/**
 * Eval engine, driven by the cron. For each pending sample: replay the resolved
 * input to the challenger, then run the blind judge, and record the verdict.
 * When a run is full (capturedN ≥ targetN) and every sample is processed,
 * finalize it: aggregate → store summary → email (best-effort) → purge content.
 *
 * Bounded per invocation (batch) and idempotent — the cron lock prevents
 * overlap, and the status guards prevent double-finalize/double-email.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import { generateText, Output, jsonSchema } from 'ai';
import type { ModelMessage } from 'ai';
import { getDb } from '@/db/client';
import { evalRuns, evalSamples, usageEvents, type KeyParams } from '@/db/schema';
import { buildSystem } from '@/lib/gateway/call';
import { extractGatewayCost } from '@/lib/usage/record';
import { judge } from '@/lib/eval/judge';
import { summarize, type JudgedSample } from '@/lib/eval/aggregate';
import { getSettings } from '@/lib/admin/settings';
import { formatEvalEmail, sendEvalEmail } from '@/lib/eval/email';

const MAX_OUTPUT_CHARS = 100_000;

async function replayChallenger(
  model: string,
  systemPrompt: string | null,
  messages: ModelMessage[],
  params: KeyParams,
  structured: boolean,
  outputSchema: Record<string, unknown> | null,
): Promise<{ output: string; costUsd: number | null; latencyMs: number }> {
  const start = Date.now();
  const callArgs = {
    model,
    system: buildSystem(systemPrompt),
    messages,
    temperature: params.temperature,
    topP: params.topP,
    maxOutputTokens: params.maxOutputTokens,
    providerOptions: { gateway: { tags: ['eval:challenger'] } } as never,
  };
  if (structured && outputSchema) {
    const r = await generateText({
      ...callArgs,
      experimental_output: Output.object({ schema: jsonSchema(outputSchema) }),
    });
    return {
      output: JSON.stringify(r.experimental_output),
      costUsd: extractGatewayCost(r.providerMetadata),
      latencyMs: Date.now() - start,
    };
  }
  const r = await generateText(callArgs);
  return { output: r.text, costUsd: extractGatewayCost(r.providerMetadata), latencyMs: Date.now() - start };
}

export async function processEvalRuns(opts?: { batch?: number }): Promise<{
  judged: number;
  finalized: number;
}> {
  const db = getDb();
  const batch = opts?.batch ?? 20;

  const pending = await db
    .select({
      sampleId: evalSamples.id,
      systemPrompt: evalSamples.systemPrompt,
      request: evalSamples.request,
      params: evalSamples.params,
      structured: evalSamples.structured,
      outputSchema: evalSamples.outputSchema,
      championOutput: evalSamples.championOutput,
      challengerModel: evalRuns.challengerModel,
      judgeModel: evalRuns.judgeModel,
    })
    .from(evalSamples)
    .innerJoin(evalRuns, eq(evalSamples.runId, evalRuns.id))
    .where(and(eq(evalSamples.status, 'pending'), eq(evalRuns.status, 'running')))
    .limit(batch);

  let judged = 0;
  for (const p of pending) {
    try {
      const messages = (p.request ?? []) as ModelMessage[];
      const params = (p.params ?? {}) as KeyParams;
      const challenger = await replayChallenger(
        p.challengerModel,
        p.systemPrompt,
        messages,
        params,
        p.structured,
        p.outputSchema ?? null,
      );
      const verdict = await judge({
        judgeModel: p.judgeModel,
        systemPrompt: p.systemPrompt,
        messages,
        championOutput: p.championOutput ?? '',
        challengerOutput: challenger.output,
        randomSwap: Math.random() < 0.5,
      });
      await db
        .update(evalSamples)
        .set({
          challengerOutput: challenger.output.slice(0, MAX_OUTPUT_CHARS),
          challengerCostUsd: challenger.costUsd != null ? String(challenger.costUsd) : null,
          challengerLatencyMs: challenger.latencyMs,
          judgeCostUsd: verdict.costUsd != null ? String(verdict.costUsd) : null,
          winner: verdict.winner,
          confidence: String(verdict.confidence),
          judgeReason: verdict.reason,
          orderSwapped: verdict.orderSwapped,
          status: 'judged',
          judgedAt: new Date(),
        })
        .where(eq(evalSamples.id, p.sampleId));
      judged++;
    } catch (err) {
      await db
        .update(evalSamples)
        .set({
          status: 'failed',
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err),
        })
        .where(eq(evalSamples.id, p.sampleId));
    }
  }

  const finalized = await finalizeRuns();
  return { judged, finalized };
}

async function finalizeRuns(): Promise<number> {
  const db = getDb();
  const runs = await db.select().from(evalRuns).where(eq(evalRuns.status, 'running'));
  let finalized = 0;

  for (const run of runs) {
    if (run.capturedN < run.targetN) continue;
    const [{ pendingCount }] = await db
      .select({ pendingCount: sql<string>`count(*)` })
      .from(evalSamples)
      .where(and(eq(evalSamples.runId, run.id), eq(evalSamples.status, 'pending')));
    if (Number(pendingCount) > 0) continue; // still being judged

    const judgedRows = await db
      .select({
        winner: evalSamples.winner,
        confidence: evalSamples.confidence,
        judgeReason: evalSamples.judgeReason,
        championCostUsd: evalSamples.championCostUsd,
        challengerCostUsd: evalSamples.challengerCostUsd,
        championLatencyMs: evalSamples.championLatencyMs,
        challengerLatencyMs: evalSamples.challengerLatencyMs,
      })
      .from(evalSamples)
      .where(and(eq(evalSamples.runId, run.id), eq(evalSamples.status, 'judged')));

    const samples: JudgedSample[] = judgedRows.map((r) => ({
      winner: r.winner ?? 'tie',
      confidence: r.confidence != null ? Number(r.confidence) : 0,
      reason: r.judgeReason ?? '',
      championCostUsd: r.championCostUsd != null ? Number(r.championCostUsd) : null,
      challengerCostUsd: r.challengerCostUsd != null ? Number(r.challengerCostUsd) : null,
      championLatencyMs: r.championLatencyMs,
      challengerLatencyMs: r.challengerLatencyMs,
    }));

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [{ cnt }] = await db
      .select({ cnt: sql<string>`count(*)` })
      .from(usageEvents)
      .where(and(eq(usageEvents.apiKeyId, run.apiKeyId), gte(usageEvents.createdAt, since)));

    const summary = summarize(samples, {
      monthlyRequests: Number(cnt) || null,
      championModel: run.championModel,
      challengerModel: run.challengerModel,
    });

    let emailedAt: Date | null = null;
    try {
      const settings = await getSettings();
      if (settings.notifyEmail) {
        const { subject, html } = formatEvalEmail({
          championModel: run.championModel,
          challengerModel: run.challengerModel,
          judgeModel: run.judgeModel,
          summary,
        });
        const sent = await sendEvalEmail(settings.notifyEmail, subject, html);
        if (sent) emailedAt = new Date();
      }
    } catch (err) {
      console.error('[eval] summary email failed', err);
    }

    // Complete the run (guarded so overlapping crons can't double-finalize).
    const done = await db
      .update(evalRuns)
      .set({
        status: 'completed',
        summary: summary as unknown as Record<string, unknown>,
        completedAt: new Date(),
        emailedAt,
      })
      .where(and(eq(evalRuns.id, run.id), eq(evalRuns.status, 'running')))
      .returning({ id: evalRuns.id });
    if (done.length === 0) continue; // someone else finalized it

    // Privacy option A: purge captured content; keep verdict + metrics.
    await db
      .update(evalSamples)
      .set({ systemPrompt: null, request: null, championOutput: null, challengerOutput: null })
      .where(eq(evalSamples.runId, run.id));
    finalized++;
  }

  return finalized;
}

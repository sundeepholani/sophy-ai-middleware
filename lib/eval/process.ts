/**
 * Eval engine, driven by the cron. For each pending sample: replay the resolved
 * input to the challenger, then run the blind judge, and record the verdict.
 * When a run is full (capturedN ≥ targetN) and every sample is processed,
 * finalize it: aggregate → store summary → email (best-effort) → purge content.
 *
 * Bounded per invocation (batch) and idempotent — the cron lock prevents
 * overlap, and the status guards prevent double-finalize/double-email.
 */
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { getDb } from '@/db/client';
import { evalRuns, evalSamples, usageEvents, type EvalWinner, type KeyParams } from '@/db/schema';
import { buildSystem } from '@/lib/gateway/call';
import { generateStructured, StructuredAttemptError } from '@/lib/gateway/structured';
import { extractGatewayCost, normalizeUsage } from '@/lib/usage/record';
import { judge, JudgeError, type JudgeVerdict } from '@/lib/eval/judge';
import { evalModel } from '@/lib/eval/model';
import { summarize, type JudgedSample } from '@/lib/eval/aggregate';
import { recordedEvalSpendUsd } from '@/lib/eval/spend';
import { getSettings } from '@/lib/admin/settings';
import { formatEvalEmail, sendEvalEmail } from '@/lib/eval/email';

const MAX_OUTPUT_CHARS = 100_000;
const MODEL_TIMEOUT_MS = 60_000;
const STALE_PENDING_MS = 60 * 60 * 1000;

async function replayChallenger(
  model: string,
  systemPrompt: string | null,
  messages: ModelMessage[],
  params: KeyParams,
  structured: boolean,
  outputSchema: Record<string, unknown> | null,
): Promise<{
  output: string;
  costUsd: number | null;
  latencyMs: number;
  schemaValid: boolean;
  inputTokens: number;
  outputTokens: number;
}> {
  const start = Date.now();
  const callArgs = {
    model: evalModel(model),
    system: buildSystem(systemPrompt),
    messages,
    temperature: params.temperature,
    topP: params.topP,
    maxOutputTokens: params.maxOutputTokens,
    abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
  };
  if (structured && outputSchema) {
    // Tolerant structured generation: an output that wraps/pads its JSON (common
    // for non-OpenAI/Anthropic models) is recovered instead of crashing. A truly
    // unparseable one comes back schemaValid:false with the raw text preserved, so
    // the caller records it as a graded "challenger loses" with the real output
    // visible — not a dropped sample.
    const r = await generateStructured(callArgs, outputSchema);
    const u = normalizeUsage(r.usage);
    return {
      output: r.text,
      // Aggregated across attempts — the tolerant retry path bills two calls.
      costUsd: r.costUsd,
      latencyMs: Date.now() - start,
      schemaValid: r.valid,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
    };
  }
  const r = await generateText(callArgs);
  const u = normalizeUsage(r.usage);
  return {
    output: r.text,
    costUsd: extractGatewayCost(r.providerMetadata),
    latencyMs: Date.now() - start,
    schemaValid: true,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
  };
}

export async function processEvalRuns(opts?: { batch?: number }): Promise<{
  judged: number;
  finalized: number;
}> {
  const db = getDb();
  const batch = opts?.batch ?? 20;

  // Backstop 1: abandon poison samples stuck pending far longer than a cron
  // cycle, so one perpetually-hanging challenger/judge can't wedge a run forever.
  await db
    .update(evalSamples)
    .set({ status: 'failed', errorMessage: 'stale pending — abandoned' })
    .where(
      and(
        eq(evalSamples.status, 'pending'),
        lt(evalSamples.createdAt, new Date(Date.now() - STALE_PENDING_MS)),
      ),
    );

  // Backstop 2: a capture can race a cancel and insert a sample after cancel's
  // delete; purge any samples left under a cancelled run (privacy option A).
  await db.delete(evalSamples).where(
    inArray(
      evalSamples.runId,
      db.select({ id: evalRuns.id }).from(evalRuns).where(eq(evalRuns.status, 'cancelled')),
    ),
  );

  const pending = await db
    .select({
      sampleId: evalSamples.id,
      // Version marker: the continuation reset in capture.ts stamps a fresh
      // createdAt, so every cron-side UPDATE below guards on (status='pending'
      // AND createdAt=<this>) — a sample reset mid-processing is left alone
      // for re-processing instead of being half-overwritten.
      // Compared as ::text, NOT as a Date: timestamptz carries microseconds
      // and the JS Date round-trip truncates to milliseconds, so a Date-equality
      // guard would never match rows stamped by the DB's now() default.
      createdAtText: sql<string>`${evalSamples.createdAt}::text`,
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
    // Cron-side writes only land on the exact sample version we selected: the
    // multi-turn continuation reset (capture.ts) re-stamps createdAt while
    // resetting the row to pending, so a stale write matches 0 rows and the
    // reset sample is re-processed whole next tick instead of half-overwritten.
    const sameVersion = and(
      eq(evalSamples.id, p.sampleId),
      eq(evalSamples.status, 'pending'),
      sql`${evalSamples.createdAt}::text = ${p.createdAtText}`,
    );
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
      // Persist the challenger result BEFORE the judge call (status stays
      // 'pending'): the challenger was billed the moment it returned, so a
      // judge failure/timeout must not lose its cost. Production 2026-07-10:
      // every judge failure discarded the paid challenger call entirely.
      const prePersisted = await db
        .update(evalSamples)
        .set({
          challengerOutput: challenger.output.slice(0, MAX_OUTPUT_CHARS),
          challengerCostUsd: challenger.costUsd != null ? String(challenger.costUsd) : null,
          challengerLatencyMs: challenger.latencyMs,
          challengerInputTokens: challenger.inputTokens,
          challengerOutputTokens: challenger.outputTokens,
        })
        .where(sameVersion)
        .returning({ id: evalSamples.id });
      // Sample was reset (next turn arrived) or deleted while the challenger
      // ran — don't spend a judge call on a stale comparison.
      if (prePersisted.length === 0) continue;
      let verdict: JudgeVerdict;
      if (p.structured && !challenger.schemaValid) {
        // Champion captures are always schema-valid (the proxy fail-closes on
        // invalid structured output), so an invalid challenger loses outright —
        // don't waste a judge call on an unfair comparison.
        verdict = {
          winner: 'champion' as EvalWinner,
          confidence: 1,
          reason: 'Challenger output failed the key’s JSON schema.',
          costUsd: null,
          orderSwapped: false,
        };
      } else {
        verdict = await judge({
          judgeModel: p.judgeModel,
          systemPrompt: p.systemPrompt,
          messages,
          championOutput: p.championOutput ?? '',
          challengerOutput: challenger.output,
          randomSwap: Math.random() < 0.5,
        });
      }
      // Re-assert the challenger fields alongside the verdict (idempotent with
      // the pre-persist) and require the same version: if the continuation
      // reset landed during the judge call this matches 0 rows and the sample
      // stays pending for a fresh turn-2 evaluation.
      const finalized = await db
        .update(evalSamples)
        .set({
          challengerOutput: challenger.output.slice(0, MAX_OUTPUT_CHARS),
          challengerCostUsd: challenger.costUsd != null ? String(challenger.costUsd) : null,
          challengerLatencyMs: challenger.latencyMs,
          challengerInputTokens: challenger.inputTokens,
          challengerOutputTokens: challenger.outputTokens,
          judgeCostUsd: verdict.costUsd != null ? String(verdict.costUsd) : null,
          winner: verdict.winner,
          confidence: String(verdict.confidence),
          judgeReason: verdict.reason,
          orderSwapped: verdict.orderSwapped,
          status: 'judged',
          judgedAt: new Date(),
        })
        .where(sameVersion)
        .returning({ id: evalSamples.id });
      if (finalized.length > 0) judged++;
    } catch (err) {
      // Billed-but-failed calls still carry their cost: JudgeError = judge
      // attempt(s), StructuredAttemptError escaping replayChallenger = the
      // challenger's completed strict attempt. Persist whichever applies so a
      // failed sample accounts for its spend. Version-guarded like every other
      // cron write — a sample reset by a newer turn is left for re-processing.
      const judgeCost = err instanceof JudgeError ? err.costUsd : null;
      const challengerCost = err instanceof StructuredAttemptError ? err.costUsd : null;
      await db
        .update(evalSamples)
        .set({
          status: 'failed',
          ...(judgeCost != null ? { judgeCostUsd: String(judgeCost) } : {}),
          ...(challengerCost != null ? { challengerCostUsd: String(challengerCost) } : {}),
          errorMessage: err instanceof Error ? err.message.slice(0, 500) : String(err),
        })
        .where(sameVersion);
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
        orderSwapped: evalSamples.orderSwapped,
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
      orderSwapped: r.orderSwapped,
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

    // Freeze the run's own spend (challenger + judge) alongside the summary.
    // The sample rows survive completion, but freezing here keeps the number
    // consistent with cancelled runs, whose samples are purged.
    const evalCostUsd = await recordedEvalSpendUsd(db, run.id);

    // Claim the run (flip running → completed, guarded) BEFORE any side effect,
    // so an overlapping cron can't also send the email. Only the winner proceeds.
    const done = await db
      .update(evalRuns)
      .set({
        status: 'completed',
        summary: summary as unknown as Record<string, unknown>,
        evalCostUsd,
        completedAt: new Date(),
      })
      .where(and(eq(evalRuns.id, run.id), eq(evalRuns.status, 'running')))
      .returning({ id: evalRuns.id });
    if (done.length === 0) continue; // someone else finalized it

    // Email (best-effort) — gated by the claim above, so no double-send.
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
        if (sent) {
          await db.update(evalRuns).set({ emailedAt: new Date() }).where(eq(evalRuns.id, run.id));
        }
      }
    } catch (err) {
      console.error('[eval] summary email failed', err);
    }

    // Privacy option A: purge the raw captured content (system prompt, inbound
    // request, model outputs). The per-sample judge reason is RETAINED — it's the
    // operator-facing verdict shown in the Eval panel, not raw captured content.
    await db
      .update(evalSamples)
      .set({
        systemPrompt: null,
        request: null,
        championOutput: null,
        challengerOutput: null,
      })
      .where(eq(evalSamples.runId, run.id));
    finalized++;
  }

  return finalized;
}

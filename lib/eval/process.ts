/**
 * Eval engine, driven by the cron. For each pending sample: replay the resolved
 * input to the challenger, then run the blind judge, and record the verdict.
 * When a run is full (capturedN ≥ targetN) and every sample is processed,
 * finalize it: aggregate → store summary → email (best-effort) → purge content.
 *
 * Bounded per invocation (batch) and idempotent — the cron lock prevents
 * overlap, and the status guards prevent double-finalize/double-email.
 */
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { generateText } from 'ai';
import type { ModelMessage } from 'ai';
import { getDb } from '@/db/client';
import {
  evalRuns,
  evalSamples,
  projectSettings,
  usageEvents,
  type EvalWinner,
  type KeyParams,
} from '@/db/schema';
import { buildSystem, providerOf } from '@/lib/gateway/call';
import { generateStructured, StructuredAttemptError } from '@/lib/gateway/structured';
import {
  extractGatewayCost,
  normalizeUsage,
  recordUsage,
  ZERO_USAGE,
  type NormalizedUsage,
} from '@/lib/usage/record';
import { judge, JudgeError, type JudgeVerdict } from '@/lib/eval/judge';
import { evalModel } from '@/lib/eval/model';
import { summarize, type JudgedSample } from '@/lib/eval/aggregate';
import { recordedEvalSpendUsd } from '@/lib/eval/spend';
import { formatEvalEmail, sendEvalEmail } from '@/lib/eval/email';
import {
  normalizeProjectGatewayError,
  ProjectGatewayUnavailableError,
  resolveProjectGateway,
  type ProjectGatewaySnapshot,
} from '@/lib/gateway/project-provider';
import { safeGatewayErrorMessage } from '@/lib/gateway/upstream-error';

const MAX_OUTPUT_CHARS = 100_000;
const MODEL_TIMEOUT_MS = 60_000;
const STALE_PENDING_MS = 60 * 60 * 1000;
const GATEWAY_UNAVAILABLE_CODE = 'project_gateway_unavailable';

async function replayChallenger(
  gateway: ProjectGatewaySnapshot,
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
    model: evalModel(gateway, model),
    system: buildSystem(systemPrompt),
    messages,
    temperature: params.temperature,
    topP: params.topP,
    maxOutputTokens: params.maxOutputTokens,
  };
  if (structured && outputSchema) {
    // Tolerant structured generation: an output that wraps/pads its JSON (common
    // for non-OpenAI/Anthropic models) is recovered instead of crashing. A truly
    // unparseable one comes back schemaValid:false with the raw text preserved, so
    // the caller records it as a graded "challenger loses" with the real output
    // visible — not a dropped sample. attemptTimeoutMs gives the strict attempt
    // and the tolerant retry each their own 60s budget (a shared signal would
    // leave the retry seconds from abort — a paid failure).
    const r = await generateStructured(callArgs, outputSchema, {
      attemptTimeoutMs: MODEL_TIMEOUT_MS,
    });
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
  const r = await generateText({ ...callArgs, abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS) });
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
        // Credential-blocked samples are deliberately pending and recover as
        // soon as an admin reconnects the project. They must not be converted
        // into permanent failures by the generic poison-sample backstop.
        sql`${evalSamples.errorMessage} is distinct from ${GATEWAY_UNAVAILABLE_CODE}`,
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
      projectId: evalRuns.projectId,
      apiKeyId: evalRuns.apiKeyId,
      challengerModel: evalRuns.challengerModel,
      judgeModel: evalRuns.judgeModel,
    })
    .from(evalSamples)
    .innerJoin(
      evalRuns,
      and(
        eq(evalSamples.runId, evalRuns.id),
        eq(evalSamples.projectId, evalRuns.projectId),
      ),
    )
    .where(and(eq(evalSamples.status, 'pending'), eq(evalRuns.status, 'running')))
    .orderBy(
      // Healthy projects always get the batch before credential-blocked work.
      // A blocked retry refreshes createdAt below, rotating it to the back of
      // this secondary queue instead of monopolizing every cron invocation.
      sql`case when ${evalSamples.errorMessage} = ${GATEWAY_UNAVAILABLE_CODE} then 1 else 0 end`,
      asc(evalSamples.createdAt),
    )
    .limit(batch);

  let judged = 0;
  const gateways = new Map<string, Promise<ProjectGatewaySnapshot>>();
  const gatewayFor = (projectId: string) => {
    let pendingGateway = gateways.get(projectId);
    if (!pendingGateway) {
      pendingGateway = resolveProjectGateway(projectId);
      gateways.set(projectId, pendingGateway);
    }
    return pendingGateway;
  };
  for (const p of pending) {
    // Cron-side writes only land on the exact sample version we selected: the
    // multi-turn continuation reset (capture.ts) re-stamps createdAt while
    // resetting the row to pending, so a stale write matches 0 rows and the
    // reset sample is re-processed whole next tick instead of half-overwritten.
    const sameVersion = and(
      eq(evalSamples.projectId, p.projectId),
      eq(evalSamples.id, p.sampleId),
      eq(evalSamples.status, 'pending'),
      sql`${evalSamples.createdAt}::text = ${p.createdAtText}`,
    );
    // Which paid call is in flight — the catch below books the error usage
    // event against the right source/model. stageBooked flips true once the
    // in-flight stage's usage event is recorded 'ok', so a LATER failure (a
    // sample UPDATE throwing) doesn't double-book the same gateway call as a
    // phantom error event.
    let stage: 'challenger' | 'judge' = 'challenger';
    let stageBooked = false;
    let gateway: ProjectGatewaySnapshot | undefined;
    try {
      gateway = await gatewayFor(p.projectId);
      const messages = (p.request ?? []) as ModelMessage[];
      const params = (p.params ?? {}) as KeyParams;
      const challenger = await replayChallenger(
        gateway,
        p.challengerModel,
        p.systemPrompt,
        messages,
        params,
        p.structured,
        p.outputSchema ?? null,
      );
      // Book the challenger call as a first-class usage event AT CALL TIME:
      // unlike the sample columns (overwritten on re-judge, purged on cancel),
      // these rows accumulate and survive, so eval spend is always accounted.
      const challengerUsage: NormalizedUsage = {
        inputTokens: challenger.inputTokens,
        outputTokens: challenger.outputTokens,
        totalTokens: challenger.inputTokens + challenger.outputTokens,
        cachedInputTokens: 0,
        cacheWriteTokens: null,
        reasoningTokens: 0,
      };
      await recordUsage({
        projectId: p.projectId,
        gatewayCredentialId: gateway.gatewayCredentialId,
        keyId: p.apiKeyId,
        source: 'eval_challenger',
        provider: providerOf(p.challengerModel),
        model: p.challengerModel,
        usage: challengerUsage,
        costUsd: challenger.costUsd,
        latencyMs: challenger.latencyMs,
        status: 'ok',
        responseKind: p.structured ? 'structured' : 'text',
      });
      stageBooked = true;
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
          usage: { ...ZERO_USAGE },
          orderSwapped: false,
        };
      } else {
        stage = 'judge';
        stageBooked = false;
        const judgeStart = Date.now();
        verdict = await judge({
          gateway,
          judgeModel: p.judgeModel,
          systemPrompt: p.systemPrompt,
          messages,
          championOutput: p.championOutput ?? '',
          challengerOutput: challenger.output,
          randomSwap: Math.random() < 0.5,
        });
        // Book the judge call the same way (only when one actually ran).
        await recordUsage({
          projectId: p.projectId,
          gatewayCredentialId: gateway.gatewayCredentialId,
          keyId: p.apiKeyId,
          source: 'eval_judge',
          provider: providerOf(p.judgeModel),
          model: p.judgeModel,
          usage: verdict.usage,
          costUsd: verdict.costUsd,
          latencyMs: Date.now() - judgeStart,
          status: 'ok',
          responseKind: 'structured',
        });
        stageBooked = true;
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
      const normalizedError = gateway
        ? await normalizeProjectGatewayError(gateway, err)
        : err;
      const credentialUnavailable = ProjectGatewayUnavailableError.isInstance(normalizedError);
      // Billed-but-failed calls still carry their cost: JudgeError = judge
      // attempt(s), StructuredAttemptError escaping replayChallenger = the
      // challenger's completed strict attempt. Persist whichever applies so a
      // failed sample accounts for its spend. Version-guarded like every other
      // cron write — a sample reset by a newer turn is left for re-processing.
      const judgeCost = err instanceof JudgeError ? err.costUsd : null;
      const challengerCost = err instanceof StructuredAttemptError ? err.costUsd : null;
      const errorMessage = credentialUnavailable
        ? normalizedError.code
        : stage === 'judge'
          ? 'eval_judge_failed'
          : 'eval_challenger_failed';
      // Book the failed stage's usage event too — the carried cost/usage is
      // exactly the billed-but-unrecorded spend class from the Jul-10 incident.
      // Skipped when the stage's call already got its 'ok' row (the throw came
      // from a later sample UPDATE, not from a gateway call).
      const carried = err instanceof JudgeError || err instanceof StructuredAttemptError ? err : null;
      if (!stageBooked && gateway) {
        await recordUsage({
          projectId: p.projectId,
          gatewayCredentialId: gateway.gatewayCredentialId,
          keyId: p.apiKeyId,
          source: stage === 'judge' ? 'eval_judge' : 'eval_challenger',
          provider: providerOf(stage === 'judge' ? p.judgeModel : p.challengerModel),
          model: stage === 'judge' ? p.judgeModel : p.challengerModel,
          usage: carried ? normalizeUsage(carried.usage) : { ...ZERO_USAGE },
          costUsd: carried?.costUsd,
          status: 'error',
          responseKind: stage === 'judge' || p.structured ? 'structured' : 'text',
          errorMessage: safeGatewayErrorMessage(normalizedError),
        });
      }
      await db
        .update(evalSamples)
        .set({
          // A project credential outage is recoverable. Keep the sample pending
          // and refresh its version timestamp so the stale-pending backstop does
          // not turn an admin-fixable outage into a permanent sample failure.
          ...(credentialUnavailable
            ? { status: 'pending' as const, createdAt: new Date() }
            : { status: 'failed' as const }),
          ...(judgeCost != null ? { judgeCostUsd: String(judgeCost) } : {}),
          ...(challengerCost != null ? { challengerCostUsd: String(challengerCost) } : {}),
          errorMessage,
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
      .where(
        and(
          eq(evalSamples.projectId, run.projectId),
          eq(evalSamples.runId, run.id),
          eq(evalSamples.status, 'pending'),
        ),
      );
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
      .where(
        and(
          eq(evalSamples.projectId, run.projectId),
          eq(evalSamples.runId, run.id),
          eq(evalSamples.status, 'judged'),
        ),
      );

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
    // Client traffic only: this run's own challenger/judge rows (and kb_query
    // rows) carry the same key id — counting them would inflate the projected
    // monthly savings in the summary/email by ~2-3x.
    const [{ cnt }] = await db
      .select({ cnt: sql<string>`count(*)` })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.projectId, run.projectId),
          eq(usageEvents.apiKeyId, run.apiKeyId),
          eq(usageEvents.source, 'proxy'),
          gte(usageEvents.createdAt, since),
        ),
      );

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
      .where(
        and(
          eq(evalRuns.projectId, run.projectId),
          eq(evalRuns.id, run.id),
          eq(evalRuns.status, 'running'),
        ),
      )
      .returning({ id: evalRuns.id });
    if (done.length === 0) continue; // someone else finalized it

    // Email (best-effort) — gated by the claim above, so no double-send.
    try {
      const [settings] = await db
        .select({ notifyEmail: projectSettings.notifyEmail })
        .from(projectSettings)
        .where(eq(projectSettings.projectId, run.projectId))
        .limit(1);
      if (settings?.notifyEmail) {
        const { subject, html } = formatEvalEmail({
          championModel: run.championModel,
          challengerModel: run.challengerModel,
          judgeModel: run.judgeModel,
          summary,
        });
        const sent = await sendEvalEmail(settings.notifyEmail, subject, html);
        if (sent) {
          await db
            .update(evalRuns)
            .set({ emailedAt: new Date() })
            .where(
              and(eq(evalRuns.projectId, run.projectId), eq(evalRuns.id, run.id)),
            );
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
      .where(
        and(eq(evalSamples.projectId, run.projectId), eq(evalSamples.runId, run.id)),
      );
    finalized++;
  }

  return finalized;
}

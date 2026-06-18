/**
 * Champion-side capture for an active eval run.
 *
 * When a key has a running eval, each successful live request records a
 * "pending" eval_sample holding the resolved input + the champion's output,
 * cost, and latency. The challenger replay + judge happen later in the cron.
 *
 * Designed to run OFF the response path (via waitUntil): it adds no latency to
 * the client, and it is fully resilient — any failure is logged, never thrown.
 *
 * Privacy: content is captured here regardless of the key's logContent flag
 * (option A) and is purged when the run ends.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ModelMessage, ProviderMetadata } from 'ai';
import { waitUntil } from '@vercel/functions';
import { getDb } from '@/db/client';
import { evalRuns, evalSamples, type KeyParams } from '@/db/schema';
import { extractGatewayCost } from '@/lib/usage/record';
import type { CallContext } from '@/lib/gateway/call';

const MAX_OUTPUT_CHARS = 100_000;
function cap(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}…[truncated]` : s;
}

interface CaptureInput {
  keyId: string;
  surface: 'chat' | 'responses';
  systemPrompt: string | null;
  messages: ModelMessage[];
  params: KeyParams;
  structured: boolean;
  outputSchema: Record<string, unknown> | null;
  championOutput: string;
  championCostUsd: number | null;
  championLatencyMs: number;
  usageEventId?: string;
}

async function captureEvalSample(input: CaptureInput): Promise<void> {
  try {
    const db = getDb();
    // Is there an active run for this key? (indexed on api_key_id, status)
    const [run] = await db
      .select({ id: evalRuns.id })
      .from(evalRuns)
      .where(and(eq(evalRuns.apiKeyId, input.keyId), eq(evalRuns.status, 'running')))
      .limit(1);
    if (!run) return;

    // Claim a slot AND write the sample in one transaction: the conditional
    // UPDATE (captured_n < target_n) is the atomic over-fill guard, and pairing
    // it with the insert means a failed insert rolls the increment back — so a
    // claimed slot always has a real sample behind it (no silent under-sampling).
    await db.transaction(async (tx) => {
      const claimed = await tx
        .update(evalRuns)
        .set({ capturedN: sql`${evalRuns.capturedN} + 1` })
        .where(
          and(
            eq(evalRuns.id, run.id),
            eq(evalRuns.status, 'running'),
            sql`${evalRuns.capturedN} < ${evalRuns.targetN}`,
          ),
        )
        .returning({ capturedN: evalRuns.capturedN });
      if (claimed.length === 0) return; // run full or no longer running

      await tx.insert(evalSamples).values({
        runId: run.id,
        usageEventId: input.usageEventId ?? null,
        surface: input.surface,
        systemPrompt: input.systemPrompt,
        request: input.messages as object,
        params: input.params,
        structured: input.structured,
        outputSchema: input.outputSchema ?? null,
        championOutput: cap(input.championOutput),
        championCostUsd: input.championCostUsd != null ? String(input.championCostUsd) : null,
        championLatencyMs: input.championLatencyMs,
        status: 'pending',
      });
    });
  } catch (err) {
    console.error('[eval] failed to capture champion sample', err);
  }
}

/**
 * Schedule a champion capture without blocking the response. No-op (a single
 * indexed lookup) when the key has no active run.
 */
export function scheduleChampionCapture(
  ctx: CallContext,
  messages: ModelMessage[],
  surface: 'chat' | 'responses',
  output: string,
  providerMetadata: ProviderMetadata | undefined,
  startMs: number,
  usageEventId?: string,
): void {
  waitUntil(
    captureEvalSample({
      keyId: ctx.keyId,
      surface,
      systemPrompt: ctx.systemPrompt,
      messages,
      params: {
        temperature: ctx.params.temperature,
        maxOutputTokens: ctx.params.maxOutputTokens,
        topP: ctx.params.topP,
      },
      structured: ctx.structured,
      outputSchema: ctx.schema,
      championOutput: output,
      championCostUsd: extractGatewayCost(providerMetadata),
      championLatencyMs: Date.now() - startMs,
      usageEventId,
    }),
  );
}

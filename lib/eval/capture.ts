/**
 * Champion-side capture for an active eval run.
 *
 * When a key has a running eval, each successful live request records a
 * "pending" eval_sample holding the resolved input + the champion's output,
 * cost, and latency. The challenger replay + judge happen later in the cron.
 *
 * Multi-turn grouping: the OpenAI-compatible API is stateless, so a multi-turn
 * conversation is N separate requests, each re-sending the growing transcript.
 * Capturing each would judge individual turns (clarifying questions etc.) rather
 * than the whole interaction. Instead, when a request CONTINUES a conversation
 * we already captured for this run (its messages extend an existing sample), we
 * update that sample in place — so each conversation is one sample holding its
 * latest, most-complete turn. capturedN therefore counts conversations, not turns.
 *
 * Designed to run OFF the response path (via waitUntil): it adds no latency to
 * the client, and it is fully resilient — any failure is logged, never thrown.
 *
 * Privacy: content is captured here regardless of the key's logContent flag
 * (option A) and is purged when the run ends.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ModelMessage } from 'ai';
import { waitUntil } from '@vercel/functions';
import { getDb } from '@/db/client';
import { evalRuns, evalSamples, type KeyParams } from '@/db/schema';
import type { CallContext } from '@/lib/gateway/call';

const MAX_OUTPUT_CHARS = 100_000;
const TRUNC_MARK = '…[truncated]';
function cap(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? `${s.slice(0, MAX_OUTPUT_CHARS)}${TRUNC_MARK}` : s;
}

function messageRole(m: unknown): string {
  return m && typeof m === 'object' ? String((m as { role?: unknown }).role ?? '') : '';
}

/**
 * A comparable rendering of a message's content. String content → itself; array
 * content → text parts inline, with non-text parts (images/files) serialized so
 * two messages with the same text but different media never compare equal.
 */
function messageText(m: unknown): string {
  if (!m || typeof m !== 'object') return '';
  const content = (m as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p || typeof p !== 'object') return '';
        return 'text' in p ? String((p as { text?: unknown }).text ?? '') : JSON.stringify(p);
      })
      .join('\n');
  }
  return '';
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Deterministic, key-sorted stringify — so compact vs pretty JSON compares equal. */
function stableJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`;
}

/**
 * Normalize a model output for comparison: drop our truncation marker and any
 * surrounding markdown code fence. Clients commonly strip the ```json fence the
 * model emits before echoing the turn back, so the champion's raw output and the
 * echoed assistant turn differ only by the fence — normalize both before compare.
 */
function normalizeOutput(s: string): string {
  let t = s.trim();
  if (t.endsWith(TRUNC_MARK)) t = t.slice(0, -TRUNC_MARK.length).trim();
  const fenced = t.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fenced) return fenced[1].trim();
  // A truncated output may have an opening fence with no close — strip only that.
  if (t.startsWith('```')) t = t.replace(/^```[^\n]*\n?/, '').trim();
  return t;
}

/**
 * Does an echoed assistant turn match the champion output that produced it?
 * Exact after normalization (handles the ```json fence the client strips), or
 * structurally equal as JSON (compact vs pretty). A prefix match is allowed
 * ONLY when the champion was truncated (cap()'d) — never for short outputs,
 * which would let "OK" match any reply starting with "OK".
 */
function outputsMatch(assistantText: string, champ: string): boolean {
  const truncated = champ.trim().endsWith(TRUNC_MARK);
  const a = normalizeOutput(assistantText);
  const c = normalizeOutput(champ);
  if (!a || !c) return false;
  if (a === c) return true;
  const ja = tryParseJson(a);
  const jc = tryParseJson(c);
  if (ja !== undefined && jc !== undefined && stableJson(ja) === stableJson(jc)) return true;
  return truncated && a.startsWith(c);
}

/**
 * True if `newReq` is the next turn of the conversation captured as
 * (`prevReq`, `prevOutput`): newReq's first prevReq.length messages match
 * prevReq (by role + text, so it's robust to jsonb key reordering), and the
 * message right after is the assistant turn prevReq produced (matched against
 * the stored champion output, which disambiguates two conversations that share
 * an opening prompt).
 */
export function continuesConversation(
  prevReq: unknown[],
  prevOutput: string,
  newReq: unknown[],
): boolean {
  if (!Array.isArray(prevReq) || !Array.isArray(newReq)) return false;
  const k = prevReq.length;
  if (k === 0 || newReq.length <= k) return false;
  for (let i = 0; i < k; i++) {
    if (messageRole(prevReq[i]) !== messageRole(newReq[i])) return false;
    if (messageText(prevReq[i]).trim() !== messageText(newReq[i]).trim()) return false;
  }
  if (messageRole(newReq[k]) !== 'assistant') return false;
  return outputsMatch(messageText(newReq[k]), prevOutput);
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

    // Multi-turn grouping: does this request continue a conversation already
    // captured for this run? Only same-run samples with FEWER messages (and
    // un-purged content) can be a prefix of it.
    const candidates = await db
      .select({
        id: evalSamples.id,
        request: evalSamples.request,
        championOutput: evalSamples.championOutput,
      })
      .from(evalSamples)
      .where(
        and(
          eq(evalSamples.runId, run.id),
          sql`${evalSamples.request} is not null`,
          sql`jsonb_array_length(${evalSamples.request}) < ${input.messages.length}`,
        ),
      );
    const target = candidates.find((c) =>
      continuesConversation((c.request ?? []) as unknown[], c.championOutput ?? '', input.messages),
    );

    if (target) {
      // Replace with the longer turn and reset judging so the cron re-evaluates
      // the now-more-complete conversation. capturedN is NOT incremented — this
      // is the same task, just a later turn of it.
      await db
        .update(evalSamples)
        .set({
          surface: input.surface,
          systemPrompt: input.systemPrompt,
          request: input.messages as object,
          params: input.params,
          structured: input.structured,
          outputSchema: input.outputSchema ?? null,
          championOutput: cap(input.championOutput),
          championCostUsd: input.championCostUsd != null ? String(input.championCostUsd) : null,
          championLatencyMs: input.championLatencyMs,
          usageEventId: input.usageEventId ?? null,
          status: 'pending',
          challengerOutput: null,
          challengerCostUsd: null,
          challengerLatencyMs: null,
          judgeCostUsd: null,
          winner: null,
          confidence: null,
          judgeReason: null,
          orderSwapped: false,
          judgedAt: null,
          errorMessage: null,
          // Refresh createdAt so the cron's stale-pending backstop measures from
          // THIS turn, not the conversation's first turn — otherwise a
          // conversation continued >1h after it started gets abandoned.
          createdAt: new Date(),
        })
        .where(eq(evalSamples.id, target.id));
      return;
    }

    // New conversation. Claim a slot AND write the sample in one transaction: the
    // conditional UPDATE (captured_n < target_n) is the atomic over-fill guard,
    // and pairing it with the insert means a failed insert rolls the increment
    // back — so a claimed slot always has a real sample behind it.
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
 * True when any message carries a non-text part (image, file, tool payload).
 * Pure — exported for unit testing.
 */
export function hasNonTextParts(messages: ModelMessage[]): boolean {
  for (const m of messages) {
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      if (typeof p === 'string') continue;
      if (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text') continue;
      return true;
    }
  }
  return false;
}

/**
 * Schedule a champion capture without blocking the response. No-op (a single
 * indexed lookup) when the key has no active run.
 *
 * Conversations containing non-text parts (images/files) are NOT captured:
 * the challenger replay would re-bill the media, the judge can't see it (its
 * prompt is text-only), and `request` is stored uncapped — a single base64
 * image captured here produced ~850K-token judge prompts in production
 * (2026-07-10, ~$30 billed / $0 recorded). Text-only tasks remain evaluable.
 */
export function scheduleChampionCapture(
  ctx: CallContext,
  messages: ModelMessage[],
  surface: 'chat' | 'responses',
  output: string,
  /**
   * The cost the caller CHARGED for this request (usage_events.cost_usd) — on
   * structured paths that is the aggregate across attempts, which last-attempt
   * providerMetadata cannot express. Keeping one source ties championCostUsd to
   * the linked usage_events row and keeps the champion-vs-challenger cost
   * comparison symmetric (the challenger side records its aggregate too).
   */
  costUsd: number | null,
  startMs: number,
  usageEventId?: string,
): void {
  if (hasNonTextParts(messages)) return;
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
      championCostUsd: costUsd,
      championLatencyMs: Date.now() - startMs,
      usageEventId,
    }),
  );
}

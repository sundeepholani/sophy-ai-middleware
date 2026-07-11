/**
 * Usage accounting: append a usage_event fact and atomically charge the
 * period-keyed quota counter. Resilient by design — failures here are logged
 * but never propagated into the client response path.
 */
import type { LanguageModelUsage, ProviderMetadata, ModelMessage } from 'ai';
import { getDb } from '@/db/client';
import {
  usageEvents,
  requestLogs,
  type UsageStatus,
  type ResponseKind,
  type UsageSource,
} from '@/db/schema';

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

export function normalizeUsage(u: LanguageModelUsage | undefined): NormalizedUsage {
  if (!u) return { ...ZERO_USAGE };
  const inputTokens = u.inputTokens ?? 0;
  const outputTokens = u.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: u.totalTokens ?? inputTokens + outputTokens,
    cachedInputTokens: u.inputTokenDetails?.cacheReadTokens ?? u.cachedInputTokens ?? 0,
    reasoningTokens: u.outputTokenDetails?.reasoningTokens ?? u.reasoningTokens ?? 0,
  };
}

/** AI Gateway returns zero-markup provider-rate cost in providerMetadata.gateway. */
export function extractGatewayCost(pm: ProviderMetadata | undefined): number | null {
  const gw = pm?.gateway as { cost?: unknown } | undefined;
  if (gw?.cost == null) return null;
  const n = Number(gw.cost);
  return Number.isFinite(n) ? n : null;
}

export function extractGatewayRequestId(pm: ProviderMetadata | undefined): string | null {
  const gw = pm?.gateway as { generationId?: unknown; requestId?: unknown } | undefined;
  const id = gw?.generationId ?? gw?.requestId;
  return typeof id === 'string' ? id : null;
}

export interface RecordUsageInput {
  /** Optional explicit id; pass it to correlate with a request_logs row. */
  id?: string;
  /** Null only for spend with no owning key (kb_ingest from the cron). */
  keyId: string | null;
  /** Defaults to 'proxy' (a client request). Non-proxy rows are Sophy's own
   *  spend and are excluded from key quotas and client-facing usage totals. */
  source?: UsageSource;
  provider?: string | null;
  model?: string | null;
  usage: NormalizedUsage;
  costUsd?: number | null;
  latencyMs?: number | null;
  status: UsageStatus;
  responseKind?: ResponseKind | null;
  streamed?: boolean;
  gatewayRequestId?: string | null;
  errorMessage?: string | null;
}

export async function recordUsage(input: RecordUsageInput): Promise<void> {
  // 1) Append the fact.
  try {
    await getDb()
      .insert(usageEvents)
      .values({
        ...(input.id ? { id: input.id } : {}),
        apiKeyId: input.keyId,
        source: input.source ?? 'proxy',
        provider: input.provider ?? null,
        model: input.model ?? null,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
        cachedInputTokens: input.usage.cachedInputTokens,
        reasoningTokens: input.usage.reasoningTokens,
        costUsd: input.costUsd != null ? String(input.costUsd) : null,
        latencyMs: input.latencyMs ?? null,
        status: input.status,
        responseKind: input.responseKind ?? null,
        streamed: input.streamed ?? false,
        gatewayRequestId: input.gatewayRequestId ?? null,
        errorMessage: input.errorMessage ?? null,
      });
  } catch (err) {
    console.error('[usage] failed to insert usage_event', err);
  }
  // The monthly cost budget is derived from the sum of cost_usd in usage_events
  // for the period (see lib/counters.ts#costUsedThisMonth) — the insert above IS
  // the charge. No separate counter to update.
}

// ---- Request content logging (per-key, separate retention) -----------------

const MAX_LOG_CHARS = 100_000;

function cap(s: string): string {
  return s.length > MAX_LOG_CHARS ? `${s.slice(0, MAX_LOG_CHARS)}…[truncated]` : s;
}

export interface RecordRequestLogInput {
  /** Shared with the usage_events row id. */
  id: string;
  keyId: string;
  surface: 'chat' | 'responses';
  /** The operator system prompt that was applied (if any). */
  systemPrompt: string | null;
  /** Inbound messages actually sent to the model. */
  messages: ModelMessage[];
  /** Outbound model text. */
  response: string | null;
  streamed?: boolean;
  status: UsageStatus;
}

/**
 * Persist inbound/outbound content for a request (gated by the key's logContent
 * upstream). Size-capped and fully resilient — never throws into the response path.
 */
export async function recordRequestLog(input: RecordRequestLogInput): Promise<void> {
  try {
    const serialized = JSON.stringify(input.messages ?? []);
    const request =
      serialized.length > MAX_LOG_CHARS
        ? { truncated: true, preview: serialized.slice(0, MAX_LOG_CHARS) }
        : input.messages;
    await getDb()
      .insert(requestLogs)
      .values({
        id: input.id,
        apiKeyId: input.keyId,
        surface: input.surface,
        systemPrompt: input.systemPrompt ? cap(input.systemPrompt) : null,
        request: request as object,
        response: input.response != null ? cap(input.response) : null,
        streamed: input.streamed ?? false,
        status: input.status,
      })
      .onConflictDoNothing();
  } catch (err) {
    console.error('[request-log] failed to insert request_log', err);
  }
}

export interface RecordEmbeddingLogInput {
  /** Shared with the usage_events row id. */
  id: string;
  keyId: string;
  /** The exact strings that were embedded (already normalized to an array). */
  inputs: string[];
  status: UsageStatus;
}

/**
 * Shape embedded inputs into the request_logs `request` jsonb. Each input is a
 * role-tagged block so the log-detail page's existing message renderer shows
 * them as readable "INPUT" cards. The whole blob is size-capped exactly like the
 * chat/responses path: if it exceeds the cap, store a truncated preview object
 * (which the detail page then renders as raw JSON) rather than an oversized row.
 * Pure — exported for unit testing.
 */
export function toEmbeddingLogRequest(
  inputs: string[],
): { role: string; content: string }[] | { truncated: true; preview: string } {
  const blocks = inputs.map((content) => ({ role: 'input', content }));
  const serialized = JSON.stringify(blocks);
  return serialized.length > MAX_LOG_CHARS
    ? { truncated: true, preview: serialized.slice(0, MAX_LOG_CHARS) }
    : blocks;
}

/**
 * Persist an embeddings request's inputs (gated by the key's logContent
 * upstream). Embeddings have no text output, so `response` is null — the
 * detail page shows "(no response captured)", which is honest here. Shares the
 * usage_events id so the log-detail join finds it. Fully resilient.
 */
export async function recordEmbeddingLog(input: RecordEmbeddingLogInput): Promise<void> {
  try {
    await getDb()
      .insert(requestLogs)
      .values({
        id: input.id,
        apiKeyId: input.keyId,
        surface: 'embedding',
        systemPrompt: null,
        request: toEmbeddingLogRequest(input.inputs) as object,
        response: null,
        streamed: false,
        status: input.status,
      })
      .onConflictDoNothing();
  } catch (err) {
    console.error('[request-log] failed to insert embedding request_log', err);
  }
}

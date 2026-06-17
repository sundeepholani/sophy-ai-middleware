/**
 * Usage accounting: append a usage_event fact and atomically charge the
 * period-keyed quota counter. Resilient by design — failures here are logged
 * but never propagated into the client response path.
 */
import type { LanguageModelUsage, ProviderMetadata } from 'ai';
import { getDb } from '@/db/client';
import { usageEvents, type UsageStatus, type ResponseKind } from '@/db/schema';

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
  keyId: string;
  clientId: string;
  routeId?: string | null;
  routeName?: string | null;
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
        apiKeyId: input.keyId,
        clientId: input.clientId,
        routeId: input.routeId ?? null,
        routeName: input.routeName ?? null,
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
  // Quota is derived from the sum of usage_events for the period (see
  // lib/counters.ts#quotaUsed) — the insert above IS the charge. No separate
  // counter to update.
}

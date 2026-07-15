/**
 * Project-scoped embedding helpers for the knowledgebase pipeline.
 *
 * The vector column dimension is locked to the embedding model (see db/schema):
 * `openai/text-embedding-3-small` → 1536. Ingestion asserts this before insert.
 */
import { embed, embedMany } from 'ai';
import type { ProviderMetadata } from 'ai';
import { extractGatewayCost } from '@/lib/usage/record';
import type { ProjectGatewaySnapshot } from '@/lib/gateway/project-provider';

export const EMBEDDING_DIM = 1536;

export function embeddingModel(gateway: ProjectGatewaySnapshot, modelId: string) {
  return gateway.gateway.embeddingModel(modelId);
}

/**
 * Embed many texts; vectors come back in input order. Returns token usage too.
 * Pass an abortSignal (and a low maxRetries) from the cron so a slow/hung
 * gateway can't silently eat the whole cron budget — it becomes a fast, caught
 * per-document failure instead. (Mirrors the eval path's AbortSignal.timeout.)
 */
export async function embedTexts(
  gateway: ProjectGatewaySnapshot,
  modelId: string,
  values: string[],
  opts?: { abortSignal?: AbortSignal; maxRetries?: number },
): Promise<{ embeddings: number[][]; tokens: number | null; costUsd: number | null }> {
  const result = await embedMany({
    model: embeddingModel(gateway, modelId),
    values,
    abortSignal: opts?.abortSignal,
    maxRetries: opts?.maxRetries,
  });
  return {
    embeddings: result.embeddings,
    tokens: result.usage?.tokens ?? null,
    // Zero-markup gateway cost, so callers can record this spend (it was
    // previously discarded — billed but invisible to usage accounting).
    costUsd: extractGatewayCost(result.providerMetadata as ProviderMetadata | undefined),
  };
}

/**
 * Embed a single query string (retrieval path). Callers on the live request path
 * should pass a short abortSignal + maxRetries:0 so a slow/hung gateway degrades
 * to "no context" fast instead of stalling the user-visible response.
 */
export async function embedQuery(
  gateway: ProjectGatewaySnapshot,
  modelId: string,
  value: string,
  opts?: { abortSignal?: AbortSignal; maxRetries?: number },
): Promise<{ embedding: number[]; tokens: number | null; costUsd: number | null }> {
  const result = await embed({
    model: embeddingModel(gateway, modelId),
    value,
    abortSignal: opts?.abortSignal,
    maxRetries: opts?.maxRetries,
  });
  return {
    embedding: result.embedding,
    tokens: result.usage?.tokens ?? null,
    costUsd: extractGatewayCost(result.providerMetadata as ProviderMetadata | undefined),
  };
}

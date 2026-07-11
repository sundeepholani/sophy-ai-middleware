/**
 * Embedding model handle + batch helper for the knowledgebase pipeline.
 *
 * Mirrors lib/eval/model.ts: live request handlers reach the AI Gateway via the
 * request-scoped Vercel OIDC token, but the cron's build-time OIDC token can be
 * expired — so when AI_GATEWAY_API_KEY is set we use an explicit gateway
 * credential, otherwise we fall back to the default provider (OIDC), which works
 * locally where a fresh token is present.
 *
 * The vector column dimension is locked to the embedding model (see db/schema):
 * `openai/text-embedding-3-small` → 1536. Ingestion asserts this before insert.
 */
import { createGateway } from '@ai-sdk/gateway';
import { embed, embedMany } from 'ai';
import type { ProviderMetadata } from 'ai';
import { env } from '@/lib/env';
import { extractGatewayCost } from '@/lib/usage/record';

export const EMBEDDING_DIM = 1536;

let cached: ReturnType<typeof createGateway> | undefined;

export function embeddingModel(modelId: string) {
  const apiKey = env.aiGatewayApiKey();
  if (!apiKey) return modelId; // default provider (request-scoped OIDC)
  if (!cached) cached = createGateway({ apiKey });
  return cached.textEmbeddingModel(modelId);
}

/**
 * Embed many texts; vectors come back in input order. Returns token usage too.
 * Pass an abortSignal (and a low maxRetries) from the cron so a slow/hung
 * gateway can't silently eat the whole cron budget — it becomes a fast, caught
 * per-document failure instead. (Mirrors the eval path's AbortSignal.timeout.)
 */
export async function embedTexts(
  modelId: string,
  values: string[],
  opts?: { abortSignal?: AbortSignal; maxRetries?: number },
): Promise<{ embeddings: number[][]; tokens: number | null; costUsd: number | null }> {
  const result = await embedMany({
    model: embeddingModel(modelId),
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
  modelId: string,
  value: string,
  opts?: { abortSignal?: AbortSignal; maxRetries?: number },
): Promise<{ embedding: number[]; tokens: number | null; costUsd: number | null }> {
  const result = await embed({
    model: embeddingModel(modelId),
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

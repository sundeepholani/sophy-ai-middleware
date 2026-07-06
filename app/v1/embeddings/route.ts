/**
 * OpenAI-compatible embeddings endpoint — POST /v1/embeddings.
 *
 * Same key-owned model contract as every other surface: the client's `model` is
 * IGNORED — the key's embedding model wins. Pipeline mirrors images/generations:
 * authenticate the key -> verify the key's model is an embedding model ->
 * validate the request -> rate limit -> quota pre-check -> embed via the AI
 * Gateway -> record usage -> return vectors in the OpenAI Embeddings shape
 * (float or base64 per `encoding_format`).
 */
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
import { checkRateLimit, costUsedThisMonth } from '@/lib/counters';
import { openAiError, type EmbeddingsRequest } from '@/lib/http/openai';
import {
  embeddingCapability,
  parseEmbeddingsRequest,
  handleEmbeddings,
} from '@/lib/gateway/embeddings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800;
// Run near the database (Supabase ap-south-1) to minimize per-request DB latency.
export const preferredRegion = 'bom1';

export async function POST(req: Request): Promise<Response> {
  // 1) Authenticate the key (which carries the whole config).
  const token = bearerFromHeader(req.headers.get('authorization'));
  if (!token) {
    return openAiError(401, 'authentication_error', 'Missing API key.', { code: 'missing_api_key' });
  }
  const key = await verifyKey(token);
  if (!key) {
    return openAiError(401, 'authentication_error', 'Invalid API key.', { code: 'invalid_api_key' });
  }

  // 2) Parse the body. `null`/scalars are valid JSON but not a valid request —
  // reject here rather than TypeError-ing into a framework 500 downstream.
  let body: EmbeddingsRequest;
  try {
    body = (await req.json()) as EmbeddingsRequest;
  } catch {
    return openAiError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return openAiError(400, 'invalid_request_error', 'Request body must be a JSON object.');
  }

  // 3) Capability guard: this surface only works for embedding models. A model
  // positively known to the catalog as something else → clean 400. Unknown /
  // uncatalogued ids fall through and, if truly invalid, fail at the provider
  // as a 502.
  if ((await embeddingCapability(key.model)) === 'not_embedding') {
    return openAiError(
      400,
      'invalid_request_error',
      "This key's model is not an embedding model.",
      { code: 'model_not_embedding' },
    );
  }

  // 4) Validate + normalize the request (input required; format/dimensions checks).
  const parsed = parseEmbeddingsRequest(body, key.model, key.id);
  if (!parsed.ok) {
    return openAiError(parsed.status, 'invalid_request_error', parsed.message, {
      code: parsed.code,
      param: parsed.param,
    });
  }

  // 5) Rate limit + monthly quota pre-check (limits come from the key).
  const rl = await checkRateLimit(key.id, key.rpmLimit);
  if (!rl.ok) {
    const retryAfter = rl.reset ? Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000)) : 60;
    return openAiError(429, 'rate_limit_error', 'Rate limit exceeded.', {
      code: 'rate_limit_exceeded',
      headers: { 'retry-after': String(retryAfter) },
    });
  }
  if (key.monthlyCostCapUsd != null) {
    const used = await costUsedThisMonth(key.id);
    if (used >= key.monthlyCostCapUsd) {
      return openAiError(402, 'insufficient_quota', 'Monthly cost budget exceeded.', {
        code: 'quota_exceeded',
      });
    }
  }

  // 6) Embed + record usage (+ content when the key logs it) + respond.
  return handleEmbeddings(
    { keyId: key.id, model: key.model, logContent: key.logContent },
    parsed.value,
  );
}

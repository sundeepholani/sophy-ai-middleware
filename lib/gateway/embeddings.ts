/**
 * Embeddings (POST /v1/embeddings).
 *
 * Sophy proxies OpenAI-compatible embeddings through the AI Gateway. As on every
 * other surface the API key owns the model — the client's `model` is ignored and
 * the key's embedding model wins. Because the vector space is a property of the
 * model, a client migrating from direct OpenAI keeps its stored vectors valid by
 * binding the key to the same model (e.g. `openai/text-embedding-3-small`).
 *
 * `embedMany` resolves the model through the same gateway handle as the KB
 * pipeline (lib/kb/embed.ts) — request-scoped OIDC by default, explicit
 * AI_GATEWAY_API_KEY when set — and batches provider-side as needed.
 */
import { embedMany } from 'ai';
import type { ProviderMetadata } from 'ai';
import {
  recordUsage,
  extractGatewayCost,
  extractGatewayRequestId,
  ZERO_USAGE,
  type NormalizedUsage,
} from '@/lib/usage/record';
import { openAiError, type EmbeddingsRequest, type EmbeddingsResponse } from '@/lib/http/openai';
import { providerOf } from '@/lib/gateway/call';
import { embeddingModel } from '@/lib/kb/embed';
import { listAllModels } from '@/lib/gateway/models';
import { type AvailableModel } from '@/lib/gateway/capabilities';

/** OpenAI allows up to 2048 inputs per embeddings request. */
const MAX_INPUTS = 2048;

// ---- Capability guard -------------------------------------------------------

/** Pure: is this catalog model an embedding model? */
export function modelSupportsEmbeddings(m: AvailableModel): boolean {
  return m.type === 'embedding';
}

/**
 * Classify a key's model against the (cached) gateway catalog. Returns
 * `'not_embedding'` only when the model is positively known to be something
 * else — an unknown id or an unavailable catalog returns `'unknown'` so we never
 * block a valid request on a catalog blip (a genuinely wrong id then fails at
 * the provider as a 502, which is correct).
 */
export async function embeddingCapability(
  model: string,
): Promise<'embedding' | 'not_embedding' | 'unknown'> {
  let all: AvailableModel[];
  try {
    all = await listAllModels();
  } catch {
    return 'unknown';
  }
  const m = all.find((x) => x.id === model);
  if (!m) return 'unknown';
  return modelSupportsEmbeddings(m) ? 'embedding' : 'not_embedding';
}

// ---- Request parsing (pure) -------------------------------------------------

export interface ParsedEmbeddingsRequest {
  /** Normalized to an array; single-string input becomes a 1-element array. */
  values: string[];
  encodingFormat: 'float' | 'base64';
  /** Namespaced provider options: gateway attribution + provider-specific knobs. */
  providerOptions: Record<string, Record<string, unknown>>;
}

export type ParseEmbeddingsResult =
  | { ok: true; value: ParsedEmbeddingsRequest }
  | { ok: false; status: number; message: string; code?: string; param?: string };

/**
 * Validate + normalize an embeddings request into `embedMany` args. Pure (no
 * I/O) so it is unit-testable. Token-array inputs (arrays of integers, which the
 * OpenAI API accepts as pre-tokenized input) are rejected with a clean 400 —
 * tokenizations are model-specific and don't survive a gateway that can rebind
 * the key to a different model.
 */
export function parseEmbeddingsRequest(
  body: EmbeddingsRequest,
  model: string,
  keyId: string,
): ParseEmbeddingsResult {
  const input = body.input;
  if (input == null || input === '') {
    return { ok: false, status: 400, message: 'Missing required parameter: input.', param: 'input' };
  }

  let values: string[];
  if (typeof input === 'string') {
    values = [input];
  } else if (Array.isArray(input)) {
    if (input.length === 0) {
      return { ok: false, status: 400, message: 'input must not be an empty array.', param: 'input' };
    }
    if (input.length > MAX_INPUTS) {
      return {
        ok: false,
        status: 400,
        message: `input must not contain more than ${MAX_INPUTS} items.`,
        param: 'input',
      };
    }
    if (!input.every((v): v is string => typeof v === 'string')) {
      return {
        ok: false,
        status: 400,
        message: 'Token-array inputs are not supported — send strings.',
        param: 'input',
        code: 'token_input_unsupported',
      };
    }
    if (input.some((v) => v === '')) {
      return { ok: false, status: 400, message: 'input strings must not be empty.', param: 'input' };
    }
    values = input;
  } else {
    return { ok: false, status: 400, message: 'input must be a string or an array of strings.', param: 'input' };
  }

  if (
    body.encoding_format != null &&
    body.encoding_format !== 'float' &&
    body.encoding_format !== 'base64'
  ) {
    return {
      ok: false,
      status: 400,
      message: 'encoding_format must be "float" or "base64".',
      param: 'encoding_format',
      code: 'unsupported_encoding_format',
    };
  }

  // Forward provider-specific knobs only when the client set them.
  const knobs: Record<string, unknown> = {};
  if (body.dimensions != null) {
    if (!Number.isInteger(body.dimensions) || body.dimensions < 1) {
      return { ok: false, status: 400, message: 'dimensions must be a positive integer.', param: 'dimensions' };
    }
    knobs.dimensions = body.dimensions;
  }

  const providerOptions: Record<string, Record<string, unknown>> = {
    gateway: { user: keyId, tags: [`key:${keyId}`.slice(0, 64)] },
  };
  if (Object.keys(knobs).length > 0) providerOptions[providerOf(model)] = knobs;

  return {
    ok: true,
    value: { values, encodingFormat: body.encoding_format ?? 'float', providerOptions },
  };
}

// ---- Response mapping (pure) ------------------------------------------------

/** OpenAI's base64 embedding encoding: little-endian float32 bytes. */
export function toBase64Embedding(vector: number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64');
}

/** Pure: map embedding vectors to the OpenAI Embeddings response shape. */
export function toEmbeddingsResponse(
  embeddings: ReadonlyArray<number[]>,
  model: string,
  encodingFormat: 'float' | 'base64',
  tokens: number,
): EmbeddingsResponse {
  return {
    object: 'list',
    data: embeddings.map((embedding, index) => ({
      object: 'embedding' as const,
      index,
      embedding: encodingFormat === 'base64' ? toBase64Embedding(embedding) : embedding,
    })),
    model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
}

// ---- Orchestrator (side-effectful) ------------------------------------------

export interface EmbeddingsCallContext {
  keyId: string;
  /** Full AI Gateway embedding-model id, e.g. "openai/text-embedding-3-small". */
  model: string;
}

/**
 * Embed the inputs and record usage. Usage is awaited (non-streaming path) so
 * the cost row is durably written before the function returns — matching the
 * image handler. Embedding usage is input-only: tokens land in inputTokens and
 * totalTokens; outputTokens stays 0.
 */
export async function handleEmbeddings(
  ctx: EmbeddingsCallContext,
  parsed: ParsedEmbeddingsRequest,
): Promise<Response> {
  const startedAt = Date.now();
  const provider = providerOf(ctx.model);
  try {
    const result = await embedMany({
      model: embeddingModel(ctx.model),
      values: parsed.values,
      providerOptions: parsed.providerOptions as never,
    });

    const tokens = result.usage?.tokens ?? 0;
    const usage: NormalizedUsage = {
      ...ZERO_USAGE,
      inputTokens: tokens,
      totalTokens: tokens,
    };
    const pm = result.providerMetadata as ProviderMetadata | undefined;
    await recordUsage({
      keyId: ctx.keyId,
      provider,
      model: ctx.model,
      usage,
      costUsd: extractGatewayCost(pm),
      latencyMs: Date.now() - startedAt,
      status: 'ok',
      responseKind: 'embedding',
      gatewayRequestId: extractGatewayRequestId(pm),
    });

    const payload = toEmbeddingsResponse(result.embeddings, ctx.model, parsed.encodingFormat, tokens);
    return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    await recordUsage({
      keyId: ctx.keyId,
      provider,
      model: ctx.model,
      usage: { ...ZERO_USAGE },
      latencyMs: Date.now() - startedAt,
      status: 'error',
      responseKind: 'embedding',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return openAiError(502, 'api_error', 'The embeddings request failed.', {
      code: 'upstream_error',
    });
  }
}

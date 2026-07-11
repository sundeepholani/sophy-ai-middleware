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
import { randomUUID } from 'node:crypto';
import { embedMany } from 'ai';
import type { ProviderMetadata } from 'ai';
import {
  recordUsage,
  recordEmbeddingLog,
  extractGatewayCost,
  extractGatewayRequestId,
  ZERO_USAGE,
  type NormalizedUsage,
} from '@/lib/usage/record';
import type { EmbeddingsRequest, EmbeddingsResponse } from '@/lib/http/openai';
import { upstreamErrorResponse } from '@/lib/gateway/upstream-error';
import { providerOf } from '@/lib/gateway/call';
import { embeddingModel } from '@/lib/kb/embed';
import { listAllModels } from '@/lib/gateway/models';
import { type AvailableModel } from '@/lib/gateway/capabilities';

/**
 * OpenAI allows up to 2048 inputs per embeddings request. This also equals the
 * gateway SDK's maxEmbeddingsPerCall (2048), so every request is a single
 * provider call — which matters because embedMany's multi-chunk merge keeps only
 * the LAST chunk's providerMetadata (gateway cost). If this cap is ever raised
 * past the SDK's, sum cost from result.responses instead of providerMetadata.
 */
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
      const looksTokenized = input.some((v) => typeof v === 'number' || Array.isArray(v));
      return {
        ok: false,
        status: 400,
        message: looksTokenized
          ? 'Token-array inputs are not supported — send strings.'
          : 'input array items must all be strings.',
        param: 'input',
        code: looksTokenized ? 'token_input_unsupported' : undefined,
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
    if (!Number.isInteger(body.dimensions) || body.dimensions < 1 || body.dimensions > 100_000) {
      return { ok: false, status: 400, message: 'dimensions must be a positive integer.', param: 'dimensions' };
    }
    // The AI SDK option name `dimensions` is OpenAI's; other embedding providers
    // spell it differently (Google: outputDimensionality, …) and the SDK silently
    // ignores unknown options — which would hand the client full-size vectors it
    // didn't ask for. Reject rather than silently poison a vector store.
    if (providerOf(model) !== 'openai') {
      return {
        ok: false,
        status: 400,
        message: 'dimensions is only supported for openai/* embedding models.',
        param: 'dimensions',
        code: 'dimensions_unsupported',
      };
    }
    knobs.dimensions = body.dimensions;
  }

  // No gateway user/tags metadata: attribution lives in Sophy's own
  // usage_events, and the gateway bills a per-request surcharge for tags.
  const providerOptions: Record<string, Record<string, unknown>> = {};
  if (Object.keys(knobs).length > 0) providerOptions[providerOf(model)] = knobs;

  return {
    ok: true,
    value: { values, encodingFormat: body.encoding_format ?? 'float', providerOptions },
  };
}

// ---- Response mapping (pure) ------------------------------------------------

/**
 * OpenAI's base64 embedding encoding: little-endian float32 bytes. Float32Array
 * uses platform byte order — every deploy target (Vercel x86/ARM) is LE, and the
 * official openai clients decode platform-native too, so this matches the wire
 * contract without a per-element DataView pass.
 */
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
  /** When true, capture the embedded inputs to request_logs (key's logContent). */
  logContent: boolean;
}

/**
 * Embed the inputs and record usage. Usage is awaited (non-streaming path) so
 * the cost row is durably written before the function returns — matching the
 * image handler. Embedding usage is input-only: tokens land in inputTokens and
 * totalTokens; outputTokens stays 0.
 *
 * When the key logs content, the embedded inputs are captured to request_logs
 * under a shared event id (so the log-detail join finds them) — on success and
 * on failure, mirroring the chat/responses surfaces.
 */
export async function handleEmbeddings(
  ctx: EmbeddingsCallContext,
  parsed: ParsedEmbeddingsRequest,
): Promise<Response> {
  const startedAt = Date.now();
  const provider = providerOf(ctx.model);
  const eventId = randomUUID();
  const logInputs = (status: 'ok' | 'error') =>
    ctx.logContent
      ? recordEmbeddingLog({ id: eventId, keyId: ctx.keyId, inputs: parsed.values, status })
      : Promise.resolve();
  try {
    const result = await embedMany({
      model: embeddingModel(ctx.model),
      values: parsed.values,
      providerOptions: parsed.providerOptions as never,
    });
    if (result.warnings?.length) {
      console.warn('[embeddings] provider warnings', { model: ctx.model, warnings: result.warnings });
    }

    // The gateway may omit usage, and embedMany's chunked path substitutes (and
    // sums) NaN in that case — NaN is not nullish, so `?? 0` alone won't catch
    // it, and it would both break the usage insert (losing the cost charge) and
    // serialize as `"prompt_tokens": null` on the wire.
    const rawTokens = result.usage?.tokens;
    const tokens = Number.isFinite(rawTokens) ? (rawTokens as number) : 0;
    const usage: NormalizedUsage = {
      ...ZERO_USAGE,
      inputTokens: tokens,
      totalTokens: tokens,
    };
    const pm = result.providerMetadata as ProviderMetadata | undefined;
    await recordUsage({
      id: eventId,
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
    await logInputs('ok');

    const payload = toEmbeddingsResponse(result.embeddings, ctx.model, parsed.encodingFormat, tokens);
    return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    await recordUsage({
      id: eventId,
      keyId: ctx.keyId,
      provider,
      model: ctx.model,
      usage: { ...ZERO_USAGE },
      latencyMs: Date.now() - startedAt,
      status: 'error',
      responseKind: 'embedding',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    await logInputs('error');
    return upstreamErrorResponse(err, 'The embeddings request failed.');
  }
}

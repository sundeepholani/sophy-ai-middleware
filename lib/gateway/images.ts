/**
 * Image generation (POST /v1/images/generations).
 *
 * Sophy proxies OpenAI-compatible image generation through the AI Gateway. As on
 * every other surface the API key owns the model — the client's `model` is
 * ignored and the key's image model wins. The proxy never stores generated
 * images: it returns them inline as base64 (`b64_json`), the only format
 * supported in v1.
 *
 * `generateImage` accepts a bare gateway model id (`type ImageModel = string |
 * ImageModelV3`), so we pass `key.model` straight through exactly as the chat
 * path passes `ctx.model` to `generateText` — same OIDC gateway, no extra wiring.
 */
import { generateImage, type ProviderMetadata } from 'ai';
import {
  recordUsage,
  extractGatewayCost,
  extractGatewayRequestId,
  ZERO_USAGE,
} from '@/lib/usage/record';
import { openAiError, type ImageGenerationRequest, type ImageGenerationResponse } from '@/lib/http/openai';
import { providerOf } from '@/lib/gateway/call';
import { listAllModels } from '@/lib/gateway/models';
import { type AvailableModel } from '@/lib/gateway/capabilities';

const SIZE_RE = /^\d{2,5}x\d{2,5}$/;
const MAX_IMAGES = 10;

// ---- Capability guard -------------------------------------------------------

/** Pure: does this catalog model produce images? */
export function modelSupportsImageGeneration(m: AvailableModel): boolean {
  return m.type === 'image' || m.tags.includes('image-generation');
}

/**
 * Classify a key's model against the (cached) gateway catalog. Returns
 * `'not_image'` only when the model is positively known to be non-image — an
 * unknown id or an unavailable catalog returns `'unknown'` so we never block a
 * valid request on a catalog blip (a genuinely wrong id then fails at the
 * provider as a 502, which is correct).
 */
export async function imageCapability(model: string): Promise<'image' | 'not_image' | 'unknown'> {
  let all: AvailableModel[];
  try {
    all = await listAllModels();
  } catch {
    return 'unknown';
  }
  const m = all.find((x) => x.id === model);
  if (!m) return 'unknown';
  return modelSupportsImageGeneration(m) ? 'image' : 'not_image';
}

// ---- Request parsing (pure) -------------------------------------------------

export interface ParsedImageRequest {
  prompt: string;
  n?: number;
  size?: string;
  /** Namespaced provider options: gateway attribution + provider-specific knobs. */
  providerOptions: Record<string, Record<string, unknown>>;
}

export type ParseImageResult =
  | { ok: true; value: ParsedImageRequest }
  | { ok: false; status: number; message: string; code?: string; param?: string };

/**
 * Validate + normalize an image request into `generateImage` args. Pure (no I/O)
 * so it is unit-testable. Mirrors how the chat route validates its body, surfacing
 * client mistakes as clean 400s rather than provider 502s.
 */
export function parseImageRequest(
  body: ImageGenerationRequest,
  model: string,
  keyId: string,
): ParseImageResult {
  if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
    return { ok: false, status: 400, message: 'Missing required parameter: prompt.', param: 'prompt' };
  }

  // v1 returns base64 only; reject an explicit url request rather than silently
  // handing back a different format than the client asked for.
  if (body.response_format != null && body.response_format !== 'b64_json') {
    return {
      ok: false,
      status: 400,
      message: 'Only response_format "b64_json" is supported.',
      param: 'response_format',
      code: 'unsupported_response_format',
    };
  }

  let n: number | undefined;
  if (body.n != null) {
    if (!Number.isInteger(body.n) || body.n < 1 || body.n > MAX_IMAGES) {
      return { ok: false, status: 400, message: `n must be an integer between 1 and ${MAX_IMAGES}.`, param: 'n' };
    }
    n = body.n;
  }

  let size: string | undefined;
  if (body.size != null) {
    if (typeof body.size !== 'string' || !SIZE_RE.test(body.size)) {
      return { ok: false, status: 400, message: 'size must look like "1024x1024".', param: 'size' };
    }
    size = body.size;
  }

  // Forward provider-specific knobs only when the client set them.
  const knobs: Record<string, unknown> = {};
  if (body.quality != null) knobs.quality = body.quality;
  if (body.style != null) knobs.style = body.style;
  if (body.background != null) knobs.background = body.background;
  if (body.output_format != null) knobs.output_format = body.output_format;

  const providerOptions: Record<string, Record<string, unknown>> = {
    gateway: { user: keyId, tags: [`key:${keyId}`.slice(0, 64)] },
  };
  if (Object.keys(knobs).length > 0) providerOptions[providerOf(model)] = knobs;

  return { ok: true, value: { prompt: body.prompt, n, size, providerOptions } };
}

// ---- Response mapping (pure) ------------------------------------------------

/** Pure: map generated images to the OpenAI Images response shape. */
export function toImageResponse(
  images: ReadonlyArray<{ base64: string }>,
  createdAtSec: number,
): ImageGenerationResponse {
  return { created: createdAtSec, data: images.map((im) => ({ b64_json: im.base64 })) };
}

// ---- Orchestrator (side-effectful) ------------------------------------------

export interface ImageCallContext {
  keyId: string;
  /** Full AI Gateway image-model id, e.g. "openai/gpt-image-1". */
  model: string;
}

/**
 * Generate images and record usage. Usage is awaited (non-streaming path) so the
 * cost row is durably written before the function returns — matching the chat
 * non-streaming handler. Cost comes from the gateway's providerMetadata; token
 * counts are zero for images (they bill per image), which the usage schema
 * already allows.
 */
export async function handleImageGeneration(
  ctx: ImageCallContext,
  parsed: ParsedImageRequest,
): Promise<Response> {
  const startedAt = Date.now();
  const provider = providerOf(ctx.model);
  try {
    const result = await generateImage({
      model: ctx.model,
      prompt: parsed.prompt,
      ...(parsed.n !== undefined ? { n: parsed.n } : {}),
      ...(parsed.size !== undefined ? { size: parsed.size as `${number}x${number}` } : {}),
      providerOptions: parsed.providerOptions as never,
    });

    // generateImage returns ImageModelProviderMetadata, which isn't assignable to
    // the language ProviderMetadata our extractors expect — they read the same
    // `gateway.{cost,generationId}` keys, so cast through unknown.
    const pm = result.providerMetadata as unknown as ProviderMetadata | undefined;
    await recordUsage({
      keyId: ctx.keyId,
      provider,
      model: ctx.model,
      usage: ZERO_USAGE,
      costUsd: extractGatewayCost(pm),
      latencyMs: Date.now() - startedAt,
      status: 'ok',
      responseKind: 'image',
      gatewayRequestId: extractGatewayRequestId(pm),
    });

    const payload = toImageResponse(result.images, Math.floor(startedAt / 1000));
    return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    await recordUsage({
      keyId: ctx.keyId,
      provider,
      model: ctx.model,
      usage: ZERO_USAGE,
      latencyMs: Date.now() - startedAt,
      status: 'error',
      responseKind: 'image',
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return openAiError(502, 'api_error', 'The image generation request failed.', {
      code: 'upstream_error',
    });
  }
}

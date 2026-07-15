/**
 * OpenAI-compatible image generation endpoint — POST /v1/images/generations.
 *
 * Same key-owned model contract as every other surface: the client's `model` is
 * IGNORED — the key's image model wins. Pipeline mirrors chat/completions:
 * authenticate the key -> verify the key's model is image-capable -> validate the
 * request -> rate limit -> quota pre-check -> generate via the AI Gateway ->
 * record usage -> return base64 images in the OpenAI Images shape.
 */
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
import { checkRateLimit, costUsedThisMonth } from '@/lib/counters';
import { openAiError, type ImageGenerationRequest } from '@/lib/http/openai';
import { imageCapability, parseImageRequest, handleImageGeneration } from '@/lib/gateway/images';
import {
  projectGatewayUnavailableResponse,
  resolveProjectGateway,
} from '@/lib/gateway/project-provider';

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
  let gateway;
  try {
    gateway = await resolveProjectGateway(key.projectId);
  } catch (error) {
    const unavailable = projectGatewayUnavailableResponse(error);
    if (unavailable) return unavailable;
    console.error('[gateway] project provider resolution failed', { projectId: key.projectId });
    return openAiError(503, 'api_error', 'This project is temporarily unable to make AI requests.', {
      code: 'project_gateway_unavailable',
    });
  }

  // 2) Parse the body.
  let body: ImageGenerationRequest;
  try {
    body = (await req.json()) as ImageGenerationRequest;
  } catch {
    return openAiError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }

  // 3) Capability guard: this surface only works for image models. A language
  // model positively known to the catalog → clean 400 (the inverse of the chat
  // route's tool/structured-output guards). Unknown/uncatalogued ids fall through
  // and, if truly invalid, fail at the provider as a 502.
  if ((await imageCapability(key.model)) === 'not_image') {
    return openAiError(
      400,
      'invalid_request_error',
      "This key's model does not support image generation.",
      { code: 'model_not_image' },
    );
  }

  // 4) Validate + normalize the request (prompt required; n/size/format checks).
  const parsed = parseImageRequest(body, key.model);
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

  // 6) Generate + record usage + respond.
  return handleImageGeneration({ keyId: key.id, gateway, model: key.model }, parsed.value);
}

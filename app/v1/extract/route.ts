/**
 * Native typed-extraction endpoint — POST /v1/extract (Cloudflare Workers AI Clairic).
 *
 * Same key-owned model contract as every other surface: the client's `model` is
 * IGNORED — the key's extraction model wins. Pipeline mirrors /v1/evaluate:
 * authenticate the key -> resolve the project's Cloudflare credential (only for
 * registered extraction keys; never the Vercel gateway) -> parse JSON -> verify the
 * key's model is a registered extraction model -> validate the request -> rate
 * limit -> quota pre-check -> extract via Workers AI -> record usage -> return the
 * typed answers.
 *
 * Native and buffered, NOT OpenAI-compatible: no OpenAI client method reaches
 * typed extraction. Clairic is a Cloudflare research preview, so its answers are
 * passed through as returned. The path is a verb on purpose, like /v1/evaluate —
 * do not "fix" it to /v1/extractions. proxy.ts does not cover /v1, so this route
 * authenticates itself.
 */
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
import { checkRateLimit, costUsedThisMonth } from '@/lib/counters';
import { openAiError, type ExtractionRequest } from '@/lib/http/openai';
import {
  resolveProjectCloudflare,
  type ProjectCloudflareSnapshot,
} from '@/lib/gateway/cloudflare-provider';
import { projectGatewayUnavailableResponse } from '@/lib/gateway/project-provider';
import { parseExtractionRequest } from '@/lib/gateway/extraction-parse';
import { handleExtraction, isExtractionModel } from '@/lib/gateway/extraction';

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

  // 2) Resolve the project's Cloudflare credential, for registered extraction keys only.
  //    Never the Vercel gateway: a Vercel outage or 402 must not block Clairic (D3). Any
  //    other key, a Clef key included, has nothing to resolve here and gets the guard's
  //    400 below rather than a misleading credential 503.
  let cloudflare: ProjectCloudflareSnapshot | undefined;
  if (isExtractionModel(key.model)) {
    try {
      cloudflare = await resolveProjectCloudflare(key.projectId);
    } catch (error) {
      const unavailable = projectGatewayUnavailableResponse(error);
      if (unavailable) return unavailable;
      console.error('[cloudflare] project credential resolution failed', { projectId: key.projectId });
      return openAiError(503, 'api_error', 'This project is temporarily unable to make AI requests.', {
        code: 'project_gateway_unavailable',
      });
    }
  }

  // 3) Parse the body. `null`/scalars are valid JSON but not a valid request —
  // reject here rather than TypeError-ing into a framework 500 downstream.
  let body: ExtractionRequest;
  try {
    body = (await req.json()) as ExtractionRequest;
  } catch {
    return openAiError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return openAiError(400, 'invalid_request_error', 'Request body must be a JSON object.');
  }

  // 4) Capability guard: a REGISTERED extraction model, read synchronously from the
  // static registry. Unlike /v1/evaluate this fails CLOSED: Workers AI ids have no
  // catalog path, and an unregistered '@cf/' id has no price, selector or safe URL
  // (D4, D9). `!cloudflare` only narrows the type: step 2 resolved every extraction key.
  if (!cloudflare || !isExtractionModel(key.model)) {
    return openAiError(400, 'invalid_request_error', "This key's model is not an extraction model.", {
      code: 'model_not_extraction',
    });
  }

  // 5) Validate + normalize the request (state, typed fields, assets, options).
  const parsed = parseExtractionRequest(body, key.model);
  if (!parsed.ok) {
    return openAiError(parsed.status, 'invalid_request_error', parsed.message, {
      code: parsed.code,
      param: parsed.param,
    });
  }

  // 6) Rate limit + monthly quota pre-check (limits come from the key).
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

  // 7) Extract + record usage (+ content when the key logs it) + respond.
  return handleExtraction(
    { keyId: key.id, model: key.model, logContent: key.logContent, cloudflare },
    parsed.value,
  );
}

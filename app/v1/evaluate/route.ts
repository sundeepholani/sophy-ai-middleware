/**
 * Native model-assessment endpoint — POST /v1/evaluate.
 *
 * Same key-owned model contract as every other surface: the client's `model` is
 * IGNORED — the key's evaluation model wins. Pipeline mirrors embeddings:
 * authenticate the key -> resolve the credential for the key's model (the
 * project's Vercel AI Gateway credential, or its Cloudflare Workers AI credential
 * for registered Clef models; any other `@cf/` id resolves nothing and fails the
 * guard, as on /v1/extract) -> parse JSON -> verify the key's model is an
 * evaluation model -> validate the request -> rate limit -> quota pre-check ->
 * evaluate upstream (AI Gateway, or Cloudflare Workers AI for Clef) -> record
 * usage -> return the typed answers.
 *
 * Vercel documents evaluation as unavailable through the OpenAI-compatible
 * endpoints, so this path mirrors the gateway's own POST /v1/evaluate rather
 * than an OpenAI-shaped plural noun. Do not "fix" it to /v1/evaluations.
 */
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
import { checkRateLimit, costUsedThisMonth } from '@/lib/counters';
import { openAiError, type EvaluationRequest } from '@/lib/http/openai';
import {
  assessmentCapability,
  parseAssessmentRequest,
  handleAssessment,
} from '@/lib/gateway/assessments';
import {
  projectGatewayUnavailableResponse,
  resolveProjectGateway,
  type ProjectGatewaySnapshot,
} from '@/lib/gateway/project-provider';
import {
  resolveProjectCloudflare,
  type ProjectCloudflareSnapshot,
} from '@/lib/gateway/cloudflare-provider';
import { getCloudflareModel, isCloudflareModelId } from '@/lib/gateway/cloudflare-models';

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
  // The key's model picks the ONE credential this request may use: the project's
  // own Cloudflare Workers AI credential for registered Clef models, the project's
  // Vercel AI Gateway credential for every non-'@cf/' model. A '@cf/' key never
  // resolves Vercel, so a Vercel outage or 402 cannot block Clef (and vice versa).
  // Any other '@cf/' id (Clairic, or one the registry does not list) has nothing to
  // resolve here: it gets the guard's 400 below rather than a misleading credential
  // 503, exactly as /v1/extract treats a non-extraction key.
  const cloudflareKey = isCloudflareModelId(key.model);
  let upstream: { gateway: ProjectGatewaySnapshot } | { cloudflare: ProjectCloudflareSnapshot } | undefined;
  if (!cloudflareKey || getCloudflareModel(key.model)?.type === 'evaluation') {
    try {
      upstream = cloudflareKey
        ? { cloudflare: await resolveProjectCloudflare(key.projectId) }
        : { gateway: await resolveProjectGateway(key.projectId) };
    } catch (error) {
      const unavailable = projectGatewayUnavailableResponse(error);
      if (unavailable) return unavailable;
      console.error('[gateway] project provider resolution failed', {
        projectId: key.projectId,
        provider: cloudflareKey ? 'cloudflare' : 'vercel',
      });
      return openAiError(503, 'api_error', 'This project is temporarily unable to make AI requests.', {
        code: 'project_gateway_unavailable',
      });
    }
  }

  // 2) Parse the body. `null`/scalars are valid JSON but not a valid request —
  // reject here rather than TypeError-ing into a framework 500 downstream.
  let body: EvaluationRequest;
  try {
    body = (await req.json()) as EvaluationRequest;
  } catch {
    return openAiError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return openAiError(400, 'invalid_request_error', 'Request body must be a JSON object.');
  }

  // 3) Capability guard: this surface only works for evaluation models. A model
  // positively known to the catalog as something else → clean 400. Unknown /
  // uncatalogued ids fall through and, if truly invalid, fail at the provider
  // as a 502 — evaluation models are new, so a stale warm catalog must not
  // reject a freshly bound key. A `@cf/` id is classified synchronously from the
  // code-reviewed Cloudflare registry and fails closed when it is not a registered
  // evaluation model; only non-`@cf/` ids fail open. `!upstream` is the same rule
  // read from step 1: only such a `@cf/` id resolved no credential.
  if ((await assessmentCapability(key.model)) === 'not_assessment' || !upstream) {
    return openAiError(
      400,
      'invalid_request_error',
      "This key's model is not an evaluation model.",
      { code: 'model_not_evaluation' },
    );
  }

  // 4) Validate + normalize the request (state + typed questions).
  const parsed = parseAssessmentRequest(body, key.model);
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

  // 6) Evaluate + record usage (+ content when the key logs it) + respond.
  return handleAssessment(
    { keyId: key.id, ...upstream, model: key.model, logContent: key.logContent },
    parsed.value,
  );
}

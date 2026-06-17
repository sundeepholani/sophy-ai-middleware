/**
 * OpenAI-compatible chat completions endpoint — the client-facing front door.
 *
 * Pipeline: authenticate our key -> rate limit -> quota pre-check -> resolve the
 * named route (the `model` field is a route name) -> inject the operator master
 * prompt (drop client system messages) -> clamp params -> reject tool calls ->
 * call the AI Gateway -> map to the OpenAI wire shape. Usage/quota accounting
 * happens after the response (see lib/gateway/call.ts).
 */
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { quotaPolicies } from '@/db/schema';
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
import { checkRateLimit, quotaUsed } from '@/lib/counters';
import { resolveRoute, keyAllowsRoute } from '@/lib/routing/resolve';
import { toModelMessages, resolveParams } from '@/lib/gateway/openai-map';
import { handleNonStreaming, handleStreaming, type CallContext } from '@/lib/gateway/call';
import { assertOwnedBlobs, extractReferencedUrls } from '@/lib/files/blob';
import { openAiError, type ChatCompletionRequest } from '@/lib/http/openai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800;
// Run near the database (Supabase ap-south-1) to minimize per-request DB latency.
export const preferredRegion = 'bom1';

/** Reject client-supplied schemas that are too large or deeply nested. */
function schemaWithinBounds(schema: unknown): boolean {
  const s = JSON.stringify(schema);
  if (!s || s.length > 20_000) return false;
  let depth = 0;
  let max = 0;
  for (const ch of s) {
    if (ch === '{' || ch === '[') {
      depth++;
      max = Math.max(max, depth);
    } else if (ch === '}' || ch === ']') {
      depth--;
    }
  }
  return max <= 12;
}

export async function POST(req: Request): Promise<Response> {
  // 1) Authenticate our key.
  const token = bearerFromHeader(req.headers.get('authorization'));
  if (!token) {
    return openAiError(401, 'authentication_error', 'Missing API key.', {
      code: 'missing_api_key',
    });
  }
  const key = await verifyKey(token);
  if (!key) {
    return openAiError(401, 'authentication_error', 'Invalid API key.', {
      code: 'invalid_api_key',
    });
  }

  // 2) Parse the body.
  let body: ChatCompletionRequest;
  try {
    body = (await req.json()) as ChatCompletionRequest;
  } catch {
    return openAiError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }

  const routeName = body.model;
  if (!routeName || typeof routeName !== 'string') {
    return openAiError(400, 'invalid_request_error', 'Missing required parameter: model.', {
      param: 'model',
    });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return openAiError(400, 'invalid_request_error', 'Missing required parameter: messages.', {
      param: 'messages',
    });
  }

  // 3) Reject tool/function calling (not supported in v1 — never silently drop).
  if (
    (Array.isArray(body.tools) && body.tools.length > 0) ||
    (Array.isArray(body.functions) && body.functions.length > 0) ||
    (body.tool_choice != null && body.tool_choice !== 'none')
  ) {
    return openAiError(
      400,
      'invalid_request_error',
      'Tool/function calling is not supported by this endpoint.',
      { param: 'tools', code: 'tools_unsupported' },
    );
  }

  // 4) Scope check.
  if (!keyAllowsRoute(key.scopes, routeName)) {
    return openAiError(404, 'not_found_error', `The model '${routeName}' does not exist or you do not have access to it.`, {
      param: 'model',
      code: 'model_not_found',
    });
  }

  // 5) Load policy (rate limit + quota cap).
  const [policy] = await getDb()
    .select()
    .from(quotaPolicies)
    .where(eq(quotaPolicies.apiKeyId, key.id))
    .limit(1);

  // 6) Rate limit.
  const rl = await checkRateLimit(key.id, policy?.rpmLimit ?? null);
  if (!rl.ok) {
    const retryAfter = rl.reset ? Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000)) : 60;
    return openAiError(429, 'rate_limit_error', 'Rate limit exceeded.', {
      code: 'rate_limit_exceeded',
      headers: { 'retry-after': String(retryAfter) },
    });
  }

  // 7) Quota pre-check (period-keyed token cap).
  if (policy?.monthlyTokenCap != null) {
    const used = await quotaUsed(key.id);
    if (used >= policy.monthlyTokenCap) {
      return openAiError(402, 'insufficient_quota', 'Monthly token quota exceeded.', {
        code: 'quota_exceeded',
      });
    }
  }

  // 8) Resolve the named route.
  const resolved = await resolveRoute(key.clientId, routeName);
  if (!resolved) {
    return openAiError(404, 'not_found_error', `The model '${routeName}' does not exist or you do not have access to it.`, {
      param: 'model',
      code: 'model_not_found',
    });
  }

  // 9) Determine structured output + schema.
  let schema: Record<string, unknown> | null = resolved.outputSchema;
  if (
    resolved.mode === 'overridable' &&
    body.response_format?.type === 'json_schema' &&
    body.response_format.json_schema?.schema
  ) {
    const candidate = body.response_format.json_schema.schema;
    if (!schemaWithinBounds(candidate)) {
      return openAiError(
        400,
        'invalid_request_error',
        'Supplied json_schema is too large or too deeply nested.',
        { param: 'response_format' },
      );
    }
    schema = candidate;
  }
  const structured = schema != null;

  // 10) Build messages (drops client system/developer/tool roles).
  const messages = toModelMessages(body.messages);
  if (messages.length === 0) {
    return openAiError(400, 'invalid_request_error', 'No user or assistant messages provided.', {
      param: 'messages',
    });
  }

  // Cross-tenant blob protection: a client may not reference another client's
  // uploaded file. External/public URLs pass through.
  const referencedUrls = extractReferencedUrls(body.messages);
  if (referencedUrls.length > 0) {
    const ok = await assertOwnedBlobs(key.clientId, referencedUrls);
    if (!ok) {
      return openAiError(403, 'invalid_request_error', 'Referenced file is not accessible to this key.', {
        code: 'file_access_denied',
      });
    }
  }

  // 11) Resolve params (clamped on overridable routes; operator-owned on locked).
  const params = resolveParams(resolved.params, resolved.paramBounds, resolved.mode, body);

  const ctx: CallContext = {
    keyId: key.id,
    clientId: key.clientId,
    resolved,
    messages,
    params,
    structured,
    schema,
    includeUsage: body.stream_options?.include_usage === true,
  };

  // 12) Stream or buffer.
  return body.stream === true ? handleStreaming(ctx) : handleNonStreaming(ctx);
}

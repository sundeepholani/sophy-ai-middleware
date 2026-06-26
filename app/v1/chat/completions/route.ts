/**
 * OpenAI-compatible chat completions endpoint — the client-facing front door.
 *
 * In the simplified model the API key carries everything: model, system prompt,
 * params, optional output schema, and quota. The client's `model` field is
 * IGNORED — the key's model always wins. Pipeline: authenticate the key ->
 * rate limit -> quota pre-check -> inject the key's system prompt (drop client
 * system messages) -> reject tool calls -> call the AI Gateway -> map to OpenAI.
 */
import type { ModelMessage } from 'ai';
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
import { checkRateLimit, costUsedThisMonth } from '@/lib/counters';
import { toModelMessages, resolveParams, toAiToolSet } from '@/lib/gateway/openai-map';
import { handleNonStreaming, handleStreaming, type CallContext } from '@/lib/gateway/call';
import { systemPromptWithKb } from '@/lib/kb/retrieve';
import { assertOwnedBlobs, extractReferencedUrls } from '@/lib/files/blob';
import { openAiError, type ChatCompletionRequest } from '@/lib/http/openai';

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

  // 2) Parse the body.
  let body: ChatCompletionRequest;
  try {
    body = (await req.json()) as ChatCompletionRequest;
  } catch {
    return openAiError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return openAiError(400, 'invalid_request_error', 'Missing required parameter: messages.', {
      param: 'messages',
    });
  }

  // 3) Tools: client `tools` pass through to the model (Sophy returns the calls;
  // it never executes them). The legacy top-level `functions` param is still
  // unsupported — clients should use `tools`.
  if (Array.isArray(body.functions) && body.functions.length > 0) {
    return openAiError(
      400,
      'invalid_request_error',
      'The legacy `functions` parameter is not supported — use `tools`.',
      { param: 'functions', code: 'functions_unsupported' },
    );
  }
  const aiTools = toAiToolSet(body.tools, body.tool_choice);
  // A key with forced structured output can't also do tool calling — they
  // compete for the model's output channel.
  if (aiTools && key.outputSchema) {
    return openAiError(
      400,
      'invalid_request_error',
      'Tool calling is not available on a key configured for structured output.',
      { param: 'tools', code: 'tools_unsupported' },
    );
  }

  // 4) Rate limit + quota pre-check (limits come from the key).
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

  // 5) Build messages (drops client system/developer/tool roles). Mapping is pure;
  // its only failure mode is a malformed image/file URL (new URL throws), which is
  // a client error — surface it as a clean 400, not an unhandled 500.
  let messages: ModelMessage[];
  try {
    messages = toModelMessages(body.messages);
  } catch {
    return openAiError(400, 'invalid_request_error', 'A message contains a malformed image or file URL.', {
      param: 'messages',
      code: 'invalid_url',
    });
  }
  if (messages.length === 0) {
    return openAiError(400, 'invalid_request_error', 'No user or assistant messages provided.', {
      param: 'messages',
    });
  }

  // Cross-key blob protection: a key may not reference another key's upload.
  const referencedUrls = extractReferencedUrls(body.messages);
  if (referencedUrls.length > 0) {
    const ok = await assertOwnedBlobs(key.id, referencedUrls);
    if (!ok) {
      return openAiError(403, 'invalid_request_error', 'Referenced file is not accessible to this key.', {
        code: 'file_access_denied',
      });
    }
  }

  // 6) Assemble the call from the key's config. If the key has a knowledgebase,
  // embed the latest user message and fold the top-k matches into the system
  // prompt (RAG grounding); non-KB keys pay nothing here.
  const structured = key.outputSchema != null;
  const ctx: CallContext = {
    keyId: key.id,
    model: key.model,
    systemPrompt: await systemPromptWithKb(key.systemPrompt, key.knowledgebaseId, messages),
    params: resolveParams(key.params),
    structured,
    schema: key.outputSchema,
    includeUsage: body.stream_options?.include_usage === true,
    logContent: key.logContent,
    tools: aiTools?.tools,
    toolChoice: aiTools?.toolChoice,
  };

  // 7) Stream or buffer.
  return body.stream === true
    ? handleStreaming(ctx, messages)
    : handleNonStreaming(ctx, messages);
}

/**
 * OpenAI Responses-API-compatible endpoint (POST /v1/responses).
 *
 * Scoped to the text + structured-JSON path so clients using
 * `client.responses.create(...)` work by changing only base_url + api_key. The
 * key owns model/system/params (client `model`, `instructions`, params are
 * ignored — same as /v1/chat/completions) — EXCEPT agent-mode keys
 * (params.allowClientPrompt), which honor client `instructions` appended after
 * the key's prompt. Stateful conversations (`previous_response_id`) are
 * rejected with a clear 400.
 */
import type { ModelMessage } from 'ai';
import { verifyKey, bearerFromHeader } from '@/lib/auth/api-key';
import { checkRateLimit, costUsedThisMonth } from '@/lib/counters';
import { languageCapability } from '@/lib/gateway/models';
import { resolveParams, responsesToAiToolSet, composeSystemPrompt } from '@/lib/gateway/openai-map';
import { type CallContext } from '@/lib/gateway/call';
import { normalizeOutputSchema } from '@/lib/gateway/schema-normalize';
import { systemPromptWithKb } from '@/lib/kb/retrieve';
import {
  handleResponsesNonStreaming,
  handleResponsesStreaming,
} from '@/lib/gateway/responses';
import {
  responsesInputToMessages,
  responsesReferencedUrls,
  collectResponsesClientSystemText,
  type ResponsesRequest,
} from '@/lib/http/responses';
import { assertOwnedBlobs, extractModelImageUrls } from '@/lib/files/blob';
import { IMAGE_INPUT_RETENTION_DAYS } from '@/lib/usage/record';
import { openAiError } from '@/lib/http/openai';
import {
  projectGatewayUnavailableResponse,
  resolveProjectGateway,
} from '@/lib/gateway/project-provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800;
export const preferredRegion = 'bom1';

export async function POST(req: Request): Promise<Response> {
  const requestStartedAt = new Date();
  // 1) Authenticate the key (carries the whole config).
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
  let body: ResponsesRequest;
  try {
    body = (await req.json()) as ResponsesRequest;
  } catch {
    return openAiError(400, 'invalid_request_error', 'Request body must be valid JSON.');
  }
  if (body.input == null) {
    return openAiError(400, 'invalid_request_error', 'Missing required parameter: input.', {
      param: 'input',
    });
  }

  // 3) Reject unsupported features (loudly, not silently).
  const aiTools = responsesToAiToolSet(body.tools, body.tool_choice);
  if (aiTools && key.outputSchema) {
    return openAiError(
      400,
      'invalid_request_error',
      'Tool calling is not available on a key configured for structured output.',
      { param: 'tools', code: 'tools_unsupported' },
    );
  }
  if (body.previous_response_id != null) {
    return openAiError(
      400,
      'invalid_request_error',
      'Stateful conversations (previous_response_id) are not supported; send the full input each call.',
      { param: 'previous_response_id', code: 'stateful_unsupported' },
    );
  }

  // 4) Capability guard: this surface only works for language models. A model
  // positively known to the catalog as something else (transcription,
  // embedding, image, evaluation) → clean 400. Unknown / uncatalogued ids fall
  // through and, if truly invalid, fail at the provider.
  //
  // This sits before the rate limiter deliberately: checkRateLimit is a write
  // (lib/counters.ts bumpWindow INSERTs and increments), so guarding after it
  // would spend an RPM token on every rejected request and turn a client retry
  // loop into 429s instead of this diagnostic 400. It also precedes the blob
  // retention write and the paid knowledgebase embed further down.
  if ((await languageCapability(key.model)) === 'not_language') {
    return openAiError(400, 'invalid_request_error', "This key's model is not a language model.", {
      code: 'model_not_language',
    });
  }

  // 5) Rate limit + quota pre-check (limits come from the key).
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

  // 6) Map input -> messages (client system/developer items dropped; key owns the prompt).
  // Mapping is pure; its only failure mode is a malformed image/file URL (new URL throws),
  // a client error — surface it as a clean 400 rather than an unhandled 500.
  let messages: ModelMessage[];
  try {
    messages = responsesInputToMessages(body.input);
  } catch {
    return openAiError(400, 'invalid_request_error', 'An input item contains a malformed image or file URL.', {
      param: 'input',
      code: 'invalid_url',
    });
  }
  if (messages.length === 0) {
    return openAiError(400, 'invalid_request_error', 'No usable input content provided.', {
      param: 'input',
    });
  }

  // Cross-key blob protection: a key may not reference another key's upload.
  const referencedUrls = responsesReferencedUrls(body.input);
  if (referencedUrls.length > 0) {
    const ok = await assertOwnedBlobs(key.projectId, key.id, referencedUrls, {
      retainImageUrls: key.logContent ? extractModelImageUrls(messages) : undefined,
      retainUntil: key.logContent
        ? new Date(
            requestStartedAt.getTime() +
              IMAGE_INPUT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
          )
        : undefined,
    });
    if (!ok) {
      return openAiError(403, 'invalid_request_error', 'Referenced file is not accessible to this key.', {
        code: 'file_access_denied',
      });
    }
  }

  // 7) Assemble the call from the key's config (structured iff the key has a
  // schema). Agent-mode keys (params.allowClientPrompt) additionally honor the
  // client's `instructions` + system/developer input items, appended AFTER the
  // key's own prompt (key stays authoritative-first; the security preamble still
  // leads via buildSystem). If the key has a knowledgebase, embed the latest
  // user message and fold the top-k matches into the system prompt; non-KB keys
  // pay nothing here.
  const clientPrompt = key.params?.allowClientPrompt
    ? collectResponsesClientSystemText(body)
    : null;
  const basePrompt = composeSystemPrompt(key.systemPrompt, clientPrompt);
  const structured = key.outputSchema != null;
  let systemPrompt: string | null;
  try {
    systemPrompt = await systemPromptWithKb(basePrompt, key.knowledgebaseId, messages, {
      keyId: key.id,
      gateway,
    });
  } catch (error) {
    const unavailable = projectGatewayUnavailableResponse(error);
    if (unavailable) return unavailable;
    return openAiError(502, 'api_error', 'Knowledgebase retrieval failed.', {
      code: 'upstream_error',
    });
  }
  const ctx: CallContext = {
    keyId: key.id,
    gateway,
    model: key.model,
    systemPrompt,
    params: resolveParams(key.params),
    structured,
    schema: structured ? normalizeOutputSchema(key.outputSchema) : key.outputSchema,
    includeUsage: true,
    logContent: key.logContent,
    requestStartedAt,
    tools: aiTools?.tools,
    toolChoice: aiTools?.toolChoice,
  };

  // 8) Stream or buffer.
  return body.stream === true
    ? handleResponsesStreaming(ctx, messages)
    : handleResponsesNonStreaming(ctx, messages);
}

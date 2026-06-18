/**
 * OpenAI Responses API wire types + pure builders.
 *
 * Sophy exposes a scoped Responses-compatible surface (POST /v1/responses) so
 * clients using `client.responses.create(...)` work by only changing base_url +
 * api_key. Like the chat surface, model/instructions/params are owned by the key
 * and any client-sent values are ignored.
 *
 * Spec-critical details (break the official SDK if wrong):
 *  - usage fields are input_tokens / output_tokens / total_tokens (NOT prompt_*).
 *  - top-level `object` is the literal "response"; `created_at` is unix SECONDS.
 *  - `output_text` is NOT a wire field — the SDK derives it from output[].content[].
 *  - streaming dispatches on the JSON `type` field; every event needs an
 *    incrementing `sequence_number`; there is NO `data: [DONE]` sentinel.
 */
import type { ModelMessage } from 'ai';
import type { NormalizedUsage } from '@/lib/usage/record';

// ---- Request shape (subset we read) ----------------------------------------

export interface ResponsesContentPart {
  type: string; // input_text | output_text | text | input_image | input_file | ...
  text?: string;
}
export interface ResponsesInputItem {
  type?: string; // optional "message"
  role?: 'user' | 'assistant' | 'system' | 'developer';
  content?: string | ResponsesContentPart[];
}
export interface ResponsesRequest {
  model?: string;
  input?: string | ResponsesInputItem[];
  instructions?: string | null;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  text?: { format?: { type?: string; name?: string; schema?: Record<string, unknown>; strict?: boolean } };
  stream?: boolean;
  previous_response_id?: string | null;
  store?: boolean;
  tools?: unknown[];
}

// ---- input -> AI SDK messages ----------------------------------------------

function partText(content: string | ResponsesContentPart[] | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('');
}

/**
 * Map the Responses `input` (string or array of items) to AI SDK messages.
 * Client system/developer items are dropped — the key owns the system prompt.
 * Only text content is carried (non-text input parts are ignored in v1).
 */
export function responsesInputToMessages(
  input: string | ResponsesInputItem[] | undefined,
): ModelMessage[] {
  if (input == null) return [];
  if (typeof input === 'string') {
    return input.trim() ? [{ role: 'user', content: input }] : [];
  }
  const out: ModelMessage[] = [];
  for (const item of input) {
    if (item.role === 'system' || item.role === 'developer') continue;
    const text = partText(item.content);
    if (!text) continue;
    out.push(item.role === 'assistant' ? { role: 'assistant', content: text } : { role: 'user', content: text });
  }
  return out;
}

// ---- Response object + usage -----------------------------------------------

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export function mapResponsesUsage(u: NormalizedUsage): ResponsesUsage {
  return {
    input_tokens: u.inputTokens,
    input_tokens_details: { cached_tokens: u.cachedInputTokens },
    output_tokens: u.outputTokens,
    output_tokens_details: { reasoning_tokens: u.reasoningTokens },
    total_tokens: u.totalTokens,
  };
}

export interface BuildResponseArgs {
  id: string;
  msgId: string;
  model: string;
  createdAt: number;
  status: 'in_progress' | 'completed';
  text: string | null;
  usage: ResponsesUsage | null;
  structured: boolean;
  temperature?: number;
  topP?: number;
}

/** Build the Responses `response` object (used for the buffered reply and for
 *  the `response` payload in created/in_progress/completed streaming events). */
export function buildResponseObject(args: BuildResponseArgs): Record<string, unknown> {
  const output =
    args.text == null
      ? []
      : [
          {
            id: args.msgId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: args.text, annotations: [] }],
          },
        ];
  return {
    id: args.id,
    object: 'response',
    created_at: args.createdAt,
    status: args.status,
    error: null,
    incomplete_details: null,
    model: args.model,
    instructions: null,
    max_output_tokens: null,
    temperature: args.temperature ?? null,
    top_p: args.topP ?? null,
    previous_response_id: null,
    store: false,
    text: { format: { type: args.structured ? 'json_schema' : 'text' } },
    tools: [],
    tool_choice: 'auto',
    output,
    usage: args.usage,
    metadata: {},
  };
}

// ---- Streaming SSE ----------------------------------------------------------

/**
 * Format one Responses SSE event. The SDK dispatches on the JSON body's `type`
 * (the `event:` line is cosmetic but we mirror it); JSON is kept on one line.
 */
export function responsesSseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

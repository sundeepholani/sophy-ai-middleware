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
import type { ResponsesToolDef, ResponsesToolChoice } from '@/lib/gateway/openai-map';

// ---- Request shape (subset we read) ----------------------------------------

export interface ResponsesContentPart {
  type: string; // input_text | output_text | text | input_image | input_file | ...
  text?: string;
  // input_image: the Responses API sends image_url as a string (a URL or a
  // data: URL); we also tolerate the chat-style { url } object.
  image_url?: string | { url?: string };
  // input_file
  file_url?: string;
  file_data?: string;
  filename?: string;
}
export interface ResponsesInputItem {
  type?: string; // "message" | "function_call" | "function_call_output"
  role?: 'user' | 'assistant' | 'system' | 'developer';
  content?: string | ResponsesContentPart[];
  // function_call item (a prior model tool call being replayed):
  call_id?: string;
  name?: string;
  arguments?: string;
  // function_call_output item (a tool result the client sends back):
  output?: string | ResponsesContentPart[];
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
  tools?: ResponsesToolDef[];
  tool_choice?: ResponsesToolChoice;
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

/** Map one Responses content part to an AI SDK content part (or null to drop). */
function responsesPartToModelPart(part: ResponsesContentPart) {
  switch (part.type) {
    case 'input_text':
    case 'output_text':
    case 'text':
      return typeof part.text === 'string' ? { type: 'text' as const, text: part.text } : null;
    case 'input_image': {
      const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      return url ? { type: 'image' as const, image: new URL(url) } : null;
    }
    case 'input_file': {
      const url = part.file_url ?? part.file_data;
      return url
        ? {
            type: 'file' as const,
            data: new URL(url),
            mediaType: 'application/octet-stream',
            filename: part.filename,
          }
        : null;
    }
    default:
      return null;
  }
}

function safeJson(s: string | undefined): unknown {
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

/**
 * Map the Responses `input` (string or array of items) to AI SDK messages.
 * Client system/developer items are dropped — the key owns the system prompt.
 * User turns carry multimodal content; assistant turns carry text. Tool turns
 * are preserved: `function_call` items become an assistant tool-call message and
 * `function_call_output` items become a tool-result message (grouped so each
 * assistant tool-call run is answered by one tool-result run, as providers expect).
 */
export function responsesInputToMessages(
  input: string | ResponsesInputItem[] | undefined,
): ModelMessage[] {
  if (input == null) return [];
  if (typeof input === 'string') {
    return input.trim() ? [{ role: 'user', content: input }] : [];
  }

  // call_id -> tool name, recovered from function_call items (results omit it).
  const toolNameById = new Map<string, string>();
  for (const item of input) {
    if (item.type === 'function_call' && item.call_id && item.name) {
      toolNameById.set(item.call_id, item.name);
    }
  }

  const out: ModelMessage[] = [];
  let pendingCalls: unknown[] = [];
  let pendingResults: unknown[] = [];
  const flush = () => {
    if (pendingCalls.length) {
      out.push({ role: 'assistant', content: pendingCalls as never });
      pendingCalls = [];
    }
    if (pendingResults.length) {
      out.push({ role: 'tool', content: pendingResults as never } as ModelMessage);
      pendingResults = [];
    }
  };

  for (const item of input) {
    if (item.type === 'function_call') {
      if (pendingResults.length) flush(); // close the prior call/result round
      if (item.call_id && item.name) {
        pendingCalls.push({
          type: 'tool-call',
          toolCallId: item.call_id,
          toolName: item.name,
          input: safeJson(item.arguments),
        });
      }
      continue;
    }
    if (item.type === 'function_call_output') {
      if (pendingCalls.length) flush(); // emit the assistant calls before their results
      if (item.call_id) {
        const text = typeof item.output === 'string' ? item.output : partText(item.output);
        pendingResults.push({
          type: 'tool-result',
          toolCallId: item.call_id,
          toolName: toolNameById.get(item.call_id) ?? item.call_id,
          output: { type: 'text', value: text },
        });
      }
      continue;
    }

    // Any plain message item — flush any open tool run first.
    flush();
    if (item.role === 'system' || item.role === 'developer') continue;

    if (typeof item.content === 'string') {
      if (item.content.trim()) {
        out.push({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content });
      }
      continue;
    }
    if (!Array.isArray(item.content)) continue;

    if (item.role === 'assistant') {
      const text = partText(item.content);
      if (text) out.push({ role: 'assistant', content: text });
      continue;
    }

    const parts = item.content
      .map(responsesPartToModelPart)
      .filter((p): p is NonNullable<typeof p> => p != null);
    if (parts.length > 0) out.push({ role: 'user', content: parts as never });
  }
  flush();
  return out;
}

/**
 * URLs referenced by image/file parts in a Responses input — used for the same
 * cross-key blob-ownership check the chat surface performs.
 */
export function responsesReferencedUrls(
  input: string | ResponsesInputItem[] | undefined,
): string[] {
  if (!Array.isArray(input)) return [];
  const urls: string[] = [];
  for (const item of input) {
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === 'input_image') {
        const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
        if (url) urls.push(url);
      } else if (part.type === 'input_file' && part.file_url) {
        urls.push(part.file_url);
      }
    }
  }
  return urls;
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

/** A function tool call the model emitted, in Responses output-item shape. */
export interface ResponsesOutToolCall {
  id: string; // output item id, e.g. "fc_…"
  callId: string; // call_id the client echoes back as function_call_output
  name: string;
  arguments: string;
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
  toolCalls?: ResponsesOutToolCall[];
}

/** Build the Responses `response` object (used for the buffered reply and for
 *  the `response` payload in created/in_progress/completed streaming events). */
export function buildResponseObject(args: BuildResponseArgs): Record<string, unknown> {
  const output: Record<string, unknown>[] = [];
  if (args.text != null) {
    output.push({
      id: args.msgId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: args.text, annotations: [] }],
    });
  }
  for (const tc of args.toolCalls ?? []) {
    output.push({
      id: tc.id,
      type: 'function_call',
      status: 'completed',
      call_id: tc.callId,
      name: tc.name,
      arguments: tc.arguments,
    });
  }
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

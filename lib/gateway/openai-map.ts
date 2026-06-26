/**
 * Pure mapping helpers between the OpenAI wire format and the AI SDK, plus
 * param clamping and JSON-schema validation. No I/O — unit-testable.
 */
import { tool, jsonSchema, type ModelMessage, type FinishReason, type ToolSet } from 'ai';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type {
  OpenAIMessage,
  OpenAIContentPart,
  OpenAITool,
  OpenAIToolChoice,
  ChatCompletion,
  ChatCompletionChunk,
  OpenAIUsage,
} from '@/lib/http/openai';
import type { KeyParams } from '@/db/schema';
import type { NormalizedUsage } from '@/lib/usage/record';

// ---- Tool conversion (OpenAI tool defs → AI SDK passthrough ToolSet) --------

export type AiToolChoice = 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };
export interface AiTools {
  tools: ToolSet;
  toolChoice?: AiToolChoice;
}

/** Flat function-tool shape used by the Responses API (vs. the chat nesting). */
export interface ResponsesToolDef {
  type?: string;
  name?: string;
  description?: string;
  parameters?: Record<string, unknown>;
}
export type ResponsesToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; name: string };

interface ToolDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/**
 * Core: build a passthrough ToolSet from normalized tool defs. Each tool is
 * defined with NO `execute`, so the model emits the call and the SDK returns it
 * without running anything (the proxy never executes tools). Null = no tools.
 */
function buildAiTools(defs: ToolDef[], toolChoice: AiToolChoice | undefined): AiTools | null {
  const set: ToolSet = {};
  for (const d of defs) {
    if (!d.name) continue;
    set[d.name] = tool({
      description: d.description,
      inputSchema: jsonSchema((d.parameters ?? { type: 'object', properties: {} }) as never),
    });
  }
  if (Object.keys(set).length === 0) return null;
  return { tools: set, toolChoice };
}

/** Chat Completions tools: [{ type:'function', function:{ name, … } }] + tool_choice. */
export function toAiToolSet(
  tools: OpenAITool[] | undefined,
  toolChoice: OpenAIToolChoice | undefined,
): AiTools | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const defs: ToolDef[] = [];
  for (const t of tools) {
    if (t?.type !== 'function' || !t.function?.name) continue;
    defs.push({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    });
  }
  let choice: AiToolChoice | undefined;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') choice = toolChoice;
  else if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function') {
    choice = { type: 'tool', toolName: toolChoice.function.name };
  }
  return buildAiTools(defs, choice);
}

/** Responses API tools: [{ type:'function', name, description, parameters }] (flat) + tool_choice. */
export function responsesToAiToolSet(
  tools: ResponsesToolDef[] | undefined,
  toolChoice: ResponsesToolChoice | undefined,
): AiTools | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const defs: ToolDef[] = [];
  for (const t of tools) {
    if (t?.type !== 'function' || !t.name) continue; // only function tools pass through
    defs.push({ name: t.name, description: t.description, parameters: t.parameters });
  }
  let choice: AiToolChoice | undefined;
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') choice = toolChoice;
  else if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function') {
    choice = { type: 'tool', toolName: toolChoice.name };
  }
  return buildAiTools(defs, choice);
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// ---- Message conversion -----------------------------------------------------

function partToModelPart(part: OpenAIContentPart) {
  switch (part.type) {
    case 'text':
      return { type: 'text' as const, text: part.text };
    case 'image_url':
      return { type: 'image' as const, image: new URL(part.image_url.url) };
    case 'file': {
      const url = part.file.file_url ?? part.file.file_data;
      return {
        type: 'file' as const,
        data: url ? new URL(url) : '',
        mediaType: 'application/octet-stream',
        filename: part.file.filename,
      };
    }
  }
}

/**
 * Convert OpenAI messages to AI SDK ModelMessages. Client-supplied system /
 * developer messages are DROPPED — the operator owns the system prompt.
 * Tool-calling turns are preserved: an assistant message's `tool_calls` become
 * tool-call parts, and `tool` messages become a tool-result message. OpenAI tool
 * messages omit the tool name, so we recover it from the assistant `tool_calls`
 * (matched by id).
 */
export function toModelMessages(messages: OpenAIMessage[]): ModelMessage[] {
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) toolNameById.set(tc.id, tc.function.name);
    }
  }

  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') continue;

    if (m.role === 'tool') {
      const id = m.tool_call_id;
      if (!id) continue;
      const text =
        typeof m.content === 'string'
          ? m.content
          : (m.content ?? []).map((p) => ('text' in p ? p.text : '')).join('');
      out.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: id,
            toolName: toolNameById.get(id) ?? id,
            output: { type: 'text', value: text },
          },
        ],
      } as ModelMessage);
      continue;
    }

    if (m.role === 'assistant' && m.tool_calls?.length) {
      const parts: unknown[] = [];
      // Preserve any leading text, whether sent as a string or as content parts
      // (mirrors the non-tool assistant path), then append the tool-call parts.
      if (typeof m.content === 'string') {
        if (m.content) parts.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) parts.push(partToModelPart(p));
      }
      for (const tc of m.tool_calls) {
        parts.push({
          type: 'tool-call',
          toolCallId: tc.id,
          toolName: tc.function.name,
          input: safeJsonParse(tc.function.arguments),
        });
      }
      out.push({ role: 'assistant', content: parts as never });
      continue;
    }

    const content =
      typeof m.content === 'string' ? m.content : (m.content ?? []).map(partToModelPart);
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: content as never });
  }
  return out;
}

// ---- Param clamping ---------------------------------------------------------

export interface ResolvedParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

/** The key's operator-set params are applied as-is (client params are ignored). */
export function resolveParams(params: KeyParams): ResolvedParams {
  return {
    temperature: params.temperature,
    topP: params.topP,
    maxOutputTokens: params.maxOutputTokens,
  };
}

// ---- Finish reason mapping --------------------------------------------------

export function mapFinishReason(reason: FinishReason | undefined): string {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'content-filter':
      return 'content_filter';
    case 'tool-calls':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

function toOpenAIUsage(u: NormalizedUsage): OpenAIUsage {
  return {
    prompt_tokens: u.inputTokens,
    completion_tokens: u.outputTokens,
    total_tokens: u.totalTokens,
  };
}

// ---- Response mapping -------------------------------------------------------

export interface OutToolCall {
  id: string;
  name: string;
  arguments: string;
}

export function toChatCompletion(args: {
  id: string;
  created: number;
  model: string;
  content: string;
  toolCalls?: OutToolCall[];
  finishReason: FinishReason | undefined;
  usage: NormalizedUsage;
}): ChatCompletion {
  const hasTools = !!args.toolCalls && args.toolCalls.length > 0;
  return {
    id: args.id,
    object: 'chat.completion',
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          // OpenAI sends content: null on a pure tool-call turn.
          content: hasTools ? (args.content || null) : args.content,
          ...(hasTools
            ? {
                tool_calls: args.toolCalls!.map((t) => ({
                  id: t.id,
                  type: 'function' as const,
                  function: { name: t.name, arguments: t.arguments },
                })),
              }
            : {}),
        },
        // Force 'tool_calls' whenever the turn emitted tool calls, matching the
        // streaming path (some providers report 'stop' despite emitting calls).
        finish_reason: hasTools ? 'tool_calls' : mapFinishReason(args.finishReason),
      },
    ],
    usage: toOpenAIUsage(args.usage),
  };
}

export function chunkFrame(args: {
  id: string;
  created: number;
  model: string;
  delta: ChatCompletionChunk['choices'][number]['delta'];
  finishReason?: string | null;
}): ChatCompletionChunk {
  return {
    id: args.id,
    object: 'chat.completion.chunk',
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        delta: args.delta,
        finish_reason: args.finishReason ?? null,
      },
    ],
  };
}

export function usageChunkFrame(args: {
  id: string;
  created: number;
  model: string;
  usage: NormalizedUsage;
}): ChatCompletionChunk {
  return {
    id: args.id,
    object: 'chat.completion.chunk',
    created: args.created,
    model: args.model,
    choices: [],
    usage: toOpenAIUsage(args.usage),
  };
}

export function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

// ---- JSON-schema validation (structured output) -----------------------------

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validators = new Map<string, ValidateFunction>();

function getValidator(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema);
  let v = validators.get(key);
  if (!v) {
    v = ajv.compile(schema);
    validators.set(key, v);
  }
  return v;
}

export function validateAgainstSchema(
  data: unknown,
  schema: Record<string, unknown>,
): { valid: boolean; errors: string | null } {
  try {
    const validate = getValidator(schema);
    const valid = validate(data);
    return {
      valid: !!valid,
      errors: valid ? null : ajv.errorsText(validate.errors, { separator: '; ' }),
    };
  } catch (err) {
    return { valid: false, errors: `schema compile error: ${String(err)}` };
  }
}

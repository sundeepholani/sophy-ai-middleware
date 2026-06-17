/**
 * Pure mapping helpers between the OpenAI wire format and the AI SDK, plus
 * param clamping and JSON-schema validation. No I/O — unit-testable.
 */
import type { ModelMessage, FinishReason } from 'ai';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type {
  OpenAIMessage,
  OpenAIContentPart,
  ChatCompletion,
  ChatCompletionChunk,
  OpenAIUsage,
} from '@/lib/http/openai';
import type { RouteParams, RouteParamBounds, RouteMode } from '@/db/schema';
import type { NormalizedUsage } from '@/lib/usage/record';

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
 * developer messages are DROPPED — the operator owns the system prompt. Tool
 * messages are dropped (tool calling is rejected upstream in v1).
 */
export function toModelMessages(messages: OpenAIMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer' || m.role === 'tool') continue;
    const content =
      typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map(partToModelPart);
    if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: content as never });
    } else {
      out.push({ role: 'user', content: content as never });
    }
  }
  return out;
}

// ---- Param clamping ---------------------------------------------------------

export interface ResolvedParams {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
}

function clampNumber(value: number, min?: number, max?: number): number {
  let v = value;
  if (typeof min === 'number') v = Math.max(v, min);
  if (typeof max === 'number') v = Math.min(v, max);
  return v;
}

/**
 * Resolve the effective generation params. Operator defaults always apply. On
 * `overridable` routes, client-supplied values are accepted but clamped to the
 * route's bounds. On `locked` routes, client params are ignored entirely.
 */
export function resolveParams(
  operator: RouteParams,
  bounds: RouteParamBounds,
  mode: RouteMode,
  client: { temperature?: number; top_p?: number; max_tokens?: number; max_completion_tokens?: number },
): ResolvedParams {
  const out: ResolvedParams = {
    temperature: operator.temperature,
    topP: operator.topP,
    maxOutputTokens: operator.maxOutputTokens,
  };
  if (mode !== 'overridable') return out;

  if (typeof client.temperature === 'number') {
    out.temperature = clampNumber(
      client.temperature,
      bounds.temperature?.min,
      bounds.temperature?.max,
    );
  }
  if (typeof client.top_p === 'number') {
    out.topP = clampNumber(client.top_p, bounds.topP?.min, bounds.topP?.max);
  }
  const clientMax = client.max_completion_tokens ?? client.max_tokens;
  if (typeof clientMax === 'number') {
    out.maxOutputTokens = clampNumber(clientMax, undefined, bounds.maxOutputTokens?.max);
  }
  return out;
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

export function toChatCompletion(args: {
  id: string;
  created: number;
  model: string;
  content: string;
  finishReason: FinishReason | undefined;
  usage: NormalizedUsage;
}): ChatCompletion {
  return {
    id: args.id,
    object: 'chat.completion',
    created: args.created,
    model: args.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: args.content },
        finish_reason: mapFinishReason(args.finishReason),
      },
    ],
    usage: toOpenAIUsage(args.usage),
  };
}

export function chunkFrame(args: {
  id: string;
  created: number;
  model: string;
  delta: { role?: 'assistant'; content?: string };
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

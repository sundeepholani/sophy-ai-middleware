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
import type { KeyParams } from '@/db/schema';
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

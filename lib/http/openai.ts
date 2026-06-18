/**
 * OpenAI-compatible wire types and error/response helpers.
 *
 * The middleware speaks the OpenAI Chat Completions protocol so existing client
 * systems only change base_url + api_key. Errors mirror OpenAI's shape so client
 * SDK error handling keeps working.
 */

export type OpenAIErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'insufficient_quota'
  | 'not_found_error'
  | 'api_error';

export interface OpenAIErrorBody {
  error: {
    message: string;
    type: OpenAIErrorType;
    param: string | null;
    code: string | null;
  };
}

export function openAiError(
  status: number,
  type: OpenAIErrorType,
  message: string,
  opts: { code?: string; param?: string; headers?: Record<string, string> } = {},
): Response {
  const body: OpenAIErrorBody = {
    error: {
      message,
      type,
      param: opts.param ?? null,
      code: opts.code ?? null,
    },
  };
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...(opts.headers ?? {}) },
  });
}

// ---- Request shape (subset we read) ----------------------------------------

export type OpenAIRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

export interface OpenAITextPart {
  type: 'text';
  text: string;
}
export interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export interface OpenAIFilePart {
  type: 'file';
  file: { file_url?: string; filename?: string; file_data?: string };
}
export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart | OpenAIFilePart;

export interface OpenAIMessage {
  role: OpenAIRole;
  content: string | OpenAIContentPart[] | null;
  name?: string;
}

export interface OpenAIResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name?: string;
    schema?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface ChatCompletionRequest {
  model?: string;
  messages?: OpenAIMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  response_format?: OpenAIResponseFormat;
  // Tool-calling fields — rejected in v1 (see plan).
  tools?: unknown[];
  functions?: unknown[];
  tool_choice?: unknown;
  n?: number;
  user?: string;
}

// ---- Response shapes --------------------------------------------------------

export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletion {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: string;
  }[];
  usage: OpenAIUsage;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: 'assistant'; content?: string };
    finish_reason: string | null;
  }[];
  usage?: OpenAIUsage | null;
}

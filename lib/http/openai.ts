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

/** A function tool call emitted by the model (assistant message) or echoed back. */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: OpenAIRole;
  content: string | OpenAIContentPart[] | null;
  name?: string;
  /** On an assistant turn: the tool calls the model previously made. */
  tool_calls?: OpenAIToolCall[];
  /** On a `tool` turn: which assistant tool call this result answers. */
  tool_call_id?: string;
}

// ---- Tool definitions (client-supplied) ------------------------------------

export interface OpenAIFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}
export interface OpenAITool {
  type: 'function';
  function: OpenAIFunctionDef;
}
export type OpenAIToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; function: { name: string } };

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
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  // Legacy completions-style function calling — still rejected (use `tools`).
  functions?: unknown[];
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
    message: { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] };
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
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason: string | null;
  }[];
  usage?: OpenAIUsage | null;
}

// ---- Image generation (POST /v1/images/generations) ------------------------

/**
 * OpenAI Images request (subset we read). As on every surface the key owns the
 * model, so `model` here is ignored — the key's image model wins. Sophy returns
 * base64 images (`response_format: "b64_json"`, the default and only supported
 * format in v1). `quality`/`style`/`background`/`output_format` are forwarded to
 * the provider when set; unknown-to-the-provider values are ignored upstream.
 */
export interface ImageGenerationRequest {
  model?: string;
  prompt?: string;
  n?: number;
  size?: string;
  response_format?: 'b64_json' | 'url';
  quality?: string;
  style?: string;
  background?: string;
  output_format?: string;
  user?: string;
}

export interface ImageData {
  b64_json: string;
}

export interface ImageGenerationResponse {
  created: number;
  data: ImageData[];
}

/**
 * OpenAI Embeddings request (subset we read). As on every surface the key owns
 * the model, so `model` here is ignored — the key's embedding model wins.
 * `input` accepts a single string or an array of strings; token-array inputs
 * (arrays of integers) are not supported. `encoding_format` follows OpenAI:
 * "float" (default) or "base64" (little-endian float32 bytes) — the official
 * openai clients request base64 by default and decode transparently, so both
 * must work. `dimensions` is forwarded to the provider when set.
 */
export interface EmbeddingsRequest {
  model?: string;
  input?: string | string[] | number[] | number[][];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
}

export interface EmbeddingData {
  object: 'embedding';
  index: number;
  /** number[] for encoding_format "float", base64 string for "base64". */
  embedding: number[] | string;
}

export interface EmbeddingsResponse {
  object: 'list';
  data: EmbeddingData[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

// ---- Audio transcription (POST /v1/audio/transcriptions) ------------------

/**
 * OpenAI-compatible transcription response. `text` is the normal SDK field.
 * Sophy's extensions make it explicit whether the key's system prompt produced
 * a processed version. Raw speech is returned only when no processing policy
 * ran; otherwise exposing it would let clients bypass instructions such as
 * redaction.
 */
export interface AudioTranscriptionResponse {
  /** Final text returned to the caller (processed when a system prompt is set). */
  text: string;
  /** Raw speech-to-text output. Present only when no processing policy ran. */
  transcript?: string;
  processed: boolean;
  language?: string;
  duration?: number;
}

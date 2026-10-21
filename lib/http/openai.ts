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
  /** cached_tokens: the part of prompt_tokens served from the provider's prompt cache. */
  prompt_tokens_details: { cached_tokens: number };
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

// ---- Model assessment (POST /v1/evaluate) ----------------------------------

/**
 * Wire types for the native evaluation surface.
 *
 * NOT OpenAI-compatible: the AI Gateway exposes evaluation models through its
 * own `/v1/evaluate` shape, and no OpenAI client method reaches it. Sophy
 * mirrors that shape so an existing gateway client only changes its base URL.
 */

/** A single typed question asked of the shared state. */
export type AssessmentQuestion =
  | { type: 'boolean'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface EvaluationRequest {
  /** Accepted and ignored — the Sophy key owns the model, as on every surface. */
  model?: string;
  /** The shared state the questions are asked about: string, object or array. */
  state?: unknown;
  questions?: Record<string, AssessmentQuestion>;
  providerOptions?: Record<string, Record<string, unknown>>;
  /**
   * Images by key. TypeSafe Jev: up to 8 png/jpg/jpeg, each key referenced in
   * state or questions and swapped for its image upstream. Cloudflare Clef: up
   * to 4 png/jpg/jpeg/webp (4 MiB each, 8 MiB total decoded), no reference
   * needed, shown to the model before the state in key order, with no
   * substitution.
   */
  assets?: Record<string, AssessmentAsset>;
}

/** One base64 still image, in TypeSafe's asset shape. */
export interface AssessmentAsset {
  type: 'image';
  /** webp: Cloudflare Clef/Clairic keys only. */
  format: 'png' | 'jpg' | 'jpeg' | 'webp';
  /** Standard, padded base64 — no `data:` prefix, no whitespace. */
  data_base64: string;
}

/** One answer, discriminated by the question type that produced it. */
export type AssessmentAnswer =
  | { type: 'boolean'; probability: number }
  | {
      type: 'choice';
      choice: string;
      probabilities: Record<string, number>;
      /** 0–1, when upstream reports it (additive). */
      confidence?: number;
    }
  | {
      type: 'score';
      score: number;
      probabilities: Record<string, number>;
      /** 0–1, when upstream reports it (additive). */
      confidence?: number;
    };

/**
 * `providerMetadata` from upstream is deliberately not echoed — it carries
 * Sophy's own gateway cost and generation id, which are not the client's.
 */
export interface EvaluationResponse {
  model: string;
  answers: Record<string, AssessmentAnswer>;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

// ---- Extraction (POST /v1/extract) ------------------------------------------

/**
 * Wire types for the native extraction surface (Cloudflare Workers AI Clairic,
 * research preview). NOT OpenAI-compatible. Answers are passed through as Clairic
 * returns them because the preview's output shape still drifts.
 */

export type ExtractionFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'time'
  | 'datetime'
  | 'duration'
  | 'list'
  | 'estimate'
  | 'forecast';

export type ExtractionForecastInterval =
  | 'step'
  | 'minute'
  | 'hour'
  | 'day'
  | 'week'
  | 'month'
  | 'quarter'
  | 'year';

/** One field to extract. These 13 keys are the known ones; any other key is rejected (D9). */
export interface ExtractionFieldSpec {
  /** What kind of value the field holds. */
  type: ExtractionFieldType;
  /** What the field should contain. */
  instructions?: string;
  /** Unit label. Durations: seconds | minutes | hours | days | weeks | months | years (Cloudflare default: seconds). */
  unit?: string;
  /** Number and duration fields only. */
  integer?: boolean;
  /** Integer 0–6. Numbers, durations and number lists only. */
  decimals?: number;
  /** Item type. REQUIRED for list fields. */
  items?: 'text' | 'number' | 'date';
  /** REQUIRED for estimate and forecast. An ISO date string only for date estimates. */
  min?: number | string;
  /** REQUIRED for estimate and forecast. An ISO date string only for date estimates. */
  max?: number | string;
  /** Estimate grid: a positive number (days for date estimates), or 'month' / 'year'. */
  step?: number | 'month' | 'year';
  /** Estimates and forecasts: spread the distribution on a linear or log scale. */
  scale?: 'linear' | 'log';
  /** In (0, 1]: the null probability above which value is null (Cloudflare default 0.5). */
  null_threshold?: number;
  /** Forecast only: the number of steps, an integer 1–64. */
  horizon?: number;
  /** Forecast only: the length of one step. */
  interval?: ExtractionForecastInterval;
}

export interface ExtractionRequest {
  /** Accepted and ignored. The key owns the model. */
  model?: string;
  /** Text to read. May be '' (or omitted) only when assets are sent. */
  state?: string;
  fields?: Record<string, ExtractionFieldSpec>;
  /** The same keyed shape and Cloudflare image rules as Clef (lib/gateway/image-assets.ts). */
  assets?: Record<string, AssessmentAsset>;
  /** ISO date (YYYY-MM-DD) that anchors dates written without a year. */
  reference_date?: string;
  options?: { include_quantiles?: boolean; return_state_text?: boolean };
}

/**
 * Clairic's answer object, PASSED THROUGH (research preview; the shape drifts).
 * Known keys: type, value, guess, p_null, confidence, span, spans, confidences,
 * mean, median, p10, p90, p_below, p_above, quantiles, steps, unit.
 *
 * Caveats:
 * - spans are END-EXCLUSIVE offsets counted in UNICODE CODE POINTS;
 * - when value is null, ignore guess and span;
 * - list answers carry per-item detail arrays: per-item `confidences` on number
 *   and date lists, per-item `spans` on text lists.
 */
export type ExtractionAnswer = { type?: string; value?: unknown } & Record<string, unknown>;

export interface ExtractionResponse {
  /** The key's model id, never the upstream echo. */
  model: string;
  answers: Record<string, ExtractionAnswer>;
  truncated: boolean;
  /** Present only when options.return_state_text was true and upstream returned it. */
  state_text?: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
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

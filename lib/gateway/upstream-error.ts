/**
 * Map an upstream AI Gateway / provider failure to an OpenAI-compatible client
 * response.
 *
 * The proxy used to flatten EVERY upstream error to a blanket HTTP 502
 * `upstream_error`. That mislabels a non-retryable client-input rejection (e.g. an
 * image whose dimensions exceed the provider's limit — a 400) as a transient 5xx,
 * so clients with retry-on-5xx logic resubmit the same doomed request; it also
 * hides quota / rate-limit / credit conditions behind the same opaque status, so a
 * caller can't tell "you're out of quota" from "the provider blipped".
 *
 * We map the upstream HTTP status to the matching OpenAI-compatible status + error
 * type (the error types already exist in `lib/http/openai.ts` for exactly this).
 * Two rules keep it safe:
 *  - Only CLIENT-INPUT rejections (a 4xx describing the caller's own request) echo
 *    the upstream message — it's about the caller's request and actionable.
 *  - Quota / credit / rate-limit conditions get a GENERIC message: the raw gateway
 *    text carries OUR account internals (the shared gateway key id, spend/limit
 *    figures, a Vercel top-up URL) that must never reach a client.
 *  - Anything ambiguous (auth/permission/not-found/5xx/unknown) stays a 502
 *    `upstream_error`, exactly as before.
 */
import { APICallError } from 'ai';
import { openAiError, type OpenAIErrorType } from '@/lib/http/openai';
import {
  projectGatewayUnavailableResponse,
  ProjectGatewayUnavailableError,
} from '@/lib/gateway/project-provider';

export interface MappedUpstreamError {
  status: number;
  type: OpenAIErrorType;
  code: string;
  message: string;
  /** Forward the upstream `Retry-After` header to the client when present. */
  passRetryAfter: boolean;
}

/** Cap an echoed provider message so a client error body stays small. */
const MAX_ECHO = 400;
function clientMessage(upstream: string | undefined): string | undefined {
  if (typeof upstream !== 'string') return undefined;
  const t = upstream.trim();
  if (!t) return undefined;
  return t.length > MAX_ECHO ? `${t.slice(0, MAX_ECHO)}…` : t;
}

/**
 * Pure: decide the client-facing error from an upstream HTTP status + message.
 * `upstreamMessage` is surfaced ONLY for client-input (4xx request) rejections;
 * for every other status we fall back to a message we control.
 */
export function mapUpstreamError(
  statusCode: number | undefined,
  upstreamMessage: string | undefined,
  fallbackMessage: string,
): MappedUpstreamError {
  switch (statusCode) {
    // Client-input rejections: the request itself is malformed / too large and
    // will never succeed on retry. Echo the provider's detail — it describes the
    // caller's request (e.g. "image dimensions exceed max allowed size: 8000
    // pixels") and is safe + actionable to surface.
    case 400:
    case 413:
    case 422:
      return {
        status: 400,
        type: 'invalid_request_error',
        code: 'upstream_invalid_request',
        message:
          clientMessage(upstreamMessage) ??
          'The request was rejected by the upstream model provider.',
        passRetryAfter: false,
      };
    // Rate limit / quota exceeded — retryable after a delay. GENERIC message: the
    // upstream text leaks our gateway account id and spend/limit figures.
    case 429:
      return {
        status: 429,
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
        message: 'The upstream provider rate limit or quota was exceeded. Please retry later.',
        passRetryAfter: true,
      };
    // Billing / insufficient credit. GENERIC message: the upstream text leaks a
    // Vercel top-up URL for our account.
    case 402:
      return {
        status: 402,
        type: 'insufficient_quota',
        code: 'insufficient_quota',
        message: 'The upstream AI provider account has insufficient quota or credit.',
        passRetryAfter: false,
      };
    // Auth / permission / not-found / 5xx / no status: a genuine bad-gateway
    // condition (often OUR gateway credential), so keep the opaque 502.
    default:
      return {
        status: 502,
        type: 'api_error',
        code: 'upstream_error',
        message: fallbackMessage,
        passRetryAfter: false,
      };
  }
}

/** Case-insensitively read `Retry-After` from an AI SDK response-headers record. */
function retryAfterHeader(headers: Record<string, string> | undefined): string | undefined {
  if (!headers) return undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'retry-after' && v) return v;
  }
  return undefined;
}

/**
 * Build the OpenAI-compatible error `Response` for an upstream failure caught in a
 * buffered (non-streaming) handler. `fallbackMessage` is the surface-specific text
 * used for the 502 default (e.g. "The embeddings request failed.").
 */
export function upstreamErrorResponse(err: unknown, fallbackMessage: string): Response {
  const unavailable = projectGatewayUnavailableResponse(err);
  if (unavailable) return unavailable;

  const isApi = APICallError.isInstance(err);
  const statusCode = isApi ? err.statusCode : undefined;
  const upstreamMessage = err instanceof Error ? err.message : undefined;
  const mapped = mapUpstreamError(statusCode, upstreamMessage, fallbackMessage);

  const headers: Record<string, string> = {};
  if (mapped.passRetryAfter && isApi) {
    const ra = retryAfterHeader(err.responseHeaders);
    if (ra) headers['retry-after'] = ra;
  }
  return openAiError(mapped.status, mapped.type, mapped.message, {
    code: mapped.code,
    headers,
  });
}

/**
 * A bounded, non-secret value for durable usage/error records. Raw gateway
 * messages can contain credential ids, balances, spend limits, and account URLs
 * and must never be persisted or echoed by Sophy.
 */
export function safeGatewayErrorMessage(err: unknown): string {
  if (ProjectGatewayUnavailableError.isInstance(err)) return err.code;
  if (APICallError.isInstance(err) && typeof err.statusCode === 'number') {
    return `upstream_http_${err.statusCode}`;
  }
  if (
    typeof DOMException !== 'undefined' &&
    err instanceof DOMException &&
    err.name === 'TimeoutError'
  ) {
    return 'upstream_timeout';
  }
  if (err instanceof Error) {
    if (/timeout|timed out/i.test(err.name)) return 'upstream_timeout';
    return `upstream_${err.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 64) || 'error'}`;
  }
  return 'upstream_error';
}

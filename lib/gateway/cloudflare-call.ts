/**
 * Cloudflare Workers AI REST calls for the native surfaces (D6, D8).
 *
 * A success is the v4 envelope `{result, success: true, errors: [], messages: []}`
 * with `cf-ai-neurons`, `cf-ai-req-id` and `cf-ray` headers. A failure carries
 * `errors[0] = {code, message}`, and the message reads like
 * `AiError: AiError: <text> (<request uuid>)`. This module lifts that into the
 * APICallError shape upstream-error.ts already maps, decides retryability (a
 * 429/3036 daily-allocation stop is final; 429/3040 capacity is retried), and
 * estimates cost. Not server-only: its pure parts are unit-tested. The account id
 * never reaches an error object.
 */
import { APICallError } from 'ai';
import { withRetries } from '@/lib/gateway/retries';
import { CloudflareModelNotRegisteredError, getCloudflareModel } from '@/lib/gateway/cloudflare-models';
import type { ProjectCloudflareSnapshot } from '@/lib/gateway/cloudflare-provider';

/** Parsed Cloudflare failure, attached as APICallError.data. */
export interface CloudflareErrorInfo {
  provider: 'cloudflare';
  /** errors[0].code: 10000 auth · 3036 daily free allocation · 3040 capacity · 3030/5006/5021 bad input or over context. */
  code: number | null;
  /** cleanCloudflareMessage(errors[0].message).message, or null. */
  message: string | null;
  /** cf-ai-req-id ?? cf-ray ?? the trailing "(uuid)" of errors[0].message (D6, D8). */
  requestId: string | null;
  /**
   * cf-ai-neurons of a 2xx that Cloudflare billed but Sophy could not use, so its error
   * row is still metered (U1). Null on every response Cloudflare rejected (4xx, 5xx, network).
   */
  neurons: number | null;
}

export interface CloudflareRunResult {
  /** The v4 envelope's `result`. Always a plain object. */
  result: Record<string, unknown>;
  /** cf-ai-neurons when present, finite and >= 0. Otherwise null. */
  neurons: number | null;
  /** cf-ai-req-id ?? cf-ray ?? null. Recorded as usage_events.gateway_request_id. */
  upstreamRequestId: string | null;
}

// Keep in step with CLOUDFLARE_API_BASE in cloudflare-provider.ts (a value import would be a
// runtime cycle). tests/cloudflare-call.test.ts asserts the two agree.
const LOG_API_BASE = 'https://api.cloudflare.com/client/v4';
const ACCOUNT_PLACEHOLDER = '{account_id}';
const MAX_REQUEST_ID_CHARS = 128;
// No leading \s*: unanchored, it backtracks quadratically over a long whitespace run, and the
// messages echo client text (field paths, question ids). cleanCloudflareMessage trims instead.
const UUID_SUFFIX = /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\s*$/i;
const AI_ERROR_PREFIX = /^(?:(?:AiError|Ai):\s*)+/;
const NEURONS = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** For APICallError.url only. The account id is never in it. */
export function cloudflareRunUrlForLogs(model: string): string {
  return `${LOG_API_BASE}/accounts/${ACCOUNT_PLACEHOLDER}/ai/run/${model}`;
}

/** Strip the trailing "(uuid)" first (captured), then any leading "AiError: " / "Ai: " repeats. */
export function cleanCloudflareMessage(raw: string): { message: string; requestId: string | null } {
  let message = raw.trim();
  let requestId: string | null = null;
  const suffix = UUID_SUFFIX.exec(message);
  if (suffix) {
    requestId = suffix[1];
    message = message.slice(0, suffix.index);
  }
  return { message: message.replace(AI_ERROR_PREFIX, '').trim(), requestId };
}

/** Reads errors[0].code / errors[0].message from a v4 JSON body. Nulls when absent. Never throws. */
export function parseCloudflareErrorBody(
  bodyText: string,
): { code: number | null; message: string | null; requestId: string | null } {
  const none = { code: null, message: null, requestId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return none;
  }
  const errors = isPlainObject(parsed) ? parsed.errors : undefined;
  const first: unknown = Array.isArray(errors) ? errors[0] : undefined;
  if (!isPlainObject(first)) return none;
  const code =
    typeof first.code === 'number' && Number.isInteger(first.code)
      ? first.code
      : typeof first.code === 'string' && /^\d{1,9}$/.test(first.code)
        ? Number(first.code)
        : null;
  if (typeof first.message !== 'string') return { code, message: null, requestId: null };
  const cleaned = cleanCloudflareMessage(first.message);
  return { code, message: cleaned.message || null, requestId: cleaned.requestId };
}

/** 429: retry unless code 3036 (daily free allocation; resets 00:00 UTC). Else APICallError's default. */
export function cloudflareRetryable(status: number, code: number | null): boolean {
  if (status === 429) return code !== 3036;
  return status === 408 || status === 409 || status >= 500;
}

/**
 * A v4 envelope is an object with a 'success' or 'result' key: success === false → null,
 * non-object result → null, else result. Any other plain object is a bare model body
 * (the cf CLI hands those back; still accept them) and is returned as is. Non-objects → null.
 */
export function unwrapCloudflareEnvelope(json: unknown): Record<string, unknown> | null {
  if (!isPlainObject(json)) return null;
  if ('success' in json || 'result' in json) {
    if (json.success === false) return null;
    return isPlainObject(json.result) ? json.result : null;
  }
  return json;
}

/** Plain decimal (or exponent) neurons; anything else, negative or non-finite → null. */
export function parseNeuronsHeader(value: string | null): number | null {
  const trimmed = value?.trim() ?? '';
  if (!NEURONS.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function headerId(headers: Headers, name: string): string | null {
  const value = headers.get(name)?.trim();
  return value ? value.slice(0, MAX_REQUEST_ID_CHARS) : null;
}

/** 'cf-ai-req-id' ?? 'cf-ray' ?? null (D6). */
export function cloudflareResponseRequestId(headers: Headers): string | null {
  return headerId(headers, 'cf-ai-req-id') ?? headerId(headers, 'cf-ray');
}

function isCloudflareData(data: unknown): data is CloudflareErrorInfo {
  return isPlainObject(data) && data.provider === 'cloudflare';
}

function findCloudflareCallError(error: unknown, seen: Set<unknown>): APICallError | undefined {
  if (error == null || typeof error !== 'object' || seen.has(error)) return undefined;
  seen.add(error);
  if (APICallError.isInstance(error) && isCloudflareData(error.data)) return error;
  // Same walk order as upstream-error.ts:126-134.
  const candidate = error as { lastError?: unknown; errors?: unknown; cause?: unknown };
  const nested: unknown[] = [];
  if (candidate.lastError !== undefined) nested.push(candidate.lastError);
  if (Array.isArray(candidate.errors)) nested.push(...[...candidate.errors].reverse());
  if (candidate.cause !== undefined) nested.push(candidate.cause);
  for (const next of nested) {
    const found = findCloudflareCallError(next, seen);
    if (found) return found;
  }
  return undefined;
}

/** The first Cloudflare APICallError in the chain (lastError, errors reversed, cause), with its status. */
export function cloudflareErrorInfo(
  error: unknown,
): (CloudflareErrorInfo & { statusCode: number | undefined }) | null {
  const found = findCloudflareCallError(error, new Set());
  if (!found) return null;
  const data = found.data as CloudflareErrorInfo;
  return {
    provider: 'cloudflare',
    code: typeof data.code === 'number' ? data.code : null,
    message: typeof data.message === 'string' ? data.message : null,
    requestId: typeof data.requestId === 'string' ? data.requestId : null,
    neurons:
      typeof data.neurons === 'number' && Number.isFinite(data.neurons) && data.neurons >= 0
        ? data.neurons
        : null,
    statusCode: found.statusCode,
  };
}

export function cloudflareErrorRequestId(error: unknown): string | null {
  return cloudflareErrorInfo(error)?.requestId ?? null;
}

/** 'invalid' iff the Cloudflare APICallError has status 401, or 403 with code 10000. Pure. */
export function cloudflareCredentialFailure(error: unknown): 'invalid' | null {
  const info = cloudflareErrorInfo(error);
  if (!info) return null;
  if (info.statusCode === 401) return 'invalid';
  if (info.statusCode === 403 && info.code === 10000) return 'invalid';
  return null;
}

function scrubAccount(text: string, accountId: string): string {
  return accountId ? text.split(accountId).join(ACCOUNT_PLACEHOLDER) : text;
}

/**
 * U1: the deadline fired while a billed 2xx body was being read. What is thrown is still the
 * abort it was — same name and message, so withRetries stops at once and
 * safeGatewayErrorMessage records upstream_timeout (a 502 for the client) — but its cause is
 * a status-less Cloudflare APICallError holding the billed data, where cloudflareErrorInfo
 * finds the neurons. The original reason stays at the end of the chain. A reason that is not
 * an Error is returned as is.
 */
function abortWithBilledData(
  reason: unknown,
  url: string,
  model: string,
  data: CloudflareErrorInfo,
): unknown {
  if (!(reason instanceof Error || (typeof DOMException !== 'undefined' && reason instanceof DOMException))) {
    return reason;
  }
  const aborted = new Error(reason.message, {
    cause: new APICallError({
      message: 'The Cloudflare Workers AI response was cut off by the deadline.',
      url,
      requestBodyValues: { model },
      isRetryable: false,
      cause: reason,
      data,
    }),
  });
  aborted.name = reason.name;
  return aborted;
}

/** One attempt. Exported for tests. Never puts state, images or the account id in the error. */
export async function postCloudflareOnce(
  snapshot: ProjectCloudflareSnapshot,
  model: string,
  body: unknown,
  signal: AbortSignal,
): Promise<CloudflareRunResult> {
  const url = cloudflareRunUrlForLogs(model);
  let res: Response;
  try {
    res = await snapshot.runner.run(model, body, signal);
  } catch (error) {
    // As @ai-sdk/provider-utils (and assessments.ts' postEvaluate): Node's "fetch failed" is retryable.
    if (
      error instanceof TypeError &&
      ['fetch failed', 'failed to fetch'].includes(error.message.toLowerCase()) &&
      error.cause != null
    ) {
      const causeMessage = (error.cause as { message?: unknown }).message;
      throw new APICallError({
        message: `Cannot connect to API: ${typeof causeMessage === 'string' ? causeMessage : 'network error'}`,
        cause: error.cause,
        url,
        requestBodyValues: { model },
        isRetryable: true,
        data: {
          provider: 'cloudflare',
          code: null,
          message: null,
          requestId: null,
          neurons: null,
        } satisfies CloudflareErrorInfo,
      });
    }
    throw error; // AbortError / TimeoutError / CloudflareModelNotRegisteredError: untouched
  }

  if (!res.ok) {
    const bodyText = scrubAccount(await res.text().catch(() => ''), snapshot.accountId);
    const parsed = parseCloudflareErrorBody(bodyText);
    const info: CloudflareErrorInfo = {
      provider: 'cloudflare',
      code: parsed.code,
      message: parsed.message,
      requestId: cloudflareResponseRequestId(res.headers) ?? parsed.requestId,
      neurons: null, // Cloudflare rejected the call: nothing billed to meter (U1)
    };
    throw new APICallError({
      // The lifted text, so upstream-error.ts echoes it unchanged for 400/413/422.
      message: info.message ?? `Cloudflare Workers AI request failed: ${res.status}`,
      url,
      requestBodyValues: { model },
      statusCode: res.status,
      responseHeaders: Object.fromEntries(res.headers),
      responseBody: bodyText.slice(0, 2000),
      isRetryable: cloudflareRetryable(res.status, info.code),
      data: info,
    });
  }

  const neurons = parseNeuronsHeader(res.headers.get('cf-ai-neurons'));
  const upstreamRequestId = cloudflareResponseRequestId(res.headers);
  // A 2xx is billed: if its body turns out unusable, the error still carries the neurons (U1).
  const billed: CloudflareErrorInfo = {
    provider: 'cloudflare',
    code: null,
    message: null,
    requestId: upstreamRequestId,
    neurons,
  };
  let json: unknown;
  try {
    json = await res.json();
  } catch (error) {
    // The deadline fired mid-body: keep it a timeout, carrying the billed data.
    if (signal.aborted) throw abortWithBilledData(signal.reason ?? error, url, model, billed);
    json = undefined;
  }
  const result = unwrapCloudflareEnvelope(json);
  if (!result) {
    throw new APICallError({
      message: 'Cloudflare Workers AI returned an unusable response.',
      url,
      requestBodyValues: { model },
      statusCode: 502,
      isRetryable: false,
      data: billed,
    });
  }
  return { result, neurons, upstreamRequestId };
}

/** withRetries(postCloudflareOnce). The caller creates signal = AbortSignal.timeout(NATIVE_UPSTREAM_TIMEOUT_MS). */
export async function callCloudflareModel(
  snapshot: ProjectCloudflareSnapshot,
  model: string,
  body: unknown,
  signal: AbortSignal,
): Promise<CloudflareRunResult> {
  return withRetries(() => postCloudflareOnce(snapshot, model, body, signal), signal);
}

// ---- Cost (D6) -----------------------------------------------------------------

/** Workers AI's documented rate: $0.011 per 1,000 neurons. The single named constant (D6). */
export const WORKERS_AI_USD_PER_1K_NEURONS = 0.011;

/** Round to 6 decimals — usage_events.cost_usd is numeric(12,6). */
export function roundUsd6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function finiteNonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * D6 ESTIMATE of what Cloudflare bills the project's account. It ignores Cloudflare's
 * 10,000-neuron daily free allocation and neuron rounding, so it can overstate small
 * accounts' real invoice. Neurons header first; else registry input price × input
 * tokens (output is priced 0). Throws CloudflareModelNotRegisteredError for an
 * unregistered id (fail closed). Error rows call it only for a billed 2xx Sophy could
 * not use, with CloudflareErrorInfo.neurons and zero tokens (U1); responses Cloudflare
 * rejected keep a NULL cost.
 * Never returns NaN — a NaN would fail the numeric insert, which recordUsage swallows,
 * silently dropping the row from the monthly cap.
 */
export function cloudflareCostUsd(input: {
  model: string;
  neurons: number | null;
  inputTokens: number;
  outputTokens: number;
}): number {
  const entry = getCloudflareModel(input.model);
  if (!entry) throw new CloudflareModelNotRegisteredError(input.model);
  if (input.neurons != null && Number.isFinite(input.neurons) && input.neurons >= 0) {
    return roundUsd6((input.neurons * WORKERS_AI_USD_PER_1K_NEURONS) / 1000);
  }
  return roundUsd6(
    (finiteNonNegative(input.inputTokens) * entry.inputPerMTok) / 1e6 +
      (finiteNonNegative(input.outputTokens) * entry.outputPerMTok) / 1e6,
  );
}

/**
 * Every other surface calls the gateway through the AI SDK, which retries
 * transient failures by default (ai@6 retryWithExponentialBackoffRespectingRetryHeaders:
 * two retries, 2s then 4s, a provider's retry-after honored when under a minute).
 * That helper isn't exported and native surfaces (/v1/evaluate, /v1/extract) call
 * their upstream by hand, so the policy is mirrored here. Without it a transient
 * upstream 503 reached the client on the first failure, while the same blip on chat
 * was absorbed.
 */
import { APICallError, RetryError } from 'ai';

/** One deadline per native upstream call — every attempt and every retry wait (was assessments.ts:52-55). */
export const NATIVE_UPSTREAM_TIMEOUT_MS = 120_000;

const MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 2_000;
const RETRY_BACKOFF_FACTOR = 2;
const MAX_RETRY_AFTER_MS = 60_000;

/** Mirrors @ai-sdk/provider-utils isAbortError: a cancelled call is never retried. */
function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error ||
      (typeof DOMException !== 'undefined' && error instanceof DOMException)) &&
    (error.name === 'AbortError' || error.name === 'ResponseAborted' || error.name === 'TimeoutError')
  );
}

/**
 * Mirrors the AI SDK's getRetryDelayInMs: prefer retry-after-ms, then retry-after
 * (seconds or an HTTP date), when it is non-negative and either under a minute or
 * shorter than the backoff; otherwise fall back to the exponential delay.
 */
function retryDelayMs(error: unknown, exponentialDelayMs: number): number {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const headers = APICallError.isInstance(error)
    ? error.responseHeaders
    : APICallError.isInstance(cause)
      ? cause.responseHeaders
      : undefined;
  if (!headers) return exponentialDelayMs;
  let ms: number | undefined;
  const retryAfterMs = headers['retry-after-ms'];
  if (retryAfterMs) {
    const n = parseFloat(retryAfterMs);
    if (!Number.isNaN(n)) ms = n;
  }
  const retryAfter = headers['retry-after'];
  if (retryAfter && ms === undefined) {
    const seconds = parseFloat(retryAfter);
    ms = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
  }
  if (
    ms != null &&
    !Number.isNaN(ms) &&
    ms >= 0 &&
    (ms < MAX_RETRY_AFTER_MS || ms < exponentialDelayMs)
  ) {
    return ms;
  }
  return exponentialDelayMs;
}

/** A wait that ends early, and releases its timer, if the call's deadline fires. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `attempt`, retrying exactly as the AI SDK does. Cancellation rethrows at
 * once. A non-retryable failure on the first try rethrows as-is, so credential
 * health handling still sees a bare 401/402. Otherwise the attempts are collected
 * into a RetryError, whose lastError carries the final status — the same shape
 * chat, embeddings and images produce, which upstream-error.ts already unwraps.
 * Exported for unit testing.
 */
export async function withRetries<T>(attempt: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const errors: unknown[] = [];
  let delayMs = INITIAL_RETRY_DELAY_MS;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (isAbortError(error)) throw error;
      errors.push(error);
      const tries = errors.length;
      const message = error instanceof Error ? error.message : String(error);
      if (tries > MAX_RETRIES) {
        throw new RetryError({
          message: `Failed after ${tries} attempts. Last error: ${message}`,
          reason: 'maxRetriesExceeded',
          errors,
        });
      }
      if (APICallError.isInstance(error) && error.isRetryable) {
        await sleep(retryDelayMs(error, delayMs), signal);
        delayMs *= RETRY_BACKOFF_FACTOR;
        continue;
      }
      if (tries === 1) throw error;
      throw new RetryError({
        message: `Failed after ${tries} attempts with non-retryable error: '${message}'`,
        reason: 'errorNotRetryable',
        errors,
      });
    }
  }
}

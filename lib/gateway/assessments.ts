/**
 * Model assessment (POST /v1/evaluate).
 *
 * Native, not OpenAI-compatible. Vercel documents evaluation models as
 * unreachable through the OpenAI-, Anthropic- and Cohere-compatible endpoints,
 * so this surface mirrors the AI Gateway's own `POST /v1/evaluate` shape rather
 * than inventing an OpenAI-shaped one. A client already talking to the gateway
 * only changes its base URL.
 *
 * As on every other surface the API key owns the model: the client's `model`
 * field is accepted and ignored, and the key's evaluation model wins.
 *
 * Named "assessment" internally on purpose. `eval`/`evaluation` is already
 * taken by champion-versus-challenger model comparison (lib/eval/*, eval_runs,
 * UsageSource eval_challenger/eval_judge), so reusing it here would make the
 * console and the imports ambiguous. The wire words stay `evaluate`/`answers`.
 *
 * The upstream call is a hand-rolled authenticated POST via
 * `ctx.gateway.evaluator`: `experimental_evaluate` / `gateway.evaluationModel()`
 * only exist in ai@7.0.107 and @ai-sdk/gateway@4.0.87, well past our installed
 * majors. The credential itself never leaves lib/gateway/project-provider.ts.
 * Because it bypasses the SDK, it also has to supply the retries the SDK would
 * have given it — see withRetries.
 */
import { randomUUID } from 'node:crypto';
import { APICallError, RetryError } from 'ai';
import {
  recordUsage,
  recordAssessmentLog,
  extractGatewayCost,
  extractGatewayRequestId,
  ZERO_USAGE,
  type NormalizedUsage,
} from '@/lib/usage/record';
import type {
  AssessmentAnswer,
  AssessmentQuestion,
  EvaluationRequest,
  EvaluationResponse,
} from '@/lib/http/openai';
import { safeGatewayErrorMessage, upstreamErrorResponse } from '@/lib/gateway/upstream-error';
import { providerOf } from '@/lib/gateway/call';
import { catalogCapability } from '@/lib/gateway/models';
import { type AvailableModel } from '@/lib/gateway/capabilities';
import {
  normalizeProjectGatewayError,
  type ProjectGatewaySnapshot,
} from '@/lib/gateway/project-provider';

/**
 * One deadline for the whole upstream call — every attempt and every retry wait
 * — so retrying never raises the worst-case latency. Buffered, never a stream.
 */
const UPSTREAM_TIMEOUT_MS = 120_000;
/** Questions are answered in parallel upstream; bound the fan-out we pay for. */
const MAX_QUESTIONS = 32;
/** The evaluated state is echoed into request_logs, so cap it before any I/O. */
const MAX_STATE_CHARS = 200_000;

const EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';

// ---- Capability guard -------------------------------------------------------

/**
 * Pure: is this catalog model an evaluation model? `evaluation` is the raw
 * upstream catalog literal, treated exactly like `type === 'image'`.
 */
export function modelSupportsAssessment(m: AvailableModel): boolean {
  return m.type === 'evaluation';
}

/**
 * Classify a key's model against the (cached) gateway catalog. Returns
 * `'not_assessment'` only when the model is positively known to be something
 * else — an unknown id or an unavailable catalog returns `'unknown'` so we never
 * block a valid request on a catalog blip (a genuinely wrong id then fails at
 * the provider as a 502, which is correct). This matters more here than
 * elsewhere: evaluation models are new, and the catalog memo is an hour long,
 * so a freshly listed model must not be rejected by a stale warm instance. The lookup is the shared
 * catalogCapability, so a slow catalog also degrades to `'unknown'` after 1.5s
 * rather than holding the request for fetchFresh's 10s budget.
 */
export async function assessmentCapability(
  model: string,
): Promise<'assessment' | 'not_assessment' | 'unknown'> {
  const result = await catalogCapability(model, modelSupportsAssessment);
  return result === 'supported' ? 'assessment' : result === 'unsupported' ? 'not_assessment' : 'unknown';
}

// ---- Request parsing (pure) -------------------------------------------------

export interface ParsedAssessmentRequest {
  /** The shared state the questions are asked about. */
  state: unknown;
  questions: Record<string, AssessmentQuestion>;
  /** Namespaced provider options: provider-specific knobs only. */
  providerOptions: Record<string, Record<string, unknown>>;
}

export type ParseAssessmentResult =
  | { ok: true; value: ParsedAssessmentRequest }
  | { ok: false; status: number; message: string; code: string; param?: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bad(
  message: string,
  code: string,
  param?: string,
): { ok: false; status: number; message: string; code: string; param?: string } {
  return { ok: false, status: 400, message, code, param };
}

/** Validate one question. Returns null when it is well-formed. */
function checkQuestion(
  name: string,
  q: unknown,
): { ok: false; status: number; message: string; code: string; param?: string } | null {
  const at = `questions.${name}`;
  if (!isPlainObject(q)) {
    return bad(`${at} must be an object.`, 'invalid_question', at);
  }
  if (typeof q.instructions !== 'string' || q.instructions.trim() === '') {
    return bad(
      `${at}.instructions must be a non-empty string.`,
      'missing_instructions',
      `${at}.instructions`,
    );
  }
  const criteria = q.criteria;
  switch (q.type) {
    case 'boolean':
      // criteria is optional; when present it must name both cases.
      if (criteria !== undefined) {
        if (
          !isPlainObject(criteria) ||
          typeof criteria.true !== 'string' ||
          typeof criteria.false !== 'string'
        ) {
          return bad(
            `${at}.criteria must be an object with string "true" and "false" descriptions.`,
            'invalid_criteria',
            `${at}.criteria`,
          );
        }
      }
      return null;
    case 'choice':
      if (
        !isPlainObject(criteria) ||
        Object.keys(criteria).length < 2 ||
        Object.values(criteria).some((v) => typeof v !== 'string' || v.trim() === '')
      ) {
        return bad(
          `${at}.criteria must be an object mapping at least two option names to descriptions.`,
          'invalid_criteria',
          `${at}.criteria`,
        );
      }
      return null;
    case 'score':
      if (
        !Array.isArray(criteria) ||
        criteria.length < 2 ||
        criteria.some((v) => typeof v !== 'string' || v.trim() === '')
      ) {
        return bad(
          `${at}.criteria must be an array of at least two string labels, ordered lowest to highest.`,
          'invalid_criteria',
          `${at}.criteria`,
        );
      }
      return null;
    default:
      return bad(
        `${at}.type must be one of "boolean", "choice" or "score".`,
        'unsupported_question_type',
        `${at}.type`,
      );
  }
}

/**
 * Pure: validate and normalize an evaluate request. No I/O. The client's
 * `model` is deliberately not read — the key owns the model.
 */
export function parseAssessmentRequest(
  body: EvaluationRequest,
  model: string,
): ParseAssessmentResult {
  if (body.state === undefined || body.state === null) {
    return bad('Missing required parameter: state.', 'missing_state', 'state');
  }
  if (JSON.stringify(body.state).length > MAX_STATE_CHARS) {
    return bad(
      `state must not exceed ${MAX_STATE_CHARS} characters when serialized.`,
      'state_too_large',
      'state',
    );
  }

  if (body.questions === undefined || body.questions === null) {
    return bad('Missing required parameter: questions.', 'missing_questions', 'questions');
  }
  if (!isPlainObject(body.questions)) {
    return bad('questions must be an object.', 'invalid_questions', 'questions');
  }
  const names = Object.keys(body.questions);
  if (names.length === 0) {
    return bad('questions must contain at least one entry.', 'questions_empty', 'questions');
  }
  if (names.length > MAX_QUESTIONS) {
    return bad(
      `questions must not contain more than ${MAX_QUESTIONS} entries.`,
      'too_many_questions',
      'questions',
    );
  }
  for (const name of names) {
    const problem = checkQuestion(name, body.questions[name]);
    if (problem) return problem;
  }

  // No gateway user/tags metadata: attribution lives in Sophy's own
  // usage_events, and the gateway bills a per-request surcharge for tags.
  const providerOptions: Record<string, Record<string, unknown>> = {};
  if (body.providerOptions !== undefined) {
    if (!isPlainObject(body.providerOptions)) {
      return bad(
        'providerOptions must be an object.',
        'unsupported_provider_options',
        'providerOptions',
      );
    }
    const allowed = providerOf(model);
    for (const [namespace, knobs] of Object.entries(body.providerOptions)) {
      if (namespace !== allowed) {
        return bad(
          `providerOptions may only address the "${allowed}" namespace for this key's model.`,
          'unsupported_provider_options',
          `providerOptions.${namespace}`,
        );
      }
      if (!isPlainObject(knobs)) {
        return bad(
          `providerOptions.${namespace} must be an object.`,
          'unsupported_provider_options',
          `providerOptions.${namespace}`,
        );
      }
      providerOptions[namespace] = knobs;
    }
  }

  return {
    ok: true,
    value: { state: body.state, questions: body.questions, providerOptions },
  };
}

// ---- Response mapping (pure) ------------------------------------------------

interface RawAssessmentResponse {
  model?: unknown;
  answers?: unknown;
  usage?: { inputTokens?: unknown; outputTokens?: unknown };
  providerMetadata?: unknown;
}

function finite(v: unknown): number {
  return Number.isFinite(v) ? (v as number) : 0;
}

/** Whitelist one upstream answer to its discriminated shape, or null. */
function toAnswer(raw: unknown): AssessmentAnswer | null {
  if (!isPlainObject(raw)) return null;
  switch (raw.type) {
    case 'boolean':
      return { type: 'boolean', probability: finite(raw.probability) };
    case 'choice':
      if (typeof raw.choice !== 'string') return null;
      return {
        type: 'choice',
        choice: raw.choice,
        probabilities: isPlainObject(raw.probabilities)
          ? Object.fromEntries(
              Object.entries(raw.probabilities).map(([k, v]) => [k, finite(v)]),
            )
          : {},
      };
    case 'score':
      return {
        type: 'score',
        score: finite(raw.score),
        probabilities: isPlainObject(raw.probabilities)
          ? Object.fromEntries(
              Object.entries(raw.probabilities).map(([k, v]) => [k, finite(v)]),
            )
          : {},
      };
    default:
      return null;
  }
}

/**
 * Pure: map the gateway's evaluate response onto Sophy's wire shape. Returns
 * null when the upstream body is unusable, so the caller can turn that into a
 * clean 502 rather than serving a partial 200.
 *
 * `model` is always the key's model, never the upstream echo, and
 * `providerMetadata` is dropped — it carries Sophy's cost and generation id.
 */
export function toAssessmentResponse(
  raw: RawAssessmentResponse,
  model: string,
  asked: string[],
): EvaluationResponse | null {
  if (!isPlainObject(raw.answers)) return null;
  const answers: Record<string, AssessmentAnswer> = {};
  for (const name of asked) {
    const answer = toAnswer(raw.answers[name]);
    if (!answer) return null;
    answers[name] = answer;
  }
  const inputTokens = finite(raw.usage?.inputTokens);
  const outputTokens = finite(raw.usage?.outputTokens);
  return {
    model,
    answers,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}

// ---- Orchestrator (side-effectful) ------------------------------------------

export interface AssessmentCallContext {
  keyId: string;
  gateway: ProjectGatewaySnapshot;
  /** Full AI Gateway evaluation-model id, e.g. "typesafe-ai/jev". */
  model: string;
  /** When true, capture state/questions/answers to request_logs. */
  logContent: boolean;
}

/** Lift a human-readable message out of a non-2xx gateway body, if present. */
function liftUpstreamMessage(bodyText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (!isPlainObject(parsed)) return null;
    const err = parsed.error;
    if (isPlainObject(err) && typeof err.message === 'string') return err.message;
    if (typeof parsed.message === 'string') return parsed.message;
    return null;
  } catch {
    return null;
  }
}

// ---- Upstream call, retried like the AI SDK ---------------------------------

/**
 * Every other surface calls the gateway through the AI SDK, which retries
 * transient failures by default (ai@6 retryWithExponentialBackoffRespectingRetryHeaders:
 * two retries, 2s then 4s, a provider's retry-after honored when under a minute).
 * That helper isn't exported and this surface calls the gateway by hand, so the
 * policy is mirrored here. Without it a transient upstream 503 reached the client
 * on the first failure, while the same blip on chat was absorbed.
 */
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

/**
 * One authenticated POST. A non-2xx becomes an APICallError whose isRetryable is
 * APICallError's own default — 408, 409, 429 and 5xx, the rule the SDK applies —
 * and a dropped connection becomes a retryable one, as @ai-sdk/provider-utils
 * does for Node's "fetch failed". Neither ever carries state or questions.
 */
async function postEvaluate(
  ctx: AssessmentCallContext,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  let res: Response;
  try {
    res = await ctx.gateway.evaluator.evaluate(body, signal);
  } catch (error) {
    if (
      error instanceof TypeError &&
      ['fetch failed', 'failed to fetch'].includes(error.message.toLowerCase()) &&
      error.cause != null
    ) {
      const causeMessage = (error.cause as { message?: unknown }).message;
      throw new APICallError({
        message: `Cannot connect to API: ${typeof causeMessage === 'string' ? causeMessage : 'network error'}`,
        cause: error.cause,
        url: EVALUATE_URL,
        requestBodyValues: { model: ctx.model },
        isRetryable: true,
      });
    }
    throw error;
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new APICallError({
      message: liftUpstreamMessage(bodyText) ?? `gateway evaluate request failed: ${res.status}`,
      url: EVALUATE_URL,
      requestBodyValues: { model: ctx.model },
      statusCode: res.status,
      responseHeaders: Object.fromEntries(res.headers),
      responseBody: bodyText.slice(0, 2000),
    });
  }
  return res;
}

/**
 * Run one evaluation and record it. Mirrors the embeddings handler: usage is
 * always written (ok or error) under an id shared with the request log, and the
 * usage row goes in BEFORE the log — request_logs carries a foreign key onto
 * usage_events, and recordUsage swallows its own failures, so the reverse order
 * would silently drop the log row. Retries happen inside withRetries, so a call
 * that succeeds on a retry still records exactly one usage row.
 */
export async function handleAssessment(
  ctx: AssessmentCallContext,
  parsed: ParsedAssessmentRequest,
): Promise<Response> {
  const startedAt = Date.now();
  const provider = providerOf(ctx.model);
  const eventId = randomUUID();
  const logAssessment = (status: 'ok' | 'error', answers: unknown) =>
    ctx.logContent
      ? recordAssessmentLog({
          id: eventId,
          projectId: ctx.gateway.projectId,
          keyId: ctx.keyId,
          state: parsed.state,
          questions: parsed.questions,
          answers,
          status,
        })
      : Promise.resolve();

  try {
    const upstreamBody = {
      model: ctx.model,
      state: parsed.state,
      questions: parsed.questions,
      ...(Object.keys(parsed.providerOptions).length > 0
        ? { providerOptions: parsed.providerOptions }
        : {}),
    };
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    const res = await withRetries(() => postEvaluate(ctx, upstreamBody, signal), signal);

    let raw: RawAssessmentResponse;
    try {
      raw = (await res.json()) as RawAssessmentResponse;
    } catch {
      raw = {};
    }
    const payload = toAssessmentResponse(raw, ctx.model, Object.keys(parsed.questions));
    if (!payload) {
      throw new APICallError({
        message: 'The gateway returned an unusable evaluation response.',
        url: EVALUATE_URL,
        requestBodyValues: { model: ctx.model },
        statusCode: 502,
        isRetryable: false,
      });
    }

    const usage: NormalizedUsage = {
      ...ZERO_USAGE,
      inputTokens: payload.usage.inputTokens,
      outputTokens: payload.usage.outputTokens,
      totalTokens: payload.usage.totalTokens,
    };
    const pm = raw.providerMetadata as Record<string, unknown> | undefined;
    await recordUsage({
      id: eventId,
      projectId: ctx.gateway.projectId,
      gatewayCredentialId: ctx.gateway.gatewayCredentialId,
      keyId: ctx.keyId,
      provider,
      model: ctx.model,
      usage,
      costUsd: extractGatewayCost(pm),
      latencyMs: Date.now() - startedAt,
      status: 'ok',
      responseKind: 'assessment',
      gatewayRequestId: extractGatewayRequestId(pm),
    });
    await logAssessment('ok', payload.answers);

    return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    const normalizedError = await normalizeProjectGatewayError(ctx.gateway, err);
    await recordUsage({
      id: eventId,
      projectId: ctx.gateway.projectId,
      gatewayCredentialId: ctx.gateway.gatewayCredentialId,
      keyId: ctx.keyId,
      provider,
      model: ctx.model,
      usage: { ...ZERO_USAGE },
      latencyMs: Date.now() - startedAt,
      status: 'error',
      responseKind: 'assessment',
      errorMessage: safeGatewayErrorMessage(normalizedError),
    });
    await logAssessment('error', null);
    return upstreamErrorResponse(normalizedError, 'The evaluation request failed.');
  }
}

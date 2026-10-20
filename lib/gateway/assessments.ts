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
 *
 * Keys bound to a registered Cloudflare Workers AI evaluation model (Clef,
 * `@cf/cloudflare/clef*`) call the project's own Cloudflare credential instead,
 * through `callCloudflareModel` (lib/gateway/cloudflare-call.ts). They get the
 * same retries, the same single deadline, and the same usage and log rows,
 * attributed to the Cloudflare credential row. Neither token ever leaves its
 * provider module.
 */
import { randomUUID } from 'node:crypto';
import { APICallError } from 'ai';
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
  AssessmentAsset,
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
import { NATIVE_UPSTREAM_TIMEOUT_MS, withRetries } from '@/lib/gateway/retries';
import {
  ASSET_KEY_PATTERN,
  isStrictBase64,
  parseCloudflareImageAssets,
  summarizeAssets,
  toCloudflareImages,
} from '@/lib/gateway/image-assets';
import {
  cloudflareInputTokenEstimate,
  getCloudflareModel,
  isCloudflareModelId,
  requireCloudflareModel,
  type CloudflareModelEntry,
} from '@/lib/gateway/cloudflare-models';
import {
  callCloudflareModel,
  cloudflareCostUsd,
  cloudflareErrorInfo,
  cloudflareErrorRequestId,
  cloudflareRunUrlForLogs,
  type CloudflareErrorInfo,
} from '@/lib/gateway/cloudflare-call';
import {
  normalizeProjectCloudflareError,
  type ProjectCloudflareSnapshot,
} from '@/lib/gateway/cloudflare-provider';

/** Questions are answered in parallel upstream; bound the fan-out we pay for. */
const MAX_QUESTIONS = 32;
/** The evaluated state is echoed into request_logs, so cap it before any I/O. */
const MAX_STATE_CHARS = 200_000;

/** Clef question ids (Cloudflare schema: letters, digits, '_', '.', '-'; at most 100). Clef keys only (D8). */
const CLEF_QUESTION_ID = /^[A-Za-z0-9_.-]{1,100}$/;
/** Clef's per-question ceilings. Cloudflare 422s an 11-level score (cf-live/clef-invalid-score11). */
const CLEF_MAX_CHOICE_OPTIONS = 255;
const CLEF_MAX_SCORE_LEVELS = 10;
/** Cloudflare-native media fields. Sophy accepts images only through the keyed `assets`. */
const CLEF_MEDIA_FIELDS = ['images', 'audio', 'videos'] as const;
type ClefMediaField = (typeof CLEF_MEDIA_FIELDS)[number];

const EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate';
const SYSTEMONE_URL = 'https://ai-gateway.vercel.sh/typesafe/v1/systemone';

/**
 * Images ride only on TypeSafe's own request shape: the gateway's /v1/evaluate
 * drops `assets` silently, so Jev answered "cannot see a picture". Requests
 * carrying assets go to the gateway's TypeSafe-compatible endpoint instead.
 * TypeSafe's own per-image limit is 16 MiB, but Vercel caps a function request
 * body at 4.5 MB, which binds first; the count cap just bounds the fan-out.
 * Clef keys use parseCloudflareImageAssets instead: up to 4 png/jpg/jpeg/webp
 * images, no reference rule, sent as an ordered `images[]`.
 */
const ASSET_PROVIDER = 'typesafe-ai';
const MAX_ASSETS = 8;
const ASSET_FORMATS = new Set(['png', 'jpg', 'jpeg']);

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
  /**
   * Images keyed by the string `state`/questions use to refer to them (Jev).
   * Clef shows them to the model in key order, before the state, with no
   * substitution.
   */
  assets?: Record<string, AssessmentAsset>;
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
 * Clef-only rules (D8), run after every question has passed checkQuestion, so a
 * choice's criteria is already a plain object of >= 2 non-empty string
 * descriptions and a score's an array of >= 2 non-empty string labels.
 */
function checkClefQuestion(
  name: string,
  q: AssessmentQuestion,
): ReturnType<typeof bad> | null {
  const at = `questions.${name}`;
  if (!CLEF_QUESTION_ID.test(name)) {
    return bad(
      'Question ids for this model must be 1-100 letters, digits, "_", "." or "-".',
      'invalid_question_id',
      at,
    );
  }
  if (q.type === 'choice') {
    const ids = Object.keys(q.criteria);
    if (ids.length > CLEF_MAX_CHOICE_OPTIONS || ids.some((id) => id === '')) {
      return bad(
        `${at}.criteria must map 2 to ${CLEF_MAX_CHOICE_OPTIONS} non-empty option ids to descriptions for this model.`,
        'invalid_criteria',
        `${at}.criteria`,
      );
    }
  }
  if (q.type === 'score' && q.criteria.length > CLEF_MAX_SCORE_LEVELS) {
    return bad(
      `${at}.criteria must have 2 to ${CLEF_MAX_SCORE_LEVELS} levels for this model.`,
      'invalid_criteria',
      `${at}.criteria`,
    );
  }
  return null;
}

/**
 * Validate `assets`. Each must be a base64 PNG/JPEG whose bytes match its
 * declared format, and each key must appear somewhere in state/questions —
 * TypeSafe 400s an unreferenced asset, so failing here gives a clearer error.
 * Clef keys use parseCloudflareImageAssets instead: up to 4 png/jpg/jpeg/webp
 * images, no reference rule, sent as an ordered `images[]`.
 */
function parseAssets(
  raw: unknown,
  model: string,
  referenced: string,
): { ok: true; value: Record<string, AssessmentAsset> } | ReturnType<typeof bad> {
  if (!isPlainObject(raw)) return bad('assets must be an object.', 'invalid_assets', 'assets');
  if (providerOf(model) !== ASSET_PROVIDER) {
    return bad(
      "Image assets are only supported for TypeSafe Jev and Cloudflare Clef keys; this key's model cannot accept them.",
      'assets_not_supported',
      'assets',
    );
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) return bad('assets must contain at least one entry.', 'invalid_assets', 'assets');
  if (keys.length > MAX_ASSETS) {
    return bad(`assets must not contain more than ${MAX_ASSETS} entries.`, 'too_many_assets', 'assets');
  }
  // Entries + Object.fromEntries, never assets[key] = …: ASSET_KEY_PATTERN admits
  // '__proto__', and plain assignment would set the prototype and drop that image.
  const entries: [string, AssessmentAsset][] = [];
  for (const key of keys) {
    const at = `assets.${key}`;
    if (!ASSET_KEY_PATTERN.test(key)) {
      return bad(
        `Asset keys must be 1-64 characters of letters, digits, "_" or "-".`,
        'invalid_asset_key',
        at,
      );
    }
    const a = raw[key];
    if (!isPlainObject(a) || a.type !== 'image') {
      return bad(`${at} must be an object with type "image".`, 'invalid_asset', at);
    }
    const format = typeof a.format === 'string' ? a.format.toLowerCase() : '';
    if (!ASSET_FORMATS.has(format)) {
      return bad(`${at}.format must be "png", "jpg" or "jpeg".`, 'unsupported_asset_format', `${at}.format`);
    }
    const data = a.data_base64;
    // isStrictBase64, not the STRICT_BASE64 regex: that overflows V8's regexp stack
    // (RangeError) on a ~3.4 MB image, which fits under Vercel's body cap.
    if (typeof data !== 'string' || data.length === 0 || !isStrictBase64(data)) {
      return bad(
        `${at}.data_base64 must be standard padded base64 with no "data:" prefix or whitespace.`,
        'invalid_asset_data',
        `${at}.data_base64`,
      );
    }
    // PNG and JPEG signatures, as they read once base64-encoded.
    const isPng = data.startsWith('iVBORw0KGgo');
    const isJpeg = data.startsWith('/9j/');
    if (format === 'png' ? !isPng : !isJpeg) {
      return bad(
        `${at}.data_base64 is not a ${format === 'png' ? 'PNG' : 'JPEG'} image.`,
        'asset_format_mismatch',
        `${at}.data_base64`,
      );
    }
    if (!referenced.includes(key)) {
      return bad(
        `${at} is not referenced: put "${key}" in state, an instruction or criteria.`,
        'unreferenced_asset',
        at,
      );
    }
    entries.push([key, { type: 'image', format: format as AssessmentAsset['format'], data_base64: data }]);
  }
  return { ok: true, value: Object.fromEntries(entries) };
}

/**
 * Pure: validate and normalize an evaluate request. No I/O. The client's
 * `model` is deliberately not read — the key owns the model.
 *
 * Keys bound to a registered Cloudflare Clef model get Clef's own rules on top
 * (D8): question ids, option and level ceilings, no providerOptions, images only
 * through the keyed `assets`, and a pre-cap against the model's context window.
 * Every other model's result is unchanged.
 */
export function parseAssessmentRequest(
  body: EvaluationRequest,
  model: string,
): ParseAssessmentResult {
  // A `@cf/` key must be a registered Clef (evaluation) entry. Anything else fails
  // closed, exactly as the route guard does, so the handler can never be asked
  // to call a Cloudflare model it cannot price or address (D4).
  let clef: CloudflareModelEntry | null = null;
  if (isCloudflareModelId(model)) {
    const entry = getCloudflareModel(model);
    if (!entry || entry.type !== 'evaluation') {
      return bad("This key's model is not an evaluation model.", 'model_not_evaluation');
    }
    clef = entry;
  }

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
  if (clef) {
    for (const name of names) {
      const problem = checkClefQuestion(name, body.questions[name]);
      if (problem) return problem;
    }
  }

  // No gateway user/tags metadata: attribution lives in Sophy's own
  // usage_events, and the gateway bills a per-request surcharge for tags.
  const providerOptions: Record<string, Record<string, unknown>> = {};
  if (clef && body.providerOptions !== undefined) {
    // Clef has no providerOptions, and the Cloudflare body never carries any (D8).
    return bad(
      "providerOptions are not supported for this key's model.",
      'unsupported_provider_options',
      'providerOptions',
    );
  }
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

  if (clef) {
    // Cloudflare's own images/audio/videos would otherwise be dropped silently.
    const media = body as EvaluationRequest & Partial<Record<ClefMediaField, unknown>>;
    for (const field of CLEF_MEDIA_FIELDS) {
      if (media[field] !== undefined) {
        return bad(
          `Send images in the keyed "assets" field; "${field}" is not accepted.`,
          'unsupported_media_field',
          field,
        );
      }
    }
  }

  let assets: Record<string, AssessmentAsset> | undefined;
  if (body.assets !== undefined && body.assets !== null) {
    const parsedAssets = clef
      ? parseCloudflareImageAssets(body.assets)
      : parseAssets(body.assets, model, JSON.stringify([body.state, body.questions]));
    if (!parsedAssets.ok) return parsedAssets;
    assets = parsedAssets.value;
  }

  const value: ParsedAssessmentRequest = {
    state: body.state,
    questions: body.questions,
    providerOptions,
    ...(assets ? { assets } : {}),
  };

  if (clef) {
    // Cloudflare pre-checks every call as compact input JSON length / 4 against the
    // context window, with base64 image bytes excluded (cf-live/clef-flash-long:
    // 232,684 chars → 58,171; clef-image-large: images not counted). Measure the
    // exact upstream body minus images, so a request it would 413 never costs a
    // round trip. A real-token 422 can still occur below this (clef-flash-mid).
    const estimate = cloudflareInputTokenEstimate(toClefRequest({ ...value, assets: undefined }, clef));
    if (estimate > clef.contextWindow) {
      return bad(
        `state is too large for ${clef.name}: the request is estimated at ${estimate} tokens and the model accepts at most ${clef.contextWindow}.`,
        'state_too_large',
        'state',
      );
    }
  }

  return { ok: true, value };
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

/**
 * Choice and score answers keep upstream `confidence` (0–1) when it is a finite
 * number: Clef always sends it, and Jev does on the TypeSafe image path. It is
 * optional and additive on the wire, so a missing or non-finite value is omitted
 * rather than coerced to 0. `legend` is still dropped, because it only restates
 * the request's own criteria.
 */
function confidenceOf(raw: Record<string, unknown>): { confidence?: number } {
  return Number.isFinite(raw.confidence) ? { confidence: raw.confidence as number } : {};
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
        ...confidenceOf(raw),
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
        ...confidenceOf(raw),
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
  const entries: [string, AssessmentAnswer][] = [];
  for (const name of asked) {
    // Own keys only: a missing "__proto__" (or "constructor") answer must not read Object.prototype.
    if (!Object.hasOwn(raw.answers, name)) return null;
    const answer = toAnswer(raw.answers[name]);
    if (!answer) return null;
    entries.push([name, answer]);
  }
  // Object.fromEntries, never answers[name] = …: a question named "__proto__"
  // would set the prototype and silently drop its answer from the 200 and the log.
  const answers: Record<string, AssessmentAnswer> = Object.fromEntries(entries);
  const inputTokens = finite(raw.usage?.inputTokens);
  const outputTokens = finite(raw.usage?.outputTokens);
  return {
    model,
    answers,
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
  };
}

// ---- TypeSafe shape translation (pure) --------------------------------------

/** System One (TypeSafe and Clef) calls a boolean question `noul`; the rest carry over unchanged. */
function toSystemOneQuestions(
  questions: Record<string, AssessmentQuestion>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(questions).map(([name, q]) => [
      name,
      q.type === 'boolean' ? { ...q, type: 'noul' } : q,
    ]),
  );
}

/**
 * Pure: the TypeSafe System One body for an image request. TypeSafe calls a
 * boolean question `noul`; everything else, `providerOptions` included (the
 * gateway reads `providerOptions.gateway` there too), carries over unchanged.
 */
export function toTypeSafeRequest(
  parsed: ParsedAssessmentRequest,
  model: string,
): Record<string, unknown> {
  const questions = toSystemOneQuestions(parsed.questions);
  return {
    model,
    state: parsed.state,
    questions,
    assets: parsed.assets,
    ...(Object.keys(parsed.providerOptions).length > 0
      ? { providerOptions: parsed.providerOptions }
      : {}),
  };
}

/**
 * Pure: the Cloudflare Workers AI input for a Clef key (D8). `model` is the
 * registry's short selector, never the key id or anything client-supplied:
 * Cloudflare 422s a selector that differs from the path model
 * (cf-live/clef-path-flash-selector). No providerOptions and no `assets`: images
 * travel as an ordered `images[]`, which Clef shows before the state with no
 * key substitution.
 */
export function toClefRequest(
  parsed: ParsedAssessmentRequest,
  entry: CloudflareModelEntry,
): Record<string, unknown> {
  return {
    model: entry.selector,
    state: parsed.state,
    questions: toSystemOneQuestions(parsed.questions),
    ...(parsed.assets ? { images: toCloudflareImages(parsed.assets) } : {}),
  };
}

/**
 * Pure: lift a TypeSafe System One response into the gateway's /v1/evaluate
 * shape, so toAssessmentResponse and usage recording stay one path.
 */
export function fromTypeSafeResponse(raw: unknown): RawAssessmentResponse {
  if (!isPlainObject(raw)) return {};
  const answers = isPlainObject(raw.answers)
    ? Object.fromEntries(
        Object.entries(raw.answers).map(([name, a]) => [
          name,
          isPlainObject(a) && a.type === 'noul' ? { type: 'boolean', probability: a.noul } : a,
        ]),
      )
    : raw.answers;
  const usage = isPlainObject(raw.usage)
    ? { inputTokens: raw.usage.input_tokens, outputTokens: raw.usage.output_tokens }
    : undefined;
  return { model: raw.model, answers, usage, providerMetadata: raw.provider_metadata };
}

// ---- Orchestrator (side-effectful) ------------------------------------------

/**
 * Exactly one upstream per call, chosen by the route from the key's model (D3):
 * the project's Vercel AI Gateway snapshot, or, for a registered `@cf/` Clef
 * model, the project's own Cloudflare Workers AI snapshot. The other member is
 * absent, so a Cloudflare failure can never reach the Vercel credential's health.
 */
export type AssessmentCallContext =
  | {
      keyId: string;
      /** Full AI Gateway evaluation-model id, e.g. "typesafe-ai/jev". */
      model: string;
      /** When true, capture state/questions/answers to request_logs. */
      logContent: boolean;
      gateway: ProjectGatewaySnapshot;
      cloudflare?: undefined;
    }
  | {
      keyId: string;
      /** The key's registered Cloudflare evaluation model, e.g. "@cf/cloudflare/clef". */
      model: string;
      /** When true, capture state/questions/answers to request_logs. */
      logContent: boolean;
      cloudflare: ProjectCloudflareSnapshot;
      gateway?: undefined;
    };

/** The Vercel member, for the gateway-only helpers. */
type GatewayAssessmentContext = Extract<AssessmentCallContext, { gateway: ProjectGatewaySnapshot }>;

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

// Moved to lib/gateway/retries.ts; re-exported for tests/assessment-handler.test.ts.
export { withRetries };

/**
 * One authenticated POST. A non-2xx becomes an APICallError whose isRetryable is
 * APICallError's own default — 408, 409, 429 and 5xx, the rule the SDK applies —
 * and a dropped connection becomes a retryable one, as @ai-sdk/provider-utils
 * does for Node's "fetch failed". Neither ever carries state or questions.
 */
async function postEvaluate(
  ctx: GatewayAssessmentContext,
  body: unknown,
  signal: AbortSignal,
  withImages: boolean,
): Promise<Response> {
  const url = withImages ? SYSTEMONE_URL : EVALUATE_URL;
  let res: Response;
  try {
    res = withImages
      ? await ctx.gateway.evaluator.systemOneWithImages(body, signal)
      : await ctx.gateway.evaluator.evaluate(body, signal);
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
        url,
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
      url,
      requestBodyValues: { model: ctx.model },
      statusCode: res.status,
      responseHeaders: Object.fromEntries(res.headers),
      responseBody: bodyText.slice(0, 2000),
    });
  }
  return res;
}

// Moved to lib/gateway/image-assets.ts; re-exported for tests/assessments.test.ts.
export { summarizeAssets };

/**
 * U1: a 2xx that Cloudflare billed but Sophy could not use (an unusable envelope or
 * answer, or a body the deadline cut off) still cost the project's account, so its
 * error row is metered from cf-ai-neurons and counts toward the key's monthly cap.
 * Responses Cloudflare rejected (4xx, 5xx, network) carry no neurons and keep a
 * NULL cost. cloudflareCostUsd cannot throw here: neurons only exist once a call
 * was made, and requireCloudflareModel proved the id registered before it.
 */
function billedErrorCost(model: string, err: unknown): { costUsd?: number } {
  const neurons = cloudflareErrorInfo(err)?.neurons;
  if (typeof neurons !== 'number' || !Number.isFinite(neurons)) return {};
  return { costUsd: cloudflareCostUsd({ model, neurons, inputTokens: 0, outputTokens: 0 }) };
}

/**
 * Run one evaluation and record it. Mirrors the embeddings handler: usage is
 * always written (ok or error) under an id shared with the request log, and the
 * usage row goes in BEFORE the log — request_logs carries a foreign key onto
 * usage_events, and recordUsage swallows its own failures, so the reverse order
 * would silently drop the log row. Retries happen inside withRetries, so a call
 * that succeeds on a retry still records exactly one usage row. Clef keys call
 * the project's own Cloudflare Workers AI credential; the usage row is
 * attributed to that credential row, and a Cloudflare failure is classified
 * against that row only.
 */
export async function handleAssessment(
  ctx: AssessmentCallContext,
  parsed: ParsedAssessmentRequest,
): Promise<Response> {
  const startedAt = Date.now();
  const provider = providerOf(ctx.model);
  const eventId = randomUUID();
  // The tenant boundary comes from whichever snapshot this call holds.
  const projectId = ctx.cloudflare ? ctx.cloudflare.projectId : ctx.gateway.projectId;
  const logAssessment = (status: 'ok' | 'error', answers: unknown) =>
    ctx.logContent
      ? recordAssessmentLog({
          id: eventId,
          projectId,
          keyId: ctx.keyId,
          state: parsed.state,
          questions: parsed.questions,
          assets: summarizeAssets(parsed.assets),
          answers,
          status,
        })
      : Promise.resolve();

  try {
    // Clef on the project's Cloudflare Workers AI credential (D8).
    if (ctx.cloudflare) {
      // 1) The registry entry (fail closed) and ONE deadline for every attempt and wait.
      const entry = requireCloudflareModel(ctx.model, 'evaluation');
      const signal = AbortSignal.timeout(NATIVE_UPSTREAM_TIMEOUT_MS);
      // 2) Retried like the AI SDK (withRetries inside callCloudflareModel).
      const run = await callCloudflareModel(
        ctx.cloudflare,
        ctx.model,
        toClefRequest(parsed, entry),
        signal,
      );
      // 3) Clef speaks System One: noul → boolean, snake_case usage → camelCase.
      const payload = toAssessmentResponse(
        fromTypeSafeResponse(run.result),
        ctx.model,
        Object.keys(parsed.questions),
      );
      if (!payload) {
        // Billed but unusable: the error row keeps the request id and is metered (U1).
        const data: CloudflareErrorInfo = {
          provider: 'cloudflare',
          code: null,
          message: null,
          requestId: run.upstreamRequestId,
          neurons: run.neurons,
        };
        throw new APICallError({
          message: 'Cloudflare Workers AI returned an unusable evaluation response.',
          url: cloudflareRunUrlForLogs(ctx.model),
          requestBodyValues: { model: ctx.model },
          statusCode: 502,
          isRetryable: false,
          data,
        });
      }
      // 4) Usage BEFORE the log (request_logs has the FK), paid by the Cloudflare row (D6, D7).
      await recordUsage({
        id: eventId,
        projectId,
        cloudflareCredentialId: ctx.cloudflare.cloudflareCredentialId,
        keyId: ctx.keyId,
        provider,
        model: ctx.model,
        usage: {
          ...ZERO_USAGE,
          inputTokens: payload.usage.inputTokens,
          outputTokens: payload.usage.outputTokens,
          totalTokens: payload.usage.totalTokens,
        },
        // Never throws: requireCloudflareModel proved the id is registered and priced.
        costUsd: cloudflareCostUsd({
          model: ctx.model,
          neurons: run.neurons,
          inputTokens: payload.usage.inputTokens,
          outputTokens: payload.usage.outputTokens,
        }),
        latencyMs: Date.now() - startedAt,
        status: 'ok',
        responseKind: 'assessment',
        gatewayRequestId: run.upstreamRequestId, // cf-ai-req-id ?? cf-ray ?? null
      });
      await logAssessment('ok', payload.answers);
      return Response.json(payload, { headers: { 'cache-control': 'no-store' } });
    }

    // Vercel AI Gateway. ctx is narrowed to the gateway member from here on.
    const withImages = parsed.assets !== undefined;
    const upstreamBody = withImages
      ? toTypeSafeRequest(parsed, ctx.model)
      : {
          model: ctx.model,
          state: parsed.state,
          questions: parsed.questions,
          ...(Object.keys(parsed.providerOptions).length > 0
            ? { providerOptions: parsed.providerOptions }
            : {}),
        };
    const signal = AbortSignal.timeout(NATIVE_UPSTREAM_TIMEOUT_MS);
    const res = await withRetries(
      () => postEvaluate(ctx, upstreamBody, signal, withImages),
      signal,
    );

    let raw: RawAssessmentResponse;
    try {
      const json: unknown = await res.json();
      raw = withImages ? fromTypeSafeResponse(json) : (json as RawAssessmentResponse);
    } catch {
      raw = {};
    }
    const payload = toAssessmentResponse(raw, ctx.model, Object.keys(parsed.questions));
    if (!payload) {
      throw new APICallError({
        message: 'The gateway returned an unusable evaluation response.',
        url: withImages ? SYSTEMONE_URL : EVALUATE_URL,
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
    // Classify a failure only against the credential that made the call. A
    // Workers AI 401 must never mark the project's Vercel key invalid (D3, D8).
    const normalizedError = ctx.cloudflare
      ? await normalizeProjectCloudflareError(ctx.cloudflare, err)
      : await normalizeProjectGatewayError(ctx.gateway, err);
    await recordUsage({
      id: eventId,
      projectId,
      ...(ctx.cloudflare
        ? {
            cloudflareCredentialId: ctx.cloudflare.cloudflareCredentialId,
            // cf-ai-req-id ?? cf-ray ?? the message uuid; NULL when no Cloudflare response was read.
            gatewayRequestId: cloudflareErrorRequestId(err),
            ...billedErrorCost(ctx.model, err),
          }
        : { gatewayCredentialId: ctx.gateway.gatewayCredentialId }),
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

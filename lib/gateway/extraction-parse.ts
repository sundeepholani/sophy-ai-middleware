/**
 * Pure request parser for POST /v1/extract (Cloudflare Workers AI Clairic).
 *
 * No I/O and no server-only imports. The client's `model` is never read: the key
 * owns the model, which must be a registered `extraction` registry entry (D4, D9).
 * Checks run in the contract §4.1 order and the first failure wins:
 *   model → media fields → state type → fields (name, then spec) →
 *   reference_date → options → assets → empty state → 200k cap → context pre-cap.
 *
 * Field specs follow Clairic's input schema with a CLOSED key set (13 keys),
 * value-checked per key, plus D9's per-type essentials (list needs items;
 * estimate and forecast need min < max). Nothing is coerced or defaulted.
 *
 * toClairicRequest lives here, not in extraction.ts, because the pre-cap must
 * estimate over the exact upstream body and this module must stay pure.
 */
import type {
  AssessmentAsset,
  ExtractionFieldSpec,
  ExtractionFieldType,
  ExtractionRequest,
} from '@/lib/http/openai';
import {
  cloudflareInputTokenEstimate,
  getCloudflareModel,
  type CloudflareModelEntry,
} from '@/lib/gateway/cloudflare-models';
import {
  parseCloudflareImageAssets,
  toCloudflareImages,
  type AssetParseFailure,
} from '@/lib/gateway/image-assets';

/** The 9 Clairic field types, in Cloudflare's schema order. */
export const EXTRACTION_FIELD_TYPES: readonly ExtractionFieldType[] = Object.freeze<ExtractionFieldType[]>([
  'text',
  'number',
  'date',
  'time',
  'datetime',
  'duration',
  'list',
  'estimate',
  'forecast',
]);
/**
 * Sophy's cap; Cloudflare has none. Every Clairic pass re-reads (and re-bills)
 * the state (input_tokens = passes × state_tokens + schema_tokens), so bound it.
 */
export const MAX_EXTRACTION_FIELDS = 64;
/** The state is echoed into request_logs, so cap it before any I/O (as /v1/evaluate does). */
export const MAX_EXTRACTION_STATE_CHARS = 200_000;

export interface ParsedExtractionRequest {
  /** The text Clairic reads; spans index into it. '' only when assets are present. */
  state: string;
  /** Validated specs: known keys only, client field order kept, own keys only. */
  fields: Record<string, ExtractionFieldSpec>;
  /** Images by key: sent as images[] in key order, never referenced or substituted. */
  assets?: Record<string, AssessmentAsset>;
  /** YYYY-MM-DD; forwarded as reference_date only when the client sent it. */
  referenceDate?: string;
  /** Known keys only; {} when the client sent none (then omitted upstream). */
  options: { include_quantiles?: boolean; return_state_text?: boolean };
}

export type ParseExtractionResult =
  | { ok: true; value: ParsedExtractionRequest }
  | AssetParseFailure;

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/; // D9; '-' last, so no escape needed
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MEDIA_FIELDS = ['images', 'audio', 'videos'] as const;
const FIELD_KEYS: ReadonlySet<string> = new Set([
  'type',
  'instructions',
  'unit',
  'integer',
  'decimals',
  'items',
  'min',
  'max',
  'step',
  'scale',
  'null_threshold',
  'horizon',
  'interval',
]);
const LIST_ITEMS = ['text', 'number', 'date'] as const;
const SCALES = ['linear', 'log'] as const;
const INTERVALS = ['step', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
/** Clairic reads any other duration unit silently wrong (its schema types `unit` only as string). */
const DURATION_UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'] as const;
const OPTION_KEYS: ReadonlySet<string> = new Set(['include_quantiles', 'return_state_text']);
const OPTIONS_MESSAGE = 'options may only contain boolean include_quantiles and return_state_text.';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isIntegerIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
}
function oneOf<T extends string>(list: readonly T[], v: unknown): v is T {
  return typeof v === 'string' && (list as readonly string[]).includes(v);
}
/** A real calendar date written exactly YYYY-MM-DD (setUTCFullYear: no 0–99 → 19xx mapping). */
function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const m = ISO_DATE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const t = new Date(0);
  t.setUTCFullYear(y, mo, d);
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo && t.getUTCDate() === d;
}
function bad(message: string, code: string, param?: string): AssetParseFailure {
  return { ok: false, status: 400, message, code, param };
}

type SpecResult = { ok: true; value: ExtractionFieldSpec } | AssetParseFailure;

/** One field spec, contract §4.1 / spec §3.3 order. Returns a shallow copy (client key order, own keys). */
function checkFieldSpec(name: string, spec: unknown): SpecResult {
  const at = `fields.${name}`;
  if (!isPlainObject(spec)) return bad(`${at} must be an object with a "type".`, 'invalid_field', at);
  const type = spec.type;
  if (!oneOf(EXTRACTION_FIELD_TYPES, type)) {
    return bad(
      `${at}.type must be one of ${EXTRACTION_FIELD_TYPES.join(', ')}.`,
      'unsupported_field_type',
      `${at}.type`,
    );
  }
  for (const key of Object.keys(spec)) {
    if (!FIELD_KEYS.has(key)) {
      return bad(`${at}.${key} is not a supported field option.`, 'invalid_field', `${at}.${key}`);
    }
  }
  const fail = (key: string, message: string) => bad(message, 'invalid_field', `${at}.${key}`);
  const { instructions, unit, integer, decimals, items, min, max, step, scale, horizon, interval } = spec;
  const nullThreshold = spec.null_threshold;

  // A present key is one that is !== undefined; a null value is present and fails its check.
  if (instructions !== undefined && typeof instructions !== 'string') {
    return fail('instructions', `${at}.instructions must be a string.`);
  }
  if (unit !== undefined) {
    if (typeof unit !== 'string' || unit.trim() === '') {
      return fail('unit', `${at}.unit must be a non-empty string.`);
    }
    if (type === 'duration' && !oneOf(DURATION_UNITS, unit)) {
      return fail('unit', `${at}.unit must be one of ${DURATION_UNITS.join(', ')} for duration fields.`);
    }
  }
  if (integer !== undefined && typeof integer !== 'boolean') {
    return fail('integer', `${at}.integer must be a boolean.`);
  }
  if (decimals !== undefined && !isIntegerIn(decimals, 0, 6)) {
    return fail('decimals', `${at}.decimals must be an integer from 0 to 6.`);
  }
  if (type === 'list' && items === undefined) {
    return fail('items', `${at}.items is required for list fields: use "text", "number" or "date".`);
  }
  if (items !== undefined && !oneOf(LIST_ITEMS, items)) {
    return fail('items', `${at}.items must be "text", "number" or "date".`);
  }

  // min / max, each checked completely before the other: estimates take numbers or ISO
  // dates (a date estimate), every other type finite numbers. Required on estimate and
  // forecast, optional elsewhere.
  const ranged = type === 'estimate' || type === 'forecast';
  for (const [key, v] of [['min', min], ['max', max]] as const) {
    if (v === undefined) {
      if (ranged) return fail(key, `${at}.${key} is required for estimate and forecast fields.`);
      continue;
    }
    if (type === 'estimate') {
      if (!isFiniteNumber(v) && !isIsoDate(v)) {
        return fail(key, `${at}.${key} must be a finite number or an ISO date (YYYY-MM-DD).`);
      }
    } else if (!isFiniteNumber(v)) {
      return fail(key, `${at}.${key} must be a finite number.`);
    }
  }
  if (min !== undefined && max !== undefined) {
    if (isFiniteNumber(min) !== isFiniteNumber(max)) {
      return fail('max', `${at}.min and ${at}.max must both be numbers or both be ISO dates.`);
    }
    // Zero-padded YYYY-MM-DD strings order correctly as plain strings.
    const ordered = isFiniteNumber(min) ? min < (max as number) : (min as string) < (max as string);
    if (!ordered) return fail('min', `${at}.min must be less than ${at}.max.`);
  }
  if (step !== undefined) {
    // A numeric step on a date estimate counts days; 'month' and 'year' only make sense there.
    const dateEstimate = type === 'estimate' && isIsoDate(min) && isIsoDate(max);
    const okStep =
      (isFiniteNumber(step) && step > 0) || (dateEstimate && (step === 'month' || step === 'year'));
    if (!okStep) {
      return fail('step', `${at}.step must be a positive number, or "month" or "year" for a date estimate.`);
    }
  }
  if (scale !== undefined && !oneOf(SCALES, scale)) {
    return fail('scale', `${at}.scale must be "linear" or "log".`);
  }
  if (
    nullThreshold !== undefined &&
    !(isFiniteNumber(nullThreshold) && nullThreshold > 0 && nullThreshold <= 1)
  ) {
    return fail('null_threshold', `${at}.null_threshold must be a number greater than 0 and at most 1.`);
  }
  if (horizon !== undefined && !isIntegerIn(horizon, 1, 64)) {
    return fail('horizon', `${at}.horizon must be an integer from 1 to 64.`);
  }
  if (interval !== undefined && !oneOf(INTERVALS, interval)) {
    return fail('interval', `${at}.interval must be one of ${INTERVALS.join(', ')}.`);
  }
  // Every key is known and checked; known keys that do not apply to the type are forwarded
  // unchanged (Clairic ignores them). The spread defines own keys in client order.
  return { ok: true, value: { ...spec } as unknown as ExtractionFieldSpec };
}

/**
 * Pure: validate and normalize an extract request. No I/O. `model` is the
 * KEY's model; the client's `model` field is deliberately never read.
 */
export function parseExtractionRequest(body: ExtractionRequest, model: string): ParseExtractionResult {
  // 0) Fail closed on anything but a registered extraction model (D4). The route's
  //    guard runs first, so this is defensive.
  const entry = getCloudflareModel(model);
  if (!entry || entry.type !== 'extraction') {
    return bad("This key's model is not an extraction model.", 'model_not_extraction');
  }
  const raw = body as unknown as Record<string, unknown>;

  // 1) Cloudflare-native media fields are refused, not silently dropped: images ride in
  //    the keyed `assets`; audio and video are out of scope (D8, D9). Any value counts,
  //    null included.
  for (const field of MEDIA_FIELDS) {
    if (raw[field] !== undefined) {
      return bad(
        `Send images in the keyed "assets" field; "${field}" is not accepted.`,
        'unsupported_media_field',
        field,
      );
    }
  }

  const {
    state: rawState,
    fields: rawFields,
    reference_date: rawReferenceDate,
    options: rawOptions,
    assets: rawAssets,
  } = raw;

  // 2) state is a string; absent or null reads as '' (as evaluate treats a null state).
  //    Emptiness is judged after assets.
  if (rawState !== undefined && rawState !== null && typeof rawState !== 'string') {
    return bad('state must be a string.', 'invalid_state', 'state');
  }
  const state = typeof rawState === 'string' ? rawState : '';

  // 3) fields: 1–64 entries; each name before its spec, field by field.
  if (rawFields === undefined || rawFields === null) {
    return bad('Missing required parameter: fields.', 'missing_fields', 'fields');
  }
  if (!isPlainObject(rawFields)) return bad('fields must be an object.', 'invalid_fields', 'fields');
  const names = Object.keys(rawFields);
  if (names.length === 0) return bad('fields must contain at least one entry.', 'fields_empty', 'fields');
  if (names.length > MAX_EXTRACTION_FIELDS) {
    return bad(`fields must not contain more than ${MAX_EXTRACTION_FIELDS} entries.`, 'too_many_fields', 'fields');
  }
  const specs: [string, ExtractionFieldSpec][] = [];
  for (const name of names) {
    if (!FIELD_NAME.test(name)) {
      return bad(
        'Field names must start with a letter or "_" and use at most 64 letters, digits, "_", "." or "-".',
        'invalid_field_name',
        `fields.${name}`,
      );
    }
    const checked = checkFieldSpec(name, rawFields[name]);
    if (!checked.ok) return checked;
    specs.push([name, checked.value]);
  }
  // Object.fromEntries defines OWN keys. `out[name] = …` would turn a field named
  // "__proto__" (FIELD_NAME admits it) into a prototype swap and drop it.
  const fields = Object.fromEntries(specs) as Record<string, ExtractionFieldSpec>;

  // 4) reference_date: a real calendar date, exactly YYYY-MM-DD; never defaulted.
  let referenceDate: string | undefined;
  if (rawReferenceDate !== undefined && rawReferenceDate !== null) {
    if (!isIsoDate(rawReferenceDate)) {
      return bad('reference_date must be an ISO date (YYYY-MM-DD).', 'invalid_reference_date', 'reference_date');
    }
    referenceDate = rawReferenceDate;
  }

  // 5) options: only Clairic's two booleans.
  const options: ParsedExtractionRequest['options'] = {};
  if (rawOptions !== undefined && rawOptions !== null) {
    if (!isPlainObject(rawOptions)) return bad(OPTIONS_MESSAGE, 'invalid_options', 'options');
    for (const [key, v] of Object.entries(rawOptions)) {
      if (!OPTION_KEYS.has(key) || typeof v !== 'boolean') {
        return bad(OPTIONS_MESSAGE, 'invalid_options', `options.${key}`);
      }
      options[key as keyof ParsedExtractionRequest['options']] = v;
    }
  }

  // 6) assets: the shared Cloudflare image rules (contract §2.8): ≤ 4 png/jpg/jpeg/webp,
  //    4 MiB each and 8 MiB in total once decoded, and NO must-be-referenced rule.
  let assets: Record<string, AssessmentAsset> | undefined;
  if (rawAssets !== undefined && rawAssets !== null) {
    const parsedAssets = parseCloudflareImageAssets(rawAssets);
    if (!parsedAssets.ok) return parsedAssets;
    assets = parsedAssets.value;
  }

  // 7) Clairic: "Must be non-empty unless images are sent." Exactly '' is empty; a
  //    whitespace-only state is left to Cloudflare.
  if (state === '' && (assets === undefined || Object.keys(assets).length === 0)) {
    return bad(
      'Missing required parameter: state (it may be empty only when assets are sent).',
      'missing_state',
      'state',
    );
  }

  // 8) The request-log echo cap, as on /v1/evaluate (UTF-16 code units).
  if (state.length > MAX_EXTRACTION_STATE_CHARS) {
    return bad(`state must not exceed ${MAX_EXTRACTION_STATE_CHARS} characters.`, 'state_too_large', 'state');
  }

  const value: ParsedExtractionRequest = {
    state,
    fields,
    options,
    ...(assets ? { assets } : {}),
    ...(referenceDate !== undefined ? { referenceDate } : {}),
  };

  // 9) Context pre-cap (contract §2.8) over the exact upstream body minus images.
  //    Cloudflare's own pre-check is len(JSON)/4 > window → 413/5021 and ignores base64
  //    image bytes. A real-token 422/3030 below the cap still surfaces as a 400
  //    upstream_invalid_request. Large field instructions can trip it too; the error
  //    still names `state`, because the contract fixes that text.
  const estimate = cloudflareInputTokenEstimate(toClairicRequest({ ...value, assets: undefined }, entry));
  if (estimate > entry.contextWindow) {
    return bad(
      `state is too large for ${entry.name}: the request is estimated at ${estimate} tokens and the model accepts at most ${entry.contextWindow}.`,
      'state_too_large',
      'state',
    );
  }
  return { ok: true, value };
}

/**
 * Pure: the Clairic request body (contract §2.13).
 * `model` is the registry selector ('clairic'), never the key's '@cf/…' id (D4).
 * Images come from the keyed assets in key order: Clairic shows them before the
 * state, with no name substitution (D9). reference_date and options are sent only
 * when given; empty options are omitted. Never `assets`, never providerOptions.
 */
export function toClairicRequest(
  parsed: ParsedExtractionRequest,
  entry: CloudflareModelEntry,
): Record<string, unknown> {
  const images = parsed.assets ? toCloudflareImages(parsed.assets) : [];
  return {
    model: entry.selector,
    state: parsed.state,
    fields: parsed.fields,
    ...(images.length > 0 ? { images } : {}),
    ...(parsed.referenceDate !== undefined ? { reference_date: parsed.referenceDate } : {}),
    ...(Object.keys(parsed.options).length > 0 ? { options: parsed.options } : {}),
  };
}

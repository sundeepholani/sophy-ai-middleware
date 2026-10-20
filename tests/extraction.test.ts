import { describe, expect, it } from 'vitest';
import {
  EXTRACTION_FIELD_TYPES,
  MAX_EXTRACTION_FIELDS,
  MAX_EXTRACTION_STATE_CHARS,
  parseExtractionRequest,
  type ParsedExtractionRequest,
} from '@/lib/gateway/extraction-parse';
import { isExtractionModel, toClairicRequest, toExtractionResponse } from '@/lib/gateway/extraction';
import { cloudflareInputTokenEstimate, requireCloudflareModel } from '@/lib/gateway/cloudflare-models';
import type { ExtractionFieldSpec, ExtractionRequest } from '@/lib/http/openai';

/**
 * POST /v1/extract — the pure parts: request parser, Clairic body builder and
 * response mapping (D9; contract §2.13, §4.1). The fixtures are the live Clairic
 * samples recorded on 2026-10-20 (cf-live/clairic-{invoice,types}.*), copied inline.
 */

// ---- Live fixtures (Clairic, 2026-10-20) --------------------------------------

const CLAIRIC = '@cf/cloudflare/clairic';

const INVOICE_STATE =
  'Invoice INV-7731 from Blue Harbor Logistics. Issued 14 Oct. Net 15. Freight: 3 pallets at $410.00 each; fuel surcharge $57.50. Contacts: Meera Iyer, Tom Okafor.';
const INVOICE_FIELDS: Record<string, ExtractionFieldSpec> = {
  invoice_number: { type: 'text', instructions: 'Invoice number' },
  total: { type: 'number', unit: 'USD', decimals: 2, instructions: 'Amount due including the surcharge' },
  due_date: { type: 'date', instructions: 'Issue date plus the net payment days' },
  contacts: { type: 'list', items: 'text', instructions: 'Contact person names' },
  po_number: { type: 'text', instructions: 'Purchase order number' },
  days_to_pay: { type: 'estimate', min: 0, max: 90, step: 1, instructions: 'Days after issue until this invoice is paid' },
};
const INVOICE_REQUEST: ExtractionRequest = {
  model: 'clairic',
  state: INVOICE_STATE,
  fields: INVOICE_FIELDS,
  reference_date: '2026-10-20',
};
const INVOICE_RESULT = {
  model: 'clairic',
  answers: {
    invoice_number: { type: 'text', p_null: 0.00009758886153576896, span: [8, 16], guess: 'INV-7731', confidence: 1, value: 'INV-7731' },
    total: { type: 'number', p_null: 0.0002998378186021, guess: 1287.5, confidence: 0.8682515184261609, value: 1287.5 },
    due_date: { type: 'date', p_null: 0.000010327539712307043, guess: '2026-10-29', confidence: 0.9999454048181, value: '2026-10-29' },
    contacts: { type: 'list', value: ['Meera Iyer', 'Tom Okafor'], spans: [[137, 147], [149, 159]], confidence: 0.9707825068312013 },
    po_number: { type: 'text', p_null: 0.9999994039535522, span: [8, 16], guess: 'INV-7731', confidence: 0.999321699142456, value: null },
    days_to_pay: { type: 'estimate', value: 18, mean: 17.58255853506008, median: 16, p10: 13, p90: 25, p_below: 0.000008598190106567927, p_above: 0.00000881781852513086 },
  },
  truncated: false,
  usage: { state_tokens: 62, image_tokens: 0, schema_tokens: 529, input_tokens: 715, output_tokens: 0, passes: 3 },
};

const TYPES_REQUEST: ExtractionRequest = {
  model: 'clairic',
  state:
    'Daily support tickets opened.\ndate,tickets\n2026-10-12,120\n2026-10-13,131\n2026-10-14,128\n2026-10-15,140\n2026-10-16,152\n2026-10-17,97\n2026-10-18,90\n2026-10-19,135\nOutage reported at 14:05 on 2026-10-19 and resolved 2 hours 30 minutes later. Affected order ids: 4410, 4415, 4422. Escalations on 2026-10-15 and 2026-10-19.',
  reference_date: '2026-10-20',
  fields: {
    next_days: { type: 'forecast', horizon: 2, interval: 'day', min: 0, max: 500, instructions: 'Tickets opened on each of the next days' },
    outage_length: { type: 'duration', unit: 'minutes', instructions: 'How long the outage lasted' },
    outage_time: { type: 'time', instructions: 'Time the outage was reported' },
    outage_start: { type: 'datetime', instructions: 'When the outage was reported' },
    order_ids: { type: 'list', items: 'number', instructions: 'Affected order ids' },
    escalation_dates: { type: 'list', items: 'date', instructions: 'Escalation dates' },
    peak: { type: 'number', integer: true, instructions: 'Highest daily ticket count' },
  },
};
const TYPES_RESULT = {
  model: 'clairic',
  answers: {
    next_days: {
      type: 'forecast',
      value: [142.39247794610196, 140.63904349308126],
      median: [141.37265130269873, 139.89668834359733],
      p10: [120.89128245126098, 112.4172213185731],
      p90: [165.28690709274733, 169.56200678663444],
      steps: [
        { value: 142.39247794610196, mean: 142.39247794610196, median: 141.37265130269873, p10: 120.89128245126098, p90: 165.28690709274733, p_below: 0.00000640254802419804, p_above: 0.0000029447071483446052 },
        { value: 140.63904349308126, mean: 140.63904349308126, median: 139.89668834359733, p10: 112.4172213185731, p90: 169.56200678663444, p_below: 0.000010098168786498718, p_above: 0.000004908068149234168 },
      ],
    },
    outage_length: { type: 'duration', p_null: 5.886057579118642e-7, unit: 'minutes', guess: 150, confidence: 0.993459200833119, value: 150 },
    outage_time: { type: 'time', p_null: 2.460476544730028e-10, guess: '14:05:00', confidence: 0.999994397195003, value: '14:05:00' },
    outage_start: { type: 'datetime', p_null: 7.564277204608061e-9, guess: '2026-10-19T14:05:00', confidence: 0.9999951124379507, value: '2026-10-19T14:05:00' },
    order_ids: { type: 'list', value: [4410, 4415, 4422], confidences: [0.9999883175902078, 0.9999873639585022, 0.9999591127076685], confidence: 0.9999337920904449 },
    escalation_dates: { type: 'list', value: ['2026-10-15', '2026-10-19'], confidences: [0.9999990463265931, 0.9999923706636761], confidence: 0.9999399848563097 },
    peak: { type: 'number', p_null: 0.0000064238879531330895, guess: 152, confidence: 0.9699041116988275, value: 152 },
  },
  truncated: false,
  usage: { state_tokens: 212, image_tokens: 0, schema_tokens: 669, input_tokens: 881, output_tokens: 0, passes: 1 },
};

// cf-live/clairic-spans: the invoice behind a multi-byte prefix, with both options set.
// The answers are trimmed to two fields; every value is the live one.
const SPANS_STATE = `Café 🚚 note. ${INVOICE_STATE}`;
const SPANS_REQUEST: ExtractionRequest = {
  model: 'clairic',
  state: SPANS_STATE,
  fields: INVOICE_FIELDS,
  reference_date: '2026-10-20',
  options: { return_state_text: true, include_quantiles: true },
};
const SPANS_RESULT = {
  model: 'clairic',
  answers: {
    invoice_number: { type: 'text', p_null: 0.00003072709296247922, span: [21, 29], guess: 'INV-7731', confidence: 1, value: 'INV-7731' },
    days_to_pay: {
      type: 'estimate',
      value: 17,
      mean: 17.309188080341308,
      median: 16,
      p10: 14,
      p90: 24,
      quantiles: [
        9, 10, 11, 12, 12, 12, 13, 13, 13, 14, 14, 14, 14, 14, 14, 14, 14, 14, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
        15, 15, 15, 15, 15, 15, 15, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 17, 17, 17, 17,
        17, 17, 17, 17, 17, 17, 17, 18, 18, 18, 18, 18, 18, 18, 19, 19, 19, 19, 19, 20, 20, 21, 21, 22, 22, 23, 23, 24, 24, 25, 25,
        26, 27, 27, 29, 30, 35,
      ],
      p_below: 0.000006990712790866382,
      p_above: 0.000006555015261255903,
    },
  },
  truncated: false,
  usage: { state_tokens: 70, image_tokens: 0, schema_tokens: 529, input_tokens: 739, output_tokens: 0, passes: 3 },
  state_text: SPANS_STATE,
};

// Images. All are strict padded base64 with the right signature.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'; // 1x1 PNG
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQ=='; // FF D8 FF E0 … JFIF header bytes
const WEBP_B64 = 'UklGRhoAAABXRUJQVlA4TAAAAAAAAAAAAAAAAAAAAAA='; // 'RIFF' + size + 'WEBPVP8L' + zeros
const png = (data = PNG_B64) => ({ type: 'image' as const, format: 'png' as const, data_base64: data });

// Size fixtures, built once (the same string is reused across keys).
const PNG_4MIB_PLUS = 'iVBORw0KGgoA' + 'AAAA'.repeat(1_398_102); // 5 592 420 chars → 4 194 315 bytes decoded (> 4 MiB)
const PNG_3MIB = 'iVBORw0KGgoA' + 'AAAA'.repeat(1_048_576); // 4 194 316 chars → 3 145 737 bytes; ×3 > 8 MiB

// ---- Helpers --------------------------------------------------------------------

const ENTRY = requireCloudflareModel(CLAIRIC, 'extraction');
const BASE = { state: 'Invoice INV-7731 from Blue Harbor Logistics.', fields: { invoice_number: { type: 'text' } } };
const withField = (spec: unknown) => ({ ...BASE, fields: { f: spec } });
const nFields = (n: number, spec: unknown = { type: 'text' }) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, spec]));

function ok(body: unknown): ParsedExtractionRequest {
  const r = parseExtractionRequest(body as ExtractionRequest, CLAIRIC);
  if (!r.ok) throw new Error(`expected ok, got ${r.code} at ${r.param}: ${r.message}`);
  return r.value;
}

describe('extraction constants', () => {
  it('pins the field types, the field cap and the state cap', () => {
    expect(EXTRACTION_FIELD_TYPES).toEqual([
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
    expect(MAX_EXTRACTION_FIELDS).toBe(64);
    expect(MAX_EXTRACTION_STATE_CHARS).toBe(200_000);
  });
});

describe('isExtractionModel', () => {
  it('accepts only the registered Clairic id and fails closed for everything else', () => {
    expect(isExtractionModel(CLAIRIC)).toBe(true);
    for (const model of [
      '@cf/cloudflare/clef',
      '@cf/cloudflare/clef-flash',
      '@cf/cloudflare/clef-omni',
      '@cf/cloudflare/clairic-2',
      '@CF/cloudflare/clairic',
      ' @cf/cloudflare/clairic',
      'cloudflare/clairic',
      'typesafe-ai/jev',
      'openai/gpt-5-mini',
      '',
    ]) {
      expect(isExtractionModel(model), model).toBe(false);
    }
  });
});

describe('parseExtractionRequest — acceptances', () => {
  it('accepts the live invoice request, keeping field order and the reference date', () => {
    const v = ok(INVOICE_REQUEST);
    expect(v.state).toBe(INVOICE_STATE);
    expect(Object.keys(v.fields)).toEqual([
      'invoice_number',
      'total',
      'due_date',
      'contacts',
      'po_number',
      'days_to_pay',
    ]);
    expect(v.fields).toEqual(INVOICE_FIELDS);
    expect(v.referenceDate).toBe('2026-10-20');
    expect(v.options).toEqual({});
    expect('assets' in v).toBe(false);
  });

  it('accepts the live multi-type request: forecast, duration, time, datetime, number and date lists, integer', () => {
    const v = ok(TYPES_REQUEST);
    expect(v.fields).toEqual(TYPES_REQUEST.fields);
    expect(v.state).toBe(TYPES_REQUEST.state);
  });

  it('keeps both options when they are booleans', () => {
    const v = ok({ ...BASE, options: { return_state_text: true, include_quantiles: false } });
    expect(v.options).toEqual({ return_state_text: true, include_quantiles: false });
  });

  it('ignores the client model field (the key owns the model)', () => {
    const v = ok({ ...BASE, model: 'openai/gpt-5' });
    expect(toClairicRequest(v, ENTRY).model).toBe('clairic');
  });

  it('accepts a date estimate with ISO bounds and a month, year or day step', () => {
    const v = ok({
      ...BASE,
      fields: {
        a: { type: 'estimate', min: '2026-11-01', max: '2027-01-31', step: 'month' },
        b: { type: 'estimate', min: '2026-11-01', max: '2027-01-31', step: 'year' },
        c: { type: 'estimate', min: '2026-11-01', max: '2026-11-30', step: 7 },
      },
    });
    expect(Object.keys(v.fields)).toEqual(['a', 'b', 'c']);
  });

  it("accepts Cloudflare's documented log-scale estimate and forecast specs", () => {
    const fields = {
      repair_cost: { type: 'estimate', unit: 'USD', min: 10, max: 5000, scale: 'log', step: 1 },
      travelers: { type: 'forecast', horizon: 1, interval: 'day', min: 500000, max: 4000000, scale: 'log' },
    };
    expect(ok({ ...BASE, fields }).fields).toEqual(fields);
  });

  it('accepts the boundary values', () => {
    ok({
      ...BASE,
      fields: {
        d0: { type: 'number', decimals: 0 },
        d6: { type: 'number', decimals: 6 },
        h1: { type: 'forecast', min: 0, max: 1, horizon: 1 },
        h64: { type: 'forecast', min: 0, max: 1, horizon: 64 },
        n1: { type: 'text', null_threshold: 1 },
        nsmall: { type: 'text', null_threshold: 0.0001 },
      },
    });
    for (const unit of ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years']) {
      expect(ok(withField({ type: 'duration', unit })).fields.f).toEqual({ type: 'duration', unit });
    }
  });

  it('accepts exactly 64 fields and a 64-character name', () => {
    const v = ok({ state: 'x', fields: { ...nFields(63), ['a' + 'b'.repeat(63)]: { type: 'text' } } });
    expect(Object.keys(v.fields)).toHaveLength(64);
  });

  it('accepts an empty, missing or null state when assets are sent', () => {
    for (const state of ['', undefined, null]) {
      const v = ok({ ...(state === undefined ? {} : { state }), fields: BASE.fields, assets: { r: png() } });
      expect(v.state).toBe('');
    }
  });

  it('needs no asset reference and keeps assets in key order', () => {
    const v = ok({
      state: 'Read the receipt.',
      fields: BASE.fields,
      assets: { b: png(), a: { type: 'image', format: 'jpg', data_base64: JPEG_B64 } },
    });
    expect(Object.keys(v.assets!)).toEqual(['b', 'a']);
    expect(toClairicRequest(v, ENTRY).images).toEqual([
      { content_type: 'image/png', base64: PNG_B64 },
      { content_type: 'image/jpeg', base64: JPEG_B64 },
    ]);
  });

  it('accepts a WebP asset', () => {
    const v = ok({ ...BASE, assets: { w: { type: 'image', format: 'webp', data_base64: WEBP_B64 } } });
    expect(toClairicRequest(v, ENTRY).images).toEqual([{ content_type: 'image/webp', base64: WEBP_B64 }]);
  });

  it('treats null reference_date, options and assets as absent', () => {
    const v = ok({ ...BASE, reference_date: null, options: null, assets: null });
    expect('referenceDate' in v).toBe(false);
    expect(v.options).toEqual({});
    expect('assets' in v).toBe(false);
  });

  it('keeps a field named __proto__ as an own key', () => {
    const v = ok(JSON.parse('{"state":"x","fields":{"__proto__":{"type":"text"},"b":{"type":"number"}}}'));
    expect(Object.keys(v.fields)).toEqual(['__proto__', 'b']);
    expect(JSON.stringify(toClairicRequest(v, ENTRY))).toContain('"__proto__":{"type":"text"}');
  });

  it('forwards known keys that do not apply to the type, unchanged', () => {
    const spec = { type: 'text', horizon: 3, interval: 'day', decimals: 2 };
    expect(ok(withField(spec)).fields.f).toEqual(spec);
  });

  it('leaves a whitespace-only state to Cloudflare', () => {
    expect(ok({ ...BASE, state: '  \n' }).state).toBe('  \n');
  });

  it('accepts a state of exactly 200000 characters', () => {
    expect(ok({ ...BASE, state: 'x'.repeat(200_000) }).state).toHaveLength(200_000);
  });

  it('does not count image bytes toward the context pre-cap', () => {
    // 300 012 base64 characters would estimate 75 003 tokens on their own if counted.
    const v = ok({ state: 'x', fields: BASE.fields, assets: { big: png('iVBORw0KGgoA' + 'AAAA'.repeat(75_000)) } });
    expect(Object.keys(v.assets!)).toEqual(['big']);
  });

  it('accepts a 4.48M-character base64 image instead of throwing', () => {
    // 4 480 012 characters (3 360 009 bytes decoded): above the old backtracking regex's ~4.47M overflow.
    const body = { ...BASE, assets: { k: png('iVBORw0KGgoA' + 'AAAA'.repeat(1_120_000)) } };
    let result: ReturnType<typeof parseExtractionRequest> | undefined;
    expect(() => {
      result = parseExtractionRequest(body as ExtractionRequest, CLAIRIC);
    }).not.toThrow();
    expect(result?.ok).toBe(true);
  });

  it('accepts empty instructions, dotted and dashed names, optional numeric bounds and a leap day', () => {
    const v = ok({
      ...BASE,
      reference_date: '2028-02-29',
      fields: {
        'line_items.total-due': { type: 'number', instructions: '', min: 0, max: 10_000 },
        _private: { type: 'number', min: 5 },
      },
    });
    expect(v.referenceDate).toBe('2028-02-29');
    expect(v.fields['line_items.total-due']).toEqual({ type: 'number', instructions: '', min: 0, max: 10_000 });
  });

  it('copies each spec, so later client mutations cannot reach the parsed request', () => {
    const spec = { type: 'text', instructions: 'Invoice number' };
    const v = ok(withField(spec));
    spec.instructions = 'changed';
    expect(v.fields.f).toEqual({ type: 'text', instructions: 'Invoice number' });
  });
});

type Rejection = [title: string, body: unknown, code: string, param: string | undefined, message?: string];

const REJECTIONS: Rejection[] = [
  // Media fields, before anything else.
  ['images field', { ...BASE, images: [{ content_type: 'image/png', base64: PNG_B64 }] }, 'unsupported_media_field', 'images', 'Send images in the keyed "assets" field; "images" is not accepted.'],
  ['audio field', { ...BASE, audio: 'x' }, 'unsupported_media_field', 'audio', 'Send images in the keyed "assets" field; "audio" is not accepted.'],
  ['videos field, even null', { ...BASE, videos: null }, 'unsupported_media_field', 'videos'],
  ['media rule before state type', { state: 5, fields: BASE.fields, images: [] }, 'unsupported_media_field', 'images'],
  // State type.
  ['numeric state', { ...BASE, state: 5 }, 'invalid_state', 'state', 'state must be a string.'],
  ['object state', { ...BASE, state: { a: 1 } }, 'invalid_state', 'state'],
  ['array state', { ...BASE, state: ['a'] }, 'invalid_state', 'state'],
  ['state type before fields', { state: true }, 'invalid_state', 'state'],
  // Fields.
  ['missing fields', { state: 'x' }, 'missing_fields', 'fields', 'Missing required parameter: fields.'],
  ['null fields', { state: 'x', fields: null }, 'missing_fields', 'fields'],
  ['array fields', { state: 'x', fields: [{ type: 'text' }] }, 'invalid_fields', 'fields', 'fields must be an object.'],
  ['string fields', { state: 'x', fields: 'total' }, 'invalid_fields', 'fields'],
  ['empty fields', { state: 'x', fields: {} }, 'fields_empty', 'fields', 'fields must contain at least one entry.'],
  ['65 fields', { state: 'x', fields: nFields(65) }, 'too_many_fields', 'fields', 'fields must not contain more than 64 entries.'],
  ['name starting with a digit', { state: 'x', fields: { '1st': { type: 'text' } } }, 'invalid_field_name', 'fields.1st', 'Field names must start with a letter or "_" and use at most 64 letters, digits, "_", "." or "-".'],
  ['name with a space', { state: 'x', fields: { 'has space': { type: 'text' } } }, 'invalid_field_name', 'fields.has space'],
  ['65-character name', { state: 'x', fields: { ['a' + 'b'.repeat(64)]: { type: 'text' } } }, 'invalid_field_name', `fields.a${'b'.repeat(64)}`],
  ['empty name', { state: 'x', fields: { '': { type: 'text' } } }, 'invalid_field_name', 'fields.'],
  ['name checked before spec', { state: 'x', fields: { '1bad': 'not an object' } }, 'invalid_field_name', 'fields.1bad'],
  ['first bad field wins', { state: 'x', fields: { a: { type: 'bogus' }, '1b': { type: 'text' } } }, 'unsupported_field_type', 'fields.a.type'],
  // Field specs.
  ['string spec', withField('text'), 'invalid_field', 'fields.f', 'fields.f must be an object with a "type".'],
  ['array spec', withField([]), 'invalid_field', 'fields.f'],
  ['null spec', withField(null), 'invalid_field', 'fields.f'],
  ['missing type', withField({ instructions: 'x' }), 'unsupported_field_type', 'fields.f.type', 'fields.f.type must be one of text, number, date, time, datetime, duration, list, estimate, forecast.'],
  ["unknown type (Cloudflare's live 400/5006 case)", withField({ type: 'currency' }), 'unsupported_field_type', 'fields.f.type'],
  ['unknown key', withField({ type: 'text', format: 'x' }), 'invalid_field', 'fields.f.format', 'fields.f.format is not a supported field option.'],
  ['unknown keys before value checks', withField({ type: 'text', decimals: 99, zzz: 1 }), 'invalid_field', 'fields.f.zzz'],
  ['non-string instructions', withField({ type: 'text', instructions: 5 }), 'invalid_field', 'fields.f.instructions', 'fields.f.instructions must be a string.'],
  ['null instructions', withField({ type: 'text', instructions: null }), 'invalid_field', 'fields.f.instructions'],
  ['non-string unit', withField({ type: 'number', unit: 5 }), 'invalid_field', 'fields.f.unit', 'fields.f.unit must be a non-empty string.'],
  ['blank unit', withField({ type: 'number', unit: '  ' }), 'invalid_field', 'fields.f.unit'],
  ['undocumented duration unit', withField({ type: 'duration', unit: 'mins' }), 'invalid_field', 'fields.f.unit', 'fields.f.unit must be one of seconds, minutes, hours, days, weeks, months, years for duration fields.'],
  ['non-boolean integer', withField({ type: 'number', integer: 'yes' }), 'invalid_field', 'fields.f.integer', 'fields.f.integer must be a boolean.'],
  ['decimals 7', withField({ type: 'number', decimals: 7 }), 'invalid_field', 'fields.f.decimals', 'fields.f.decimals must be an integer from 0 to 6.'],
  ['decimals -1', withField({ type: 'number', decimals: -1 }), 'invalid_field', 'fields.f.decimals'],
  ['decimals 2.5', withField({ type: 'number', decimals: 2.5 }), 'invalid_field', 'fields.f.decimals'],
  ["decimals '2'", withField({ type: 'number', decimals: '2' }), 'invalid_field', 'fields.f.decimals'],
  ['list without items', withField({ type: 'list' }), 'invalid_field', 'fields.f.items', 'fields.f.items is required for list fields: use "text", "number" or "date".'],
  ['bad items', withField({ type: 'list', items: 'boolean' }), 'invalid_field', 'fields.f.items', 'fields.f.items must be "text", "number" or "date".'],
  ['estimate without min', withField({ type: 'estimate', max: 10 }), 'invalid_field', 'fields.f.min', 'fields.f.min is required for estimate and forecast fields.'],
  ['estimate without max', withField({ type: 'estimate', min: 0 }), 'invalid_field', 'fields.f.max', 'fields.f.max is required for estimate and forecast fields.'],
  ['forecast without bounds', withField({ type: 'forecast', horizon: 2, interval: 'day' }), 'invalid_field', 'fields.f.min'],
  ['estimate word bound', withField({ type: 'estimate', min: 'soon', max: 10 }), 'invalid_field', 'fields.f.min', 'fields.f.min must be a finite number or an ISO date (YYYY-MM-DD).'],
  ['impossible date', withField({ type: 'estimate', min: '2026-02-01', max: '2026-02-30' }), 'invalid_field', 'fields.f.max', 'fields.f.max must be a finite number or an ISO date (YYYY-MM-DD).'],
  ['unpadded date', withField({ type: 'estimate', min: '2026-1-5', max: '2026-12-01' }), 'invalid_field', 'fields.f.min'],
  ['forecast date bound', withField({ type: 'forecast', min: '2026-11-01', max: '2026-12-01' }), 'invalid_field', 'fields.f.min', 'fields.f.min must be a finite number.'],
  ['non-numeric min on a number field', withField({ type: 'number', min: 'x' }), 'invalid_field', 'fields.f.min', 'fields.f.min must be a finite number.'],
  ['mixed bound kinds', withField({ type: 'estimate', min: 0, max: '2026-12-01' }), 'invalid_field', 'fields.f.max', 'fields.f.min and fields.f.max must both be numbers or both be ISO dates.'],
  ['equal bounds', withField({ type: 'estimate', min: 10, max: 10 }), 'invalid_field', 'fields.f.min', 'fields.f.min must be less than fields.f.max.'],
  ['reversed dates', withField({ type: 'estimate', min: '2026-12-01', max: '2026-11-01' }), 'invalid_field', 'fields.f.min'],
  ['reversed forecast bounds', withField({ type: 'forecast', min: 500, max: 0 }), 'invalid_field', 'fields.f.min'],
  ['step 0', withField({ type: 'estimate', min: 0, max: 9, step: 0 }), 'invalid_field', 'fields.f.step', 'fields.f.step must be a positive number, or "month" or "year" for a date estimate.'],
  ["step 'week'", withField({ type: 'estimate', min: '2026-11-01', max: '2026-12-31', step: 'week' }), 'invalid_field', 'fields.f.step'],
  ['month step on a numeric estimate', withField({ type: 'estimate', min: 0, max: 9, step: 'month' }), 'invalid_field', 'fields.f.step'],
  ['bad scale', withField({ type: 'estimate', min: 1, max: 9, scale: 'exp' }), 'invalid_field', 'fields.f.scale', 'fields.f.scale must be "linear" or "log".'],
  ['null_threshold 0', withField({ type: 'text', null_threshold: 0 }), 'invalid_field', 'fields.f.null_threshold', 'fields.f.null_threshold must be a number greater than 0 and at most 1.'],
  ['null_threshold 1.5', withField({ type: 'text', null_threshold: 1.5 }), 'invalid_field', 'fields.f.null_threshold'],
  ["null_threshold '0.5'", withField({ type: 'text', null_threshold: '0.5' }), 'invalid_field', 'fields.f.null_threshold'],
  ['horizon 0', withField({ type: 'forecast', min: 0, max: 9, horizon: 0 }), 'invalid_field', 'fields.f.horizon', 'fields.f.horizon must be an integer from 1 to 64.'],
  ['horizon 65', withField({ type: 'forecast', min: 0, max: 9, horizon: 65 }), 'invalid_field', 'fields.f.horizon'],
  ['horizon 2.5', withField({ type: 'forecast', min: 0, max: 9, horizon: 2.5 }), 'invalid_field', 'fields.f.horizon'],
  ['bad interval', withField({ type: 'forecast', min: 0, max: 9, interval: 'fortnight' }), 'invalid_field', 'fields.f.interval', 'fields.f.interval must be one of step, minute, hour, day, week, month, quarter, year.'],
  // reference_date and options.
  ['non-ISO reference date', { ...BASE, reference_date: '20-10-2026' }, 'invalid_reference_date', 'reference_date', 'reference_date must be an ISO date (YYYY-MM-DD).'],
  ['impossible reference date', { ...BASE, reference_date: '2026-02-29' }, 'invalid_reference_date', 'reference_date'],
  ['numeric reference date', { ...BASE, reference_date: 20261020 }, 'invalid_reference_date', 'reference_date'],
  ['array options', { ...BASE, options: [] }, 'invalid_options', 'options', 'options may only contain boolean include_quantiles and return_state_text.'],
  ['string options', { ...BASE, options: 'yes' }, 'invalid_options', 'options'],
  ['unknown option', { ...BASE, options: { verbose: true } }, 'invalid_options', 'options.verbose'],
  ['non-boolean option', { ...BASE, options: { return_state_text: 'true' } }, 'invalid_options', 'options.return_state_text'],
  // Assets (delegated to parseCloudflareImageAssets), the empty-state rule and the caps.
  ['five assets', { ...BASE, assets: { a: png(), b: png(), c: png(), d: png(), e: png() } }, 'too_many_assets', 'assets', 'assets must not contain more than 4 entries for this model.'],
  ['empty assets', { ...BASE, assets: {} }, 'invalid_assets', 'assets'],
  ['gif asset', { ...BASE, assets: { k: { type: 'image', format: 'gif', data_base64: PNG_B64 } } }, 'unsupported_asset_format', 'assets.k.format', 'assets.k.format must be "png", "jpg", "jpeg" or "webp".'],
  ['webp with PNG bytes', { ...BASE, assets: { k: { type: 'image', format: 'webp', data_base64: PNG_B64 } } }, 'asset_format_mismatch', 'assets.k.data_base64', 'assets.k.data_base64 is not a WebP image.'],
  ['empty state, no assets', { state: '', fields: BASE.fields }, 'missing_state', 'state', 'Missing required parameter: state (it may be empty only when assets are sent).'],
  ['missing state, no assets', { fields: BASE.fields }, 'missing_state', 'state'],
  ['null state, no assets', { state: null, fields: BASE.fields }, 'missing_state', 'state'],
  ['state over 200000', { ...BASE, state: 'x'.repeat(200_001) }, 'state_too_large', 'state', 'state must not exceed 200000 characters.'],
  ['options before the empty-state rule', { state: '', fields: BASE.fields, options: { x: true } }, 'invalid_options', 'options.x'],
  ['reference_date before the 200k cap', { ...BASE, state: 'x'.repeat(200_001), reference_date: 'tomorrow' }, 'invalid_reference_date', 'reference_date'],
  ['assets before the empty-state rule', { state: '', fields: BASE.fields, assets: { k: { type: 'video' } } }, 'invalid_asset', 'assets.k'],
  ['bad asset key', { ...BASE, assets: { 'bad key': png() } }, 'invalid_asset_key', 'assets.bad key'],
  ['non-base64 asset data', { ...BASE, assets: { k: png('not base64!') } }, 'invalid_asset_data', 'assets.k.data_base64'],
  ['one image over 4 MiB', { ...BASE, assets: { k: png(PNG_4MIB_PLUS) } }, 'asset_too_large', 'assets.k', 'assets.k must not exceed 4 MiB once decoded.'],
  ['images over 8 MiB in total', { ...BASE, assets: { a: png(PNG_3MIB), b: png(PNG_3MIB), c: png(PNG_3MIB) } }, 'assets_too_large', 'assets', 'assets must not exceed 8 MiB in total once decoded.'],
  // Further strictness checks beyond the spec table.
  ['datetime reference date', { ...BASE, reference_date: '2026-10-20T00:00:00Z' }, 'invalid_reference_date', 'reference_date'],
  ['padded reference date', { ...BASE, reference_date: ' 2026-10-20' }, 'invalid_reference_date', 'reference_date'],
  ['negative step', withField({ type: 'estimate', min: 0, max: 9, step: -1 }), 'invalid_field', 'fields.f.step'],
  ['month step on a forecast', withField({ type: 'forecast', min: 0, max: 9, step: 'month' }), 'invalid_field', 'fields.f.step'],
  ['duration unit in the wrong case', withField({ type: 'duration', unit: 'Minutes' }), 'invalid_field', 'fields.f.unit'],
  ['bad items on a non-list field', withField({ type: 'text', items: 'boolean' }), 'invalid_field', 'fields.f.items'],
  ['null bound on an estimate', withField({ type: 'estimate', min: null, max: 10 }), 'invalid_field', 'fields.f.min', 'fields.f.min must be a finite number or an ISO date (YYYY-MM-DD).'],
  ['reversed numeric bounds on a number field', withField({ type: 'number', min: 10, max: 1 }), 'invalid_field', 'fields.f.min', 'fields.f.min must be less than fields.f.max.'],
  ['__proto__ key inside a spec', withField(JSON.parse('{"type":"text","__proto__":{"x":1}}')), 'invalid_field', 'fields.f.__proto__', 'fields.f.__proto__ is not a supported field option.'],
  ['field name with a slash', { state: 'x', fields: { 'a/b': { type: 'text' } } }, 'invalid_field_name', 'fields.a/b'],
  ['non-boolean include_quantiles', { ...BASE, options: { include_quantiles: 1 } }, 'invalid_options', 'options.include_quantiles'],
];

describe('parseExtractionRequest — rejections', () => {
  it.each(REJECTIONS)('%s', (_title, body, code, param, message) => {
    const r = parseExtractionRequest(body as ExtractionRequest, CLAIRIC);
    expect(r).toMatchObject({ ok: false, status: 400, code });
    if (r.ok) return;
    expect(r.param).toBe(param);
    if (message !== undefined) expect(r.message).toBe(message);
  });

  it('fails closed for a key model that is not a registered extraction model', () => {
    for (const model of ['typesafe-ai/jev', '@cf/cloudflare/clef', '@cf/cloudflare/clairic-2']) {
      const r = parseExtractionRequest(BASE as ExtractionRequest, model);
      expect(r, model).toMatchObject({
        ok: false,
        status: 400,
        code: 'model_not_extraction',
        message: "This key's model is not an extraction model.",
      });
      if (!r.ok) expect(r.param).toBeUndefined();
    }
  });

  it('rejects a request estimated above the context window before any round trip', () => {
    const state = 'x'.repeat(200_000);
    const fields = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`f${i}`, { type: 'text', instructions: 'y'.repeat(1_000) }]),
    );
    const n = Math.ceil(JSON.stringify({ model: 'clairic', state, fields }).length / 4);
    expect(n).toBe(66_648);
    expect(n).toBeGreaterThan(65_536);
    const r = parseExtractionRequest({ state, fields } as ExtractionRequest, CLAIRIC);
    expect(r).toMatchObject({
      ok: false,
      status: 400,
      code: 'state_too_large',
      param: 'state',
      message: `state is too large for Clairic: the request is estimated at ${n} tokens and the model accepts at most 65536.`,
    });
  });

  // The two limits /docs, the README and the migration guide state for `state`.
  it('counts the 200,000-character cap in UTF-16 code units, so an emoji counts twice', () => {
    const atCap = 'x'.repeat(199_998) + '😀'; // 199,999 code points, 200,000 UTF-16 units
    expect(parseExtractionRequest({ ...BASE, state: atCap } as ExtractionRequest, CLAIRIC).ok).toBe(true);
    const overCap = 'x'.repeat(199_999) + '😀'; // 200,000 code points, 200,001 UTF-16 units
    expect(parseExtractionRequest({ ...BASE, state: overCap } as ExtractionRequest, CLAIRIC)).toMatchObject({
      ok: false,
      code: 'state_too_large',
      message: 'state must not exceed 200000 characters.',
    });
  });

  it('can reject an escape-heavy state under 200,000 characters at the context pre-cap', () => {
    // JSON escaping writes each newline as two characters, so 199,998 characters of a
    // newline-dense series estimate above Clairic's 65,536-token window (about 262,000 JSON characters).
    const state = '12\n'.repeat(66_666);
    expect(state.length).toBeLessThan(200_000);
    const r = parseExtractionRequest({ ...BASE, state } as ExtractionRequest, CLAIRIC);
    expect(r).toMatchObject({ ok: false, code: 'state_too_large', param: 'state' });
    if (!r.ok) expect(r.message).toMatch(/^state is too large for Clairic: the request is estimated at \d+ tokens and the model accepts at most 65536\.$/);
  });

  it('estimates the pre-cap over the exact upstream body, images excluded', () => {
    const v = ok({ ...INVOICE_REQUEST, options: { include_quantiles: true }, assets: { r: png() } });
    const upstream = toClairicRequest(v, ENTRY);
    const withoutImages = toClairicRequest({ ...v, assets: undefined }, ENTRY);
    expect(withoutImages).toEqual(Object.fromEntries(Object.entries(upstream).filter(([k]) => k !== 'images')));
    expect(cloudflareInputTokenEstimate(withoutImages)).toBeLessThan(ENTRY.contextWindow);
  });
});

describe('toClairicRequest', () => {
  it('sends only the selector, state and fields when nothing else was given', () => {
    expect(toClairicRequest(ok(BASE), ENTRY)).toStrictEqual({
      model: 'clairic',
      state: BASE.state,
      fields: BASE.fields,
    });
  });

  it('adds reference_date and non-empty options in snake_case', () => {
    const body = toClairicRequest(
      ok({ ...BASE, reference_date: '2026-10-20', options: { return_state_text: true } }),
      ENTRY,
    );
    expect(body).toMatchObject({ reference_date: '2026-10-20', options: { return_state_text: true } });
    expect(body).not.toHaveProperty('referenceDate');
  });

  it('omits empty options', () => {
    expect(toClairicRequest(ok({ ...BASE, options: {} }), ENTRY)).not.toHaveProperty('options');
  });

  it('maps assets to images[] in key order and never sends assets or providerOptions', () => {
    const body = toClairicRequest(
      ok({
        state: 'Read the receipt.',
        fields: BASE.fields,
        assets: { b: png(), a: { type: 'image', format: 'jpg', data_base64: JPEG_B64 } },
      }),
      ENTRY,
    );
    expect(body.images).toEqual([
      { content_type: 'image/png', base64: PNG_B64 },
      { content_type: 'image/jpeg', base64: JPEG_B64 },
    ]);
    expect(body).not.toHaveProperty('assets');
    expect(body).not.toHaveProperty('providerOptions');
  });

  it('sends the live invoice request exactly as Cloudflare received it', () => {
    expect(toClairicRequest(ok(INVOICE_REQUEST), ENTRY)).toStrictEqual({
      model: 'clairic',
      state: INVOICE_STATE,
      fields: INVOICE_FIELDS,
      reference_date: '2026-10-20',
    });
  });

  it('sends the live spans request, with both options, exactly as Cloudflare received it', () => {
    const body = toClairicRequest(ok(SPANS_REQUEST), ENTRY);
    expect(body).toStrictEqual(SPANS_REQUEST);
    expect(JSON.stringify(body)).toBe(JSON.stringify(SPANS_REQUEST)); // same key order, too
  });
});

describe('toExtractionResponse — passthrough', () => {
  const asked = Object.keys(INVOICE_FIELDS);

  it('passes the live invoice answers through unmodified and reports the key model', () => {
    expect(toExtractionResponse(INVOICE_RESULT, CLAIRIC, asked, false)).toStrictEqual({
      model: CLAIRIC,
      answers: INVOICE_RESULT.answers,
      truncated: false,
      usage: { inputTokens: 715, outputTokens: 0, totalTokens: 715 },
    });
  });

  it('keeps a null value together with its guess and span', () => {
    const r = toExtractionResponse(INVOICE_RESULT, CLAIRIC, asked, false);
    expect(r!.answers.po_number).toEqual({
      type: 'text',
      p_null: 0.9999994039535522,
      span: [8, 16],
      guess: 'INV-7731',
      confidence: 0.999321699142456,
      value: null,
    });
  });

  it('keeps list confidences and forecast arrays with their steps', () => {
    const r = toExtractionResponse(TYPES_RESULT, CLAIRIC, Object.keys(TYPES_REQUEST.fields!), false);
    expect(r!.answers).toStrictEqual(TYPES_RESULT.answers);
    expect(r!.answers.order_ids.confidences).toHaveLength(3);
    expect(r!.answers.next_days.steps).toHaveLength(2);
    expect(r!.usage.totalTokens).toBe(881);
  });

  it('returns state_text only when it was requested and sent', () => {
    const withText = { ...INVOICE_RESULT, state_text: 'S' };
    expect(toExtractionResponse(withText, CLAIRIC, asked, true)!.state_text).toBe('S');
    expect(toExtractionResponse(withText, CLAIRIC, asked, false)).not.toHaveProperty('state_text');
    expect(toExtractionResponse(INVOICE_RESULT, CLAIRIC, asked, true)).not.toHaveProperty('state_text');
    expect(toExtractionResponse({ ...INVOICE_RESULT, state_text: 5 }, CLAIRIC, asked, true)).not.toHaveProperty(
      'state_text',
    );
  });

  it('drops answers nobody asked for', () => {
    const r = toExtractionResponse(INVOICE_RESULT, CLAIRIC, ['total'], false);
    expect(Object.keys(r!.answers)).toEqual(['total']);
  });

  it('is unusable when an asked answer is missing or not an object', () => {
    const withoutTotal = Object.fromEntries(Object.entries(INVOICE_RESULT.answers).filter(([k]) => k !== 'total'));
    for (const result of [
      { ...INVOICE_RESULT, answers: withoutTotal },
      { ...INVOICE_RESULT, answers: { ...INVOICE_RESULT.answers, total: 5 } },
      { ...INVOICE_RESULT, answers: { ...INVOICE_RESULT.answers, total: null } },
      { ...INVOICE_RESULT, answers: { ...INVOICE_RESULT.answers, total: [1] } },
      { ...INVOICE_RESULT, answers: [] },
      { model: 'clairic', truncated: false, usage: INVOICE_RESULT.usage },
    ]) {
      expect(toExtractionResponse(result, CLAIRIC, asked, false)).toBeNull();
    }
  });

  it('reads truncated strictly and zeroes non-finite or absent usage', () => {
    expect(toExtractionResponse({ ...INVOICE_RESULT, truncated: 'yes' }, CLAIRIC, asked, false)!.truncated).toBe(false);
    expect(toExtractionResponse({ ...INVOICE_RESULT, truncated: true }, CLAIRIC, asked, false)!.truncated).toBe(true);
    const zero = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    expect(
      toExtractionResponse({ ...INVOICE_RESULT, usage: { input_tokens: 'x', output_tokens: Infinity } }, CLAIRIC, asked, false)!
        .usage,
    ).toEqual(zero);
    expect(toExtractionResponse({ answers: INVOICE_RESULT.answers }, CLAIRIC, asked, false)!.usage).toEqual(zero);
  });

  it('never reads Object.prototype for a missing __proto__ answer, and keeps a present one', () => {
    expect(
      toExtractionResponse({ answers: JSON.parse('{"a":{"type":"text","value":"x"}}') }, CLAIRIC, ['__proto__'], false),
    ).toBeNull();
    const r = toExtractionResponse(
      { answers: JSON.parse('{"__proto__":{"type":"text","value":"x"}}') },
      CLAIRIC,
      ['__proto__'],
      false,
    );
    expect(Object.keys(r!.answers)).toEqual(['__proto__']);
    expect(JSON.stringify(r)).toContain('"__proto__":{"type":"text","value":"x"}');
  });

  it('exposes only camelCase token counts, not Clairic usage internals', () => {
    const r = toExtractionResponse(INVOICE_RESULT, CLAIRIC, asked, false);
    expect(Object.keys(r!.usage)).toEqual(['inputTokens', 'outputTokens', 'totalTokens']);
  });

  it('passes code-point spans, quantiles and the requested state_text through untouched', () => {
    const r = toExtractionResponse(SPANS_RESULT, CLAIRIC, ['invoice_number', 'days_to_pay'], true);
    expect(r).toStrictEqual({
      model: CLAIRIC,
      answers: SPANS_RESULT.answers,
      truncated: false,
      state_text: SPANS_STATE,
      usage: { inputTokens: 739, outputTokens: 0, totalTokens: 739 },
    });
    expect(r!.answers.days_to_pay.quantiles).toHaveLength(99);
    // Spans count Unicode code points, end-exclusive; Sophy never converts them to UTF-16.
    const [start, end] = r!.answers.invoice_number.span as [number, number];
    expect(Array.from(r!.state_text!).slice(start, end).join('')).toBe('INV-7731');
    expect(r!.state_text!.slice(start, end)).not.toBe('INV-7731');
  });
});

import { describe, it, expect } from 'vitest';
import {
  unwrapResponseFormat,
  toStrictSchema,
  normalizeOutputSchema,
} from '@/lib/gateway/schema-normalize';
import { validateAgainstSchema } from '@/lib/gateway/openai-map';

/** Assert every object node requires all its properties and forbids extras. */
function assertStrict(node: unknown, path = 'root'): void {
  if (Array.isArray(node)) {
    node.forEach((n, i) => assertStrict(n, `${path}[${i}]`));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as Record<string, unknown>;
  if (obj.properties && typeof obj.properties === 'object') {
    const props = Object.keys(obj.properties as object);
    const required = (obj.required as string[]) ?? [];
    expect(new Set(required), `${path} required`).toEqual(new Set(props));
    expect(obj.additionalProperties, `${path} additionalProperties`).toBe(false);
  }
  for (const v of Object.values(obj)) assertStrict(v, path);
}

describe('unwrapResponseFormat', () => {
  it('unwraps the OpenAI { name, schema, strict } envelope', () => {
    const inner = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(unwrapResponseFormat({ name: 'x', schema: inner, strict: true })).toEqual(inner);
  });

  it('unwraps a nested { json_schema: { schema } } form', () => {
    const inner = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
    expect(unwrapResponseFormat({ type: 'json_schema', json_schema: { name: 'y', schema: inner } })).toEqual(
      inner,
    );
  });

  it('leaves a bare schema untouched', () => {
    const bare = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    expect(unwrapResponseFormat(bare)).toEqual(bare);
  });

  it('does NOT unwrap a real schema with a property coincidentally named "schema"', () => {
    const real = { type: 'object', properties: { schema: { type: 'string' } }, required: ['schema'] };
    expect(unwrapResponseFormat(real)).toEqual(real);
  });
});

describe('toStrictSchema', () => {
  it('requires every property and makes optional ones nullable', () => {
    const out = toStrictSchema({
      type: 'object',
      required: ['match'],
      properties: { match: { type: 'boolean' }, reason: { type: 'string' } },
      additionalProperties: false,
    }) as Record<string, unknown>;
    expect(out.required).toEqual(['match', 'reason']);
    expect((out.properties as Record<string, unknown>).reason).toEqual({ type: ['string', 'null'] });
    expect((out.properties as Record<string, unknown>).match).toEqual({ type: 'boolean' }); // already required → untouched
  });

  it('forces additionalProperties:false and recurses into arrays and nested objects', () => {
    const out = toStrictSchema({
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id'] },
        },
      },
    });
    assertStrict(out);
  });

  it('widens an optional enum with null instead of a type union', () => {
    const out = toStrictSchema({
      type: 'object',
      required: [],
      properties: { kind: { enum: ['a', 'b'] } },
    }) as Record<string, unknown>;
    expect((out.properties as Record<string, unknown>).kind).toEqual({ enum: ['a', 'b', null] });
  });

  it('is idempotent', () => {
    const once = toStrictSchema({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    });
    expect(toStrictSchema(once)).toEqual(once);
  });
});

describe('normalizeOutputSchema — real production cases', () => {
  it('optional-field schema (Name match decision) → OpenAI-strict-valid, still validates good output', () => {
    const stored = {
      type: 'object',
      required: ['match'],
      properties: { match: { type: 'boolean' }, reason: { type: 'string', description: '≤20 words' } },
      additionalProperties: false,
    };
    const norm = normalizeOutputSchema(stored);
    assertStrict(norm);
    // A response that supplies both fields validates; the nullable lets `reason` be null.
    expect(validateAgainstSchema({ match: true, reason: 'names align' }, norm).valid).toBe(true);
    expect(validateAgainstSchema({ match: false, reason: null }, norm).valid).toBe(true);
  });

  it('wrapped { name, schema, strict } (Skills recommender) → unwrapped and actually enforced', () => {
    const stored = {
      name: 'recommended_skills',
      strict: true,
      schema: {
        type: 'object',
        required: ['skills'],
        properties: { skills: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    };
    const norm = normalizeOutputSchema(stored);
    // Envelope is gone — the schema is the inner object, so validation is real again.
    expect((norm as Record<string, unknown>).type).toBe('object');
    expect(validateAgainstSchema({ skills: ['a', 'b'] }, norm).valid).toBe(true);
    expect(validateAgainstSchema({ skills: 'not-an-array' }, norm).valid).toBe(false);
    // Before the fix the wrapper validated anything: prove that would have been the case.
    expect(validateAgainstSchema({ anything: 1 }, stored as Record<string, unknown>).valid).toBe(true);
  });

  it('returns a non-object value unchanged (defensive)', () => {
    expect(normalizeOutputSchema(null as unknown)).toBeNull();
  });
});

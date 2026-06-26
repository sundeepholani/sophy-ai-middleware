import { describe, it, expect } from 'vitest';
import { extractJsonObject, coerceToSchema } from '@/lib/gateway/structured';

describe('extractJsonObject', () => {
  it('parses raw JSON', () => {
    expect(extractJsonObject('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('strips a ```json fence', () => {
    const t = '```json\n{\n  "a": 1\n}\n```';
    expect(extractJsonObject(t)).toEqual({ a: 1 });
  });

  it('strips a bare ``` fence', () => {
    expect(extractJsonObject('```\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('extracts JSON embedded in prose', () => {
    expect(extractJsonObject('Here is the result:\n{"a": 3}\nHope that helps!')).toEqual({ a: 3 });
  });

  it('takes the first balanced object and ignores a brace inside a string', () => {
    expect(extractJsonObject('{"note":"a } brace","ok":true} trailing junk {"b":2}')).toEqual({
      note: 'a } brace',
      ok: true,
    });
  });

  it('returns undefined for truncated JSON (never closes)', () => {
    expect(extractJsonObject('{"a": 1, "b": "unterminat')).toBeUndefined();
  });

  it('returns undefined for plain prose / no JSON', () => {
    expect(extractJsonObject('**Feedback:** this is just prose, no json here.')).toBeUndefined();
    expect(extractJsonObject('   ')).toBeUndefined();
  });
});

describe('coerceToSchema', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { sentiment: { type: 'string' }, score: { type: 'number' } },
    required: ['sentiment', 'score'],
  };

  it('accepts fenced JSON that satisfies the schema', () => {
    const r = coerceToSchema('```json\n{"sentiment":"positive","score":0.9}\n```', schema);
    expect(r.valid).toBe(true);
    expect(r.value).toEqual({ sentiment: 'positive', score: 0.9 });
  });

  it('rejects JSON that is valid but does not match the schema', () => {
    const r = coerceToSchema('{"sentiment":"positive"}', schema); // missing `score`
    expect(r.valid).toBe(false);
  });

  it('rejects unparseable output', () => {
    const r = coerceToSchema('I think it is positive.', schema);
    expect(r.valid).toBe(false);
    expect(r.value).toBeUndefined();
  });
});

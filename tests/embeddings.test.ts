import { describe, it, expect } from 'vitest';
import {
  parseEmbeddingsRequest,
  toEmbeddingsResponse,
  toBase64Embedding,
  modelSupportsEmbeddings,
} from '@/lib/gateway/embeddings';
import type { AvailableModel } from '@/lib/gateway/capabilities';

/** Decode the OpenAI base64 wire encoding. Node Buffers are views into a shared
 * pool, so the Float32Array must honor byteOffset/byteLength — reading `.buffer`
 * from offset 0 would decode pool garbage. */
function decodeB64(b64: string): number[] {
  const buf = Buffer.from(b64, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

const MODEL = 'openai/text-embedding-3-small';
const KEY = 'key_123';

function model(partial: Partial<AvailableModel>): AvailableModel {
  return {
    id: 'x',
    name: 'x',
    provider: 'x',
    type: 'language',
    contextWindow: null,
    maxTokens: null,
    inputPerMTok: null,
    outputPerMTok: null,
    description: null,
    tags: [],
    ...partial,
  };
}

describe('parseEmbeddingsRequest', () => {
  it('rejects a missing or empty input', () => {
    expect(parseEmbeddingsRequest({}, MODEL, KEY)).toMatchObject({ ok: false, param: 'input' });
    expect(parseEmbeddingsRequest({ input: '' }, MODEL, KEY)).toMatchObject({ ok: false, param: 'input' });
    expect(parseEmbeddingsRequest({ input: [] }, MODEL, KEY)).toMatchObject({ ok: false, param: 'input' });
  });

  it('normalizes a single string to a 1-element array and attaches gateway attribution', () => {
    const r = parseEmbeddingsRequest({ input: 'hello' }, MODEL, KEY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.values).toEqual(['hello']);
    expect(r.value.encodingFormat).toBe('float');
    expect(r.value.providerOptions.gateway).toMatchObject({ user: KEY });
    // No knobs set → no provider-specific options bucket.
    expect(r.value.providerOptions.openai).toBeUndefined();
  });

  it('accepts an array of strings in order', () => {
    const r = parseEmbeddingsRequest({ input: ['a', 'b', 'c'] }, MODEL, KEY);
    expect(r.ok && r.value.values).toEqual(['a', 'b', 'c']);
  });

  it('rejects token-array inputs with a distinct code', () => {
    expect(parseEmbeddingsRequest({ input: [1, 2, 3] }, MODEL, KEY)).toMatchObject({
      ok: false,
      code: 'token_input_unsupported',
    });
    expect(parseEmbeddingsRequest({ input: [[1, 2], [3]] }, MODEL, KEY)).toMatchObject({
      ok: false,
      code: 'token_input_unsupported',
    });
  });

  it('rejects arrays containing empty strings', () => {
    expect(parseEmbeddingsRequest({ input: ['a', ''] }, MODEL, KEY)).toMatchObject({
      ok: false,
      param: 'input',
    });
  });

  it('rejects oversized batches', () => {
    const big = Array.from({ length: 2049 }, () => 'x');
    expect(parseEmbeddingsRequest({ input: big }, MODEL, KEY)).toMatchObject({ ok: false, param: 'input' });
  });

  it('validates encoding_format', () => {
    expect(parseEmbeddingsRequest({ input: 'x', encoding_format: 'float' }, MODEL, KEY)).toMatchObject({
      ok: true,
    });
    const b64 = parseEmbeddingsRequest({ input: 'x', encoding_format: 'base64' }, MODEL, KEY);
    expect(b64.ok && b64.value.encodingFormat).toBe('base64');
    expect(
      parseEmbeddingsRequest({ input: 'x', encoding_format: 'hex' as never }, MODEL, KEY),
    ).toMatchObject({ ok: false, code: 'unsupported_encoding_format' });
  });

  it('forwards dimensions to the provider bucket only when set and valid', () => {
    const r = parseEmbeddingsRequest({ input: 'x', dimensions: 256 }, MODEL, KEY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.providerOptions.openai).toMatchObject({ dimensions: 256 });
    expect(parseEmbeddingsRequest({ input: 'x', dimensions: 0 }, MODEL, KEY)).toMatchObject({
      ok: false,
      param: 'dimensions',
    });
    expect(parseEmbeddingsRequest({ input: 'x', dimensions: 1.5 }, MODEL, KEY)).toMatchObject({
      ok: false,
      param: 'dimensions',
    });
  });

  it('ignores the client model field entirely (key owns the model)', () => {
    const r = parseEmbeddingsRequest({ model: 'text-embedding-3-small', input: 'x' }, MODEL, KEY);
    expect(r.ok).toBe(true);
  });
});

describe('toBase64Embedding', () => {
  it('round-trips through little-endian float32 (the OpenAI wire encoding)', () => {
    const vec = [0.1, -0.25, 1.5, 0];
    const decoded = decodeB64(toBase64Embedding(vec));
    // float32 precision, not float64 — compare approximately.
    decoded.forEach((v, i) => expect(v).toBeCloseTo(vec[i], 6));
    expect(decoded).toHaveLength(vec.length);
  });
});

describe('toEmbeddingsResponse', () => {
  const vecs = [
    [0.5, -0.5],
    [1, 2],
  ];

  it('maps float embeddings with stable indexes and usage', () => {
    const r = toEmbeddingsResponse(vecs, MODEL, 'float', 7);
    expect(r.object).toBe('list');
    expect(r.model).toBe(MODEL);
    expect(r.usage).toEqual({ prompt_tokens: 7, total_tokens: 7 });
    expect(r.data.map((d) => d.index)).toEqual([0, 1]);
    expect(r.data[0].embedding).toEqual([0.5, -0.5]);
    expect(r.data.every((d) => d.object === 'embedding')).toBe(true);
  });

  it('encodes base64 embeddings when requested', () => {
    const r = toEmbeddingsResponse(vecs, MODEL, 'base64', 7);
    expect(typeof r.data[0].embedding).toBe('string');
    const decoded = decodeB64(r.data[0].embedding as string);
    expect(decoded[0]).toBeCloseTo(0.5, 6);
    expect(decoded[1]).toBeCloseTo(-0.5, 6);
  });
});

describe('modelSupportsEmbeddings', () => {
  it('accepts embedding-typed models only', () => {
    expect(modelSupportsEmbeddings(model({ type: 'embedding' }))).toBe(true);
    expect(modelSupportsEmbeddings(model({ type: 'language' }))).toBe(false);
    expect(modelSupportsEmbeddings(model({ type: 'image' }))).toBe(false);
  });
});

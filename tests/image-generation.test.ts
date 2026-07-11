import { describe, it, expect } from 'vitest';
import {
  parseImageRequest,
  toImageResponse,
  modelSupportsImageGeneration,
} from '@/lib/gateway/images';
import type { AvailableModel } from '@/lib/gateway/capabilities';

const MODEL = 'openai/gpt-image-1';

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

describe('parseImageRequest', () => {
  it('rejects a missing or blank prompt', () => {
    expect(parseImageRequest({}, MODEL)).toMatchObject({ ok: false, param: 'prompt' });
    expect(parseImageRequest({ prompt: '   ' }, MODEL)).toMatchObject({ ok: false, param: 'prompt' });
  });

  it('accepts a valid prompt without gateway metadata', () => {
    const r = parseImageRequest({ prompt: 'a cat' }, MODEL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.prompt).toBe('a cat');
    expect(r.value.providerOptions.gateway).toBeUndefined();
    // No knobs set → no provider-specific options bucket.
    expect(r.value.providerOptions[MODEL.split('/')[0]]).toBeUndefined();
  });

  it('rejects response_format other than b64_json', () => {
    expect(parseImageRequest({ prompt: 'x', response_format: 'url' }, MODEL)).toMatchObject({
      ok: false,
      code: 'unsupported_response_format',
      param: 'response_format',
    });
    expect(parseImageRequest({ prompt: 'x', response_format: 'b64_json' }, MODEL)).toMatchObject({
      ok: true,
    });
  });

  it('validates n bounds', () => {
    expect(parseImageRequest({ prompt: 'x', n: 0 }, MODEL)).toMatchObject({ ok: false, param: 'n' });
    expect(parseImageRequest({ prompt: 'x', n: 11 }, MODEL)).toMatchObject({ ok: false, param: 'n' });
    expect(parseImageRequest({ prompt: 'x', n: 1.5 }, MODEL)).toMatchObject({ ok: false, param: 'n' });
    const ok = parseImageRequest({ prompt: 'x', n: 3 }, MODEL);
    expect(ok.ok && ok.value.n).toBe(3);
  });

  it('validates size format', () => {
    expect(parseImageRequest({ prompt: 'x', size: 'huge' }, MODEL)).toMatchObject({ ok: false, param: 'size' });
    const ok = parseImageRequest({ prompt: 'x', size: '1024x1024' }, MODEL);
    expect(ok.ok && ok.value.size).toBe('1024x1024');
  });

  it('forwards provider knobs under the provider namespace', () => {
    const r = parseImageRequest({ prompt: 'x', quality: 'high', style: 'vivid' }, MODEL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.providerOptions.openai).toEqual({ quality: 'high', style: 'vivid' });
  });
});

describe('toImageResponse', () => {
  it('maps base64 images to the OpenAI b64_json shape', () => {
    const out = toImageResponse([{ base64: 'AAA' }, { base64: 'BBB' }], 1735689600);
    expect(out).toEqual({
      created: 1735689600,
      data: [{ b64_json: 'AAA' }, { b64_json: 'BBB' }],
    });
  });
});

describe('modelSupportsImageGeneration', () => {
  it('is true for image-type models or models tagged image-generation', () => {
    expect(modelSupportsImageGeneration(model({ type: 'image' }))).toBe(true);
    expect(modelSupportsImageGeneration(model({ type: 'language', tags: ['image-generation'] }))).toBe(true);
  });

  it('is false for a plain language model', () => {
    expect(modelSupportsImageGeneration(model({ type: 'language', tags: ['tool-use'] }))).toBe(false);
  });
});

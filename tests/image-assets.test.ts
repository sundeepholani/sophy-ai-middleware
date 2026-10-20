import { describe, expect, it } from 'vitest';
import {
  decodedBase64Bytes,
  isStrictBase64,
  parseCloudflareImageAssets,
  STRICT_BASE64,
  summarizeAssets,
  toCloudflareImages,
} from '@/lib/gateway/image-assets';
import type { AssessmentAsset } from '@/lib/http/openai';

/**
 * The Clef and Clairic image rules (D8, D9): every failure is pinned by code,
 * param and exact message, in the order the parser checks them.
 */

const MiB = 1024 * 1024;
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(8)]).toString('base64');
const JPG = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.alloc(8)]).toString('base64');
const WEBP = Buffer.from('RIFF\x24\x00\x00\x00WEBPVP8 ', 'latin1').toString('base64');
const WAVE = Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1').toString('base64');

/** An n-byte payload with a PNG signature, base64-encoded. */
function big(n: number): string {
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(n - 8)]).toString('base64');
}

/** `format` stays a plain string: the fixtures also need formats the wire type does not admit. */
function img(data: string, format = 'png'): AssessmentAsset {
  return { type: 'image', format, data_base64: data } as AssessmentAsset;
}

function failure(code: string, param: string, message: string) {
  return { ok: false, status: 400, code, param, message };
}

describe('parseCloudflareImageAssets', () => {
  it('requires a non-empty object', () => {
    for (const raw of [[], 'x', null]) {
      expect(parseCloudflareImageAssets(raw)).toEqual(
        failure('invalid_assets', 'assets', 'assets must be an object.'),
      );
    }
    expect(parseCloudflareImageAssets({})).toEqual(
      failure('invalid_assets', 'assets', 'assets must contain at least one entry.'),
    );
  });

  it('allows at most 4 images', () => {
    const four = { a: img(PNG), b: img(PNG), c: img(PNG), d: img(PNG) };
    expect(parseCloudflareImageAssets(four)).toEqual({ ok: true, value: four });
    expect(parseCloudflareImageAssets({ ...four, e: img(PNG) })).toEqual(
      failure('too_many_assets', 'assets', 'assets must not contain more than 4 entries for this model.'),
    );
  });

  it('validates keys and asset types', () => {
    const keyMessage = 'Asset keys must be 1-64 characters of letters, digits, "_" or "-".';
    expect(parseCloudflareImageAssets({ 'bad key': img(PNG) })).toEqual(
      failure('invalid_asset_key', 'assets.bad key', keyMessage),
    );
    expect(parseCloudflareImageAssets({ ['k'.repeat(65)]: img(PNG) })).toMatchObject({
      code: 'invalid_asset_key',
    });
    expect(parseCloudflareImageAssets({ a: { type: 'audio' } })).toEqual(
      failure('invalid_asset', 'assets.a', 'assets.a must be an object with type "image".'),
    );
    expect(parseCloudflareImageAssets({ a: PNG })).toMatchObject({ code: 'invalid_asset' });
  });

  it('accepts png, jpg, jpeg and webp in any case', () => {
    expect(
      parseCloudflareImageAssets({
        a: img(PNG, 'PNG'),
        b: img(JPG, 'jpg'),
        c: img(JPG, 'JPEG'),
        d: img(WEBP, 'WebP'),
      }),
    ).toEqual({
      ok: true,
      value: { a: img(PNG, 'png'), b: img(JPG, 'jpg'), c: img(JPG, 'jpeg'), d: img(WEBP, 'webp') },
    });
    const formatMessage = 'assets.a.format must be "png", "jpg", "jpeg" or "webp".';
    expect(parseCloudflareImageAssets({ a: img(PNG, 'gif') })).toEqual(
      failure('unsupported_asset_format', 'assets.a.format', formatMessage),
    );
    expect(parseCloudflareImageAssets({ a: { type: 'image', format: 1, data_base64: PNG } })).toEqual(
      failure('unsupported_asset_format', 'assets.a.format', formatMessage),
    );
  });

  it('requires strict base64', () => {
    for (const data of ['data:image/png;base64,' + PNG, 'abc', '', PNG + '\n']) {
      expect(parseCloudflareImageAssets({ a: img(data) }), JSON.stringify(data)).toEqual(
        failure(
          'invalid_asset_data',
          'assets.a.data_base64',
          'assets.a.data_base64 must be standard padded base64 with no "data:" prefix or whitespace.',
        ),
      );
    }
  });

  it('checks magic bytes, including RIFF…WEBP', () => {
    const mismatch = (label: string) =>
      failure('asset_format_mismatch', 'assets.a.data_base64', `assets.a.data_base64 is not a ${label} image.`);
    expect(parseCloudflareImageAssets({ a: img(PNG, 'jpg') })).toEqual(mismatch('JPEG'));
    expect(parseCloudflareImageAssets({ a: img(WAVE, 'webp') })).toEqual(mismatch('WebP'));
    expect(parseCloudflareImageAssets({ a: img('UklGRg==', 'webp') })).toEqual(mismatch('WebP'));
    expect(parseCloudflareImageAssets({ a: img(JPG, 'png') })).toEqual(mismatch('PNG'));
  });

  it('caps each image at 4 MiB decoded', () => {
    const max = big(4 * MiB);
    expect(max).toHaveLength(5_592_408);
    expect(parseCloudflareImageAssets({ a: img(max) })).toEqual({ ok: true, value: { a: img(max) } });
    expect(parseCloudflareImageAssets({ a: img(big(4 * MiB + 1)) })).toEqual(
      failure('asset_too_large', 'assets.a', 'assets.a must not exceed 4 MiB once decoded.'),
    );
  });

  it('keeps a __proto__ asset key', () => {
    const result = parseCloudflareImageAssets(
      JSON.parse(`{"__proto__":{"type":"image","format":"png","data_base64":"${PNG}"}}`),
    );
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(Object.keys(result.value)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(toCloudflareImages(result.value)).toEqual([{ content_type: 'image/png', base64: PNG }]);
  });

  it('caps the total at 8 MiB decoded', () => {
    const four = big(4 * MiB);
    expect(parseCloudflareImageAssets({ a: img(four), b: img(four) })).toMatchObject({ ok: true });
    const three = big(3 * MiB);
    expect(parseCloudflareImageAssets({ a: img(three), b: img(three), c: img(three) })).toEqual(
      failure('assets_too_large', 'assets', 'assets must not exceed 8 MiB in total once decoded.'),
    );
  });

  it('reports the first failure in key order', () => {
    expect(parseCloudflareImageAssets({ ok: img(PNG), bad: img(PNG, 'gif') })).toMatchObject({
      ok: false,
      param: 'assets.bad.format',
    });
    expect(
      parseCloudflareImageAssets({
        a: img(PNG),
        'bad key': img(PNG),
        b: img(PNG),
        c: img(PNG),
        d: img(PNG),
      }),
    ).toMatchObject({ ok: false, code: 'too_many_assets' });
  });

  it('has no must-be-referenced rule', () => {
    expect(parseCloudflareImageAssets({ unreferenced: img(PNG) })).toEqual({
      ok: true,
      value: { unreferenced: img(PNG) },
    });
  });
});

describe('strict base64', () => {
  it('isStrictBase64 matches STRICT_BASE64 and is stack-safe', () => {
    for (const s of ['', 'AA==', 'AAA=', 'AAAA', 'A===', '====', 'AA=A', 'AB-_', 'AAAAA', 'AAAAAA==', 'QUJD']) {
      expect(isStrictBase64(s), s).toBe(STRICT_BASE64.test(s));
    }
    expect(isStrictBase64('A'.repeat(5_592_408))).toBe(true);
  });
});

describe('toCloudflareImages', () => {
  it('maps to Cloudflare images in Object.keys order', () => {
    expect(
      toCloudflareImages({ b: img(PNG), '2': img(JPG, 'jpg'), a: img(WEBP, 'webp'), '1': img(PNG) }),
    ).toEqual([
      { content_type: 'image/png', base64: PNG },
      { content_type: 'image/jpeg', base64: JPG },
      { content_type: 'image/png', base64: PNG },
      { content_type: 'image/webp', base64: WEBP },
    ]);
  });

  it('throws on a format the parser never admits', () => {
    expect(() => toCloudflareImages({ a: img(PNG, 'gif') })).toThrow('Unsupported image format: gif');
    expect(() => toCloudflareImages({ a: img(PNG, 'constructor') })).toThrow(
      'Unsupported image format: constructor',
    );
  });
});

describe('asset summary', () => {
  it('keeps the summary arithmetic', () => {
    expect(decodedBase64Bytes('AAAA')).toBe(3);
    expect(decodedBase64Bytes('AAA=')).toBe(2);
    expect(decodedBase64Bytes('AA==')).toBe(1);
    expect(summarizeAssets(undefined)).toBeUndefined();
    expect(summarizeAssets({ a: img(PNG) })).toEqual({ a: { format: 'png', bytes: 16 } });
  });
});

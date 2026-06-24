import { describe, it, expect } from 'vitest';
import { extractText, isKbContentTypeAllowed } from '@/lib/kb/extract';

function buf(s: string): ArrayBuffer {
  const u8 = new TextEncoder().encode(s);
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}
function bytes(arr: number[]): ArrayBuffer {
  return new Uint8Array(arr).buffer;
}

describe('isKbContentTypeAllowed', () => {
  it('accepts the supported types, ignoring charset params and case', () => {
    expect(isKbContentTypeAllowed('text/plain')).toBe(true);
    expect(isKbContentTypeAllowed('text/markdown')).toBe(true);
    expect(isKbContentTypeAllowed('text/csv')).toBe(true);
    expect(isKbContentTypeAllowed('application/json')).toBe(true);
    expect(isKbContentTypeAllowed('application/pdf')).toBe(true);
    expect(
      isKbContentTypeAllowed(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
    expect(isKbContentTypeAllowed('TEXT/PLAIN; charset=utf-8')).toBe(true);
  });

  it('rejects unsupported types at the upload gate (images, html, octet-stream)', () => {
    // The gate is strict (allowlist), even though extractText() would happily
    // UTF-8 decode any text/* — html isn't an offered upload type.
    expect(isKbContentTypeAllowed('image/png')).toBe(false);
    expect(isKbContentTypeAllowed('text/html')).toBe(false);
    expect(isKbContentTypeAllowed('application/octet-stream')).toBe(false);
  });
});

describe('extractText', () => {
  it('decodes UTF-8 text including multibyte chars', async () => {
    // "café — déjà vu" exercises multibyte UTF-8 round-tripping.
    const s = 'café — déjà vu';
    expect(await extractText({ contentType: 'text/plain', data: buf(s) })).toBe(s);
  });

  it('decodes text with a charset parameter on the content-type', async () => {
    expect(
      await extractText({ contentType: 'text/markdown; charset=utf-8', data: buf('# title') }),
    ).toBe('# title');
  });

  it('decodes JSON as raw text', async () => {
    expect(await extractText({ contentType: 'application/json', data: buf('{"a":1}') })).toBe(
      '{"a":1}',
    );
  });

  it('strips NUL bytes (Postgres text cannot store them)', async () => {
    // bytes: 'a', NUL, 'b' — the NUL must be removed, not preserved.
    const out = await extractText({ contentType: 'text/plain', data: bytes([0x61, 0x00, 0x62]) });
    expect(out).toBe('ab');
    // no NUL (char code 0) survives — checked without a literal NUL in source.
    expect([...out].some((ch) => ch.charCodeAt(0) === 0)).toBe(false);
  });

  it('replaces other C0 control chars with a space but keeps tab/newline', async () => {
    // bytes: 'a', BEL(0x07), 'b', TAB(0x09), 'c', LF(0x0a), 'd'
    const out = await extractText({
      contentType: 'text/plain',
      data: bytes([0x61, 0x07, 0x62, 0x09, 0x63, 0x0a, 0x64]),
    });
    expect(out).toBe('a b\tc\nd');
  });

  it('throws on an unsupported content type', async () => {
    await expect(
      extractText({ contentType: 'application/octet-stream', data: buf('x') }),
    ).rejects.toThrow(/unsupported content type/i);
  });
});

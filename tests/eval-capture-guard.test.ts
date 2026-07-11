import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { hasNonTextParts } from '@/lib/eval/capture';

const msg = (role: string, content: unknown) => ({ role, content }) as unknown as ModelMessage;

describe('hasNonTextParts', () => {
  it('is false for string-content messages', () => {
    expect(hasNonTextParts([msg('user', 'hello'), msg('assistant', 'hi')])).toBe(false);
  });

  it('is false for array content made only of text parts and strings', () => {
    expect(
      hasNonTextParts([msg('user', [{ type: 'text', text: 'a' }, 'raw string part'])]),
    ).toBe(false);
  });

  it('is true when any message carries an image part', () => {
    expect(
      hasNonTextParts([
        msg('user', 'first turn'),
        msg('user', [
          { type: 'text', text: 'look:' },
          { type: 'image', image: 'data:image/png;base64,AAAA' },
        ]),
      ]),
    ).toBe(true);
  });

  it('is true for file parts', () => {
    expect(
      hasNonTextParts([msg('user', [{ type: 'file', data: 'x', mimeType: 'application/pdf' }])]),
    ).toBe(true);
  });

  it('is true for object parts without a type (unknown shapes are not text)', () => {
    expect(hasNonTextParts([msg('user', [{ foo: 'bar' }])])).toBe(true);
  });

  it('is false for an empty conversation', () => {
    expect(hasNonTextParts([])).toBe(false);
  });
});

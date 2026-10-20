import { describe, expect, it } from 'vitest';
import { fmtUsd } from '@/components/admin/models-format';
import { CLOUDFLARE_MODELS } from '@/lib/gateway/cloudflare-models';

describe('fmtUsd', () => {
  it.each([
    [null, '—'],
    [Number.NaN, '—'],
    [Number.POSITIVE_INFINITY, '—'],
    [0, '$0'],
    [3, '$3'],
    [15, '$15'],
    [0.25, '$0.25'],
    [1.5, '$1.5'],
    [0.1, '$0.1'],
    [0.24, '$0.24'],
    [0.15, '$0.15'],
    [0.038, '$0.038'],
    [0.0375, '$0.0375'],
    [0.02, '$0.02'],
    [0.038000000000000006, '$0.038'], // perMillion float noise (lib/gateway/models.ts)
    [0.00001, '<$0.0001'],
  ] as const)('fmtUsd(%s) is %s', (input, expected) => {
    expect(fmtUsd(input)).toBe(expected);
  });

  it('renders every registry price exactly (D5 regression: never $0.04 for clef-flash)', () => {
    expect(CLOUDFLARE_MODELS.length).toBeGreaterThan(0);
    for (const model of CLOUDFLARE_MODELS) {
      expect(fmtUsd(model.inputPerMTok)).toBe(`$${model.inputPerMTok}`);
      expect(fmtUsd(model.outputPerMTok)).toBe('$0');
    }
    expect(fmtUsd(0.038)).not.toBe('$0.04');
  });
});

import { describe, it, expect } from 'vitest';
import { deblindReason } from '@/lib/eval/deblind';

describe('deblindReason', () => {
  it('remaps the full Response A/B labels to model short-names', () => {
    expect(
      deblindReason('Response A is better than Response B', false, 'anthropic/opus', 'openai/gpt'),
    ).toBe('opus is better than gpt');
  });

  it('respects orderSwapped (A was the challenger) when remapping', () => {
    expect(deblindReason('Response A wins', true, 'anthropic/opus', 'openai/gpt')).toBe('gpt wins');
  });

  // Regression: must NOT rewrite ordinary capitalized "A"/"B" words when the modern
  // "Response A/B" form is present (e.g. "A-grade", "plan B").
  it('does not mangle ordinary A/B words in a modern reason', () => {
    expect(
      deblindReason('Response A gives an A-grade answer; Response B is plan B', false, 'm/champ', 'm/chall'),
    ).toBe('champ gives an A-grade answer; chall is plan B');
  });

  // Legacy bare-letter reasons (no "Response A/B") still get a best-effort remap.
  it('best-effort remaps a legacy bare-letter reason', () => {
    expect(deblindReason('A is better', false, 'm/champ', 'm/chall')).toBe('champ is better');
  });
});

import { describe, it, expect } from 'vitest';
import type { LanguageModelUsage } from 'ai';
import { sumUsage, sumCost, StructuredAttemptError } from '@/lib/gateway/structured';

const u = (inputTokens: number, outputTokens: number, extra?: Partial<LanguageModelUsage>) =>
  ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, ...extra }) as LanguageModelUsage;

describe('sumUsage', () => {
  it('passes a single defined report through', () => {
    expect(sumUsage(u(10, 5), undefined)).toEqual(u(10, 5));
    expect(sumUsage(undefined, u(3, 2))).toEqual(u(3, 2));
    expect(sumUsage(undefined, undefined)).toBeUndefined();
  });

  it('sums both attempts field-by-field', () => {
    const total = sumUsage(u(100, 20), u(150, 30));
    expect(total?.inputTokens).toBe(250);
    expect(total?.outputTokens).toBe(50);
    expect(total?.totalTokens).toBe(300);
  });

  it('treats missing numeric fields as zero', () => {
    const total = sumUsage(
      { inputTokens: 10 } as LanguageModelUsage,
      { outputTokens: 7 } as LanguageModelUsage,
    );
    expect(total?.inputTokens).toBe(10);
    expect(total?.outputTokens).toBe(7);
    expect(total?.totalTokens).toBe(0);
  });

  it('sums cached and reasoning token details', () => {
    const total = sumUsage(
      u(10, 5, { cachedInputTokens: 4, reasoningTokens: 1 }),
      u(20, 10, { cachedInputTokens: 6, reasoningTokens: 2 }),
    );
    expect(total?.cachedInputTokens).toBe(10);
    expect(total?.reasoningTokens).toBe(3);
  });
});

describe('sumCost', () => {
  it('is null only when no attempt reported a cost', () => {
    expect(sumCost(null, null)).toBeNull();
  });

  it('passes a single reported cost through', () => {
    expect(sumCost(0.5, null)).toBe(0.5);
    expect(sumCost(null, 0.25)).toBe(0.25);
  });

  it('adds both attempts (the retry path bills two calls)', () => {
    expect(sumCost(0.5, 0.25)).toBe(0.75);
  });

  it('keeps a legitimate zero-cost attempt distinct from unreported', () => {
    expect(sumCost(0, null)).toBe(0);
    expect(sumCost(0, 0.1)).toBe(0.1);
  });
});

describe('StructuredAttemptError', () => {
  it('carries the billed strict-attempt cost, usage, and original cause', () => {
    const cause = new Error('timeout');
    const e = new StructuredAttemptError('retry failed', 0.02, u(100, 0), cause);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('StructuredAttemptError');
    expect(e.costUsd).toBe(0.02);
    expect(e.usage?.inputTokens).toBe(100);
    expect(e.cause).toBe(cause);
  });
});

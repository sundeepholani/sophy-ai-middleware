import { describe, it, expect } from 'vitest';
import type { LanguageModelUsage } from 'ai';
import { normalizeUsage, extractGatewayCost } from '@/lib/usage/record';

describe('normalizeUsage', () => {
  it('maps full usage including token details', () => {
    const u = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: { cacheReadTokens: 20 },
      outputTokenDetails: { reasoningTokens: 10 },
    } as unknown as LanguageModelUsage;
    const n = normalizeUsage(u);
    expect(n.inputTokens).toBe(100);
    expect(n.outputTokens).toBe(50);
    expect(n.totalTokens).toBe(150);
    expect(n.cachedInputTokens).toBe(20);
    expect(n.reasoningTokens).toBe(10);
  });

  it('falls back to input+output when totalTokens missing, and handles undefined', () => {
    const n = normalizeUsage({ inputTokens: 7, outputTokens: 3 } as unknown as LanguageModelUsage);
    expect(n.totalTokens).toBe(10);
    expect(normalizeUsage(undefined).totalTokens).toBe(0);
  });
});

describe('extractGatewayCost', () => {
  it('reads numeric cost from providerMetadata.gateway', () => {
    expect(extractGatewayCost({ gateway: { cost: 0.0123 } } as never)).toBe(0.0123);
    expect(extractGatewayCost({ gateway: { cost: '0.5' } } as never)).toBe(0.5);
  });
  it('returns null when absent', () => {
    expect(extractGatewayCost(undefined)).toBeNull();
    expect(extractGatewayCost({} as never)).toBeNull();
  });
});

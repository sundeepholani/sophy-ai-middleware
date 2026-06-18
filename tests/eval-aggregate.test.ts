import { describe, it, expect } from 'vitest';
import { summarize, type JudgedSample } from '@/lib/eval/aggregate';

type W = JudgedSample['winner'];
function samples(spec: { winner: W; n: number }[], cost?: { champ: number; chall: number }): JudgedSample[] {
  const out: JudgedSample[] = [];
  for (const s of spec) {
    for (let i = 0; i < s.n; i++) {
      out.push({
        winner: s.winner,
        confidence: 0.9,
        reason: 'r',
        championCostUsd: cost?.champ ?? null,
        challengerCostUsd: cost?.chall ?? null,
        championLatencyMs: 100,
        challengerLatencyMs: 80,
      });
    }
  }
  return out;
}

const opts = { monthlyRequests: 1000, championModel: 'a/champ', challengerModel: 'a/chall' };

describe('summarize', () => {
  it('recommends switch when the challenger clearly wins', () => {
    const s = summarize(samples([{ winner: 'challenger', n: 80 }, { winner: 'champion', n: 20 }]), opts);
    expect(s.winsChallenger).toBe(80);
    expect(s.challengerWinRate).toBeCloseTo(0.8, 5);
    expect(s.ci!.low).toBeGreaterThan(0.5);
    expect(s.recommendation).toBe('switch');
  });

  it('recommends keep when the champion clearly wins', () => {
    const s = summarize(samples([{ winner: 'challenger', n: 20 }, { winner: 'champion', n: 80 }]), opts);
    expect(s.ci!.high).toBeLessThan(0.5);
    expect(s.recommendation).toBe('keep');
  });

  it('is inconclusive on a coin-flip with no cost signal', () => {
    const s = summarize(samples([{ winner: 'challenger', n: 50 }, { winner: 'champion', n: 50 }]), {
      ...opts,
      monthlyRequests: null,
    });
    expect(s.ci!.low).toBeLessThan(0.5);
    expect(s.ci!.high).toBeGreaterThan(0.5);
    expect(s.recommendation).toBe('inconclusive');
  });

  it('recommends switch_for_cost on a coin-flip when the challenger is cheaper', () => {
    const s = summarize(
      samples([{ winner: 'challenger', n: 50 }, { winner: 'champion', n: 50 }], { champ: 0.002, chall: 0.001 }),
      opts,
    );
    expect(s.projectedMonthlyCostDeltaUsd).toBeCloseTo(-1, 5); // (0.001-0.002)*1000
    expect(s.recommendation).toBe('switch_for_cost');
  });

  it('projects monthly cost delta and tie rate', () => {
    const s = summarize(
      samples([{ winner: 'tie', n: 100 }], { champ: 0.003, chall: 0.001 }),
      opts,
    );
    expect(s.ties).toBe(100);
    expect(s.tieRate).toBe(1);
    expect(s.challengerWinRate).toBeNull();
    expect(s.projectedMonthlyCostDeltaUsd).toBeCloseTo(-2, 5);
    expect(s.recommendation).toBe('switch_for_cost'); // interchangeable + cheaper
  });
});

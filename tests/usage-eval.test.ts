import { describe, it, expect } from 'vitest';
import {
  evalCostTotal,
  evalCostByModel,
  evalCostByKey,
  evalStackRows,
  type EvalCostCell,
} from '@/lib/admin/usage-eval';

// champion = sonnet (its cost lives in usage_events, never in these cells),
// challenger = haiku, judge = opus.
const cell = (over: Partial<EvalCostCell> = {}): EvalCostCell => ({
  day: '2026-07-01',
  apiKeyId: 'key-1',
  keyName: 'Support bot',
  challengerModel: 'anthropic/claude-haiku-4.5',
  judgeModel: 'anthropic/claude-opus-4.8',
  challengerCost: 0.01,
  judgeCost: 0.03,
  ...over,
});

describe('evalCostTotal', () => {
  it('sums challenger + judge across cells', () => {
    expect(evalCostTotal([cell(), cell({ challengerCost: 0.02, judgeCost: 0 })])).toBeCloseTo(0.06, 10);
  });

  it('with a model filter, counts only the portion attributed to that model', () => {
    const cells = [cell()]; // haiku challenger 0.01, opus judge 0.03
    expect(evalCostTotal(cells, 'anthropic/claude-haiku-4.5')).toBeCloseTo(0.01, 10);
    expect(evalCostTotal(cells, 'anthropic/claude-opus-4.8')).toBeCloseTo(0.03, 10);
    expect(evalCostTotal(cells, 'anthropic/claude-sonnet-4.6')).toBe(0); // champion — not in cells
  });

  it('is zero for no cells', () => {
    expect(evalCostTotal([])).toBe(0);
  });
});

describe('evalCostByModel', () => {
  it('attributes challenger cost to the challenger model and judge cost to the judge model', () => {
    const m = evalCostByModel([cell()]);
    expect(m.get('anthropic/claude-haiku-4.5')).toBeCloseTo(0.01, 10);
    expect(m.get('anthropic/claude-opus-4.8')).toBeCloseTo(0.03, 10);
    expect(m.has('anthropic/claude-sonnet-4.6')).toBe(false); // champion never appears
  });

  it('sums challenger and judge onto the same model when a run uses it for both', () => {
    const m = evalCostByModel([cell({ judgeModel: 'anthropic/claude-haiku-4.5' })]);
    expect(m.get('anthropic/claude-haiku-4.5')).toBeCloseTo(0.04, 10);
    expect(m.size).toBe(1);
  });

  it('accumulates across runs and days', () => {
    const m = evalCostByModel([
      cell({ challengerCost: 0.01 }),
      cell({ day: '2026-07-02', challengerCost: 0.02 }),
    ]);
    expect(m.get('anthropic/claude-haiku-4.5')).toBeCloseTo(0.03, 10);
    expect(m.get('anthropic/claude-opus-4.8')).toBeCloseTo(0.06, 10);
  });

  it('with a model filter, keeps only that model', () => {
    const m = evalCostByModel([cell()], 'anthropic/claude-opus-4.8');
    expect([...m.keys()]).toEqual(['anthropic/claude-opus-4.8']);
    expect(m.get('anthropic/claude-opus-4.8')).toBeCloseTo(0.03, 10);
  });

  it('omits a model whose attributed portion is zero', () => {
    const m = evalCostByModel([cell({ judgeCost: 0 })]);
    expect(m.has('anthropic/claude-opus-4.8')).toBe(false);
  });
});

describe('evalCostByKey', () => {
  it('sums challenger + judge onto the key', () => {
    const m = evalCostByKey([cell(), cell({ challengerCost: 0.05, judgeCost: 0 })]);
    expect(m.get('key-1')!.cost).toBeCloseTo(0.09, 10);
    expect(m.get('key-1')!.keyName).toBe('Support bot');
  });

  it('separates distinct keys', () => {
    const m = evalCostByKey([cell(), cell({ apiKeyId: 'key-2', keyName: 'JD extractor' })]);
    expect(m.get('key-1')!.cost).toBeCloseTo(0.04, 10);
    expect(m.get('key-2')!.cost).toBeCloseTo(0.04, 10);
  });

  it('keeps a null keyName (deleted key) so the caller can fall back to the id', () => {
    const m = evalCostByKey([cell({ keyName: null })]);
    expect(m.get('key-1')!.keyName).toBeNull();
  });

  it('drops a key whose filtered cost is zero', () => {
    const m = evalCostByKey([cell({ challengerCost: 0, judgeCost: 0.03 })], 'anthropic/claude-haiku-4.5');
    expect(m.size).toBe(0);
  });
});

describe('evalStackRows', () => {
  it('by model emits a row for each of challenger and judge on the sample day', () => {
    const rows = evalStackRows([cell()], 'model');
    expect(rows).toEqual([
      { day: '2026-07-01', cat: 'anthropic/claude-haiku-4.5', requests: 0, tokens: 0, cost: 0.01 },
      { day: '2026-07-01', cat: 'anthropic/claude-opus-4.8', requests: 0, tokens: 0, cost: 0.03 },
    ]);
  });

  it('by key emits one row with the combined cost', () => {
    const rows = evalStackRows([cell()], 'key');
    expect(rows).toEqual([
      { day: '2026-07-01', cat: 'Support bot', requests: 0, tokens: 0, cost: 0.04 },
    ]);
  });

  it('by key falls back to the api key id for a deleted key', () => {
    const rows = evalStackRows([cell({ keyName: null })], 'key');
    expect(rows[0].cat).toBe('key-1');
  });

  it('carries zero requests and tokens so eval spend shows only under the Cost metric', () => {
    for (const r of evalStackRows([cell()], 'model')) {
      expect(r.requests).toBe(0);
      expect(r.tokens).toBe(0);
    }
  });

  it('respects the model filter (only the matching attribution emits a row)', () => {
    const rows = evalStackRows([cell()], 'model', 'anthropic/claude-opus-4.8');
    expect(rows).toEqual([
      { day: '2026-07-01', cat: 'anthropic/claude-opus-4.8', requests: 0, tokens: 0, cost: 0.03 },
    ]);
  });

  it('emits no row when the attributed cost is zero', () => {
    expect(evalStackRows([cell({ challengerCost: 0, judgeCost: 0 })], 'model')).toEqual([]);
  });
});

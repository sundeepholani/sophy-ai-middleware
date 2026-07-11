/**
 * Folding eval spend into the Usage page.
 *
 * Champion cost is real client traffic and is already in usage_events (it's the
 * live request), so the usage charts already count it. What they miss is the
 * eval-only spend: the **challenger** replay and the **judge** call. This module
 * attributes that spend the way the operator reads the page:
 *
 *   - by KEY   → the run's api key (challenger + judge together)
 *   - by MODEL → challenger cost to the challenger model, judge cost to the
 *                judge model (never to the champion — that's the live request)
 *
 * It folds into COST only. Requests and token counts stay proxy-only: a
 * challenger replay isn't a client request, and the judge call records no
 * tokens. The chart's cost/requests/tokens toggle keeps this honest — eval
 * spend surfaces under Cost and is absent under the other two.
 *
 * Source: JUDGED eval samples (their cost columns survive the post-finalize
 * content purge). Cancelled runs' samples are hard-deleted, so their frozen
 * spend can't be split by model and is NOT reflected here — see the Evals page
 * for run-level recorded spend.
 *
 * Pure functions over already-fetched rows, so the attribution/filter logic is
 * unit-tested without a database (the SQL that produces the cells lives in
 * lib/admin/queries.ts).
 */
import type { UsageStackRow } from '@/lib/admin/queries';

/** One (day × key × challenger-model × judge-model) bucket of eval spend. */
export interface EvalCostCell {
  day: string;
  apiKeyId: string;
  keyName: string | null;
  challengerModel: string;
  judgeModel: string;
  challengerCost: number;
  judgeCost: number;
}

/**
 * The challenger/judge portions of a cell that count under an optional model
 * filter: with no filter both count; with a filter, the challenger portion
 * counts only when it's the filtered model, and likewise the judge portion.
 */
function attributable(cell: EvalCostCell, model?: string): { challenger: number; judge: number } {
  return {
    challenger: !model || cell.challengerModel === model ? cell.challengerCost : 0,
    judge: !model || cell.judgeModel === model ? cell.judgeCost : 0,
  };
}

/** Total eval spend to add to the usage cost total (honoring a model filter). */
export function evalCostTotal(cells: EvalCostCell[], model?: string): number {
  let sum = 0;
  for (const c of cells) {
    const { challenger, judge } = attributable(c, model);
    sum += challenger + judge;
  }
  return sum;
}

/** model id → eval cost. Challenger cost lands on the challenger model, judge
 *  cost on the judge model; if a run uses the same id for both, they sum. */
export function evalCostByModel(cells: EvalCostCell[], model?: string): Map<string, number> {
  const out = new Map<string, number>();
  const add = (m: string, v: number) => {
    if (v) out.set(m, (out.get(m) ?? 0) + v);
  };
  for (const c of cells) {
    const { challenger, judge } = attributable(c, model);
    add(c.challengerModel, challenger);
    add(c.judgeModel, judge);
  }
  return out;
}

/** api key id → { name, eval cost }. Challenger + judge land together on the key. */
export function evalCostByKey(
  cells: EvalCostCell[],
  model?: string,
): Map<string, { keyName: string | null; cost: number }> {
  const out = new Map<string, { keyName: string | null; cost: number }>();
  for (const c of cells) {
    const { challenger, judge } = attributable(c, model);
    const cost = challenger + judge;
    if (!cost) continue;
    const cur = out.get(c.apiKeyId) ?? { keyName: c.keyName, cost: 0 };
    cur.cost += cost;
    if (cur.keyName == null) cur.keyName = c.keyName; // first non-null name wins
    out.set(c.apiKeyId, cur);
  }
  return out;
}

/**
 * Eval spend as stacked-chart rows to CONCATENATE with the proxy rows — the
 * chart re-aggregates by (day, cat), so same-bucket rows simply sum. Requests
 * and tokens are 0 (cost-only). By model, each cell emits up to two rows
 * (challenger model, judge model); by key, one row on the key's label (name, or
 * the raw id for an orphaned/deleted key — matching the proxy query's fallback).
 */
export function evalStackRows(
  cells: EvalCostCell[],
  dim: 'model' | 'key',
  model?: string,
): UsageStackRow[] {
  const out: UsageStackRow[] = [];
  const push = (day: string, cat: string, cost: number) => {
    if (cost) out.push({ day, cat, requests: 0, tokens: 0, cost });
  };
  for (const c of cells) {
    const { challenger, judge } = attributable(c, model);
    if (dim === 'model') {
      push(c.day, c.challengerModel, challenger);
      push(c.day, c.judgeModel, judge);
    } else {
      push(c.day, c.keyName ?? c.apiKeyId, challenger + judge);
    }
  }
  return out;
}

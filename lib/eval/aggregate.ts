/**
 * Turn judged samples into a verdict: win/loss/tie counts, a Wilson 95%
 * confidence interval on the challenger win-rate (so we don't over-read a
 * coin-flip), cost/latency deltas, a projected monthly cost impact, and a
 * recommendation.
 */
import type { EvalWinner } from '@/db/schema';

export interface JudgedSample {
  winner: EvalWinner;
  confidence: number;
  reason: string;
  championCostUsd: number | null;
  challengerCostUsd: number | null;
  championLatencyMs: number | null;
  challengerLatencyMs: number | null;
}

export type EvalRecommendation = 'switch' | 'switch_for_cost' | 'keep' | 'inconclusive';

export interface EvalSummary {
  total: number;
  winsChampion: number;
  winsChallenger: number;
  ties: number;
  challengerWinRate: number | null; // among decisive (excludes ties)
  ci: { low: number; high: number } | null; // Wilson 95% on the win-rate
  tieRate: number;
  avgChampionCostUsd: number | null;
  avgChallengerCostUsd: number | null;
  avgChampionLatencyMs: number | null;
  avgChallengerLatencyMs: number | null;
  monthlyRequests: number | null;
  projectedMonthlyCostDeltaUsd: number | null; // challenger − champion at current volume
  recommendation: EvalRecommendation;
  headline: string;
  examples: { winner: EvalWinner; confidence: number; reason: string }[];
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

/** Wilson score interval for a binomial proportion (z = 1.96 ⇒ ~95%). */
function wilson(successes: number, n: number): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

export function summarize(
  samples: JudgedSample[],
  opts: { monthlyRequests: number | null; championModel: string; challengerModel: string },
): EvalSummary {
  const total = samples.length;
  const winsChampion = samples.filter((s) => s.winner === 'champion').length;
  const winsChallenger = samples.filter((s) => s.winner === 'challenger').length;
  const ties = samples.filter((s) => s.winner === 'tie').length;
  const decisive = winsChampion + winsChallenger;

  const challengerWinRate = decisive > 0 ? winsChallenger / decisive : null;
  const ci = decisive > 0 ? wilson(winsChallenger, decisive) : null;
  const tieRate = total > 0 ? ties / total : 0;

  const avgChampionCostUsd = mean(
    samples.map((s) => s.championCostUsd).filter((x): x is number => x != null),
  );
  const avgChallengerCostUsd = mean(
    samples.map((s) => s.challengerCostUsd).filter((x): x is number => x != null),
  );
  const avgChampionLatencyMs = mean(
    samples.map((s) => s.championLatencyMs).filter((x): x is number => x != null),
  );
  const avgChallengerLatencyMs = mean(
    samples.map((s) => s.challengerLatencyMs).filter((x): x is number => x != null),
  );

  const projectedMonthlyCostDeltaUsd =
    opts.monthlyRequests != null && avgChampionCostUsd != null && avgChallengerCostUsd != null
      ? (avgChallengerCostUsd - avgChampionCostUsd) * opts.monthlyRequests
      : null;

  const cheaper = projectedMonthlyCostDeltaUsd != null && projectedMonthlyCostDeltaUsd < 0;

  let recommendation: EvalRecommendation;
  if (ci && ci.low > 0.5) recommendation = 'switch';
  else if (ci && ci.high < 0.5) recommendation = 'keep';
  else recommendation = cheaper ? 'switch_for_cost' : 'inconclusive';

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const ch = opts.challengerModel;
  let headline: string;
  switch (recommendation) {
    case 'switch':
      headline = `Switch to ${ch}: it won ${pct(challengerWinRate ?? 0)} of decided comparisons (95% CI ${pct(ci!.low)}–${pct(ci!.high)}).`;
      break;
    case 'keep':
      headline = `Keep ${opts.championModel}: the challenger lost (${ch} won only ${pct(challengerWinRate ?? 0)} of decided comparisons).`;
      break;
    case 'switch_for_cost':
      headline = `No clear quality difference, and ${ch} is cheaper — switching would save ~$${Math.abs(projectedMonthlyCostDeltaUsd!).toFixed(2)}/mo at current volume.`;
      break;
    default:
      headline = `Inconclusive: no clear quality difference between the models, and ${ch} isn't cheaper. Consider a larger sample or deciding on other factors.`;
  }

  // Up to 4 examples: the most confident decisive verdicts on each side.
  const decisiveSamples = samples
    .filter((s) => s.winner !== 'tie')
    .sort((a, b) => b.confidence - a.confidence);
  const examples = [
    ...decisiveSamples.filter((s) => s.winner === 'challenger').slice(0, 2),
    ...decisiveSamples.filter((s) => s.winner === 'champion').slice(0, 2),
  ].map((s) => ({ winner: s.winner, confidence: s.confidence, reason: s.reason }));

  return {
    total,
    winsChampion,
    winsChallenger,
    ties,
    challengerWinRate,
    ci,
    tieRate,
    avgChampionCostUsd,
    avgChallengerCostUsd,
    avgChampionLatencyMs,
    avgChallengerLatencyMs,
    monthlyRequests: opts.monthlyRequests,
    projectedMonthlyCostDeltaUsd,
    recommendation,
    headline,
    examples,
  };
}

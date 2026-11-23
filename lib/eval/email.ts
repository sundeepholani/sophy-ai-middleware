import type { EvalSummary } from '@/lib/eval/aggregate';
import { deblindReason, shortModel } from '@/lib/eval/deblind';
import { renderEmail, type EmailMessage } from '@/lib/email/frame';

function fmtUsd(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0')}`;
}
function fmtMs(n: number | null): string {
  return n == null ? '—' : `${Math.round(n)} ms`;
}
function pct(n: number | null): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
}

export function formatEvalEmail(args: {
  championModel: string;
  challengerModel: string;
  judgeModel: string;
  summary: EvalSummary;
}): EmailMessage {
  const s = args.summary;
  const subject = `Eval: ${args.challengerModel} vs ${args.championModel} — ${
    s.recommendation === 'switch'
      ? 'switch recommended'
      : s.recommendation === 'switch_for_cost'
        ? 'switch for cost'
        : s.recommendation === 'keep'
          ? 'keep champion'
          : 'inconclusive'
  }`;

  const costDelta =
    s.projectedMonthlyCostDeltaUsd == null
      ? '—'
      : `${s.projectedMonthlyCostDeltaUsd < 0 ? '−' : '+'}$${Math.abs(s.projectedMonthlyCostDeltaUsd).toFixed(2)}/mo`;

  const comparison = (champion: string, challenger: string) => `${champion} → ${challenger}`;

  return renderEmail({
    subject,
    headline: 'Model evaluation complete',
    intro: s.headline,
    details: [
      { label: 'Current model', value: args.championModel },
      { label: 'Challenger', value: args.challengerModel },
      { label: 'Judge', value: args.judgeModel },
      { label: 'Samples', value: String(s.total) },
      { label: 'Wins (challenger / current / tie)', value: `${s.winsChallenger} / ${s.winsChampion} / ${s.ties}` },
      {
        label: 'Challenger win rate (excluding ties)',
        value: `${pct(s.challengerWinRate)}${s.ci ? ` (95% confidence interval ${pct(s.ci.low)}–${pct(s.ci.high)})` : ''}`,
      },
      { label: 'Average cost per task', value: comparison(fmtUsd(s.avgChampionCostUsd), fmtUsd(s.avgChallengerCostUsd)) },
      { label: 'Projected monthly cost change', value: costDelta },
      { label: 'Average latency', value: comparison(fmtMs(s.avgChampionLatencyMs), fmtMs(s.avgChallengerLatencyMs)) },
    ],
    notes: s.examples.map((example) => {
      const winner = example.winner === 'challenger' ? args.challengerModel : args.championModel;
      return {
        label: `${shortModel(winner)} won`,
        value: deblindReason(example.reason, example.orderSwapped, args.championModel, args.challengerModel),
      };
    }),
    reason: 'This email address is listed for evaluation results in the project settings.',
  });
}

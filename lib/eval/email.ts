/**
 * Eval summary email: formats the run summary into HTML and sends via the shared
 * transactional sender (lib/email/send). Feature-gated at the sender — when email
 * isn't configured the send is a no-op and finalization still completes.
 */
import type { EvalSummary } from '@/lib/eval/aggregate';
import { sendEmail, escapeHtml } from '@/lib/email/send';

/** Back-compat alias — eval finalization sends through the shared sender. */
export { sendEmail as sendEvalEmail };

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
}): { subject: string; html: string } {
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

  const examples = s.examples
    .map(
      (e) =>
        `<li><b>${e.winner === 'challenger' ? 'Challenger' : 'Champion'} won</b>: ${escapeHtml(e.reason)}</li>`,
    )
    .join('');

  const html = `
  <div style="font-family:system-ui,sans-serif;max-width:640px;color:#111">
    <h2 style="margin:0 0 4px">Model eval complete</h2>
    <p style="font-size:16px;margin:8px 0 16px"><b>${escapeHtml(s.headline)}</b></p>
    <table style="border-collapse:collapse;font-size:14px;width:100%">
      <tr><td style="padding:4px 8px;color:#666">Champion</td><td style="padding:4px 8px"><code>${escapeHtml(args.championModel)}</code></td></tr>
      <tr><td style="padding:4px 8px;color:#666">Challenger</td><td style="padding:4px 8px"><code>${escapeHtml(args.challengerModel)}</code></td></tr>
      <tr><td style="padding:4px 8px;color:#666">Judge</td><td style="padding:4px 8px"><code>${escapeHtml(args.judgeModel)}</code></td></tr>
      <tr><td style="padding:4px 8px;color:#666">Samples</td><td style="padding:4px 8px">${s.total}</td></tr>
      <tr><td style="padding:4px 8px;color:#666">Wins (challenger / champion / tie)</td><td style="padding:4px 8px">${s.winsChallenger} / ${s.winsChampion} / ${s.ties}</td></tr>
      <tr><td style="padding:4px 8px;color:#666">Challenger win-rate (decided)</td><td style="padding:4px 8px">${pct(s.challengerWinRate)} ${s.ci ? `(95% CI ${pct(s.ci.low)}–${pct(s.ci.high)})` : ''}</td></tr>
      <tr><td style="padding:4px 8px;color:#666">Avg cost per task (champion → challenger)</td><td style="padding:4px 8px">${fmtUsd(s.avgChampionCostUsd)} → ${fmtUsd(s.avgChallengerCostUsd)}</td></tr>
      <tr><td style="padding:4px 8px;color:#666">Projected monthly cost impact</td><td style="padding:4px 8px">${costDelta}</td></tr>
      <tr><td style="padding:4px 8px;color:#666">Avg latency (champion → challenger)</td><td style="padding:4px 8px">${fmtMs(s.avgChampionLatencyMs)} → ${fmtMs(s.avgChallengerLatencyMs)}</td></tr>
    </table>
    ${examples ? `<h3 style="margin:16px 0 4px">Example verdicts</h3><ul style="font-size:14px;padding-left:18px">${examples}</ul>` : ''}
    <p style="font-size:12px;color:#888;margin-top:16px">Sophy · the model field is owned by the key; switch the key's model in the admin console if you agree.</p>
  </div>`;

  return { subject, html };
}

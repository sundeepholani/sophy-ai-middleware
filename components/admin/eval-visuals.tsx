/**
 * Shared presentation for model-eval data — used by both the eval dialog
 * (keys page, client) and the evals pages (server). Pure components and maps:
 * keeping the win/tie collapsing (effectiveWinner), de-blinding, colors, and
 * labels in one place so a verdict reads identically on every surface.
 */
import type { EvalRunStatus } from '@/db/schema';
import type { EvalJudgment } from '@/lib/admin/queries';
import { effectiveWinner } from '@/lib/eval/confidence';
import { deblindReason, shortModel } from '@/lib/eval/deblind';
import { Badge } from '@/components/ui/badge';

export const REC_LABEL: Record<string, { text: string; variant: 'default' | 'destructive' | 'outline' }> = {
  switch: { text: 'Switch to challenger', variant: 'default' },
  switch_for_cost: { text: 'Switch for cost', variant: 'default' },
  keep: { text: 'Keep champion', variant: 'outline' },
  inconclusive: { text: 'Inconclusive', variant: 'outline' },
};

/** Run-status badge presentation. 'failed' is unreachable today (only samples
 *  fail), but the enum reserves it — render it defensively rather than crash. */
export const RUN_STATUS_META: Record<EvalRunStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  running: { label: 'Running', variant: 'default' },
  completed: { label: 'Completed', variant: 'secondary' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
  failed: { label: 'Failed', variant: 'destructive' },
};

export function pct(n: number | null): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
}
export function usd(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/**
 * Per-side presentation, keyed off the judge's winner. We surface the *actual
 * model names* (not "champion"/"challenger") so the operator reads the comparison
 * in concrete terms. Colors are shared by the win bar and the row badges so a
 * given model reads the same everywhere.
 */
export function sideMeta(winner: string, championModel: string, challengerModel: string) {
  switch (winner) {
    case 'challenger':
      return {
        full: challengerModel,
        label: shortModel(challengerModel),
        bar: 'bg-primary',
        badge: 'border-transparent bg-primary text-primary-foreground',
      };
    case 'champion':
      return {
        full: championModel,
        label: shortModel(championModel),
        bar: 'bg-amber-500',
        badge: 'border-transparent bg-amber-500 text-white',
      };
    default:
      return { full: 'Tie', label: 'Tie', bar: 'bg-muted-foreground/30', badge: '' };
  }
}

/** Stacked win-share bar + legend, showing which model is winning what share. */
export function WinBar({
  judgments,
  championModel,
  challengerModel,
}: {
  judgments: EvalJudgment[];
  championModel: string;
  challengerModel: string;
}) {
  const total = judgments.length;
  if (total === 0) return null;
  const sides = (['challenger', 'champion', 'tie'] as const).map((w) => {
    const meta = sideMeta(w, championModel, challengerModel);
    return {
      w,
      meta,
      n: judgments.filter((j) => effectiveWinner(j.winner, j.confidence) === w).length,
    };
  });
  const share = (n: number) => Math.round((n / total) * 100);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Who’s winning</span>
        <span className="text-xs text-muted-foreground">{total} judged</span>
      </div>
      <div
        className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={sides.map((s) => `${s.meta.full}: ${share(s.n)}%`).join(', ')}
      >
        {sides.map((s) =>
          s.n > 0 ? (
            <div key={s.w} className={s.meta.bar} style={{ width: `${(s.n / total) * 100}%` }} />
          ) : null,
        )}
      </div>
      <ul className="space-y-1">
        {sides.map((s) => (
          <li key={s.w} className="flex items-center gap-2 text-xs">
            <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${s.meta.bar}`} />
            <code className="min-w-0 flex-1 truncate text-muted-foreground">{s.meta.full}</code>
            <span className="shrink-0 tabular-nums font-medium">{share(s.n)}%</span>
            <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{s.n}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Avg cost per task for each model in this eval (challenger first, to match the bar). */
export function CostPerTask({
  championModel,
  challengerModel,
  avgChampionCostUsd,
  avgChallengerCostUsd,
}: {
  championModel: string;
  challengerModel: string;
  avgChampionCostUsd: number | null;
  avgChallengerCostUsd: number | null;
}) {
  const rows = [
    { name: challengerModel, cost: avgChallengerCostUsd, color: 'bg-primary' },
    { name: championModel, cost: avgChampionCostUsd, color: 'bg-amber-500' },
  ];
  return (
    <div className="space-y-2 rounded-md border p-3">
      <span className="text-sm font-medium">Avg cost / task</span>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.name} className="flex items-center gap-2 text-xs">
            <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-sm ${r.color}`} />
            <code className="min-w-0 flex-1 truncate text-muted-foreground">{r.name}</code>
            <span className="shrink-0 tabular-nums font-medium">{usd(r.cost)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function JudgmentsList({
  judgments,
  championModel,
  challengerModel,
}: {
  judgments: EvalJudgment[];
  championModel: string;
  challengerModel: string;
}) {
  if (!judgments?.length) {
    return (
      <p className="text-xs text-muted-foreground">
        No judgments yet — they appear here as the judge scores each sample.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="text-sm font-medium">Judgments ({judgments.length})</p>
      <div className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-2">
        {judgments.map((j, i) => {
          const meta = sideMeta(
            effectiveWinner(j.winner, j.confidence),
            championModel,
            challengerModel,
          );
          return (
            <div key={i} className="flex items-start gap-2 text-xs">
              <Badge variant="outline" className={`shrink-0 ${meta.badge}`}>
                {meta.label}
              </Badge>
              <span className="text-muted-foreground">
                {deblindReason(j.reason, j.orderSwapped, championModel, challengerModel) || '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

'use client';

import { useState, useEffect, useTransition } from 'react';
import { toast } from 'sonner';
import { startEvalRun, cancelEvalRun, refreshKeyEval } from '@/app/admin/actions';
import type { KeyEval } from '@/lib/admin/queries';
import type { AvailableModel } from '@/lib/gateway/models';
import { effectiveWinner } from '@/lib/eval/confidence';
import { deblindReason, shortModel } from '@/lib/eval/deblind';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { ModelCombobox } from '@/components/admin/model-combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

type Summary = NonNullable<KeyEval['summary']>;

const REC_LABEL: Record<string, { text: string; variant: 'default' | 'destructive' | 'outline' }> = {
  switch: { text: 'Switch to challenger', variant: 'default' },
  switch_for_cost: { text: 'Switch for cost', variant: 'default' },
  keep: { text: 'Keep champion', variant: 'outline' },
  inconclusive: { text: 'Inconclusive', variant: 'outline' },
};

function pct(n: number | null): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
}
function usd(n: number | null): string {
  return n == null ? '—' : `$${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}

export function EvalDialog({
  keyRow,
  models,
  current,
  judgeModel,
  open,
  onOpenChange,
}: {
  keyRow: { id: string; name: string; model: string };
  models: AvailableModel[];
  current: KeyEval | null;
  judgeModel: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  // `current` is a snapshot taken when the keys page server-rendered. Fetch the
  // latest on open (and poll while a run is judging) so judgments the background
  // cron produced after page load appear without a full reload.
  // Track only freshly-fetched data; `data` falls back to the page-load snapshot
  // until the first fetch lands. The dialog is remounted per key (key={id} at the
  // call site), so `fetched` always belongs to this key.
  const [fetched, setFetched] = useState<KeyEval | null>(null);
  const data = fetched ?? current;
  const running = data?.status === 'running';
  const completed = data?.status === 'completed' && data.summary;

  useEffect(() => {
    if (!open) return;
    let active = true;
    const tick = async () => {
      try {
        const fresh = await refreshKeyEval(keyRow.id);
        if (active && fresh) setFetched(fresh);
      } catch {
        /* keep the last good data on a transient failure */
      }
    };
    tick(); // fresh fetch the moment the modal opens
    if (!running) return () => void (active = false);
    const id = setInterval(tick, 10_000); // live updates while the judge is scoring
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [open, keyRow.id, running]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] w-full overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Model eval — {keyRow.name}</DialogTitle>
          <DialogDescription>
            Shadow a challenger model against the current one and let a judge pick the better output,
            blind. You get an email verdict when it finishes.
          </DialogDescription>
        </DialogHeader>

        {running ? (
          <RunningView current={data!} onDone={() => onOpenChange(false)} />
        ) : (
          <>
            {completed && <CompletedView current={data!} />}
            <StartForm
              keyRow={keyRow}
              models={models}
              judgeModel={judgeModel}
              hasPrevious={!!data}
              onDone={() => onOpenChange(false)}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Per-side presentation, keyed off the judge's winner. We surface the *actual
 * model names* (not "champion"/"challenger") so the operator reads the comparison
 * in concrete terms. Colors are shared by the win bar and the row badges so a
 * given model reads the same everywhere.
 */
function sideMeta(winner: string, championModel: string, challengerModel: string) {
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
function WinBar({ current }: { current: KeyEval }) {
  const total = current.judgments.length;
  if (total === 0) return null;
  const sides = (['challenger', 'champion', 'tie'] as const).map((w) => {
    const meta = sideMeta(w, current.championModel, current.challengerModel);
    return {
      w,
      meta,
      n: current.judgments.filter((j) => effectiveWinner(j.winner, j.confidence) === w).length,
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
function CostPerTask({ current }: { current: KeyEval }) {
  const rows = [
    { name: current.challengerModel, cost: current.avgChallengerCostUsd, color: 'bg-primary' },
    { name: current.championModel, cost: current.avgChampionCostUsd, color: 'bg-amber-500' },
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

function JudgmentsList({
  judgments,
  championModel,
  challengerModel,
}: {
  judgments: KeyEval['judgments'];
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

function RunningView({ current, onDone }: { current: KeyEval; onDone: () => void }) {
  const [isPending, startTransition] = useTransition();
  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-muted/40 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="font-medium">Running</span>
          <span className="tabular-nums text-muted-foreground">
            captured {current.capturedN}/{current.targetN} · judged {current.judgedN}
          </span>
        </div>
        <dl className="mt-2 space-y-0.5 text-xs text-muted-foreground">
          <div>
            champion <code>{current.championModel}</code>
          </div>
          <div>
            challenger <code>{current.challengerModel}</code>
          </div>
          <div>
            judge <code>{current.judgeModel}</code>
          </div>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">
          Captures the next {current.targetN} successful requests on this key; the challenger + judge
          run in the background. You’ll be emailed when it completes.
        </p>
      </div>
      <WinBar current={current} />
      <CostPerTask current={current} />
      <JudgmentsList
        judgments={current.judgments}
        championModel={current.championModel}
        challengerModel={current.challengerModel}
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="destructive"
          size="sm"
          disabled={isPending}
          onClick={() =>
            startTransition(async () => {
              try {
                await cancelEvalRun(current.runId);
                toast.success('Eval cancelled');
                onDone();
              } catch {
                toast.error('Could not cancel the eval');
              }
            })
          }
        >
          Cancel eval
        </Button>
        <Button variant="outline" size="sm" onClick={onDone}>
          Close
        </Button>
      </div>
    </div>
  );
}

function CompletedView({ current }: { current: KeyEval }) {
  const s = current.summary as Summary;
  const rec = REC_LABEL[s.recommendation] ?? REC_LABEL.inconclusive;
  const delta = s.projectedMonthlyCostDeltaUsd;
  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Last result</span>
          <Badge variant={rec.variant}>{rec.text}</Badge>
        </div>
      <p className="text-sm">{s.headline}</p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div>Samples: {s.total}</div>
        <div>
          Wins (chall/champ/tie): {s.winsChallenger}/{s.winsChampion}/{s.ties}
        </div>
        <div>
          Challenger win-rate: {pct(s.challengerWinRate)}
          {s.ci ? ` (CI ${pct(s.ci.low)}–${pct(s.ci.high)})` : ''}
        </div>
        {delta != null && (
          <div>
            Projected: {delta < 0 ? '−' : '+'}${Math.abs(delta).toFixed(2)}/mo
          </div>
        )}
        <div>
          Avg latency: {s.avgChampionLatencyMs != null ? `${Math.round(s.avgChampionLatencyMs)}ms` : '—'} →{' '}
          {s.avgChallengerLatencyMs != null ? `${Math.round(s.avgChallengerLatencyMs)}ms` : '—'}
        </div>
        </dl>
      </div>
      <WinBar current={current} />
      <CostPerTask current={current} />
      <JudgmentsList
        judgments={current.judgments}
        championModel={current.championModel}
        challengerModel={current.challengerModel}
      />
    </div>
  );
}

function StartForm({
  keyRow,
  models,
  judgeModel,
  hasPrevious,
  onDone,
}: {
  keyRow: { id: string; name: string; model: string };
  models: AvailableModel[];
  judgeModel: string;
  hasPrevious: boolean;
  onDone: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const options = models.filter((m) => m.id !== keyRow.model);
  const [challenger, setChallenger] = useState(options[0]?.id ?? '');
  const [targetN, setTargetN] = useState('100');

  function start() {
    if (!challenger.trim()) return toast.error('Pick a challenger model');
    const n = Number(targetN);
    if (!Number.isInteger(n) || n <= 0) return toast.error('Sample size must be a positive whole number');
    startTransition(async () => {
      try {
        await startEvalRun({ apiKeyId: keyRow.id, challengerModel: challenger.trim(), targetN: n });
        toast.success('Eval started');
        onDone();
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        toast.error(
          msg === 'unauthorized' ? 'Your session expired — please sign in again.' : msg || 'Could not start the eval',
        );
      }
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{hasPrevious ? 'Start another eval' : 'Start an eval'}</p>
        <p className="text-xs text-muted-foreground">
          Champion <code>{keyRow.model}</code> · judge <code>{judgeModel}</code> (set in Settings).
        </p>
      </div>

      <div className="space-y-1">
        <Label htmlFor="challenger" className="text-xs">
          Challenger model
        </Label>
        <ModelCombobox
          id="challenger"
          value={challenger}
          onValueChange={setChallenger}
          models={options.map((m) => m.id)}
          placeholder="anthropic/claude-sonnet-4.6"
        />
      </div>

      <div className="space-y-1">
        <Label htmlFor="target-n" className="text-xs">
          Sample size (transactions)
        </Label>
        <Input
          id="target-n"
          inputMode="numeric"
          value={targetN}
          onChange={(e) => setTargetN(e.target.value)}
          className="w-32"
        />
      </div>

      <div className="flex justify-end">
        <Button onClick={start} disabled={isPending}>
          {isPending ? 'Starting…' : 'Start eval'}
        </Button>
      </div>
    </div>
  );
}

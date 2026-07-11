'use client';

import Link from 'next/link';
import { useState, useEffect, useTransition } from 'react';
import { toast } from 'sonner';
import { startEvalRun, cancelEvalRun, refreshKeyEval } from '@/app/admin/actions';
import type { KeyEval } from '@/lib/admin/queries';
import type { EvalRunStatus } from '@/db/schema';
import type { AvailableModel } from '@/lib/gateway/models';
import {
  CostPerTask,
  JudgmentsList,
  pct,
  REC_LABEL,
  WinBar,
} from '@/components/admin/eval-visuals';
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

export function EvalDialog({
  keyRow,
  models,
  initialStatus,
  judgeModel,
  open,
  onOpenChange,
}: {
  keyRow: { id: string; name: string; model: string };
  models: AvailableModel[];
  /** Latest run status from the keys page (cheap hint); the full body loads on open. */
  initialStatus?: EvalRunStatus;
  judgeModel: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  // The keys page only passes each key's latest-run STATUS (cheap). The full eval
  // body — judgments, summary, costs — is fetched here when the modal opens, and
  // re-fetched every 10s while a run is judging, so the panel is never stale.
  // The dialog is remounted per key (key={id} at the call site).
  const [fetched, setFetched] = useState<KeyEval | null>(null);
  const [loaded, setLoaded] = useState(false);
  const status = fetched?.status ?? initialStatus ?? null;
  const running = status === 'running';
  const completed = fetched?.status === 'completed' && fetched.summary;

  useEffect(() => {
    if (!open) return;
    let active = true;
    const tick = async () => {
      try {
        const fresh = await refreshKeyEval(keyRow.id);
        if (active) {
          setFetched(fresh);
          setLoaded(true);
        }
      } catch {
        /* keep showing the last good data; the poll retries while running */
      }
    };
    tick(); // fetch the full eval the moment the modal opens
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

        {!loaded ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading eval…</p>
        ) : fetched?.status === 'running' ? (
          <RunningView current={fetched} onDone={() => onOpenChange(false)} />
        ) : (
          <>
            {completed && <CompletedView current={fetched!} />}
            <StartForm
              keyRow={keyRow}
              models={models}
              judgeModel={judgeModel}
              hasPrevious={!!fetched}
              onDone={() => onOpenChange(false)}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
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
          run in the background. You’ll be emailed when it completes.{' '}
          <Link href={`/admin/evals/${current.runId}`} className="text-primary hover:underline">
            Full details
          </Link>
        </p>
      </div>
      <WinBar
        judgments={current.judgments}
        championModel={current.championModel}
        challengerModel={current.challengerModel}
      />
      <CostPerTask
        championModel={current.championModel}
        challengerModel={current.challengerModel}
        avgChampionCostUsd={current.avgChampionCostUsd}
        avgChallengerCostUsd={current.avgChallengerCostUsd}
      />
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
          <span className="text-sm font-medium">
            Last result{' '}
            <Link
              href={`/admin/evals/${current.runId}`}
              className="font-normal text-primary hover:underline"
            >
              · details
            </Link>
          </span>
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
      <WinBar
        judgments={current.judgments}
        championModel={current.championModel}
        challengerModel={current.challengerModel}
      />
      <CostPerTask
        championModel={current.championModel}
        challengerModel={current.challengerModel}
        avgChampionCostUsd={current.avgChampionCostUsd}
        avgChallengerCostUsd={current.avgChallengerCostUsd}
      />
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
  // Eval compares text outputs, so a challenger must be a language model — the
  // key-form model list now also includes image models, which can't be judged.
  const options = models.filter((m) => m.type === 'language' && m.id !== keyRow.model);
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

'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { startEvalRun, cancelEvalRun } from '@/app/admin/actions';
import type { KeyEval } from '@/lib/admin/queries';
import type { AvailableModel } from '@/lib/gateway/models';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

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
  const running = current?.status === 'running';
  const completed = current?.status === 'completed' && current.summary;

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
          <RunningView current={current!} onDone={() => onOpenChange(false)} />
        ) : (
          <>
            {completed && <CompletedView current={current!} />}
            <StartForm
              keyRow={keyRow}
              models={models}
              judgeModel={judgeModel}
              hasPrevious={!!current}
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
          run in the background. You’ll be emailed when it completes.
        </p>
      </div>
      <div className="flex justify-end">
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
      </div>
    </div>
  );
}

function CompletedView({ current }: { current: KeyEval }) {
  const s = current.summary as Summary;
  const rec = REC_LABEL[s.recommendation] ?? REC_LABEL.inconclusive;
  const delta = s.projectedMonthlyCostDeltaUsd;
  return (
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
        <div>
          Avg cost: {usd(s.avgChampionCostUsd)} → {usd(s.avgChallengerCostUsd)}
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
        {options.length > 0 ? (
          <Select value={challenger} onValueChange={(v) => v != null && setChallenger(v)}>
            <SelectTrigger id="challenger" className="w-full">
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {options.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  {m.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id="challenger"
            placeholder="anthropic/claude-sonnet-4.6"
            value={challenger}
            onChange={(e) => setChallenger(e.target.value)}
          />
        )}
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

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getEvalRunDetail, type EvalRunDetail, type EvalSampleListRow } from '@/lib/admin/queries';
import { requireViewer } from '@/lib/auth/viewer';
import { effectiveWinner } from '@/lib/eval/confidence';
import { deblindReason, shortModel } from '@/lib/eval/deblind';
import { LocalTime } from '@/components/admin/local-time';
import { AutoRefresh } from '@/components/admin/auto-refresh';
import { EvalRunCancel } from '@/components/admin/eval-run-cancel';
import {
  CostPerTask,
  pct,
  REC_LABEL,
  RUN_STATUS_META,
  sideMeta,
  usd,
  WinBar,
} from '@/components/admin/eval-visuals';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function EvalRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireViewer();
  const run = await getEvalRunDetail(viewer, id);
  if (!run) notFound();

  const status = RUN_STATUS_META[run.status] ?? RUN_STATUS_META.failed;
  // Winner/confidence columns survive the post-finalize content purge, so the
  // win bar and judgments render for completed runs too — only cancelled runs
  // (samples hard-deleted) have nothing to chart.
  const judgments = run.samples
    .filter((s) => s.status === 'judged')
    .map((s) => ({
      winner: s.winner ?? ('tie' as const),
      confidence: s.confidence ?? 0,
      reason: s.judgeReason ?? '',
      orderSwapped: s.orderSwapped,
    }));

  const meta = [
    `judged ${run.judgedN}`,
    run.pendingN > 0 ? `pending ${run.pendingN}` : null,
    run.failedN > 0 ? `failed ${run.failedN}` : null,
    run.evalCostUsd != null ? `eval spend ${usd(run.evalCostUsd)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="space-y-6">
      {run.status === 'running' && <AutoRefresh />}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/admin/evals" className="text-sm text-primary hover:underline">
            ← Evals
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">
            {shortModel(run.championModel)} vs {shortModel(run.challengerModel)}
          </h1>
          <p className="text-sm text-muted-foreground">
            Started <LocalTime value={run.createdAt.toISOString()} /> · key{' '}
            {run.keyName ?? `${run.apiKeyId.slice(0, 8)}… (deleted)`}
          </p>
        </div>
        {run.status === 'running' && <EvalRunCancel runId={run.id} />}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={status.variant}>{status.label}</Badge>
        <span className="tabular-nums text-muted-foreground">
          captured {run.capturedN}/{run.targetN}
        </span>
        {meta && <span className="tabular-nums text-muted-foreground">· {meta}</span>}
      </div>

      {run.status === 'running' && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
          Capturing the next {run.targetN} successful requests on this key; the challenger and
          judge run in the background every 15 minutes. Results below update live.
        </div>
      )}

      {run.status === 'cancelled' && (
        <div className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
          This run was cancelled
          {run.completedAt && (
            <>
              {' '}
              on <LocalTime value={run.completedAt.toISOString()} />
            </>
          )}
          . Its captured samples — including any judgments — were purged, so only the run’s
          metadata and recorded spend are retained.
        </div>
      )}

      {run.status === 'completed' && run.summary && <SummaryCard run={run} />}

      {judgments.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <WinBar
            judgments={judgments}
            championModel={run.championModel}
            challengerModel={run.challengerModel}
          />
          <CostPerTask
            championModel={run.championModel}
            challengerModel={run.challengerModel}
            avgChampionCostUsd={run.avgChampionCostUsd}
            avgChallengerCostUsd={run.avgChallengerCostUsd}
          />
        </div>
      )}

      <FactsCard run={run} />

      {run.samples.length > 0 && <SamplesTable run={run} />}
    </div>
  );
}

function SummaryCard({ run }: { run: EvalRunDetail }) {
  const s = run.summary!;
  const rec = REC_LABEL[s.recommendation] ?? REC_LABEL.inconclusive;
  const delta = s.projectedMonthlyCostDeltaUsd;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">Verdict</CardTitle>
          <Badge variant={rec.variant}>{rec.text}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">{s.headline}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
          <Fact label="Samples" value={String(s.total)} />
          <Fact
            label="Wins (chall / champ / tie)"
            value={`${s.winsChallenger} / ${s.winsChampion} / ${s.ties}`}
          />
          <Fact
            label="Challenger win-rate (decided)"
            value={`${pct(s.challengerWinRate)}${s.ci ? ` (CI ${pct(s.ci.low)}–${pct(s.ci.high)})` : ''}`}
          />
          <Fact label="Tie rate" value={pct(s.tieRate)} />
          <Fact
            label="Avg latency (champ → chall)"
            value={`${s.avgChampionLatencyMs != null ? `${Math.round(s.avgChampionLatencyMs)}ms` : '—'} → ${
              s.avgChallengerLatencyMs != null ? `${Math.round(s.avgChallengerLatencyMs)}ms` : '—'
            }`}
          />
          <Fact
            label="Projected monthly impact"
            value={
              delta != null
                ? `${delta < 0 ? '−' : '+'}$${Math.abs(delta).toFixed(2)}/mo${
                    s.monthlyRequests != null ? ` (${s.monthlyRequests} req, trailing 30d)` : ''
                  }`
                : '—'
            }
          />
        </dl>
      </CardContent>
    </Card>
  );
}

function Fact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      {/* Model ids render mono like everywhere else in the admin. */}
      <dd className={mono ? 'font-mono text-xs leading-5' : 'tabular-nums'}>{value}</dd>
    </div>
  );
}

function FactsCard({ run }: { run: EvalRunDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Run configuration</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm md:grid-cols-3">
          <Fact label="Champion (at start)" value={run.championModel} mono />
          <Fact label="Challenger" value={run.challengerModel} mono />
          <Fact label="Judge" value={run.judgeModel} mono />
          <Fact label="Target samples" value={String(run.targetN)} />
          <div>
            <dt className="text-xs text-muted-foreground">Ended</dt>
            <dd className="tabular-nums">
              {run.completedAt ? <LocalTime value={run.completedAt.toISOString()} /> : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Verdict emailed</dt>
            <dd className="tabular-nums">
              {run.emailedAt ? <LocalTime value={run.emailedAt.toISOString()} /> : '—'}
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function SamplesTable({ run }: { run: EvalRunDetail }) {
  return (
    <div className="space-y-1.5">
      {/* "Captured", not "Samples": the Verdict card's "Samples" is the frozen
          judged-only total — failed rows are counted here but not there. */}
      <h2 className="text-sm font-medium text-muted-foreground">
        Captured samples ({run.samples.length})
      </h2>
      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Verdict</TableHead>
              <TableHead className="text-right">Conf.</TableHead>
              <TableHead>Judge’s reason</TableHead>
              <TableHead className="text-right">Cost (champ → chall)</TableHead>
              <TableHead className="text-right">Latency</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {run.samples.map((s) => (
              <SampleRow key={s.id} sample={s} run={run} />
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SampleRow({ sample: s, run }: { sample: EvalSampleListRow; run: EvalRunDetail }) {
  const judged = s.status === 'judged';
  const when = s.judgedAt ?? s.createdAt;
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
        <LocalTime value={when.toISOString()} />
      </TableCell>
      <TableCell>
        {judged ? (
          (() => {
            const meta = sideMeta(
              effectiveWinner(s.winner ?? 'tie', s.confidence ?? 0),
              run.championModel,
              run.challengerModel,
            );
            return (
              <Badge variant="outline" className={`shrink-0 ${meta.badge}`}>
                {meta.label}
              </Badge>
            );
          })()
        ) : (
          <Badge variant={s.status === 'failed' ? 'destructive' : 'outline'}>{s.status}</Badge>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {judged && s.confidence != null ? s.confidence.toFixed(2) : '—'}
      </TableCell>
      <TableCell className="max-w-md">
        {s.status === 'failed' ? (
          <span className="block truncate text-xs text-destructive" title={s.errorMessage ?? undefined}>
            {s.errorMessage ?? 'failed'}
          </span>
        ) : (
          (() => {
            const reason = s.judgeReason
              ? deblindReason(s.judgeReason, s.orderSwapped, run.championModel, run.challengerModel)
              : '';
            return reason ? (
              <span className="block truncate text-xs text-muted-foreground" title={reason}>
                {reason}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            );
          })()
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        {usd(s.championCostUsd)} → {usd(s.challengerCostUsd)}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        {s.championLatencyMs != null ? `${s.championLatencyMs}ms` : '—'} →{' '}
        {s.challengerLatencyMs != null ? `${s.challengerLatencyMs}ms` : '—'}
      </TableCell>
      <TableCell className="text-right">
        {/* Pending samples have no challenger call yet — the log detail gate
            (judged/failed only) would 404, so no link. */}
        {s.status !== 'pending' && (
          <Button
            render={<Link href={`/admin/logs/${s.id}`} />}
            nativeButton={false}
            size="sm"
            variant="ghost"
          >
            View
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

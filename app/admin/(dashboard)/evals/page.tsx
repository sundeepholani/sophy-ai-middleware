import Link from 'next/link';
import { listEvalRuns } from '@/lib/admin/queries';
import type { EvalRunStatus } from '@/db/schema';
import { requireViewer } from '@/lib/auth/viewer';
import { cn } from '@/lib/utils';
import { EvalsTable } from '@/components/admin/evals-table';
import { AutoRefresh } from '@/components/admin/auto-refresh';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

// 'failed' is reserved in the enum but unreachable today (only samples fail),
// so it gets no pill; a defensive row under "All" is enough if one ever appears.
const FILTERS: { value: EvalRunStatus | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

export default async function EvalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const status: EvalRunStatus | undefined =
    sp.status === 'running' || sp.status === 'completed' || sp.status === 'cancelled'
      ? sp.status
      : undefined;

  // One fetch serves both the tiles (always across ALL runs) and the table
  // (status-filtered) — runs are operator-initiated, so the table is small.
  const runs = await listEvalRuns(viewer);
  const shown = status ? runs.filter((r) => r.status === status) : runs;

  const runningN = runs.filter((r) => r.status === 'running').length;
  const completedN = runs.filter((r) => r.status === 'completed').length;
  const spend = runs.reduce((sum, r) => sum + (r.evalCostUsd ?? 0), 0);

  return (
    <div className="space-y-6">
      {/* Live progress while any run is judging — same cadence as the eval dialog. */}
      {runningN > 0 && <AutoRefresh />}

      <div>
        <h1 className="text-2xl font-semibold">Evals</h1>
        <p className="text-sm text-muted-foreground">
          Every champion-vs-challenger eval, current and past. Challenger and judge spend is
          tracked here — it is never billed to the key, and it survives cancellation. Start
          runs from the API Keys page.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Eval runs" value={String(runs.length)} />
        <Stat label="Running now" value={String(runningN)} />
        <Stat label="Completed" value={String(completedN)} />
        <Stat label="Eval spend (recorded)" value={`$${spend.toFixed(4)}`} />
      </div>

      {/* Status filter — applied server-side; search narrows within. */}
      <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
        {FILTERS.map((f) => {
          const active = (status ?? 'all') === f.value;
          return (
            <Link
              key={f.value}
              href={f.value === 'all' ? '/admin/evals' : `/admin/evals?status=${f.value}`}
              className={cn(
                'rounded px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {f.label}
            </Link>
          );
        })}
      </div>

      <EvalsTable
        runs={shown}
        emptyMessage={
          status && runs.length > 0
            ? `No ${status} evals.`
            : 'No eval runs yet — start one from the flask icon on the API Keys page.'
        }
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

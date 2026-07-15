import Link from 'next/link';
import { listEvalRuns } from '@/lib/admin/queries';
import type { EvalRunStatus } from '@/db/schema';
import { requireProjectViewer } from '@/lib/auth/viewer';
import { cn } from '@/lib/utils';
import { projectPath } from '@/components/admin/project-path';
import { EvalsTable } from '@/components/admin/evals-table';
import { AutoRefresh } from '@/components/admin/auto-refresh';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

const FILTERS: { value: EvalRunStatus | 'all'; label: string }[] = [
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'all', label: 'All' },
];

export default async function EvalsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ status?: string }>;
}) {
  const [{ projectId }, sp] = await Promise.all([params, searchParams]);
  const viewer = await requireProjectViewer(projectId);
  const status: EvalRunStatus | 'all' =
    sp.status === 'all' || sp.status === 'completed' || sp.status === 'cancelled'
      ? sp.status
      : 'running';
  const runs = await listEvalRuns(viewer);
  const shown = status === 'all' ? runs : runs.filter((run) => run.status === status);
  const runningN = runs.filter((run) => run.status === 'running').length;
  const completedN = runs.filter((run) => run.status === 'completed').length;
  const spend = runs.reduce((sum, run) => sum + (run.evalCostUsd ?? 0), 0);
  const basePath = projectPath(projectId, 'evals');

  return (
    <div className="space-y-6">
      {runningN > 0 && <AutoRefresh />}

      <div>
        <h1 className="text-2xl font-semibold">Evals</h1>
        <p className="text-sm text-muted-foreground">
          Champion-vs-challenger evals inside {viewer.projectName}. Start a run from Sophy API keys.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Eval runs" value={String(runs.length)} />
        <Stat label="Running now" value={String(runningN)} />
        <Stat label="Completed" value={String(completedN)} />
        <Stat label="Eval spend" value={`$${spend.toFixed(4)}`} />
      </div>

      <div className="inline-flex max-w-full overflow-x-auto rounded-md border bg-muted/40 p-0.5">
        {FILTERS.map((filter) => {
          const active = status === filter.value;
          return (
            <Link
              key={filter.value}
              href={filter.value === 'running' ? basePath : `${basePath}?status=${filter.value}`}
              className={cn(
                'whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {filter.label}
            </Link>
          );
        })}
      </div>

      <EvalsTable
        projectId={projectId}
        runs={shown}
        emptyMessage={
          status !== 'all' && runs.length > 0
            ? `No ${status} evals.`
            : 'No eval runs yet — start one from a Sophy API key.'
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

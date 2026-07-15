import Link from 'next/link';
import { getRecentLogs, type LogSource } from '@/lib/admin/queries';
import { requireProjectViewer } from '@/lib/auth/viewer';
import { cn } from '@/lib/utils';
import { projectPath } from '@/components/admin/project-path';
import { LogsTable } from '@/components/admin/logs-table';

export const dynamic = 'force-dynamic';

const FILTERS: { value: LogSource | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'proxy', label: 'Proxy' },
  { value: 'challenger', label: 'Challenger' },
  { value: 'judge', label: 'Judge' },
  { value: 'kb', label: 'KB' },
];

const SOURCES: LogSource[] = ['proxy', 'challenger', 'judge', 'kb'];

export default async function LogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ source?: string }>;
}) {
  const [{ projectId }, sp] = await Promise.all([params, searchParams]);
  const viewer = await requireProjectViewer(projectId);
  const source = SOURCES.find((candidate) => candidate === sp.source);
  const logs = await getRecentLogs(viewer, 100, source);
  const basePath = projectPath(projectId, 'logs');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Request logs</h1>
        <p className="text-sm text-muted-foreground">
          The most recent requests in {viewer.projectName}, including proxy traffic and Sophy’s
          eval and knowledgebase Gateway calls.
        </p>
      </div>

      <div className="inline-flex max-w-full overflow-x-auto rounded-md border bg-muted/40 p-0.5">
        {FILTERS.map((filter) => {
          const active = (source ?? 'all') === filter.value;
          return (
            <Link
              key={filter.value}
              href={filter.value === 'all' ? basePath : `${basePath}?source=${filter.value}`}
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

      <LogsTable projectId={projectId} logs={logs} />
    </div>
  );
}

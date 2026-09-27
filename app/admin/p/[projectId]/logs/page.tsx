import Link from 'next/link';
import { getRecentLogs, listKeys, type LogSource } from '@/lib/admin/queries';
import { requireProjectViewer } from '@/lib/auth/viewer';
import { cn } from '@/lib/utils';
import { projectPath } from '@/components/admin/project-path';
import { LogsTable } from '@/components/admin/logs-table';
import { LogsKeyFilter } from '@/components/admin/logs-key-filter';

export const dynamic = 'force-dynamic';

const FILTERS: { value: LogSource | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'proxy', label: 'Proxy' },
  { value: 'processor', label: 'Transcript processor' },
  { value: 'challenger', label: 'Challenger' },
  { value: 'judge', label: 'Judge' },
  { value: 'kb', label: 'KB' },
];

const SOURCES: LogSource[] = ['proxy', 'processor', 'challenger', 'judge', 'kb'];

export default async function LogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectId: string }>;
  searchParams: Promise<{ source?: string; key?: string }>;
}) {
  const [{ projectId }, sp] = await Promise.all([params, searchParams]);
  const viewer = await requireProjectViewer(projectId);
  const source = SOURCES.find((candidate) => candidate === sp.source);
  // As on Usage, only a key this viewer can see becomes a filter; an unknown or
  // out-of-scope ?key= falls back to all keys and never reaches the SQL.
  const keys = await listKeys(viewer);
  const keyId = sp.key && keys.some((key) => key.id === sp.key) ? sp.key : undefined;
  const logs = await getRecentLogs(viewer, 100, source, keyId);
  const basePath = projectPath(projectId, 'logs');
  const sourceHref = (value: LogSource | 'all') => {
    const query = new URLSearchParams();
    if (value !== 'all') query.set('source', value);
    if (keyId) query.set('key', keyId);
    const qs = query.toString();
    return qs ? `${basePath}?${qs}` : basePath;
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Request logs</h1>
        <p className="text-sm text-muted-foreground">
          The most recent client requests and component Gateway calls in {viewer.projectName},
          including transcript processing and Sophy’s eval and knowledgebase work.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex max-w-full overflow-x-auto rounded-md border bg-muted/40 p-0.5">
          {FILTERS.map((filter) => {
            const active = (source ?? 'all') === filter.value;
            return (
              <Link
                key={filter.value}
                href={sourceHref(filter.value)}
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
        <LogsKeyFilter
          keys={keys.map((key) => ({ id: key.id, name: key.name }))}
          current={keyId ?? 'all'}
        />
      </div>

      <LogsTable projectId={projectId} logs={logs} />
    </div>
  );
}

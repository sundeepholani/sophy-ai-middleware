import Link from 'next/link';
import { getRecentLogs, type LogSource } from '@/lib/admin/queries';
import { requireViewer } from '@/lib/auth/viewer';
import { cn } from '@/lib/utils';
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
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const source = SOURCES.find((s) => s === sp.source);
  const logs = await getRecentLogs(viewer, 100, source);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Request logs</h1>
        <p className="text-sm text-muted-foreground">
          Most recent 100 requests — live proxy traffic plus Sophy’s own gateway calls: eval
          challenger and judge models, and knowledgebase embeddings.
        </p>
      </div>

      {/* Source filter — eval runs and KB ingestion can flood the list with
          non-client calls, so let the operator isolate or hide them. Applied
          server-side (before the 100-row limit); search narrows within. */}
      <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
        {FILTERS.map((f) => {
          const active = (source ?? 'all') === f.value;
          return (
            <Link
              key={f.value}
              href={f.value === 'all' ? '/admin/logs' : `/admin/logs?source=${f.value}`}
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

      <LogsTable logs={logs} />
    </div>
  );
}

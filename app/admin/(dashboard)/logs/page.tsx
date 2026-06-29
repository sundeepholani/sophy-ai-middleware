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
];

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const viewer = await requireViewer();
  const sp = await searchParams;
  const source: LogSource | undefined = sp.source === 'proxy' || sp.source === 'challenger' ? sp.source : undefined;
  const logs = await getRecentLogs(viewer, 100, source);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Request logs</h1>
        <p className="text-sm text-muted-foreground">
          Most recent 100 requests — live proxy traffic plus eval challenger model calls.
        </p>
      </div>

      {/* Source filter — challenger runs can produce many samples, so let the
          operator isolate or hide them. Applied server-side; search narrows within. */}
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

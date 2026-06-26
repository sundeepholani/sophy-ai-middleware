import Link from 'next/link';
import { getRecentLogs, type LogSource } from '@/lib/admin/queries';
import { requireViewer } from '@/lib/auth/viewer';
import { LocalTime } from '@/components/admin/local-time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
          operator isolate or hide them. */}
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

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Model</TableHead>
              <TableHead className="text-right">In</TableHead>
              <TableHead className="text-right">Out</TableHead>
              <TableHead className="text-right">Cost</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {logs.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  <LocalTime value={l.createdAt.toISOString()} />
                </TableCell>
                <TableCell className="font-medium">{l.keyName ?? l.apiKeyId.slice(0, 8)}</TableCell>
                <TableCell className="font-mono text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    {l.model ?? '—'}
                    {l.source === 'challenger' && (
                      <Badge variant="secondary" className="font-sans">
                        challenger
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{l.inputTokens ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{l.outputTokens ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {l.costUsd ? `$${Number(l.costUsd).toFixed(4)}` : '—'}
                </TableCell>
                <TableCell>
                  {l.responseKind ?? '—'}
                  {l.streamed ? ' · stream' : ''}
                </TableCell>
                <TableCell>
                  <Badge variant={l.status === 'ok' ? 'default' : 'destructive'}>{l.status}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    render={<Link href={`/admin/logs/${l.id}`} />}
                    nativeButton={false}
                    size="sm"
                    variant="ghost"
                  >
                    View
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {logs.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-sm text-muted-foreground">
                  No requests yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

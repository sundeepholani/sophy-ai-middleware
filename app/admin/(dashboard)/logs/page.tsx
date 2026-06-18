import Link from 'next/link';
import { getRecentLogs } from '@/lib/admin/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function LogsPage() {
  const logs = await getRecentLogs(100);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Request logs</h1>
        <p className="text-sm text-muted-foreground">Most recent 100 proxied requests.</p>
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
                  {new Date(l.createdAt).toLocaleString()}
                </TableCell>
                <TableCell className="font-mono text-xs">{l.apiKeyId.slice(0, 8)}</TableCell>
                <TableCell className="font-mono text-xs">{l.model ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{l.inputTokens}</TableCell>
                <TableCell className="text-right tabular-nums">{l.outputTokens}</TableCell>
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

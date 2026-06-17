import { getRecentLogs } from '@/lib/admin/queries';
import { Badge } from '@/components/ui/badge';
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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Route</TableHead>
            <TableHead>Model</TableHead>
            <TableHead>In</TableHead>
            <TableHead>Out</TableHead>
            <TableHead>Cost</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {logs.map((l) => (
            <TableRow key={l.id}>
              <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                {new Date(l.createdAt).toLocaleString()}
              </TableCell>
              <TableCell className="font-mono text-xs">{l.routeName ?? '—'}</TableCell>
              <TableCell className="font-mono text-xs">{l.model ?? '—'}</TableCell>
              <TableCell>{l.inputTokens}</TableCell>
              <TableCell>{l.outputTokens}</TableCell>
              <TableCell>{l.costUsd ? `$${Number(l.costUsd).toFixed(5)}` : '—'}</TableCell>
              <TableCell>
                {l.responseKind ?? '—'}
                {l.streamed ? ' · stream' : ''}
              </TableCell>
              <TableCell>
                <Badge variant={l.status === 'ok' ? 'default' : 'destructive'}>{l.status}</Badge>
              </TableCell>
            </TableRow>
          ))}
          {logs.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                No requests yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

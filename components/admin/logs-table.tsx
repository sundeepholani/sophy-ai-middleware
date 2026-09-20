'use client';

import Link from 'next/link';
import type { LogListRow } from '@/lib/admin/queries';
import { LocalTime } from '@/components/admin/local-time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableSearchBox, useTableFilter } from '@/components/admin/table-search';
import { projectPath } from '@/components/admin/project-path';
import { formatUsd } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** Request-logs table with a free-text search over the loaded rows. The source
 *  filter (All/Proxy/Challenger) is applied server-side on the page; this narrows
 *  within the rows it returns. */
export function LogsTable({ projectId, logs }: { projectId: string; logs: LogListRow[] }) {
  const { query, setQuery, filtered } = useTableFilter(logs, (l) =>
    [
      l.keyName ?? l.apiKeyId,
      l.model ?? '',
      l.source,
      l.responseKind ?? '',
      l.status,
      l.costUsd ?? '',
      String(l.inputTokens ?? ''),
      String(l.outputTokens ?? ''),
      l.createdAt.toISOString().slice(0, 10),
    ].join(' '),
  );

  return (
    <div className="space-y-4">
      <TableSearchBox value={query} onChange={setQuery} placeholder="Search logs…" label="Search logs" />

      <div className="overflow-x-auto rounded-lg border bg-card">
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
            {logs.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-sm text-muted-foreground">
                  No requests yet.
                </TableCell>
              </TableRow>
            )}
            {logs.length > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="h-24 text-center text-sm text-muted-foreground">
                  No logs match “{query.trim()}”.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((l) => (
              <TableRow key={l.id}>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                  <LocalTime value={l.createdAt.toISOString()} />
                </TableCell>
                <TableCell className="font-medium">
                  {l.keyName ?? (l.apiKeyId ? l.apiKeyId.slice(0, 8) : '—')}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    {l.model ?? '—'}
                    {l.source !== 'proxy' && (
                      <Badge variant="secondary" className="font-sans">
                        {l.source}
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{l.inputTokens ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">{l.outputTokens ?? '—'}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatUsd(l.costUsd == null ? null : Number(l.costUsd))}
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
                    render={<Link href={projectPath(projectId, `logs/${l.id}`)} />}
                    nativeButton={false}
                    size="sm"
                    variant="ghost"
                  >
                    View
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

'use client';

import Link from 'next/link';
import type { EvalRunListRow } from '@/lib/admin/queries';
import { shortModel } from '@/lib/eval/deblind';
import { LocalTime } from '@/components/admin/local-time';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableSearchBox, useTableFilter } from '@/components/admin/table-search';
import { pct, usd, REC_LABEL, RUN_STATUS_META } from '@/components/admin/eval-visuals';
import { projectPath } from '@/components/admin/project-path';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/** All eval runs, newest first, with a free-text search over the loaded rows.
 *  The status filter (All/Running/…) is applied server-side on the page; this
 *  narrows within the rows it returns. `emptyMessage` distinguishes "no runs at
 *  all" (onboarding copy) from "the status filter has no matches". */
export function EvalsTable({
  projectId,
  runs,
  emptyMessage,
}: {
  projectId: string;
  runs: EvalRunListRow[];
  emptyMessage: string;
}) {
  const { query, setQuery, filtered } = useTableFilter(runs, (r) =>
    [
      r.keyName ?? r.apiKeyId,
      r.championModel,
      r.challengerModel,
      r.status,
      r.recommendation ?? '',
      r.headline ?? '',
      r.createdAt.toISOString().slice(0, 10),
    ].join(' '),
  );

  return (
    <div className="space-y-4">
      <TableSearchBox value={query} onChange={setQuery} placeholder="Search evals…" label="Search evals" />

      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Champion → challenger</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Result</TableHead>
              <TableHead className="text-right">Win rate</TableHead>
              <TableHead className="text-right">Captured</TableHead>
              <TableHead className="text-right">Judged</TableHead>
              <TableHead className="text-right">Eval cost</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="h-24 text-center text-sm text-muted-foreground">
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
            {runs.length > 0 && filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={10} className="h-24 text-center text-sm text-muted-foreground">
                  No evals match “{query.trim()}”.
                </TableCell>
              </TableRow>
            )}
            {filtered.map((r) => {
              const status = RUN_STATUS_META[r.status] ?? RUN_STATUS_META.failed;
              const rec = r.recommendation ? REC_LABEL[r.recommendation] ?? REC_LABEL.inconclusive : null;
              return (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    <LocalTime value={r.createdAt.toISOString()} />
                  </TableCell>
                  <TableCell className="font-medium">
                    {r.keyName ?? (
                      <span className="text-muted-foreground" title={r.apiKeyId}>
                        {r.apiKeyId.slice(0, 8)}… (deleted)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs" title={`${r.championModel} → ${r.challengerModel}`}>
                    {shortModel(r.championModel)} → {shortModel(r.challengerModel)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </TableCell>
                  <TableCell>
                    {rec ? (
                      <Badge variant={rec.variant} title={r.headline ?? undefined}>
                        {rec.text}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{pct(r.challengerWinRate)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.capturedN}/{r.targetN}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.judgedN}
                    {r.failedN > 0 && (
                      <span className="text-destructive" title={`${r.failedN} sample${r.failedN === 1 ? '' : 's'} failed`}>
                        {' '}
                        · {r.failedN}✗
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{usd(r.evalCostUsd)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      render={<Link href={projectPath(projectId, `evals/${r.id}`)} />}
                      nativeButton={false}
                      size="sm"
                      variant="ghost"
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

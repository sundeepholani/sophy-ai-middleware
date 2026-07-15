'use client';

import type { UsageBreakdownRow } from '@/lib/admin/queries';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TableSearchBox, useTableFilter } from '@/components/admin/table-search';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const nf = new Intl.NumberFormat('en-US');

/** A usage breakdown table (by key / by model) with a free-text filter on the
 *  label column. */
export function UsageBreakdownCard({
  title,
  head,
  rows,
}: {
  title: string;
  head: string;
  rows: UsageBreakdownRow[];
}) {
  const { query, setQuery, filtered } = useTableFilter(rows, (r) => r.label);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length > 0 && (
          <TableSearchBox
            value={query}
            onChange={setQuery}
            placeholder={`Search by ${head.toLowerCase()}…`}
            label={`Search by ${head}`}
            className="max-w-none"
          />
        )}
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{head}</TableHead>
                <TableHead className="text-right">Req</TableHead>
                <TableHead className="text-right">In</TableHead>
                <TableHead className="text-right">Out</TableHead>
                <TableHead className="text-right">Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">
                    No usage in this range.
                  </TableCell>
                </TableRow>
              ) : filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-20 text-center text-sm text-muted-foreground">
                    No {head.toLowerCase()} matches “{query.trim()}”.
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((r) => (
                  <TableRow key={r.label}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{nf.format(r.requests)}</TableCell>
                    <TableCell className="text-right tabular-nums">{nf.format(r.inputTokens)}</TableCell>
                    <TableCell className="text-right tabular-nums">{nf.format(r.outputTokens)}</TableCell>
                    <TableCell className="text-right tabular-nums">${r.cost.toFixed(4)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

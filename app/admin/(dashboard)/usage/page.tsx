import {
  getUsageSeries,
  getUsageTotals,
  getUsageByKey,
  getUsageByModel,
  listKeys,
  listUsedModels,
  type UsageBreakdownRow,
  type UsageFilters,
} from '@/lib/admin/queries';
import { requireViewer } from '@/lib/auth/viewer';
import { UsageChart } from '@/components/admin/usage-chart';
import { UsageFilters as UsageFilterBar } from '@/components/admin/usage-filters';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

const ALLOWED_RANGES = [7, 30, 90];
const nf = new Intl.NumberFormat('en-US');

export default async function UsagePage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; key?: string; model?: string }>;
}) {
  const sp = await searchParams;
  const sinceDays = ALLOWED_RANGES.includes(Number(sp.range)) ? Number(sp.range) : 30;
  const keyId = sp.key || undefined;
  const model = sp.model || undefined;
  const filters: UsageFilters = { sinceDays, keyId, model };
  const viewer = await requireViewer();

  const [series, totals, byKey, byModel, keys, models] = await Promise.all([
    getUsageSeries(viewer, filters),
    getUsageTotals(viewer, filters),
    getUsageByKey(viewer, filters),
    getUsageByModel(viewer, filters),
    listKeys(viewer),
    listUsedModels(viewer),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="text-sm text-muted-foreground">
          Token volume and cost, broken down by key and model. Cost is our real-time estimate from
          the AI Gateway; reconcile against the Gateway report for billing-grade numbers.
        </p>
      </div>

      <UsageFilterBar
        keys={keys.map((k) => ({ id: k.id, name: k.name }))}
        models={models}
        current={{ range: String(sinceDays), key: keyId ?? 'all', model: model ?? 'all' }}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Requests" value={nf.format(totals.requests)} />
        <Stat label="Input tokens" value={nf.format(totals.inputTokens)} />
        <Stat label="Output tokens" value={nf.format(totals.outputTokens)} />
        <Stat label="Est. cost" value={`$${totals.cost.toFixed(4)}`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cost per day</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageChart data={series} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <BreakdownCard title="By key" head="Key" rows={byKey} />
        <BreakdownCard title="By model" head="Model" rows={byModel} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
      </CardContent>
    </Card>
  );
}

function BreakdownCard({
  title,
  head,
  rows,
}: {
  title: string;
  head: string;
  rows: UsageBreakdownRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-lg border">
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
              ) : (
                rows.map((r) => (
                  <TableRow key={r.label}>
                    <TableCell className="font-medium">{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{nf.format(r.requests)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {nf.format(r.inputTokens)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {nf.format(r.outputTokens)}
                    </TableCell>
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

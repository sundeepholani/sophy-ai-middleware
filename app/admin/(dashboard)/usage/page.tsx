import {
  getUsageStacked,
  getUsageTotals,
  getUsageByKey,
  getUsageByModel,
  listKeys,
  listUsedModels,
  type UsageFilters,
} from '@/lib/admin/queries';
import { requireViewer } from '@/lib/auth/viewer';
import { UsageShareChart } from '@/components/admin/usage-share-chart';
import { UsageFilters as UsageFilterBar } from '@/components/admin/usage-filters';
import { UsageBreakdownCard } from '@/components/admin/usage-breakdown';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

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
  const viewer = await requireViewer();

  const [keys, models] = await Promise.all([listKeys(viewer), listUsedModels(viewer)]);

  // Only honor a key/model filter that refers to a real owned key / seen model.
  // This both (a) avoids a Postgres uuid-cast error from a crafted non-UUID ?key=
  // (apiKeyId is a uuid column), and (b) keeps the filter Select from rendering a
  // blank value its option list doesn't contain — display and query stay in sync.
  const keyId = sp.key && keys.some((k) => k.id === sp.key) ? sp.key : undefined;
  const model = sp.model && models.includes(sp.model) ? sp.model : undefined;
  const filters: UsageFilters = { sinceDays, keyId, model };

  const [stackedModel, stackedKey, totals, byKey, byModel] = await Promise.all([
    getUsageStacked(viewer, filters, 'model'),
    getUsageStacked(viewer, filters, 'key'),
    getUsageTotals(viewer, filters),
    getUsageByKey(viewer, filters),
    getUsageByModel(viewer, filters),
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
          <CardTitle className="text-base">Usage share over time</CardTitle>
        </CardHeader>
        <CardContent>
          <UsageShareChart data={{ model: stackedModel, key: stackedKey }} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <UsageBreakdownCard title="By key" head="Key" rows={byKey} />
        <UsageBreakdownCard title="By model" head="Model" rows={byModel} />
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


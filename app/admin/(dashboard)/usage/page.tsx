import { getUsageSeries } from '@/lib/admin/queries';
import { UsageChart } from '@/components/admin/usage-chart';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

export default async function UsagePage() {
  const series = await getUsageSeries();
  const totalTokens = series.reduce((a, b) => a + b.tokens, 0);
  const totalCost = series.reduce((a, b) => a + b.cost, 0);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="text-sm text-muted-foreground">
          Token volume per day (last 30 days). Cost is our real-time estimate from the AI Gateway;
          reconcile against the Gateway report for billing-grade numbers.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {totalTokens.toLocaleString()} tokens · ${totalCost.toFixed(4)} est.
          </CardTitle>
        </CardHeader>
        <CardContent>
          <UsageChart data={series} />
        </CardContent>
      </Card>
    </div>
  );
}

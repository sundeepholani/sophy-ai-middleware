import { getOverview } from '@/lib/admin/queries';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}

export default async function OverviewPage() {
  const o = await getOverview();
  const nf = new Intl.NumberFormat('en-US');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">Last 30 days across all clients.</p>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Requests" value={nf.format(o.requests)} />
        <Stat label="Input tokens" value={nf.format(o.inputTokens)} />
        <Stat label="Output tokens" value={nf.format(o.outputTokens)} />
        <Stat label="Est. cost" value={`$${o.cost.toFixed(4)}`} />
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Errors" value={nf.format(o.errors)} />
      </div>
    </div>
  );
}

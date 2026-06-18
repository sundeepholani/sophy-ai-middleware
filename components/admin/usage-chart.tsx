'use client';

interface Point {
  day: string;
  requests: number;
  tokens: number;
  cost: number;
}

export function UsageChart({ data }: { data: Point[] }) {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No usage in the last 30 days.</p>;
  }
  const max = Math.max(1, ...data.map((d) => d.tokens));
  return (
    <div className="space-y-2">
      <div className="flex h-48 items-end gap-1 border-b">
        {data.map((d) => (
          <div key={d.day} className="group flex flex-1 flex-col items-center justify-end">
            <div
              className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
              style={{ height: d.tokens > 0 ? `max(2px, ${(d.tokens / max) * 100}%)` : '0px' }}
              title={`${d.day}: ${d.tokens.toLocaleString()} tokens, ${d.requests} req, $${d.cost.toFixed(4)}`}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{data[0]?.day}</span>
        <span>tokens / day</span>
        <span>{data[data.length - 1]?.day}</span>
      </div>
    </div>
  );
}

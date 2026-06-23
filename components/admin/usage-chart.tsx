'use client';

interface Point {
  day: string;
  requests: number;
  tokens: number;
  cost: number;
}

/** Compact USD: cents-precision once we're past a dollar, finer below. */
function usd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return '$0';
}

export function UsageChart({ data }: { data: Point[] }) {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">No usage in this range.</p>;
  }
  // Scale bars to the costliest day. Guard against an all-zero series.
  const max = Math.max(0, ...data.map((d) => d.cost));
  return (
    <div className="space-y-2">
      {/* Each column is h-full (a definite height) so the bar's percentage
          height resolves correctly; the row's items-end then sits them on the axis. */}
      <div className="flex h-48 items-end gap-1 border-b">
        {data.map((d) => (
          <div
            key={d.day}
            className="group flex h-full flex-1 flex-col justify-end"
            title={`${d.day}: ${usd(d.cost)} · ${d.requests} req · ${d.tokens.toLocaleString()} tokens`}
          >
            <div
              className="w-full rounded-t bg-primary/70 transition-colors group-hover:bg-primary"
              style={{ height: max > 0 && d.cost > 0 ? `max(2px, ${(d.cost / max) * 100}%)` : '0px' }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{data[0]?.day}</span>
        <span>$ / day</span>
        <span>{data[data.length - 1]?.day}</span>
      </div>
    </div>
  );
}

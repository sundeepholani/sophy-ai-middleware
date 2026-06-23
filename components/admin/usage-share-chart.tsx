'use client';

import { useMemo, useState } from 'react';
import type { UsageStackRow, UsageDimension } from '@/lib/admin/queries';

type Metric = 'cost' | 'requests' | 'tokens';
type Mode = 'share' | 'absolute';

const OTHER = '__other__';
const TOP_N = 9;

// Distinct, legible palette assigned by rank; "Other" is a muted pink.
const PALETTE = [
  '#0f766e', // teal
  '#7c3aed', // violet
  '#2563eb', // blue
  '#16a34a', // green
  '#0ea5e9', // sky
  '#c084fc', // light purple
  '#4d7c0f', // olive
  '#e11d48', // rose
  '#f59e0b', // amber
];
const OTHER_COLOR = '#f9a8d4';

const nf = new Intl.NumberFormat('en-US');
function fmt(metric: Metric, n: number): string {
  if (metric === 'cost') return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
  return nf.format(Math.round(n));
}

interface Legend {
  label: string;
  display: string;
  value: number;
  pct: number;
  color: string;
}

function shape(rows: UsageStackRow[], metric: Metric) {
  const val = (r: UsageStackRow) => r[metric];

  // Overall total per category → rank → top N + Other.
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.cat, (totals.get(r.cat) ?? 0) + val(r));
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const topCats = ranked.slice(0, TOP_N).map(([c]) => c);
  const topIndex = new Map(topCats.map((c, i) => [c, i]));
  const hasOther = ranked.length > TOP_N;
  const grand = ranked.reduce((s, [, v]) => s + v, 0);

  const colorOf = (cat: string) =>
    cat === OTHER ? OTHER_COLOR : PALETTE[(topIndex.get(cat) ?? 0) % PALETTE.length];

  const legend: Legend[] = topCats.map((c) => ({
    label: c,
    display: c,
    value: totals.get(c) ?? 0,
    pct: grand > 0 ? ((totals.get(c) ?? 0) / grand) * 100 : 0,
    color: colorOf(c),
  }));
  if (hasOther) {
    const otherTotal = ranked.slice(TOP_N).reduce((s, [, v]) => s + v, 0);
    legend.push({
      label: OTHER,
      display: 'Other',
      value: otherTotal,
      pct: grand > 0 ? (otherTotal / grand) * 100 : 0,
      color: OTHER_COLOR,
    });
  }

  // Per-day value per stacking bucket (top cats individually, rest → Other).
  const days = [...new Set(rows.map((r) => r.day))].sort();
  const perDay = new Map<string, Map<string, number>>();
  const dayTotal = new Map<string, number>();
  for (const r of rows) {
    const bucket = topIndex.has(r.cat) ? r.cat : OTHER;
    if (!perDay.has(r.day)) perDay.set(r.day, new Map());
    const m = perDay.get(r.day)!;
    m.set(bucket, (m.get(bucket) ?? 0) + val(r));
    dayTotal.set(r.day, (dayTotal.get(r.day) ?? 0) + val(r));
  }
  // Busiest day — the full-height reference for absolute mode.
  const maxTotal = Math.max(0, ...days.map((d) => dayTotal.get(d) ?? 0));

  // Stack bottom→top by rank, Other on top — so render order is top→bottom = reversed.
  const order = [...topCats, ...(hasOther ? [OTHER] : [])];
  const renderOrder = [...order].reverse();

  const columns = days.map((d) => {
    const m = perDay.get(d);
    const total = dayTotal.get(d) ?? 0;
    const segments = renderOrder
      .map((cat) => ({ cat, value: m?.get(cat) ?? 0, color: colorOf(cat) }))
      .filter((s) => s.value > 0)
      .map((s) => ({
        ...s,
        // share% within the day, and absolute% of the busiest day
        pct: total > 0 ? (s.value / total) * 100 : 0,
        abs: maxTotal > 0 ? (s.value / maxTotal) * 100 : 0,
      }));
    return { day: d, total, segments };
  });

  return { legend, columns, days };
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
            value === o.value
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function UsageShareChart({
  data,
}: {
  data: Record<UsageDimension, UsageStackRow[]>;
}) {
  // Defaults: by API key, absolute values, cost.
  const [dim, setDim] = useState<UsageDimension>('key');
  const [metric, setMetric] = useState<Metric>('cost');
  const [mode, setMode] = useState<Mode>('absolute');
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    cat: string;
    day: string;
    value: number;
    pct: number;
  } | null>(null);
  const { legend, columns, days } = useMemo(() => shape(data[dim], metric), [data, dim, metric]);

  const empty = columns.every((c) => c.total <= 0);

  return (
    <div className="space-y-4">
      {/* All toggles left-aligned; each toggle's default option is listed first (leftmost). */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={dim}
          onChange={setDim}
          options={[
            { value: 'key', label: 'By API key' },
            { value: 'model', label: 'By model' },
          ]}
        />
        <Segmented
          value={metric}
          onChange={setMetric}
          options={[
            { value: 'cost', label: 'Cost' },
            { value: 'requests', label: 'Requests' },
            { value: 'tokens', label: 'Tokens' },
          ]}
        />
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'absolute', label: 'Absolute' },
            { value: 'share', label: 'Share %' },
          ]}
        />
      </div>

      {empty ? (
        <p className="py-12 text-center text-sm text-muted-foreground">No usage in this range.</p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          {/* Each column is a full-height (definite) flex box so segment heights
              resolve as percentages. Share mode fills each column to 100%;
              absolute mode scales to the busiest day, so segments anchor to the
              bottom (justify-end) and short days leave a gap on top. */}
          <div className="min-w-0 flex-1">
            {/* p-2 insets the bars so the rounded border never clips them. */}
            <div
              className="flex h-64 items-stretch gap-px rounded-md border bg-muted/20 p-2"
              onMouseLeave={() => setHover(null)}
            >
              {columns.map((c) => (
                <div key={c.day} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                  {c.segments.map((s) => {
                    const label = s.cat === OTHER ? 'Other' : s.cat;
                    return (
                      <div
                        key={s.cat}
                        className="w-full transition-opacity hover:opacity-80"
                        style={{ height: `${mode === 'share' ? s.pct : s.abs}%`, backgroundColor: s.color }}
                        onMouseMove={(e) =>
                          setHover({
                            x: e.clientX,
                            y: e.clientY,
                            cat: label,
                            day: c.day,
                            value: s.value,
                            pct: s.pct,
                          })
                        }
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between text-xs text-muted-foreground">
              <span>{days[0]}</span>
              <span>{mode === 'share' ? `share of ${metric}` : metric} / day</span>
              <span>{days[days.length - 1]}</span>
            </div>
          </div>

          {/* Legend: ranked over the whole range — % in share mode, totals in absolute mode. */}
          <ol className="w-full shrink-0 space-y-1.5 text-sm lg:w-64">
            {legend.map((l, i) => (
              <li key={l.label} className="flex items-center gap-2">
                <span className="w-4 text-right text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: l.color }}
                />
                <span className="min-w-0 flex-1 truncate" title={l.display}>
                  {l.display}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {mode === 'share' ? `${l.pct.toFixed(1)}%` : fmt(metric, l.value)}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Cursor-following tooltip with the hovered bar's value + share. */}
      {hover && (
        <div
          className="pointer-events-none fixed z-50 rounded-md bg-foreground px-2 py-1 text-xs text-background shadow-md"
          style={{ left: hover.x, top: hover.y, transform: 'translate(10px, calc(-100% - 10px))' }}
        >
          <div className="font-medium">{hover.cat}</div>
          <div className="opacity-80">
            {hover.day} · {fmt(metric, hover.value)} · {hover.pct.toFixed(1)}%
          </div>
        </div>
      )}
    </div>
  );
}

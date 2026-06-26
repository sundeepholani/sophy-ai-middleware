'use client';

import { useMemo, useState } from 'react';
import type { UsageStackRow, UsageDimension } from '@/lib/admin/queries';

type Metric = 'cost' | 'requests' | 'tokens';
type Mode = 'share' | 'absolute';

// Sentinel for the aggregated "Other" bucket. The leading NUL byte makes it
// impossible to collide with a real category: `cat` is a model id or a key name,
// both read from Postgres text columns, which cannot store NUL. (It's only ever a
// map key / comparison target — the user-facing label is always "Other".)
const OTHER = `${String.fromCharCode(0)}other`;
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
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

function fmt(metric: Metric, n: number): string {
  if (metric === 'cost') return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
  return nf.format(Math.round(n));
}

/** Short label for axis ticks + per-column totals (keeps narrow columns legible). */
function fmtCompact(metric: Metric, n: number): string {
  if (metric === 'cost') {
    if (n === 0) return '$0';
    return n >= 1 ? `$${compact.format(n)}` : `$${n.toFixed(2)}`;
  }
  return compact.format(Math.round(n));
}

/** A "nice" axis ceiling + tick step for [0, max] using 1/2/2.5/5/10 steps. */
function niceScale(max: number, ticks = 4): { max: number; step: number } {
  if (!(max > 0)) return { max: 1, step: 1 };
  const rawStep = max / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const niceStep = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(max / niceStep) * niceStep, step: niceStep };
}

interface Legend {
  label: string;
  display: string;
  value: number;
  pct: number;
  color: string;
}

interface Segment {
  cat: string;
  value: number;
  color: string;
}
interface Column {
  day: string;
  /** Stacking buckets for this day, in render (top→bottom) order, value > 0. */
  segments: Segment[];
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
  for (const r of rows) {
    const bucket = topIndex.has(r.cat) ? r.cat : OTHER;
    if (!perDay.has(r.day)) perDay.set(r.day, new Map());
    const m = perDay.get(r.day)!;
    m.set(bucket, (m.get(bucket) ?? 0) + val(r));
  }

  // Stack bottom→top by rank, Other on top — so DOM (top→bottom) order is reversed.
  const renderOrder = [...topCats, ...(hasOther ? [OTHER] : [])].reverse();

  const columns: Column[] = days.map((d) => {
    const m = perDay.get(d);
    const segments = renderOrder
      .map((cat) => ({ cat, value: m?.get(cat) ?? 0, color: colorOf(cat) }))
      .filter((s) => s.value > 0);
    return { day: d, segments };
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

// Vertical insets shared by the y-axis and the plot area so their `bottom: x%`
// positions line up. top headroom leaves room for the per-column total labels.
const PLOT_INSET = 'top-5 bottom-2';

export function UsageShareChart({
  data,
}: {
  data: Record<UsageDimension, UsageStackRow[]>;
}) {
  // Defaults: by API key, absolute values, cost.
  const [dim, setDim] = useState<UsageDimension>('key');
  const [metric, setMetric] = useState<Metric>('cost');
  const [mode, setMode] = useState<Mode>('absolute');
  // Legend filter: empty = show all; otherwise show only the selected categories.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    cat: string;
    day: string;
    value: number;
    pct: number;
  } | null>(null);

  const { legend, columns, days } = useMemo(() => shape(data[dim], metric), [data, dim, metric]);

  // Flipping the dimension (keys ↔ models) changes the category universe, so a
  // stale selection would filter to nothing — clear it alongside the switch.
  function changeDim(v: UsageDimension) {
    setDim(v);
    setSelected(new Set());
  }

  const filterActive = selected.size > 0;
  const isShown = (cat: string) => !filterActive || selected.has(cat);

  // Per-day totals over the currently-shown categories, and the busiest such day.
  const dayTotals = useMemo(
    () => columns.map((c) => c.segments.reduce((s, seg) => s + (isShown(seg.cat) ? seg.value : 0), 0)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, selected],
  );
  const filteredMax = Math.max(0, ...dayTotals);
  const empty = filteredMax <= 0;

  // y-axis scale + ticks: share mode is a fixed 0–100%, absolute uses a nice ceiling.
  const axis = mode === 'share' ? { max: 100, step: 25 } : niceScale(filteredMax);
  const ticks: number[] = [];
  if (axis.max > 0) for (let v = 0; v <= axis.max + axis.step * 1e-6; v += axis.step) ticks.push(v);

  function toggle(label: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      {/* All toggles left-aligned; each toggle's default option is listed first (leftmost). */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={dim}
          onChange={changeDim}
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
        <p className="py-12 text-center text-sm text-muted-foreground">
          {filterActive ? 'No usage for the selected series.' : 'No usage in this range.'}
        </p>
      ) : (
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="min-w-0 flex-1">
            <div className="flex gap-2">
              {/* y-axis tick values, aligned to the plot area's 0–100% range. */}
              <div className="relative h-64 w-12 shrink-0" aria-hidden>
                <div className={`absolute inset-x-0 ${PLOT_INSET}`}>
                  {ticks.map((t) => (
                    <div
                      key={t}
                      className="absolute right-1 translate-y-1/2 text-[10px] leading-none tabular-nums text-muted-foreground"
                      style={{ bottom: `${(t / axis.max) * 100}%` }}
                    >
                      {mode === 'share' ? `${t}%` : fmtCompact(metric, t)}
                    </div>
                  ))}
                </div>
              </div>

              {/* Plot: gridlines behind, stacked bars in front. */}
              <div className="relative h-64 min-w-0 flex-1 rounded-md border bg-muted/20">
                <div className={`absolute inset-x-2 ${PLOT_INSET}`}>
                  {/* Horizontal gridlines at each tick. */}
                  {ticks.map((t) => (
                    <div
                      key={t}
                      className="pointer-events-none absolute inset-x-0 border-t border-dashed border-border/60"
                      style={{ bottom: `${(t / axis.max) * 100}%` }}
                    />
                  ))}

                  <div
                    className="absolute inset-0 flex items-stretch gap-px"
                    onMouseLeave={() => setHover(null)}
                  >
                    {columns.map((c, ci) => {
                      const dayTotal = dayTotals[ci];
                      const barTop = mode === 'share' ? (dayTotal > 0 ? 100 : 0) : (dayTotal / axis.max) * 100;
                      return (
                        <div
                          key={c.day}
                          className="relative flex h-full min-w-0 flex-1 flex-col justify-end"
                        >
                          {/* Total for the day, riding just above the bar. */}
                          {dayTotal > 0 && (
                            <div
                              className="pointer-events-none absolute inset-x-0 text-center text-[10px] leading-none font-medium tabular-nums whitespace-nowrap text-foreground/75"
                              style={{ bottom: `calc(${barTop}% + 2px)` }}
                            >
                              {fmtCompact(metric, dayTotal)}
                            </div>
                          )}
                          {c.segments
                            .filter((s) => isShown(s.cat))
                            .map((s) => {
                              const label = s.cat === OTHER ? 'Other' : s.cat;
                              const pct = dayTotal > 0 ? (s.value / dayTotal) * 100 : 0;
                              const height = mode === 'share' ? pct : (s.value / axis.max) * 100;
                              return (
                                <div
                                  key={s.cat}
                                  className="w-full transition-opacity hover:opacity-80"
                                  style={{ height: `${height}%`, backgroundColor: s.color }}
                                  onMouseMove={(e) =>
                                    setHover({
                                      x: e.clientX,
                                      y: e.clientY,
                                      cat: label,
                                      day: c.day,
                                      value: s.value,
                                      pct,
                                    })
                                  }
                                />
                              );
                            })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-1 flex justify-between pl-14 text-xs text-muted-foreground">
              <span>{days[0]}</span>
              <span>{mode === 'share' ? `share of ${metric}` : metric} / day</span>
              <span>{days[days.length - 1]}</span>
            </div>
          </div>

          {/* Legend doubles as a filter: click to isolate series, click again to remove.
              Ranked over the whole range — % in share mode, totals in absolute mode. */}
          <div className="w-full shrink-0 space-y-1.5 lg:w-64">
            <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
              <span>{filterActive ? `${selected.size} selected` : 'Click to filter'}</span>
              {filterActive && (
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="font-medium text-primary hover:underline"
                >
                  Clear
                </button>
              )}
            </div>
            <ol className="space-y-0.5 text-sm">
              {legend.map((l, i) => {
                const on = selected.has(l.label);
                return (
                  <li key={l.label}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggle(l.label)}
                      title={l.display}
                      className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left transition-colors hover:bg-muted ${
                        filterActive && !on ? 'opacity-40' : ''
                      }`}
                    >
                      <span className="w-4 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {i + 1}
                      </span>
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: l.color }}
                      />
                      <span className="min-w-0 flex-1 truncate">{l.display}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {mode === 'share' ? `${l.pct.toFixed(1)}%` : fmt(metric, l.value)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
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

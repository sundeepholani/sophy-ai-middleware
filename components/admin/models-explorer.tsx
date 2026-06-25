'use client';

import { useMemo, useState } from 'react';
import { ArrowUpDown, ArrowUp, ArrowDown, Search } from 'lucide-react';
import {
  type AvailableModel,
  MODEL_CAPABILITIES,
  capabilityLabel,
  modelHasAllTags,
} from '@/lib/gateway/capabilities';
import { CapabilityCheckboxes } from '@/components/admin/capability-checkboxes';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

type SortKey = 'name' | 'provider' | 'type' | 'context' | 'input' | 'output';
type SortDir = 'asc' | 'desc';

function fmtTokens(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}
function fmtUsd(n: number | null): string {
  if (n == null) return '—';
  // $ per 1M tokens; trim trailing zeros (e.g. $3, $0.25, $1.50→$1.5).
  return `$${n.toFixed(2).replace(/\.?0+$/, '')}`;
}

const PRIMARY_TAGS = MODEL_CAPABILITIES.map((c) => c.tag);
function orderedTags(tags: string[]): string[] {
  const primary = PRIMARY_TAGS.filter((t) => tags.includes(t));
  const extra = tags.filter((t) => !PRIMARY_TAGS.includes(t as (typeof PRIMARY_TAGS)[number]));
  return [...primary, ...extra];
}

export function ModelsExplorer({ models }: { models: AvailableModel[] }) {
  const [query, setQuery] = useState('');
  const [caps, setCaps] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  function toggleCap(tag: string) {
    setCaps((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }
  function sortBy(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else {
      setSortKey(key);
      setSortDir(key === 'context' || key === 'input' || key === 'output' ? 'desc' : 'asc');
    }
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = models.filter((m) => {
      if (caps.length && !modelHasAllTags(m, caps)) return false;
      if (!q) return true;
      return (
        m.id.toLowerCase().includes(q) ||
        m.name.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q) ||
        (m.description?.toLowerCase().includes(q) ?? false)
      );
    });
    const dir = sortDir === 'asc' ? 1 : -1;
    const num = (v: number | null) => (v == null ? (sortDir === 'asc' ? Infinity : -Infinity) : v);
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'provider':
          return dir * (a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
        case 'type':
          return dir * (a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
        case 'context':
          return dir * ((num(a.contextWindow) - num(b.contextWindow)) || a.id.localeCompare(b.id));
        case 'input':
          return dir * ((num(a.inputPerMTok) - num(b.inputPerMTok)) || a.id.localeCompare(b.id));
        case 'output':
          return dir * ((num(a.outputPerMTok) - num(b.outputPerMTok)) || a.id.localeCompare(b.id));
        default:
          return dir * (a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      }
    });
  }, [models, query, caps, sortKey, sortDir]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models, providers…"
            className="pl-8"
            aria-label="Search models"
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {rows.length} of {models.length} model{models.length === 1 ? '' : 's'}
        </p>
      </div>

      <div className="space-y-1.5 rounded-md border p-3">
        <p className="text-xs font-medium text-muted-foreground">Filter by capability</p>
        <CapabilityCheckboxes selected={caps} onToggle={toggleCap} idPrefix="models-filter" />
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <SortHead label="Model" k="name" {...{ sortKey, sortDir, sortBy }} />
              <SortHead label="Provider" k="provider" {...{ sortKey, sortDir, sortBy }} />
              <SortHead label="Type" k="type" {...{ sortKey, sortDir, sortBy }} />
              <SortHead label="Context" k="context" align="right" {...{ sortKey, sortDir, sortBy }} />
              <SortHead label="In $/1M" k="input" align="right" {...{ sortKey, sortDir, sortBy }} />
              <SortHead label="Out $/1M" k="output" align="right" {...{ sortKey, sortDir, sortBy }} />
              <TableHead>Capabilities</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No models match the search/filters.
                </TableCell>
              </TableRow>
            )}
            {rows.map((m) => (
              <TableRow key={m.id}>
                <TableCell>
                  <div className="font-medium">{m.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">{m.id}</div>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{m.provider}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs font-normal">
                    {m.type}
                  </Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmtTokens(m.contextWindow)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmtUsd(m.inputPerMTok)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {fmtUsd(m.outputPerMTok)}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {orderedTags(m.tags).length === 0 && (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                    {orderedTags(m.tags).map((t) => (
                      <Badge key={t} variant="secondary" className="text-xs font-normal">
                        {capabilityLabel(t)}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function SortHead({
  label,
  k,
  align,
  sortKey,
  sortDir,
  sortBy,
}: {
  label: string;
  k: SortKey;
  align?: 'right';
  sortKey: SortKey;
  sortDir: SortDir;
  sortBy: (k: SortKey) => void;
}) {
  const active = sortKey === k;
  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead className={align === 'right' ? 'text-right' : undefined}>
      <button
        type="button"
        onClick={() => sortBy(k)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${align === 'right' ? 'flex-row-reverse' : ''} ${active ? 'text-foreground' : ''}`}
      >
        {label}
        <Icon className="h-3.5 w-3.5 opacity-60" />
      </button>
    </TableHead>
  );
}

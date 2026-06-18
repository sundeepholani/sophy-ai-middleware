'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const RANGES: Record<string, string> = {
  '7': 'Last 7 days',
  '30': 'Last 30 days',
  '90': 'Last 90 days',
};

export function UsageFilters({
  keys,
  models,
  current,
}: {
  keys: { id: string; name: string }[];
  models: string[];
  current: { range: string; key: string; model: string };
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  function update(param: string, value: string) {
    const params = new URLSearchParams(sp.toString());
    // 'all' (or the default 30-day range) means "no filter" — keep the URL clean.
    if (value === 'all' || (param === 'range' && value === '30')) {
      params.delete(param);
    } else {
      params.set(param, value);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const keyItems: Record<string, string> = {
    all: 'All keys',
    ...Object.fromEntries(keys.map((k) => [k.id, k.name])),
  };
  const modelItems: Record<string, string> = {
    all: 'All models',
    ...Object.fromEntries(models.map((m) => [m, m])),
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="Range">
        <Select
          items={RANGES}
          value={current.range}
          onValueChange={(v) => v && update('range', v)}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(RANGES).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Key">
        <Select items={keyItems} value={current.key} onValueChange={(v) => v && update('key', v)}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All keys</SelectItem>
            {keys.map((k) => (
              <SelectItem key={k.id} value={k.id}>
                {k.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Model">
        <Select
          items={modelItems}
          value={current.model}
          onValueChange={(v) => v && update('model', v)}
        >
          <SelectTrigger className="w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All models</SelectItem>
            {models.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

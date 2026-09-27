'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Key picker for the logs page. It only edits ?key= (keeping ?source=); the
 *  page validates the key against the viewer's keys and filters in SQL. */
export function LogsKeyFilter({
  keys,
  current,
}: {
  keys: { id: string; name: string }[];
  current: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  function update(value: string) {
    const params = new URLSearchParams(sp.toString());
    // 'all' means "no filter" — keep the URL clean.
    if (value === 'all') params.delete('key');
    else params.set('key', value);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  const items: Record<string, string> = {
    all: 'All keys',
    ...Object.fromEntries(keys.map((k) => [k.id, k.name])),
  };

  return (
    <Select items={items} value={current} onValueChange={(v) => v && update(v)}>
      <SelectTrigger size="sm" className="w-56" aria-label="Filter logs by key">
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
  );
}

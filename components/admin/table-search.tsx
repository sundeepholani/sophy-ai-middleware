'use client';

import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Free-text filter shared by every admin table. Case-insensitive; the query is
 * split on whitespace and EVERY term must be a substring of the row's `toText`
 * haystack (so "claude active" matches active rows on a Claude model). Filtering
 * is recomputed each render — admin tables are small (≤100 rows), so there's no
 * need to memoize (and it sidesteps stale closures when `toText` reads other props).
 */
export function useTableFilter<T>(
  items: T[],
  toText: (item: T) => string,
): { query: string; setQuery: (q: string) => void; filtered: T[] } {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  if (!q) return { query, setQuery, filtered: items };
  const terms = q.split(/\s+/);
  const filtered = items.filter((item) => {
    const hay = toText(item).toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  return { query, setQuery, filtered };
}

/** The search box that sits above a table — magnifying glass + input + clear ✕. */
export function TableSearchBox({
  value,
  onChange,
  placeholder = 'Search…',
  label = 'Search',
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn('relative max-w-sm', className)}>
      <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="pr-8 pl-8"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm text-muted-foreground hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

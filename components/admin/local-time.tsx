'use client';

import { useSyncExternalStore } from 'react';

/**
 * Render a timestamp in the VIEWER's local timezone. Server components format in
 * the server's timezone (UTC on Vercel), so dates must be localized in the browser.
 *
 * useSyncExternalStore renders the server snapshot (deterministic UTC) during SSR
 * and hydration — so there's no mismatch — then swaps to the local-timezone
 * snapshot on the client. No effect, no flicker-on-every-render.
 */
const subscribe = () => () => {};

export function LocalTime({ value, className }: { value: string; className?: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => new Date(value).toLocaleString(), // client: viewer's local timezone + locale
    () => new Date(value).toLocaleString('en-US', { timeZone: 'UTC' }), // server + hydration
  );
  return (
    <time dateTime={value} className={className}>
      {text}
    </time>
  );
}

'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Re-fetch the current server component's data on an interval. Mounted by the
 * evals pages while a run is live so cron progress (judgments, counts) streams
 * in without a manual reload — same 10s cadence as the eval dialog's poll.
 */
export function AutoRefresh({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}

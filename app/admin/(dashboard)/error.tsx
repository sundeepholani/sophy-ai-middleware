'use client';

import { Button } from '@/components/ui/button';

export default function Error({
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <div className="space-y-4 py-16 text-center">
      <h2 className="text-lg font-semibold">Couldn’t load this page</h2>
      <p className="mx-auto max-w-md text-sm text-muted-foreground">
        Something went wrong fetching the data — often a transient database or gateway hiccup. Try
        again, and if it persists, check the server logs.
      </p>
      <Button onClick={unstable_retry}>Try again</Button>
    </div>
  );
}

'use client';

import { Button } from '@/components/ui/button';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="space-y-4 py-16 text-center">
      <h2 className="text-lg font-semibold">Couldn’t load this page</h2>
      <p className="mx-auto max-w-md text-sm text-muted-foreground">
        Something went wrong fetching the data — often a transient database or gateway hiccup. Try
        again, and if it persists, check the server logs.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}

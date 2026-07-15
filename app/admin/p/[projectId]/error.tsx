'use client';

import { Button } from '@/components/ui/button';

export default function ProjectError({
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <div className="space-y-4 py-16 text-center">
      <h2 className="text-lg font-semibold">Couldn’t load this project</h2>
      <p className="mx-auto max-w-md text-sm text-muted-foreground">
        The project may be temporarily unavailable, or your access may have changed.
      </p>
      <Button onClick={unstable_retry}>Try again</Button>
    </div>
  );
}

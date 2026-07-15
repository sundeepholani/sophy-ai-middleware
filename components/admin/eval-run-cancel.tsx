'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { cancelEvalRun } from '@/app/admin/actions';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/** Cancel button for a running eval on the run-detail page. Cancelling is
 *  destructive (captured samples are purged), so it always confirms first. */
export function EvalRunCancel({ projectId, runId }: { projectId: string; runId: string }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        Cancel eval
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this eval?</AlertDialogTitle>
            <AlertDialogDescription>
              The run stops immediately and its captured samples — including any judgments so far —
              are discarded. This can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault();
                startTransition(async () => {
                  try {
                    await cancelEvalRun({ projectId, runId });
                    toast.success('Eval cancelled');
                    setOpen(false);
                    router.refresh();
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : '';
                    toast.error(
                      msg === 'unauthorized'
                        ? 'Your session expired — please sign in again.'
                        : msg || 'Could not cancel the eval',
                    );
                  }
                });
              }}
            >
              {isPending ? 'Cancelling…' : 'Cancel eval'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Star } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function MakeDefaultProjectButton({
  projectId,
  projectName,
  isDefault,
  setDefaultAction,
}: {
  projectId: string;
  projectName: string;
  isDefault: boolean;
  setDefaultAction: (input: { projectId: string }) => Promise<void>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (isDefault) {
    return (
      <Button variant="secondary" disabled>
        <Star className="fill-current" /> Current default
      </Button>
    );
  }

  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await setDefaultAction({ projectId });
            toast.success(`${projectName} is now your default project`);
            router.refresh();
          } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : 'Could not change your default');
          }
        })
      }
    >
      <Star /> {pending ? 'Saving…' : 'Make default'}
    </Button>
  );
}

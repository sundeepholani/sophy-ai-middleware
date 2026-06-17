'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { createPrompt } from '@/app/admin/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export function CreatePrompt() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState('');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">New prompt</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Input
            placeholder="Prompt name (e.g. support-bot-system)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button
            disabled={isPending || !name.trim()}
            onClick={() =>
              startTransition(async () => {
                try {
                  const { id } = await createPrompt(name.trim());
                  router.push(`/admin/prompts/${id}`);
                } catch {
                  toast.error('Failed (name may already exist)');
                }
              })
            }
          >
            Create
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

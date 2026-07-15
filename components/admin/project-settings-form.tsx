'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ProjectSettingsFormProps {
  projectId: string;
  initialName: string;
  projectSlug: string;
  renameAction: (input: { projectId: string; name: string }) => Promise<void>;
}

export function ProjectSettingsForm({
  projectId,
  initialName,
  projectSlug,
  renameAction,
}: ProjectSettingsFormProps) {
  const [name, setName] = useState(initialName);
  const [pending, startTransition] = useTransition();

  function save() {
    const trimmed = name.trim();
    if (!trimmed) return toast.error('Project name is required');
    startTransition(async () => {
      try {
        await renameAction({ projectId, name: trimmed });
        toast.success('Project renamed');
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        toast.error(message || 'Could not rename this project');
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="project-name">Project name</Label>
        <p className="text-xs text-muted-foreground">
          “My Project” is only the initial name. Rename it anytime without changing access or keys.
        </p>
        <Input
          id="project-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          className="max-w-xl"
        />
      </div>
      <div className="space-y-2">
        <Label>Stable project address</Label>
        <code className="block max-w-xl overflow-x-auto rounded-lg bg-muted p-3 text-xs">
          /admin/p/{projectId}
        </code>
        <p className="text-xs text-muted-foreground">
          Internal slug: {projectSlug}. Renaming the project does not change its address.
        </p>
      </div>
      <Button disabled={pending || !name.trim() || name.trim() === initialName} onClick={save}>
        {pending ? 'Saving…' : 'Save project name'}
      </Button>
    </div>
  );
}

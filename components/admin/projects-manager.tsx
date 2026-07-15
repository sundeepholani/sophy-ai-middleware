'use client';

import { useState, useTransition } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { CirclePlus, FolderKanban, Star } from 'lucide-react';
import { toast } from 'sonner';
import type { ProjectOption } from '@/components/admin/project-types';
import { projectRoleLabel } from '@/components/admin/project-types';
import { projectSwitchPath } from '@/components/admin/project-path';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface ProjectsManagerProps {
  projects: ProjectOption[];
  currentProjectId: string;
  createProjectAction: (input: { name: string }) => Promise<{ projectId: string }>;
  setDefaultProjectAction: (input: { projectId: string }) => Promise<void>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  showTrigger?: boolean;
}

function actionError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message === 'unauthorized') return 'Your session expired — sign in again.';
  if (message === 'forbidden') return 'You do not have access to that project.';
  return message || 'Something went wrong.';
}

export function ProjectsManager({
  projects,
  currentProjectId,
  createProjectAction,
  setDefaultProjectAction,
  open: controlledOpen,
  onOpenChange,
  showTrigger = true,
}: ProjectsManagerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [pending, startTransition] = useTransition();
  const open = controlledOpen ?? uncontrolledOpen;

  function setOpen(nextOpen: boolean) {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
  }

  function openProject(project: ProjectOption) {
    setOpen(false);
    router.push(projectSwitchPath(pathname, currentProjectId, project.id, project.role));
  }

  function makeDefault(project: ProjectOption) {
    if (project.isDefault) return;
    startTransition(async () => {
      try {
        await setDefaultProjectAction({ projectId: project.id });
        toast.success(`${project.name} is now your default project`);
        router.refresh();
      } catch (error) {
        toast.error(actionError(error));
      }
    });
  }

  function create() {
    const trimmed = name.trim();
    if (!trimmed) return toast.error('Project name is required');
    startTransition(async () => {
      try {
        const result = await createProjectAction({ name: trimmed });
        setCreateOpen(false);
        setName('');
        toast.success(`${trimmed} was created`);
        router.push(`/admin/p/${encodeURIComponent(result.projectId)}`);
      } catch (error) {
        toast.error(actionError(error));
      }
    });
  }

  return (
    <>
      {showTrigger && (
        <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
          Manage
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Your projects</DialogTitle>
            <DialogDescription>
              Opening a project changes this tab. Making it your default changes where Sophy opens
              after your next sign-in.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {projects.map((project) => (
              <div
                key={project.id}
                className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
                    <FolderKanban className="size-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-medium">{project.name}</p>
                      {project.id === currentProjectId && <Badge variant="outline">Open now</Badge>}
                      {project.isDefault && (
                        <Badge variant="secondary">
                          <Star data-icon="inline-start" /> Default
                        </Badge>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {projectRoleLabel(project.role)} · {project.slug}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 sm:justify-end">
                  {!project.isDefault && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => makeDefault(project)}
                    >
                      <Star /> Make default
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={project.id === currentProjectId ? 'secondary' : 'outline'}
                    disabled={project.id === currentProjectId}
                    onClick={() => openProject(project)}
                  >
                    {project.id === currentProjectId ? 'Open' : 'Switch'}
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
            >
              <CirclePlus /> Create project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create a project</DialogTitle>
            <DialogDescription>
              You will be its Project Admin. The new project opens immediately but does not replace
              your default project.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-project-name">Project name</Label>
            <Input
              id="new-project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && create()}
              placeholder="My Project"
              maxLength={120}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button disabled={pending || !name.trim()} onClick={create}>
              {pending ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

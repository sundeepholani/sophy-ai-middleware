'use client';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Check, ChevronDown, FolderCog, FolderKanban, LogOut, Star } from 'lucide-react';
import { toast } from 'sonner';
import { projectSwitchPath } from '@/components/admin/project-path';
import type { ProjectOption, ProjectRole } from '@/components/admin/project-types';
import { projectRoleLabel } from '@/components/admin/project-types';
import { ProjectsManager } from '@/components/admin/projects-manager';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface AccountMenuProps {
  email: string;
  role: ProjectRole;
  projects: ProjectOption[];
  currentProjectId: string;
  createProjectAction: (input: { name: string }) => Promise<{ projectId: string }>;
  setDefaultProjectAction: (input: { projectId: string }) => Promise<void>;
}

export function AccountMenu({
  email,
  role,
  projects,
  currentProjectId,
  createProjectAction,
  setDefaultProjectAction,
}: AccountMenuProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const selected = projects.find((project) => project.id === currentProjectId);
  const projectName = selected?.name ?? 'Current project';
  const roleLabel = projectRoleLabel(selected?.role ?? role);
  const initial = (email[0] ?? 'S').toUpperCase();

  function switchProject(project: ProjectOption) {
    if (project.id === currentProjectId) return;
    router.push(projectSwitchPath(pathname, currentProjectId, project.id, project.role));
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      const response = await fetch('/api/admin/logout', { method: 'POST' });
      if (!response.ok) throw new Error('logout_failed');
      router.replace('/admin/login');
      router.refresh();
    } catch {
      setSigningOut(false);
      toast.error('Could not sign out. Please try again.');
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              aria-label={`Account menu for ${email}. Current project: ${projectName}. Role: ${roleLabel}.`}
              title={`${projectName} · ${roleLabel}`}
              className="h-auto max-w-[min(60vw,16rem)] justify-end gap-2 rounded-xl px-1.5 py-1"
            />
          }
        >
          <span className="min-w-0 text-right leading-tight">
            <span className="block truncate text-sm font-medium text-foreground">{projectName}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {roleLabel}
            </span>
          </span>
          <ChevronDown aria-hidden="true" className="size-3.5 text-muted-foreground" />
          <span
            aria-hidden="true"
            className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
          >
            {initial}
          </span>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          sideOffset={8}
          className="w-72 max-w-[calc(100vw-2rem)]"
        >
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-2 py-2 font-normal">
              <span className="block text-[0.7rem] font-medium uppercase tracking-wide text-muted-foreground">
                Signed in as
              </span>
              <span className="mt-0.5 block truncate text-sm text-foreground" title={email}>
                {email}
              </span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="px-2 py-1.5">Switch project</DropdownMenuLabel>
            {projects.map((project) => {
              const current = project.id === currentProjectId;
              return (
                <DropdownMenuItem
                  key={project.id}
                  aria-current={current ? 'page' : undefined}
                  className="cursor-pointer px-2 py-2"
                  onClick={() => switchProject(project)}
                >
                  <FolderKanban aria-hidden="true" className="size-4 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{project.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {projectRoleLabel(project.role)} · {project.slug}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {project.isDefault && (
                      <span title="Default project">
                        <Star aria-hidden="true" className="size-3.5 fill-current text-primary" />
                        <span className="sr-only">Default project</span>
                      </span>
                    )}
                    {current && (
                      <span title="Current project">
                        <Check aria-hidden="true" className="size-4 text-primary" />
                        <span className="sr-only">Current project</span>
                      </span>
                    )}
                  </span>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuGroup>

          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="cursor-pointer px-2 py-2"
            onClick={() => setProjectsOpen(true)}
          >
            <FolderCog aria-hidden="true" />
            Manage projects
          </DropdownMenuItem>

          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={signingOut}
            className="cursor-pointer px-2 py-2"
            onClick={() => void signOut()}
          >
            <LogOut aria-hidden="true" />
            {signingOut ? 'Signing out…' : 'Sign out'}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <ProjectsManager
        projects={projects}
        currentProjectId={currentProjectId}
        createProjectAction={createProjectAction}
        setDefaultProjectAction={setDefaultProjectAction}
        open={projectsOpen}
        onOpenChange={setProjectsOpen}
        showTrigger={false}
      />
    </>
  );
}

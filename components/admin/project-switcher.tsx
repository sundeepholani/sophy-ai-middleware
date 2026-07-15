'use client';

import { usePathname, useRouter } from 'next/navigation';
import { FolderKanban, Star } from 'lucide-react';
import type { ProjectOption } from '@/components/admin/project-types';
import { projectRoleLabel } from '@/components/admin/project-types';
import { projectSwitchPath } from '@/components/admin/project-path';
import { ProjectsManager } from '@/components/admin/projects-manager';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';

interface ProjectSwitcherProps {
  projects: ProjectOption[];
  currentProjectId: string;
  createProjectAction: (input: { name: string }) => Promise<{ projectId: string }>;
  setDefaultProjectAction: (input: { projectId: string }) => Promise<void>;
}

export function ProjectSwitcher({
  projects,
  currentProjectId,
  createProjectAction,
  setDefaultProjectAction,
}: ProjectSwitcherProps) {
  const pathname = usePathname();
  const router = useRouter();
  const selected = projects.find((project) => project.id === currentProjectId);

  return (
    <div className="flex min-w-0 items-center gap-1">
      <Select
        items={projects.map((project) => ({ label: project.name, value: project.id }))}
        value={currentProjectId}
        onValueChange={(value) => {
          if (!value || value === currentProjectId) return;
          const next = projects.find((project) => project.id === value);
          if (!next) return;
          router.push(projectSwitchPath(pathname, currentProjectId, next.id, next.role));
        }}
      >
        <SelectTrigger aria-label="Current project" className="h-9 min-w-0 max-w-64 flex-1 sm:w-56">
          <FolderKanban className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">{selected?.name ?? 'Select project'}</span>
        </SelectTrigger>
        <SelectContent align="start" className="min-w-72">
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{project.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {projectRoleLabel(project.role)} · {project.slug}
                  </span>
                </span>
                {project.isDefault && <Star className="size-3 fill-current text-primary" />}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <ProjectsManager
        projects={projects}
        currentProjectId={currentProjectId}
        createProjectAction={createProjectAction}
        setDefaultProjectAction={setDefaultProjectAction}
      />
    </div>
  );
}

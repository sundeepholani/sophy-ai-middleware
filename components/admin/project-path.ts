import type { ProjectRole } from '@/components/admin/project-types';

const ADMIN_ONLY_SEGMENTS = new Set(['members', 'settings']);

export function projectPath(projectId: string, suffix = ''): string {
  const cleanSuffix = suffix.replace(/^\/+/, '');
  return `/admin/p/${encodeURIComponent(projectId)}${cleanSuffix ? `/${cleanSuffix}` : ''}`;
}

/** Keep the current dashboard surface when switching projects when the new role allows it. */
export function projectSwitchPath(
  pathname: string,
  currentProjectId: string,
  nextProjectId: string,
  nextRole: ProjectRole,
): string {
  const currentBase = projectPath(currentProjectId);
  if (!pathname.startsWith(currentBase)) return projectPath(nextProjectId);

  const suffix = pathname.slice(currentBase.length).replace(/^\/+/, '');
  const firstSegment = suffix.split('/')[0];
  if (!suffix || (nextRole !== 'admin' && ADMIN_ONLY_SEGMENTS.has(firstSegment))) {
    return projectPath(nextProjectId);
  }
  // Resource IDs are project-local. Switching from a detail page keeps the
  // surface, never a foreign log/eval identifier that cannot exist next door.
  return projectPath(nextProjectId, firstSegment);
}

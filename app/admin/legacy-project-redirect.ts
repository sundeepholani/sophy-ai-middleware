import { redirect } from 'next/navigation';
import { getIdentityViewer } from '@/lib/auth/viewer';
import { listProjectsForUser } from '@/lib/projects/repository';
import { projectPath } from '@/components/admin/project-path';

/** Temporary compatibility for bookmarks using the pre-project console URLs. */
export async function redirectToDefaultProject(suffix = ''): Promise<never> {
  const identity = await getIdentityViewer();
  if (!identity) redirect('/admin/login');

  const projects = await listProjectsForUser(identity.userId);
  const target = projects.find((project) => project.isDefault) ?? projects[0];
  if (!target) redirect('/admin/no-projects');
  redirect(projectPath(target.id, suffix));
}

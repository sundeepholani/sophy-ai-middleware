import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { createProject, setDefaultProject } from '@/app/admin/project-actions';
import { BrandMark } from '@/components/brand';
import { LogoutButton } from '@/components/admin/logout-button';
import { Nav } from '@/components/admin/nav';
import { ProjectSwitcher } from '@/components/admin/project-switcher';
import { projectRoleLabel } from '@/components/admin/project-types';
import { Badge } from '@/components/ui/badge';
import { Toaster } from '@/components/ui/sonner';
import { getIdentityViewer, requireProjectViewer } from '@/lib/auth/viewer';
import { listProjectsForUser, touchProjectAccess } from '@/lib/projects/repository';

export const dynamic = 'force-dynamic';

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const identity = await getIdentityViewer();
  if (!identity) redirect('/admin/login');

  const { projectId } = await params;
  const projects = await listProjectsForUser(identity.userId);
  if (!projects.length) redirect('/admin/no-projects');
  if (!projects.some((project) => project.id === projectId)) {
    const fallback = projects.find((project) => project.isDefault) ?? projects[0];
    redirect(`/admin/p/${fallback.id}`);
  }
  const viewer = await requireProjectViewer(projectId);
  after(async () => {
    try {
      await touchProjectAccess(viewer.userId, projectId);
    } catch (error) {
      console.error('[projects] failed to record project access', { projectId, error });
    }
  });
  const initial = (viewer.email[0] ?? 'S').toUpperCase();

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <BrandMark size="sm" href={`/admin/p/${encodeURIComponent(projectId)}`} />

          <div className="order-3 flex min-w-0 w-full items-center gap-2 sm:order-none sm:w-auto sm:flex-1 lg:max-w-sm">
            <ProjectSwitcher
              projects={projects}
              currentProjectId={projectId}
              createProjectAction={createProject}
              setDefaultProjectAction={setDefaultProject}
            />
          </div>

          <div className="relative order-4 min-w-0 w-full overflow-x-auto lg:order-none lg:w-auto lg:flex-1">
            <Nav role={viewer.role} projectId={projectId} />
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Badge variant="secondary" className="hidden md:inline-flex">
              {projectRoleLabel(viewer.role)}
            </Badge>
            <LogoutButton />
            <div
              title={viewer.email}
              aria-label={`Signed in as ${viewer.email}`}
              className="grid size-8 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
            >
              {initial}
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      <Toaster />
    </div>
  );
}

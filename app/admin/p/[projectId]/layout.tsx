import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { createProject, setDefaultProject } from '@/app/admin/project-actions';
import { AccountMenu } from '@/components/admin/account-menu';
import { BrandMark } from '@/components/brand';
import { Nav } from '@/components/admin/nav';
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
  return (
    <div className="min-h-screen bg-muted/40">
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
          <BrandMark size="sm" href={`/admin/p/${encodeURIComponent(projectId)}`} />

          <div className="relative order-3 min-w-0 w-full overflow-x-auto lg:order-none lg:w-auto lg:flex-1">
            <Nav role={viewer.role} projectId={projectId} />
          </div>

          <div className="ml-auto min-w-0 shrink-0">
            <AccountMenu
              email={viewer.email}
              role={viewer.role}
              projects={projects}
              currentProjectId={projectId}
              createProjectAction={createProject}
              setDefaultProjectAction={setDefaultProject}
            />
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      <Toaster />
    </div>
  );
}

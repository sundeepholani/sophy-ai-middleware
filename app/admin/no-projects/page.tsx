import { redirect } from 'next/navigation';
import { BrandMark } from '@/components/brand';
import { LogoutButton } from '@/components/admin/logout-button';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { getIdentityViewer } from '@/lib/auth/viewer';
import { listProjectsForUser } from '@/lib/projects/repository';
import { createRecoveryProject } from './actions';

export const dynamic = 'force-dynamic';

export default async function NoProjectsPage() {
  const identity = await getIdentityViewer();
  if (!identity) redirect('/admin/login');

  const projects = await listProjectsForUser(identity.userId);
  const target = projects.find((project) => project.isDefault) ?? projects[0];
  if (target) redirect(`/admin/p/${target.id}`);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-lg shadow-lg">
        <CardHeader>
          <div className="mb-3 flex items-center justify-between gap-3">
            <BrandMark />
            <LogoutButton />
          </div>
          <CardTitle>Create a new home in Sophy</CardTitle>
          <CardDescription>
            You do not currently have access to an active project. Create a renameable My Project
            to continue as its Project Admin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form action={createRecoveryProject}>
            <Button type="submit" className="w-full">
              Create My Project
            </Button>
          </form>
          <p className="mt-3 text-center text-xs text-muted-foreground">
            If you expected access to an existing project, ask one of its Project Admins for a new
            invitation.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

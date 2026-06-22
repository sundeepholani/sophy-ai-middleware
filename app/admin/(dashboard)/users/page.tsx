import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/viewer';
import { listUsers } from '@/lib/admin/queries';
import { UsersManager } from '@/components/admin/users-manager';

export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const viewer = await getViewer();
  if (!viewer) redirect('/admin/login');
  if (viewer.role !== 'admin') redirect('/admin');
  const users = await listUsers();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          Operators who can sign in. Admins manage everything; editors manage only the keys they own.
          New users get a one-time email sign-in link — there are no passwords.
        </p>
      </div>
      <UsersManager users={users} selfId={viewer.userId} />
    </div>
  );
}

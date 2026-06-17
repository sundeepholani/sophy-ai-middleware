import { redirect } from 'next/navigation';
import { isAdminAuthed } from '@/lib/auth/admin-session';
import { Nav } from '@/components/admin/nav';
import { LogoutButton } from '@/components/admin/logout-button';
import { Toaster } from '@/components/ui/sonner';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!(await isAdminAuthed())) redirect('/admin/login');

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b px-6 py-3">
        <span className="font-semibold">AI Middleware</span>
        <LogoutButton />
      </header>
      <div className="mx-auto flex max-w-6xl gap-8 px-6 py-8">
        <aside className="w-48 shrink-0">
          <Nav />
        </aside>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <Toaster />
    </div>
  );
}

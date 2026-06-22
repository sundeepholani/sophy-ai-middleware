import { redirect } from 'next/navigation';
import { getViewer } from '@/lib/auth/viewer';
import { Nav } from '@/components/admin/nav';
import { LogoutButton } from '@/components/admin/logout-button';
import { Toaster } from '@/components/ui/sonner';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Require a real, still-active user (DB-validated). Legacy single-admin cookies and
  // deactivated users → null → bounce to login, so every page below has a live Viewer.
  const user = await getViewer();
  if (!user) redirect('/admin/login');
  const initial = (user.email[0] ?? 'A').toUpperCase();

  return (
    <div className="min-h-screen bg-muted/40">
      <header className="sticky top-0 z-30 border-b bg-background">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-3 px-4 sm:gap-6 sm:px-6 lg:px-8">
          <div className="flex shrink-0 items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
              ai
            </div>
            <span className="hidden whitespace-nowrap text-sm font-semibold tracking-tight sm:inline">
              AI Middleware
            </span>
          </div>
          <div className="flex-1">
            <Nav role={user.role} />
          </div>
          <div className="flex items-center gap-3">
            <LogoutButton />
            <div
              title={user.email}
              className="grid h-8 w-8 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground"
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

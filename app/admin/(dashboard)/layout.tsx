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
    <div className="min-h-screen bg-muted/40">
      <header className="sticky top-0 z-30 border-b bg-background">
        <div className="flex h-16 items-center gap-6 px-4 sm:px-6 lg:px-8">
          <div className="flex shrink-0 items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
              ai
            </div>
            <span className="hidden whitespace-nowrap text-sm font-semibold tracking-tight sm:inline">
              AI Middleware
            </span>
          </div>
          <div className="flex-1">
            <Nav />
          </div>
          <div className="flex items-center gap-3">
            <LogoutButton />
            <div className="grid h-8 w-8 place-items-center rounded-full bg-secondary text-xs font-semibold text-secondary-foreground">
              A
            </div>
          </div>
        </div>
      </header>
      <main className="px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      <Toaster />
    </div>
  );
}

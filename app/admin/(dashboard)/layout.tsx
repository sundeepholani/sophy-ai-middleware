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
      <header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-6">
          <div className="flex items-center gap-2">
            <div className="grid h-7 w-7 place-items-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
              ai
            </div>
            <span className="text-sm font-semibold tracking-tight">AI Middleware</span>
          </div>
          <div className="flex-1">
            <Nav />
          </div>
          <LogoutButton />
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      <Toaster />
    </div>
  );
}

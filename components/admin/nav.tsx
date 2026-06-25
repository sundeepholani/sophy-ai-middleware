'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  KeyRound,
  BarChart3,
  ScrollText,
  Settings,
  Users,
  Library,
  Boxes,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SessionRole } from '@/lib/auth/session-config';

const ITEMS = [
  { href: '/admin', label: 'Overview', icon: LayoutDashboard },
  { href: '/admin/keys', label: 'API Keys', icon: KeyRound },
  { href: '/admin/models', label: 'Models', icon: Boxes },
  { href: '/admin/usage', label: 'Usage', icon: BarChart3 },
  { href: '/admin/logs', label: 'Logs', icon: ScrollText },
  { href: '/admin/knowledgebases', label: 'Knowledgebases', icon: Library, adminOnly: true },
  { href: '/admin/users', label: 'Users', icon: Users, adminOnly: true },
  { href: '/admin/settings', label: 'Settings', icon: Settings, adminOnly: true },
];

export function Nav({ role }: { role: SessionRole }) {
  const pathname = usePathname();
  const items = ITEMS.filter((i) => role === 'admin' || !i.adminOnly);
  return (
    <nav className="flex items-center gap-1">
      {items.map((item) => {
        const active =
          item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="hidden whitespace-nowrap sm:inline">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

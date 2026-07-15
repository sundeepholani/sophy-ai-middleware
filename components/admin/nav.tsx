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
  FlaskConical,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProjectRole } from '@/components/admin/project-types';
import { projectPath } from '@/components/admin/project-path';

const ITEMS = [
  { segment: '', label: 'Overview', icon: LayoutDashboard },
  { segment: 'keys', label: 'Sophy keys', icon: KeyRound },
  { segment: 'models', label: 'Models', icon: Boxes },
  { segment: 'usage', label: 'Usage', icon: BarChart3 },
  { segment: 'evals', label: 'Evals', icon: FlaskConical },
  { segment: 'logs', label: 'Logs', icon: ScrollText },
  { segment: 'knowledgebases', label: 'Knowledgebases', icon: Library, adminOnly: true },
  { segment: 'members', label: 'Members', icon: Users, adminOnly: true },
  { segment: 'settings', label: 'Settings', icon: Settings, adminOnly: true },
];

export function Nav({ role, projectId }: { role: ProjectRole; projectId: string }) {
  const pathname = usePathname();
  const items = ITEMS.filter((i) => role === 'admin' || !i.adminOnly);
  return (
    <nav aria-label="Project navigation" className="flex min-w-max items-center gap-1">
      {items.map((item) => {
        const href = projectPath(projectId, item.segment);
        const active =
          item.segment === '' ? pathname === href : pathname.startsWith(href);
        const Icon = item.icon;
        return (
          <Link
            key={item.segment}
            href={href}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="whitespace-nowrap">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

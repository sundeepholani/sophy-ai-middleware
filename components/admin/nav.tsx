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
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProjectRole } from '@/components/admin/project-types';
import { projectPath } from '@/components/admin/project-path';
import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuIcon,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuPopup,
  NavigationMenuPortal,
  NavigationMenuPositioner,
  NavigationMenuTrigger,
  NavigationMenuViewport,
} from '@/components/ui/navigation-menu';

type NavItem = {
  segment: string;
  label: string;
  icon: typeof LayoutDashboard;
};

type NavGroup = {
  label: string;
  icon: typeof LayoutDashboard;
  items: NavItem[];
  adminOnly?: boolean;
};

type NavEntry = (NavItem & { adminOnly?: boolean }) | NavGroup;

const ENTRIES: NavEntry[] = [
  { segment: '', label: 'Overview', icon: LayoutDashboard },
  {
    label: 'Keys',
    icon: KeyRound,
    items: [
      { segment: 'keys', label: 'Sophy keys', icon: KeyRound },
      { segment: 'evals', label: 'Evals', icon: FlaskConical },
    ],
  },
  { segment: 'models', label: 'Models', icon: Boxes },
  {
    label: 'Usage',
    icon: BarChart3,
    items: [
      { segment: 'usage', label: 'Usage', icon: BarChart3 },
      { segment: 'logs', label: 'Logs', icon: ScrollText },
    ],
  },
  { segment: 'knowledgebases', label: 'Knowledgebases', icon: Library, adminOnly: true },
  {
    label: 'Settings',
    icon: Settings,
    adminOnly: true,
    items: [
      { segment: 'settings', label: 'Settings', icon: Settings },
      { segment: 'members', label: 'Members', icon: Users },
    ],
  },
];

const ROOT_ITEM_CLASS =
  'flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors';

function isGroup(entry: NavEntry): entry is NavGroup {
  return 'items' in entry;
}

function isPathActive(pathname: string, href: string, exact = false) {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

export function Nav({ role, projectId }: { role: ProjectRole; projectId: string }) {
  const pathname = usePathname();
  const entries = ENTRIES.filter((entry) => role === 'admin' || !entry.adminOnly);

  return (
    <NavigationMenu aria-label="Project navigation" className="min-w-max">
      <NavigationMenuList>
        {entries.map((entry) => {
          const Icon = entry.icon;

          if (isGroup(entry)) {
            const groupActive = entry.items.some((item) =>
              isPathActive(pathname, projectPath(projectId, item.segment)),
            );

            return (
              <NavigationMenuItem key={entry.label} value={entry.label.toLowerCase()}>
                <NavigationMenuTrigger
                  className={cn(
                    ROOT_ITEM_CLASS,
                    groupActive
                      ? 'bg-primary/10 font-medium text-primary'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    'data-popup-open:bg-muted data-popup-open:text-foreground',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span>{entry.label}</span>
                  <NavigationMenuIcon>
                    <ChevronDown className="h-3.5 w-3.5" />
                  </NavigationMenuIcon>
                </NavigationMenuTrigger>

                <NavigationMenuContent>
                  <ul className="space-y-0.5">
                    {entry.items.map((item) => {
                      const href = projectPath(projectId, item.segment);
                      const active = isPathActive(pathname, href);
                      const ItemIcon = item.icon;

                      return (
                        <li key={item.segment}>
                          <NavigationMenuLink
                            render={<Link href={href} />}
                            active={active}
                            closeOnClick
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors',
                              active
                                ? 'bg-primary/10 font-medium text-primary'
                                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                            )}
                          >
                            <ItemIcon className="h-4 w-4 shrink-0" />
                            <span>{item.label}</span>
                          </NavigationMenuLink>
                        </li>
                      );
                    })}
                  </ul>
                </NavigationMenuContent>
              </NavigationMenuItem>
            );
          }

          const href = projectPath(projectId, entry.segment);
          const active = isPathActive(pathname, href, entry.segment === '');

          return (
            <NavigationMenuItem key={entry.segment || 'overview'}>
              <NavigationMenuLink
                render={<Link href={href} />}
                active={active}
                closeOnClick
                className={cn(
                  ROOT_ITEM_CLASS,
                  active
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span>{entry.label}</span>
              </NavigationMenuLink>
            </NavigationMenuItem>
          );
        })}
      </NavigationMenuList>

      <NavigationMenuPortal>
        <NavigationMenuPositioner>
          <NavigationMenuPopup aria-label="Project subsection navigation">
            <NavigationMenuViewport />
          </NavigationMenuPopup>
        </NavigationMenuPositioner>
      </NavigationMenuPortal>
    </NavigationMenu>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/keys', label: 'API Keys' },
  { href: '/admin/usage', label: 'Usage' },
  { href: '/admin/logs', label: 'Logs' },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {ITEMS.map((item) => {
        const active =
          item.href === '/admin' ? pathname === '/admin' : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-secondary font-medium text-secondary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

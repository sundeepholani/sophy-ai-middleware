import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { BrandMark } from '@/components/brand';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/#features', label: 'Features' },
  { href: '/#how-it-works', label: 'How it works' },
];

/** Public marketing header: brand, in-page nav (md+), Docs + Sign in. */
export function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 w-full max-w-7xl items-center gap-4 px-4 sm:px-6 lg:px-8">
        <BrandMark href="/" />
        <nav className="hidden items-center gap-1 text-sm md:flex">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-3 py-2 text-muted-foreground transition-colors hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex flex-1 items-center justify-end gap-1 sm:gap-2">
          <Link href="/docs" className={cn(buttonVariants({ variant: 'ghost' }))}>
            Docs
          </Link>
          <Link href="/admin/login" className={cn(buttonVariants())}>
            Sign in
          </Link>
        </div>
      </div>
    </header>
  );
}

import Link from 'next/link';
import { cn } from '@/lib/utils';

/**
 * The Sophy brand mark: a vivid-blue "S" box + "Sophy" wordmark. Shared so the
 * marketing site and the admin console render an identical logo. Pass `href` to
 * make it a link, `wordmark={false}` for the box alone.
 */
export function BrandMark({
  className,
  size = 'md',
  href,
  wordmark = true,
}: {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  href?: string;
  wordmark?: boolean;
}) {
  const box =
    size === 'lg' ? 'h-9 w-9 text-base' : size === 'sm' ? 'h-7 w-7 text-sm' : 'h-8 w-8 text-sm';
  const word = size === 'lg' ? 'text-lg' : 'text-sm';

  const inner = (
    <>
      <span
        className={cn(
          'grid shrink-0 place-items-center rounded-md bg-primary font-bold text-primary-foreground',
          box,
        )}
      >
        S
      </span>
      {wordmark && (
        <span className={cn('font-semibold tracking-tight whitespace-nowrap', word)}>Sophy</span>
      )}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        aria-label="Sophy home"
        className={cn('inline-flex items-center gap-2', className)}
      >
        {inner}
      </Link>
    );
  }
  return <span className={cn('inline-flex items-center gap-2', className)}>{inner}</span>;
}

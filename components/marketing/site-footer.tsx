import Link from 'next/link';
import { BrandMark } from '@/components/brand';

const COLUMNS: { title: string; links: { label: string; href: string }[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Features', href: '/#features' },
      { label: 'How it works', href: '/#how-it-works' },
      { label: 'Model evaluations', href: '/#evaluation' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'API docs', href: '/docs' },
      { label: 'Quickstart', href: '/docs#quickstart' },
      { label: 'Audio transcription', href: '/docs#audio-transcriptions' },
      { label: 'Embeddings', href: '/docs#embeddings' },
    ],
  },
  {
    title: 'Account',
    links: [{ label: 'Sign in', href: '/admin/login' }],
  },
];

/** Public marketing footer: brand + tagline, link columns, copyright. */
export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-t bg-muted/30">
      <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-10 md:flex-row md:items-start md:justify-between">
          <div className="max-w-xs space-y-3">
            <BrandMark href="/" />
            <p className="text-sm text-muted-foreground">
              A governed, OpenAI-compatible gateway for language, transcription, image, and
              embedding workloads. Each key pins its primary model and carries its policy
              server-side.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 sm:gap-12">
            {COLUMNS.map((col) => (
              <div key={col.title} className="space-y-3">
                <h3 className="text-xs font-semibold tracking-wide text-foreground uppercase">
                  {col.title}
                </h3>
                <ul className="space-y-2">
                  {col.links.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-10 border-t pt-6 text-xs text-muted-foreground">
          © {year} Sophy. All rights reserved.
        </div>
      </div>
    </footer>
  );
}

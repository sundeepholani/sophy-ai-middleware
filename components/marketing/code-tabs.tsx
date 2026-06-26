'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';

export type CodeSample = { label: string; code: string };

/**
 * A dark, self-contained code card with language tabs and a copy button. Used on
 * the landing hero and throughout the API docs. Kept independent of the shadcn
 * Tabs primitive (which is themed for light surfaces) so the dark code theme is
 * fully under our control.
 */
export function CodeTabs({ samples, className }: { samples: CodeSample[]; className?: string }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const current = samples[active] ?? samples[0];

  async function copy() {
    try {
      await navigator.clipboard.writeText(current.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  return (
    <div
      className={cn('overflow-hidden rounded-xl bg-[#0d1117] ring-1 ring-foreground/10', className)}
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-white/[0.04] pr-2 pl-1">
        <div className="flex items-center overflow-x-auto" role="tablist" aria-label="Code examples">
          {samples.map((s, i) => (
            <button
              key={s.label}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className={cn(
                'border-b-2 px-3 py-2.5 text-xs font-medium whitespace-nowrap transition-colors',
                i === active
                  ? 'border-primary text-white'
                  : 'border-transparent text-white/50 hover:text-white/80',
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          aria-label="Copy code"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
        <code className="font-mono text-white/90">{current.code}</code>
      </pre>
    </div>
  );
}

/** Single (non-tabbed) code block — reuses the copy button + dark theme. */
export function CodeBlock({
  code,
  label = 'shell',
  className,
}: {
  code: string;
  label?: string;
  className?: string;
}) {
  return <CodeTabs samples={[{ label, code }]} className={className} />;
}

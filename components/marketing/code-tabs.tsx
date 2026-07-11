'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
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
  const id = useId().replace(/:/g, '');
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = samples[active] ?? samples[0];

  function selectTab(index: number) {
    setActive(index);
    tabRefs.current[index]?.focus();
  }

  function onTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % samples.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + samples.length) % samples.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = samples.length - 1;
    if (next == null) return;

    event.preventDefault();
    selectTab(next);
  }

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
              id={`code-tabs-${id}-tab-${i}`}
              aria-controls={`code-tabs-${id}-panel-${i}`}
              aria-selected={i === active}
              tabIndex={i === active ? 0 : -1}
              ref={(element) => {
                tabRefs.current[i] = element;
              }}
              onClick={() => setActive(i)}
              onKeyDown={(event) => onTabKeyDown(event, i)}
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
        <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {copied ? 'Code copied to clipboard.' : ''}
        </span>
      </div>
      {samples.map((sample, i) => (
        <div
          key={sample.label}
          role="tabpanel"
          id={`code-tabs-${id}-panel-${i}`}
          aria-labelledby={`code-tabs-${id}-tab-${i}`}
          tabIndex={i === active ? 0 : -1}
          hidden={i !== active}
        >
          <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
            <code className="font-mono text-white/90">{sample.code}</code>
          </pre>
        </div>
      ))}
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

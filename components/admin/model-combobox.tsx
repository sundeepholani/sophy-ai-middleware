'use client';

import { Combobox } from '@base-ui/react/combobox';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Input } from '@/components/ui/input';

const inputClasses =
  'h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 pr-8 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 md:text-sm dark:bg-input/30';

/**
 * Type-to-filter model picker. Renders a base-ui Combobox over the gateway model
 * list (filters as you type, scroll-free). When the catalog is unavailable it
 * falls back to a free-text input. A saved-but-stale model (no longer in the live
 * catalog) stays listed and selectable.
 */
export function ModelCombobox({
  id,
  value,
  onValueChange,
  models,
  modelsUnavailable = false,
  placeholder = 'Select or type to filter…',
}: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  models: string[];
  modelsUnavailable?: boolean;
  placeholder?: string;
}) {
  // No catalog → free-text (same behavior as before).
  if (models.length === 0) {
    return (
      <>
        <Input
          id={id}
          placeholder="anthropic/claude-sonnet-4.6"
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
        />
        {modelsUnavailable && (
          <p className="text-xs text-muted-foreground">
            Couldn’t load the gateway model list — enter the model id as free text.
          </p>
        )}
      </>
    );
  }

  // Keep a saved-but-stale model selectable/visible.
  const items = value && !models.includes(value) ? [value, ...models] : models;

  return (
    <Combobox.Root
      items={items}
      value={value}
      onValueChange={(v) => onValueChange(typeof v === 'string' ? v : '')}
      openOnInputClick
    >
      <div className="relative">
        <Combobox.Input id={id} placeholder={placeholder} className={inputClasses} />
        <Combobox.Trigger
          aria-label="Show models"
          className="absolute top-1/2 right-1.5 -translate-y-1/2 grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <ChevronsUpDown className="size-4" />
        </Combobox.Trigger>
      </div>
      <Combobox.Portal>
        <Combobox.Positioner sideOffset={4} align="start" className="isolate z-50">
          <Combobox.Popup className="max-h-(--available-height) w-(--anchor-width) overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10">
            <Combobox.Empty className="px-2 py-2 text-sm text-muted-foreground">
              No models match.
            </Combobox.Empty>
            <Combobox.List>
              {(item: string) => (
                <Combobox.Item
                  key={item}
                  value={item}
                  className="relative flex w-full cursor-default items-center gap-2 rounded-md py-1 pr-2 pl-2.5 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <span className="flex-1 truncate font-mono text-xs">{item}</span>
                  <Combobox.ItemIndicator>
                    <Check className="size-4" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

'use client';

import { MODEL_CAPABILITIES } from '@/lib/gateway/capabilities';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

/**
 * A row of capability checkboxes (Image analysis, File input, …). Controlled:
 * `selected` is the list of chosen tags; `onToggle` flips one. Shared by the
 * key-form model filter and the Models screen so the UX is identical.
 */
export function CapabilityCheckboxes({
  selected,
  onToggle,
  idPrefix,
}: {
  selected: string[];
  onToggle: (tag: string) => void;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {MODEL_CAPABILITIES.map((c) => {
        const id = `${idPrefix}-${c.tag}`;
        return (
          <Label
            key={c.tag}
            htmlFor={id}
            title={c.hint}
            className="flex cursor-pointer items-center gap-2 text-xs font-normal"
          >
            <Checkbox
              id={id}
              checked={selected.includes(c.tag)}
              onCheckedChange={() => onToggle(c.tag)}
            />
            {c.label}
          </Label>
        );
      })}
    </div>
  );
}

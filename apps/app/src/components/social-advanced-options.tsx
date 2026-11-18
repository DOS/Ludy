// SPDX-License-Identifier: AGPL-3.0-only
// One closed disclosure for a channel's optional automations (#3656): remove at, auto-reply, first comment, thread and
// repost rule. Closed by default so the settings and the preview come first; open from the start when one is already set,
// so a rule that is on is never hidden.
import { useState, type ReactNode } from 'react';
import { cn } from '@crove/ui/lib/utils';

export function AdvancedOptions({ title, filled, children }: { title: string; filled: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(filled);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group rounded-lg border px-3" data-testid="advanced-options">
      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 text-sm font-medium text-foreground select-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none md:min-h-9">
        <span>{title}</span>
        <span aria-hidden="true" className={cn('text-muted-foreground transition-transform', open && 'rotate-180')}>
          ▾
        </span>
      </summary>
      <div className="space-y-3 pb-3">{children}</div>
    </details>
  );
}

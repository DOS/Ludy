// SPDX-License-Identifier: AGPL-3.0-only
// The shell of a create form that opens over its list (owner rule of 2026-11-17, DESIGN.md 4.5, #3607): the shared Sheet,
// a panel at the right edge (full screen on a phone) with the title and a short line on top, the fields scrolling in the
// middle and the buttons always in view at the bottom. Focus moves into the panel, Tab stays inside, Escape or the close
// button cancels and focus returns to the button that opened it. While the request is on its way the panel stays open, so the
// answer is not lost. The caller keeps its own state and mutation; this only decides where the form lives.
import type { FormEvent, ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@crove/ui/components/sheet';

export function FormPanel({
  title,
  description,
  label,
  wide = false,
  busy = false,
  onClose,
  onSubmit,
  footer,
  children,
}: {
  title: string;
  description?: string;
  // The accessible name of the form when it differs from the title.
  label?: string;
  // A form with a row of columns (the voucher's lines) takes a wider column from sm up.
  wide?: boolean;
  busy?: boolean;
  onClose: () => void;
  // Without it the panel shows a result (no form), with only the footer's buttons.
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  // The buttons, cancel first: on a phone they stack with the first one last, so the main action is on top.
  footer: ReactNode;
  children: ReactNode;
}) {
  const root = useTranslations();
  const content = (
    <>
      <SheetBody className="space-y-4">{children}</SheetBody>
      <SheetFooter>{footer}</SheetFooter>
    </>
  );
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <SheetContent closeLabel={root('common.close')} className={wide ? 'sm:max-w-2xl' : undefined}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        {onSubmit ? (
          <form aria-label={label ?? title} className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
            {content}
          </form>
        ) : (
          content
        )}
      </SheetContent>
    </Sheet>
  );
}

// The line under a field when what is being typed looks like a record that already exists: a polite live region, so a screen
// reader hears it appear. It takes no room while it is empty.
export function DuplicateHint({ children, testId }: { children?: ReactNode; testId?: string }) {
  return (
    <div aria-live="polite" className="empty:hidden">
      {children ? (
        <p className="rounded-md border border-border bg-muted/50 p-2 text-sm text-foreground" data-testid={testId}>
          {children}
        </p>
      ) : null}
    </div>
  );
}

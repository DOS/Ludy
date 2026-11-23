// SPDX-License-Identifier: AGPL-3.0-only
// The shell of a create form that opens over its list (owner rule of 2026-11-17, DESIGN.md 4.5, #3607): the shared Sheet,
// a panel at the right edge (full screen on a phone) with the title and a short line on top, the fields scrolling in the
// middle and the buttons always in view at the bottom. Focus moves into the panel, Tab stays inside, Escape or the close
// button cancels and focus returns to the button that opened it. While the request is on its way the panel stays open, so the
// answer is not lost. The caller keeps its own state and mutation; this only decides where the form lives.
// Two habits live here so every form in a panel has them (#3606): Cmd or Ctrl plus Enter saves from any field, and a form
// that holds input (`dirty`) asks before Escape or the close button throws it away.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@ludy/ui/components/sheet';

// Cmd or Ctrl plus Enter, not in the middle of an IME composition (a Vietnamese Telex or VNI word being typed).
export function isSaveShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; isComposing: boolean }): boolean {
  return event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing;
}

export function FormPanel({
  title,
  description,
  label,
  wide = false,
  busy = false,
  opener: openerProp,
  dirty = false,
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
  // The element to give focus back to on close, for a panel that opens a moment after the press (it reads something first); by default the element focused when the panel mounts.
  opener?: Element | null;
  // The form holds input that has not been saved: closing it asks first, and says what is lost.
  dirty?: boolean;
  onClose: () => void;
  // Without it the panel shows a result (no form), with only the footer's buttons.
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  // The buttons, cancel first: on a phone they stack with the first one last, so the main action is on top. A function gets the
  // panel's own close, which asks first when there is unsaved input: the cancel button goes through it like Escape does.
  footer: ReactNode | ((requestClose: () => void) => ReactNode);
  children: ReactNode;
}) {
  const root = useTranslations();
  const formRef = useRef<HTMLFormElement>(null);
  // The panel is mounted when its button is pressed and unmounted when it closes, so the dialog does not know what opened it: the
  // element that had focus at that moment is remembered and gets focus back when the panel goes away (keyboard users land where they were).
  const [ownOpener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  const opener = openerProp ?? ownOpener;
  useEffect(
    () => () => {
      window.setTimeout(() => {
        // Not while a panel is open again (React's strict mode runs this cleanup once at the start).
        if (document.querySelector('[data-slot="sheet-content"]')) return;
        if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
      }, 0);
    },
    [opener],
  );
  const [asking, setAsking] = useState(false);
  // Escape, the close button and the cancel buttons all end here; a click on the dimmed page never does (see below).
  const requestClose = () => {
    if (busy) return;
    if (dirty && onSubmit) setAsking(true);
    else onClose();
  };
  const keepEditing = () => {
    setAsking(false);
    // The warning's own button is about to go away, so focus goes back to the first field instead of to the page.
    formRef.current?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select')?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    // A field that already took the key (the new-step box adds its step on Enter) has had its say: saving too would read a form the add has not reached yet.
    if (event.defaultPrevented || !isSaveShortcut({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    // Not while the discard question is up (the keys then answer that question), and not while a save is on its way.
    if (!busy && !asking) event.currentTarget.requestSubmit();
  };
  const content = (
    <>
      <SheetBody className="space-y-4">
        {/* While a save is on its way the fields are locked, so what is typed after pressing Save is not silently dropped when the panel closes. */}
        {onSubmit ? (
          <fieldset disabled={busy} className="m-0 min-w-0 space-y-4 border-0 p-0">
            {children}
          </fieldset>
        ) : (
          children
        )}
      </SheetBody>
      {asking ? (
        <div role="alert" data-testid="panel-discard" className="space-y-3 border-t border-border bg-muted/50 p-4">
          <p className="text-sm text-foreground">{root('common.discardAsk')}</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="destructive" disabled={busy} onClick={onClose}>
              {root('common.discard')}
            </Button>
            <Button type="button" autoFocus onClick={keepEditing}>
              {root('common.keepEditing')}
            </Button>
          </div>
        </div>
      ) : (
        <SheetFooter>{typeof footer === 'function' ? footer(requestClose) : footer}</SheetFooter>
      )}
    </>
  );
  return (
    <Sheet
      open
      // A form is not dropped by a stray click on the dimmed page: Escape and the close button still cancel it, as the cancel button did.
      disablePointerDismissal={onSubmit !== undefined}
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <SheetContent closeLabel={root('common.close')} className={wide ? 'sm:max-w-2xl' : undefined}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        {onSubmit ? (
          <form ref={formRef} aria-label={label ?? title} className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit} onKeyDown={onKeyDown}>
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

// SPDX-License-Identifier: AGPL-3.0-only
// The small cousin of FormPanel (owner rule of 2026-11-17, #3608): a create form of one to three fields opens in the shared Dialog over its
// card, never as a form that stays open under a list. It keeps the habits of FormPanel so a person meets the same form everywhere: focus
// moves in and returns to the button that opened it, Escape or the close button cancels, a click on the dimmed page does not throw typed
// input away, Cmd or Ctrl plus Enter saves, the fields lock while the request is on its way, and a form that holds input asks before it
// is dropped. A form with more fields than a dialog holds uses FormPanel. The caller keeps its own state and mutation.
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@ludy/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@ludy/ui/components/dialog';
import { isSaveShortcut } from './form-panel.tsx';

// False once the component has gone away: the answer of a second-factor check that comes back after the dialog was dropped must not send the request the person gave up.
export function useLive(): { current: boolean } {
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  return live;
}

export function FormDialog({
  title,
  description,
  label,
  busy = false,
  dirty = false,
  submitLabel,
  submitDisabled = false,
  onClose,
  onSubmit,
  outside,
  children,
}: {
  title: string;
  description?: string;
  // The accessible name of the form when it differs from the title.
  label?: string;
  busy?: boolean;
  // The form holds input that has not been saved: closing it asks first, and says what is lost.
  dirty?: boolean;
  submitLabel: string;
  submitDisabled?: boolean;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  // Content under the form but inside the dialog: a prompt that has a form of its own (the second-factor step-up) cannot sit inside this one.
  outside?: ReactNode;
  children: ReactNode;
}) {
  const root = useTranslations();
  const formRef = useRef<HTMLFormElement>(null);
  // Mounted when its button is pressed and unmounted when it closes: the element focused at that moment gets focus back when the dialog goes away.
  const [opener] = useState(() => (typeof document === 'undefined' ? null : document.activeElement));
  useEffect(
    () => () => {
      window.setTimeout(() => {
        if (document.querySelector('[data-slot="dialog-content"], [data-slot="sheet-content"]')) return;
        if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
      }, 0);
    },
    [opener],
  );
  const [asking, setAsking] = useState(false);
  const requestClose = () => {
    if (busy) return;
    if (dirty) setAsking(true);
    else onClose();
  };
  const keepEditing = () => {
    setAsking(false);
    formRef.current?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, select')?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.defaultPrevented || !isSaveShortcut({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, isComposing: event.nativeEvent.isComposing })) return;
    event.preventDefault();
    if (!busy && !asking && !submitDisabled) event.currentTarget.requestSubmit();
  };
  return (
    <Dialog
      open
      // A form is not dropped by a stray click on the dimmed page: Escape and the close button still cancel it.
      disablePointerDismissal
      onOpenChange={(open) => {
        if (!open) requestClose();
      }}
    >
      <DialogContent closeLabel={root('common.close')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form ref={formRef} aria-label={label ?? title} noValidate className="grid gap-3" onSubmit={onSubmit} onKeyDown={onKeyDown}>
          {/* While a save is on its way the fields are locked, so what is typed after pressing Save is not silently dropped when the dialog closes. */}
          <fieldset disabled={busy} className="m-0 grid min-w-0 gap-3 border-0 p-0">
            {children}
          </fieldset>
          {asking ? (
            <div role="alert" data-testid="dialog-discard" className="space-y-3 rounded-lg border border-border bg-muted/50 p-3">
              <p className="text-sm text-foreground">{root('common.discardAsk')}</p>
              <DialogFooter>
                <Button type="button" variant="destructive" disabled={busy} onClick={onClose}>
                  {root('common.discard')}
                </Button>
                <Button type="button" autoFocus onClick={keepEditing}>
                  {root('common.keepEditing')}
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={busy} onClick={requestClose}>
                {root('common.cancel')}
              </Button>
              <Button type="submit" loading={busy} disabled={busy || submitDisabled}>
                {submitLabel}
              </Button>
            </DialogFooter>
          )}
        </form>
        {outside}
      </DialogContent>
    </Dialog>
  );
}

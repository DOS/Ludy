// SPDX-License-Identifier: AGPL-3.0-only
import { useRef } from 'react';
import { useTranslations } from 'use-intl';
import { ConfirmDialog } from './confirm-dialog.tsx';

// The question a screen with unsaved changes asks before the router leaves it (#2117), in place of window.confirm: give it
// what `useBlocker({ withResolver: true })` returns. Staying (Cancel, Escape, the close button) resets the blocker, leaving
// proceeds. The browser's own prompt for closing the tab stays native (`enableBeforeUnload`): a tab cannot show a Dialog.
export function LeavePageDialog({ blocker }: { blocker: { status: 'blocked' | 'idle'; proceed?: (() => void) | undefined; reset?: (() => void) | undefined } }) {
  const t = useTranslations('social');
  // Confirming closes the dialog too; that close must not undo the leave it just asked for.
  const leaving = useRef(false);
  return (
    <ConfirmDialog
      open={blocker.status === 'blocked'}
      onOpenChange={(open) => {
        if (open) return;
        if (leaving.current) leaving.current = false;
        else blocker.reset?.();
      }}
      title={t('leaveTitle')}
      description={t('leaveConfirm')}
      confirm={t('leaveDo')}
      cancel={t('leaveStay')}
      destructive
      onConfirm={() => {
        leaving.current = true;
        blocker.proceed?.();
      }}
    />
  );
}

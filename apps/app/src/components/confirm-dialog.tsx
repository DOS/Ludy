import type { ReactElement, ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@crove/ui/components/dialog';

// A question asked before an action (#1512), in place of window.confirm: `render` is the button that opens it, Cancel,
// Escape or the close button leave things as they were, and the confirm button, named for the action, runs `onConfirm`.
// Focus starts on Cancel and returns to the button once the dialog closes. Where the question is not asked from a button
// of its own (a bar that picks the action, a router that blocks a navigation), leave `render` out and drive it with
// `open` and `onOpenChange`. `cancel` names the other answer when the plain "Cancel" would be confused with the
// action ("Cancel 5 posts" asks "Keep them").
export function ConfirmDialog({
  render,
  children,
  disabled = false,
  open,
  onOpenChange,
  title,
  description,
  confirm,
  cancel,
  destructive = false,
  onConfirm,
}: {
  render?: ReactElement;
  children?: ReactNode;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title: string;
  description: string;
  confirm: string;
  cancel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  const common = useTranslations('common');
  return (
    <Dialog {...(open === undefined ? {} : { open })} {...(onOpenChange ? { onOpenChange: (next: boolean) => onOpenChange(next) } : {})}>
      {render ? (
        <DialogTrigger render={render} disabled={disabled}>
          {children}
        </DialogTrigger>
      ) : null}
      <DialogContent variant={destructive ? 'destructive' : 'default'} closeLabel={common('close')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>{cancel ?? common('cancel')}</DialogClose>
          <DialogClose render={<Button variant={destructive ? 'destructive' : 'default'} />} onClick={onConfirm}>
            {confirm}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

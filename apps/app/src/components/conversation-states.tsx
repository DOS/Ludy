// SPDX-License-Identifier: AGPL-3.0-only
// The states of the Inbox panes besides "rows" (#3638, Engage audit IN-7, DESIGN.md 5.3): an error that can be tried again, and the shapes the thread and the contact panel
// take while they load (a spinner says nothing about what is coming).
import { useTranslations } from 'use-intl';
import { Button } from '@crove/ui/components/button';
import { Skeleton } from '@crove/ui/components/skeleton';
import { ErrorText } from './ui.tsx';
import { TOUCH_BUTTON } from '../lib/conversation-touch.ts';

// A failed read of a list, a thread or the panel: what the server said, and the button that reads it again.
export function PaneError({ message, onRetry, testId }: { message: string; onRetry: () => void; testId?: string }) {
  const t = useTranslations('conversations.inbox');
  return (
    <div className="space-y-2" data-testid={testId ?? 'pane-error'}>
      <ErrorText>{message}</ErrorText>
      <Button type="button" variant="outline" size="sm" className={TOUCH_BUTTON} data-testid="pane-retry" onClick={onRetry}>
        {t('retry')}
      </Button>
    </div>
  );
}

// The thread while it loads: the name and the address, then a few messages of both sides and the reply box.
export function ThreadSkeleton() {
  const t = useTranslations('common');
  return (
    <div aria-busy="true" className="space-y-4" data-testid="thread-skeleton">
      <span className="sr-only">{t('loading')}</span>
      <div className="space-y-2">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-14 w-4/5" />
        <Skeleton className="ml-auto h-10 w-3/5" />
        <Skeleton className="h-12 w-2/3" />
      </div>
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

// The contact panel while it loads: the contact's name and lines under it.
export function PanelSkeleton() {
  const t = useTranslations('common');
  return (
    <div aria-busy="true" className="space-y-3" data-testid="panel-skeleton">
      <span className="sr-only">{t('loading')}</span>
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

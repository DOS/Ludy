// In-app notifications of the kernel and finance (#671): the viewer's own, newest first.
// Clarify-style 2-column master-detail on desktop (>= lg) and single-column feed + Sheet on mobile (< lg) (DESIGN.md §3.8, #4927).
// The settings that turn kinds off for this member sit in Settings (NT-1, #3592), linked from here; a run of the same kind of notice is one row (NT-2).
// Social's have their own screen (#637).
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { Badge } from '@ludy/ui/components/badge';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { SegmentedControl, SegmentedControlItem } from '@ludy/ui/components/segmented-control';
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@ludy/ui/components/sheet';
import { cn } from '@ludy/ui/lib/utils';
import {
  NotificationDetailActions,
  NotificationDetailBody,
  NotificationDetailHeaderMeta,
  NotificationDetailPane,
  NotificationGroupHeading,
  useNotificationAppLabel,
  useNotificationLine,
  useNotificationTitle,
  type WorkNotification,
} from '../components/notification-detail.tsx';
import { Empty, ErrorText, ListSkeleton } from '../components/ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { hasBlockingOverlayForPeek, isPeekNavInputTarget } from '../lib/list-peek-nav.ts';
import { useMediaQuery } from '../lib/media.ts';
import {
  filterNotifications,
  formatRelativeNotificationTime,
  groupNotifications,
  isKnownKind,
  NOTIFICATION_LIST_LIMIT,
  notificationApp,
  notificationAppsIn,
  notificationFeedStepFromKey,
  notificationRowId,
  parseNotificationsSearch,
  resolveNotificationSelection,
  restoreNotificationRowFocus,
  stepNotificationRowIndex,
  unreadIdChunks,
  type NotificationAppFilter,
  type NotificationFilter,
  type NotificationRow,
  type NotificationsSearch,
} from '../lib/notifications.ts';
import { useScreenTitle } from '../lib/screen-title.ts';
import { withSearch } from '../lib/search.ts';
import { SAFETY_POLL_MS, pollEvery, useStreamLive } from '../lib/stream-hook.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';
import { SETTINGS_CARD } from './settings/tabs.ts';

export type { WorkNotification } from '../components/notification-detail.tsx';

// The card of Settings that holds the preferences; test/settings-tabs.test.ts checks this link goes to the tab of that card.
const NOTIFICATION_SETTINGS_ID = SETTINGS_CARD.notifications;
const LG_UP = '(min-width: 64rem)';

// The viewer's notifications; between stream hints they are read again every minute.
export function useWorkNotifications(enabled = true) {
  const live = useStreamLive();
  return useQuery({ ...orpc.notifications.list.queryOptions({ input: {} }), enabled, refetchInterval: pollEvery(live, 60_000, SAFETY_POLL_MS) });
}

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.notifications.list.key() });

function escapeSelectorAttr(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

export function NotificationsPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => parseNotificationsSearch(rawSearch), [rawSearch]);
  const t = useTranslations('notifications');
  const tc = useTranslations('common');
  const f = useFormat();
  const locale = useLocale() === 'en' ? 'en' : 'vi';
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(LG_UP);
  const list = useWorkNotifications();
  const line = useNotificationLine((list.data?.items ?? []).some((n) => n.kind === 'meetings.tracker_alert'));
  const appLabel = useNotificationAppLabel();
  const titleOf = useNotificationTitle();

  useScreenTitle(t('title'));

  const [pendingScope, setPendingScope] = useState<'all' | 'group' | string | null>(null);
  const read = useMutation({
    mutationFn: (input: { ids: string[] } | { all: true }) => client.notifications.read(input),
    onSettled: () => {
      setPendingScope((cur) => (cur === 'group' ? cur : null));
      refresh();
    },
  });

  const feedScrollRef = useRef<HTMLDivElement>(null);
  const feedListRef = useRef<HTMLUListElement>(null);
  const filterAreaRef = useRef<HTMLDivElement>(null);
  const detailPaneRef = useRef<HTMLElement>(null);
  const lastTriggerRowIdRef = useRef<string | null>(null);
  const pendingFocusRowIdRef = useRef<string | null>(null);

  const updateSearch = (patch: { [K in keyof NotificationsSearch]?: NotificationsSearch[K] | undefined }) => {
    void navigate({
      to: '.',
      search: withSearch(search, patch) as never,
      replace: true,
      resetScroll: false,
    });
  };

  // A kind this version of the app does not know (a newer module) is left out rather than shown blank.
  const items = useMemo(() => (list.data?.items ?? []).filter((n) => isKnownKind(n.kind)), [list.data?.items]);
  const activeFilter: NotificationFilter = search.filter ?? 'all';
  const activeApp = search.app;
  const availableApps = useMemo(() => notificationAppsIn(items, activeApp), [items, activeApp]);
  const showAppFilters = availableApps.length > 1 || activeApp !== undefined;
  const filteredItems = useMemo(() => filterNotifications(items, { filter: activeFilter, app: activeApp }), [items, activeFilter, activeApp]);
  const rows = useMemo(() => groupNotifications(filteredItems), [filteredItems]);
  // The server answers with the newest 30: a group at the end of a full list may stand for more.
  const capped = (list.data?.items.length ?? 0) >= NOTIFICATION_LIST_LIMIT;
  const lastRawId = items[items.length - 1]?.id;
  const isCappedRow = (row: NotificationRow<WorkNotification>) =>
    capped && row.type === 'group' && lastRawId !== undefined && row.items[row.items.length - 1]?.id === lastRawId;

  const activeRow = useMemo(
    () => resolveNotificationSelection(rows, items, search.selected, isDesktop),
    [rows, items, search.selected, isDesktop],
  );
  const activeRowId = activeRow ? notificationRowId(activeRow) : null;

  const markSingleRead = (id: string, trackPending = false) => {
    if (trackPending) setPendingScope(id);
    read.mutate({ ids: [id] });
  };

  const markGroupRead = (group: WorkNotification[], options?: { clearGroupSearch?: boolean }) => {
    const chunks = unreadIdChunks(group);
    if (chunks.length === 0) return;
    setPendingScope('group');
    void (async () => {
      for (const ids of chunks) await read.mutateAsync({ ids });
      if (options?.clearGroupSearch && activeFilter === 'unread' && search.selected?.startsWith('group:')) {
        updateSearch({ selected: undefined });
      }
    })()
      .catch(() => undefined)
      .finally(() => setPendingScope(null));
  };

  const isRowMarkPending = (row: NotificationRow<WorkNotification> | null): boolean => {
    if (!read.isPending || !row) return false;
    return row.type === 'group' ? pendingScope === 'group' : pendingScope === row.item.id;
  };

  const handleReadAll = () => {
    setPendingScope('all');
    read.mutate({ all: true });
    if (activeFilter === 'unread' && search.selected) {
      updateSearch({ selected: undefined });
    }
  };

  const activateRow = (row: NotificationRow<WorkNotification>, { focusDetail = false }: { focusDetail?: boolean } = {}) => {
    const id = notificationRowId(row);
    lastTriggerRowIdRef.current = id;
    if (row.type === 'one' && !row.item.read) {
      markSingleRead(row.item.id, false);
    }
    updateSearch({ selected: id });
    if (focusDetail && isDesktop) {
      window.setTimeout(() => {
        detailPaneRef.current?.focus();
      }, 0);
    }
  };

  const closeMobileSheet = () => {
    pendingFocusRowIdRef.current = lastTriggerRowIdRef.current ?? activeRowId;
    updateSearch({ selected: undefined });
  };

  // Restore focus after TanStack Router finishes clearing ?selected= and the Sheet closes cleanly.
  useEffect(() => {
    if (isDesktop || activeRow !== null) return;
    const closingId = pendingFocusRowIdRef.current;
    if (closingId === null) return;
    pendingFocusRowIdRef.current = null;
    const timer = window.setTimeout(() => {
      const blocked = hasBlockingOverlayForPeek('', document);
      if (blocked) return;
      if (restoreNotificationRowFocus(feedListRef.current, closingId, false)) return;
      const fallback = filterAreaRef.current?.querySelector<HTMLElement>('button, [role="radio"]');
      fallback?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isDesktop, activeRow]);

  // J/K and ArrowDown/ArrowUp move through visible rows without hijacking inputs, dialogs, sheets, or SegmentedControl.
  const latestNavRef = useRef({ rows, activeRowId, isDesktop, updateSearch });
  latestNavRef.current = { rows, activeRowId, isDesktop, updateSearch };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = latestNavRef.current;
      if (current.rows.length === 0) return;
      const activeEl = document.activeElement;
      const blocked =
        isPeekNavInputTarget(event.target) ||
        isPeekNavInputTarget(activeEl) ||
        hasBlockingOverlayForPeek('', document);
      const container = feedListRef.current;
      const insideFeed = Boolean(
        container &&
          ((event.target instanceof Node && container.contains(event.target)) || (activeEl && container.contains(activeEl))),
      );
      const plainPageFocus = activeEl === null || activeEl === document.body || activeEl.id === 'main-content';
      const step = notificationFeedStepFromKey(event, { blocked, insideFeed, plainPageFocus });
      if (!step) return;

      const focusedRowAttr =
        activeEl instanceof Element
          ? activeEl.closest('[data-notification-row]')?.getAttribute('data-notification-row') ?? null
          : null;
      const ids = current.rows.map((row) => notificationRowId(row));
      const focusedIdx = focusedRowAttr ? ids.indexOf(focusedRowAttr) : -1;
      const currentIdx = focusedIdx >= 0 ? focusedIdx : current.activeRowId ? ids.indexOf(current.activeRowId) : -1;
      const nextIdx = stepNotificationRowIndex(currentIdx, current.rows.length, step);
      if (nextIdx === null) return;

      const nextRow = current.rows[nextIdx];
      if (!nextRow) return;
      const nextId = notificationRowId(nextRow);
      event.preventDefault();

      const rowEl = container?.querySelector<HTMLElement>(`[data-notification-row="${escapeSelectorAttr(nextId)}"]`);
      rowEl?.focus({ preventScroll: true });
      rowEl?.scrollIntoView?.({ block: 'nearest' });

      if (current.isDesktop) {
        current.updateSearch({ selected: nextId });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const unreadCount = list.data?.unread ?? 0;

  const headerControls = (compact = false) => (
    <div className={cn('flex flex-wrap items-center justify-between gap-2', compact ? '' : 'mb-4')}>
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-foreground outline-none">{t('title')}</h1>
        {unreadCount > 0 && (
          <Badge variant="brand" data-testid="notifications-unread-count">
            {unreadCount}
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {/* The preferences are a card of Settings (NT-1, #3592), the tab "Thông báo của tôi". */}
        <Link
          to="/o/$slug/settings/notifications"
          params={{ slug }}
          hash={NOTIFICATION_SETTINGS_ID}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), PHONE_TARGET)}
        >
          {t('settingsLink')}
        </Link>
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={read.isPending && pendingScope === 'all'}
          disabled={!unreadCount || read.isPending}
          onClick={handleReadAll}
        >
          {t('readAll')}
        </Button>
      </div>
    </div>
  );

  const filterBar = (
    <div ref={filterAreaRef} className="space-y-2.5" data-testid="notifications-filter-bar">
      <SegmentedControl
        size="sm"
        value={activeFilter}
        onValueChange={(next) => updateSearch({ filter: next === 'all' ? undefined : (next as NotificationFilter), selected: undefined })}
        aria-label={t('filterLabel')}
      >
        <SegmentedControlItem value="all" data-testid="notifications-filter-all">
          {t('filters.all')}
        </SegmentedControlItem>
        <SegmentedControlItem value="unread" data-testid="notifications-filter-unread">
          {t('filters.unread')}
        </SegmentedControlItem>
      </SegmentedControl>
      {showAppFilters && (
        <div role="group" aria-label={t('appFilterLabel')} className="flex flex-wrap items-center gap-1.5" data-testid="notifications-app-filters">
          <button
            type="button"
            aria-pressed={activeApp === undefined}
            data-testid="notifications-app-all"
            onClick={() => updateSearch({ app: undefined, selected: undefined })}
            className={cn(
              'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none max-md:min-h-11 max-md:px-3.5',
              activeApp === undefined
                ? 'border-primary/40 bg-primary/15 text-foreground'
                : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {t('filters.allApps')}
          </button>
          {availableApps.map((app: NotificationAppFilter) => {
            const pressed = activeApp === app;
            return (
              <button
                key={app}
                type="button"
                aria-pressed={pressed}
                data-testid={`notifications-app-${app}`}
                onClick={() => updateSearch({ app: pressed ? undefined : app, selected: undefined })}
                className={cn(
                  'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none max-md:min-h-11 max-md:px-3.5',
                  pressed
                    ? 'border-primary/40 bg-primary/15 text-foreground'
                    : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {appLabel(app)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const rowButton = (row: NotificationRow<WorkNotification>) => {
    const id = notificationRowId(row);
    const isSelected = activeRowId === id;
    if (row.type === 'group') {
      const sample = row.items[0]!;
      const relative = formatRelativeNotificationTime(sample.createdAt, locale);
      const absolute = f.dateTime(sample.createdAt);
      const app = appLabel(notificationApp(sample.kind));
      return (
        <li key={id}>
          <button
            type="button"
            data-notification-row={id}
            data-testid="notification-group"
            aria-current={isSelected ? 'true' : undefined}
            onClick={() => activateRow(row)}
            onKeyDown={(e: ReactKeyboardEvent<HTMLButtonElement>) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                activateRow(row, { focusDetail: true });
              }
            }}
            className={cn(
              'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors max-md:min-h-11 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
              isSelected ? 'border-l-2 border-l-primary bg-accent pl-3.5' : 'bg-primary/5',
            )}
          >
            <span className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 space-y-1">
              <span className="block text-sm leading-snug font-medium text-foreground">
                <NotificationGroupHeading kind={row.kind} items={row.items} cappedAtEnd={isCappedRow(row)} />
                <span className="sr-only"> ({t('unread')})</span>
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-subtle-foreground">
                <span className="font-medium text-muted-foreground">{app}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={sample.createdAt} title={absolute}>
                  {relative || absolute}
                </time>
              </span>
            </span>
            <span className="shrink-0 self-center text-xs font-medium text-link">{t('groupOpen')}</span>
          </button>
        </li>
      );
    }

    const item = row.item;
    const relative = formatRelativeNotificationTime(item.createdAt, locale);
    const absolute = f.dateTime(item.createdAt);
    const app = appLabel(notificationApp(item.kind));
    return (
      <li key={id}>
        <button
          type="button"
          data-notification-row={id}
          data-testid="notification-row"
          aria-current={isSelected ? 'true' : undefined}
          onClick={() => activateRow(row)}
          onKeyDown={(e: ReactKeyboardEvent<HTMLButtonElement>) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              activateRow(row, { focusDetail: true });
            }
          }}
          className={cn(
            'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors max-md:min-h-11 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
            isSelected ? 'border-l-2 border-l-primary bg-accent pl-3.5' : !item.read ? 'bg-primary/5' : '',
          )}
        >
          <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', item.read ? 'bg-transparent' : 'bg-primary')} aria-hidden="true" />
          <span className="min-w-0 flex-1 space-y-1">
            <span className={cn('block text-sm leading-snug', item.read ? 'text-muted-foreground' : 'font-medium text-foreground')}>
              {line(item)}
              {!item.read && <span className="sr-only"> ({t('unread')})</span>}
            </span>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-subtle-foreground">
              <span className="font-medium text-muted-foreground">{app}</span>
              <span aria-hidden="true">·</span>
              <time dateTime={item.createdAt} title={absolute}>
                {relative || absolute}
              </time>
            </span>
          </span>
        </button>
      </li>
    );
  };

  const feedRowsContent =
    rows.length === 0 ? (
      <div className="p-4">
        <Empty
          compact
          title={t('filters.filteredEmpty')}
          hint={t('filters.filteredEmptyHint')}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => updateSearch({ filter: undefined, app: undefined, selected: undefined })}
            >
              {t('filters.showAll')}
            </Button>
          }
        />
      </div>
    ) : (
      <ul ref={feedListRef} className="divide-y divide-border" data-testid="notifications-feed">
        {rows.map(rowButton)}
      </ul>
    );

  if (list.isLoading) {
    return (
      <div className="space-y-4">
        {headerControls()}
        <ListSkeleton />
      </div>
    );
  }

  if (list.error) {
    return (
      <div className="space-y-4">
        {headerControls()}
        <ErrorText>{errorMessage(list.error)}</ErrorText>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="space-y-4">
        {headerControls()}
        <Empty title={t('empty')} hint={t('emptyHint')} />
        {read.error && <ErrorText>{errorMessage(read.error)}</ErrorText>}
      </div>
    );
  }

  if (isDesktop) {
    return (
      <div className="space-y-3" data-testid="notifications-master-detail">
        <div className="grid overflow-hidden rounded-xl border border-border bg-card lg:h-[max(32rem,calc(100dvh-9rem))] lg:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
          <section aria-label={t('feedLabel')} className="flex min-h-0 min-w-0 flex-col lg:border-r lg:border-border" data-testid="notifications-feed-pane">
            <div className="space-y-3 border-b border-border p-4">
              {headerControls(true)}
              {filterBar}
            </div>
            <div ref={feedScrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="notifications-feed-scroll">
              {feedRowsContent}
            </div>
            <p className="border-t border-border px-4 py-2 text-xs text-subtle-foreground" data-testid="notifications-shortcuts-hint">
              {t('shortcutsHint')}
            </p>
          </section>
          <section
            ref={detailPaneRef}
            tabIndex={-1}
            aria-label={t('detail.regionLabel')}
            data-testid="notification-detail-pane"
            className="min-h-0 min-w-0 overflow-y-auto outline-none"
          >
            <NotificationDetailPane
              slug={slug}
              row={activeRow}
              cappedAtEnd={activeRow !== null && isCappedRow(activeRow)}
              onMarkSingleRead={(id) => markSingleRead(id, true)}
              onMarkGroupRead={markGroupRead}
              markPending={isRowMarkPending(activeRow)}
            />
          </section>
        </div>
        {read.error && <ErrorText>{errorMessage(read.error)}</ErrorText>}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="notifications-mobile">
      {headerControls()}
      {filterBar}
      <div className="overflow-hidden rounded-xl border border-border bg-card">{feedRowsContent}</div>
      {read.error && <ErrorText>{errorMessage(read.error)}</ErrorText>}
      <Sheet
        open={activeRow !== null}
        onOpenChange={(open) => {
          if (!open) closeMobileSheet();
        }}
      >
        <SheetContent closeLabel={tc('close')} data-testid="notification-detail-sheet" className="sm:max-w-lg">
          {activeRow && (
            <>
              <SheetHeader>
                <NotificationDetailHeaderMeta row={activeRow} cappedAtEnd={isCappedRow(activeRow)} />
                <SheetTitle>
                  {activeRow.type === 'group' ? (
                    <NotificationGroupHeading kind={activeRow.kind} items={activeRow.items} cappedAtEnd={isCappedRow(activeRow)} />
                  ) : (
                    titleOf(activeRow.item)
                  )}
                </SheetTitle>
              </SheetHeader>
              <SheetBody key={activeRowId ?? undefined} className="space-y-4">
                <NotificationDetailBody
                  slug={slug}
                  row={activeRow}
                  cappedAtEnd={isCappedRow(activeRow)}
                  onMarkSingleRead={(id) => markSingleRead(id, true)}
                />
                {read.error && <ErrorText>{errorMessage(read.error)}</ErrorText>}
              </SheetBody>
              <SheetFooter className="empty:hidden">
                <NotificationDetailActions
                  slug={slug}
                  row={activeRow}
                  onMarkSingleRead={(id) => markSingleRead(id, true)}
                  onMarkGroupRead={markGroupRead}
                  markPending={isRowMarkPending(activeRow)}
                />
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

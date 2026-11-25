// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox (CV3, #2306, plan docs/plan/conversations.md section 11): the three panes of the Hộp thư group of the Social app. Left: the conversations, with
// the New, Pending and Resolved tabs, a search, the filters (comments or private messages, channel, assignee), unread dots and "X is replying". Middle: the
// thread with its reply box, saved replies, the draft and the notes. Right: the contact panel. Comments and private messages are listed together, one
// unread mark for each; a private message is in the list only for those the database lets read it. The open thread, the tab and the filters live in the
// address, so a link (Home's, a notification's) opens the screen where it should.
// Layout (#3582, DESIGN.md 3.4 and 5.3): the filters on one row above one frame; inside it the list on the left (its own scroll) and the reading pane (thread,
// then the contact panel, or beside it from 2xl) filling the height from xl. Below xl it is a list and then the conversation full screen with a back control.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { CONVERSATION_INTENTS } from '@ludy/kernel-contract';
import { Link, useParams } from '@tanstack/react-router';
import { Button, buttonVariants } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { NavIcon } from '@ludy/ui/components/nav-icon';
import { cn } from '@ludy/ui/lib/utils';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect } from '@ludy/ui/components/native-select';
import { Badge } from '@ludy/ui/components/badge';
import { Tabs, TabsList, TabsTrigger } from '@ludy/ui/components/tabs';
import { ErrorText, RowsSkeleton } from './ui.tsx';
import { PaneError } from './conversation-states.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { getConfig } from '../lib/auth.ts';
import { inboxCountsInput, inboxListInput, type InboxSearch } from '../lib/conversation-inbox.ts';
import { sortByIntent } from '../lib/conversation-intent.ts';
import { INBOX_SPLIT_UP, useMediaQuery } from '../lib/media.ts';
import { TOUCH_BUTTON } from '../lib/conversation-touch.ts';
import { withSearch } from '../lib/search.ts';
import { useDebounced } from '../lib/use-debounced.ts';
import { ConversationListItem, ConversationThread, LoadOlderConversations, OfflineVerifyNotice, POLL_MS, STATUSES, useConversationPages, useMe, useVerifyOnUnpause, verifySharedRefetch } from './conversation-inbox.tsx';
import { useIntentSuggestions } from './conversation-intent.tsx';
import { ContactPanel } from './conversation-contact-panel.tsx';
import { EmailAddressCard } from './conversation-email-address.tsx';

const SEARCH_PAUSE_MS = 300;

// The member's own status: taking new conversations (told about a new one first) or away. It changes nothing about what they can read or answer.
export function AvailabilityControl({ paused = false }: { paused?: boolean } = {}) {
  const t = useTranslations('conversations.inbox.availability');
  const { canWrite } = useMe();
  const [activated, setActivated] = useState(!paused);
  useEffect(() => {
    if (!paused) setActivated(true);
  }, [paused]);
  const current = useQuery({
    ...orpc.conversations.availability.queryOptions({ input: {} }),
    enabled: activated && !paused && canWrite,
    refetchOnWindowFocus: activated && !paused && canWrite,
    refetchOnReconnect: activated && !paused && canWrite,
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  if (!canWrite || !current.data) return null;
  const available = current.data.me.status === 'available';
  const change = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    try {
      await client.conversations.setAvailability({ status: next ? 'available' : 'away' });
      await queryClient.invalidateQueries({ queryKey: orpc.conversations.availability.key() });
    } catch (error) {
      setFailed(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="availability">
      <label className="flex items-center gap-2 font-medium whitespace-nowrap text-foreground">
        <Checkbox checked={available} aria-busy={busy} data-testid="availability-switch" onCheckedChange={(checked) => void change(checked === true)} />
        {t('switchLabel')}
      </label>
      <Badge variant={available ? 'default' : 'outline'} data-testid="availability-status" role="status">
        {available ? t('available') : t('away')}
      </Badge>
      <p className="text-xs text-subtle-foreground">{available ? t('availableHint') : t('awayHint')}</p>
      {failed !== null && <ErrorText>{errorMessage(failed)}</ErrorText>}
    </div>
  );
}

// One empty state for both panes: centred in the pane, no box, what will appear and (for a list) nothing to press (DESIGN.md 5.3).
function PaneEmpty({ title, hint, testId }: { title: string; hint?: string | undefined; testId?: string }) {
  return (
    <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-1 px-6 py-10 text-center" data-testid={testId}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-xs text-xs text-subtle-foreground">{hint}</p>}
    </div>
  );
}

// An Inbox with no channel to receive from is not "all clear" (#3638): it says so, offers the one action (connect a channel), and, where the server receives mail, the
// other way in: forward an email to the Inbox's own address.
export function NoChannelsEmpty({ slug, address, canConnect = true }: { slug: string; address: string | null; canConnect?: boolean }) {
  const t = useTranslations('conversations.inbox');
  return (
    <div className="flex min-h-48 flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center" data-testid="inbox-no-channels">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t('noChannels')}</p>
        <p className="max-w-xs text-xs text-subtle-foreground">{t('noChannelsHint')}</p>
      </div>
      {/* A viewer cannot connect a channel, so the button is for those who may answer; the others read the hint. */}
      {canConnect && (
        <Link to="/o/$slug/social/channels" params={{ slug }} className={cn(buttonVariants({ size: 'lg' }), TOUCH_BUTTON)} data-testid="inbox-connect-channel">
          {t('connectChannel')}
        </Link>
      )}
      {address && (
        <p className="max-w-xs text-xs text-subtle-foreground" data-testid="inbox-forward-address">
          {t('orForward')} <span className="font-mono break-all text-foreground">{address}</span>
        </p>
      )}
    </div>
  );
}

function findScrollAnchor(listEl: HTMLUListElement | null, viewportTop: number): { id: string; offset: number } | null {
  if (!listEl) return null;
  const rows = listEl.children;
  if (rows.length === 0) return null;
  let lo = 0;
  let hi = rows.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = rows[mid] as HTMLElement;
    if (row.getBoundingClientRect().bottom > viewportTop + 1) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (found < 0) return null;
  const target = rows[found] as HTMLElement;
  const id = target.dataset.conversationId;
  return id ? { id, offset: target.getBoundingClientRect().top - viewportTop } : null;
}

export type ListRestoreAction = 'none' | 'load_more' | 'restore_scroll';

export function shouldCaptureMultiPageRestore(args: {
  wasHidden: boolean;
  hideList: boolean;
  prevPageCount: number;
  hasTarget: boolean;
  hasAnchor: boolean;
  containerScrollTop: number;
  windowScrollY: number;
}): boolean {
  return (
    !args.wasHidden &&
    args.hideList &&
    args.prevPageCount > 1 &&
    !args.hasTarget &&
    (args.hasAnchor || args.containerScrollTop > 0 || args.windowScrollY > 0)
  );
}

export function nextListRestoreStep(args: {
  showList?: boolean;
  hideList: boolean;
  listRefetchFailed: boolean;
  loaded: boolean;
  itemIds: readonly string[];
  pageCount: number;
  hasMore: boolean;
  loadingMore: boolean;
  loadFailed: boolean;
  target: { anchorId: string | null; minPages: number } | null;
  wasHidden: boolean;
  savedScrollTop: number;
  hasRoomBelowAnchor?: boolean;
}): ListRestoreAction {
  if (args.showList === false || args.hideList || args.listRefetchFailed || !args.loaded) return 'none';
  if (args.target) {
    const foundAnchor = args.target.anchorId !== null && args.itemIds.includes(args.target.anchorId);
    const hasRoom = foundAnchor && (args.hasRoomBelowAnchor ?? true);
    const reachedMinPages = args.pageCount >= args.target.minPages;
    if ((!foundAnchor || !hasRoom) && !reachedMinPages) {
      if (args.loadFailed || !args.hasMore) return 'restore_scroll';
      return args.loadingMore ? 'none' : 'load_more';
    }
    return 'restore_scroll';
  }
  if (args.wasHidden && args.itemIds.length > 0 && args.savedScrollTop > 0) {
    return 'restore_scroll';
  }
  return 'none';
}

export function shouldCancelRestoreOnUserScroll(args: {
  hideList: boolean;
  showList: boolean;
  loaded: boolean;
  programmaticScroll: boolean;
}): boolean {
  return !args.hideList && args.showList && args.loaded && !args.programmaticScroll;
}

export function initialDeepLinkRestoreTarget(
  pageCount: number,
  conversationId: string | undefined,
  items: readonly { id: string }[],
): { anchorId: string | null; anchorOffset: number; minPages: number } | null {
  if (pageCount <= 1 || !conversationId || !items.some((c) => c.id === conversationId)) return null;
  return { anchorId: conversationId, anchorOffset: 0, minPages: pageCount };
}

export function shouldClearDeferredInitialOpen(args: {
  covered: boolean;
  activated: boolean;
  deferredInitialOpen: boolean;
  openId: string | null;
  listReady: boolean;
  showReading: boolean;
}): boolean {
  return (
    !args.covered &&
    args.activated &&
    args.deferredInitialOpen &&
    ((args.showReading && args.openId !== null) || (args.listReady && args.openId === null))
  );
}

export function InboxScreen({ search, onSearch, covered = false }: { search: InboxSearch; onSearch: (next: InboxSearch) => void; covered?: boolean }) {
  const t = useTranslations('conversations');
  const ti = useTranslations('conversations.inbox');
  const tn = useTranslations('conversations.intent');
  const status = search.status ?? 'new';
  // Defer initial inbox list, counts, channels, and thread auto-open when arriving straight on ?settings=true; once loaded, keep panes mounted (so any typed reply stays intact) and pause polling while covered.
  const [activated, setActivated] = useState(!covered);
  useEffect(() => {
    if (!covered) setActivated(true);
  }, [covered]);
  // The Inbox's own channel filter lists the messaging-only channels too (WhatsApp never publishes, so every other list leaves it out).
  const channels = useQuery({ ...orpc.channels.list.queryOptions({ input: { includeMessaging: true } }), enabled: activated && !covered });
  const list = useConversationPages(inboxListInput(search), { enabled: activated, paused: covered });
  const countsOptions = orpc.conversations.counts.queryOptions({ input: inboxCountsInput(search) });
  const counts = useQuery({
    ...countsOptions,
    enabled: activated && !covered,
    refetchInterval: activated && !covered ? POLL_MS : false,
    refetchOnWindowFocus: activated && !covered,
    refetchOnReconnect: activated && !covered,
  });
  const verifyingCounts = useVerifyOnUnpause(
    covered || !activated,
    (cancelExisting) => verifySharedRefetch(countsOptions.queryKey, () => counts.refetch({ cancelRefetch: false }), cancelExisting),
    activated,
    false,
    countsOptions.queryKey,
    undefined,
    counts.data !== undefined,
  );
  const { canWrite } = useMe();
  const systemAiOn = getConfig().aiEnabled === true;
  // The AI coworker's suggested intents for the top of the New list (a read, never stored); the list may be ordered by them, a sort of the page only.
  const loaded = list.items;
  const listRefetchFailed = !list.verifying && Boolean(list.error) && !list.loadFailed;
  const listReady = activated && list.loaded && !listRefetchFailed;
  const { suggested, ai } = useIntentSuggestions(loaded, canWrite && systemAiOn && status === 'new' && !covered && listReady, canWrite && systemAiOn && activated && !covered);
  const items = search.order === 'intent' && status === 'new' ? sortByIntent(loaded, suggested) : loaded;
  // Opening ?settings=true (with or without ?c=) defers opening/mounting a thread until settings close; verify that first revealed thread on mount even if its detail was cached earlier.
  const [deferredInitialOpen, setDeferredInitialOpen] = useState(covered);
  // The thread shown: wait until Inbox activates (drawer closed) even when ?c=...&settings=true is deep-linked directly, so thread detail and tasks do not fetch behind the drawer.
  const openId = activated ? (search.c ?? (listReady ? items[0]?.id : undefined) ?? null) : null;
  // From xl the list and the conversation sit side by side; below it one shows at a time (the screen renders one layout, not both with one hidden, so
  // the thread behind the list is not mounted and does not mark itself read): the list, or the conversation after a tap or a link that names one.
  const split = useMediaQuery(INBOX_SPLIT_UP);
  const [reading, setReading] = useState(search.c !== undefined);
  // The thread the screen itself opened for good (below): it is not "opened" by the reader, so the list stays first on a phone.
  const autoOpened = useRef<string | null>(null);
  // The conversation the reader opened: it stays mounted while the list is shown again below xl, so a reply being typed is not lost on "back".
  const [readerOpened, setReaderOpened] = useState<string | null>(search.c ?? null);
  useEffect(() => {
    if (search.c && search.c !== autoOpened.current) {
      setReading(true);
      setReaderOpened(search.c);
    }
  }, [search.c]);
  const showList = split || !reading || !openId;
  const showReading = split || (openId !== null && (reading || readerOpened === openId));
  useEffect(() => {
    if (shouldClearDeferredInitialOpen({ covered, activated, deferredInitialOpen, openId, listReady, showReading })) {
      setDeferredInitialOpen(false);
    }
  }, [covered, activated, deferredInitialOpen, openId, listReady, showReading]);
  const readingVisible = split || reading;
  const hideList = covered || list.verifying;
  const listRef = useRef<HTMLElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);
  const listUlRef = useRef<HTMLUListElement>(null);
  const listScrollTopRef = useRef(0);
  const windowScrollYRef = useRef(0);
  const lastVisibleAnchorRef = useRef<{ id: string; offset: number } | null>(null);
  const anchorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastVisiblePageCountRef = useRef(list.pageCount);
  const programmaticScrollRef = useRef(false);
  const restoreTargetRef = useRef<{ anchorId: string | null; anchorOffset: number; minPages: number } | null>(
    initialDeepLinkRestoreTarget(list.pageCount, search.c, list.items),
  );
  const captureAnchorNow = () => {
    if (hideList) return;
    const container = listScrollRef.current;
    const isContainerScroll = container !== null && container.scrollHeight > container.clientHeight;
    const scrollPos = isContainerScroll ? container.scrollTop : typeof window !== 'undefined' ? window.scrollY : 0;
    if (isContainerScroll) listScrollTopRef.current = scrollPos;
    else if (typeof window !== 'undefined') windowScrollYRef.current = scrollPos;
    if (scrollPos <= 0) {
      lastVisibleAnchorRef.current = null;
      return;
    }
    const viewportTop = isContainerScroll && container ? container.getBoundingClientRect().top : 0;
    lastVisibleAnchorRef.current = findScrollAnchor(listUlRef.current, viewportTop);
  };
  const scheduleScrollCapture = (containerTop?: number) => {
    if (hideList) return;
    if (shouldCancelRestoreOnUserScroll({ hideList, showList, loaded: list.loaded, programmaticScroll: programmaticScrollRef.current })) {
      restoreTargetRef.current = null;
    }
    // Invalidate any prior row anchor as soon as the user scrolls so opening Settings before the 80ms debounce fires
    // falls back to the latest numeric scroll offset instead of reverting to an older row.
    lastVisibleAnchorRef.current = null;
    if (containerTop !== undefined) listScrollTopRef.current = containerTop;
    else if (typeof window !== 'undefined') windowScrollYRef.current = window.scrollY;
    if (anchorTimerRef.current !== null) clearTimeout(anchorTimerRef.current);
    anchorTimerRef.current = setTimeout(() => {
      anchorTimerRef.current = null;
      captureAnchorNow();
    }, 80);
  };
  useEffect(() => {
    if (hideList || !showList || typeof window === 'undefined') return;
    const onWindowScroll = () => scheduleScrollCapture();
    window.addEventListener('scroll', onWindowScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onWindowScroll);
      if (anchorTimerRef.current !== null) {
        clearTimeout(anchorTimerRef.current);
        anchorTimerRef.current = null;
      }
    };
  }, [hideList, showList]); // eslint-disable-line react-hooks/exhaustive-deps
  if (showList && !hideList && !listRefetchFailed && list.loaded) {
    lastVisiblePageCountRef.current = list.pageCount;
  }
  const wasListHiddenRef = useRef(hideList);
  if (
    shouldCaptureMultiPageRestore({
      wasHidden: wasListHiddenRef.current,
      hideList,
      prevPageCount: lastVisiblePageCountRef.current,
      hasTarget: restoreTargetRef.current !== null,
      hasAnchor: lastVisibleAnchorRef.current !== null,
      containerScrollTop: listScrollTopRef.current,
      windowScrollY: windowScrollYRef.current,
    })
  ) {
    restoreTargetRef.current = {
      anchorId: lastVisibleAnchorRef.current?.id ?? null,
      anchorOffset: lastVisibleAnchorRef.current?.offset ?? 0,
      minPages: lastVisiblePageCountRef.current,
    };
  }
  useEffect(() => {
    if (hideList) wasListHiddenRef.current = true;
    // On mobile (< xl) while viewing a conversation (?c=...&settings=true or navigating back from settings), keep restoreTargetRef
    // and wasListHiddenRef intact until the list section mounts visibly (`showList && listUlRef.current`) so room-below-anchor
    // measurements and loadMore / scroll restoration run against the real list DOM rather than firing or clearing against null.
    if (!showList || (items.length > 0 && !listUlRef.current)) return;
    const container = listScrollRef.current;
    const isContainerScroll = container !== null && container.scrollHeight > container.clientHeight;
    const target = restoreTargetRef.current;
    let hasRoomBelowAnchor = true;
    if (!hideList && !listRefetchFailed && list.loaded && target?.anchorId && listUlRef.current) {
      const ul = listUlRef.current;
      let anchorEl: HTMLElement | null = null;
      for (const child of ul.children) {
        const row = child as HTMLElement;
        if (row.dataset.conversationId === target.anchorId) {
          anchorEl = row;
          break;
        }
      }
      const lastRow = ul.lastElementChild as HTMLElement | null;
      if (anchorEl && lastRow) {
        const viewportHeight = isContainerScroll && container ? container.clientHeight : typeof window !== 'undefined' ? window.innerHeight : 0;
        const availableBelow = lastRow.getBoundingClientRect().bottom - anchorEl.getBoundingClientRect().top + target.anchorOffset;
        hasRoomBelowAnchor = viewportHeight <= 0 || availableBelow >= viewportHeight - 1;
      }
    }
    const step = nextListRestoreStep({
      showList,
      hideList,
      listRefetchFailed,
      loaded: list.loaded,
      itemIds: items.map((c) => c.id),
      pageCount: list.pageCount,
      hasMore: list.hasMore,
      loadingMore: list.loadingMore,
      loadFailed: list.loadFailed,
      target,
      wasHidden: wasListHiddenRef.current,
      savedScrollTop: isContainerScroll ? listScrollTopRef.current : windowScrollYRef.current,
      hasRoomBelowAnchor,
    });
    if (!hideList && list.loaded) wasListHiddenRef.current = false;
    if (step === 'load_more') {
      list.loadMore();
      return;
    }
    if (step === 'restore_scroll') {
      const target = restoreTargetRef.current;
      restoreTargetRef.current = null;
      const ul = listUlRef.current;
      let anchorRow: HTMLElement | null = null;
      if (target?.anchorId && ul) {
        for (const child of ul.children) {
          const row = child as HTMLElement;
          if (row.dataset.conversationId === target.anchorId) {
            anchorRow = row;
            break;
          }
        }
      }
      programmaticScrollRef.current = true;
      try {
        if (isContainerScroll && container) {
          if (listScrollTopRef.current > 0) container.scrollTop = listScrollTopRef.current;
          if (anchorRow && target) {
            const delta = anchorRow.getBoundingClientRect().top - container.getBoundingClientRect().top - target.anchorOffset;
            container.scrollTop = Math.max(0, container.scrollTop + delta);
          }
        } else if (typeof window !== 'undefined') {
          if (windowScrollYRef.current > 0) window.scrollTo({ top: windowScrollYRef.current, behavior: 'instant' });
          if (anchorRow && target) {
            const delta = anchorRow.getBoundingClientRect().top - target.anchorOffset;
            if (Math.abs(delta) > 1) window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: 'instant' });
          }
        }
      } finally {
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            programmaticScrollRef.current = false;
          });
        } else {
          programmaticScrollRef.current = false;
        }
      }
    }
  }, [showList, hideList, listRefetchFailed, list.loaded, list.pageCount, list.hasMore, list.loadingMore, list.loadFailed, items]); // eslint-disable-line react-hooks/exhaustive-deps
  const backRef = useRef<HTMLButtonElement>(null);
  // Switching panes moves the focus with it (WCAG 2.4.3): to the back control when the conversation opens, to the open row when the list returns.
  const openReading = (id: string) => {
    setReading(true);
    setReaderOpened(id);
    requestAnimationFrame(() => backRef.current?.focus());
  };
  const closeReading = () => {
    setReading(false);
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>('[data-testid="conversation-item"][aria-current="true"]')?.focus());
  };
  // A change of tab or filter starts a new list: the open thread is the first of it again.
  const change = (next: { [K in keyof InboxSearch]?: InboxSearch[K] | undefined }) => {
    listScrollTopRef.current = 0;
    windowScrollYRef.current = 0;
    lastVisibleAnchorRef.current = null;
    lastVisiblePageCountRef.current = 0;
    restoreTargetRef.current = null;
    setReading(false);
    onSearch(withSearch(search, { c: undefined, ...next }));
  };
  // The first thread of a list is opened for good once the current list query succeeds (never from stale cache while re-verifying or after a refetch error): answering it moves it to another tab, and it stays on screen (the address names it from then on).
  const first = listReady ? items[0]?.id : undefined;
  // A thread the reader may no longer read has just gone: it is not opened again from the list that still holds it until the next poll.
  const gone = useRef<string | null>(null);
  // The open thread is gone (the reader may not read it, or its customer was erased): leave it.
  const leave = () => {
    gone.current = openId;
    change({});
  };
  useEffect(() => {
    if (!covered && listReady && !search.c && first && first !== gone.current) {
      autoOpened.current = first;
      onSearch({ ...search, c: first });
    }
  }, [covered, listReady, search.c, first]); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState(search.q ?? '');
  const typed = useDebounced(text.trim(), SEARCH_PAUSE_MS);
  useEffect(() => {
    if ((search.q ?? '') !== typed) change({ q: typed === '' ? undefined : typed });
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps
  const channelList = (channels.data ?? []).filter((c) => c.status !== 'revoked');
  // Nothing connected (the channel list has loaded and holds none): the empty New tab says so instead of "no new conversations".
  // "Nothing connected" counts the Inbox's own email connection too (made by the first customer mail): an org that only receives forwarded email is not unconnected.
  const everyChannel = useQuery({ ...orpc.channels.list.queryOptions({ input: { includeMessaging: true, includeEmail: true } }), enabled: activated && !covered });
  const noChannels = everyChannel.data !== undefined && everyChannel.data.every((c) => c.status === 'revoked');
  // Neither empty text is drawn until that list has answered (or failed, when the ordinary empty text stands): a list that finishes first must not say "all clear" to an org
  // with no channel for a moment.
  const emptyReady = listReady && (everyChannel.data !== undefined || everyChannel.isError);
  const { slug } = useParams({ strict: false }) as { slug: string };
  const org = useQuery({ ...orpc.org.get.queryOptions(), enabled: activated });
  const paneClass = 'min-h-0 min-w-0';
  return (
    <div className="space-y-3" data-testid="inbox" data-reading={reading}>
      <div className={cn('flex flex-wrap items-end gap-3', !showList && 'hidden')} role="search" aria-label={ti('filters.label')}>
        <div className="min-w-48 flex-[2] basis-full sm:basis-48">
          <label htmlFor="inbox-search" className="mb-1 block text-xs font-medium text-muted-foreground">
            {ti('searchLabel')}
          </label>
          <Input id="inbox-search" type="search" value={text} maxLength={100} placeholder={ti('searchPlaceholder')} onChange={(e) => setText(e.target.value)} />
        </div>
        <label className="min-w-[8.5rem] flex-1 text-xs font-medium text-muted-foreground">
          <span className="mb-1 block">{ti('filters.kind')}</span>
          <NativeSelect className="w-full" value={search.kind ?? ''} onChange={(e) => change({ kind: e.target.value === '' ? undefined : (e.target.value as InboxSearch['kind']) })} data-testid="inbox-kind">
            <option value="">{ti('filters.kindAll')}</option>
            <option value="comment_thread">{t('kind.comment_thread')}</option>
            <option value="direct">{t('kind.direct')}</option>
            <option value="email">{t('kind.email')}</option>
          </NativeSelect>
        </label>
        <label className="min-w-[8.5rem] flex-1 text-xs font-medium text-muted-foreground">
          <span className="mb-1 block">{ti('filters.channel')}</span>
          <NativeSelect className="w-full" value={search.channel ?? ''} onChange={(e) => change({ channel: e.target.value === '' ? undefined : e.target.value })} data-testid="inbox-channel">
            <option value="">{ti('filters.channelAll')}</option>
            {channelList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="min-w-[8.5rem] flex-1 text-xs font-medium text-muted-foreground">
          <span className="mb-1 block">{ti('filters.assignee')}</span>
          <NativeSelect className="w-full" value={search.assignee ?? ''} onChange={(e) => change({ assignee: e.target.value === '' ? undefined : (e.target.value as InboxSearch['assignee']) })} data-testid="inbox-assignee">
            <option value="">{ti('filters.assigneeAll')}</option>
            <option value="me">{ti('filters.assigneeMe')}</option>
            <option value="none">{ti('filters.assigneeNone')}</option>
          </NativeSelect>
        </label>
        <label className="min-w-[8.5rem] flex-1 text-xs font-medium text-muted-foreground">
          <span className="mb-1 block">{ti('filters.intent')}</span>
          <NativeSelect className="w-full" value={search.intent ?? ''} onChange={(e) => change({ intent: e.target.value === '' ? undefined : (e.target.value as InboxSearch['intent']) })} data-testid="inbox-intent">
            <option value="">{ti('filters.intentAll')}</option>
            {CONVERSATION_INTENTS.map((intent) => (
              <option key={intent} value={intent}>
                {tn(`label.${intent}`)}
              </option>
            ))}
            <option value="none">{ti('filters.intentNone')}</option>
          </NativeSelect>
        </label>
      </div>
      {/* One frame, one hairline between the panes (no cards in cards, DESIGN.md 3.4). From xl it fills the window's height and each pane scrolls on its own. */}
      <div className="flex flex-col overflow-hidden rounded-lg border border-border xl:grid xl:h-[max(30rem,calc(100dvh-16rem))] xl:grid-cols-[20rem_minmax(0,1fr)]">
        {showList && (
        <section
          ref={listRef}
          aria-label={t('listLabel')}
          className={cn(paneClass, 'flex flex-col xl:border-r xl:border-border')}
          data-testid="inbox-list"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) captureAnchorNow();
          }}
        >
          <div className="space-y-2 border-b border-border p-3">
            <Tabs value={status} onValueChange={(v) => change({ status: v === 'new' ? undefined : (v as InboxSearch['status']) })}>
              <TabsList className="w-full">
                {STATUSES.map((s) => (
                  <TabsTrigger key={s} value={s} data-testid={`conversation-tab-${s}`}>
                    {t(`status.${s}`)}
                    {activated && !covered && !verifyingCounts && !list.verifying && !counts.isError && counts.data ? <span className="ml-1 text-xs text-muted-foreground tabular-nums">{counts.data[s]}</span> : null}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            {canWrite && status === 'new' && (
              <div className="space-y-0.5">
                <label className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
                  <input type="checkbox" checked={search.order === 'intent'} aria-describedby="inbox-order-hint" data-testid="inbox-order-intent" onChange={(e) => change({ order: e.target.checked ? 'intent' : undefined })} />
                  {tn('order')}
                </label>
                <p id="inbox-order-hint" className="text-xs text-subtle-foreground">
                  {tn('orderHint')}
                </p>
              </div>
            )}
            {!hideList && ai === 'budget' && status === 'new' && (
              <p className="text-xs text-muted-foreground" role="status">
                {tn('budget')}
              </p>
            )}
          </div>
          <div
            ref={listScrollRef}
            onScroll={(e) => scheduleScrollCapture(e.currentTarget.scrollTop)}
            className="flex min-h-0 flex-1 flex-col xl:overflow-y-auto"
          >
            {(list.isPending || hideList) && (
              <div className={!covered && list.verifyingOffline ? 'p-3' : 'px-3'}>
                {!covered && list.verifyingOffline ? <OfflineVerifyNotice testId="inbox-list-offline" /> : <RowsSkeleton rows={6} />}
              </div>
            )}
            {activated && !hideList && listRefetchFailed && (
              <div className="p-3">
                <PaneError message={errorMessage(list.error)} onRetry={list.retry} testId="inbox-list-error" />
              </div>
            )}
            {!hideList && emptyReady && items.length === 0 && noChannels && !search.q && status === 'new' && <NoChannelsEmpty slug={slug} address={org.data?.conversationAddress ?? null} canConnect={canWrite} />}
            {!hideList && emptyReady && items.length === 0 && !(noChannels && !search.q && status === 'new') && <PaneEmpty title={search.q ? ti('noMatch') : ti(`empty.${status}`)} hint={!search.q && status === 'new' ? ti('emptyNewHint') : undefined} testId="inbox-list-empty" />}
            {activated && !listRefetchFailed && items.length > 0 && (
              <div className={hideList ? 'hidden' : undefined} data-testid="inbox-list-content">
                <ul ref={listUlRef} className="divide-y divide-border">
                  {items.map((c) => (
                    <ConversationListItem
                      key={c.id}
                      conversation={c}
                      open={c.id === openId}
                      onOpen={() => {
                        captureAnchorNow();
                        openReading(c.id);
                        onSearch({ ...search, c: c.id });
                      }}
                      suggested={suggested.get(c.id) ?? null}
                    />
                  ))}
                </ul>
                <div className="p-3 pt-0 empty:hidden">
                  <LoadOlderConversations hasMore={list.hasMore} loading={list.loadingMore} failed={list.loadFailed} onLoad={list.loadMore} />
                </div>
              </div>
            )}
          </div>
        </section>
        )}
        {showReading && (
        <section
          aria-label={t('threadLabel')}
          className={cn(paneClass, 'flex flex-col xl:overflow-y-auto 2xl:grid 2xl:grid-cols-[minmax(0,1fr)_16rem] 2xl:overflow-hidden', !readingVisible && 'hidden')}
          data-testid="inbox-reading"
        >
          {openId ? (
            <>
              <div className="min-w-0 space-y-3 p-4 2xl:overflow-y-auto">
                <Button ref={backRef} type="button" variant="ghost" size="sm" className="-ml-2 xl:hidden" data-testid="inbox-back" onClick={closeReading}>
                  <NavIcon name="expand" className="rotate-90" />
                  {ti('back')}
                </Button>
                <ConversationThread
                  key={openId}
                  conversationId={openId}
                  paused={covered || !readingVisible}
                  verifyOnMount={deferredInitialOpen}
                  onGone={leave}
                  onOpenConversation={(id) => onSearch({ ...search, c: id })}
                />
              </div>
              <div className="min-w-0 border-t border-border p-4 2xl:overflow-y-auto 2xl:border-t-0 2xl:border-l">
                <ContactPanel key={openId} conversationId={openId} paused={covered || !readingVisible} verifyOnMount={deferredInitialOpen} onOpen={(id) => onSearch({ ...search, c: id })} onErased={leave} />
              </div>
            </>
          ) : (
            <PaneEmpty title={t('pick')} testId="inbox-reading-empty" />
          )}
        </section>
        )}
      </div>
      {activated && showList && (
        <div className={covered ? 'hidden' : undefined} data-testid="inbox-email-address-wrap">
          <EmailAddressCard />
        </div>
      )}
    </div>
  );
}

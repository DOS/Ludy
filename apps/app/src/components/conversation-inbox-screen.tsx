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
import { CONVERSATION_INTENTS } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { NavIcon } from '@crove/ui/components/nav-icon';
import { cn } from '@crove/ui/lib/utils';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { Badge } from '@crove/ui/components/badge';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { ErrorText, RowsSkeleton } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { inboxCountsInput, inboxListInput, type InboxSearch } from '../lib/conversation-inbox.ts';
import { sortByIntent } from '../lib/conversation-intent.ts';
import { INBOX_SPLIT_UP, useMediaQuery } from '../lib/media.ts';
import { withSearch } from '../lib/search.ts';
import { useDebounced } from '../lib/use-debounced.ts';
import { ConversationListItem, ConversationThread, LoadOlderConversations, POLL_MS, STATUSES, useConversationPages, useMe } from './conversation-inbox.tsx';
import { useIntentSuggestions } from './conversation-intent.tsx';
import { ContactPanel } from './conversation-contact-panel.tsx';
import { EmailAddressCard } from './conversation-email-address.tsx';

const SEARCH_PAUSE_MS = 300;

// The member's own status: taking new conversations (told about a new one first) or away. It changes nothing about what they can read or answer.
export function AvailabilityControl() {
  const t = useTranslations('conversations.inbox.availability');
  const { canWrite } = useMe();
  const current = useQuery(orpc.conversations.availability.queryOptions({ input: {} }));
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

export function InboxScreen({ search, onSearch }: { search: InboxSearch; onSearch: (next: InboxSearch) => void }) {
  const t = useTranslations('conversations');
  const ti = useTranslations('conversations.inbox');
  const tn = useTranslations('conversations.intent');
  const status = search.status ?? 'new';
  // The Inbox's own channel filter lists the messaging-only channels too (WhatsApp never publishes, so every other list leaves it out).
  const channels = useQuery(orpc.channels.list.queryOptions({ input: { includeMessaging: true } }));
  const list = useConversationPages(inboxListInput(search));
  const counts = useQuery({ ...orpc.conversations.counts.queryOptions({ input: inboxCountsInput(search) }), refetchInterval: POLL_MS });
  const { canWrite } = useMe();
  // The AI coworker's suggested intents for the top of the New list (a read, never stored); the list may be ordered by them, a sort of the page only.
  const loaded = list.items;
  const { suggested, ai } = useIntentSuggestions(loaded, canWrite && status === 'new');
  const items = search.order === 'intent' && status === 'new' ? sortByIntent(loaded, suggested) : loaded;
  // The thread shown: the one the address names (kept even when it has moved to another tab), else the first of the list.
  const openId = search.c ?? items[0]?.id ?? null;
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
  const readingVisible = split || reading;
  const listRef = useRef<HTMLElement>(null);
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
    setReading(false);
    onSearch(withSearch(search, { c: undefined, ...next }));
  };
  // The first thread of a list is opened for good: answering it moves it to another tab, and it stays on screen (the address names it from then on).
  const first = items[0]?.id;
  // A thread the reader may no longer read has just gone: it is not opened again from the list that still holds it until the next poll.
  const gone = useRef<string | null>(null);
  // The open thread is gone (the reader may not read it, or its customer was erased): leave it.
  const leave = () => {
    gone.current = openId;
    change({});
  };
  useEffect(() => {
    if (!search.c && first && first !== gone.current) {
      autoOpened.current = first;
      onSearch({ ...search, c: first });
    }
  }, [search.c, first]); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState(search.q ?? '');
  const typed = useDebounced(text.trim(), SEARCH_PAUSE_MS);
  useEffect(() => {
    if ((search.q ?? '') !== typed) change({ q: typed === '' ? undefined : typed });
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps
  const channelList = (channels.data ?? []).filter((c) => c.status !== 'revoked');
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
        <section ref={listRef} aria-label={t('listLabel')} className={cn(paneClass, 'flex flex-col xl:border-r xl:border-border')} data-testid="inbox-list">
          <div className="space-y-2 border-b border-border p-3">
            <Tabs value={status} onValueChange={(v) => change({ status: v === 'new' ? undefined : (v as InboxSearch['status']) })}>
              <TabsList className="w-full">
                {STATUSES.map((s) => (
                  <TabsTrigger key={s} value={s} data-testid={`conversation-tab-${s}`}>
                    {t(`status.${s}`)}
                    {counts.data ? <span className="ml-1 text-xs text-muted-foreground tabular-nums">{counts.data[s]}</span> : null}
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
            {ai === 'budget' && status === 'new' && (
              <p className="text-xs text-muted-foreground" role="status">
                {tn('budget')}
              </p>
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col xl:overflow-y-auto">
            {list.isPending && (
              <div className="px-3">
                <RowsSkeleton rows={6} />
              </div>
            )}
            {list.error && (
              <div className="p-3">
                <ErrorText>{errorMessage(list.error)}</ErrorText>
              </div>
            )}
            {list.loaded && items.length === 0 && <PaneEmpty title={search.q ? ti('noMatch') : ti(`empty.${status}`)} hint={!search.q && status === 'new' ? ti('emptyNewHint') : undefined} testId="inbox-list-empty" />}
            {items.length > 0 && (
              <ul className="divide-y divide-border">
                {items.map((c) => (
                  <ConversationListItem
                    key={c.id}
                    conversation={c}
                    open={c.id === openId}
                    onOpen={() => {
                      openReading(c.id);
                      onSearch({ ...search, c: c.id });
                    }}
                    suggested={suggested.get(c.id) ?? null}
                  />
                ))}
              </ul>
            )}
            <div className="p-3 pt-0 empty:hidden">
              <LoadOlderConversations hasMore={list.hasMore} loading={list.loadingMore} failed={list.loadFailed} onLoad={list.loadMore} />
            </div>
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
                  onGone={leave}
                  onOpenConversation={(id) => onSearch({ ...search, c: id })}
                />
              </div>
              <div className="min-w-0 border-t border-border p-4 2xl:overflow-y-auto 2xl:border-t-0 2xl:border-l">
                <ContactPanel key={openId} conversationId={openId} onOpen={(id) => onSearch({ ...search, c: id })} onErased={leave} />
              </div>
            </>
          ) : (
            <PaneEmpty title={t('pick')} testId="inbox-reading-empty" />
          )}
        </section>
        )}
      </div>
      {showList && <EmailAddressCard />}
    </div>
  );
}

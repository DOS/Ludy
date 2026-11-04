// SPDX-License-Identifier: AGPL-3.0-only
// The Inbox (CV3, #2306, plan docs/plan/conversations.md section 11): the three panes of the Hộp thư group of the Social app. Left: the conversations, with
// the New, Pending and Resolved tabs, a search, the filters (comments or private messages, channel, assignee), unread dots and "X is replying". Middle: the
// thread with its reply box, saved replies, the draft and the notes. Right: the contact panel. Comments and private messages are listed together, one
// unread mark for each; a private message is in the list only for those the database lets read it. The open thread, the tab and the filters live in the
// address, so a link (Home's, a notification's) opens the screen where it should.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { CONVERSATION_INTENTS } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Empty, ErrorText, Spinner } from './ui.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { inboxCountsInput, inboxListInput, type InboxSearch } from '../lib/conversation-inbox.ts';
import { sortByIntent } from '../lib/conversation-intent.ts';
import { withSearch } from '../lib/search.ts';
import { useDebounced } from '../lib/use-debounced.ts';
import { ConversationListItem, ConversationThread, POLL_MS, STATUSES, useMe } from './conversation-inbox.tsx';
import { useIntentSuggestions } from './conversation-intent.tsx';
import { ContactPanel } from './conversation-contact-panel.tsx';
import { EmailAddressCard } from './conversation-email-address.tsx';

const SEARCH_PAUSE_MS = 300;

// The member's own switch: available (told about a new conversation first) or away. It changes nothing about what they can read or answer.
function AvailabilitySwitch() {
  const t = useTranslations('conversations.inbox.availability');
  const { canWrite } = useMe();
  const current = useQuery(orpc.conversations.availability.queryOptions({ input: {} }));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<unknown>(null);
  if (!canWrite || !current.data) return null;
  const available = current.data.me.status === 'available';
  const toggle = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await client.conversations.setAvailability({ status: available ? 'away' : 'available' });
      await queryClient.invalidateQueries({ queryKey: orpc.conversations.availability.key() });
    } catch (error) {
      setFailed(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="availability">
      <Button type="button" size="sm" variant={available ? 'outline' : 'default'} loading={busy} onClick={() => void toggle()}>
        {available ? t('setAway') : t('setAvailable')}
      </Button>
      <span className="text-muted-foreground" role="status">
        {available ? t('available') : t('away')}
      </span>
      {failed !== null && <ErrorText>{errorMessage(failed)}</ErrorText>}
    </div>
  );
}

export function InboxScreen({ search, onSearch }: { search: InboxSearch; onSearch: (next: InboxSearch) => void }) {
  const t = useTranslations('conversations');
  const ti = useTranslations('conversations.inbox');
  const tn = useTranslations('conversations.intent');
  const status = search.status ?? 'new';
  const channels = useQuery(orpc.channels.list.queryOptions({ input: {} }));
  const list = useQuery({ ...orpc.conversations.list.queryOptions({ input: inboxListInput(search) }), refetchInterval: POLL_MS });
  const counts = useQuery({ ...orpc.conversations.counts.queryOptions({ input: inboxCountsInput(search) }), refetchInterval: POLL_MS });
  const { canWrite } = useMe();
  // The AI coworker's suggested intents for the top of the New list (a read, never stored); the list may be ordered by them, a sort of the page only.
  const loaded = list.data?.conversations ?? [];
  const { suggested, ai } = useIntentSuggestions(loaded, canWrite && status === 'new');
  const items = search.order === 'intent' && status === 'new' ? sortByIntent(loaded, suggested) : loaded;
  // The thread shown: the one the address names (kept even when it has moved to another tab), else the first of the list.
  const openId = search.c ?? items[0]?.id ?? null;
  // A change of tab or filter starts a new list: the open thread is the first of it again.
  const change = (next: { [K in keyof InboxSearch]?: InboxSearch[K] | undefined }) => onSearch(withSearch(search, { c: undefined, ...next }));
  // The first thread of a list is opened for good: answering it moves it to another tab, and it stays on screen (the address names it from then on).
  const first = items[0]?.id;
  // A thread the reader may no longer read has just gone: it is not opened again from the list that still holds it until the next poll.
  const gone = useRef<string | null>(null);
  useEffect(() => {
    if (!search.c && first && first !== gone.current) onSearch({ ...search, c: first });
  }, [search.c, first]); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState(search.q ?? '');
  const typed = useDebounced(text.trim(), SEARCH_PAUSE_MS);
  useEffect(() => {
    if ((search.q ?? '') !== typed) change({ q: typed === '' ? undefined : typed });
  }, [typed]); // eslint-disable-line react-hooks/exhaustive-deps
  const channelList = (channels.data ?? []).filter((c) => c.status !== 'revoked');
  return (
    <div className="space-y-3" data-testid="inbox">
      <div className="flex flex-wrap items-end gap-2" role="search" aria-label={ti('filters.label')}>
        <div className="min-w-48 flex-1">
          <label htmlFor="inbox-search" className="mb-1 block text-xs font-medium text-muted-foreground">
            {ti('searchLabel')}
          </label>
          <Input id="inbox-search" type="search" value={text} maxLength={100} placeholder={ti('searchPlaceholder')} onChange={(e) => setText(e.target.value)} />
        </div>
        <label className="text-xs font-medium text-muted-foreground">
          <span className="mb-1 block">{ti('filters.kind')}</span>
          <NativeSelect value={search.kind ?? ''} onChange={(e) => change({ kind: e.target.value === '' ? undefined : (e.target.value as InboxSearch['kind']) })} data-testid="inbox-kind">
            <option value="">{ti('filters.kindAll')}</option>
            <option value="comment_thread">{t('kind.comment_thread')}</option>
            <option value="direct">{t('kind.direct')}</option>
            <option value="email">{t('kind.email')}</option>
          </NativeSelect>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          <span className="mb-1 block">{ti('filters.channel')}</span>
          <NativeSelect value={search.channel ?? ''} onChange={(e) => change({ channel: e.target.value === '' ? undefined : e.target.value })} data-testid="inbox-channel">
            <option value="">{ti('filters.channelAll')}</option>
            {channelList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          <span className="mb-1 block">{ti('filters.assignee')}</span>
          <NativeSelect value={search.assignee ?? ''} onChange={(e) => change({ assignee: e.target.value === '' ? undefined : (e.target.value as InboxSearch['assignee']) })} data-testid="inbox-assignee">
            <option value="">{ti('filters.assigneeAll')}</option>
            <option value="me">{ti('filters.assigneeMe')}</option>
            <option value="none">{ti('filters.assigneeNone')}</option>
          </NativeSelect>
        </label>
        <label className="text-xs font-medium text-muted-foreground">
          <span className="mb-1 block">{ti('filters.intent')}</span>
          <NativeSelect value={search.intent ?? ''} onChange={(e) => change({ intent: e.target.value === '' ? undefined : (e.target.value as InboxSearch['intent']) })} data-testid="inbox-intent">
            <option value="">{ti('filters.intentAll')}</option>
            {CONVERSATION_INTENTS.map((intent) => (
              <option key={intent} value={intent}>
                {tn(`label.${intent}`)}
              </option>
            ))}
            <option value="none">{ti('filters.intentNone')}</option>
          </NativeSelect>
        </label>
        <AvailabilitySwitch />
      </div>
      <EmailAddressCard />
      <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)_minmax(0,16rem)]">
        <section aria-label={t('listLabel')} className="min-w-0 space-y-3" data-testid="inbox-list">
          <Tabs value={status} onValueChange={(v) => change({ status: v === 'new' ? undefined : (v as InboxSearch['status']) })}>
            <TabsList>
              {STATUSES.map((s) => (
                <TabsTrigger key={s} value={s} data-testid={`conversation-tab-${s}`}>
                  {t(`status.${s}`)}
                  {counts.data ? <span className="ml-1 text-xs text-muted-foreground tabular-nums">{counts.data[s]}</span> : null}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {canWrite && status === 'new' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={search.order === 'intent'} data-testid="inbox-order-intent" onChange={(e) => change({ order: e.target.checked ? 'intent' : undefined })} />
              {tn('order')}
            </label>
          )}
          {ai === 'budget' && status === 'new' && (
            <p className="text-xs text-muted-foreground" role="status">
              {tn('budget')}
            </p>
          )}
          {list.isPending && <Spinner />}
          {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
          {list.data && items.length === 0 && <Empty title={search.q ? ti('noMatch') : ti(`empty.${status}`)} />}
          <ul className="divide-y divide-border rounded-md border border-border">
            {items.map((c) => (
              <ConversationListItem key={c.id} conversation={c} open={c.id === openId} onOpen={() => onSearch({ ...search, c: c.id })} suggested={suggested.get(c.id) ?? null} />
            ))}
          </ul>
          {list.data?.more && <p className="text-xs text-muted-foreground">{t('more')}</p>}
        </section>
        <section aria-label={t('threadLabel')} className="min-w-0">
          {openId ? (
            <ConversationThread
              key={openId}
              conversationId={openId}
              onGone={() => {
                gone.current = openId;
                change({});
              }}
            />
          ) : (
            <Empty title={t('pick')} />
          )}
        </section>
        {openId && (
          <div className="min-w-0 md:col-span-2 lg:col-span-1">
            <ContactPanel key={openId} conversationId={openId} onOpen={(id) => onSearch({ ...search, c: id })} />
          </div>
        )}
      </div>
    </div>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// The conversation screen (#2303, plan docs/plan/conversations.md section 11), one component for both inboxes: the list of
// threads with their New, Pending and Resolved tabs, the thread with its reply box, and the actions on it (assign, resolve,
// hide a comment, note). Social passes the comment kind (the comment inbox, and the threads under one post); Service will
// pass the direct kind. What a viewer may read is the database's decision, not this screen's: a thread the reader may not
// read is simply not in the list. A reply carries the last message its sender saw, so a newer one asks them to read it first.
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { CONVERSATION_FACEBOOK_DIRECT_MAX, CONVERSATION_INSTAGRAM_COMMENT_MAX, CONVERSATION_INSTAGRAM_DIRECT_MAX, CONVERSATION_NOTE_MAX, CONVERSATION_RETENTION_MONTHS, CONVERSATION_REPLY_MAX, CONVERSATION_THREADS_REPLY_MAX, conversationRules, type ConversationAttachmentView, type ConversationDetail, type ConversationIntent, type ConversationKind, type ConversationMessage, type ConversationStatus, type ConversationSummary } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { NativeSelect } from '@crove/ui/components/native-select';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Textarea } from '@crove/ui/components/textarea';
import { cn } from '@crove/ui/lib/utils';
import { Empty, ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { splitQuoted } from '../lib/email-text.ts';
import { channelsOfPosts, INBOX_PAGE_SIZE, inboxListInput, mergeConversationPages, nextConversationCursor } from '../lib/conversation-inbox.ts';
import { client, errorMessage, fetchConversationImage, isStepUpRequired, orpc, queryClient } from '../lib/api.ts';
import { appendQuoteMessage, canInsertQuoteLink } from '../lib/quote-reply.ts';
import { StepUpPrompt } from './two-factor.tsx';
import { DraftPanel, replyTextFor } from './conversation-drafts.tsx';
import { IntentBadge, IntentBar } from './conversation-intent.tsx';
import { REPLY_INSERT_EVENT, type ReplyInsert } from './quote-send.tsx';

export const STATUSES: readonly ConversationStatus[] = ['new', 'pending', 'resolved'];
// Lists and the open thread are read again this often (the stream's hints do not carry conversations yet).
export const POLL_MS = 6_000;
// How often typing in the reply box tells the server (it takes one mark in 20 seconds, and a mark lives 60).
const COMPOSING_EVERY_MS = 25_000;

export interface PostRef {
  connectionId: string;
  externalPostId: string;
}

// The kernel's code of a refused call.
const codeOf = (error: unknown): string | null => ((error as { code?: unknown } | null)?.code as string | undefined) ?? null;

// The codes a failed or unclear send is worded for; any other is shown as it is.
// The mark of an email whose sender the receiving server did not vouch for (#2439): the name and address in From may be anyone's.
function UnverifiedMark() {
  const t = useTranslations('conversations');
  return (
    <span className="shrink-0 rounded border border-border px-1 text-[10px] leading-4 text-muted-foreground" data-testid="unverified-sender" title={t('unverifiedHint')}>
      {t('unverified')}
    </span>
  );
}

const SEND_ERRORS = ['ZALO_TOKEN', 'ZALO_NO_TOKEN', 'ZALO_QUOTA', 'ZALO_RATE_LIMIT', 'ZALO_NOT_FOLLOWER', 'ZALO_BLOCKED', 'ZALO_OA_ACCESS', 'ZALO_BAD_PARAM', 'ZALO_TEXT_LENGTH', 'ZALO_DIRECT_ONLY', 'ZALO_UNREACHABLE', 'ZALO_5XX', 'ZALO_NO_MESSAGE_ID', 'ZALO_BAD_ANSWER', 'FB_WINDOW_CLOSED', 'FB_PRIVATE_REPLIED', 'FB_RECIPIENT_UNAVAILABLE', 'FB_NOT_FOUND', 'FB_TEXT_LENGTH', 'FB_NO_MESSAGE_ID', 'IG_TEXT_LENGTH', 'IG_COMMENT_LENGTH', 'THREADS_REPLY_CAP', 'THREADS_TEXT_LENGTH', 'NO_TOKEN', 'BAD_REPLY_ID', 'LATE_PUBLISH', 'CONTAINER_NOT_READY', 'NO_POST_ID', 'CONTAINER_PUBLISHED', 'NO_PAGE_TOKEN', 'BAD_PAGE_ID', 'BAD_IG_ID', 'BAD_COMMENT_ID', 'BAD_RECIPIENT_ID', 'CHANNEL_NOT_ACTIVE', 'CHANNEL_OWNER_LEFT', 'CREDENTIAL_ERROR', 'WORKER_LOST', 'SUPPRESSED', 'BOUNCED', 'COMPLAINED', 'MAIL_OFF', 'NO_ADDRESS', 'TEMPLATE_DATA', 'TEMPLATE_UNKNOWN', 'SEND_TIMEOUT', 'SEND_FAILED', 'OUTCOME_UNKNOWN'] as const;
const isKnownSendError = (code: string): code is (typeof SEND_ERRORS)[number] => (SEND_ERRORS as readonly string[]).includes(code);

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });

export interface Member {
  userId: string;
  displayName: string | null;
  email: string;
}

export function useMe() {
  const org = useQuery(orpc.org.get.queryOptions());
  const me = useQuery(orpc.me.get.queryOptions());
  const role = org.data?.role;
  return {
    userId: me.data?.userId ?? null,
    members: (org.data?.members ?? []) as readonly Member[],
    canWrite: role === 'owner' || role === 'admin' || role === 'member',
    isAdmin: role === 'owner' || role === 'admin',
  };
}

export function useContactName() {
  const t = useTranslations('conversations');
  return (c: ConversationSummary['contact']): string => c.partyName ?? c.displayName ?? t('anonymous', { tail: c.idTail });
}

type ListInput = ReturnType<typeof inboxListInput> & { posts?: Array<{ connectionId: string; externalPostId: string }> };

// The threads of a list as pages (#2339): the first page and every older page asked for with "load older", each read again every POLL_MS so the
// list stays live. A page starts after the last thread of the one before it (last message time and id), so a thread that moves up between two
// reads can land on two pages: it is shown once (mergeConversationPages).
export function useConversationPages(input: ListInput) {
  const pages = useInfiniteQuery({
    ...orpc.conversations.list.infiniteOptions({
      input: (cursor: { at: string | null; id: string } | undefined) => ({ ...input, ...(cursor ? { before: cursor } : {}) }),
      initialPageParam: undefined as { at: string | null; id: string } | undefined,
      getNextPageParam: nextConversationCursor,
    }),
    refetchInterval: POLL_MS,
  });
  const items = useMemo(() => mergeConversationPages(pages.data?.pages ?? []), [pages.data]);
  return { items, loaded: pages.data !== undefined, isPending: pages.isPending, error: pages.error, hasMore: pages.hasNextPage, loadingMore: pages.isFetchingNextPage, loadFailed: pages.isFetchNextPageError, loadMore: () => void pages.fetchNextPage() };
}

// "Load older conversations" under a list: shown only while the server says there are more.
export function LoadOlderConversations({ hasMore, loading, onLoad, failed }: { hasMore: boolean; loading: boolean; onLoad: () => void; failed?: boolean }) {
  const t = useTranslations('conversations');
  if (!hasMore) return null;
  return (
    <div className="space-y-1" data-testid="conversation-more">
      <Button type="button" size="sm" variant="outline" className="w-full" loading={loading} onClick={onLoad}>
        {t('loadOlder')}
      </Button>
      {failed && <ErrorText>{t('loadOlderFailed')}</ErrorText>}
    </div>
  );
}

export function ConversationInbox({ kind, posts, empty }: { kind: ConversationKind; posts?: readonly PostRef[] | undefined; empty?: string | undefined }) {
  const t = useTranslations('conversations');
  const [status, setStatus] = useState<ConversationStatus>('new');
  const [selected, setSelected] = useState<string | null>(null);
  // The channel the threads are narrowed to (#2339): the channels the posts are on, offered when there are two or more.
  const [channel, setChannel] = useState<string>('');
  const channelIds = useMemo(() => channelsOfPosts(posts ?? []), [posts]);
  const channels = useQuery({ ...orpc.channels.list.queryOptions({ input: {} }), enabled: channelIds.length > 1 });
  const offered = (channels.data ?? []).filter((c) => channelIds.includes(c.id));
  const narrowed = channel !== '' && channelIds.includes(channel) ? { connectionId: channel } : {};
  const postFilter = posts && posts.length > 0 ? { posts: posts.map((p) => ({ connectionId: p.connectionId, externalPostId: p.externalPostId })) } : {};
  const list = useConversationPages({ status, kind, limit: INBOX_PAGE_SIZE, ...narrowed, ...postFilter });
  const counts = useQuery({ ...orpc.conversations.counts.queryOptions({ input: { kind, ...narrowed, ...postFilter } }), refetchInterval: POLL_MS });
  const items = list.items;
  // The thread shown: the one chosen while it is still in the list or was opened from it, else the first.
  const openId = selected ?? items[0]?.id ?? null;
  // The first thread of a tab is opened for good: answering it moves it to another tab, and it stays on screen.
  useEffect(() => {
    if (selected === null && items[0]) setSelected(items[0].id);
  }, [selected, items]);
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]" data-testid="conversation-inbox">
      <section aria-label={t('listLabel')} className="min-w-0 space-y-3">
        {offered.length > 1 && (
          <label className="block text-xs font-medium text-muted-foreground">
            <span className="mb-1 block">{t('channelFilter')}</span>
            <NativeSelect
              value={channel}
              data-testid="conversation-channel"
              onChange={(e) => {
                setChannel(e.target.value);
                setSelected(null);
              }}
            >
              <option value="">{t('channelAll')}</option>
              {offered.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </NativeSelect>
          </label>
        )}
        <Tabs
          value={status}
          onValueChange={(v) => {
            setStatus(v as ConversationStatus);
            setSelected(null);
          }}
        >
          <TabsList>
            {STATUSES.map((s) => (
              <TabsTrigger key={s} value={s} data-testid={`conversation-tab-${s}`}>
                {t(`status.${s}`)}
                {counts.data ? <span className="ml-1 text-xs text-muted-foreground tabular-nums">{counts.data[s]}</span> : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {list.isPending && <Spinner />}
        {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
        {list.loaded && items.length === 0 && <Empty title={empty ?? t(`empty.${status}`)} />}
        <ul className="divide-y divide-border rounded-md border border-border">
          {items.map((c) => (
            <ConversationListItem key={c.id} conversation={c} open={c.id === openId} onOpen={() => setSelected(c.id)} />
          ))}
        </ul>
        <LoadOlderConversations hasMore={list.hasMore} loading={list.loadingMore} failed={list.loadFailed} onLoad={list.loadMore} />
      </section>
      <section aria-label={t('threadLabel')} className="min-w-0">
        {openId ? <ConversationThread key={openId} conversationId={openId} onGone={() => setSelected(null)} onOpenConversation={(id) => setSelected(id)} /> : <Empty title={t('pick')} />}
      </section>
    </div>
  );
}

// One row of a list of threads: who, the last words, the channel, an unread dot, and the members who are typing a reply to it now (CV3).
export function ConversationListItem({ conversation: c, open, onOpen, suggested = null }: { conversation: ConversationSummary; open: boolean; onOpen: () => void; suggested?: ConversationIntent | null }) {
  const t = useTranslations('conversations');
  const f = useFormat();
  const contactName = useContactName();
  const { members } = useMe();
  return (
    <li>
      <button
        type="button"
        data-testid="conversation-item"
        aria-current={open ? 'true' : undefined}
        className={cn('flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted', open && 'bg-muted')}
        onClick={onOpen}
      >
        <span className="flex items-center justify-between gap-2">
          <span className={cn('truncate', c.unread ? 'font-semibold text-foreground' : 'text-foreground')}>{contactName(c.contact)}</span>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {c.unread && <span className="size-2 rounded-full bg-primary" role="img" aria-label={t('unread')} />}
            {c.lastMessageAt ? f.dateTime(c.lastMessageAt) : ''}
          </span>
        </span>
        {c.kind === 'email' && (
          // The sender chose the name shown above; the address is where the answer goes, so it always stands beside it.
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="conversation-item-address">
            <span className="truncate">{c.contact.address}</span>
            {c.senderUnverified && <UnverifiedMark />}
          </span>
        )}
        {c.kind === 'email' && c.subject && <span className={cn('truncate', c.unread ? 'font-medium text-foreground' : 'text-foreground')}>{c.subject}</span>}
        <span className="truncate text-muted-foreground">{c.preview || t('noText')}</span>
        <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">
              {c.channel.displayName}
              {c.kind === 'direct' ? ` · ${t('kind.direct')}` : ''}
            </span>
            {c.intent ? <IntentBadge intent={c.intent} applied /> : suggested ? <IntentBadge intent={suggested} applied={false} /> : null}
          </span>
          {c.composing.length > 0 && (
            <span className="shrink-0 text-primary" data-testid="conversation-composing-short">
              {t('composingShort', { names: composingNames(c.composing, members, t('someone')), count: c.composing.length })}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

const composingNames = (userIds: readonly string[], members: readonly Member[], fallback: string): string =>
  userIds.map((id) => members.find((m) => m.userId === id)?.displayName ?? members.find((m) => m.userId === id)?.email ?? fallback).join(', ');

// "Linh is replying", above the reply box.
function ComposingNote({ userIds, members }: { userIds: readonly string[]; members: readonly Member[] }) {
  const t = useTranslations('conversations');
  return (
    <p role="status" className="text-sm text-muted-foreground" data-testid="conversation-composing">
      {t('composing', { names: composingNames(userIds, members, t('someone')), count: userIds.length })}
    </p>
  );
}

export function ConversationThread({ conversationId, onGone, onOpenConversation }: { conversationId: string; onGone: () => void; onOpenConversation?: ((id: string) => void) | undefined }) {
  const t = useTranslations('conversations');
  const f = useFormat();
  const contactName = useContactName();
  const { userId, members, canWrite, isAdmin } = useMe();
  const detail = useQuery({ ...orpc.conversations.get.queryOptions({ input: { conversationId } }), refetchInterval: POLL_MS });
  const data = detail.data;
  // The last message the sender has seen: where the thread stood when it was opened, and what they have since acknowledged.
  const [seen, setSeen] = useState<number | null>(null);
  const lastSeq = data?.conversation.lastSeq ?? null;
  useEffect(() => {
    if (seen === null && lastSeq !== null) setSeen(lastSeq);
  }, [seen, lastSeq]);
  // Opening a thread reads it, for this member.
  const markRead = useMutation({ mutationFn: (seq: number) => client.conversations.markRead({ conversationId, seq }), onSuccess: refresh });
  const unread = data?.conversation.unread ?? false;
  // Marks what the member has seen, not what has arrived: a message that comes in while the thread is open stays unread until they
  // acknowledge it ("Đã xem"), which moves `seen`.
  useEffect(() => {
    if (unread && seen !== null) markRead.mutate(seen);
  }, [unread, seen]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // A thread the reader may no longer read is gone from their screen.
    if (codeOf(detail.error) === 'CONVERSATION_NOT_FOUND') onGone();
  }, [detail.error]); // eslint-disable-line react-hooks/exhaustive-deps
  if (detail.isPending) return <Spinner />;
  if (detail.error || !data) return <ErrorText>{errorMessage(detail.error)}</ErrorText>;
  const c = data.conversation;
  const newer = seen !== null && c.lastSeq > seen;
  return (
    <div className="space-y-4" data-testid="conversation-thread">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-foreground">{contactName(c.contact)}</h2>
          {c.kind === 'email' && (
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground" data-testid="conversation-address">
              <span className="truncate">{c.contact.address}</span>
              {c.senderUnverified && <UnverifiedMark />}
            </p>
          )}
          {c.kind === 'email' && c.subject && (
            <p className="truncate text-sm text-foreground" data-testid="conversation-subject">
              {c.subject}
            </p>
          )}
          <p className="truncate text-xs text-muted-foreground">
            {c.channel.displayName}
            {c.contact.partyName && c.contact.displayName ? ` · ${c.contact.displayName}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={c.status === 'new' ? 'default' : 'outline'} data-testid="conversation-status">
            {t(`status.${c.status}`)}
          </Badge>
          {canWrite && <AssignSelect conversation={c} members={members} />}
          {canWrite && <ResolveButton conversation={c} />}
          {isAdmin && <EraseContactButton conversation={c} onErased={onGone} />}
        </div>
      </header>
      {canWrite ? <IntentBar conversation={c} /> : c.intent ? <IntentBadge intent={c.intent} applied /> : null}
      {data.parentId && (
        <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" data-testid="conversation-parent-link">
          <span>{t('fromComment')}</span>
          {onOpenConversation && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onOpenConversation(data.parentId as string)}>
              {t('openParentComment')}
            </Button>
          )}
        </div>
      )}
      {data.gap && (
        <p role="note" className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="conversation-gap">
          {t('gap', { from: f.dateTime(data.gap.from), to: f.dateTime(data.gap.to) })}
        </p>
      )}
      {newer && (
        <div role="status" className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm" data-testid="conversation-newer">
          <span>{t('newer')}</span>
          <Button type="button" size="sm" variant="outline" onClick={() => setSeen(c.lastSeq)}>
            {t('seenIt')}
          </Button>
        </div>
      )}
      <ol className="space-y-2" aria-label={t('messages')}>
        {data.messages.map((m) => (
          <MessageRow key={m.id} message={m} detail={data} members={members} userId={userId} canWrite={canWrite} isAdmin={isAdmin} contact={contactName(c.contact)} onOpenConversation={onOpenConversation} />
        ))}
      </ol>
      {c.composing.length > 0 && <ComposingNote userIds={c.composing} members={members} />}
      {canWrite && <ReplyBox detail={data} seen={seen ?? c.lastSeq} onMoved={(seq) => setSeen(seq)} />}
      <Notes detail={data} members={members} canWrite={canWrite} />
    </div>
  );
}

function AssignSelect({ conversation, members }: { conversation: ConversationSummary; members: readonly Member[] }) {
  const t = useTranslations('conversations');
  const assign = useMutation({ mutationFn: (assigneeUserId: string | null) => client.conversations.assign({ conversationId: conversation.id, assigneeUserId }), onSuccess: refresh });
  return (
    <div>
      <NativeSelect size="sm" aria-label={t('assignee')} value={conversation.assigneeUserId ?? ''} disabled={assign.isPending} onChange={(e) => assign.mutate(e.target.value || null)}>
        <option value="">{t('unassigned')}</option>
        {members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.displayName ?? m.email}
          </option>
        ))}
      </NativeSelect>
      {assign.error && <ErrorText>{errorMessage(assign.error)}</ErrorText>}
    </div>
  );
}

// Erases the customer of this thread: every thread of theirs with its messages and notes, and their name. Owners and admins, behind a
// confirmation and a fresh second factor (the kernel asks for it); it cannot be undone.
function EraseContactButton({ conversation, onErased, messageId, who, label = 'eraseOpen' }: { conversation: ConversationSummary; onErased: () => void; messageId?: string; who?: string; label?: 'eraseOpen' | 'eraseAuthor' }) {
  const t = useTranslations('conversations');
  const [asking, setAsking] = useState(false);
  const [attempt] = useState(() => crypto.randomUUID());
  const erase = useMutation({
    // One key per confirmed attempt, kept across the step-up retry, so a lost answer is retried to the same result.
    mutationFn: () => client.conversations.eraseContact({ conversationId: conversation.id, ...(messageId ? { messageId } : {}), confirm: true, idempotencyKey: attempt }),
    onSuccess: () => {
      setAsking(false);
      onErased();
      refresh();
    },
  });
  const stepUp = isStepUpRequired(erase.error);
  if (!asking) {
    return (
      <Button type="button" size="sm" variant="ghost" data-testid={messageId ? 'conversation-message-erase-open' : 'conversation-erase-open'} onClick={() => setAsking(true)}>
        {t(label)}
      </Button>
    );
  }
  return (
    <div role="alertdialog" aria-label={t('eraseOpen')} className="w-full space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm" data-testid={messageId ? 'conversation-message-erase-confirm' : 'conversation-erase-confirm'}>
      <p>{messageId && who ? t('eraseAuthorWarn', { name: who, channel: conversation.channel.displayName }) : t('eraseWarn', { channel: conversation.channel.displayName })}</p>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="destructive" disabled={erase.isPending} data-testid={messageId ? 'conversation-message-erase-yes' : 'conversation-erase-yes'} onClick={() => erase.mutate()}>
          {t('eraseYes')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            setAsking(false);
            erase.reset();
          }}
        >
          {t('cancel')}
        </Button>
      </div>
      {stepUp && <StepUpPrompt action={t('eraseStepUp')} onVerified={() => erase.mutate()} onCancel={() => erase.reset()} />}
      {erase.error && !stepUp && <ErrorText>{errorMessage(erase.error)}</ErrorText>}
    </div>
  );
}

// How long threads are kept after their last message (CV6, #2305): every member sees it, owners and admins change it. Older threads
// are deleted every night with their messages and notes; "keep" holds them until someone deletes them.
export function ConversationRetentionSetting() {
  const t = useTranslations('conversations');
  const { isAdmin } = useMe();
  const current = useQuery(orpc.conversations.retention.queryOptions({ input: {} }));
  // A shorter retention (or one where there was none) deletes threads at the next nightly run, so it asks first.
  const [asking, setAsking] = useState<6 | 12 | 24 | null | undefined>(undefined);
  const set = useMutation({
    mutationFn: (retentionMonths: 6 | 12 | 24 | null) => client.conversations.setRetention({ retentionMonths }),
    onSuccess: () => {
      setAsking(undefined);
      void queryClient.invalidateQueries({ queryKey: orpc.conversations.retention.key() });
    },
  });
  if (current.isError) {
    return (
      <section className="space-y-1 rounded-md border border-border p-3 text-sm" data-testid="conversation-retention-error">
        <ErrorText>{errorMessage(current.error)}</ErrorText>
        <Button type="button" size="sm" variant="outline" onClick={() => void current.refetch()}>
          {t('retention.retry')}
        </Button>
      </section>
    );
  }
  if (!current.data) return null;
  const monthsOf = (m: 6 | 12 | 24 | null) => (m === null ? Number.POSITIVE_INFINITY : m);
  const choose = (next: 6 | 12 | 24 | null) => {
    if (monthsOf(next) < monthsOf(current.data.retentionMonths)) setAsking(next);
    else set.mutate(next);
  };
  const value = current.data.retentionMonths === null ? 'keep' : String(current.data.retentionMonths);
  return (
    <section className="space-y-1 rounded-md border border-border p-3 text-sm" aria-label={t('retention.title')} data-testid="conversation-retention">
      <label className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{t('retention.title')}</span>
        <NativeSelect
          aria-label={t('retention.title')}
          value={value}
          disabled={!isAdmin || set.isPending}
          data-testid="conversation-retention-select"
          onChange={(e) => choose(e.target.value === 'keep' ? null : (Number(e.target.value) as 6 | 12 | 24))}
        >
          {CONVERSATION_RETENTION_MONTHS.map((m) => (
            <option key={m} value={String(m)}>
              {t(`retention.m${m}`)}
              {current.data.isDefault && m === 24 ? ` ${t('retention.default')}` : ''}
            </option>
          ))}
          <option value="keep">{t('retention.keep')}</option>
        </NativeSelect>
      </label>
      <p className="text-xs text-muted-foreground">{t('retention.hint')}</p>
      {asking !== undefined && asking !== null && (
        <div role="alertdialog" aria-label={t('retention.title')} className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3" data-testid="conversation-retention-confirm">
          <p>{t('retention.shorten', { months: String(asking) })}</p>
          <div className="flex gap-2">
            <Button type="button" size="sm" variant="destructive" disabled={set.isPending} data-testid="conversation-retention-yes" onClick={() => set.mutate(asking)}>
              {t('retention.shortenYes')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(undefined)}>
              {t('cancel')}
            </Button>
          </div>
        </div>
      )}
      {set.error && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </section>
  );
}

function ResolveButton({ conversation }: { conversation: ConversationSummary }) {
  const t = useTranslations('conversations');
  const resolve = useMutation({ mutationFn: () => client.conversations.resolve({ conversationId: conversation.id }), onSuccess: refresh });
  const reopen = useMutation({ mutationFn: () => client.conversations.reopen({ conversationId: conversation.id }), onSuccess: refresh });
  const resolved = conversation.status === 'resolved';
  const pending = resolve.isPending || reopen.isPending;
  const failure = resolved ? reopen.error : resolve.error;
  return (
    <>
    <Button type="button" size="sm" variant={resolved ? 'outline' : 'default'} loading={pending} data-testid={resolved ? 'conversation-reopen' : 'conversation-resolve'} onClick={() => (resolved ? reopen.mutate() : resolve.mutate())}>
      {resolved ? t('reopen') : t('resolve')}
    </Button>
    {failure && <ErrorText>{errorMessage(failure)}</ErrorText>}
    </>
  );
}

// A customer's image, fetched with the member's own session (the route answers 404 to one who may not read the thread) and drawn as an image
// from an object URL: never as HTML. While it loads, or when it cannot be read, nothing is drawn and the message's placeholder text stands.
function MessageImage({ attachment }: { attachment: ConversationAttachmentView }) {
  const t = useTranslations('conversations');
  const blob = useQuery({ queryKey: ['conversation-image', attachment.id], queryFn: () => fetchConversationImage(attachment.id), staleTime: Infinity, retry: false });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob.data) return;
    const next = URL.createObjectURL(blob.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob.data]);
  if (!url) return null;
  return (
    <img
      src={url}
      alt={t('imageAlt')}
      width={attachment.width ?? undefined}
      height={attachment.height ?? undefined}
      loading="lazy"
      className="h-auto max-h-72 w-auto max-w-full rounded-md border border-border"
      data-testid="conversation-image"
    />
  );
}

function MessageRow({ message: m, detail, members, userId, canWrite, isAdmin, contact, onOpenConversation }: { message: ConversationMessage; detail: ConversationDetail; members: readonly Member[]; userId: string | null; canWrite: boolean; isAdmin: boolean; contact: string; onOpenConversation?: ((id: string) => void) | undefined }) {
  const t = useTranslations('conversations');
  const f = useFormat();
  const mine = m.direction === 'out';
  // A customer message names its own author (in a comment thread the replies are other people's), else the thread's contact.
  const customer = m.authorName ?? (m.authorTail ? t('anonymous', { tail: m.authorTail }) : contact);
  const author = mine ? (m.authorKind === 'member' ? (m.authorUserId === userId ? t('you') : (members.find((x) => x.userId === m.authorUserId)?.displayName ?? t('member'))) : t('platformSide')) : customer;
  const settle = useMutation({ mutationFn: (action: 'retry' | 'mark_sent') => client.conversations.settle({ messageId: m.id, action }), onSuccess: refresh });
  const hide = useMutation({ mutationFn: (hidden: boolean) => client.conversations.hide({ messageId: m.id, hidden }), onSuccess: refresh });
  const [privateOpen, setPrivateOpen] = useState(false);
  const [privateText, setPrivateText] = useState('');
  const privateReply = useMutation({
    mutationFn: () => client.conversations.replyPrivately({ messageId: m.id, body: privateText.trim() }),
    onSuccess: (done) => {
      setPrivateText('');
      setPrivateOpen(false);
      refresh();
      if (onOpenConversation) onOpenConversation(done.conversationId);
    },
  });
  // Only where the platform's hide is confirmed (the provider's rules): Threads' is not until its live check (#3133).
  const canHide = canWrite && detail.conversation.kind === 'comment_thread' && !mine && !m.removed && Boolean(conversationRules(detail.conversation.channel.provider)?.canHide);
  const supportsPrivateReply =
    detail.conversation.kind === 'comment_thread' &&
    !mine &&
    !m.removed &&
    (detail.conversation.channel.provider === 'facebook_page' ||
      detail.conversation.channel.provider === 'instagram' ||
      detail.conversation.channel.provider === 'sandbox');
  const withinPrivateWindow = Date.now() - Date.parse(m.sentAt) <= 7 * 24 * 3_600_000;
  // An email from the customer: what they wrote this time, and the history and signature behind "show quoted text" (a display rule; the whole text is stored).
  const [showQuoted, setShowQuoted] = useState(false);
  const email = detail.conversation.kind === 'email' && !mine && !m.removed ? splitQuoted(m.body) : null;
  return (
    <li className={cn('flex', mine ? 'justify-end' : 'justify-start')} data-testid="conversation-message" data-direction={m.direction}>
      <div className={cn('max-w-[85%] space-y-1 rounded-lg border border-border px-3 py-2 text-sm', mine ? 'bg-muted' : 'bg-background', m.hidden && 'opacity-60')}>
        <p className="text-xs text-muted-foreground">
          {author} · {f.dateTime(m.sentAt)}
        </p>
        {m.removed ? <p className="italic text-muted-foreground">{t('removed')}</p> : <p className="whitespace-pre-wrap break-words text-foreground">{email ? email.fresh : m.body}</p>}
        {email && email.quoted !== '' && (
          <>
            <Button type="button" size="sm" variant="ghost" aria-expanded={showQuoted} data-testid="conversation-quoted-toggle" onClick={() => setShowQuoted((v) => !v)}>
              {t(showQuoted ? 'quoted.hide' : 'quoted.show')}
            </Button>
            {showQuoted && <p className="whitespace-pre-wrap break-words border-l-2 border-border pl-2 text-muted-foreground" data-testid="conversation-quoted">{email.quoted}</p>}
          </>
        )}
        {!m.removed && m.attachments.map((a) => <MessageImage key={a.id} attachment={a} />)}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {m.sendState && m.sendState !== 'sent' && (
            <Badge variant={m.sendState === 'failed' || m.sendState === 'unknown' ? 'destructive' : 'outline'} data-testid="conversation-send-state">
              {t(`sendState.${m.sendState}`)}
            </Badge>
          )}
          {m.sendErrorCode && (m.sendState === 'failed' || m.sendState === 'unknown') && (
            <span className="text-muted-foreground">{isKnownSendError(m.sendErrorCode) ? t(`sendError.${m.sendErrorCode}`) : m.sendErrorCode}</span>
          )}
          {canWrite && (m.sendState === 'failed' || m.sendState === 'unknown') && (
            <>
              {!(detail.conversation.kind === 'email' && m.sendState === 'unknown') && (
                <Button type="button" size="sm" variant="outline" loading={settle.isPending} onClick={() => settle.mutate('retry')}>
                  {m.sendState === 'unknown' ? t('sendAgainUnknown') : t('sendAgain')}
                </Button>
              )}
              {m.sendState === 'unknown' && (
                <Button type="button" size="sm" variant="ghost" loading={settle.isPending} onClick={() => settle.mutate('mark_sent')}>
                  {t('wasSent')}
                </Button>
              )}
            </>
          )}
          {m.hidden && <Badge variant="outline">{t('hidden')}</Badge>}
          {m.hideRequest && <Badge variant="outline">{t(m.hideRequest === 'hide' ? 'hiding' : 'unhiding')}</Badge>}
          {m.hideErrorCode && !m.hideRequest && <span className="text-destructive">{t('hideFailed', { code: m.hideErrorCode })}</span>}
          {canHide && m.hideRequest && m.hideErrorCode && (
            <Button type="button" size="sm" variant="outline" loading={hide.isPending} onClick={() => hide.mutate(m.hideRequest === 'hide')}>
              {t('hideAgain')}
            </Button>
          )}
          {canHide && !m.hideRequest && (
            <Button type="button" size="sm" variant="ghost" loading={hide.isPending} data-testid="conversation-hide" onClick={() => hide.mutate(!m.hidden)}>
              {m.hidden ? t('unhide') : t('hide')}
            </Button>
          )}
          {supportsPrivateReply && m.privateReplyConversationId && (
            onOpenConversation ? (
              <Button type="button" size="sm" variant="ghost" data-testid="conversation-private-reply-open" onClick={() => onOpenConversation(m.privateReplyConversationId as string)}>
                {t('privateReplyView')}
              </Button>
            ) : (
              <Badge variant="outline" data-testid="conversation-private-reply-badge">{t('privateReplySent')}</Badge>
            )
          )}
          {supportsPrivateReply && !m.privateReplyConversationId && canWrite && withinPrivateWindow && (
            <Button type="button" size="sm" variant="ghost" data-testid="conversation-private-reply-button" onClick={() => setPrivateOpen((v) => !v)}>
              {t('privateReplyOpen')}
            </Button>
          )}
        </div>
        {privateOpen && (
          <form
            className="space-y-2 border-t border-border pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (privateText.trim()) privateReply.mutate();
            }}
          >
            <Textarea
              aria-label={t('privateReplyLabel')}
              rows={2}
              maxLength={detail.conversation.channel.provider === 'instagram' ? CONVERSATION_INSTAGRAM_DIRECT_MAX : CONVERSATION_FACEBOOK_DIRECT_MAX}
              value={privateText}
              placeholder={t('privateReplyPlaceholder')}
              onChange={(e) => setPrivateText(e.target.value)}
              data-testid="conversation-private-reply-text"
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" loading={privateReply.isPending} disabled={privateText.trim() === ''} data-testid="conversation-private-reply-send">
                {t('privateReplySend')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setPrivateOpen(false);
                  privateReply.reset();
                }}
              >
                {t('cancel')}
              </Button>
            </div>
            {privateReply.error && <ErrorText>{errorMessage(privateReply.error)}</ErrorText>}
          </form>
        )}
        {/* A customer who only replied in this comment thread has no thread of their own to erase from: their message names them. */}
        {isAdmin && !mine && m.authorTail !== null && detail.conversation.kind === 'comment_thread' && <EraseContactButton conversation={detail.conversation} messageId={m.id} who={customer} onErased={refresh} label="eraseAuthor" />}
        {(settle.error || hide.error) && <ErrorText>{errorMessage(settle.error ?? hide.error)}</ErrorText>}
      </div>
    </li>
  );
}

function ReplyBox({ detail, seen, onMoved }: { detail: ConversationDetail; seen: number; onMoved: (seq: number) => void }) {
  const t = useTranslations('conversations');
  const [text, setText] = useState('');
  const [movedNote, setMovedNote] = useState(false);
  // "Linh is replying": typing marks the thread for the others (the server keeps a mark for 60 seconds and takes one in 20; asking every 25 here is
  // enough). A failed mark is not worth a message.
  const lastMarked = useRef(0);
  // The draft or the saved reply the text in the box began from: the reply names it, so the draft is marked used (its length and the size of the
  // edit are kept, never the text) and the saved reply is counted. Typing everything away forgets it.
  const [from, setFrom] = useState<{ draftId?: string; savedReplyId?: string }>({});
  const id = detail.conversation.id;
  const kind = detail.conversation.kind;
  // The longest reply this channel takes: the box stops typing there, and a quote message put in by code is checked against it too (#2827).
  const replyMax =
    detail.conversation.channel.provider === 'instagram'
      ? kind === 'direct'
        ? CONVERSATION_INSTAGRAM_DIRECT_MAX
        : CONVERSATION_INSTAGRAM_COMMENT_MAX
      : detail.conversation.channel.provider === 'threads'
        ? CONVERSATION_THREADS_REPLY_MAX
        : detail.conversation.channel.provider === 'facebook_page' && kind === 'direct'
          ? CONVERSATION_FACEBOOK_DIRECT_MAX
          : detail.conversation.channel.provider === 'telegram'
            ? (conversationRules('telegram')?.replyMax ?? CONVERSATION_REPLY_MAX)
            : CONVERSATION_REPLY_MAX;
  const [insertTooLong, setInsertTooLong] = useState(false);
  // The listener below reads what is in the box now without being set up again at every keystroke.
  const textNow = useRef(text);
  textNow.current = text;
  // A quote link the contact panel offers (#2694): its message lands in this box for the person to read, edit and send. Nothing is sent from there.
  useEffect(() => {
    const onInsert = (event: Event) => {
      const { conversationId, text: inserted } = (event as CustomEvent<ReplyInsert>).detail;
      // A quote link is a private document's address: never into a public reply (a comment thread), whoever sends the event (#2827).
      if (conversationId !== id || !canInsertQuoteLink(kind)) return;
      // A message that would pass the channel's limit is not added (cutting it would cut the link): the box says so, and the draft stays as it is (#2827).
      const next = appendQuoteMessage(textNow.current, inserted, replyMax);
      setInsertTooLong(!next.fits);
      if (!next.fits) return;
      setText(next.text);
      setFrom({});
    };
    window.addEventListener(REPLY_INSERT_EVENT, onInsert);
    return () => window.removeEventListener(REPLY_INSERT_EVENT, onInsert);
  }, [id, kind, replyMax]);
  const send = useMutation({
    mutationFn: () => client.conversations.reply({ conversationId: id, body: text.trim(), lastSeenSeq: seen, ...from }),
    onSuccess: (done) => {
      setText('');
      setFrom({});
      setMovedNote(false);
      onMoved(done.seq);
      refresh();
    },
    onError: async (error) => {
      // A newer message exists: show it, and let the sender press Send again once they have read it.
      if (codeOf(error) === 'CONVERSATION_MOVED') {
        const fresh = await client.conversations.get({ conversationId: id }).catch(() => null);
        if (fresh) {
          queryClient.setQueryData(orpc.conversations.get.queryOptions({ input: { conversationId: id } }).queryKey, fresh);
          // `seen` stays where it was: the banner's "Đã xem" is the sender's acknowledgement, and the draft is kept until then.
          setMovedNote(true);
        }
      }
    },
  });
  const reason = detail.reply.reason;
  if (!detail.reply.allowed) return <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">{t(`replyBlocked.${reason ?? 'not_supported'}`)}</p>;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) send.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-2" aria-label={t('replyLabel')}>
      <p className="text-xs text-muted-foreground">
        {detail.conversation.kind === 'email' ? t('replyEmail') : t(detail.conversation.kind === 'direct' ? 'replyPrivate' : 'replyPublic', { channel: detail.conversation.channel.displayName })}
      </p>
      <DraftPanel
        detail={detail}
        onUse={(draft) => {
          // A draft may keep the saved reply's `{tên}` as a fill (#3102): it is filled here, as for a saved reply.
          setText(replyTextFor(draft.body ?? '', detail));
          setFrom({ draftId: draft.id });
        }}
        onUseSaved={(reply) => {
          // `{tên}` becomes the contact's name here, in the box, before Send (#3102); with no name it is dropped.
          setText(replyTextFor(reply.body, detail));
          // The text is now the saved reply's, so it no longer began from a draft.
          setFrom({ savedReplyId: reply.id });
        }}
      />
      <Textarea
        aria-label={t('replyLabel')}
        rows={3}
        maxLength={replyMax}
        value={text}
        placeholder={t('replyPlaceholder')}
        onChange={(e) => {
          setText(e.target.value);
          setInsertTooLong(false);
          if (e.target.value === '') setFrom({});
          else if (Date.now() - lastMarked.current > COMPOSING_EVERY_MS) {
            lastMarked.current = Date.now();
            void client.conversations.composing({ conversationId: id }).catch(() => undefined);
          }
        }}
        data-testid="conversation-reply-text"
      />
      {insertTooLong && <ErrorText>{t('quoteTooLong', { max: String(replyMax) })}</ErrorText>}
      {movedNote && <p role="status" className="text-sm text-muted-foreground">{t('movedAfterSend')}</p>}
      {send.error && !movedNote && <ErrorText>{errorMessage(send.error)}</ErrorText>}
      <Button type="submit" size="sm" loading={send.isPending} disabled={text.trim() === ''} data-testid="conversation-send">
        {t('send')}
      </Button>
    </form>
  );
}

function Notes({ detail, members, canWrite }: { detail: ConversationDetail; members: readonly Member[]; canWrite: boolean }) {
  const t = useTranslations('conversations');
  const f = useFormat();
  const [text, setText] = useState('');
  const add = useMutation({
    mutationFn: () => client.conversations.note({ conversationId: detail.conversation.id, body: text.trim() }),
    onSuccess: () => {
      setText('');
      refresh();
    },
  });
  const names = useMemo(() => new Map(members.map((m) => [m.userId, m.displayName ?? m.email])), [members]);
  if (detail.notes.length === 0 && !canWrite) return null;
  return (
    <section className="space-y-2 border-t border-border pt-3" aria-label={t('notes')}>
      <h3 className="text-sm font-medium text-foreground">{t('notes')}</h3>
      <ul className="space-y-1">
        {detail.notes.map((n) => (
          <li key={n.id} className="rounded-md bg-muted px-3 py-2 text-sm" data-testid="conversation-note">
            <p className="whitespace-pre-wrap break-words text-foreground">{n.body}</p>
            <p className="text-xs text-muted-foreground">
              {names.get(n.authorUserId) ?? t('member')} · {f.dateTime(n.createdAt)}
            </p>
          </li>
        ))}
      </ul>
      {canWrite && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) add.mutate();
          }}
        >
          <Textarea aria-label={t('noteLabel')} rows={2} maxLength={CONVERSATION_NOTE_MAX} value={text} placeholder={t('notePlaceholder')} onChange={(e) => setText(e.target.value)} data-testid="conversation-note-text" />
          <Button type="submit" size="sm" variant="outline" loading={add.isPending} disabled={text.trim() === ''} data-testid="conversation-note-add">
            {t('addNote')}
          </Button>
        </form>
      )}
      {add.error && <ErrorText>{errorMessage(add.error)}</ErrorText>}
    </section>
  );
}

// A demo comment on a published post of the offline sandbox, for owners and admins: it takes the same way in a platform's
// notice does, and appears in the thread list in a moment.
export function SandboxCommentButton({ connectionId, postId }: { connectionId: string; postId: string }) {
  const t = useTranslations('conversations');
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const make = useMutation({
    mutationFn: () => client.conversations.sandboxComment({ connectionId, postId, text: text.trim(), fromName: t('sandboxFrom') }),
    onSuccess: () => {
      setText('');
      setOpen(false);
      window.setTimeout(refresh, 1500);
    },
  });
  if (!open) {
    return (
      <Button type="button" size="sm" variant="outline" data-testid="sandbox-comment-open" onClick={() => setOpen(true)}>
        {t('sandboxMake')}
      </Button>
    );
  }
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) make.mutate();
      }}
    >
      <Textarea aria-label={t('sandboxText')} rows={2} maxLength={2000} value={text} placeholder={t('sandboxText')} onChange={(e) => setText(e.target.value)} data-testid="sandbox-comment-text" />
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={make.isPending} disabled={text.trim() === ''} data-testid="sandbox-comment-send">
          {t('sandboxSend')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          {t('cancel')}
        </Button>
      </div>
      {make.error && <ErrorText>{errorMessage(make.error)}</ErrorText>}
    </form>
  );
}

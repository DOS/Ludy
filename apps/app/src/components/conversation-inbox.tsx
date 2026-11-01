// SPDX-License-Identifier: AGPL-3.0-only
// The conversation screen (#2303, plan docs/plan/conversations.md section 11), one component for both inboxes: the list of
// threads with their New, Pending and Resolved tabs, the thread with its reply box, and the actions on it (assign, resolve,
// hide a comment, note). Social passes the comment kind (the comment inbox, and the threads under one post); Service will
// pass the direct kind. What a viewer may read is the database's decision, not this screen's: a thread the reader may not
// read is simply not in the list. A reply carries the last message its sender saw, so a newer one asks them to read it first.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { CONVERSATION_NOTE_MAX, CONVERSATION_REPLY_MAX, type ConversationDetail, type ConversationKind, type ConversationMessage, type ConversationStatus, type ConversationSummary } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { NativeSelect } from '@crove/ui/components/native-select';
import { Tabs, TabsList, TabsTrigger } from '@crove/ui/components/tabs';
import { Textarea } from '@crove/ui/components/textarea';
import { cn } from '@crove/ui/lib/utils';
import { Empty, ErrorText, Spinner } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const STATUSES: readonly ConversationStatus[] = ['new', 'pending', 'resolved'];
// Lists and the open thread are read again this often (the stream's hints do not carry conversations yet).
const POLL_MS = 6_000;

export interface PostRef {
  connectionId: string;
  externalPostId: string;
}

// The kernel's code of a refused call.
const codeOf = (error: unknown): string | null => ((error as { code?: unknown } | null)?.code as string | undefined) ?? null;

// The codes a failed or unclear send is worded for; any other is shown as it is.
const SEND_ERRORS = ['ZALO_TOKEN', 'ZALO_NO_TOKEN', 'ZALO_QUOTA', 'ZALO_RATE_LIMIT', 'ZALO_NOT_FOLLOWER', 'ZALO_BLOCKED', 'ZALO_OA_ACCESS', 'ZALO_BAD_PARAM', 'ZALO_TEXT_LENGTH', 'ZALO_DIRECT_ONLY', 'ZALO_UNREACHABLE', 'ZALO_5XX', 'ZALO_NO_MESSAGE_ID', 'ZALO_BAD_ANSWER', 'CHANNEL_NOT_ACTIVE', 'CHANNEL_OWNER_LEFT', 'CREDENTIAL_ERROR', 'WORKER_LOST'] as const;
const isKnownSendError = (code: string): code is (typeof SEND_ERRORS)[number] => (SEND_ERRORS as readonly string[]).includes(code);

const refresh = () => void queryClient.invalidateQueries({ queryKey: orpc.conversations.key() });

export interface Member {
  userId: string;
  displayName: string | null;
  email: string;
}

function useMe() {
  const org = useQuery(orpc.org.get.queryOptions());
  const me = useQuery(orpc.me.get.queryOptions());
  const role = org.data?.role;
  return { userId: me.data?.userId ?? null, members: (org.data?.members ?? []) as readonly Member[], canWrite: role === 'owner' || role === 'admin' || role === 'member' };
}

function useContactName() {
  const t = useTranslations('conversations');
  return (c: ConversationSummary['contact']): string => c.partyName ?? c.displayName ?? t('anonymous', { tail: c.idTail });
}

export function ConversationInbox({ kind, posts, empty }: { kind: ConversationKind; posts?: readonly PostRef[] | undefined; empty?: string | undefined }) {
  const t = useTranslations('conversations');
  const f = useFormat();
  const contactName = useContactName();
  const [status, setStatus] = useState<ConversationStatus>('new');
  const [selected, setSelected] = useState<string | null>(null);
  const postFilter = posts && posts.length > 0 ? { posts: posts.map((p) => ({ connectionId: p.connectionId, externalPostId: p.externalPostId })) } : {};
  const list = useQuery({ ...orpc.conversations.list.queryOptions({ input: { status, kind, limit: 50, ...postFilter } }), refetchInterval: POLL_MS });
  const counts = useQuery({ ...orpc.conversations.counts.queryOptions({ input: { kind, ...postFilter } }), refetchInterval: POLL_MS });
  const items = list.data?.conversations ?? [];
  // The thread shown: the one chosen while it is still in the list or was opened from it, else the first.
  const openId = selected ?? items[0]?.id ?? null;
  // The first thread of a tab is opened for good: answering it moves it to another tab, and it stays on screen.
  useEffect(() => {
    if (selected === null && items[0]) setSelected(items[0].id);
  }, [selected, items]);
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]" data-testid="conversation-inbox">
      <section aria-label={t('listLabel')} className="min-w-0 space-y-3">
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
        {list.data && items.length === 0 && <Empty title={empty ?? t(`empty.${status}`)} />}
        <ul className="divide-y divide-border rounded-md border border-border">
          {items.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                data-testid="conversation-item"
                aria-current={c.id === openId ? 'true' : undefined}
                className={cn('flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted', c.id === openId && 'bg-muted')}
                onClick={() => setSelected(c.id)}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className={cn('truncate', c.unread ? 'font-semibold text-foreground' : 'text-foreground')}>{contactName(c.contact)}</span>
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    {c.unread && <span className="size-2 rounded-full bg-primary" role="img" aria-label={t('unread')} />}
                    {c.lastMessageAt ? f.dateTime(c.lastMessageAt) : ''}
                  </span>
                </span>
                <span className="truncate text-muted-foreground">{c.preview || t('noText')}</span>
                <span className="truncate text-xs text-muted-foreground">{c.channel.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
        {list.data?.more && <p className="text-xs text-muted-foreground">{t('more')}</p>}
      </section>
      <section aria-label={t('threadLabel')} className="min-w-0">
        {openId ? <ConversationThread key={openId} conversationId={openId} onGone={() => setSelected(null)} /> : <Empty title={t('pick')} />}
      </section>
    </div>
  );
}

function ConversationThread({ conversationId, onGone }: { conversationId: string; onGone: () => void }) {
  const t = useTranslations('conversations');
  const contactName = useContactName();
  const { userId, members, canWrite } = useMe();
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
        </div>
      </header>
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
          <MessageRow key={m.id} message={m} detail={data} members={members} userId={userId} canWrite={canWrite} contact={contactName(c.contact)} />
        ))}
      </ol>
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

function MessageRow({ message: m, detail, members, userId, canWrite, contact }: { message: ConversationMessage; detail: ConversationDetail; members: readonly Member[]; userId: string | null; canWrite: boolean; contact: string }) {
  const t = useTranslations('conversations');
  const f = useFormat();
  const mine = m.direction === 'out';
  const author = mine ? (m.authorKind === 'member' ? (m.authorUserId === userId ? t('you') : (members.find((x) => x.userId === m.authorUserId)?.displayName ?? t('member'))) : t('platformSide')) : contact;
  const settle = useMutation({ mutationFn: (action: 'retry' | 'mark_sent') => client.conversations.settle({ messageId: m.id, action }), onSuccess: refresh });
  const hide = useMutation({ mutationFn: (hidden: boolean) => client.conversations.hide({ messageId: m.id, hidden }), onSuccess: refresh });
  const canHide = canWrite && detail.conversation.kind === 'comment_thread' && !mine && !m.removed;
  return (
    <li className={cn('flex', mine ? 'justify-end' : 'justify-start')} data-testid="conversation-message" data-direction={m.direction}>
      <div className={cn('max-w-[85%] space-y-1 rounded-lg border border-border px-3 py-2 text-sm', mine ? 'bg-muted' : 'bg-background', m.hidden && 'opacity-60')}>
        <p className="text-xs text-muted-foreground">
          {author} · {f.dateTime(m.sentAt)}
        </p>
        {m.removed ? <p className="italic text-muted-foreground">{t('removed')}</p> : <p className="whitespace-pre-wrap break-words text-foreground">{m.body}</p>}
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
              <Button type="button" size="sm" variant="outline" loading={settle.isPending} onClick={() => settle.mutate('retry')}>
                {m.sendState === 'unknown' ? t('sendAgainUnknown') : t('sendAgain')}
              </Button>
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
        </div>
        {(settle.error || hide.error) && <ErrorText>{errorMessage(settle.error ?? hide.error)}</ErrorText>}
      </div>
    </li>
  );
}

function ReplyBox({ detail, seen, onMoved }: { detail: ConversationDetail; seen: number; onMoved: (seq: number) => void }) {
  const t = useTranslations('conversations');
  const [text, setText] = useState('');
  const [movedNote, setMovedNote] = useState(false);
  const id = detail.conversation.id;
  const send = useMutation({
    mutationFn: () => client.conversations.reply({ conversationId: id, body: text.trim(), lastSeenSeq: seen }),
    onSuccess: (done) => {
      setText('');
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
          onMoved(fresh.conversation.lastSeq);
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
      <p className="text-xs text-muted-foreground">{t(detail.conversation.kind === 'direct' ? 'replyPrivate' : 'replyPublic', { channel: detail.conversation.channel.displayName })}</p>
      <Textarea aria-label={t('replyLabel')} rows={3} maxLength={CONVERSATION_REPLY_MAX} value={text} placeholder={t('replyPlaceholder')} onChange={(e) => setText(e.target.value)} data-testid="conversation-reply-text" />
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

// SPDX-License-Identifier: AGPL-3.0-only
// "Gửi qua Zalo" (Meetings B5, #3169, docs/plan/meetings-integrations.md 5.3): on a published result of a meeting linked to a customer who has a Zalo conversation in Hộp thư, the recorder
// ticks the lines of the published minutes the customer needs and opens that thread with a short text in its reply box. Nothing is sent from here and no AI takes part: the text is built
// by code from the ticked lines (never the transcript, the audio, an attendee's details or an action item's owner), the person reads, edits and presses Hộp thư's own Send button, and the
// existing send path decides the rest (the 48-hour window, plan errors, `send_state`). When the thread's reply window is closed the button is disabled with the reason: Ludy sends no
// template and no paid message. The thread and its window come from the queries Hộp thư and the CRM already have; no Zalo client, webhook or connection is added.
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { MEETING_ZALO_DRAFT_MAX, buildMeetingZaloDraft, type ActionItemView, type ConversationDetail } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Checkbox } from '@crove/ui/components/checkbox';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { orpc } from '../lib/api.ts';
import { putReplyHandoff } from '../lib/reply-handoff.ts';
import { installedModules } from '../lib/org-modules.ts';

const ZALO = 'zalo_oa';
// A customer with many Zalo threads is rare; the panel offers the latest few.
const THREADS_MAX = 5;
// The window can close between two looks: the thread is read again when the panel is seen, never trusted for long.
const FRESH = { staleTime: 30_000, refetchOnWindowFocus: true } as const;
// A page left open is looked at again every minute, and the window is also compared with the clock below.
const WINDOW_POLL_MS = 60_000;

const installed = (): boolean => {
  const modules = installedModules();
  return modules.includes('crm') && modules.includes('social');
};

export interface ZaloThread {
  id: string;
  lastMessageAt: string | null;
}

// The customer's Zalo direct threads, newest first, from the contacts the meeting is linked to (the CRM's own query: it follows merged duplicates and the company, and the database's
// restrictive policy shows a member only the direct messages they may read).
export function zaloThreadsOf(lists: ReadonlyArray<ReadonlyArray<{ id: string; kind: string; channel: { provider: string }; lastMessageAt: string | null }> | undefined>): ZaloThread[] {
  const found = new Map<string, ZaloThread>();
  for (const list of lists) {
    for (const c of list ?? []) {
      if (c.kind === 'direct' && c.channel.provider === ZALO) found.set(c.id, { id: c.id, lastMessageAt: c.lastMessageAt });
    }
  }
  return [...found.values()].sort((a, b) => (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || b.id.localeCompare(a.id)).slice(0, THREADS_MAX);
}

export function MeetingZalo({
  meetingId,
  title,
  summary,
  decisions,
  items,
}: {
  meetingId: string;
  title: string;
  summary: string | null;
  decisions: readonly string[];
  items: readonly ActionItemView[];
}) {
  const links = useQuery({ ...orpc.meetings.links.list.queryOptions({ input: { meetingId } }), enabled: installed() });
  const partyIds = (links.data ?? []).filter((l) => l.kind === 'party').map((l) => l.targetId);
  const lists = useQueries({ queries: partyIds.map((partyId) => ({ ...orpc.crm.contacts.conversations.queryOptions({ input: { partyId } }), ...FRESH, retry: false })) });
  const threads = zaloThreadsOf(lists.map((q) => q.data));
  if (!installed() || threads.length === 0) return null;
  return <ZaloPanel title={title} summary={summary} decisions={decisions} items={items} threads={threads} />;
}

function ZaloPanel({ title, summary, decisions, items, threads }: { title: string; summary: string | null; decisions: readonly string[]; items: readonly ActionItemView[]; threads: readonly ZaloThread[] }) {
  const t = useTranslations('meetings.zalo');
  const tc = useTranslations('conversations');
  const { slug } = useParams({ strict: false }) as { slug: string };
  const navigate = useNavigate();
  const details = useQueries({ queries: threads.map((th) => ({ ...orpc.conversations.get.queryOptions({ input: { conversationId: th.id } }), ...FRESH, refetchInterval: WINDOW_POLL_MS, retry: false })) });
  const [picked, setPicked] = useState<string | null>(null);
  const [includeSummary, setIncludeSummary] = useState(false);
  // Ticks are kept by what was ticked (a decision's text, an item's id), never by position: when the results change under an open panel (a new publish), a tick follows its line or goes.
  const [tickedDecisions, setTickedDecisions] = useState<readonly string[]>([]);
  const [tickedItems, setTickedItems] = useState<readonly string[]>([]);
  const [storageFailed, setStorageFailed] = useState(false);
  const [opening, setOpening] = useState(false);

  const index = Math.max(0, threads.findIndex((th) => th.id === picked));
  const thread = threads[index];
  const detail = details[index]?.data as ConversationDetail | undefined;
  const failed = details[index]?.error;
  if (!thread) return null;

  const draft = buildMeetingZaloDraft({
    title,
    summary,
    includeSummary,
    decisions,
    tickedDecisions: decisions.flatMap((d, i) => (tickedDecisions.includes(d) ? [i] : [])),
    items: items.map((i) => ({ title: i.title, whenDate: i.whenDate })),
    tickedItems: items.flatMap((it, i) => (tickedItems.includes(it.id) ? [i] : [])),
    labels: {
      heading: (name) => t('heading', { title: name }),
      summary: t('draftSummary'),
      decisions: t('draftDecisions'),
      items: t('draftItems'),
      due: (date) => t('draftDue', { date }),
    },
  });
  const toggle = (list: readonly string[], key: string, on: boolean): string[] => (on ? [...new Set([...list, key])] : list.filter((x) => x !== key));
  // Open only while the last read says so, the read did not fail, and the window's own end has not passed on the clock (a page left open); the send command checks again.
  const windowEnd = detail?.conversation.replyWindowUntil ?? null;
  const expired = windowEnd !== null && new Date(windowEnd).getTime() <= Date.now();
  const allowed = detail?.reply.allowed === true && !failed && !expired;
  // A thread that cannot be read now (access taken away, a network error) is not offered: the button stays off and says the channel cannot be answered from here.
  const reason = failed ? 'not_supported' : detail ? (!detail.reply.allowed ? (detail.reply.reason ?? 'not_supported') : expired ? 'window_closed' : null) : null;
  const canOpen = allowed && draft.hasLines && draft.fits && !opening;
  const name = (i: number): string => {
    const d = details[i]?.data as ConversationDetail | undefined;
    return t('threadOption', { name: d?.conversation.contact.partyName ?? d?.conversation.contact.displayName ?? t('noName'), channel: d?.conversation.channel.displayName ?? 'Zalo' });
  };

  const open = () => {
    if (!canOpen) return;
    setOpening(true);
    // The text waits for the reply box of that thread (it only exists once the Inbox shows the thread); the address carries the thread, never the text.
    if (!putReplyHandoff(thread.id, draft.text)) {
      setStorageFailed(true);
      setOpening(false);
      return;
    }
    setStorageFailed(false);
    void navigate({ to: '/o/$slug/social/inbox', params: { slug }, search: { c: thread.id } });
  };

  return (
    <section className="space-y-3 rounded-lg border border-border p-3" data-testid="meeting-zalo">
      <div className="space-y-1">
        <h3 className="text-sm font-medium text-foreground">{t('title')}</h3>
        <p className="text-xs text-muted-foreground">{t('desc')}</p>
      </div>
      {threads.length > 1 && (
        <div className="space-y-1">
          <label htmlFor="zalo-thread" className="text-xs font-medium text-muted-foreground">
            {t('thread')}
          </label>
          <NativeSelect id="zalo-thread" value={thread.id} onChange={(e) => setPicked(e.target.value)}>
            {threads.map((th, i) => (
              <NativeSelectOption key={th.id} value={th.id}>
                {name(i)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
      {decisions.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-muted-foreground">{t('decisions')}</legend>
          {decisions.map((d, i) => (
            <label key={`d${i}`} className="flex items-start gap-2 text-sm">
              <Checkbox checked={tickedDecisions.includes(d)} onCheckedChange={(on) => setTickedDecisions(toggle(tickedDecisions, d, on === true))} />
              <span className="min-w-0 whitespace-pre-wrap break-words">{d}</span>
            </label>
          ))}
        </fieldset>
      )}
      {items.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="text-xs font-medium text-muted-foreground">{t('items')}</legend>
          {items.map((it) => (
            <label key={it.id} className="flex items-start gap-2 text-sm">
              <Checkbox checked={tickedItems.includes(it.id)} onCheckedChange={(on) => setTickedItems(toggle(tickedItems, it.id, on === true))} />
              <span className="min-w-0 break-words">
                {it.title}
                {it.whenDate && <span className="text-muted-foreground">{` (${t('itemDue', { date: it.whenDate.split('-').reverse().join('/') })})`}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {summary !== null && summary.trim() !== '' && (
        <div className="space-y-1">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={includeSummary} onCheckedChange={(on) => setIncludeSummary(on === true)} />
            <span>{t('summary')}</span>
          </label>
          <p className="text-xs text-muted-foreground">{t('summaryHint')}</p>
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor="zalo-preview" className="text-xs font-medium text-muted-foreground">
          {t('preview')}
        </label>
        <Textarea id="zalo-preview" readOnly rows={Math.min(12, Math.max(4, draft.text.split('\n').length))} value={draft.text} />
        <p className={draft.fits ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>{t('count', { count: String(draft.length), max: String(MEETING_ZALO_DRAFT_MAX) })}</p>
        {!draft.fits && <ErrorText>{t('tooLong')}</ErrorText>}
        {!draft.hasLines && <p className="text-xs text-muted-foreground">{t('nothing')}</p>}
      </div>
      {!detail && !failed && <p className="text-xs text-muted-foreground">{t('loading')}</p>}
      {reason !== null && (
        <p className="text-xs text-foreground" role="status" data-testid="meeting-zalo-closed">
          {t('closed', { reason: tc(`replyBlocked.${reason}` as never) })}
        </p>
      )}
      {storageFailed && <ErrorText>{t('storageFailed')}</ErrorText>}
      <p className="text-xs text-muted-foreground">{t('sendNote')}</p>
      <Button type="button" size="sm" disabled={!canOpen} loading={opening} onClick={open} data-testid="meeting-zalo-open">
        {t('open')}
      </Button>
    </section>
  );
}

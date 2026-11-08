// SPDX-License-Identifier: AGPL-3.0-only
// The summary, the decisions and the action items of a meeting on its page (#2580, M6 part A). The recorder types a summary and items as a draft only they
// see, and one click shares them with the meeting's readers; a reader sees what was shared and makes a team task from an item: they confirm the title, pick the
// date and the seat. Nothing here needs AI; the work Vy does for this screen arrives in a later step and lands in these same drafts.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { ActionItemView } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { DateInput } from './date-input.tsx';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// A member as people read them: the name, else the email, else a plain fallback; never an id.
export function memberLabel(members: ReadonlyArray<{ userId: string; displayName: string | null; email: string }>, userId: string, fallback: string): string {
  const m = members.find((x) => x.userId === userId);
  return m ? (m.displayName?.trim() || m.email || fallback) : fallback;
}

// Reading the results is a sensitive read that leaves an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
const refresh = () => {
  void queryClient.invalidateQueries({ queryKey: orpc.meetings.results.key() });
};

// The recorder's draft summary and decisions (one decision per line).
function SummaryEditor({ meetingId, summary, decisions }: { meetingId: string; summary: string; decisions: string[] }) {
  const t = useTranslations('meetings.results');
  const [text, setText] = useState(summary);
  const [lines, setLines] = useState(decisions.join('\n'));
  const parsed = lines.split('\n').map((l) => l.trim()).filter(Boolean);
  const save = useMutation({ mutationFn: () => orpc.meetings.results.saveSummary.call({ meetingId, summary: text.trim(), decisions: parsed }), onSuccess: refresh });
  return (
    <div className="space-y-2">
      <Textarea aria-label={t('summary')} value={text} maxLength={8000} rows={5} onChange={(e) => setText(e.target.value)} />
      <Textarea aria-label={t('decisions')} placeholder={t('decisionsHint')} value={lines} rows={3} onChange={(e) => setLines(e.target.value)} />
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      <Button size="sm" loading={save.isPending} disabled={text.trim() === ''} onClick={() => save.mutate()}>
        {t('saveDraft')}
      </Button>
    </div>
  );
}

function SummaryText({ summary, decisions }: { summary: string; decisions: string[] }) {
  const t = useTranslations('meetings.results');
  return (
    <div className="space-y-2 text-sm">
      <p className="whitespace-pre-wrap">{summary}</p>
      {decisions.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">{t('decisions')}</p>
          <ul className="list-disc space-y-1 pl-5">
            {decisions.map((d, i) => (
              <li key={`${i}-${d}`}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function NewItem({ meetingId, readers }: { meetingId: string; readers: readonly string[] }) {
  const t = useTranslations('meetings.results');
  const org = useQuery(orpc.org.get.queryOptions());
  const members = org.data?.members ?? [];
  const [title, setTitle] = useState('');
  const [who, setWho] = useState('');
  const [whoUserId, setWhoUserId] = useState('');
  const [when, setWhen] = useState('');
  const [whenDate, setWhenDate] = useState('');
  const create = useMutation({
    mutationFn: () =>
      orpc.meetings.actionItems.create.call({ meetingId, title: title.trim(), who: who.trim(), whoUserId: whoUserId || null, when: when.trim(), whenDate: whenDate || null, transcriptSeconds: null }),
    onSuccess: () => {
      setTitle('');
      setWho('');
      setWhoUserId('');
      setWhen('');
      setWhenDate('');
      refresh();
    },
  });
  return (
    <form
      className="space-y-2 rounded-lg border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) create.mutate();
      }}
    >
      <Input aria-label={t('itemTitle')} placeholder={t('itemTitle')} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label={t('who')} placeholder={t('who')} value={who} maxLength={200} onChange={(e) => setWho(e.target.value)} className="w-40" />
        <NativeSelect aria-label={t('attendee')} value={whoUserId} onChange={(e) => setWhoUserId(e.target.value)}>
          <option value="">{t('noAttendee')}</option>
          {readers.map((r) => (
            <option key={r} value={r}>
              {memberLabel(members, r, t('unknownMember'))}
            </option>
          ))}
        </NativeSelect>
        <Input aria-label={t('when')} placeholder={t('when')} value={when} maxLength={200} onChange={(e) => setWhen(e.target.value)} className="w-40" />
        <DateInput aria-label={t('date')} value={whenDate} onChange={setWhenDate} />
      </div>
      {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
      <Button size="sm" type="submit" loading={create.isPending} disabled={title.trim() === ''}>
        {t('addItem')}
      </Button>
    </form>
  );
}

// One item: a reader (or the recorder) confirms the title, the date and the seat, then makes the task.
function Item({ item, isRecorder }: { item: ActionItemView; isRecorder: boolean }) {
  const t = useTranslations('meetings.results');
  const chart = useQuery(orpc.chart.get.queryOptions());
  // The attendee's own seats first, then the others (a person may give the work to any seat).
  const own = new Set(item.positions.map((p) => p.id));
  const seats = (chart.data?.positions ?? []).filter((p) => p.status !== 'archived').sort((a, b) => Number(own.has(b.id)) - Number(own.has(a.id)));
  const [title, setTitle] = useState(item.title);
  const [due, setDue] = useState(item.whenDate ?? '');
  // The seat is preselected only when the attendee holds exactly one; otherwise a person picks it (the code never picks).
  const [seat, setSeat] = useState(item.positions.length === 1 ? (item.positions[0] as { id: string }).id : '');
  const accept = useMutation({
    mutationFn: () => orpc.meetings.actionItems.accept.call({ itemId: item.id, confirmed: true, title: title.trim(), due: due || null, positionId: seat }),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: () => orpc.meetings.actionItems.delete.call({ itemId: item.id }), onSuccess: refresh });
  const open = item.status === 'suggested';
  return (
    <li className="space-y-2 py-3 text-sm" data-testid="action-item">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {item.transcriptSeconds !== null && <span className="font-mono">{clock(item.transcriptSeconds)}</span>}
        {item.who && <span>{item.who}</span>}
        {item.when && <span>{item.when}</span>}
        {item.flags.includes('contact_in_title') && <Badge variant="outline">{t('flagContact')}</Badge>}
        {item.tainted && <Badge variant="outline">{t('fromVy')}</Badge>}
        {item.status === 'accepted' && <Badge>{t('accepted')}</Badge>}
        {item.stage === 'draft' && <Badge variant="secondary">{t('draft')}</Badge>}
      </div>
      {open ? (
        <div className="space-y-2">
          <Input aria-label={t('taskTitle')} value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect aria-label={t('seat')} value={seat} onChange={(e) => setSeat(e.target.value)}>
              <option value="">{t('pickSeat')}</option>
              {seats.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </NativeSelect>
            <DateInput aria-label={t('due')} value={due} onChange={setDue} />
            <Button size="sm" loading={accept.isPending} disabled={title.trim() === '' || seat === ''} onClick={() => accept.mutate()}>
              {t('makeTask')}
            </Button>
            {isRecorder && item.stage === 'draft' && (
              <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => remove.mutate()}>
                {t('delete')}
              </Button>
            )}
          </div>
          {item.positions.length > 1 && <p className="text-xs text-muted-foreground">{t('severalSeats')}</p>}
          {(accept.error || remove.error) && <ErrorText>{errorMessage(accept.error ?? remove.error)}</ErrorText>}
        </div>
      ) : (
        <p>{item.title}</p>
      )}
    </li>
  );
}

export function MeetingResults({ meetingId, readers }: { meetingId: string; readers: readonly string[] }) {
  const t = useTranslations('meetings.results');
  const query = useQuery({ ...orpc.meetings.results.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  const publish = useMutation({ mutationFn: () => orpc.meetings.results.publish.call({ meetingId, confirmed: true }), onSuccess: refresh });
  const acceptClean = useMutation({ mutationFn: () => orpc.meetings.actionItems.acceptClean.call({ meetingId, confirmed: true }), onSuccess: refresh });
  if (query.isPending) return null;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  const data = query.data;
  const { isRecorder, draft, published, items } = data;
  // A reader with nothing shared sees no panel at all.
  if (!isRecorder && !published && items.length === 0) return null;
  const hasDraft = draft !== null || items.some((i) => i.stage === 'draft');
  const cleanCount = items.filter((i) => i.clean).length;
  return (
    <Card data-testid="meeting-results">
      <CardHeader>
        <CardTitle className="text-base font-medium">{t('title')}</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{isRecorder ? t('recorderNote') : t('readerNote')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {published && (
          <section className="space-y-1">
            {isRecorder && <h3 className="text-xs font-medium text-muted-foreground">{t('publishedTitle')}</h3>}
            <SummaryText summary={published.summary} decisions={published.decisions} />
          </section>
        )}
        {isRecorder && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium text-muted-foreground">{t('draftTitle')}</h3>
            {hasDraft && <p className="text-xs text-muted-foreground">{t('draftExpiry')}</p>}
            <SummaryEditor key={draft?.id ?? 'new'} meetingId={meetingId} summary={draft?.summary ?? ''} decisions={draft?.decisions ?? []} />
          </section>
        )}
        {items.length > 0 && (
          <section>
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium text-muted-foreground">{t('items')}</h3>
              {cleanCount > 0 && (
                <Button size="sm" variant="outline" loading={acceptClean.isPending} onClick={() => acceptClean.mutate()}>
                  {t('acceptClean', { count: String(cleanCount) })}
                </Button>
              )}
            </div>
            {acceptClean.error && <ErrorText>{errorMessage(acceptClean.error)}</ErrorText>}
            <ul className="divide-y">
              {items.map((item) => (
                <Item key={item.id} item={item} isRecorder={isRecorder} />
              ))}
            </ul>
          </section>
        )}
        {isRecorder && <NewItem meetingId={meetingId} readers={readers} />}
        {isRecorder && hasDraft && (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs text-muted-foreground">{t('publishNote')}</p>
            {publish.error && <ErrorText>{errorMessage(publish.error)}</ErrorText>}
            <Button size="sm" loading={publish.isPending} onClick={() => publish.mutate()}>
              {t('publish')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

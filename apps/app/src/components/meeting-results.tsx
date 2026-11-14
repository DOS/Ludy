// SPDX-License-Identifier: AGPL-3.0-only
// The summary, the decisions and the action items of a meeting on its page (#2580, M6 part A). The recorder types a summary and items as a draft only they
// see, and one click shares them with the meeting's readers; a reader sees what was shared and makes a team task from an item: they confirm the title, pick the
// date and the seat. Nothing here needs AI; the work Vy does for this screen arrives in a later step and lands in these same drafts.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import { MEETING_SUMMARY_TEMPLATES, templateSections, textToSections, type ActionItemView, type MeetingSummaryTemplate } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { Textarea } from '@crove/ui/components/textarea';
import { DateInput } from './date-input.tsx';
import { ErrorText } from './ui.tsx';
import { MeetingFollowup } from './meeting-followup.tsx';
import { MeetingTranslation } from './meeting-translation.tsx';
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

// The recorder picks the minutes template of their meeting (A4, #3162): the sections Vy fills and the sections they type under. The kernel keeps only the code.
function TemplatePicker({ meetingId, template }: { meetingId: string; template: MeetingSummaryTemplate }) {
  const t = useTranslations('meetings');
  const pick = useMutation({
    mutationFn: (summaryTemplate: MeetingSummaryTemplate) => orpc.meetings.setTemplate.call({ meetingId, summaryTemplate }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.get.key() });
    },
  });
  return (
    <div className="space-y-1" data-testid="template-picker">
      <label htmlFor="minutes-template" className="text-xs font-medium text-muted-foreground">
        {t('templates.label')}
      </label>
      <NativeSelect id="minutes-template" value={template} disabled={pick.isPending} onChange={(e) => pick.mutate(e.target.value as MeetingSummaryTemplate)}>
        {MEETING_SUMMARY_TEMPLATES.map((code) => (
          <NativeSelectOption key={code} value={code}>
            {t(`templates.names.${code}`)}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">{t('templates.hint')}</p>
      {pick.error && <ErrorText>{errorMessage(pick.error)}</ErrorText>}
    </div>
  );
}

// The recorder's draft summary and decisions (one decision per line). On a template the summary is typed section by section; the kernel makes the one text from them.
function SummaryEditor({ meetingId, summary, decisions, template }: { meetingId: string; summary: string; decisions: string[]; template: MeetingSummaryTemplate }) {
  const t = useTranslations('meetings.results');
  const tm = useTranslations('meetings');
  const defs = templateSections(template);
  const parsed = defs.length === 0 ? null : textToSections(template, summary);
  // Text that is not in this template's form (typed before the recorder changed the type) goes into the first section, never lost.
  const reflowed = defs.length > 0 && parsed === null && summary.trim() !== '';
  const [text, setText] = useState(summary);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(defs.map((d, i) => [d.key, parsed ? ((parsed.find((p) => p.key === d.key)?.text) ?? '') : i === 0 ? summary : ''])),
  );
  const [lines, setLines] = useState(decisions.join('\n'));
  const decisionList = lines.split('\n').map((l) => l.trim()).filter(Boolean);
  const sections = defs.map((d) => ({ key: d.key, text: (values[d.key] ?? '').trim() })).filter((x) => x.text !== '');
  const save = useMutation({
    mutationFn: () =>
      orpc.meetings.results.saveSummary.call(defs.length === 0 ? { meetingId, summary: text.trim(), decisions: decisionList } : { meetingId, sections, decisions: decisionList }),
    onSuccess: refresh,
  });
  return (
    <div className="space-y-2">
      {defs.length === 0 ? (
        <Textarea aria-label={t('summary')} value={text} maxLength={8000} rows={5} onChange={(e) => setText(e.target.value)} />
      ) : (
        <div className="space-y-2" data-testid="section-editor">
          {reflowed && <p className="text-xs text-muted-foreground">{tm('templates.reflow')}</p>}
          {defs.map((d) => (
            <div key={d.key} className="space-y-1">
              <label htmlFor={`section-${d.key}`} className="text-xs font-medium">
                {tm(`templates.sections.${template}.${d.key}` as never)}
              </label>
              <Textarea id={`section-${d.key}`} value={values[d.key] ?? ''} maxLength={1200} rows={3} onChange={(e) => setValues((v) => ({ ...v, [d.key]: e.target.value }))} />
            </div>
          ))}
        </div>
      )}
      <Textarea aria-label={t('decisions')} placeholder={t('decisionsHint')} value={lines} rows={3} onChange={(e) => setLines(e.target.value)} />
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      <Button size="sm" loading={save.isPending} disabled={defs.length === 0 ? text.trim() === '' : sections.length === 0} onClick={() => save.mutate()}>
        {t('saveDraft')}
      </Button>
    </div>
  );
}

function SummaryText({ summary, decisions, template }: { summary: string; decisions: string[]; template: MeetingSummaryTemplate }) {
  const t = useTranslations('meetings.results');
  const tm = useTranslations('meetings');
  // A template's text is shown under its headings; text that is not in the template's form is shown whole.
  const sections = textToSections(template, summary)?.filter((s) => s.text !== '') ?? null;
  return (
    <div className="space-y-2 text-sm">
      {sections === null ? (
        <p className="whitespace-pre-wrap">{summary}</p>
      ) : (
        sections.map((s) => (
          <div key={s.key}>
            <p className="text-xs font-medium text-muted-foreground">{tm(`templates.sections.${template}.${s.key}` as never)}</p>
            <p className="whitespace-pre-wrap">{s.text}</p>
          </div>
        ))
      )}
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

// A fixed code the kernel sent, in words; null for a code this screen does not know.
function codeText(t: ReturnType<typeof useTranslations>, code: unknown): string | null {
  switch (code) {
    case 'AI_BUDGET_EXHAUSTED':
    case 'AI_STOPPED':
    case 'SUMMARY_TIMEOUT':
    case 'SUMMARY_FAILED':
    case 'SUMMARY_UNPARSABLE':
    case 'SUMMARY_EMPTY':
    case 'SUMMARY_TOO_LONG':
    case 'SUMMARY_NO_TRANSCRIPT':
      return t(`vy.codes.${code}`);
    default:
      return null;
  }
}

// The recorder's own Vy summarizing this meeting: ask, wait for the one answer, then copy it into the draft with a click of their own. Shown to the recorder only, and
// only when this system lets Vy summarize (the status says so); nothing is shared from here.
function VySummary({ meetingId, hasModelDraft }: { meetingId: string; hasModelDraft: boolean }) {
  const t = useTranslations('meetings.results');
  const status = useQuery(orpc.meetings.results.summaryStatus.queryOptions({ input: { meetingId } }));
  const ask = useMutation({ mutationFn: () => orpc.meetings.results.summarize.call({ meetingId }) });
  const copy = useMutation({
    mutationFn: (runId: string) => orpc.meetings.results.copySummary.call({ meetingId, runId }),
    onSuccess: () => {
      ask.reset();
      refresh();
    },
  });
  if (!status.data?.enabled) return null;
  const answer = ask.data;
  const refusal = ask.error ?? copy.error;
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="vy-summary">
      <p className="text-sm font-medium">{t('vy.title')}</p>
      <p className="text-xs text-muted-foreground">{t('vy.desc')}</p>
      {ask.isPending && <p role="status">{t('vy.running')}</p>}
      {copy.isSuccess && <p role="status">{t('vy.copied')}</p>}
      {answer?.state === 'ready' && !copy.isSuccess && (
        <div className="space-y-2">
          <p>{t('vy.ready')}</p>
          {hasModelDraft && <p className="text-xs text-muted-foreground">{t('vy.copyReplaces')}</p>}
          <Button size="sm" loading={copy.isPending} onClick={() => copy.mutate(answer.runId)}>
            {t('vy.copy')}
          </Button>
        </div>
      )}
      {answer?.state === 'failed' && <ErrorText>{`${t('vy.failed')} ${codeText(t, answer.errorCode) ?? t('vy.codes.default')}`}</ErrorText>}
      {refusal && <ErrorText>{errorMessage(refusal)}</ErrorText>}
      {!ask.isPending && answer?.state !== 'ready' && (
        <Button size="sm" variant={answer ? 'outline' : 'default'} loading={ask.isPending} onClick={() => ask.mutate()}>
          {answer ? t('vy.restart') : t('vy.start')}
        </Button>
      )}
    </div>
  );
}

// `template` is the meeting's minutes template (A4, #3162); `minutesLink` is the "Xem biên bản" link the page puts beside the title (it knows the route; this panel does not).
export function MeetingResults({ meetingId, readers, template = 'general', minutesLink }: { meetingId: string; readers: readonly string[]; template?: MeetingSummaryTemplate; minutesLink?: ReactNode }) {
  const t = useTranslations('meetings.results');
  const query = useQuery({ ...orpc.meetings.results.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  const publish = useMutation({ mutationFn: () => orpc.meetings.results.publish.call({ meetingId, confirmed: true }), onSuccess: refresh });
  const review = useMutation({ mutationFn: (ids: string[]) => orpc.meetings.results.review.call({ meetingId, confirmed: true, ids }), onSuccess: refresh });
  const acceptClean = useMutation({ mutationFn: () => orpc.meetings.actionItems.acceptClean.call({ meetingId, confirmed: true }), onSuccess: refresh });
  if (query.isPending) return null;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  const data = query.data;
  const { isRecorder, draft, published, items } = data;
  // A reader with nothing shared sees no panel at all.
  if (!isRecorder && !published && items.length === 0) return null;
  const hasDraft = draft !== null || items.some((i) => i.stage === 'draft');
  // What Vy wrote and the recorder has not read: the draft is not shared until they confirm it (or rewrite it).
  // The rows on the screen that Vy wrote: the review names exactly these, so a row copied in another tab after this one loaded keeps its mark.
  const unreadIds = [...(draft?.tainted ? [draft.id] : []), ...items.filter((i) => i.stage === 'draft' && i.tainted).map((i) => i.id)];
  const unread = unreadIds.length > 0;
  const cleanCount = items.filter((i) => i.clean).length;
  return (
    <Card data-testid="meeting-results">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base font-medium">{t('title')}</CardTitle>
          {minutesLink}
        </div>
        <CardDescription className="text-xs text-muted-foreground">{isRecorder ? t('recorderNote') : t('readerNote')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {published && (
          <section className="space-y-1">
            {isRecorder && <h3 className="text-xs font-medium text-muted-foreground">{t('publishedTitle')}</h3>}
            <SummaryText summary={published.summary} decisions={published.decisions} template={template} />
            <MeetingTranslation meetingId={meetingId} stage="published" original={{ summary: published.summary, decisions: published.decisions, items: items.filter((i) => i.stage === 'published') }} />
          </section>
        )}
        {isRecorder && (published || items.some((i) => i.stage === 'published')) && <MeetingFollowup meetingId={meetingId} />}
        {isRecorder && <TemplatePicker meetingId={meetingId} template={template} />}
        {isRecorder && <VySummary meetingId={meetingId} hasModelDraft={(draft?.tainted ?? false) || items.some((i) => i.stage === 'draft' && i.tainted)} />}
        {isRecorder && (
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {t('draftTitle')}
              {draft?.tainted && <Badge variant="outline">{t('fromVy')}</Badge>}
            </h3>
            {hasDraft && <p className="text-xs text-muted-foreground">{t('draftExpiry')}</p>}
            <SummaryEditor key={`${template}-${draft?.id ?? 'new'}`} meetingId={meetingId} summary={draft?.summary ?? ''} decisions={draft?.decisions ?? []} template={template} />
            {hasDraft && <MeetingTranslation meetingId={meetingId} stage="draft" original={{ summary: draft?.summary ?? '', decisions: draft?.decisions ?? [], items: items.filter((i) => i.stage === 'draft') }} />}
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
            {unread && (
              <div className="space-y-2" data-testid="vy-review">
                <p className="text-sm">{t('reviewNote')}</p>
                {review.error && <ErrorText>{errorMessage(review.error)}</ErrorText>}
                <Button size="sm" variant="outline" loading={review.isPending} onClick={() => review.mutate(unreadIds)}>
                  {t('reviewed')}
                </Button>
              </div>
            )}
            {publish.error && <ErrorText>{errorMessage(publish.error)}</ErrorText>}
            <Button size="sm" loading={publish.isPending} disabled={unread} onClick={() => publish.mutate()}>
              {t('publish')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// The summary, the decisions and the action items of a meeting on its page (#2580, M6 part A). The recorder types a summary and items as a draft only they
// see, and one click shares them with the meeting's readers; a reader sees what was shared and makes a team task from an item: they confirm the title, pick the
// date and the seat. Nothing here needs AI; the work Vy does for this screen arrives in a later step and lands in these same drafts.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslations } from 'use-intl';
import { MEETING_SUMMARY_TEMPLATES, templateSections, textToSections, type ActionItemView, type AssigneeAnswer, type MeetingSummaryTemplate, type MeetingVisibility, type MinutesTemplateCopy, type TranscriptRedacted } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Textarea } from '@ludy/ui/components/textarea';
import { ConfirmDialog } from './confirm-dialog.tsx';
import { DateInput } from './date-input.tsx';
import { ErrorText } from './ui.tsx';
import { MeetingDealUpdate } from './meeting-deal-update.tsx';
import { MeetingFollowup } from './meeting-followup.tsx';
import { MeetingMinutesSignHandoff, type MeetingSignMemberInfo } from './meeting-minutes-sign-handoff.tsx';
import { useMinutesEsign } from './minutes-esign.tsx';
import { DraftRedactionDialog, RedactionNudge, useRedactCandidatesQuery } from './meeting-redaction.tsx';
import { MeetingZalo } from './meeting-zalo.tsx';
import { MeetingChatPost } from './meeting-chat.tsx';
import { MeetingTranslation } from './meeting-translation.tsx';
import { MinutesVersionPublisher, MinutesVersionSwitch } from './meeting-minutes-version.tsx';
import { clock } from './meeting-transcript.tsx';
import { TalkTimeLine } from './meeting-talk-time.tsx';
import { notesInstalled } from './notes-panel.tsx';
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
  void queryClient.invalidateQueries({ queryKey: orpc.meetings.transcript.redactCandidates.key() });
};

// The recorder picks the minutes template of their meeting (A4, #3162): the sections Vy fills and the sections they type under. The five built-in ones, then the templates the org wrote
// (#3578), listed by name. Picking an org template makes the meeting its own copy of it, so a later edit or archive of the template changes nothing here; picking the same one again takes
// its current sections. The meeting's present copy, when it is one, is the selected option under its own name.
const CURRENT_COPY = 'current-copy';
export function TemplatePicker({ meetingId, template, copy }: { meetingId: string; template: MeetingSummaryTemplate; copy: MinutesTemplateCopy | null }) {
  const t = useTranslations('meetings');
  const org = useQuery(orpc.meetings.template.list.queryOptions({ input: {} }));
  const own = (org.data?.templates ?? []).filter((x) => !x.archived);
  const pick = useMutation({
    mutationFn: (value: string) =>
      value.startsWith('org:')
        ? orpc.meetings.setTemplate.call({ meetingId, summaryTemplate: 'custom', templateId: value.slice('org:'.length) })
        : orpc.meetings.setTemplate.call({ meetingId, summaryTemplate: value as Exclude<MeetingSummaryTemplate, 'custom'> }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.get.key() });
    },
  });
  // Code without a copy treats a custom meeting as the general summary (the contract), so that is what the select shows then.
  const current = template === 'custom' ? (copy ? CURRENT_COPY : 'general') : template;
  return (
    <div className="space-y-1" data-testid="template-picker">
      <label htmlFor="minutes-template" className="text-xs font-medium text-muted-foreground">
        {t('templates.label')}
      </label>
      <NativeSelect id="minutes-template" value={current} disabled={pick.isPending} onChange={(e) => e.target.value !== CURRENT_COPY && pick.mutate(e.target.value)}>
        {MEETING_SUMMARY_TEMPLATES.map((code) => (
          <NativeSelectOption key={code} value={code}>
            {t(`templates.names.${code}`)}
          </NativeSelectOption>
        ))}
        {template === 'custom' && copy && (
          <NativeSelectOption value={CURRENT_COPY}>{t('templates.customCurrent', { name: copy.name })}</NativeSelectOption>
        )}
        {own.map((x) => (
          <NativeSelectOption key={x.id} value={`org:${x.id}`}>
            {t('templates.customOption', { name: x.name })}
          </NativeSelectOption>
        ))}
      </NativeSelect>
      <p className="text-xs text-muted-foreground">{t('templates.hint')}</p>
      {pick.error && <ErrorText>{errorMessage(pick.error)}</ErrorText>}
    </div>
  );
}

// The heading of a section: an organization's template gives its own (from the meeting's copy, shown as text), a built-in one the app's words.
export function sectionHeadingText(t: (key: never) => string, template: MeetingSummaryTemplate, copy: MinutesTemplateCopy | null, key: string): string {
  return template === 'custom' ? (copy?.sections.find((s) => s.key === key)?.title ?? '') : t(`templates.sections.${template}.${key}` as never);
}
export function useSectionHeading(template: MeetingSummaryTemplate, copy: MinutesTemplateCopy | null) {
  const tm = useTranslations('meetings');
  return (key: string): string => sectionHeadingText(tm as unknown as (key: never) => string, template, copy, key);
}

// The recorder's draft summary and decisions (one decision per line). On a template the summary is typed section by section; the kernel makes the one text from them.
function SummaryEditor({ meetingId, summary, decisions, template, copy }: { meetingId: string; summary: string; decisions: string[]; template: MeetingSummaryTemplate; copy: MinutesTemplateCopy | null }) {
  const t = useTranslations('meetings.results');
  const tm = useTranslations('meetings');
  const heading = useSectionHeading(template, copy);
  const defs = templateSections(template, copy?.sections ?? null);
  const parsed = defs.length === 0 ? null : textToSections(template, summary, copy?.sections ?? null);
  // Text that is not in this template's form (typed before the recorder changed the type) goes into the first section, never lost.
  const reflowed = defs.length > 0 && parsed === null && summary.trim() !== '';
  const [text, setText] = useState(summary);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(defs.map((d, i) => [d.key, parsed ? ((parsed.find((p) => p.key === d.key)?.text) ?? '') : i === 0 ? summary : ''])),
  );
  const [lines, setLines] = useState(decisions.join('\n'));
  const decisionsKey = decisions.join('\n');
  const copyHash = copy?.hash ?? null;
  const prevServerRef = useRef({ summary, decisionsKey, template, copyHash });
  useEffect(() => {
    if (
      prevServerRef.current.summary !== summary ||
      prevServerRef.current.decisionsKey !== decisionsKey ||
      prevServerRef.current.template !== template ||
      prevServerRef.current.copyHash !== copyHash
    ) {
      prevServerRef.current = { summary, decisionsKey, template, copyHash };
      const currentDefs = templateSections(template, copy?.sections ?? null);
      const nextParsed = currentDefs.length === 0 ? null : textToSections(template, summary, copy?.sections ?? null);
      setText(summary);
      setValues(
        Object.fromEntries(currentDefs.map((d, i) => [d.key, nextParsed ? ((nextParsed.find((p) => p.key === d.key)?.text) ?? '') : i === 0 ? summary : ''])),
      );
      setLines(decisionsKey);
    }
  }, [summary, decisionsKey, template, copy, copyHash]);
  const decisionList = lines.split('\n').map((l) => l.trim()).filter(Boolean);
  const sections = defs.map((d) => ({ key: d.key, text: (values[d.key] ?? '').trim() })).filter((x) => x.text !== '');
  // A section holds at most 1200 characters; text reflowed into the first one can be longer, and the recorder splits it before saving.
  const tooLong = defs.some((d) => (values[d.key] ?? '').length > 1200);
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
          {tooLong && <ErrorText>{tm('templates.tooLong')}</ErrorText>}
          {defs.map((d) => (
            <div key={d.key} className="space-y-1">
              <label htmlFor={`section-${d.key}`} className="text-xs font-medium">
                {heading(d.key)}
              </label>
              <Textarea id={`section-${d.key}`} value={values[d.key] ?? ''} maxLength={1200} rows={3} onChange={(e) => setValues((v) => ({ ...v, [d.key]: e.target.value }))} />
            </div>
          ))}
        </div>
      )}
      <Textarea aria-label={t('decisions')} placeholder={t('decisionsHint')} value={lines} rows={3} onChange={(e) => setLines(e.target.value)} />
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      <Button size="sm" loading={save.isPending} disabled={defs.length === 0 ? text.trim() === '' : sections.length === 0 || tooLong} onClick={() => save.mutate()}>
        {t('saveDraft')}
      </Button>
    </div>
  );
}

export function SummaryText({ summary, decisions, template, copy = null }: { summary: string; decisions: string[]; template: MeetingSummaryTemplate; copy?: MinutesTemplateCopy | null }) {
  const t = useTranslations('meetings.results');
  const heading = useSectionHeading(template, copy);
  // A template's text is shown under its headings; text that is not in the template's form is shown whole.
  const sections = textToSections(template, summary, copy?.sections ?? null)?.filter((s) => s.text !== '') ?? null;
  return (
    <div className="space-y-2 text-sm">
      {sections === null ? (
        <p className="whitespace-pre-wrap">{summary}</p>
      ) : (
        sections.map((s) => (
          <div key={s.key}>
            <p className="text-xs font-medium text-muted-foreground">{heading(s.key)}</p>
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
// The click that has the member's own Vy read the said name when code found nobody (#3921, step 2). Absent when AI is off here (no model, the deployment's switch, no right to work with Vy, a pause or a spent
// budget): the plain "pick the seat" flow is the whole feature then, with no button and no message about what is not there. The answer is text on the page; nothing is stored.
function AskVy({ itemId, answer, onAnswer }: { itemId: string; answer: AssigneeAnswer | null; onAnswer: (answer: AssigneeAnswer) => void }) {
  const t = useTranslations('meetings.results');
  const status = useQuery({ ...orpc.meetings.assignee.status.queryOptions({ input: {} }), ...READ_ONCE });
  const ask = useMutation({ mutationFn: (): Promise<AssigneeAnswer> => orpc.meetings.assignee.suggest.call({ itemId }), onSuccess: onAnswer });
  if (status.data?.enabled !== true) return null;
  const code = answer?.errorCode ?? null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="assignee-ask">
      {answer?.state !== 'suggested' && (
        <Button size="sm" variant="ghost" loading={ask.isPending} disabled={ask.isPending} onClick={() => ask.mutate()} data-testid="assignee-ask-button">
          {t('askVy')}
        </Button>
      )}
      <span aria-live="polite" className="text-xs text-muted-foreground">
        {ask.isPending && t('askVyRunning')}
        {answer?.state === 'none' && t('askVyNone')}
        {answer?.state === 'failed' && `${t('askVyFailed')} ${t(`askVyCodes.${code === 'AI_BUDGET_EXHAUSTED' || code === 'AI_STOPPED' || code === 'ASSIGNEE_BUSY' ? code : 'default'}`)}`}
      </span>
      {ask.error && <ErrorText>{errorMessage(ask.error)}</ErrorText>}
    </div>
  );
}

function Item({ item, isRecorder, redactedEpoch = 0 }: { item: ActionItemView; isRecorder: boolean; redactedEpoch?: number }) {
  const t = useTranslations('meetings.results');
  const chart = useQuery(orpc.chart.get.queryOptions());
  // Who the item points at: the attendee it names, else the person the said name probably means (a suggestion only, found by code).
  // Vy's answer to a click (step 2) stands in for it when code found nobody; it is only text on the page, never stored.
  const [vy, setVy] = useState<AssigneeAnswer | null>(null);
  const lastEpochRef = useRef(redactedEpoch);
  useEffect(() => {
    if (redactedEpoch !== lastEpochRef.current) {
      lastEpochRef.current = redactedEpoch;
      setVy(null);
    }
  }, [redactedEpoch]);
  const suggested = item.whoUserId === null ? (item.suggestion ?? (vy?.suggestion ? { ...vy.suggestion, source: 'vy' as const } : null)) : null;
  const offered = suggested ? suggested.positions : item.positions;
  // Their own seats first, then the others (a person may give the work to any seat).
  const own = new Set(offered.map((p) => p.id));
  const seats = (chart.data?.positions ?? []).filter((p) => p.status !== 'archived').sort((a, b) => Number(own.has(b.id)) - Number(own.has(a.id)));
  const [title, setTitle] = useState(item.title);
  useEffect(() => {
    setTitle(item.title);
  }, [item.title]);
  const [due, setDue] = useState(item.whenDate ?? '');
  // The seat is preselected only when that person holds exactly one; otherwise a person picks it (the code never picks).
  const [seat, setSeat] = useState(offered.length === 1 ? (offered[0] as { id: string }).id : '');
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
          {suggested && (
            <p className="text-xs text-muted-foreground" data-testid="assignee-suggestion">
              <Badge variant="outline">{t('suggestedBadge')}</Badge> {t(suggested.source === 'vy' ? 'suggestedVy' : suggested.source === 'attendee' ? 'suggestedAttendee' : 'suggestedMember', { name: suggested.name })} {t(offered.length === 0 ? 'suggestedNoSeat' : offered.length === 1 ? 'suggestedOneSeat' : 'suggestedSeveralSeats')}
            </p>
          )}
          {item.whoUserId === null && item.suggestion === null && item.who.trim() !== '' && (
            <AskVy
              itemId={item.id}
              answer={vy}
              onAnswer={(answer) => {
                setVy(answer);
                // Preselected only when the person holds exactly one seat, and never over a seat a person already picked.
                const held = answer.suggestion?.positions ?? [];
                if (held.length === 1 && seat === '') setSeat((held[0] as { id: string }).id);
              }}
            />
          )}
          {!suggested && item.positions.length > 1 && <p className="text-xs text-muted-foreground">{t('severalSeats')}</p>}
          {(accept.error || remove.error) && <ErrorText>{errorMessage(accept.error ?? remove.error)}</ErrorText>}
        </div>
      ) : (
        <p>{item.title}</p>
      )}
    </li>
  );
}

// A fixed code the kernel sent, in words; null for a code this screen does not know.
export function codeText(t: ReturnType<typeof useTranslations>, code: unknown): string | null {
  switch (code) {
    case 'AI_BUDGET_EXHAUSTED':
    case 'AI_STOPPED':
    case 'SUMMARY_TIMEOUT':
    case 'SUMMARY_FAILED':
    case 'SUMMARY_UNPARSABLE':
    case 'SUMMARY_EMPTY':
    case 'SUMMARY_TOO_LONG':
    case 'SUMMARY_NO_TRANSCRIPT':
    case 'NOTES_TOO_LONG':
      return t(`vy.codes.${code}`);
    default:
      return null;
  }
}

// Which attendee a speaker may be (#3502), as the recorder's Vy suggested it in a finished summary run: one line per suggestion with the moment it rests on and a click of the recorder's own
// that gives the draft lines of that speaker the attendee's name. Nothing is renamed without the click; with no suggestion the block is not drawn.
export function SpeakerSuggestions({ meetingId, runId }: { meetingId: string; runId: string }) {
  const t = useTranslations('meetings.results');
  const list = useQuery({ ...orpc.meetings.results.speakerSuggestions.queryOptions({ input: { meetingId, runId } }), ...READ_ONCE });
  const name = useMutation({
    mutationFn: (s: { label: string; name: string }) => orpc.meetings.results.nameSpeaker.call({ meetingId, label: s.label, name: s.name }),
    onSuccess: () => {
      void list.refetch();
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.transcript.key() });
    },
  });
  const suggestions = list.data?.suggestions ?? [];
  if (suggestions.length === 0 && !name.isSuccess) return null;
  return (
    <div className="space-y-2" data-testid="speaker-suggestions">
      <p className="text-sm font-medium">{t('vy.speakers.title')}</p>
      <p className="text-xs text-muted-foreground">{t('vy.speakers.hint')}</p>
      <ul className="space-y-1">
        {suggestions.map((s) => (
          <li key={s.label} className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t('vy.speakers.line', { label: s.label, name: s.name, time: clock(s.seconds) })}</span>
            <Button size="sm" variant="outline" loading={name.isPending && name.variables?.label === s.label} onClick={() => name.mutate({ label: s.label, name: s.name })}>
              {t('vy.speakers.apply')}
            </Button>
          </li>
        ))}
      </ul>
      <p role="status" className="empty:mb-0">{name.isSuccess ? t('vy.speakers.done', { name: name.data.name, count: String(name.data.lines) }) : null}</p>
      {name.error && <ErrorText>{errorMessage(name.error)}</ErrorText>}
    </div>
  );
}

// The recorder's own Vy summarizing this meeting: ask, wait for the one answer, then copy it into the draft with a click of their own. Shown to the recorder only, and
// only when this system lets Vy summarize (the status says so); nothing is shared from here.
function VySummary({ meetingId, hasModelDraft }: { meetingId: string; hasModelDraft: boolean }) {
  const t = useTranslations('meetings.results');
  const status = useQuery(orpc.meetings.results.summaryStatus.queryOptions({ input: { meetingId } }));
  // The run whose speaker suggestions are shown: kept after the copy below resets the answer, so the recorder can still accept a name once the draft is theirs.
  const [suggestRun, setSuggestRun] = useState<string | null>(null);
  const ask = useMutation({
    mutationFn: () => {
      setSuggestRun(null);
      return orpc.meetings.results.summarize.call({ meetingId });
    },
    onSuccess: (r) => setSuggestRun(r.state === 'ready' ? r.runId : null),
  });
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
      {/* One live region that is always in the page, so the changes are announced (a region added together with its text often is not): the run's progress, the draft that is ready, the copy that was made. */}
      <div role="status" aria-live="polite" className="space-y-2 empty:mb-0" data-testid="vy-live">
        {ask.isPending && <p>{t('vy.running')}</p>}
        {answer?.state === 'ready' && !copy.isSuccess && <p data-testid="vy-ready">{t('vy.ready')}</p>}
        {copy.isSuccess && <p>{t('vy.copied')}</p>}
      </div>
      {suggestRun !== null && <SpeakerSuggestions meetingId={meetingId} runId={suggestRun} />}
      {answer?.state === 'ready' && !copy.isSuccess && (
        <div className="space-y-2">
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

function hasNotesModule(): boolean {
  try {
    return notesInstalled();
  } catch {
    return false;
  }
}

function SaveSummaryAsNote({
  meetingId,
  visibility,
  slug,
}: {
  meetingId: string;
  visibility: MeetingVisibility | undefined;
  slug: string | undefined;
}) {
  const t = useTranslations('meetings.results');
  const [savedNoteId, setSavedNoteId] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => orpc.notes.fromMeetingSummary.call({ meetingId }),
    onSuccess: (done) => {
      setSavedNoteId(done.noteId);
      void queryClient.invalidateQueries({ queryKey: orpc.notes.key() });
    },
  });
  return (
    <div className="space-y-2 border-t pt-3" data-testid="save-summary-as-note-box">
      {visibility !== 'org' ? (
        <ConfirmDialog
          render={<Button type="button" size="sm" variant="outline" loading={save.isPending} data-testid="save-summary-as-note" />}
          disabled={save.isPending}
          title={t('saveAsNoteConfirmTitle')}
          description={t('saveAsNoteConfirmDesc')}
          confirm={t('saveAsNoteConfirmAction')}
          onConfirm={() => save.mutate()}
        >
          {t('saveAsNote')}
        </ConfirmDialog>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="outline"
          loading={save.isPending}
          disabled={save.isPending}
          onClick={() => save.mutate()}
          data-testid="save-summary-as-note"
        >
          {t('saveAsNote')}
        </Button>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      {savedNoteId !== null && (
        <p role="status" className="text-xs text-muted-foreground" data-testid="saved-summary-note">
          {t('savedAsNote')}
          {slug ? (
            <>
              {' '}
              <Link to="/o/$slug/notes" params={{ slug }} search={{ note: savedNoteId }} className="text-link underline">
                {t('openSavedNote')}
              </Link>
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}

export interface MeetingRedactionControl {
  queryEnabled: boolean;
  onOpen: () => void;
  lastRedacted: TranscriptRedacted | null;
  showDone: boolean;
  doneRef: RefObject<HTMLDivElement | null>;
  redactedEpoch: number;
}

// `template` is the meeting's minutes template (A4, #3162); `minutesLink` is the "Xem biên bản" link the page puts beside the title (it knows the route; this panel does not); `title` is
// the meeting's title, for the heading of the text "Gửi qua Zalo" prepares (B5, #3169).
export function MeetingResults({
  meetingId,
  readers,
  template = 'general',
  minutesTemplate = null,
  title = '',
  visibility,
  slug,
  minutesLink,
  signInfo,
  redaction,
}: {
  meetingId: string;
  readers: readonly string[];
  template?: MeetingSummaryTemplate;
  // The meeting's own copy of an organization's template (#3578): the headings of a custom meeting are read from it.
  minutesTemplate?: MinutesTemplateCopy | null;
  title?: string;
  visibility?: MeetingVisibility;
  slug?: string;
  minutesLink?: ReactNode;
  signInfo?: {
    startedAt: string | null;
    createdAt: string;
    endedAt: string | null;
    recorderUserId: string;
    companyName: string;
    orgMembers: readonly MeetingSignMemberInfo[];
    canEdit?: boolean;
  };
  redaction?: MeetingRedactionControl;
}) {
  const t = useTranslations('meetings.results');
  const minutesEsignOn = useMinutesEsign();
  const query = useQuery({ ...orpc.meetings.results.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  const [localRedactOpen, setLocalRedactOpen] = useState(false);
  const [localLastRedacted, setLocalLastRedacted] = useState<TranscriptRedacted | null>(null);
  const [localRedactedEpoch, setLocalRedactedEpoch] = useState(0);
  const localDoneRef = useRef<HTMLDivElement | null>(null);
  const redactEnabled = redaction
    ? redaction.queryEnabled
    : Boolean(query.data?.isRecorder && (query.data.draft !== null || query.data.items.some((i) => i.stage === 'draft')));
  const redactCandidatesQuery = useRedactCandidatesQuery(meetingId, redactEnabled);
  // Publishing removes the button that held the focus (the draft is gone): the focus goes to the heading of what was shared, which a screen reader reads out as the result (WCAG 2.4.3, 4.1.3).
  const [focusPublished, setFocusPublished] = useState(false);
  const publishedHeading = useRef<HTMLHeadingElement | null>(null);
  const hasPublished = query.data?.published != null;
  useEffect(() => {
    if (focusPublished && hasPublished && publishedHeading.current) {
      // Only when the focus was lost with the button: a person who has moved on to another field keeps it.
      if (document.activeElement === null || document.activeElement === document.body) publishedHeading.current.focus();
      setFocusPublished(false);
    }
  }, [focusPublished, hasPublished]);
  const publish = useMutation({
    mutationFn: () => orpc.meetings.results.publish.call({ meetingId, confirmed: true }),
    // Waits for the results to be read again, so the heading is the one of the result that was just shared.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: orpc.meetings.results.key() });
      await queryClient.invalidateQueries({ queryKey: orpc.meetings.transcript.redactCandidates.key() });
      setFocusPublished(true);
    },
  });
  const review = useMutation({ mutationFn: (ids: string[]) => orpc.meetings.results.review.call({ meetingId, confirmed: true, ids }), onSuccess: refresh });
  const acceptClean = useMutation({ mutationFn: () => orpc.meetings.actionItems.acceptClean.call({ meetingId, confirmed: true }), onSuccess: refresh });
  if (query.isPending) return null;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  const data = query.data;
  const { isRecorder, draft, published, items } = data;
  // A reader with nothing shared sees no panel at all.
  if (!isRecorder && !published && items.length === 0) return null;
  const hasDraft = draft !== null || items.some((i) => i.stage === 'draft');
  const hasPublishedSummary =
    published !== null && (published.summary.trim() !== '' || published.decisions.some((d) => d.trim() !== ''));
  const hasDraftSummary =
    isRecorder &&
    published === null &&
    draft !== null &&
    !draft.tainted &&
    (draft.summary.trim() !== '' || draft.decisions.some((d) => d.trim() !== ''));
  const canSaveAsNote = hasNotesModule() && (hasPublishedSummary || hasDraftSummary);
  // What Vy wrote and the recorder has not read: the draft is not shared until they confirm it (or rewrite it).
  // The rows on the screen that Vy wrote: the review names exactly these, so a row copied in another tab after this one loaded keeps its mark.
  const unreadIds = [...(draft?.tainted ? [draft.id] : []), ...items.filter((i) => i.stage === 'draft' && i.tainted).map((i) => i.id)];
  const unread = unreadIds.length > 0;
  const cleanCount = items.filter((i) => i.clean).length;
  // The shared text as the translation reads it (the summary, the decisions and the titles of the shared items).
  const publishedOriginal = { summary: published?.summary ?? '', decisions: published?.decisions ?? [], items: items.filter((i) => i.stage === 'published') };
  const effectiveRedactedEpoch = redaction ? redaction.redactedEpoch : localRedactedEpoch;
  return (
    <Card data-testid="meeting-results">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle role="heading" aria-level={2} className="text-base font-medium">{t('title')}</CardTitle>
          {minutesLink}
        </div>
        <CardDescription className="text-xs text-muted-foreground">{isRecorder ? t('recorderNote') : t('readerNote')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {published && (
          <section className="space-y-1">
            {isRecorder && (
              <h3 ref={publishedHeading} tabIndex={-1} className="text-xs font-medium text-muted-foreground">
                {t('publishedTitle')}
              </h3>
            )}
            {/* The second-language version the recorder published (#4777): readers switch between the original and it; the original shows first. */}
            <MinutesVersionSwitch meetingId={meetingId} original={publishedOriginal}>
              <SummaryText summary={published.summary} decisions={published.decisions} template={template} copy={minutesTemplate} />
            </MinutesVersionSwitch>
            {/* Who did the talking (#4765): one line worked out in code from the transcript the reader may read, no AI */}
            <TalkTimeLine meetingId={meetingId} />
            <MeetingTranslation meetingId={meetingId} stage="published" original={publishedOriginal} />
            {isRecorder && <MinutesVersionPublisher meetingId={meetingId} original={publishedOriginal} />}
          </section>
        )}
        {canSaveAsNote && <SaveSummaryAsNote key={meetingId} meetingId={meetingId} visibility={visibility} slug={slug} />}
        {/* Ký biên bản họp (#4703): the handoff shows only while the org setting is on; the server refuses a new minutes envelope while it is off. */}
        {signInfo && minutesEsignOn && (published !== null || items.some((i) => i.stage === 'published')) && (
          <MeetingMinutesSignHandoff
            source={{
              meeting: {
                id: meetingId,
                title,
                startedAt: signInfo.startedAt,
                createdAt: signInfo.createdAt,
                endedAt: signInfo.endedAt,
                recorderUserId: signInfo.recorderUserId,
                readers,
                summaryTemplate: template,
                minutesTemplate,
                isRecorder,
              },
              results: data,
              companyName: signInfo.companyName,
              orgMembers: signInfo.orgMembers,
            }}
            {...(signInfo.canEdit !== undefined ? { canEdit: signInfo.canEdit } : {})}
          />
        )}
        {isRecorder &&
          (published !== null ||
            items.some((i) => i.stage === 'published') ||
            (!unread && (draft !== null || items.some((i) => i.stage === 'draft')))) && <MeetingFollowup meetingId={meetingId} />}
        {/* #4766: with a linked open deal and published minutes, the recorder updates the deal (next step and a note), by hand or from Vy's proposal; nothing is written before Save. */}
        {isRecorder && (published !== null || items.some((i) => i.stage === 'published')) && <MeetingDealUpdate meetingId={meetingId} />}
        {/* B5 (#3169): only a published result can be offered to a customer, and only the lines the recorder ticks; the draft is never read here. */}
        {isRecorder && title !== '' && (published || items.some((i) => i.stage === 'published')) && (
          <MeetingZalo meetingId={meetingId} title={title} summary={published?.summary ?? null} decisions={published?.decisions ?? []} items={items.filter((i) => i.stage === 'published')} />
        )}
        {isRecorder && (published || items.some((i) => i.stage === 'published')) && <MeetingChatPost meetingId={meetingId} />}
        {isRecorder && <TemplatePicker meetingId={meetingId} template={template} copy={minutesTemplate} />}
        {isRecorder && <VySummary key={`vy-${effectiveRedactedEpoch}`} meetingId={meetingId} hasModelDraft={(draft?.tainted ?? false) || items.some((i) => i.stage === 'draft' && i.tainted)} />}
        {isRecorder && (
          <section className="space-y-2">
            <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
              {t('draftTitle')}
              {draft?.tainted && <Badge variant="outline">{t('fromVy')}</Badge>}
            </h3>
            {hasDraft && <p className="text-xs text-muted-foreground">{t('draftExpiry')}</p>}
            <SummaryEditor key={`${template}-${minutesTemplate?.hash ?? ''}-${draft?.id ?? 'new'}`} meetingId={meetingId} summary={draft?.summary ?? ''} decisions={draft?.decisions ?? []} template={template} copy={minutesTemplate} />
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
                <Item key={item.id} item={item} isRecorder={isRecorder} redactedEpoch={effectiveRedactedEpoch} />
              ))}
            </ul>
          </section>
        )}
        {isRecorder && <NewItem meetingId={meetingId} readers={readers} />}
        {isRecorder && hasDraft && (
          <div className="space-y-2 border-t pt-3">
            <RedactionNudge
              count={redactCandidatesQuery.data?.candidates.length ?? 0}
              truncated={redactCandidatesQuery.data?.truncated ?? false}
              onOpen={() => {
                if (redaction) redaction.onOpen();
                else setLocalRedactOpen(true);
              }}
              testId="redaction-prepublish-nudge"
              lastRedacted={redaction ? redaction.lastRedacted : localLastRedacted}
              showDone={redaction ? redaction.showDone : localLastRedacted !== null}
              doneRef={redaction ? redaction.doneRef : localDoneRef}
            />
            {!redaction && (
              <DraftRedactionDialog
                meetingId={meetingId}
                open={localRedactOpen}
                onOpenChange={setLocalRedactOpen}
                enabled={redactEnabled}
                sources={{ meetingTitle: title, draftResult: draft, items }}
                onRedacted={(result) => {
                  setLocalLastRedacted(result);
                  setLocalRedactedEpoch((n) => n + 1);
                }}
                doneRef={localDoneRef}
              />
            )}
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

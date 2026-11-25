// SPDX-License-Identifier: AGPL-3.0-only
// Keyword trackers (#4818, plan docs/plan/meetings.md L22): on a meeting's page a card of the tracked words that came up in it (how often, and the times of the lines, each a button that takes the
// transcript and the player there), and on the meetings page a weekly tool: the hits across the meetings the person reads, and, for an owner or an admin, the list of tracked words with add and
// remove. The counts are worked out by the kernel from the lines the person may read (a reader the published lines), so nothing here reads a line; no AI, nothing stored but the words an owner chose.
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { TRACKER_TERMS_MAX, TRACKER_WEEKS_BACK_MAX } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// A sensitive read that leaves an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
const REFUSALS = ['TRACKER_TERM_TAKEN', 'TRACKER_MAX', 'TRACKER_TERM_NOT_FOUND'] as const;

const refusalOf = (error: unknown): (typeof REFUSALS)[number] | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return REFUSALS.find((r) => r === code) ?? null;
};

const refreshAll = () => queryClient.invalidateQueries({ queryKey: orpc.meetings.tracker.key() });

/** The member's own switch for the alert when a tracked word comes up in the minutes of a new meeting they read (#4873): off by default, theirs alone, no AI. A failed save shows its message and leaves the switch where it was. */
function AlertSwitch() {
  const t = useTranslations('meetings.trackers');
  const state = useQuery({ ...orpc.meetings.tracker.alertGet.queryOptions({ input: {} }), ...READ_ONCE });
  const set = useMutation({
    mutationFn: (on: boolean) => orpc.meetings.tracker.alertSet.call({ on }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: orpc.meetings.tracker.alertGet.key() }),
  });
  if (state.isLoading || state.isError || !state.data) return null;
  return (
    <section className="space-y-1 border-t pt-3">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={state.data.on} disabled={set.isPending} onChange={(e) => set.mutate(e.target.checked)} />
        <span>
          <span className="font-medium">{t('alertLabel')}</span>
          <span className="block text-xs text-muted-foreground">{t('alertHint')}</span>
        </span>
      </label>
      {set.isError && <ErrorText>{errorMessage(set.error)}</ErrorText>}
    </section>
  );
}

/** The card of a meeting's page: the tracked words that came up in it. Absent when no word is tracked, none came up, or the read failed (as after the text retention date). */
export function MeetingTrackerHits({ meetingId, onJump, redactedEpoch = 0 }: { meetingId: string; onJump: (seconds: number) => void; redactedEpoch?: number }) {
  const t = useTranslations('meetings.trackers');
  const query = useQuery({ ...orpc.meetings.tracker.hits.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  // A redaction changes the lines, so the counts are read again.
  useEffect(() => {
    if (redactedEpoch > 0) void queryClient.invalidateQueries({ queryKey: orpc.meetings.tracker.hits.key() });
  }, [redactedEpoch]);
  // So does a new transcript read (a new transcription, a publish): the counts follow the lines the transcript panel shows, with no read of their own on the first load.
  const transcript = useQuery({ ...orpc.meetings.transcript.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  const seen = useRef<number | null>(null);
  useEffect(() => {
    if (seen.current !== null && seen.current !== 0 && seen.current !== transcript.dataUpdatedAt) void queryClient.invalidateQueries({ queryKey: orpc.meetings.tracker.hits.key() });
    seen.current = transcript.dataUpdatedAt;
  }, [transcript.dataUpdatedAt]);
  if (query.error || !query.data || query.data.hits.length === 0) return null;
  return (
    <Card data-testid="meeting-tracker-hits">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">
          {t('title')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {query.data.hits.map((h) => (
            <li key={h.id} className="space-y-1 py-2 text-sm" data-testid="tracker-hit">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{h.term}</span>
                <span className="text-xs text-muted-foreground">{t('times', { count: h.count })}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1 text-xs">
                {h.seconds.map((s) => (
                  <button key={s} type="button" className="rounded border px-1.5 py-0.5 font-mono underline max-md:min-h-11" aria-label={t('jump', { time: clock(s) })} onClick={() => onJump(s)}>
                    {clock(s)}
                  </button>
                ))}
                {h.more && <span className="text-muted-foreground">{t('more')}</span>}
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// The owner's and the admin's list of tracked words, with add and remove.
function TermEditor() {
  const t = useTranslations('meetings.trackers');
  const list = useQuery(orpc.meetings.tracker.list.queryOptions({ input: {} }));
  const [term, setTerm] = useState('');
  const add = useMutation({
    mutationFn: () => orpc.meetings.tracker.add.call({ term }),
    onSuccess: () => {
      setTerm('');
      return refreshAll();
    },
  });
  const remove = useMutation({ mutationFn: (termId: string) => orpc.meetings.tracker.remove.call({ termId }), onSuccess: refreshAll });
  const terms = list.data?.terms ?? [];
  const failure = add.error ?? remove.error;
  const refusal = refusalOf(failure);
  return (
    <section className="space-y-2" aria-labelledby="tracker-words">
      <h3 id="tracker-words" className="text-sm font-medium">
        {t('words.title', { count: terms.length, max: TRACKER_TERMS_MAX })}
      </h3>
      <p className="text-xs text-muted-foreground">{t('words.hint')}</p>
      {terms.length > 0 && (
        <ul className="flex flex-wrap gap-2" data-testid="tracker-words">
          {terms.map((w) => (
            <li key={w.id} className="flex items-center gap-1 rounded-md border px-2 py-1 text-sm">
              <span>{w.term}</span>
              <Button size="xs" variant="ghost" aria-label={t('words.remove', { term: w.term })} loading={remove.isPending && remove.variables === w.id} onClick={() => remove.mutate(w.id)}>
                {t('words.removeShort')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (term.trim() !== '') add.mutate();
        }}
      >
        <Input aria-label={t('words.label')} placeholder={t('words.placeholder')} value={term} maxLength={40} onChange={(e) => setTerm(e.target.value)} className="h-8 w-56" />
        <Button type="submit" size="sm" loading={add.isPending} disabled={term.trim() === '' || terms.length >= TRACKER_TERMS_MAX}>
          {t('words.add')}
        </Button>
      </form>
      {failure ? <ErrorText>{refusal ? t(`errors.${refusal}`) : errorMessage(failure)}</ErrorText> : null}
    </section>
  );
}

/** The weekly tool of the meetings page: the hits across the meetings the person reads, and for an owner or an admin the list of words. */
export function TrackersWeek({ slug }: { slug: string }) {
  const t = useTranslations('meetings.trackers');
  const [weeksBack, setWeeksBack] = useState(0);
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const canEdit = orgQuery.data?.role === 'owner' || orgQuery.data?.role === 'admin';
  const week = useQuery({ ...orpc.meetings.tracker.week.queryOptions({ input: { weeksBack } }), ...READ_ONCE, placeholderData: keepPreviousData });
  const data = week.data;
  return (
    <Card data-testid="trackers-week">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">
          {t('weekTitle')}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t('weekDesc')}</span>
          <NativeSelect aria-label={t('week')} value={String(weeksBack)} onChange={(e) => setWeeksBack(Number(e.target.value))}>
            {Array.from({ length: TRACKER_WEEKS_BACK_MAX + 1 }, (_, back) => (
              <NativeSelectOption key={back} value={String(back)}>
                {back === 0 ? t('thisWeek') : back === 1 ? t('lastWeek') : t('weeksAgo', { count: back })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {week.error ? <ErrorText>{errorMessage(week.error)}</ErrorText> : null}
        {data && (
          <section className="space-y-2" aria-label={t('week')}>
            <p className="text-xs text-muted-foreground" data-testid="trackers-range">
              {t('range', { from: data.weekStart, to: data.weekEnd, meetings: data.meetings })}
            </p>
            {data.tracked === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="trackers-none-tracked">
                {canEdit ? t('noneTrackedOwner') : t('noneTracked')}
              </p>
            ) : data.terms.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="trackers-empty">
                {t('noHits')}
              </p>
            ) : (
              <ul className="divide-y" data-testid="trackers-terms">
                {data.terms.map((w) => (
                  <li key={w.id} className="space-y-1 py-2 text-sm" data-testid="trackers-term">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{w.term}</span>
                      <span className="text-xs text-muted-foreground">{t('times', { count: w.count })}</span>
                    </div>
                    <ul className="space-y-0.5 text-xs">
                      {w.meetings.map((m) => (
                        <li key={m.meetingId}>
                          <Link to="/o/$slug/meetings/$id" params={{ slug, id: m.meetingId }} className="text-link underline">
                            {m.title}
                          </Link>
                          <span className="text-muted-foreground"> {t('inMeeting', { count: m.count })}</span>
                        </li>
                      ))}
                      {w.moreMeetings > 0 && <li className="text-muted-foreground">{t('moreMeetings', { count: w.moreMeetings })}</li>}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
            {data.cut && <p className="text-xs text-muted-foreground">{t('cut')}</p>}
          </section>
        )}
        {canEdit && <TermEditor />}
        <AlertSwitch />
      </CardContent>
    </Card>
  );
}

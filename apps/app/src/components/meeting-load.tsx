// SPDX-License-Identifier: AGPL-3.0-only
// "Thời gian họp" (#4770, plan docs/plan/meetings.md L16), on the meetings page for an owner or an admin: how many meetings and minutes each member spent in a week, and the recurring series that may be worth
// trimming, each with the reason in words. Worked out by code from the meetings the person reads (an owner or an admin has no extra right to read a meeting), so it is "from the meetings you can read"; the people
// in a meeting are the recorder and the readers the recorder added. No meeting text, no AI, nothing stored, and nothing here changes a meeting or a series: a person decides what to trim.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { LOAD_SERIES_MIN_MEETINGS, LOAD_SERIES_WEEKS, LOAD_WEEKS_BACK_MAX, type LoadSeries, type LoadSignal } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { ErrorText } from './ui.tsx';
import { memberLabel } from './meeting-results.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

// A sensitive read that leaves an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;

/** A length of time in words: "45 phút", "2 giờ", "1 giờ 30 phút". */
export function useDuration() {
  const t = useTranslations('meetings.load');
  return (minutes: number): string => {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours === 0) return t('minutes', { minutes: rest });
    return rest === 0 ? t('hours', { hours }) : t('hoursMinutes', { hours, minutes: rest });
  };
}

function SeriesReason({ series, signal }: { series: LoadSeries; signal: LoadSignal }) {
  const t = useTranslations('meetings.load.signals');
  switch (signal) {
    case 'few_people':
      return <>{t('few_people', { solo: series.soloMeetings, meetings: series.meetings })}</>;
    case 'no_minutes':
      return <>{t('no_minutes', { withMinutes: series.withMinutes, meetings: series.meetings })}</>;
    case 'items_piling':
      return <>{t('items_piling', { latest: series.openItems[0] ?? 0, previous: series.openItems[1] ?? 0 })}</>;
  }
}

export function MeetingLoad({ slug }: { slug: string }) {
  const t = useTranslations('meetings.load');
  const duration = useDuration();
  const [weeksBack, setWeeksBack] = useState(0);
  const orgQuery = useQuery(orpc.org.get.queryOptions());
  const role = orgQuery.data?.role;
  const allowed = role === 'owner' || role === 'admin';
  const load = useQuery({ ...orpc.meetings.load.week.queryOptions({ input: { weeksBack } }), ...READ_ONCE, placeholderData: keepPreviousData, enabled: allowed });
  // Only an owner or an admin gets the card (the read refuses anyone else).
  if (!allowed) return null;
  const data = load.data;
  if (load.error && !data) return <ErrorText>{errorMessage(load.error)}</ErrorText>;
  if (!data) return null;
  const members = orgQuery.data?.members ?? [];
  return (
    <Card data-testid="meeting-load">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">
          {t('title')}
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t('description')}</span>
          <NativeSelect aria-label={t('week')} value={String(weeksBack)} onChange={(e) => setWeeksBack(Number(e.target.value))}>
            {Array.from({ length: LOAD_WEEKS_BACK_MAX + 1 }, (_, back) => (
              <NativeSelectOption key={back} value={String(back)}>
                {back === 0 ? t('thisWeek') : back === 1 ? t('lastWeek') : t('weeksAgo', { count: back })}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {load.error && <ErrorText>{errorMessage(load.error)}</ErrorText>}
        <section className="space-y-2" aria-label={t('week')}>
          <p className="text-xs text-muted-foreground" data-testid="load-range">
            {t('range', { from: data.weekStart, to: data.weekEnd })}
          </p>
          {data.members.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="load-empty">
              {t('noMembers')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="load-members">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-1 pr-3 font-medium">
                      {t('member')}
                    </th>
                    <th scope="col" className="py-1 pr-3 text-right font-medium">
                      {t('meetings')}
                    </th>
                    <th scope="col" className="py-1 text-right font-medium">
                      {t('time')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.members.map((m) => (
                    <tr key={m.userId} className="border-t" data-testid="load-member-row">
                      <th scope="row" className="py-1 pr-3 text-left font-normal">
                        {memberLabel(members, m.userId, t('someone'))}
                      </th>
                      <td className="py-1 pr-3 text-right tabular-nums">{m.meetings}</td>
                      <td className="py-1 text-right tabular-nums">{duration(m.minutes)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t font-medium" data-testid="load-total">
                    <th scope="row" className="py-1 pr-3 text-left font-medium">
                      {t('total')}
                    </th>
                    <td className="py-1 pr-3 text-right tabular-nums">{data.meetings}</td>
                    <td className="py-1 text-right tabular-nums">{duration(data.personMinutes)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('basis')}</p>
        </section>
        <section className="space-y-2" aria-labelledby="meeting-load-trim">
          <h3 id="meeting-load-trim" className="text-sm font-medium">
            {t('trim.title')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('trim.hint', { weeks: LOAD_SERIES_WEEKS, min: LOAD_SERIES_MIN_MEETINGS })}</p>
          {data.series.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="load-series-empty">
              {t('trim.none')}
            </p>
          ) : (
            <ul className="space-y-2" data-testid="load-series">
              {data.series.map((s) => (
                <li key={s.seriesId} className="space-y-1 rounded-md border p-2 text-sm" data-testid="load-series-row">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link to="/o/$slug/meetings/$id" params={{ slug, id: s.latestMeetingId }} className="text-link underline">
                      {s.title}
                    </Link>
                    <Badge variant="outline">{t('trim.count', { count: s.meetings, average: duration(s.averageMinutes) })}</Badge>
                  </div>
                  <ul className="list-disc pl-5 text-xs text-muted-foreground">
                    {s.signals.map((signal) => (
                      <li key={signal}>
                        <SeriesReason series={s} signal={signal} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
          {data.seriesCut && <p className="text-xs text-muted-foreground">{t('trim.cut')}</p>}
        </section>
      </CardContent>
    </Card>
  );
}

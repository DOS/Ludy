// SPDX-License-Identifier: AGPL-3.0-only
// Who did the talking (#4765): each speaker's talk time and share, turns and longest monologue, on a meeting's page and as one line under the published summary. Worked out in code
// (lib/talk-time.ts) from the transcript lines the page already reads, so there is no model call, no new request and no new audit row, a reader sees the figures of the lines they may read
// and the figures go when the transcript does. Speaker names are shown as plain text.
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { clock } from './meeting-transcript.tsx';
import { orpc } from '../lib/api.ts';
import { speakerFigures, wholePercents, type SpeakerFigures } from '../lib/talk-time.ts';

// The same query, with the same cache entry, as the transcript panel: a sensitive read that leaves one audit row, so no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;

// How many names the one-line summary lists before it says "and N others".
const SUMMARY_LINE_SPEAKERS = 3;

// The figures of the meeting for the caller, or null while loading, with no transcript, with fewer than two speakers (one person talking has nothing to compare), or when the last read of the
// transcript failed (a refetch that fails keeps the lines of the earlier read, and the transcript panel shows the error instead of them, so the figures go too: a 404 after the text retention date).
// `publishedOnly` keeps the published lines, for the line under the published summary: the recorder's draft is not what a reader sees there.
function useFigures(meetingId: string, publishedOnly = false): SpeakerFigures | null {
  const transcript = useQuery({ ...orpc.meetings.transcript.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  if (transcript.error || !transcript.data) return null;
  const lines = publishedOnly ? transcript.data.segments.filter((s) => s.stage === 'published') : transcript.data.segments;
  const figures = speakerFigures(lines);
  return figures && figures.speakers.length >= 2 ? figures : null;
}

export function MeetingTalkTime({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.talkTime');
  const figures = useFigures(meetingId);
  if (!figures) return null;
  const percents = wholePercents(figures.speakers.map((s) => s.share));
  return (
    <Card data-testid="meeting-talk-time">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">
          {t('title')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('speaker')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('share')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('time')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('turns')}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {t('longest')}
                </th>
              </tr>
            </thead>
            <tbody>
              {figures.speakers.map((s, i) => (
                <tr key={s.speaker} className="border-t" data-testid="talk-time-row">
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {s.speaker}
                  </th>
                  <td className="py-1 pr-3">
                    <div className="flex items-center gap-2">
                      <div className="h-2 w-24 overflow-hidden rounded bg-muted" aria-hidden="true">
                        <div className="h-full bg-primary" style={{ width: `${percents[i] ?? 0}%` }} />
                      </div>
                      <span className="tabular-nums">{percents[i]}%</span>
                    </div>
                  </td>
                  <td className="py-1 pr-3 text-right font-mono text-xs tabular-nums">{clock(s.seconds)}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">{s.turns}</td>
                  <td className="py-1 text-right font-mono text-xs tabular-nums">{clock(s.longestMonologue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

// The one line under the published summary: the biggest shares by name, "and N others" for the rest.
export function TalkTimeLine({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.talkTime');
  const figures = useFigures(meetingId, true);
  if (!figures) return null;
  const percents = wholePercents(figures.speakers.map((s) => s.share));
  const listed = figures.speakers.slice(0, SUMMARY_LINE_SPEAKERS).map((s, i) => `${s.speaker} ${percents[i]}%`);
  const others = figures.speakers.length - listed.length;
  const list = listed.join(', ');
  return (
    <p className="text-xs text-muted-foreground" data-testid="talk-time-line">
      {others > 0 ? t('lineMore', { list, count: others }) : t('line', { list })}
    </p>
  );
}

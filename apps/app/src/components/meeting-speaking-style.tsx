// SPDX-License-Identifier: AGPL-3.0-only
// How each speaker spoke (#4919): speaking pace in words per minute, the share of filler words with the three most used, and the longest stretch without a pause, per speaker label, on a meeting's page.
// Counted by code on the server from the lines the caller may read (meetings.speaking_style.get: the transcript page's reader rule, a reader's figures rest on the published lines and the recorder's on the
// draft), so there is no model call and no AI budget use, nothing is written, and the answer holds numbers and words of a fixed list, never a transcript line. Speaker names are plain text. The figures are
// facts about the transcript, with no score or judgment of a person.
import { useQuery } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'use-intl';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { clock } from './meeting-transcript.tsx';
import { orpc } from '../lib/api.ts';

// A sensitive read that leaves one audit row, so no refetch on focus or remount; the transcript's edits invalidate it.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;

// A share of words as a percentage with one decimal ("3,4%"), in the reader's language.
function percent(share: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(share * 100)}%`;
}

export function MeetingSpeakingStyle({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.speakingStyle');
  const locale = useLocale();
  const query = useQuery({ ...orpc.meetings.speakingStyle.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  // Nothing while loading, when the read failed (a 404 after the text retention date) or when no line has text and a length.
  if (query.error || !query.data || query.data.speakers.length === 0) return null;
  return (
    <Card data-testid="meeting-speaking-style">
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
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('pace')}
                </th>
                <th scope="col" className="py-1 pr-3 text-right font-medium">
                  {t('fillers')}
                </th>
                <th scope="col" className="py-1 pr-3 font-medium">
                  {t('topFillers')}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {t('stretch')}
                </th>
              </tr>
            </thead>
            <tbody>
              {query.data.speakers.map((s) => (
                <tr key={s.speaker} className="border-t" data-testid="speaking-style-row">
                  <th scope="row" className="py-1 pr-3 text-left font-normal">
                    {s.speaker}
                  </th>
                  <td className="py-1 pr-3 text-right tabular-nums">{s.wordsPerMinute === null ? t('paceNone') : s.wordsPerMinute}</td>
                  <td className="py-1 pr-3 text-right tabular-nums">
                    {s.fillerWords} <span className="text-xs text-muted-foreground">({percent(s.fillerShare, locale)})</span>
                  </td>
                  <td className="py-1 pr-3">{s.fillerTop.length === 0 ? t('none') : s.fillerTop.map((f) => `${f.word} ×${f.count}`).join(', ')}</td>
                  <td className="py-1 text-right font-mono text-xs tabular-nums">{clock(s.longestStretchSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">{t('note')}</p>
      </CardContent>
    </Card>
  );
}

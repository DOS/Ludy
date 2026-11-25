// SPDX-License-Identifier: AGPL-3.0-only
// Highlights on a meeting's page (#4819): the list of marks the caller may read, each with the time (a button that takes the transcript and the player there), the lines it covers, who marked it and
// a copy button and, for the caller's own marks (any mark for the recorder), a remove button. The buttons on the transcript's lines are in meeting-line-marks.tsx. A mark holds no text: the lines are the transcript the page already reads (the same query
// and cache entry as the transcript panel), so a redacted line shows redacted and a mark whose lines are gone shows its time only. The list is plain text and works with AI off.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { Highlight } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { clock } from './meeting-transcript.tsx';
import { orpc } from '../lib/api.ts';
import { copyText, linesOf } from '../lib/highlights.ts';
import { MarkError, refreshHighlights, useHighlights } from './meeting-line-marks.tsx';

// The same query, with the same cache entry, as the transcript panel: a sensitive read that leaves one audit row, so no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;
// The lines of a mark shown in the list before "and N more".
const SHOWN_LINES = 3;

function CopyButton({ text }: { text: string }) {
  const t = useTranslations('meetings.highlights');
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        void (async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            setTimeout(() => setDone(false), 2000);
          } catch {
            // The clipboard may be blocked (an insecure page, no permission): the lines stay on the screen to select.
          }
        })();
      }}
    >
      {done ? t('copied') : t('copy')}
    </Button>
  );
}

export function MeetingHighlights({ meetingId, isRecorder, onJump }: { meetingId: string; isRecorder: boolean; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.highlights');
  const list = useHighlights(meetingId);
  const transcript = useQuery({ ...orpc.meetings.transcript.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  const [error, setError] = useState<unknown>(null);
  const remove = useMutation({
    mutationFn: (highlightId: string) => orpc.meetings.highlight.remove.call({ meetingId, highlightId }),
    onSuccess: refreshHighlights,
    onError: setError,
  });
  // Nothing to show with none (or when the list cannot be read, as after the text retention date): no empty card.
  if (list.error || !list.data || list.data.highlights.length === 0) return null;
  // A failed transcript read shows the marks by their time alone, never lines of an earlier read.
  const segments = transcript.error ? [] : (transcript.data?.segments ?? []);
  return (
    <Card data-testid="meeting-highlights">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">
          {t('title')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <MarkError error={error} />
        <ul className="divide-y">
          {list.data.highlights.map((h: Highlight) => {
            const lines = linesOf(h, segments);
            const shown = lines.slice(0, SHOWN_LINES);
            const time = h.endSeconds > h.startSeconds ? `${clock(h.startSeconds)} - ${clock(h.endSeconds)}` : clock(h.startSeconds);
            const who = h.mine ? t('you') : (h.markedBy ?? t('aMember'));
            return (
              <li key={h.id} className="space-y-1 py-2 text-sm" data-testid="highlight">
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <button type="button" className="font-mono underline" aria-label={t('jump', { time })} onClick={() => onJump(h.startSeconds)}>
                    {time}
                  </button>
                  <span>{t('markedBy', { who })}</span>
                </div>
                {shown.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t('noLines')}</p>
                ) : (
                  <div className="space-y-0.5">
                    {shown.map((l) => (
                      <p key={`${l.id}`} className="whitespace-pre-wrap">
                        <span className="font-medium">{l.speakerLabel}: </span>
                        {l.text}
                      </p>
                    ))}
                    {lines.length > shown.length && <p className="text-xs text-muted-foreground">{t('moreLines', { count: lines.length - shown.length })}</p>}
                  </div>
                )}
                <div className="flex gap-2">
                  {lines.length > 0 && <CopyButton text={copyText(lines, clock)} />}
                  {(h.mine || isRecorder) && (
                    <Button size="sm" variant="ghost" loading={remove.isPending && remove.variables === h.id} onClick={() => { setError(null); remove.mutate(h.id); }}>
                      {t('remove')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

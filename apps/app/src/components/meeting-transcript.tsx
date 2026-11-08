// SPDX-License-Identifier: AGPL-3.0-only
// The transcript of a meeting on its page (#2578, M4a). The recorder sees their draft, line by line with the time and the
// speaker, and corrects a line by hand; every other reader of the meeting sees only what was published. Vy writes the draft
// for the recorder alone (the transcription run itself is M4b); without AI there is simply no transcript, and the recording
// and its playback work as before.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { TranscriptSegment } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Textarea } from '@crove/ui/components/textarea';
import { Empty, ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// 3725.4 seconds as 1:02:05; under an hour as 2:05.
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

function Line({ segment, editable }: { segment: TranscriptSegment; editable: boolean }) {
  const t = useTranslations('meetings.transcript');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(segment.text);
  const [speaker, setSpeaker] = useState(segment.speakerLabel);
  const save = useMutation({
    mutationFn: () =>
      orpc.meetings.transcript.correct.call({
        segmentId: segment.id,
        ...(text.trim() !== segment.text ? { text: text.trim() } : {}),
        ...(speaker.trim() !== segment.speakerLabel ? { speakerLabel: speaker.trim() } : {}),
      }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.transcript.key() });
    },
  });
  const unchanged = text.trim() === segment.text && speaker.trim() === segment.speakerLabel;

  return (
    <li className="space-y-1 py-2 text-sm" data-testid="transcript-line">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{clock(segment.startSeconds)}</span>
        {editing ? (
          <Input aria-label={t('speaker')} value={speaker} maxLength={80} onChange={(e) => setSpeaker(e.target.value)} className="h-7 w-44 text-xs" />
        ) : (
          <span className="font-medium text-foreground">{segment.speakerLabel}</span>
        )}
        {segment.corrected && <Badge variant="outline">{t('corrected')}</Badge>}
      </div>
      {editing ? (
        <div className="space-y-2">
          <Textarea aria-label={t('text')} value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} rows={3} />
          {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
          <div className="flex gap-2">
            <Button size="sm" loading={save.isPending} disabled={unchanged || text.trim() === '' || speaker.trim() === ''} onClick={() => save.mutate()}>
              {t('save')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setText(segment.text);
                setSpeaker(segment.speakerLabel);
                setEditing(false);
                save.reset();
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <p className="whitespace-pre-wrap">{segment.text}</p>
          {editable && segment.stage === 'draft' && (
            <Button size="sm" variant="ghost" aria-label={t('editLine', { time: clock(segment.startSeconds) })} onClick={() => setEditing(true)}>
              {t('edit')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

export function MeetingTranscript({ meetingId }: { meetingId: string }) {
  const t = useTranslations('meetings.transcript');
  const query = useQuery(orpc.meetings.transcript.get.queryOptions({ input: { meetingId } }));
  if (query.isPending) return null;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  const transcript = query.data;
  if (!transcript || transcript.segments.length === 0) {
    // Only the recorder is told there is none; to another reader a meeting with nothing shared simply shows no transcript.
    return transcript?.isRecorder ? <Empty title={t('emptyRecorder')} /> : null;
  }
  const draft = transcript.stage === 'draft';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">{draft ? t('draftTitle') : t('title')}</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{draft ? t('draftNote') : t('publishedNote')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {transcript.segments.map((segment) => (
            <Line key={segment.id} segment={segment} editable={transcript.isRecorder} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

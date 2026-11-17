// SPDX-License-Identifier: AGPL-3.0-only
// The transcript of a meeting on its page (#2578, M4a). The recorder sees their draft, line by line with the time and the
// speaker, and corrects a line by hand; every other reader of the meeting sees only what was published. Vy's transcription (M4b)
// is the recorder's own Vy run in the background: the recorder starts it, it lands in the recorder's own Vy result, and the
// recorder's own click copies it here as the draft. Without AI (or with transcription off) there is no button and no
// transcript, and the recording and its playback work as before.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { TranscriptSegment } from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Textarea } from '@crove/ui/components/textarea';
import { Empty, ErrorText } from './ui.tsx';
import { TranscriptTranslationPanel, TranslatedLine, useTranscriptParts } from './meeting-transcript-translation.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// Reading a transcript is a sensitive read that leaves an audit row: no refetch on focus or remount.
const READ_ONCE = { staleTime: 5 * 60_000, refetchOnWindowFocus: false } as const;

// 3725.4 seconds as 1:02:05; under an hour as 2:05.
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

function Line({ segment, editable, focused, translation }: { segment: TranscriptSegment; editable: boolean; focused: boolean; translation?: { part: Parameters<typeof TranslatedLine>[0]['part']; to: string } | undefined }) {
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
  // The line a search hit opened the page at: scrolled to the middle once and marked.
  const ref = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [focused]);

  return (
    <li ref={ref} className={focused ? 'space-y-1 rounded-md bg-warning/15 px-2 py-2 text-sm' : 'space-y-1 py-2 text-sm'} data-testid="transcript-line" {...(focused ? { 'aria-current': 'location' as const, 'data-focused': 'true' } : {})}>
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
      {translation && !editing && <TranslatedLine part={translation.part} to={translation.to} />}
    </li>
  );
}

// A fixed code the kernel sent, in words; null for a code this screen does not know.
function codeText(t: ReturnType<typeof useTranslations>, code: unknown): string | null {
  switch (code) {
    case 'AI_BUDGET_EXHAUSTED':
      return t('vy.codes.AI_BUDGET_EXHAUSTED');
    case 'AI_STOPPED':
      return t('vy.codes.AI_STOPPED');
    case 'TRANSCRIBE_OFF':
      return t('vy.codes.TRANSCRIBE_OFF');
    case 'TRANSCRIBE_NO_BROKER':
      return t('vy.codes.TRANSCRIBE_NO_BROKER');
    case 'TRANSCRIBE_RUNNING':
      return t('vy.codes.TRANSCRIBE_RUNNING');
    case 'TRANSCRIBE_OTHER_RUNNING':
      return t('vy.codes.TRANSCRIBE_OTHER_RUNNING');
    case 'MEETING_NO_AUDIO':
      return t('vy.codes.MEETING_NO_AUDIO');
    case 'TRANSCRIPT_EMPTY':
      return t('vy.codes.TRANSCRIPT_EMPTY');
    case 'TRANSCRIPT_TOO_LONG':
      return t('vy.codes.TRANSCRIPT_TOO_LONG');
    case 'RUN_ENDED':
      return t('vy.codes.RUN_ENDED');
    case 'RUN_CANCELLED':
      return t('vy.codes.RUN_CANCELLED');
    default:
      return null;
  }
}

// A refusal as the recorder reads it: the words for its code, else the generic message.
function refusalText(t: ReturnType<typeof useTranslations>, error: unknown): string {
  return codeText(t, (error as { code?: unknown } | null)?.code) ?? errorMessage(error);
}

// The recorder's own Vy transcribing this meeting: start it, see how it goes, copy the result into the draft. Shown to the recorder only, and only when this
// system transcribes at all (the status says so); nothing is shared with anyone from here.
function VyTranscribe({ meetingId, hasDraft }: { meetingId: string; hasDraft: boolean }) {
  const t = useTranslations('meetings.transcript');
  const status = useQuery({
    ...orpc.meetings.transcript.status.queryOptions({ input: { meetingId } }),
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 5000 : false),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: orpc.meetings.transcript.key() });
  };
  const start = useMutation({ mutationFn: () => orpc.meetings.transcript.start.call({ meetingId }), onSuccess: refresh });
  // Stops the recorder's own run (#3033), so a lost job does not hold their slot until it expires.
  const stop = useMutation({ mutationFn: () => orpc.meetings.transcript.cancel.call({ meetingId }), onSuccess: refresh });
  const copy = useMutation({
    mutationFn: (runId: string) => orpc.meetings.transcript.copyResult.call({ meetingId, runId }),
    onSuccess: refresh,
  });
  const data = status.data;
  if (!data || !data.enabled) return null;
  const running = data.state === 'running';
  return (
    <Card data-testid="vy-transcribe">
      <CardHeader>
        <CardTitle className="text-base font-medium">{t('vy.title')}</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('vy.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {running && (
          <div className="space-y-2">
            <p role="status">{t('vy.running')}</p>
            <p className="text-xs text-muted-foreground">{t('vy.stopHint')}</p>
            <Button size="sm" variant="outline" loading={stop.isPending} onClick={() => {
                start.reset();
                copy.reset();
                stop.mutate();
              }}>
              {t('vy.stop')}
            </Button>
          </div>
        )}
        {copy.isSuccess && <p role="status">{t('vy.copied')}</p>}
        {data.state === 'ready' && data.runId && !copy.isSuccess && (
          <div className="space-y-2">
            <p>{t('vy.ready')}</p>
            {hasDraft && <p className="text-xs text-muted-foreground">{t('vy.copyReplaces')}</p>}
            <Button size="sm" loading={copy.isPending} onClick={() => {
                start.reset();
                stop.reset();
                copy.mutate(data.runId as string);
              }}>
              {t('vy.copy')}
            </Button>
          </div>
        )}
        {data.state === 'failed' && <ErrorText>{`${t('vy.failed')} ${codeText(t, data.errorCode) ?? t('vy.codes.default')}`}</ErrorText>}
        {(start.error || copy.error || stop.error) && <ErrorText>{refusalText(t, start.error ?? copy.error ?? stop.error)}</ErrorText>}
        {!running && (
          <Button size="sm" variant={data.state === 'none' ? 'default' : 'outline'} loading={start.isPending} onClick={() => {
              copy.reset();
              stop.reset();
              start.mutate();
            }}>
            {data.state === 'none' ? t('vy.start') : t('vy.restart')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function MeetingTranscript({ meetingId, focusSegmentId }: { meetingId: string; focusSegmentId?: string }) {
  const t = useTranslations('meetings.transcript');
  const query = useQuery({ ...orpc.meetings.transcript.get.queryOptions({ input: { meetingId } }), ...READ_ONCE });
  // The member's own translated parts beside the lines (E2, #3185); none until they asked.
  const translated = useTranscriptParts(meetingId);
  if (query.isPending) return null;
  if (query.error) return <ErrorText>{errorMessage(query.error)}</ErrorText>;
  const transcript = query.data;
  if (!transcript || transcript.segments.length === 0) {
    // Only the recorder is told there is none; to another reader a meeting with nothing shared simply shows no transcript.
    return transcript?.isRecorder ? (
      <div className="space-y-3">
        <VyTranscribe meetingId={meetingId} hasDraft={false} />
        <Empty title={t('emptyRecorder')} />
      </div>
    ) : null;
  }
  const draft = transcript.stage === 'draft';
  return (
    <div className="space-y-3">
      {transcript.isRecorder && <VyTranscribe meetingId={meetingId} hasDraft={draft} />}
      <TranscriptTranslationPanel meetingId={meetingId} />
      <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium">{draft ? t('draftTitle') : t('title')}</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{draft ? t('draftNote') : t('publishedNote')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {transcript.segments.map((segment) => (
            <Line
              key={segment.id}
              segment={segment}
              editable={transcript.isRecorder}
              focused={segment.id === focusSegmentId}
              translation={translated.parts.has(segment.id) ? { part: translated.parts.get(segment.id) as Parameters<typeof TranslatedLine>[0]['part'], to: translated.to } : undefined}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
    </div>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// "Còn bỏ ngỏ" (#4768): the recorder's own Vy reads the transcript once, on a click, and lists the questions that were asked and that it did not see answered, and the topics where a decision was raised and not taken.
// Each line shows the time of the transcript line it rests on and a click takes the transcript there. The answer lives only in this component's state: nothing is saved, shared or made a task from here. The one write
// is the recorder's own click "Thêm vào ghi chú của tôi", which appends the line to their own notes by the existing notes commands (theirs alone, they go with the meeting). Lines are plain text. Absent when AI is off
// (the status says so), for a person who is not the recorder, and for a meeting with no transcript.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import type { OpenPoint, OpenPointsAnswer } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { appendNoteLine, noteLineFor } from '../lib/series-notes.ts';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// The failures of a run the person is told about in their own words; any other code gets the general line.
const RUN_CODES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'OPEN_POINTS_TIMEOUT', 'OPEN_POINTS_FAILED', 'OPEN_POINTS_TOO_LONG', 'OPEN_POINTS_NO_TRANSCRIPT', 'OPEN_POINTS_BUSY'] as const;
export const openPointsRunCodeOf = (code: string | null): (typeof RUN_CODES)[number] | 'default' => RUN_CODES.find((c) => c === code) ?? 'default';

export function MeetingOpenPoints({ meetingId, isRecorder, hasTranscript, onJump }: { meetingId: string; isRecorder: boolean; hasTranscript: boolean; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.openPoints');
  const status = useQuery({ ...orpc.meetings.openPoints.status.queryOptions({ input: { meetingId } }), enabled: isRecorder && hasTranscript });
  const run = useMutation({ mutationFn: () => orpc.meetings.openPoints.list.call({ meetingId }) });
  // The recorder alone, with a transcript to read, and only when this system lets Vy work: otherwise no card and no word about it.
  if (!isRecorder || !hasTranscript || !status.data?.enabled) return null;
  const answer = run.data;
  return (
    <Card data-testid="meeting-open-points">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">{t('title')}</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button size="sm" variant={answer ? 'outline' : 'default'} loading={run.isPending} disabled={run.isPending} onClick={() => run.mutate()} data-testid="open-points-run">
          {answer ? t('restart') : t('button')}
        </Button>
        {/* One live region that is always in the page, so the changes are announced. */}
        <div role="status" aria-live="polite" className="space-y-2 empty:hidden">
          {run.isPending && <p className="text-xs">{t('running')}</p>}
          {/* What the answer is, said once when it arrives; the lists below it are not read out, the member moves to them (WCAG 4.1.3). */}
          {answer?.state === 'listed' && !run.isPending && <p className="sr-only">{t('found', { questions: answer.questions.length, decisions: answer.decisions.length })}</p>}
          {answer?.state === 'none' && !run.isPending && <p className="sr-only">{t('none')}</p>}
        </div>
        {run.error && <ErrorText>{errorMessage(run.error)}</ErrorText>}
        {answer && !run.isPending && <OpenPointsResult answer={answer} meetingId={meetingId} onJump={onJump} />}
      </CardContent>
    </Card>
  );
}

// What the one answer shows: the two lists, or "no suggestion", or the fixed words of a failure. A click on a time only moves the transcript; the only write is the recorder's own "add to my notes".
export function OpenPointsResult({ answer, meetingId, onJump }: { answer: OpenPointsAnswer; meetingId: string; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.openPoints');
  if (answer.state === 'none') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="open-points-none">
        {t('none')}
      </p>
    );
  }
  if (answer.state === 'failed') {
    return (
      <div data-testid="open-points-failed">
        <ErrorText>{`${t('failed')} ${t(`codes.${openPointsRunCodeOf(answer.errorCode)}`)}`}</ErrorText>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3" data-testid="open-points-answer">
      <Section kind="question" points={answer.questions} meetingId={meetingId} onJump={onJump} />
      <Section kind="decision" points={answer.decisions} meetingId={meetingId} onJump={onJump} />
      {answer.dropped > 0 && <p className="text-xs text-muted-foreground">{t('dropped', { count: String(answer.dropped) })}</p>}
      <p className="text-xs text-muted-foreground">{t('private')}</p>
    </div>
  );
}

function Section({ kind, points, meetingId, onJump }: { kind: 'question' | 'decision'; points: OpenPoint[]; meetingId: string; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.openPoints');
  if (points.length === 0) return null;
  return (
    <section className="space-y-1" data-testid={`open-points-${kind}s`}>
      <h3 className="text-sm font-semibold">{t(`${kind}s`)}</h3>
      <ul className="space-y-1">
        {points.map((point, index) => (
          <Point key={`${point.seconds}-${index}`} kind={kind} point={point} meetingId={meetingId} onJump={onJump} />
        ))}
      </ul>
    </section>
  );
}

function Point({ kind, point, meetingId, onJump }: { kind: 'question' | 'decision'; point: OpenPoint; meetingId: string; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.openPoints');
  const [full, setFull] = useState(false);
  const carry = useMutation({
    // The recorder's own notes are read and saved by the existing commands: the line goes at the end of what they have, once, and nothing is cut.
    mutationFn: async () => {
      const notes = await orpc.meetings.results.notesGet.call({ meetingId });
      const next = appendNoteLine(notes.body, noteLineFor(t(`note.${kind}`, { text: point.text }), clock(point.seconds)));
      if (next === null) {
        setFull(true);
        return null;
      }
      setFull(false);
      return orpc.meetings.results.notesSave.call({ meetingId, body: next });
    },
    onSuccess: (done) => {
      if (done) void queryClient.invalidateQueries({ queryKey: orpc.meetings.results.notesGet.key() });
    },
  });
  const id = `open-point-${kind}-${point.seconds}`;
  return (
    <li className="flex flex-wrap items-baseline gap-2 text-sm" data-testid="open-points-line" data-kind={kind}>
      {/* Plain text: the line is the model's words, never markup. */}
      <span id={id}>{point.text}</span>
      <button
        type="button"
        className="inline-flex min-h-6 items-center font-mono text-xs text-link underline max-md:min-h-11"
        title={t('open', { time: clock(point.seconds) })}
        aria-label={t('open', { time: clock(point.seconds) })}
        onClick={() => onJump(point.seconds)}
        data-testid="open-points-jump"
      >
        {clock(point.seconds)}
      </button>
      {!(carry.isSuccess && carry.data) && (
        <Button size="sm" variant="outline" aria-describedby={id} loading={carry.isPending} onClick={() => carry.mutate()} data-testid="open-points-carry">
          {t('carry')}
        </Button>
      )}
      <span role="status" className="text-xs text-muted-foreground">
        {carry.isSuccess && carry.data ? t('carried') : null}
      </span>
      {full && <ErrorText>{t('notesFull')}</ErrorText>}
      {carry.error && <ErrorText>{errorMessage(carry.error)}</ErrorText>}
    </li>
  );
}

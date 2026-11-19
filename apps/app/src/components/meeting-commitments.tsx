// SPDX-License-Identifier: AGPL-3.0-only
// "Ai cam kết làm gì" (#3954): the recorder's own Vy reads the transcript once, on a click, and lists for each speaker what they said they would do and what they said was decided. Each line shows the time of the
// transcript line it rests on and a click takes the transcript there. The answer lives only in this component's state: nothing is saved, shared or made a task from here. Lines are plain text; the speaker is the
// transcript's own label. Absent when AI is off (the status says so), for a person who is not the recorder, and for a meeting with no transcript.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslations } from 'use-intl';
import type { CommitmentsAnswer } from '@crove/kernel-contract';
import { Button } from '@crove/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@crove/ui/components/card';
import { ErrorText } from './ui.tsx';
import { clock } from './meeting-transcript.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

// The failures of a run the person is told about in their own words; any other code gets the general line.
const RUN_CODES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'COMMITMENTS_TIMEOUT', 'COMMITMENTS_FAILED', 'COMMITMENTS_TOO_LONG', 'COMMITMENTS_NO_TRANSCRIPT', 'COMMITMENTS_BUSY'] as const;
export const commitmentsRunCodeOf = (code: string | null): (typeof RUN_CODES)[number] | 'default' => RUN_CODES.find((c) => c === code) ?? 'default';

export function MeetingCommitments({ meetingId, isRecorder, hasTranscript, onJump }: { meetingId: string; isRecorder: boolean; hasTranscript: boolean; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.commitments');
  const status = useQuery({ ...orpc.meetings.commitments.status.queryOptions({ input: { meetingId } }), enabled: isRecorder && hasTranscript });
  const run = useMutation({ mutationFn: () => orpc.meetings.commitments.list.call({ meetingId }) });
  // The recorder alone, with a transcript to read, and only when this system lets Vy work: otherwise no card and no word about it.
  if (!isRecorder || !hasTranscript || !status.data?.enabled) return null;
  const answer = run.data;
  return (
    <Card data-testid="meeting-commitments">
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">{t('title')}</CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button size="sm" variant={answer ? 'outline' : 'default'} loading={run.isPending} disabled={run.isPending} onClick={() => run.mutate()} data-testid="commitments-run">
          {answer ? t('restart') : t('button')}
        </Button>
        {/* One live region that is always in the page, so the changes are announced. */}
        <div role="status" aria-live="polite" className="space-y-2 empty:hidden">
          {run.isPending && <p className="text-xs">{t('running')}</p>}
        </div>
        {run.error && <ErrorText>{errorMessage(run.error)}</ErrorText>}
        {answer && !run.isPending && <CommitmentsResult answer={answer} onJump={onJump} />}
      </CardContent>
    </Card>
  );
}

// What the one answer shows: the lines grouped by speaker, or "no suggestion", or the fixed words of a failure. Nothing here writes: a click on a time only moves the transcript.
export function CommitmentsResult({ answer, onJump }: { answer: CommitmentsAnswer; onJump: (seconds: number) => void }) {
  const t = useTranslations('meetings.commitments');
  if (answer.state === 'none') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="commitments-none">
        {t('none')}
      </p>
    );
  }
  if (answer.state === 'failed') {
    return (
      <div data-testid="commitments-failed">
        <ErrorText>{`${t('failed')} ${t(`codes.${commitmentsRunCodeOf(answer.errorCode)}`)}`}</ErrorText>
      </div>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-3" data-testid="commitments-answer">
      {answer.speakers.map((speaker) => (
        <section key={speaker.label} className="space-y-1" data-testid="commitments-speaker">
          {/* Plain text: the label is the transcript's own, the lines are the model's words, never markup. */}
          <h3 className="text-sm font-semibold">{speaker.label}</h3>
          <ul className="space-y-1">
            {speaker.lines.map((line, index) => (
              <li key={`${line.seconds}-${index}`} className="flex flex-wrap items-baseline gap-2 text-sm" data-testid="commitments-line" data-kind={line.kind}>
                <span className="text-xs font-medium text-muted-foreground">{t(line.kind)}</span>
                <span>{line.text}</span>
                <button
                  type="button"
                  className="font-mono text-xs text-link underline"
                  title={t('open', { time: clock(line.seconds) })}
                  onClick={() => onJump(line.seconds)}
                  data-testid="commitments-jump"
                >
                  {clock(line.seconds)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {answer.dropped > 0 && <p className="text-xs text-muted-foreground">{t('dropped', { count: String(answer.dropped) })}</p>}
      <p className="text-xs text-muted-foreground">{t('private')}</p>
    </div>
  );
}

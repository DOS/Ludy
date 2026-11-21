// SPDX-License-Identifier: AGPL-3.0-only
// "Gợi ý tên" (#3947): the recorder's own Vy reads the transcript once, on a click, and offers up to three titles for the meeting. The candidates live only in this component's state, nothing is stored;
// each is plain text, and nothing changes until the recorder picks one (the rename command, audited) or none. Absent when AI is off (the status says so) or when the person is not the recorder.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { TitleAnswer } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

// The failures of a run the person is told about in their own words; any other code gets the general line.
const RUN_CODES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'TITLE_TIMEOUT', 'TITLE_FAILED', 'TITLE_TOO_LONG', 'TITLE_NO_TRANSCRIPT', 'TITLE_BUSY'] as const;
export const titleRunCodeOf = (code: string | null): (typeof RUN_CODES)[number] | 'default' => RUN_CODES.find((c) => c === code) ?? 'default';

export function MeetingTitleSuggest({ meetingId, isRecorder, hasTranscript }: { meetingId: string; isRecorder: boolean; hasTranscript: boolean }) {
  const t = useTranslations('meetings.titleSuggest');
  const status = useQuery({ ...orpc.meetings.title.status.queryOptions({ input: { meetingId } }), enabled: isRecorder && hasTranscript });
  const [dismissed, setDismissed] = useState(false);
  const suggest = useMutation({
    mutationFn: () => orpc.meetings.title.suggest.call({ meetingId }),
    onMutate: () => setDismissed(false),
  });
  const rename = useMutation({
    mutationFn: (title: string) => orpc.meetings.rename.call({ meetingId, title }),
    onSuccess: () => {
      suggest.reset();
      void queryClient.invalidateQueries({ queryKey: orpc.meetings.key() });
    },
  });
  const answer = dismissed ? undefined : suggest.data;
  // A pick or "none of these" removes the list and the button that held the focus: it goes back to the button that asked (WCAG 2.4.3).
  const runRef = useRef<HTMLButtonElement>(null);
  const hadAnswer = useRef(false);
  const busy = suggest.isPending || rename.isPending;
  useEffect(() => {
    if (answer) hadAnswer.current = true;
    // Only once the button can take the focus: a disabled button ignores it, and the chance would be spent.
    else if (hadAnswer.current && !busy) {
      hadAnswer.current = false;
      runRef.current?.focus();
    }
  }, [answer, busy]);
  // The recorder alone, with a transcript to read, and only when this system lets Vy work: otherwise no button and no word about it.
  if (!isRecorder || !hasTranscript || !status.data?.enabled) return null;
  return (
    <div className="mb-4 space-y-2" data-testid="title-suggest">
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={runRef} size="sm" variant="outline" loading={suggest.isPending} disabled={busy} onClick={() => suggest.mutate()} data-testid="title-suggest-run">
          {t('button')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('note')}</span>
      </div>
      {/* One live region that is always in the page, so the changes are announced. */}
      <div role="status" aria-live="polite" className="space-y-2 empty:hidden">
        {suggest.isPending && <p className="text-xs">{t('running')}</p>}
        {rename.isSuccess && !answer && <p className="text-xs" data-testid="title-renamed">{t('renamed')}</p>}
        {/* What the answer is, said once when it arrives; the list below it is not read out, the member moves to it (WCAG 4.1.3). */}
        {answer?.state === 'suggested' && <p className="sr-only">{t('found', { count: answer.titles.length })}</p>}
        {answer?.state === 'none' && <p className="sr-only">{t('none')}</p>}
      </div>
      {answer && <TitleResult answer={answer} picking={rename.isPending ? rename.variables : null} onPick={(title) => rename.mutate(title)} onDismiss={() => setDismissed(true)} />}
      {suggest.error && <ErrorText>{errorMessage(suggest.error)}</ErrorText>}
      {rename.error && <ErrorText>{errorMessage(rename.error)}</ErrorText>}
    </div>
  );
}

// What the one answer shows: the candidates as plain text with a pick each and a way to pick none, or "no suggestion", or the fixed words of a failure. Nothing here writes: a pick calls `onPick`.
export function TitleResult({ answer, picking, onPick, onDismiss }: { answer: TitleAnswer; picking: string | null; onPick: (title: string) => void; onDismiss: () => void }) {
  const t = useTranslations('meetings.titleSuggest');
  if (answer.state === 'none') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="title-none">
        {t('none')}
      </p>
    );
  }
  if (answer.state === 'failed') {
    return (
      <div data-testid="title-failed">
        <ErrorText>{`${t('failed')} ${t(`codes.${titleRunCodeOf(answer.errorCode)}`)}`}</ErrorText>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3" data-testid="title-candidates">
      <p className="text-sm font-semibold">{t('pickTitle')}</p>
      <ul className="space-y-2">
        {answer.titles.map((title, index) => (
          <li key={title} className="flex flex-wrap items-center gap-2" data-testid="title-candidate">
            {/* Plain text: a candidate is the model's words, never markup. */}
            <span id={`title-candidate-${index}`} className="text-sm">{title}</span>
            {/* The same words on every row: the candidate is each button's description, so a screen reader says which title it takes (WCAG 2.4.6). */}
            <Button size="sm" aria-describedby={`title-candidate-${index}`} loading={picking === title} disabled={picking !== null} onClick={() => onPick(title)} data-testid="title-pick">
              {t('use')}
            </Button>
          </li>
        ))}
      </ul>
      {answer.dropped > 0 && <p className="text-xs text-muted-foreground">{t('dropped', { count: String(answer.dropped) })}</p>}
      <Button size="sm" variant="ghost" disabled={picking !== null} onClick={onDismiss} data-testid="title-dismiss">
        {t('dismiss')}
      </Button>
    </div>
  );
}

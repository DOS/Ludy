// SPDX-License-Identifier: AGPL-3.0-only
// "Gợi ý nhãn" (#5010): the recorder's own Vy reads the meeting's title and the labels the recorder already uses (no transcript), on a click, and offers up to three labels. The suggestions live only in this component's
// state, nothing is stored; each is a chip of plain text (a React text node, never markup and never a link), and nothing changes until the recorder clicks one (the existing label add command) or none. Absent when AI
// is off (the status says so), when the person is not the recorder, and when the meeting has five labels already.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslations } from 'use-intl';
import { MEETING_LABELS_MAX, type LabelSuggestAnswer } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { refreshLabels } from './meeting-labels.tsx';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

// The failures of a run the person is told about in their own words; any other code gets the general line.
const RUN_CODES = ['AI_BUDGET_EXHAUSTED', 'AI_STOPPED', 'LABEL_SUGGEST_TIMEOUT', 'LABEL_SUGGEST_FAILED', 'LABEL_SUGGEST_BUSY'] as const;
const runCodeOf = (code: string | null): (typeof RUN_CODES)[number] | 'default' => RUN_CODES.find((c) => c === code) ?? 'default';

/** The recorder's click on a suggestion: the existing label add command (the only thing that writes), then the labels of the meeting and the meetings list are read again. */
export async function addSuggestedLabel(meetingId: string, label: string): Promise<void> {
  await orpc.meetings.label.add.call({ meetingId, label });
  await refreshLabels();
}

export function MeetingLabelSuggest({ meetingId, isRecorder }: { meetingId: string; isRecorder: boolean }) {
  const t = useTranslations('meetings.labelSuggest');
  const status = useQuery({ ...orpc.meetings.label.suggestStatus.queryOptions({ input: { meetingId } }), enabled: isRecorder });
  // The same read as the labels panel's, so one request serves both and an add refreshes the count here.
  const labels = useQuery({ ...orpc.meetings.label.list.queryOptions({ input: { meetingId } }), enabled: isRecorder });
  const [dismissed, setDismissed] = useState(false);
  // The suggestions the recorder already took in this answer: they leave the chips, the others stay for the next click.
  const [taken, setTaken] = useState<readonly string[]>([]);
  const suggest = useMutation({
    mutationFn: () => orpc.meetings.label.suggest.call({ meetingId }),
    onMutate: () => {
      setDismissed(false);
      setTaken([]);
      add.reset();
    },
  });
  const add = useMutation({
    mutationFn: (label: string) => addSuggestedLabel(meetingId, label),
    onSuccess: (_done, label) => setTaken((now) => [...now, label]),
  });
  const answer = dismissed ? undefined : suggest.data;
  const shown = answer?.state === 'suggested' ? answer.labels.filter((l) => !taken.includes(l)) : [];
  // A pick or "none of these" removes the chip or the list that held the focus (WCAG 2.4.3): it goes to the control that is still there, the button that asked once the list is gone.
  const runRef = useRef<HTMLButtonElement>(null);
  const dismissRef = useRef<HTMLButtonElement>(null);
  const hadChips = useRef(0);
  const busy = suggest.isPending || add.isPending;
  useEffect(() => {
    const had = hadChips.current;
    hadChips.current = shown.length;
    if (busy || shown.length >= had) return;
    if (shown.length > 0) dismissRef.current?.focus();
    else runRef.current?.focus();
  }, [shown.length, busy]);
  // The recorder alone, only when this system lets Vy work and the meeting has room for a label: otherwise no button and no word about it.
  if (!isRecorder || !status.data?.enabled || !labels.data || labels.data.labels.length >= MEETING_LABELS_MAX) return null;
  return (
    <div className="space-y-2" data-testid="label-suggest">
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={runRef} type="button" size="sm" variant="outline" loading={suggest.isPending} disabled={busy} onClick={() => suggest.mutate()} data-testid="label-suggest-run">
          {t('button')}
        </Button>
        <span className="text-xs text-muted-foreground">{t('note')}</span>
      </div>
      {/* One live region that is always in the page, so the changes are announced. */}
      <div role="status" aria-live="polite" className="space-y-2 empty:hidden">
        {suggest.isPending && <p className="text-xs">{t('running')}</p>}
        {add.isSuccess && answer && <p className="text-xs" data-testid="label-suggest-added">{t('added')}</p>}
        {/* What the answer is, said once when it arrives; the chips below are not read out, the member moves to them (WCAG 4.1.3). */}
        {answer?.state === 'suggested' && <p className="sr-only">{t('found', { count: answer.labels.length })}</p>}
      </div>
      {answer && <LabelSuggestResult answer={answer} shown={shown} picking={add.isPending ? add.variables : null} onPick={(label) => add.mutate(label)} onDismiss={() => setDismissed(true)} dismissRef={dismissRef} />}
      {suggest.error && <ErrorText>{errorMessage(suggest.error)}</ErrorText>}
      {add.error && <ErrorText>{errorMessage(add.error)}</ErrorText>}
    </div>
  );
}

// What the one answer shows: the suggestions as chips of plain text, one real button each that takes it, and a way to take none; or "no suggestion", or the fixed words of a failure. Nothing here writes: a click calls `onPick`.
export function LabelSuggestResult({
  answer,
  shown,
  picking,
  onPick,
  onDismiss,
  dismissRef,
}: {
  answer: LabelSuggestAnswer;
  shown: readonly string[];
  picking: string | null;
  onPick: (label: string) => void;
  onDismiss: () => void;
  dismissRef?: React.Ref<HTMLButtonElement>;
}) {
  const t = useTranslations('meetings.labelSuggest');
  if (answer.state === 'none') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="label-suggest-none">
        {t('none')}
      </p>
    );
  }
  if (answer.state === 'failed') {
    return (
      <div data-testid="label-suggest-failed">
        <ErrorText>{`${t('failed')} ${t(`codes.${runCodeOf(answer.errorCode)}`)}`}</ErrorText>
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3" data-testid="label-suggest-chips">
      <p className="text-sm font-semibold">{t('pickLabel')}</p>
      {shown.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t('pickLabel')}>
          {labelChips(shown, picking, onPick, (label) => t('add', { label }))}
        </ul>
      )}
      {answer.dropped > 0 && <p className="text-xs text-muted-foreground">{t('dropped', { count: String(answer.dropped) })}</p>}
      <Button ref={dismissRef} type="button" size="sm" variant="ghost" className="min-h-11" disabled={picking !== null} onClick={onDismiss} data-testid="label-suggest-dismiss">
        {t('dismiss')}
      </Button>
    </div>
  );
}

// The chips: one list item and one real button each, a text child and never markup (the model's words are tainted). The button's name says what the click does and its text is the label; it is at least 44 px
// high and wide at every width, so a finger lands on it. A plain function, not a component, so a test can read the elements and call their handlers.
export function labelChips(shown: readonly string[], picking: string | null, onPick: (label: string) => void, nameOf: (label: string) => string): ReactElement[] {
  return shown.map((label) => (
    <li key={label}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-11 min-w-11 rounded-full"
        aria-label={nameOf(label)}
        loading={picking === label}
        disabled={picking !== null}
        onClick={() => onPick(label)}
        data-testid="label-suggest-pick"
      >
        {label}
      </Button>
    </li>
  ));
}

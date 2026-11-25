// SPDX-License-Identifier: AGPL-3.0-only
// Update the deal a meeting is linked to (#4766): the recorder of a meeting with published minutes and an open linked deal asks their own Vy for the deal's next step and a short note, reads and
// edits them, and saves. Nothing is written until "Lưu vào cơ hội": the text on screen is what is saved (a task for the next step, a line on the contact's timeline for the note). It works
// with Vy off: the recorder types the same two fields. The day of the next step is only ever one the meeting wrote for an action item, shown, never typed.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { DEAL_UPDATE_NOTE_MAX, DEAL_UPDATE_STEP_MAX, type DealUpdateAnswer, type DealUpdateConfirmed, type DealUpdateStatus } from '@ludy/kernel-contract';
import { Button } from '@ludy/ui/components/button';
import { Checkbox } from '@ludy/ui/components/checkbox';
import { Input } from '@ludy/ui/components/input';
import { Textarea } from '@ludy/ui/components/textarea';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc } from '../lib/api.ts';

const STATE = { used: 'state.used', none: 'state.none', off: 'state.off', busy: 'state.busy', budget: 'state.budget', failed: 'state.failed' } as const;
const REASON = { off: 'state.off', forbidden: 'forbidden', paused: 'state.budget', budget: 'state.budget' } as const;

// The status is read fresh each time the card mounts: the minutes key must be the minutes' now.
const FRESH = { staleTime: 0, gcTime: 0, refetchOnMount: 'always', refetchOnWindowFocus: false } as const;

function Label({ htmlFor, children }: { htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
      {children}
    </label>
  );
}

export function MeetingDealUpdate({ meetingId }: { meetingId: string }) {
  const status = useQuery({ ...orpc.meetings.dealUpdate.status.queryOptions({ input: { meetingId } }), ...FRESH });
  if (!status.data || !status.data.available || !status.data.deal || status.data.minutesKey === null) return null;
  return <DealUpdateCard meetingId={meetingId} status={status.data} onStale={() => void status.refetch()} />;
}

function DealUpdateCard({ meetingId, status, onStale }: { meetingId: string; status: DealUpdateStatus; onStale: () => void }) {
  const t = useTranslations('meetings.dealUpdate');
  const locale = useLocale();
  const deal = status.deal as NonNullable<DealUpdateStatus['deal']>;
  const [step, setStep] = useState('');
  const [note, setNote] = useState('');
  const [dueOn, setDueOn] = useState<string | null>(null);
  // The minutes the text on screen answers: the card's own (as the status reads them now) until Vy proposes, then the proposal's.
  const [proposalKey, setProposalKey] = useState<string | null>(null);
  const minutesKey = proposalKey ?? (status.minutesKey as string);
  const [fromVy, setFromVy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [state, setState] = useState<DealUpdateAnswer['ai'] | null>(null);
  const [done, setDone] = useState<DealUpdateConfirmed | null>(null);
  // One key per version of the form: a double click or a retry of the same save is the same request, and any edit is a new one.
  const key = useRef<string>(crypto.randomUUID());
  const touch = () => {
    key.current = crypto.randomUUID();
    setDone(null);
  };

  const propose = useMutation({
    mutationFn: () => orpc.meetings.dealUpdate.propose.call({ meetingId }),
    onSuccess: (answer: DealUpdateAnswer) => {
      setState(answer.ai);
      if (answer.ai !== 'used' || answer.minutesKey === null) return;
      setStep(answer.nextStep?.text ?? '');
      setDueOn(answer.nextStep?.dueOn ?? null);
      setNote(answer.note ?? '');
      setProposalKey(answer.minutesKey);
      setFromVy(true);
      setReviewed(false);
      touch();
    },
  });

  const save = useMutation({
    mutationFn: () =>
      orpc.meetings.dealUpdate.confirm.call({
        meetingId,
        dealId: deal.id,
        minutesKey,
        nextStep: step.trim() === '' ? null : { text: step.trim(), dueOn },
        note: note.trim() === '' ? null : note.trim(),
        idempotencyKey: key.current,
      }),
    onError: (error: Error) => {
      // The minutes changed since the text on screen was made: read the status again and drop the proposal's key, so a typed update can be saved against the new minutes.
      if ((error as { code?: string } | null)?.code === 'STALE_DEAL_UPDATE') {
        setProposalKey(null);
        setFromVy(false);
        setReviewed(false);
        setDueOn(null);
        onStale();
      }
    },
    onSuccess: (result: DealUpdateConfirmed) => {
      setDone(result);
      setStep('');
      setNote('');
      setDueOn(null);
      setFromVy(false);
      setReviewed(false);
      setProposalKey(null);
      setState(null);
      key.current = crypto.randomUUID();
    },
  });

  const empty = step.trim() === '' && note.trim() === '';
  const blocked = empty || (fromVy && !reviewed);
  const reasonKey = status.reason === null ? null : (REASON as Record<string, string>)[status.reason];
  return (
    <section className="space-y-3 rounded-lg border p-3" data-testid="meeting-deal-update" aria-label={t('title')}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{t('title')}</h3>
        <p className="text-xs text-muted-foreground">{t('desc', { deal: deal.title, stage: deal.stage })}</p>
      </div>
      {status.enabled ? (
        <Button variant="outline" size="sm" loading={propose.isPending} onClick={() => propose.mutate()} data-testid="deal-update-ask">
          {propose.isPending ? t('asking') : t('ask')}
        </Button>
      ) : (
        reasonKey && (
          <p className="text-xs text-muted-foreground" data-testid="deal-update-reason">
            {t(reasonKey as 'forbidden')}
          </p>
        )
      )}
      <p className="text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="deal-update-state">
        {state === null ? '' : propose.data?.errorCode === 'DEAL_UPDATE_TOO_LONG' ? t('tooLong') : t(STATE[state])}
        {done !== null
          ? [t('saved'), done.taskId !== null ? t('taskSaved') : null, done.noteSaved ? t('noteSaved') : null, done.remindersClosed > 0 ? t('remindersClosed') : null].filter(Boolean).join(' ')
          : ''}
      </p>
      {propose.error && <ErrorText>{errorMessage(propose.error)}</ErrorText>}
      <div className="space-y-1">
        <Label htmlFor={`deal-update-step-${meetingId}`}>{t('step')}</Label>
        <Input
          id={`deal-update-step-${meetingId}`}
          value={step}
          maxLength={DEAL_UPDATE_STEP_MAX}
          placeholder={t('stepHint')}
          onChange={(e) => {
            setStep(e.target.value);
            // The day belongs to the action item Vy pointed at: a rewritten step no longer has it.
            setDueOn(null);
            touch();
          }}
        />
        {dueOn !== null && step.trim() !== '' && <p className="text-xs text-muted-foreground">{t('due', { date: new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${dueOn}T00:00:00Z`)) })}</p>}
      </div>
      <div className="space-y-1">
        <Label htmlFor={`deal-update-note-${meetingId}`}>{t('note')}</Label>
        <Textarea
          id={`deal-update-note-${meetingId}`}
          rows={3}
          value={note}
          maxLength={DEAL_UPDATE_NOTE_MAX}
          placeholder={t('noteHint')}
          onChange={(e) => {
            setNote(e.target.value);
            touch();
          }}
        />
      </div>
      {fromVy && (
        <label className="flex cursor-pointer items-center gap-2 text-xs max-md:min-h-11" data-testid="deal-update-read">
          <Checkbox checked={reviewed} onCheckedChange={(on) => setReviewed(on === true)} />
          <span>{t('read')}</span>
        </label>
      )}
      {save.error && <ErrorText>{errorMessage(save.error)}</ErrorText>}
      {blocked && (
        <p id={`deal-update-why-${meetingId}`} className="text-xs text-muted-foreground" data-testid="deal-update-why">
          {empty ? t('needText') : t('needRead')}
        </p>
      )}
      <Button size="sm" loading={save.isPending} disabled={blocked} aria-describedby={blocked ? `deal-update-why-${meetingId}` : undefined} onClick={() => save.mutate()} data-testid="deal-update-save">
        {t('save')}
      </Button>
    </section>
  );
}

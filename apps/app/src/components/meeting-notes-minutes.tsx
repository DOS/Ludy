// SPDX-License-Identifier: AGPL-3.0-only
// Drafts structured meeting minutes (summary, cited decisions, cited action items) from the recorder's typed notes when a meeting has no audio recording (#5129, L32).
// Never auto-applies or auto-publishes; applying requires the recorder's explicit click on "Áp dụng vào bản nháp", and publishing stays a separate click.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  templateSections,
  type MeetingSummaryTemplate,
  type MinutesTemplateCopy,
  type NotesMinutesAnswer,
  type NotesMinutesStatus,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@ludy/ui/components/card';
import { ErrorText } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';

const NOTES_MINUTES_RUN_CODES = [
  'NOTES_MINUTES_UNPARSABLE',
  'NOTES_MINUTES_TIMEOUT',
  'NOTES_MINUTES_FAILED',
  'NOTES_MINUTES_OFF',
  'NOTES_MINUTES_BUSY',
  'NOTES_MINUTES_HAS_TRANSCRIPT',
  'NOTES_MINUTES_NO_NOTES',
  'NOTES_MINUTES_REDACTED',
  'AI_BUDGET_EXHAUSTED',
  'AI_STOPPED',
  'VY_NOT_ALLOWED',
  'VY_RUN_BUSY',
] as const;

export const notesMinutesRunCodeOf = (code: string | null): (typeof NOTES_MINUTES_RUN_CODES)[number] | 'default' =>
  NOTES_MINUTES_RUN_CODES.find((c) => c === code) ?? 'default';

export function buildApplySummaryPayload(
  meetingId: string,
  answer: NotesMinutesAnswer,
  template: MeetingSummaryTemplate,
  minutesTemplate: MinutesTemplateCopy | null,
) {
  const decisionList = answer.decisions.map((d) => d.text);
  const summaryText = answer.summary.trim() || decisionList[0] || '';
  if (summaryText === '') return null;
  const defs = templateSections(template, minutesTemplate?.sections ?? null);
  if (defs.length === 0) {
    return { meetingId, summary: summaryText, decisions: decisionList };
  }
  return {
    meetingId,
    sections: defs.map((def, idx) => ({ key: def.key, text: idx === 0 ? summaryText : '' })),
    decisions: decisionList,
  };
}

export function NotesMinutesBody({
  meetingId,
  status,
  answer,
  running,
  writeError,
  applying,
  applied,
  applyError,
  onRun,
  onApply,
}: {
  meetingId: string;
  status: NotesMinutesStatus;
  answer: NotesMinutesAnswer | undefined;
  running: boolean;
  writeError: unknown;
  applying: boolean;
  applied: boolean;
  applyError: unknown;
  onRun: () => void;
  onApply: (draft: NotesMinutesAnswer) => void;
}) {
  const t = useTranslations('meetings.notesMinutes');
  const estimate = status.estimate;
  const totalTokens = estimate ? estimate.inputTokens + estimate.outputTokens : 0;
  const estimateCost = estimate?.cost ?? null;

  const blockedMessage =
    status.reason === 'no_notes'
      ? t('blockedNoNotes')
      : status.reason === 'redacted'
        ? t('blockedRedacted')
        : status.reason === 'forbidden'
          ? t('blockedForbidden')
          : status.reason === 'paused'
            ? t('blockedPaused')
            : status.reason === 'budget'
              ? t('blockedBudget')
              : null;

  return (
    <Card data-testid="meeting-notes-minutes" data-meeting-id={meetingId}>
      <CardHeader>
        <CardTitle role="heading" aria-level={2} className="text-base font-medium">
          {t('title')}
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">{t('hint')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {blockedMessage !== null && <p className="text-sm text-muted-foreground">{blockedMessage}</p>}

        {status.available && (
          <div className="space-y-2">
            <Button type="button" variant="outline" className="min-h-11" loading={running} disabled={running} onClick={onRun}>
              {answer ? t('restart') : t('button')}
            </Button>
            {totalTokens > 0 && (
              <p className="text-xs text-muted-foreground">
                {estimateCost !== null
                  ? t('estimateCost', { tokens: String(totalTokens), cost: String(estimateCost) })
                  : t('estimateTokens', { tokens: String(totalTokens) })}
              </p>
            )}
          </div>
        )}

        <div role="status" aria-live="polite" className="space-y-1 text-sm">
          {running && <p className="text-muted-foreground">{t('running')}</p>}
          {applying && <p className="text-muted-foreground">{t('applying')}</p>}
          {applied && <p className="text-foreground">{t('applied')}</p>}
        </div>

        {Boolean(writeError) && <ErrorText>{errorMessage(writeError)}</ErrorText>}
        {Boolean(applyError) && <ErrorText>{errorMessage(applyError)}</ErrorText>}

        {answer?.state === 'failed' && (
          <ErrorText>{`${t('failed')} ${t(`codes.${notesMinutesRunCodeOf(answer.errorCode)}`)}`}</ErrorText>
        )}

        {answer?.state === 'none' && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
            {answer.dropped > 0 && (
              <p className="text-xs text-muted-foreground">{t('dropped', { count: answer.dropped })}</p>
            )}
          </div>
        )}

        {answer?.state === 'drafted' && (
          <div className="space-y-3 rounded-lg border p-3" data-testid="notes-minutes-preview">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{t('fromVy')}</Badge>
              <span className="text-xs text-muted-foreground">{t('taintedNote')}</span>
            </div>

            {answer.summary !== '' && (
              <div className="space-y-1">
                <h3 className="text-xs font-medium text-muted-foreground">{t('summaryTitle')}</h3>
                <p className="text-sm">{answer.summary}</p>
              </div>
            )}

            {answer.decisions.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">{t('decisionsTitle')}</h3>
                <ul className="space-y-1.5 text-sm">
                  {answer.decisions.map((decision, idx) => (
                    <li key={`${decision.noteLine}-${idx}`} className="flex flex-wrap items-baseline gap-2">
                      <span>{decision.text}</span>
                      <Badge variant="secondary">{t('citeLine', { line: String(decision.noteLine) })}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {answer.items.length > 0 && (
              <div className="space-y-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">{t('itemsTitle')}</h3>
                <ul className="space-y-1.5 text-sm">
                  {answer.items.map((item, idx) => (
                    <li key={`${item.noteLine}-${idx}`} className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{item.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {[item.who || t('noOwner'), item.when].filter(Boolean).join(' · ')}
                      </span>
                      <Badge variant="secondary">{t('citeLine', { line: String(item.noteLine) })}</Badge>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {answer.dropped > 0 && (
              <p className="text-xs text-muted-foreground">{t('dropped', { count: answer.dropped })}</p>
            )}

            <Button
              type="button"
              className="min-h-11"
              loading={applying}
              disabled={applying || applied}
              onClick={() => onApply(answer)}
            >
              {t('applyButton')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MeetingNotesMinutes({
  meetingId,
  template,
  minutesTemplate = null,
}: {
  meetingId: string;
  template: MeetingSummaryTemplate;
  minutesTemplate?: MinutesTemplateCopy | null;
}) {
  const [applied, setApplied] = useState(false);
  const status = useQuery(orpc.meetings.notesMinutes.status.queryOptions({ input: { meetingId } }));
  const write = useMutation({
    mutationFn: () => orpc.meetings.notesMinutes.write.call({ meetingId }),
    onMutate: () => setApplied(false),
  });
  const writeResetRef = useRef(write.reset);
  writeResetRef.current = write.reset;
  const isUnavailable = status.data !== undefined && !status.data.available;
  useEffect(() => {
    if (isUnavailable) {
      writeResetRef.current();
      setApplied(false);
    }
  }, [isUnavailable]);
  const apply = useMutation({
    mutationFn: async (draft: NotesMinutesAnswer) => {
      try {
        const summaryPayload = buildApplySummaryPayload(meetingId, draft, template, minutesTemplate);
        if (summaryPayload !== null) {
          await orpc.meetings.results.saveSummary.call(summaryPayload);
        }
        for (const item of draft.items) {
          await orpc.meetings.actionItems.create.call({
            meetingId,
            title: item.title,
            who: item.who,
            whoUserId: null,
            when: item.when,
            whenDate: null,
            transcriptSeconds: null,
          });
        }
      } finally {
        await queryClient.invalidateQueries({ queryKey: orpc.meetings.results.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.meetings.transcript.redactCandidates.key() });
      }
    },
    onSuccess: () => setApplied(true),
  });

  if (status.isPending || status.error || !status.data) return null;
  if (status.data.reason === 'not_recorder' || status.data.reason === 'has_transcript' || status.data.reason === 'off') {
    return null;
  }

  return (
    <NotesMinutesBody
      meetingId={meetingId}
      status={status.data}
      answer={write.data}
      running={write.isPending}
      writeError={write.error}
      applying={apply.isPending}
      applied={applied}
      applyError={apply.error}
      onRun={() => write.mutate()}
      onApply={(draft) => apply.mutate(draft)}
    />
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Modular end-of-probation review panel with deterministic Projects facts and optional Ly draft note (#4448, Stage 5B).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  HR_PROBATION_DECISIONS,
  type HrProbationAiState,
  type HrProbationDecision,
  type HrProbationPreviewResult,
  type HrProbationReviewView,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { Textarea } from '@ludy/ui/components/textarea';
import { ErrorText, TableSkeleton } from './ui.tsx';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const PHONE_TARGET = 'max-md:min-h-11';
const DECISION_BADGE = {
  pass: 'success',
  extend: 'warning',
  terminate: 'destructive',
} as const;

export function probationScopeKey(employeeId: string, periodStart: string, periodEnd: string): string {
  return `${employeeId}|${periodStart}|${periodEnd}`;
}

export function previewMatchesProbationRange(args: {
  preview: HrProbationPreviewResult | undefined;
  isFetching: boolean;
  isError: boolean;
  employeeId: string;
  effectiveStart: string;
  effectiveEnd: string;
}): boolean {
  return (
    Boolean(args.preview) &&
    !args.isFetching &&
    !args.isError &&
    args.preview?.employeeId === args.employeeId &&
    args.preview?.periodStart === args.effectiveStart &&
    args.preview?.periodEnd === args.effectiveEnd
  );
}

export function canSubmitProbationDecision(args: {
  decision: HrProbationDecision | null;
  rangeValid: boolean;
  previewMatchesRange: boolean;
  extendedUntil: string;
  effectiveEnd: string;
}): boolean {
  return (
    Boolean(args.decision) &&
    args.rangeValid &&
    args.previewMatchesRange &&
    (args.decision !== 'extend' || (Boolean(args.extendedUntil) && args.extendedUntil > args.effectiveEnd))
  );
}

interface ProbationDraftAiVars {
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  lang: 'en' | 'vi';
}

export function HrProbationPanel({ employeeId }: { employeeId: string }) {
  const t = useTranslations('hrEmployees.probation');
  const f = useFormat();
  const { locale } = useLocaleSetting();
  const [prevEmployeeId, setPrevEmployeeId] = useState(employeeId);
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [submittedRange, setSubmittedRange] = useState<{ employeeId: string; periodStart?: string; periodEnd?: string }>({
    employeeId,
  });
  const [aiStatus, setAiStatus] = useState<HrProbationAiState | null>(null);
  const [aiDraftNote, setAiDraftNote] = useState('');
  const [decision, setDecision] = useState<HrProbationDecision | null>(null);
  const [extendedUntil, setExtendedUntil] = useState('');
  const [reviewNote, setReviewNote] = useState('');

  if (prevEmployeeId !== employeeId) {
    setPrevEmployeeId(employeeId);
    setPeriodStart('');
    setPeriodEnd('');
    setSubmittedRange({ employeeId });
    setAiStatus(null);
    setAiDraftNote('');
    setDecision(null);
    setExtendedUntil('');
    setReviewNote('');
  }

  const activeAsk =
    submittedRange.employeeId === employeeId ? submittedRange : { employeeId };

  const previewQ = useQuery({
    ...orpc.hr.probation.preview.queryOptions({ input: activeAsk }),
    ...ONCE,
    gcTime: 0,
  });

  const listQ = useQuery({
    ...orpc.hr.probation.list.queryOptions({ input: { employeeId, limit: 20 } }),
    ...ONCE,
    gcTime: 0,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });

  const preview = previewQ.data;
  const effectiveStart = periodStart || preview?.periodStart || '';
  const effectiveEnd = periodEnd || preview?.periodEnd || '';
  const rangeValid = Boolean(effectiveStart) && Boolean(effectiveEnd) && effectiveEnd >= effectiveStart;
  const currentScopeKey = probationScopeKey(employeeId, effectiveStart, effectiveEnd);
  const scopeKeyRef = useRef(currentScopeKey);
  scopeKeyRef.current = currentScopeKey;
  const previewMatchesRange = previewMatchesProbationRange({
    preview,
    isFetching: previewQ.isFetching,
    isError: previewQ.isError,
    employeeId,
    effectiveStart,
    effectiveEnd,
  });

  const draftAi = useMutation({
    mutationFn: (vars: ProbationDraftAiVars) =>
      client.hr.probation.draftSummary({
        employeeId: vars.employeeId,
        ...(vars.periodStart ? { periodStart: vars.periodStart } : {}),
        ...(vars.periodEnd ? { periodEnd: vars.periodEnd } : {}),
        lang: vars.lang,
      }),
    onSuccess: (res, vars) => {
      if (probationScopeKey(vars.employeeId, vars.periodStart, vars.periodEnd) !== scopeKeyRef.current) {
        return;
      }
      setAiStatus(res.status);
      if (res.draftNote) {
        setAiDraftNote(res.draftNote);
      }
      // Human manager always selects decision explicitly; Ly never sets or changes outcome.
    },
  });

  const decide = useMutation({
    mutationFn: () => {
      if (!decision || !previewMatchesRange) throw new Error('decision and matching preview are required');
      return client.hr.probation.decide({
        employeeId,
        periodStart: effectiveStart,
        periodEnd: effectiveEnd,
        probationEndOn: preview?.probationEndOn ?? null,
        decision,
        ...(decision === 'extend' && extendedUntil ? { extendedUntil } : {}),
        ...(reviewNote.trim() ? { reviewNote: reviewNote.trim() } : {}),
        ...(aiDraftNote.trim() ? { aiDraftNote: aiDraftNote.trim() } : {}),
      });
    },
    onSuccess: async () => {
      setDecision(null);
      setExtendedUntil('');
      setReviewNote('');
      await refresh();
      await Promise.all([previewQ.refetch(), listQ.refetch()]);
    },
  });

  const handleLoadFacts = (ev: FormEvent) => {
    ev.preventDefault();
    if (!rangeValid) return;
    setAiStatus(null);
    setAiDraftNote('');
    draftAi.reset();
    if (
      submittedRange.employeeId === employeeId &&
      submittedRange.periodStart === effectiveStart &&
      submittedRange.periodEnd === effectiveEnd
    ) {
      void previewQ.refetch();
      return;
    }
    setSubmittedRange({
      employeeId,
      periodStart: effectiveStart,
      periodEnd: effectiveEnd,
    });
  };

  const canSubmit = canSubmitProbationDecision({
    decision,
    rangeValid,
    previewMatchesRange,
    extendedUntil,
    effectiveEnd,
  });

  const history: readonly HrProbationReviewView[] = listQ.data ?? [];

  return (
    <Card className="mt-4 block space-y-4 p-4" data-testid="hr-probation-panel">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
        <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
      </div>

      <form className="flex flex-wrap items-end gap-3" onSubmit={handleLoadFacts}>
        <div className="space-y-1">
          <Label htmlFor={`hr-prob-start-${employeeId}`}>{t('periodStart')}</Label>
          <Input
            id={`hr-prob-start-${employeeId}`}
            type="date"
            className={PHONE_TARGET}
            value={effectiveStart}
            onChange={(ev) => {
              setPeriodStart(ev.target.value);
              setAiStatus(null);
              setAiDraftNote('');
              draftAi.reset();
            }}
            data-testid="hr-probation-start"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`hr-prob-end-${employeeId}`}>{t('periodEnd')}</Label>
          <Input
            id={`hr-prob-end-${employeeId}`}
            type="date"
            className={PHONE_TARGET}
            value={effectiveEnd}
            onChange={(ev) => {
              setPeriodEnd(ev.target.value);
              setAiStatus(null);
              setAiDraftNote('');
              draftAi.reset();
            }}
            data-testid="hr-probation-end"
          />
        </div>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          className={PHONE_TARGET}
          disabled={!rangeValid || previewQ.isFetching}
          data-testid="hr-probation-load"
        >
          {t('refreshFacts')}
        </Button>
      </form>

      {previewQ.isPending && <TableSkeleton columns={3} rows={2} />}
      {previewQ.error && <ErrorText>{errorMessage(previewQ.error)}</ErrorText>}

      {preview && (
        <div className="space-y-4 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{t('completedTasksLabel')}</span>
              <Badge variant="outline" data-testid="hr-probation-task-count">
                {f.number(preview.completedTasksCount)}
              </Badge>
            </div>
            <Badge
              variant={preview.projectsAvailable ? 'secondary' : 'outline'}
              data-testid="hr-probation-projects-badge"
            >
              {preview.projectsAvailable ? t('projectsBadge') : t('projectsOffBadge')}
            </Badge>
          </div>

          {preview.completedTasks.length === 0 ? (
            <p className="text-sm text-subtle-foreground" data-testid="hr-probation-tasks-empty">
              {t('completedTasksEmpty')}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[460px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b text-subtle-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t('colTask')}
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t('colProject')}
                    </th>
                    <th scope="col" className="py-2 font-medium">
                      {t('colCompletedAt')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.completedTasks.map((task) => (
                    <tr key={task.taskId} className="border-b last:border-b-0" data-testid="hr-probation-task-row">
                      <td className="py-2 pr-3 font-medium text-foreground">{task.title}</td>
                      <td className="py-2 pr-3 text-subtle-foreground">{task.projectName ?? '-'}</td>
                      <td className="py-2 text-subtle-foreground">{f.dateTime(task.completedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="space-y-1 rounded-md border bg-muted/20 p-3 text-sm" data-testid="hr-probation-attendance">
            <p className="text-xs font-medium text-foreground">{t('attendanceTitle')}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-subtle-foreground">
              <span>{t('annualLeave', { days: preview.attendance.annualLeaveDays })}</span>
              <span>{t('unpaidLeave', { days: preview.attendance.unpaidLeaveDays })}</span>
              <span>
                {t('overtimeSummary', {
                  hours: preview.attendance.overtimeHours,
                  count: f.number(preview.attendance.overtimeRequestsCount),
                })}
              </span>
            </div>
          </div>

          <div className="space-y-2 border-t pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={PHONE_TARGET}
                loading={draftAi.isPending}
                disabled={!rangeValid || !previewMatchesRange}
                onClick={() =>
                  draftAi.mutate({
                    employeeId,
                    periodStart: effectiveStart,
                    periodEnd: effectiveEnd,
                    lang: locale === 'en' ? 'en' : 'vi',
                  })
                }
                data-testid="hr-probation-draft-ai"
              >
                {t('draftAiBtn')}
              </Button>
              {aiStatus && (
                <Badge variant={aiStatus === 'used' ? 'proposal' : 'outline'} data-testid="hr-probation-ai-status">
                  {t(`aiStates.${aiStatus}`)}
                </Badge>
              )}
            </div>
            {draftAi.error && <ErrorText>{errorMessage(draftAi.error)}</ErrorText>}
            <div className="space-y-1">
              <Label htmlFor={`hr-prob-ai-draft-${employeeId}`}>{t('aiDraftLabel')}</Label>
              <Textarea
                id={`hr-prob-ai-draft-${employeeId}`}
                rows={3}
                value={aiDraftNote}
                onChange={(ev) => setAiDraftNote(ev.target.value)}
                data-testid="hr-probation-ai-draft"
              />
            </div>
          </div>

          <form
            className="space-y-3 border-t pt-3"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (canSubmit) decide.mutate();
            }}
          >
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-foreground">{t('decisionLabel')}</legend>
              <div className="flex flex-wrap gap-2">
                {HR_PROBATION_DECISIONS.map((opt) => (
                  <label
                    key={opt}
                    className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm ${
                      decision === opt ? 'border-primary bg-primary/10 font-medium' : 'border-border'
                    }`}
                  >
                    <input
                      type="radio"
                      name={`hr-probation-decision-${employeeId}`}
                      value={opt}
                      checked={decision === opt}
                      onChange={() => setDecision(opt)}
                      data-testid={`hr-probation-decision-${opt}`}
                    />
                    <span>{t(`decisions.${opt}`)}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            {decision === 'extend' && (
              <div className="max-w-xs space-y-1">
                <Label htmlFor={`hr-prob-extend-${employeeId}`}>{t('extendedUntil')}</Label>
                <Input
                  id={`hr-prob-extend-${employeeId}`}
                  type="date"
                  className={PHONE_TARGET}
                  value={extendedUntil}
                  min={effectiveEnd || undefined}
                  onChange={(ev) => setExtendedUntil(ev.target.value)}
                  data-testid="hr-probation-extended-until"
                />
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor={`hr-prob-note-${employeeId}`}>{t('reviewNoteLabel')}</Label>
              <Textarea
                id={`hr-prob-note-${employeeId}`}
                rows={3}
                placeholder={t('reviewNotePlaceholder')}
                value={reviewNote}
                onChange={(ev) => setReviewNote(ev.target.value)}
                data-testid="hr-probation-note"
              />
            </div>

            {decide.error && <ErrorText>{errorMessage(decide.error)}</ErrorText>}
            <Button
              type="submit"
              size="sm"
              className={PHONE_TARGET}
              loading={decide.isPending}
              disabled={!canSubmit}
              data-testid="hr-probation-submit"
            >
              {t('submit')}
            </Button>
          </form>
        </div>
      )}

      <div className="space-y-2 border-t pt-3">
        <h4 className="text-sm font-medium text-foreground">{t('historyTitle')}</h4>
        {listQ.isPending ? (
          <TableSkeleton columns={3} rows={1} />
        ) : listQ.error ? (
          <ErrorText>{errorMessage(listQ.error)}</ErrorText>
        ) : history.length === 0 ? (
          <p className="text-sm text-subtle-foreground" data-testid="hr-probation-history-empty">
            {t('historyEmpty')}
          </p>
        ) : (
          <div className="space-y-2">
            {history.map((rev) => (
              <div key={rev.id} className="space-y-1 rounded-md border p-3 text-sm" data-testid="hr-probation-history-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={DECISION_BADGE[rev.decision]}>{t(`decisions.${rev.decision}`)}</Badge>
                    <span className="text-xs text-subtle-foreground">
                      {f.date(rev.periodStart)} - {f.date(rev.periodEnd)}
                    </span>
                    {rev.extendedUntil && (
                      <span className="text-xs text-subtle-foreground">
                        {t('extendedUntil')}: {f.date(rev.extendedUntil)}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">{t('decidedOn', { date: f.dateTime(rev.decidedAt) })}</span>
                </div>
                {rev.reviewNote && <p className="text-xs text-foreground">{rev.reviewNote}</p>}
                {rev.aiDraftNote && <p className="text-xs text-subtle-foreground">{rev.aiDraftNote}</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

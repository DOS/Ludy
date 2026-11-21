// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useRef, useState, type KeyboardEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  calculateJobLossAllowance,
  calculateSeveranceAllowance,
  isValidCalendarDate,
  money,
} from '@crove/l10n-vn';
import {
  HR_JOB_LOSS_TERMINATION_REASONS,
  HR_SEVERANCE_TERMINATION_REASONS,
  type HrEmployeeJobLossAsk,
  type HrEmployeeJobLossResult,
  type HrEmployeeSeveranceAsk,
  type HrEmployeeSeveranceResult,
  type HrJobLossTerminationReason,
  type HrSeveranceTerminationReason,
} from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { ErrorText, TableSkeleton } from './ui.tsx';

// A sensitive read leaves an audit row each time: the worksheet fetches once and again only when the user clicks calculate.
const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const INT_RE = /^\d{1,4}$/;
const WAGE_RE = /^\d{1,16}(\.\d{1,2})?$/;

export type AllowanceCalculatorMode = 'severance' | 'job_loss';

export interface SharedTerminationDraft {
  endedOn?: string;
  totalWorkedMonths?: string;
  unemploymentInsuredMonths?: string;
  priorSettledMonths?: string;
  paidAmount?: string;
}

export interface SeveranceDraftOverrides extends SharedTerminationDraft {
  terminationReason?: HrSeveranceTerminationReason;
}

export interface JobLossDraftOverrides extends SharedTerminationDraft {
  terminationReason?: HrJobLossTerminationReason;
}

const isValidIntText = (value: string) => INT_RE.test(value) && Number(value) <= 1200;

function buildTerminationAskBase(
  employeeId: string,
  draft: SharedTerminationDraft,
  data?: {
    endedOn: string;
    unemploymentInsuredMonths: number;
    priorSettledMonths: number;
    paidAmount: string | null;
  },
  employeeEndedOn: string | null = null,
) {
  const endedOn = draft.endedOn ?? data?.endedOn ?? employeeEndedOn ?? '';
  const insuredText = draft.unemploymentInsuredMonths ?? (data ? String(data.unemploymentInsuredMonths) : '0');
  const settledText = draft.priorSettledMonths ?? (data ? String(data.priorSettledMonths) : '0');
  const paidText = draft.paidAmount ?? (data?.paidAmount ?? '');
  const workedOverride =
    draft.totalWorkedMonths !== undefined && draft.totalWorkedMonths !== ''
      ? Number(draft.totalWorkedMonths)
      : undefined;
  return {
    employeeId,
    ...(endedOn !== '' ? { endedOn } : {}),
    ...(workedOverride !== undefined ? { totalWorkedMonths: workedOverride } : {}),
    unemploymentInsuredMonths: Number(insuredText),
    priorSettledMonths: Number(settledText),
    ...(paidText !== '' ? { paidAmount: paidText } : {}),
  };
}

export function buildSeveranceAsk(
  employeeId: string,
  draft: SeveranceDraftOverrides,
  data?: Pick<HrEmployeeSeveranceResult, 'endedOn' | 'unemploymentInsuredMonths' | 'priorSettledMonths' | 'paidAmount'> & {
    terminationReason?: HrSeveranceTerminationReason;
  },
  employeeEndedOn: string | null = null,
): HrEmployeeSeveranceAsk {
  return {
    ...buildTerminationAskBase(employeeId, draft, data, employeeEndedOn),
    terminationReason: draft.terminationReason ?? data?.terminationReason ?? 'contract_expired',
  };
}

export function buildJobLossAsk(
  employeeId: string,
  draft: JobLossDraftOverrides,
  data?: Pick<HrEmployeeJobLossResult, 'endedOn' | 'unemploymentInsuredMonths' | 'priorSettledMonths' | 'paidAmount'> & {
    terminationReason?: HrJobLossTerminationReason;
  },
  employeeEndedOn: string | null = null,
): HrEmployeeJobLossAsk {
  return {
    ...buildTerminationAskBase(employeeId, draft, data, employeeEndedOn),
    terminationReason: draft.terminationReason ?? data?.terminationReason ?? 'organizational_restructuring',
  };
}

export function buildSwitchedAllowanceAsk(
  targetMode: AllowanceCalculatorMode,
  employeeId: string,
  sharedDraft: SharedTerminationDraft,
  targetReason: HrSeveranceTerminationReason | HrJobLossTerminationReason | undefined,
  sourceData?: {
    endedOn: string;
    unemploymentInsuredMonths: number;
    priorSettledMonths: number;
    paidAmount: string | null;
  },
  employeeEndedOn: string | null = null,
): HrEmployeeSeveranceAsk | HrEmployeeJobLossAsk {
  const preservedData = sourceData
    ? {
        endedOn: sourceData.endedOn,
        unemploymentInsuredMonths: sourceData.unemploymentInsuredMonths,
        priorSettledMonths: sourceData.priorSettledMonths,
        paidAmount: sourceData.paidAmount,
      }
    : undefined;
  if (targetMode === 'job_loss') {
    return buildJobLossAsk(
      employeeId,
      {
        ...sharedDraft,
        ...(targetReason ? { terminationReason: targetReason as HrJobLossTerminationReason } : {}),
      },
      preservedData,
      employeeEndedOn,
    );
  }
  return buildSeveranceAsk(
    employeeId,
    {
      ...sharedDraft,
      ...(targetReason ? { terminationReason: targetReason as HrSeveranceTerminationReason } : {}),
    },
    preservedData,
    employeeEndedOn,
  );
}

export function SeveranceCalculatorPanel({
  employeeId,
  employeeEndedOn,
  initialMode = 'severance',
}: {
  employeeId: string;
  employeeEndedOn: string | null;
  initialMode?: AllowanceCalculatorMode;
}) {
  const t = useTranslations('hrEmployees');
  const f = useFormat();
  const [mode, setMode] = useState<AllowanceCalculatorMode>(initialMode);
  const tabArt46Ref = useRef<HTMLButtonElement>(null);
  const tabArt47Ref = useRef<HTMLButtonElement>(null);
  const [submittedSeveranceAsk, setSubmittedSeveranceAsk] = useState<HrEmployeeSeveranceAsk>({ employeeId });
  const [submittedJobLossAsk, setSubmittedJobLossAsk] = useState<HrEmployeeJobLossAsk>({ employeeId });
  const [sharedDraft, setSharedDraft] = useState<SharedTerminationDraft>({});
  const [severanceReasonDraft, setSeveranceReasonDraft] = useState<HrSeveranceTerminationReason | undefined>(undefined);
  const [jobLossReasonDraft, setJobLossReasonDraft] = useState<HrJobLossTerminationReason | undefined>(undefined);

  const severanceQuery = useQuery({
    ...orpc.hr.payroll.employees.severance.queryOptions({ input: submittedSeveranceAsk }),
    ...ONCE,
    gcTime: 0,
    enabled: mode === 'severance',
  });

  const jobLossQuery = useQuery({
    ...orpc.hr.payroll.employees.job_loss.queryOptions({ input: submittedJobLossAsk }),
    ...ONCE,
    gcTime: 0,
    enabled: mode === 'job_loss',
  });

  const activeQuery = mode === 'severance' ? severanceQuery : jobLossQuery;
  const activeData = activeQuery.data;

  const endedOn = sharedDraft.endedOn ?? activeData?.endedOn ?? employeeEndedOn ?? '';
  const severanceReason = severanceReasonDraft ?? severanceQuery.data?.terminationReason ?? 'contract_expired';
  const jobLossReason = jobLossReasonDraft ?? jobLossQuery.data?.terminationReason ?? 'organizational_restructuring';
  const totalWorkedText = sharedDraft.totalWorkedMonths ?? (activeData ? String(activeData.totalWorkedMonths) : '');
  const insuredText = sharedDraft.unemploymentInsuredMonths ?? (activeData ? String(activeData.unemploymentInsuredMonths) : '0');
  const settledText = sharedDraft.priorSettledMonths ?? (activeData ? String(activeData.priorSettledMonths) : '0');
  const paidText = sharedDraft.paidAmount ?? (activeData?.paidAmount ?? '');

  const endedOnValid = endedOn !== '' && isValidCalendarDate(endedOn);
  const beforeHire = Boolean(activeData && endedOnValid && endedOn < activeData.hireDate);
  const workedValid = totalWorkedText === '' || isValidIntText(totalWorkedText);
  const insuredValid = isValidIntText(insuredText);
  const settledValid = isValidIntText(settledText);
  const paidValid = paidText === '' || WAGE_RE.test(paidText);
  const formValid = endedOnValid && !beforeHire && workedValid && insuredValid && settledValid && paidValid;

  const canPreviewLocally =
    activeData !== undefined &&
    formValid &&
    endedOn === activeData.endedOn &&
    totalWorkedText !== '' &&
    (Number(totalWorkedText) === activeData.totalWorkedMonths || (Number(totalWorkedText) >= 6 && activeData.sixMonthWages.length === 6));

  const liveSeveranceCalc =
    mode === 'severance' && canPreviewLocally && severanceQuery.data
      ? calculateSeveranceAllowance({
          totalWorkedMonths: Number(totalWorkedText),
          unemploymentInsuredMonths: Number(insuredText),
          priorSettledMonths: Number(settledText),
          sixMonthWages: severanceQuery.data.sixMonthWages,
          terminationReason: severanceReason,
          ...(paidText !== '' ? { paidAmount: paidText } : {}),
        })
      : null;

  const liveJobLossCalc =
    mode === 'job_loss' && canPreviewLocally && jobLossQuery.data
      ? calculateJobLossAllowance({
          totalWorkedMonths: Number(totalWorkedText),
          unemploymentInsuredMonths: Number(insuredText),
          priorSettledMonths: Number(settledText),
          sixMonthWages: jobLossQuery.data.sixMonthWages,
          terminationReason: jobLossReason,
          ...(paidText !== '' ? { paidAmount: paidText } : {}),
        })
      : null;

  const severanceDisplay = liveSeveranceCalc ?? severanceQuery.data;
  const jobLossDisplay = liveJobLossCalc ?? jobLossQuery.data;
  const display = mode === 'severance' ? severanceDisplay : jobLossDisplay;
  const needsServerRefresh = activeData !== undefined && !canPreviewLocally;

  const switchMode = (nextMode: AllowanceCalculatorMode) => {
    if (nextMode === mode) return;
    if (formValid) {
      const activeSubmittedAsk = mode === 'severance' ? submittedSeveranceAsk : submittedJobLossAsk;
      const carriedWorked =
        sharedDraft.totalWorkedMonths ??
        (activeSubmittedAsk.totalWorkedMonths !== undefined ? String(activeSubmittedAsk.totalWorkedMonths) : undefined);
      const effectiveDraft: SharedTerminationDraft = {
        ...sharedDraft,
        endedOn,
        unemploymentInsuredMonths: insuredText,
        priorSettledMonths: settledText,
        paidAmount: paidText,
        ...(carriedWorked !== undefined ? { totalWorkedMonths: carriedWorked } : {}),
      };
      const nextData = nextMode === 'job_loss' ? jobLossQuery.data : severanceQuery.data;
      const canReuseNextWages =
        nextData !== undefined &&
        endedOn === nextData.endedOn &&
        (totalWorkedText === '' ||
          Number(totalWorkedText) === nextData.totalWorkedMonths ||
          (Number(totalWorkedText) >= 6 && nextData.sixMonthWages.length === 6));
      if (canReuseNextWages) {
        const matchesNextData =
          endedOn === nextData.endedOn &&
          insuredText === String(nextData.unemploymentInsuredMonths) &&
          settledText === String(nextData.priorSettledMonths) &&
          paidText === (nextData.paidAmount ?? '') &&
          (carriedWorked === undefined || Number(carriedWorked) === nextData.totalWorkedMonths);
        setSharedDraft(matchesNextData ? {} : effectiveDraft);
      } else {
        const targetReason =
          nextMode === 'job_loss'
            ? (jobLossReasonDraft ?? jobLossQuery.data?.terminationReason)
            : (severanceReasonDraft ?? severanceQuery.data?.terminationReason);
        const nextAsk = buildSwitchedAllowanceAsk(nextMode, employeeId, effectiveDraft, targetReason, activeData, employeeEndedOn);
        if (nextMode === 'job_loss') {
          setSubmittedJobLossAsk(nextAsk as HrEmployeeJobLossAsk);
        } else {
          setSubmittedSeveranceAsk(nextAsk as HrEmployeeSeveranceAsk);
        }
        setSharedDraft({});
      }
    }
    setMode(nextMode);
  };

  const focusTab = (targetMode: AllowanceCalculatorMode) => {
    const target = targetMode === 'severance' ? tabArt46Ref.current : tabArt47Ref.current;
    target?.focus();
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const targetMode: AllowanceCalculatorMode = mode === 'severance' ? 'job_loss' : 'severance';
      switchMode(targetMode);
      focusTab(targetMode);
    } else if (event.key === 'Home') {
      event.preventDefault();
      switchMode('severance');
      focusTab('severance');
    } else if (event.key === 'End') {
      event.preventDefault();
      switchMode('job_loss');
      focusTab('job_loss');
    }
  };

  const submit = () => {
    if (!formValid) return;
    if (mode === 'severance') {
      const nextAsk = buildSeveranceAsk(
        employeeId,
        { ...sharedDraft, ...(severanceReasonDraft ? { terminationReason: severanceReasonDraft } : {}) },
        severanceQuery.data,
        employeeEndedOn,
      );
      if (JSON.stringify(nextAsk) === JSON.stringify(submittedSeveranceAsk)) {
        void severanceQuery.refetch();
      } else {
        setSubmittedSeveranceAsk(nextAsk);
      }
      setSeveranceReasonDraft(undefined);
    } else {
      const nextAsk = buildJobLossAsk(
        employeeId,
        { ...sharedDraft, ...(jobLossReasonDraft ? { terminationReason: jobLossReasonDraft } : {}) },
        jobLossQuery.data,
        employeeEndedOn,
      );
      if (JSON.stringify(nextAsk) === JSON.stringify(submittedJobLossAsk)) {
        void jobLossQuery.refetch();
      } else {
        setSubmittedJobLossAsk(nextAsk);
      }
      setJobLossReasonDraft(undefined);
    }
    setSharedDraft({});
  };

  const tabArt46Id = `allowance-tab-art46-${employeeId}`;
  const tabArt47Id = `allowance-tab-art47-${employeeId}`;
  const panelId = `allowance-tabpanel-${employeeId}`;
  const panelTitle = mode === 'severance' ? t('severance.title') : t('jobLoss.title');

  const excludedMonths = liveJobLossCalc
    ? Number(insuredText) + Number(settledText)
    : (jobLossQuery.data?.unemploymentInsuredMonths ?? 0) + (jobLossQuery.data?.priorSettledMonths ?? 0);
  const jobLossLySummary = (() => {
    if (mode !== 'job_loss' || !jobLossDisplay) return null;
    const hasTaxableExcess = money(jobLossDisplay.taxableExcess).gt(0);
    const hasPaidAmount = jobLossDisplay.paidAmount !== null && money(jobLossDisplay.paidAmount).gt(0);
    const excessNote = hasTaxableExcess
      ? t('jobLoss.lyExcessWarn', { excess: f.money(jobLossDisplay.taxableExcess, 'VND') })
      : hasPaidAmount
        ? t('jobLoss.lyNoExcess')
        : t('jobLoss.lyNoPayout');
    if (!jobLossDisplay.eligible) {
      return t('jobLoss.lySummaryIneligible', { excessNote });
    }
    if (jobLossDisplay.minimumFloorApplied) {
      return t('jobLoss.lySummaryFloorApplied', {
        excludedMonths: String(excludedMonths),
        qualifyingMonths: String(jobLossDisplay.qualifyingMonths),
        qualifyingYears: jobLossDisplay.qualifyingYears,
        amount: f.money(jobLossDisplay.amount, 'VND'),
        excessNote,
      });
    }
    return t('jobLoss.lySummaryStandard', {
      excludedMonths: String(excludedMonths),
      qualifyingMonths: String(jobLossDisplay.qualifyingMonths),
      qualifyingYears: jobLossDisplay.qualifyingYears,
      amount: f.money(jobLossDisplay.amount, 'VND'),
      excessNote,
    });
  })();

  return (
    <Card className="mt-3 block p-4" aria-label={panelTitle} data-testid="hr-severance-panel">
      <div
        role="tablist"
        aria-label={t('severance.modeLabel')}
        className="mb-3 flex flex-wrap gap-2"
        onKeyDown={onTabKeyDown}
      >
        <Button
          ref={tabArt46Ref}
          id={tabArt46Id}
          type="button"
          role="tab"
          aria-selected={mode === 'severance'}
          aria-controls={panelId}
          tabIndex={mode === 'severance' ? 0 : -1}
          variant={mode === 'severance' ? 'default' : 'outline'}
          className="min-h-11"
          onClick={() => switchMode('severance')}
          data-testid="hr-severance-tab-art46"
        >
          {t('severance.tabArt46')}
        </Button>
        <Button
          ref={tabArt47Ref}
          id={tabArt47Id}
          type="button"
          role="tab"
          aria-selected={mode === 'job_loss'}
          aria-controls={panelId}
          tabIndex={mode === 'job_loss' ? 0 : -1}
          variant={mode === 'job_loss' ? 'default' : 'outline'}
          className="min-h-11"
          onClick={() => switchMode('job_loss')}
          data-testid="hr-severance-tab-art47"
        >
          {t('severance.tabArt47')}
        </Button>
      </div>

      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={mode === 'severance' ? tabArt46Id : tabArt47Id}
      >
        <h4 className="text-sm font-semibold text-foreground">{panelTitle}</h4>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="hr-severance-readonly-note">
          {t('severance.readOnlyNote')}
        </p>

        {activeQuery.isPending ? (
          <div className="mt-3">
            <TableSkeleton columns={2} rows={4} />
          </div>
        ) : activeQuery.error ? (
          <ErrorText>{errorMessage(activeQuery.error)}</ErrorText>
        ) : activeData && display ? (
          <form
            className="mt-3 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-3">
              {mode === 'severance' ? (
                <div className="space-y-1">
                  <Label htmlFor={`sev-reason-${employeeId}`}>{t('severance.reasonLabel')}</Label>
                  <NativeSelect
                    id={`sev-reason-${employeeId}`}
                    className="w-full"
                    value={severanceReason}
                    onChange={(e) => setSeveranceReasonDraft(e.target.value as HrSeveranceTerminationReason)}
                    data-testid="hr-severance-reason"
                  >
                    {HR_SEVERANCE_TERMINATION_REASONS.map((reason) => (
                      <NativeSelectOption key={reason} value={reason}>
                        {t(`severance.reasons.${reason}`)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              ) : (
                <div className="space-y-1">
                  <Label htmlFor={`jobloss-reason-${employeeId}`}>{t('jobLoss.reasonLabel')}</Label>
                  <NativeSelect
                    id={`jobloss-reason-${employeeId}`}
                    className="w-full"
                    value={jobLossReason}
                    onChange={(e) => setJobLossReasonDraft(e.target.value as HrJobLossTerminationReason)}
                    data-testid="hr-job-loss-reason"
                  >
                    {HR_JOB_LOSS_TERMINATION_REASONS.map((reason) => (
                      <NativeSelectOption key={reason} value={reason}>
                        {t(`jobLoss.reasons.${reason}`)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor={`sev-ended-${employeeId}`}>{t('severance.endedOn')}</Label>
                <Input
                  id={`sev-ended-${employeeId}`}
                  type="date"
                  value={endedOn}
                  onChange={(e) =>
                    setSharedDraft((prev) => {
                      const { totalWorkedMonths: _ignored, ...rest } = prev;
                      return { ...rest, endedOn: e.target.value };
                    })
                  }
                  data-testid="hr-severance-ended-on"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`sev-worked-${employeeId}`}>{t('severance.totalWorkedMonths')}</Label>
                <Input
                  id={`sev-worked-${employeeId}`}
                  inputMode="numeric"
                  value={totalWorkedText}
                  onChange={(e) => setSharedDraft((prev) => ({ ...prev, totalWorkedMonths: e.target.value.replace(/\D/g, '') }))}
                  data-testid="hr-severance-worked-months"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`sev-insured-${employeeId}`}>{t('severance.unemploymentInsuredMonths')}</Label>
                <Input
                  id={`sev-insured-${employeeId}`}
                  inputMode="numeric"
                  value={insuredText}
                  onChange={(e) =>
                    setSharedDraft((prev) => ({ ...prev, unemploymentInsuredMonths: e.target.value.replace(/\D/g, '') }))
                  }
                  data-testid="hr-severance-insured-months"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`sev-settled-${employeeId}`}>{t('severance.priorSettledMonths')}</Label>
                <Input
                  id={`sev-settled-${employeeId}`}
                  inputMode="numeric"
                  value={settledText}
                  onChange={(e) => setSharedDraft((prev) => ({ ...prev, priorSettledMonths: e.target.value.replace(/\D/g, '') }))}
                  data-testid="hr-severance-settled-months"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`sev-paid-${employeeId}`}>{t('severance.paidAmount')}</Label>
                <Input
                  id={`sev-paid-${employeeId}`}
                  inputMode="decimal"
                  placeholder={t('severance.paidAmountPlaceholder')}
                  value={paidText}
                  onChange={(e) => setSharedDraft((prev) => ({ ...prev, paidAmount: e.target.value.replace(/[^\d.]/g, '') }))}
                  data-testid="hr-severance-paid-amount"
                />
              </div>
            </div>

            {mode === 'severance' && severanceReason === 'job_loss_redundancy' && (
              <div>
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-11"
                  onClick={() => switchMode('job_loss')}
                  data-testid="hr-severance-switch-job-loss"
                >
                  {t('severance.switchToJobLoss')}
                </Button>
              </div>
            )}

            {beforeHire && <ErrorText>{t('severance.endBeforeStart')}</ErrorText>}
            {!beforeHire && !formValid && <ErrorText>{t('severance.invalidInputs')}</ErrorText>}
            {needsServerRefresh && formValid && (
              <p className="text-xs text-muted-foreground">{t('severance.recalculateHint')}</p>
            )}

            <div>
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-7"
                disabled={!formValid || activeQuery.isFetching}
                data-testid="hr-severance-calculate"
              >
                {t('severance.calculate')}
              </Button>
            </div>

            <div className="space-y-3 border-t pt-3" data-testid="hr-severance-result">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">{t('severance.eligibleLabel')}</span>
                <Badge variant={display.eligible ? 'success' : 'secondary'}>
                  {display.eligible ? t('severance.eligibleYes') : t('severance.eligibleNo')}
                </Badge>
                {mode === 'job_loss' && jobLossDisplay?.eligible && (
                  <Badge
                    variant={jobLossDisplay.minimumFloorApplied ? 'outline' : 'secondary'}
                    data-testid="hr-job-loss-floor-badge"
                  >
                    {jobLossDisplay.minimumFloorApplied ? t('jobLoss.floorBadge') : t('jobLoss.aboveFloorBadge')}
                  </Badge>
                )}
                {!display.eligible && display.reason && (
                  <span className="text-xs text-destructive" data-testid="hr-severance-ineligible">
                    {mode === 'severance'
                      ? t(`severance.ineligibleReasons.${display.reason as NonNullable<HrEmployeeSeveranceResult['reason']>}`)
                      : t(`jobLoss.ineligibleReasons.${display.reason as NonNullable<HrEmployeeJobLossResult['reason']>}`)}
                  </span>
                )}
              </div>

              <dl className="grid gap-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-subtle-foreground">{t('severance.hireDate')}</dt>
                  <dd>{f.date(activeData.hireDate)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle-foreground">{t('severance.qualifyingMonths')}</dt>
                  <dd className="tabular-nums">{display.qualifyingMonths}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle-foreground">{t('severance.qualifyingYears')}</dt>
                  <dd className="tabular-nums">{display.qualifyingYears}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle-foreground">{t('severance.averageWage')}</dt>
                  <dd className="tabular-nums">{f.money(display.averageWage, 'VND')}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle-foreground">
                    {mode === 'severance' ? t('severance.amount') : t('jobLoss.amount')}
                  </dt>
                  <dd className="font-semibold tabular-nums" data-testid="hr-severance-amount">
                    {f.money(display.amount, 'VND')}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle-foreground">{t('severance.pitExemptAmount')}</dt>
                  <dd className="tabular-nums" data-testid="hr-severance-exempt">
                    {f.money(display.pitExemptAmount, 'VND')}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle-foreground">{t('severance.taxableExcess')}</dt>
                  <dd className="tabular-nums" data-testid="hr-severance-excess">
                    {f.money(display.taxableExcess, 'VND')}
                  </dd>
                </div>
              </dl>

              {jobLossLySummary && (
                <div
                  className="rounded-md border bg-muted/30 p-2.5 text-xs text-foreground"
                  data-testid="hr-job-loss-ly-note"
                >
                  <p className="font-medium">{t('jobLoss.lyTitle')}</p>
                  <p className="mt-1 text-muted-foreground">{jobLossLySummary}</p>
                </div>
              )}

              <div>
                <p className="text-xs font-medium text-muted-foreground">{t('severance.sixMonthWagesTitle')}</p>
                <ul className="mt-1 flex flex-wrap gap-2 text-xs">
                  {activeData.sixMonthWages.map((wage, idx) => (
                    <li key={idx} className="rounded border px-2 py-1 tabular-nums">
                      {t('severance.sixMonthWageItem', { index: String(idx + 1) })}: {f.money(wage, 'VND')}
                    </li>
                  ))}
                </ul>
              </div>

              {display.rulesUsed.length > 0 && (
                <div className="space-y-1 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">{t('severance.rulesTitle')}</p>
                  <ul className="space-y-1">
                    {display.rulesUsed.map((rule) => (
                      <li key={rule.id}>
                        <span className="font-mono">{rule.id}</span>{' '}
                        <Badge variant="secondary">{t(`severance.ruleStatus.${rule.status}`)}</Badge>{' '}
                        <span>{rule.cite}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}

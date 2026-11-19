// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { calculateSeveranceAllowance, isValidCalendarDate } from '@ludy/l10n-vn';
import {
  HR_SEVERANCE_TERMINATION_REASONS,
  type HrEmployeeSeveranceAsk,
  type HrEmployeeSeveranceResult,
  type HrSeveranceTerminationReason,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { useFormat } from '../i18n/provider.tsx';
import { errorMessage, orpc } from '../lib/api.ts';
import { ErrorText, TableSkeleton } from './ui.tsx';

// A sensitive read leaves an audit row each time: the worksheet fetches once and again only when the user clicks calculate.
const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const INT_RE = /^\d{1,4}$/;
const WAGE_RE = /^\d{1,16}(\.\d{1,2})?$/;

export interface SeveranceDraftOverrides {
  endedOn?: string;
  terminationReason?: HrSeveranceTerminationReason;
  totalWorkedMonths?: string;
  unemploymentInsuredMonths?: string;
  priorSettledMonths?: string;
  paidAmount?: string;
}

const isValidIntText = (value: string) => INT_RE.test(value) && Number(value) <= 1200;

export function buildSeveranceAsk(
  employeeId: string,
  draft: SeveranceDraftOverrides,
  data?: Pick<HrEmployeeSeveranceResult, 'endedOn' | 'terminationReason' | 'unemploymentInsuredMonths' | 'priorSettledMonths' | 'paidAmount'>,
  employeeEndedOn: string | null = null,
): HrEmployeeSeveranceAsk {
  const endedOn = draft.endedOn ?? data?.endedOn ?? employeeEndedOn ?? '';
  const terminationReason = draft.terminationReason ?? data?.terminationReason ?? 'contract_expired';
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
    terminationReason,
    ...(workedOverride !== undefined ? { totalWorkedMonths: workedOverride } : {}),
    unemploymentInsuredMonths: Number(insuredText),
    priorSettledMonths: Number(settledText),
    ...(paidText !== '' ? { paidAmount: paidText } : {}),
  };
}

export function SeveranceCalculatorPanel({
  employeeId,
  employeeEndedOn,
}: {
  employeeId: string;
  employeeEndedOn: string | null;
}) {
  const t = useTranslations('hrEmployees');
  const f = useFormat();
  const [submittedAsk, setSubmittedAsk] = useState<HrEmployeeSeveranceAsk>({ employeeId });
  const [draft, setDraft] = useState<SeveranceDraftOverrides>({});

  const q = useQuery({
    ...orpc.hr.payroll.employees.severance.queryOptions({ input: submittedAsk }),
    ...ONCE,
    gcTime: 0,
  });

  const data: HrEmployeeSeveranceResult | undefined = q.data;
  const endedOn = draft.endedOn ?? data?.endedOn ?? employeeEndedOn ?? '';
  const terminationReason = draft.terminationReason ?? data?.terminationReason ?? 'contract_expired';
  const totalWorkedText = draft.totalWorkedMonths ?? (data ? String(data.totalWorkedMonths) : '');
  const insuredText = draft.unemploymentInsuredMonths ?? (data ? String(data.unemploymentInsuredMonths) : '0');
  const settledText = draft.priorSettledMonths ?? (data ? String(data.priorSettledMonths) : '0');
  const paidText = draft.paidAmount ?? (data?.paidAmount ?? '');

  const endedOnValid = endedOn !== '' && isValidCalendarDate(endedOn);
  const beforeHire = Boolean(data && endedOnValid && endedOn < data.hireDate);
  const workedValid = totalWorkedText === '' || isValidIntText(totalWorkedText);
  const insuredValid = isValidIntText(insuredText);
  const settledValid = isValidIntText(settledText);
  const paidValid = paidText === '' || WAGE_RE.test(paidText);
  const formValid = endedOnValid && !beforeHire && workedValid && insuredValid && settledValid && paidValid;

  const canPreviewLocally =
    data !== undefined &&
    formValid &&
    endedOn === data.endedOn &&
    totalWorkedText !== '' &&
    (Number(totalWorkedText) === data.totalWorkedMonths || (Number(totalWorkedText) >= 6 && data.sixMonthWages.length === 6));

  const liveCalc = canPreviewLocally
    ? calculateSeveranceAllowance({
        totalWorkedMonths: Number(totalWorkedText),
        unemploymentInsuredMonths: Number(insuredText),
        priorSettledMonths: Number(settledText),
        sixMonthWages: data.sixMonthWages,
        terminationReason,
        ...(paidText !== '' ? { paidAmount: paidText } : {}),
      })
    : null;

  const display = liveCalc ?? data;
  const needsServerRefresh = data !== undefined && !canPreviewLocally;

  const submit = () => {
    if (!formValid) return;
    const nextAsk = buildSeveranceAsk(employeeId, draft, data, employeeEndedOn);
    if (JSON.stringify(nextAsk) === JSON.stringify(submittedAsk)) {
      void q.refetch();
    } else {
      setSubmittedAsk(nextAsk);
    }
    setDraft({});
  };

  return (
    <Card className="mt-3 block p-4" aria-label={t('severance.title')} data-testid="hr-severance-panel">
      <h4 className="text-sm font-semibold text-foreground">{t('severance.title')}</h4>
      <p className="mt-1 text-xs text-muted-foreground" data-testid="hr-severance-readonly-note">
        {t('severance.readOnlyNote')}
      </p>

      {q.isPending ? (
        <div className="mt-3">
          <TableSkeleton columns={2} rows={4} />
        </div>
      ) : q.error ? (
        <ErrorText>{errorMessage(q.error)}</ErrorText>
      ) : data && display ? (
        <form
          className="mt-3 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={`sev-reason-${employeeId}`}>{t('severance.reasonLabel')}</Label>
              <NativeSelect
                id={`sev-reason-${employeeId}`}
                value={terminationReason}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, terminationReason: e.target.value as HrSeveranceTerminationReason }))
                }
                data-testid="hr-severance-reason"
              >
                {HR_SEVERANCE_TERMINATION_REASONS.map((reason) => (
                  <NativeSelectOption key={reason} value={reason}>
                    {t(`severance.reasons.${reason}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1">
              <Label htmlFor={`sev-ended-${employeeId}`}>{t('severance.endedOn')}</Label>
              <Input
                id={`sev-ended-${employeeId}`}
                type="date"
                value={endedOn}
                onChange={(e) =>
                  setDraft((prev) => {
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
                onChange={(e) => setDraft((prev) => ({ ...prev, totalWorkedMonths: e.target.value.replace(/\D/g, '') }))}
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
                  setDraft((prev) => ({ ...prev, unemploymentInsuredMonths: e.target.value.replace(/\D/g, '') }))
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
                onChange={(e) => setDraft((prev) => ({ ...prev, priorSettledMonths: e.target.value.replace(/\D/g, '') }))}
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
                onChange={(e) => setDraft((prev) => ({ ...prev, paidAmount: e.target.value.replace(/[^\d.]/g, '') }))}
                data-testid="hr-severance-paid-amount"
              />
            </div>
          </div>

          {beforeHire && <ErrorText>{t('severance.endBeforeStart')}</ErrorText>}
          {!beforeHire && !formValid && <ErrorText>{t('severance.invalidInputs')}</ErrorText>}
          {needsServerRefresh && formValid && (
            <p className="text-xs text-muted-foreground">{t('severance.recalculateHint')}</p>
          )}

          <div>
            <Button type="submit" variant="outline" size="sm" disabled={!formValid || q.isFetching} data-testid="hr-severance-calculate">
              {t('severance.calculate')}
            </Button>
          </div>

          <div className="space-y-3 border-t pt-3" data-testid="hr-severance-result">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">{t('severance.eligibleLabel')}</span>
              <Badge variant={display.eligible ? 'success' : 'secondary'}>
                {display.eligible ? t('severance.eligibleYes') : t('severance.eligibleNo')}
              </Badge>
              {!display.eligible && display.reason && (
                <span className="text-xs text-destructive" data-testid="hr-severance-ineligible">
                  {t(`severance.ineligibleReasons.${display.reason}`)}
                </span>
              )}
            </div>

            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-subtle-foreground">{t('severance.hireDate')}</dt>
                <dd>{f.date(data.hireDate)}</dd>
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
                <dt className="text-xs text-subtle-foreground">{t('severance.amount')}</dt>
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

            <div>
              <p className="text-xs font-medium text-muted-foreground">{t('severance.sixMonthWagesTitle')}</p>
              <ul className="mt-1 flex flex-wrap gap-2 text-xs">
                {data.sixMonthWages.map((wage, idx) => (
                  <li key={idx} className="rounded border px-2 py-1 tabular-nums">
                    {t('severance.sixMonthWageItem', { index: String(idx + 1) })}: {f.money(wage, 'VND')}
                  </li>
                ))}
              </ul>
            </div>

            {data.rulesUsed.length > 0 && (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">{t('severance.rulesTitle')}</p>
                <ul className="space-y-1">
                  {data.rulesUsed.map((rule) => (
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
    </Card>
  );
}

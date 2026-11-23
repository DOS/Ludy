// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { calculateThirteenthMonthSalary, money, sum, toMoney } from '@ludy/l10n-vn';
import { HR_THIRTEENTH_MONTH_MODES, type HrThirteenthMonthMode, type HrThirteenthMonthPreviewResult } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc } from '../lib/api.ts';
import { DataTable, ErrorText, TableSkeleton } from './ui.tsx';

// A sensitive read leaves an audit row each time: the panel queries once per (run, year) and again only after an apply.
const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const NUM = 'text-right tabular-nums';
const WORKED_MONTHS_RE = /^(?:1[01](?:\.\d{1,2})?|12(?:\.0{1,2})?|[0-9](?:\.\d{1,2})?)$/;

export function defaultThirteenthMonthYear(month: string): number {
  const year = Number(month.slice(0, 4));
  return month.endsWith('-01') ? Math.max(2020, year - 1) : year;
}

export function ThirteenthMonthPanel({
  runId,
  month,
  onApplied,
  onClose,
}: {
  runId: string;
  month: string;
  onApplied: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations('hrPayroll');
  const f = useFormat();
  const initialYear = defaultThirteenthMonthYear(month);
  const [yearText, setYearText] = useState(() => String(initialYear));
  const [activeYear, setActiveYear] = useState(initialYear);
  const [mode, setMode] = useState<HrThirteenthMonthMode>('replace');
  const [workedEdits, setWorkedEdits] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  const yearValid = /^\d{4}$/.test(yearText) && Number(yearText) >= 2020 && Number(yearText) <= 2100;
  const q = useQuery({
    ...orpc.hr.payroll.runs.thirteenthMonthPreview.queryOptions({ input: { runId, year: activeYear } }),
    ...ONCE,
  });

  const data: HrThirteenthMonthPreviewResult | undefined = q.data;
  const rows = (data?.rows ?? []).map((row) => {
    const checked = selected[row.lineId] ?? true;
    const workedInput = workedEdits[row.lineId] ?? row.workedMonths;
    const workedValid = WORKED_MONTHS_RE.test(workedInput.trim());
    const proratedAmount = workedValid
      ? calculateThirteenthMonthSalary({ baseWage: row.baseWage, workedMonths: workedInput.trim() }).amount
      : row.amount;
    const resultingBonus =
      mode === 'add'
        ? toMoney(money(row.existingBonus).plus(money(proratedAmount)))
        : proratedAmount;
    return { ...row, checked, workedInput, workedValid, proratedAmount, resultingBonus };
  });

  const selectedRows = rows.filter((r) => r.checked);
  const hasInvalidWorked = selectedRows.some((r) => !r.workedValid);
  const totalSelectedAmount = toMoney(sum(selectedRows.map((r) => r.proratedAmount)));

  const apply = useMutation({
    mutationFn: () =>
      client.hr.payroll.runs.applyThirteenthMonth({
        runId,
        year: activeYear,
        mode,
        rows: selectedRows.map((r) => ({ lineId: r.lineId, workedMonths: r.workedInput.trim() })),
      }),
    onSuccess: async () => {
      await onApplied();
      onClose();
    },
  });

  const handleYearChange = (raw: string) => {
    const cleaned = raw.replace(/\D/g, '').slice(0, 4);
    setYearText(cleaned);
    if (/^\d{4}$/.test(cleaned)) {
      const next = Number(cleaned);
      if (next >= 2020 && next <= 2100 && next !== activeYear) {
        setActiveYear(next);
        setWorkedEdits({});
        setSelected({});
      }
    }
  };

  return (
    <Card className="mb-6 block p-4" aria-label={t('thirteenthMonth.title')} data-testid="hr-13th-month-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold">{t('thirteenthMonth.title')}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{t('thirteenthMonth.hint')}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('thirteenthMonth.cancel')}
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor="hr-13th-year">{t('thirteenthMonth.year')}</Label>
          <Input
            id="hr-13th-year"
            className="w-28"
            value={yearText}
            inputMode="numeric"
            maxLength={4}
            onChange={(e) => handleYearChange(e.target.value)}
            data-testid="hr-13th-month-year"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="hr-13th-mode">{t('thirteenthMonth.mode')}</Label>
          <NativeSelect
            id="hr-13th-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as HrThirteenthMonthMode)}
            data-testid="hr-13th-month-mode"
          >
            {HR_THIRTEENTH_MONTH_MODES.map((m) => (
              <NativeSelectOption key={m} value={m}>
                {t(`thirteenthMonth.modes.${m}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      </div>
      {!yearValid && <ErrorText>{t('thirteenthMonth.invalidYear')}</ErrorText>}

      {q.isPending ? (
        <div className="mt-4">
          <TableSkeleton columns={6} rows={3} />
        </div>
      ) : q.error ? (
        <ErrorText>{errorMessage(q.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('thirteenthMonth.empty')}</p>
      ) : (
        <div className="mt-4 space-y-3">
          <DataTable
            head={[
              '',
              t('thirteenthMonth.colEmployee'),
              t('thirteenthMonth.colPeriod'),
              t('thirteenthMonth.colBaseWage'),
              t('thirteenthMonth.colWorkedMonths'),
              t('thirteenthMonth.colProrated'),
              t('thirteenthMonth.colExistingBonus'),
              t('thirteenthMonth.colResultingBonus'),
            ]}
            numeric={[3, 5, 6, 7]}
            foot={
              <TableRow>
                <TableCell />
                <TableCell colSpan={4} className="font-medium">
                  {t('thirteenthMonth.total')}
                </TableCell>
                <TableCell className={`${NUM} font-medium`} data-testid="hr-13th-month-total">
                  {f.money(totalSelectedAmount, 'VND')}
                </TableCell>
                <TableCell />
                <TableCell />
              </TableRow>
            }
          >
            {rows.map((r) => (
              <TableRow key={r.lineId} data-testid="hr-13th-month-row">
                <TableCell>
                  <input
                    type="checkbox"
                    aria-label={r.employeeName}
                    checked={r.checked}
                    onChange={(e) => setSelected((prev) => ({ ...prev, [r.lineId]: e.target.checked }))}
                    data-testid="hr-13th-month-select"
                  />
                </TableCell>
                <TableCell className="font-medium">{r.employeeName}</TableCell>
                <TableCell className="text-xs text-muted-foreground tabular-nums">
                  {f.date(r.hireDate)} - {r.endedOn ? f.date(r.endedOn) : t('thirteenthMonth.activeStatus')}
                </TableCell>
                <TableCell className={NUM}>{f.money(r.baseWage, 'VND')}</TableCell>
                <TableCell>
                  <Input
                    aria-label={`${t('thirteenthMonth.colWorkedMonths')}: ${r.employeeName}`}
                    className="w-20 text-right tabular-nums"
                    value={r.workedInput}
                    inputMode="decimal"
                    onChange={(e) =>
                      setWorkedEdits((prev) => ({
                        ...prev,
                        [r.lineId]: e.target.value.replace(/[^\d.]/g, ''),
                      }))
                    }
                    data-testid="hr-13th-month-worked"
                  />
                </TableCell>
                <TableCell className={NUM}>{f.money(r.proratedAmount, 'VND')}</TableCell>
                <TableCell className={NUM}>{f.money(r.existingBonus, 'VND')}</TableCell>
                <TableCell className={NUM}>{f.money(r.resultingBonus, 'VND')}</TableCell>
              </TableRow>
            ))}
          </DataTable>

          {hasInvalidWorked && <ErrorText>{t('thirteenthMonth.invalidWorkedMonths')}</ErrorText>}

          {data && data.rulesUsed.length > 0 && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{t('thirteenthMonth.rulesTitle')}</p>
              <ul className="space-y-1">
                {data.rulesUsed.map((rule) => (
                  <li key={rule.id}>
                    <span className="font-mono">{rule.id}</span>{' '}
                    <Badge variant="secondary">{t(`thirteenthMonth.ruleStatus.${rule.status}`)}</Badge>{' '}
                    <span>{rule.cite}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {apply.error && <ErrorText>{errorMessage(apply.error)}</ErrorText>}
          <div className="flex flex-wrap gap-2">
            <Button
              loading={apply.isPending}
              disabled={!yearValid || selectedRows.length === 0 || hasInvalidWorked}
              onClick={() => apply.mutate()}
              data-testid="hr-13th-month-apply"
            >
              {t('thirteenthMonth.apply', { count: selectedRows.length })}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              {t('thirteenthMonth.cancel')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

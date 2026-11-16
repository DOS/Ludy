// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  HR_LEAVE_CATEGORIES,
  HR_LEAVE_ENTRY_KINDS,
  vietnamToday,
  type HrLeaveBalanceAsk,
  type HrLeaveCategory,
  type HrLeaveEntryKind,
} from '@crove/kernel-contract';
import { Badge } from '@crove/ui/components/badge';
import { Button } from '@crove/ui/components/button';
import { Card } from '@crove/ui/components/card';
import { Input } from '@crove/ui/components/input';
import { Label } from '@crove/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@crove/ui/components/native-select';
import { TableCell, TableRow } from '@crove/ui/components/table';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { DataTable, ErrorText, TableSkeleton } from './ui.tsx';

// A sensitive read leaves an audit row each time: fetch once on demand and refresh only after an explicit load or mutation.
const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAYS_RE = /^\d{1,3}(\.\d{1,2})?$/;

export function LeaveBalancePanel({ employeeId }: { employeeId: string }) {
  const t = useTranslations('hrEmployees');
  const f = useFormat();
  const today = vietnamToday();
  const defaultYear = today.slice(0, 4);
  const [yearInput, setYearInput] = useState(defaultYear);
  const [categoryInput, setCategoryInput] = useState<HrLeaveCategory>('standard');
  const [submittedAsk, setSubmittedAsk] = useState<HrLeaveBalanceAsk>({
    employeeId,
    year: defaultYear,
    category: 'standard',
  });
  const [month, setMonth] = useState(today.slice(0, 7));
  const [kind, setKind] = useState<HrLeaveEntryKind>('annual_leave');
  const [days, setDays] = useState('1');
  const [approved, setApproved] = useState(true);

  const q = useQuery({
    ...orpc.hr.payroll.leave.balance.queryOptions({ input: submittedAsk }),
    ...ONCE,
    gcTime: 0,
  });

  const refreshLeave = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });

  const saveEntry = useMutation({
    mutationFn: () => client.hr.payroll.leave.set({ employeeId, month, kind, days, approved }),
    onSuccess: refreshLeave,
  });

  const deleteEntry = useMutation({
    mutationFn: (entryId: string) => client.hr.payroll.leave.delete({ entryId }),
    onSuccess: refreshLeave,
  });

  const parsedYear = Number(yearInput);
  const yearValid = /^\d{4}$/.test(yearInput) && parsedYear >= 2000 && parsedYear <= 2100;
  const formValid = MONTH_RE.test(month) && DAYS_RE.test(days) && Number(days) <= 366;
  const data = q.data;

  return (
    <Card className="mt-4 block space-y-4 p-4" data-testid="hr-leave-panel">
      <div>
        <h3 className="text-sm font-semibold">{t('leave.title')}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t('leave.hint')}</p>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(ev) => {
          ev.preventDefault();
          if (!yearValid) return;
          if (yearInput === submittedAsk.year && categoryInput === submittedAsk.category) {
            void q.refetch();
            return;
          }
          setSubmittedAsk({ employeeId, year: yearInput, category: categoryInput });
        }}
      >
        <div className="space-y-1">
          <Label htmlFor={`hr-leave-year-${employeeId}`}>{t('leave.year')}</Label>
          <Input
            id={`hr-leave-year-${employeeId}`}
            className="w-24"
            inputMode="numeric"
            value={yearInput}
            onChange={(ev) => setYearInput(ev.target.value.replace(/\D/g, '').slice(0, 4))}
            data-testid="hr-leave-year"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`hr-leave-cat-${employeeId}`}>{t('leave.category')}</Label>
          <NativeSelect
            id={`hr-leave-cat-${employeeId}`}
            value={categoryInput}
            onChange={(ev) => setCategoryInput(ev.target.value as HrLeaveCategory)}
            data-testid="hr-leave-category"
          >
            {HR_LEAVE_CATEGORIES.map((c) => (
              <NativeSelectOption key={c} value={c}>
                {t(`leave.categories.${c}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={!yearValid || q.isFetching} data-testid="hr-leave-load">
          {t('leave.load')}
        </Button>
      </form>

      {q.isPending && <TableSkeleton columns={4} />}
      {q.error && <ErrorText>{errorMessage(q.error)}</ErrorText>}

      {data && (
        <div className="space-y-4 border-t pt-3">
          <dl className="grid gap-2 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.hireDate')}</dt>
              <dd>{f.date(data.hireDate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.eligibleMonths')}</dt>
              <dd className="tabular-nums">{data.balance.eligibleMonths}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.entitlementDays')}</dt>
              <dd className="tabular-nums">{data.balance.entitlementDays}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.seniorityYears')}</dt>
              <dd className="tabular-nums">{data.balance.seniorityYears}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.seniorityDays')}</dt>
              <dd className="tabular-nums">{data.balance.seniorityDays}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.totalEntitlementDays')}</dt>
              <dd className="tabular-nums">{data.balance.totalEntitlementDays}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.openingDays')}</dt>
              <dd className="tabular-nums">{data.balance.openingDays}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.takenAnnualDays')}</dt>
              <dd className="tabular-nums">{data.balance.takenAnnualDays}</dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.remainingAnnualDays')}</dt>
              <dd className="font-semibold tabular-nums" data-testid="hr-leave-remaining">
                {data.balance.remainingAnnualDays}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.exceededAnnualDays')}</dt>
              <dd
                className={data.balance.exceededAnnualDays !== '0' ? 'font-semibold tabular-nums text-destructive' : 'tabular-nums'}
                data-testid="hr-leave-exceeded"
              >
                {data.balance.exceededAnnualDays}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-subtle-foreground">{t('leave.personalPaidDays')}</dt>
              <dd className="tabular-nums">{data.balance.personalPaidDays}</dd>
            </div>
          </dl>

          <form
            className="space-y-3 border-t pt-3"
            data-testid="hr-leave-form"
            onSubmit={(ev) => {
              ev.preventDefault();
              if (!formValid) return;
              saveEntry.mutate();
            }}
          >
            <p className="text-xs font-medium text-muted-foreground">{t('leave.formTitle')}</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor={`hr-leave-month-${employeeId}`}>{t('leave.month')}</Label>
                <Input
                  id={`hr-leave-month-${employeeId}`}
                  className="w-28"
                  value={month}
                  placeholder="2026-11"
                  onChange={(ev) => setMonth(ev.target.value)}
                  data-testid="hr-leave-month"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`hr-leave-kind-${employeeId}`}>{t('leave.kind')}</Label>
                <NativeSelect
                  id={`hr-leave-kind-${employeeId}`}
                  value={kind}
                  onChange={(ev) => setKind(ev.target.value as HrLeaveEntryKind)}
                  data-testid="hr-leave-kind"
                >
                  {HR_LEAVE_ENTRY_KINDS.map((k) => (
                    <NativeSelectOption key={k} value={k}>
                      {t(`leave.kinds.${k}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`hr-leave-days-${employeeId}`}>{t('leave.days')}</Label>
                <Input
                  id={`hr-leave-days-${employeeId}`}
                  className="w-24"
                  inputMode="decimal"
                  value={days}
                  onChange={(ev) => setDays(ev.target.value.replace(/[^\d.]/g, ''))}
                  data-testid="hr-leave-days"
                />
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={approved}
                  onChange={(ev) => setApproved(ev.target.checked)}
                  data-testid="hr-leave-approved"
                />
                {t('leave.approved')}
              </label>
              <Button type="submit" size="sm" loading={saveEntry.isPending} disabled={!formValid} data-testid="hr-leave-save">
                {t('leave.save')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('leave.zeroDeletesHint')}</p>
            {saveEntry.error && <ErrorText>{errorMessage(saveEntry.error)}</ErrorText>}
          </form>

          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">{t('leave.entriesTitle', { year: String(data.year) })}</p>
            {deleteEntry.error && <ErrorText>{errorMessage(deleteEntry.error)}</ErrorText>}
            {data.entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('leave.empty')}</p>
            ) : (
              <DataTable head={[t('leave.colMonth'), t('leave.colKind'), t('leave.colDays'), t('leave.colApproved'), '']} numeric={[2]}>
                {data.entries.map((entry) => (
                  <TableRow key={entry.id} data-testid="hr-leave-entry-row">
                    <TableCell className="px-4 py-2">{entry.month}</TableCell>
                    <TableCell className="px-4 py-2">{t(`leave.kinds.${entry.kind}`)}</TableCell>
                    <TableCell className="px-4 py-2 text-right tabular-nums">{entry.days}</TableCell>
                    <TableCell className="px-4 py-2">
                      <Badge variant={entry.approved ? 'secondary' : 'outline'}>
                        {entry.approved ? t('leave.approvedYes') : t('leave.approvedNo')}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={deleteEntry.isPending && deleteEntry.variables === entry.id}
                        onClick={() => deleteEntry.mutate(entry.id)}
                        data-testid="hr-leave-delete"
                      >
                        {t('leave.delete')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </DataTable>
            )}
          </div>

          {data.balance.rulesUsed.length > 0 && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{t('leave.rulesTitle')}</p>
              <ul className="space-y-1">
                {data.balance.rulesUsed.map((rule) => (
                  <li key={rule.id}>
                    <span className="font-mono">{rule.id}</span>{' '}
                    <Badge variant="secondary">{t(`leave.ruleStatus.${rule.status}`)}</Badge>{' '}
                    <span>{rule.key} ({rule.effectiveFrom})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

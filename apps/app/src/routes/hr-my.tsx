// SPDX-License-Identifier: AGPL-3.0-only
// Employee self-service portal & L1 department leave approvals (issue #4300).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  HR_LEAVE_REQUEST_KINDS,
  HR_UNPAID_LEAVE_PRECISION_RE,
  vietnamToday,
  type HrLeaveRequestKind,
  type HrLeaveRequestStatus,
  type HrLeaveRequestView,
  type HrPayslip,
  type HrSelfLeaveSubmitResult,
  type HrSelfPayslipSummary,
} from '@ludy/kernel-contract';
import { money, toMoney, type PayrollBreakdown } from '@ludy/l10n-vn';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { normalizeLeaveDaysInput } from '../components/hr-leave-panel.tsx';
import { HrSelfOnboardingCard, HrSelfOvertimeCard, type HrOvertimeCardPrefill } from '../components/hr-onboarding-ot-card.tsx';
import { HrSelfAdvanceTripCards } from '../components/hr-stage6b-cards.tsx';
import { HrSelfCoworkerCard, type HrSelfLeavePrefill, type HrSelfOvertimePrefill } from '../components/hr-self-coworker-card.tsx';
import { HrSelfAssetsCard } from '../components/hr-stage6c-panels.tsx';
import { DataTable, Empty, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { HrAttendanceCheckinCard } from '../components/hr-attendance-checkin-card.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, getCurrentOrg, orpc, queryClient } from '../lib/api.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const NUM = 'text-right tabular-nums';
const PHONE_SELECT_TARGET = 'max-md:min-h-11 [&_select]:max-md:min-h-11';
const PHONE_INPUT_TARGET = 'max-md:min-h-11';

export function isValidSelfLeaveDays(kind: HrLeaveRequestKind, raw: string): boolean {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return false;
  if (kind === 'unpaid_leave' && !HR_UNPAID_LEAVE_PRECISION_RE.test(raw)) return false;
  const [wholeRaw = '0', fracRaw = ''] = raw.split('.');
  const hundredths = Number(wholeRaw) * 100 + Number(fracRaw.padEnd(2, '0').slice(0, 2));
  return Number.isSafeInteger(hundredths) && hundredths > 0 && hundredths <= 3100;
}

export function buildDeterministicPayslipExplanation(
  p: HrPayslip,
  formatMoney: (value: string, currency: string) => string,
  t: ReturnType<typeof useTranslations<'hrMy'>>,
): string {
  const b = p.breakdown as unknown as PayrollBreakdown;
  const extrasTotal = toMoney(
    money(b.pay.bonus)
      .plus(b.pay.allowances.reduce((acc, a) => acc.plus(money(a.paid)), money(0)))
      .plus(b.pay.overtime.reduce((acc, o) => acc.plus(money(o.pay)), money(0)))
      .plus(b.pay.nightWork ? money(b.pay.nightWork.pay) : money(0)),
  );
  const deductionsTotal = toMoney(
    money(b.deductions.advance).plus(money(b.deductions.damage)).plus(money(b.deductions.other)),
  );
  const extrasNote =
    extrasTotal !== '0' && extrasTotal !== '0.00'
      ? t('payslips.explainExtras', { amount: formatMoney(extrasTotal, 'VND') })
      : '';
  const deductionsNote =
    deductionsTotal !== '0' && deductionsTotal !== '0.00'
      ? t('payslips.explainDeductions', { amount: formatMoney(deductionsTotal, 'VND') })
      : '';
  return t('payslips.explainSummary', {
    month: p.month,
    gross: formatMoney(p.figures.gross, 'VND'),
    baseWage: formatMoney(b.pay.baseWage, 'VND'),
    extrasNote,
    insurance: formatMoney(p.figures.employeeInsurance, 'VND'),
    pit: formatMoney(p.figures.pit, 'VND'),
    deductionsNote,
    net: formatMoney(p.figures.net, 'VND'),
  });
}

function statusVariant(status: HrLeaveRequestStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'approved') return 'default';
  if (status === 'rejected') return 'destructive';
  if (status === 'cancelled') return 'outline';
  return 'secondary';
}

export function SelfPayslipDetail({
  lineId,
  onClose,
  initialExplained = false,
}: {
  lineId: string;
  onClose: () => void;
  initialExplained?: boolean;
}) {
  const t = useTranslations('hrMy');
  const tp = useTranslations('hrPayroll');
  const f = useFormat();
  const [explained, setExplained] = useState(initialExplained);

  const q = useQuery({
    ...orpc.hr.self.payslips.get.queryOptions({ input: { lineId } }),
    ...ONCE,
    gcTime: 0,
  });

  if (q.isPending) return <TableSkeleton columns={2} rows={4} />;
  if (q.error) return <ErrorText>{errorMessage(q.error)}</ErrorText>;

  const p = q.data;
  const b = p.breakdown as unknown as PayrollBreakdown;
  const line = (label: string, value: string, key: string) => (
    <tr key={key}>
      <td className="py-1 pr-6">{label}</td>
      <td className="py-1 text-right tabular-nums">{f.money(value, 'VND')}</td>
    </tr>
  );

  return (
    <Card className="mt-4 block p-6 print:border-0 print:shadow-none" data-testid="hr-my-payslip-detail">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3 print:hidden">
        <h3 className="text-base font-medium">{t('payslips.open')}</h3>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            className={PHONE_TARGET}
            aria-expanded={explained}
            onClick={() => setExplained((v) => !v)}
            data-testid="hr-my-payslip-explain"
          >
            {t('payslips.explainBtn')}
          </Button>
          <Button type="button" className={PHONE_TARGET} onClick={() => window.print()} data-testid="hr-my-payslip-print">
            {t('payslips.print')}
          </Button>
          <Button type="button" variant="ghost" className={PHONE_TARGET} onClick={onClose}>
            {t('payslips.close')}
          </Button>
        </div>
      </div>

      <p className="text-lg font-semibold">{p.employerName}</p>
      <p className="text-sm text-muted-foreground">{t('payslips.period', { month: p.month })}</p>
      <p className="mt-1 text-sm">{t('payslips.forEmployee', { name: p.employeeName })}</p>

      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th scope="col" className="py-1.5 pr-6 text-left font-medium">
              {t('payslips.itemCol')}
            </th>
            <th scope="col" className="py-1.5 text-right font-medium">
              {t('payslips.amountCol')}
            </th>
          </tr>
        </thead>
        <tbody>
          {line(tp('bd.baseWage'), b.pay.baseWage, 'base')}
          {b.pay.allowances.map((a, i) => line(a.label, a.paid, `a${i}`))}
          {b.pay.overtime.map((o, i) => line(tp('bd.overtime', { kind: tp(`dayKind.${o.dayKind}`), hours: o.hours }), o.pay, `o${i}`))}
          {b.pay.nightWork && line(tp('bd.night', { hours: b.pay.nightWork.hours }), b.pay.nightWork.pay, 'night')}
          {line(tp('bd.bonus'), b.pay.bonus, 'bonus')}
          {line(tp('gross'), p.figures.gross, 'gross')}
          {b.insurance.funds.map((fund) => line(tp(`fund.${fund.fund}`), fund.employee, fund.fund))}
          {line(tp('bd.pit'), p.figures.pit, 'pit')}
          {line(tp('bd.advance'), b.deductions.advance, 'advance')}
          {line(tp('bd.damage'), b.deductions.damage, 'damage')}
          {line(tp('bd.other'), b.deductions.other, 'other')}
          <tr className="border-t font-semibold">
            <td className="py-2 pr-6">{tp('net')}</td>
            <td className="py-2 text-right tabular-nums">{f.money(p.figures.net, 'VND')}</td>
          </tr>
        </tbody>
      </table>

      {explained && (
        <div className="mt-4 rounded-md border bg-muted/40 p-3 text-sm print:hidden" data-testid="hr-my-payslip-explanation">
          <p className="text-xs font-medium text-muted-foreground">{t('payslips.explainTitle')}</p>
          <p className="mt-1">{buildDeterministicPayslipExplanation(p, f.money, t)}</p>
        </div>
      )}
    </Card>
  );
}

export function HrSelfServicePage() {
  const t = useTranslations('hrMy');
  const f = useFormat();
  const today = vietnamToday();
  const [year, setYear] = useState(today.slice(0, 4));
  const [startOn, setStartOn] = useState(today);
  const [endOn, setEndOn] = useState(today);
  const [kind, setKind] = useState<HrLeaveRequestKind>('annual_leave');
  const [days, setDays] = useState('1');
  const [reason, setReason] = useState('');
  const [leaveAiDrafted, setLeaveAiDrafted] = useState(false);
  const [otPrefill, setOtPrefill] = useState<HrOvertimeCardPrefill | null>(null);
  const [lastSubmit, setLastSubmit] = useState<HrSelfLeaveSubmitResult | null>(null);
  const [teamNotes, setTeamNotes] = useState<Record<string, string>>({});
  const [openLineId, setOpenLineId] = useState<string | null>(null);

  const params = useParams({ strict: false }) as { slug?: string } | undefined;
  const slug = params?.slug || getCurrentOrg() || '';
  const meQ = useQuery({ ...orpc.me.get.queryOptions(), ...ONCE });
  const orgRole = meQ.data?.orgs.find((o) => o.slug === slug)?.role;
  const isOrgManagerRole = orgRole === 'owner' || orgRole === 'admin';

  const profileQ = useQuery({ ...orpc.hr.self.profile.get.queryOptions({ input: {} }), ...ONCE });
  const profile = profileQ.data;
  const linked = profile?.linked === true;
  const managesTeam = (profile?.managesDepartmentCount ?? 0) > 0;

  const balanceQ = useQuery({
    ...orpc.hr.self.leave.balance.queryOptions({ input: { year } }),
    ...ONCE,
    enabled: linked && /^\d{4}$/.test(year),
  });
  const requestsQ = useQuery({
    ...orpc.hr.self.leave.requests.queryOptions({ input: { scope: 'all' } }),
    ...ONCE,
    enabled: linked || managesTeam,
  });
  const payslipsQ = useQuery({
    ...orpc.hr.self.payslips.list.queryOptions({ input: { limit: 24 } }),
    ...ONCE,
    gcTime: 0,
    enabled: linked,
  });

  const refreshSelf = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.hr.self.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.hr.leaveRequests.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.hr.payroll.leave.key() }),
    ]);

  const submitMut = useMutation({
    mutationFn: () =>
      client.hr.self.leave.submit({
        startOn,
        endOn,
        kind,
        days,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: async (res) => {
      setLastSubmit(res);
      setReason('');
      setLeaveAiDrafted(false);
      await refreshSelf();
    },
  });

  const cancelMut = useMutation({
    mutationFn: (requestId: string) => client.hr.self.leave.cancel({ requestId }),
    onSuccess: refreshSelf,
  });

  const approveL1Mut = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note?: string }) =>
      client.hr.leaveRequests.approveL1({ requestId, ...(note ? { note } : {}) }),
    onSuccess: refreshSelf,
  });

  const rejectMut = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note?: string }) =>
      client.hr.leaveRequests.reject({ requestId, ...(note ? { note } : {}) }),
    onSuccess: refreshSelf,
  });

  const sameMonth = startOn.slice(0, 7) === endOn.slice(0, 7);
  const canSubmit = linked && Boolean(startOn) && Boolean(endOn) && endOn >= startOn && sameMonth && isValidSelfLeaveDays(kind, days);
  const handleSubmit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    if (!canSubmit || submitMut.isPending) return;
    submitMut.mutate();
  };

  const handleApplyLeaveDraft = (draft: HrSelfLeavePrefill) => {
    setStartOn(draft.startOn);
    setEndOn(draft.endOn);
    setKind(draft.kind);
    setDays(draft.days);
    setReason(draft.reason);
    setLeaveAiDrafted(true);
    if (typeof document !== 'undefined') {
      document.getElementById('hr-my-leave-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const handleApplyOvertimeDraft = (draft: HrSelfOvertimePrefill) => {
    setOtPrefill((prev) => ({
      version: (prev?.version ?? 0) + 1,
      ...draft,
    }));
    if (typeof document !== 'undefined') {
      document.getElementById('hr-my-ot-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  };

  const allRequests: readonly HrLeaveRequestView[] = requestsQ.data ?? [];
  const managedDeptIds = new Set((profile?.managedDepartments ?? []).map((d) => d.id));
  const myRequests = profile?.employeeId ? allRequests.filter((r) => r.employeeId === profile.employeeId) : [];
  const teamRequests = managesTeam
    ? allRequests.filter(
        (r) => r.employeeId !== profile?.employeeId && r.departmentId !== null && managedDeptIds.has(r.departmentId),
      )
    : [];
  const payslips: readonly HrSelfPayslipSummary[] = payslipsQ.data ?? [];

  return (
    <>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {profileQ.isPending && <TableSkeleton columns={3} />}
      {profileQ.error && <ErrorText>{errorMessage(profileQ.error)}</ErrorText>}

      {profile && !linked && (
        <Card className="mb-6 block p-4" data-testid="hr-my-unlinked">
          <h2 className="text-base font-medium text-foreground">{t('unlinkedTitle')}</h2>
          <p className="mt-1 text-sm text-subtle-foreground">{t('unlinkedHint')}</p>
        </Card>
      )}

      {profile && (linked || isOrgManagerRole) && (
        <HrSelfCoworkerCard
          key={slug || 'default'}
          linked={linked}
          onApplyLeave={handleApplyLeaveDraft}
          onApplyOvertime={handleApplyOvertimeDraft}
        />
      )}

      {profile && linked && (
        <>
          <Card className="mb-6 block p-4" data-testid="hr-my-profile">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-medium text-foreground">{t('profile.title')}</h2>
              <Badge variant={profile.status === 'active' ? 'default' : 'secondary'}>
                {profile.status === 'ended' ? t('profile.statusEnded') : t('profile.statusActive')}
              </Badge>
            </div>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-subtle-foreground">{t('profile.employeeName')}</dt>
                <dd className="font-medium text-foreground" data-testid="hr-my-name">{profile.displayName}</dd>
              </div>
              <div>
                <dt className="text-xs text-subtle-foreground">{t('profile.legalEntity')}</dt>
                <dd>{profile.legalEntityName ?? t('profile.unassigned')}</dd>
              </div>
              <div>
                <dt className="text-xs text-subtle-foreground">{t('profile.department')}</dt>
                <dd>{profile.departmentName ?? t('profile.unassigned')}</dd>
              </div>
              <div>
                <dt className="text-xs text-subtle-foreground">{t('profile.manager')}</dt>
                <dd>{profile.departmentManagerName ?? t('profile.unassigned')}</dd>
              </div>
              <div>
                <dt className="text-xs text-subtle-foreground">{t('profile.jobTitle')}</dt>
                <dd>{profile.jobTitle ?? t('profile.unassigned')}</dd>
              </div>
              <div>
                <dt className="text-xs text-subtle-foreground">{t('profile.hireDate')}</dt>
                <dd>{profile.hireDate ? f.date(profile.hireDate) : t('profile.unassigned')}</dd>
              </div>
            </dl>
          </Card>

          <HrAttendanceCheckinCard enabled={linked} />

          <Card className="mb-6 block space-y-4 p-4" data-testid="hr-my-leave-card">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-medium text-foreground">{t('leave.title')}</h2>
              <div className="flex items-center gap-2">
                <Label htmlFor="hr-my-leave-year">{t('leave.year')}</Label>
                <Input
                  id="hr-my-leave-year"
                  className={`w-24 ${PHONE_INPUT_TARGET}`}
                  inputMode="numeric"
                  value={year}
                  onChange={(ev) => setYear(ev.target.value.replace(/\D/g, '').slice(0, 4))}
                  data-testid="hr-my-leave-year"
                />
              </div>
            </div>

            {balanceQ.isPending && <TableSkeleton columns={4} rows={1} />}
            {balanceQ.error && <ErrorText>{errorMessage(balanceQ.error)}</ErrorText>}
            {balanceQ.data && balanceQ.data.balance === null && (
              <p className="text-sm text-subtle-foreground">{t('leave.noEmploymentHint')}</p>
            )}
            {balanceQ.data?.balance && (
              <dl className="grid gap-3 rounded-md border p-3 text-sm sm:grid-cols-4" data-testid="hr-my-leave-balance">
                <div>
                  <dt className="text-xs text-subtle-foreground">{t('leave.totalEntitlement')}</dt>
                  <dd className="font-medium tabular-nums">{balanceQ.data.balance.totalEntitlementDays}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle-foreground">{t('leave.takenAnnual')}</dt>
                  <dd className="tabular-nums">{balanceQ.data.balance.takenAnnualDays}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle-foreground">{t('leave.remaining')}</dt>
                  <dd className="font-semibold tabular-nums" data-testid="hr-my-remaining-days">
                    {balanceQ.data.balance.remainingAnnualDays}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle-foreground">{t('leave.personalPaid')}</dt>
                  <dd className="tabular-nums">{balanceQ.data.balance.personalPaidDays}</dd>
                </div>
              </dl>
            )}

            <form id="hr-my-leave-form" className="space-y-3 border-t pt-3" onSubmit={handleSubmit} data-testid="hr-my-leave-form">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-foreground">{t('leave.formTitle')}</h3>
                {leaveAiDrafted && (
                  <Badge variant="proposal" data-testid="hr-my-leave-ai-draft-badge">
                    {t('leave.aiDraftBadge')}
                  </Badge>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="space-y-1">
                  <Label htmlFor="hr-my-start-on">{t('leave.startOn')}</Label>
                  <Input
                    id="hr-my-start-on"
                    className={PHONE_INPUT_TARGET}
                    type="date"
                    value={startOn}
                    onChange={(ev) => setStartOn(ev.target.value)}
                    data-testid="hr-my-start-on"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="hr-my-end-on">{t('leave.endOn')}</Label>
                  <Input
                    id="hr-my-end-on"
                    className={PHONE_INPUT_TARGET}
                    type="date"
                    min={startOn}
                    value={endOn}
                    onChange={(ev) => setEndOn(ev.target.value)}
                    data-testid="hr-my-end-on"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="hr-my-kind">{t('leave.kind')}</Label>
                  <NativeSelect
                    id="hr-my-kind"
                    className={`w-full ${PHONE_SELECT_TARGET}`}
                    value={kind}
                    onChange={(ev) => setKind(ev.target.value as HrLeaveRequestKind)}
                    data-testid="hr-my-kind"
                  >
                    {HR_LEAVE_REQUEST_KINDS.map((k) => (
                      <NativeSelectOption key={k} value={k}>
                        {t(`leave.kinds.${k}`)}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="hr-my-days">{t('leave.days')}</Label>
                  <Input
                    id="hr-my-days"
                    className={PHONE_INPUT_TARGET}
                    inputMode="decimal"
                    value={days}
                    onChange={(ev) => setDays(normalizeLeaveDaysInput(ev.target.value))}
                    data-testid="hr-my-days"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-60 flex-1 space-y-1">
                  <Label htmlFor="hr-my-reason">{t('leave.reason')}</Label>
                  <Input
                    id="hr-my-reason"
                    className={PHONE_INPUT_TARGET}
                    maxLength={2000}
                    placeholder={t('leave.reasonPlaceholder')}
                    value={reason}
                    onChange={(ev) => setReason(ev.target.value)}
                    data-testid="hr-my-reason"
                  />
                </div>
                <Button type="submit" className={PHONE_TARGET} loading={submitMut.isPending} disabled={!canSubmit} data-testid="hr-my-submit">
                  {t('leave.submit')}
                </Button>
              </div>
              {submitMut.error && <ErrorText>{errorMessage(submitMut.error)}</ErrorText>}
              {lastSubmit && (
                <div className="space-y-1 text-xs" data-testid="hr-my-submit-feedback">
                  <p className="text-foreground">
                    {lastSubmit.status === 'pending_l1' ? t('leave.submittedL1') : t('leave.submittedFinal')}
                  </p>
                  {lastSubmit.overlapCount > 0 && (
                    <p className="rounded border border-warning/40 bg-warning/10 px-2 py-1 text-foreground" data-testid="hr-my-overlap-warning">
                      {t('leave.overlapWarning', { count: String(lastSubmit.overlapCount) })}
                    </p>
                  )}
                </div>
              )}
            </form>

            <div className="space-y-2 border-t pt-3">
              <h3 className="text-sm font-medium text-foreground">{t('leave.myRequestsTitle')}</h3>
              {cancelMut.error && <ErrorText>{errorMessage(cancelMut.error)}</ErrorText>}
              {myRequests.length === 0 ? (
                <p className="text-sm text-subtle-foreground">{t('leave.myRequestsEmpty')}</p>
              ) : (
                <ul className="divide-y rounded-md border">
                  {myRequests.map((r) => {
                    const cancellable = r.status === 'pending_l1' || r.status === 'pending_final';
                    return (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-testid="hr-my-request-row">
                        <div className="space-y-0.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">
                              {t('leave.dates', { start: f.date(r.startOn), end: f.date(r.endOn), days: r.days })}
                            </span>
                            <Badge variant="outline">{t(`leave.kinds.${r.kind}`)}</Badge>
                            <Badge variant={statusVariant(r.status)}>{t(`leave.statuses.${r.status}`)}</Badge>
                          </div>
                          {r.reason && <p className="text-xs text-subtle-foreground">{r.reason}</p>}
                          {r.decisionNote && <p className="text-xs text-muted-foreground">{r.decisionNote}</p>}
                        </div>
                        {cancellable && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className={PHONE_TARGET}
                            loading={cancelMut.isPending && cancelMut.variables === r.id}
                            onClick={() => cancelMut.mutate(r.id)}
                            data-testid="hr-my-cancel"
                          >
                            {t('leave.cancel')}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>
        </>
      )}

      {managesTeam && (
        <Card className="mb-6 block space-y-3 p-4" data-testid="hr-my-team-queue">
          <div>
            <h2 className="text-base font-medium text-foreground">{t('teamQueue.title')}</h2>
            <p className="mt-1 text-xs text-subtle-foreground">{t('teamQueue.subtitle')}</p>
          </div>
          {approveL1Mut.error && <ErrorText>{errorMessage(approveL1Mut.error)}</ErrorText>}
          {rejectMut.error && <ErrorText>{errorMessage(rejectMut.error)}</ErrorText>}
          {teamRequests.length === 0 ? (
            <p className="text-sm text-subtle-foreground">{t('teamQueue.empty')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {teamRequests.map((r) => {
                const note = teamNotes[r.id]?.trim() || undefined;
                const pendingL1 = r.status === 'pending_l1';
                return (
                  <li key={r.id} className="space-y-2 px-3 py-3 text-sm" data-testid="hr-my-team-row">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-foreground">{r.employeeName}</span>
                        {r.departmentName && <Badge variant="outline">{r.departmentName}</Badge>}
                        <span>{t('leave.dates', { start: f.date(r.startOn), end: f.date(r.endOn), days: r.days })}</span>
                        <Badge variant="outline">{t(`leave.kinds.${r.kind}`)}</Badge>
                        <Badge variant={statusVariant(r.status)}>{t(`leave.statuses.${r.status}`)}</Badge>
                      </div>
                    </div>
                    {r.reason && <p className="text-xs text-subtle-foreground">{r.reason}</p>}
                    {pendingL1 && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Input
                          className={`min-w-48 flex-1 ${PHONE_INPUT_TARGET}`}
                          aria-label={t('teamQueue.notePlaceholder')}
                          placeholder={t('teamQueue.notePlaceholder')}
                          value={teamNotes[r.id] ?? ''}
                          onChange={(ev) => setTeamNotes((cur) => ({ ...cur, [r.id]: ev.target.value }))}
                          data-testid="hr-my-team-note"
                        />
                        <Button
                          type="button"
                          size="sm"
                          className={PHONE_TARGET}
                          loading={approveL1Mut.isPending && approveL1Mut.variables?.requestId === r.id}
                          onClick={() => approveL1Mut.mutate({ requestId: r.id, ...(note ? { note } : {}) })}
                          data-testid="hr-my-l1-approve"
                        >
                          {t('teamQueue.approveL1')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className={PHONE_TARGET}
                          loading={rejectMut.isPending && rejectMut.variables?.requestId === r.id}
                          onClick={() => rejectMut.mutate({ requestId: r.id, ...(note ? { note } : {}) })}
                          data-testid="hr-my-l1-reject"
                        >
                          {t('teamQueue.reject')}
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {profile && linked && (
        <Card className="mb-6 block space-y-3 p-4" data-testid="hr-my-payslips">
          <div>
            <h2 className="text-base font-medium text-foreground">{t('payslips.title')}</h2>
            <p className="mt-1 text-xs text-subtle-foreground">{t('payslips.subtitle')}</p>
          </div>
          {payslipsQ.isPending ? (
            <TableSkeleton columns={4} rows={2} />
          ) : payslipsQ.error ? (
            <ErrorText>{errorMessage(payslipsQ.error)}</ErrorText>
          ) : payslips.length === 0 ? (
            <Empty title={t('payslips.empty')} />
          ) : (
            <DataTable head={[t('payslips.month'), t('payslips.gross'), t('payslips.net'), '']} numeric={[1, 2]}>
              {payslips.map((p) => (
                <TableRow key={p.lineId} data-testid="hr-my-payslip-row">
                  <TableCell className="font-medium tabular-nums">
                    {p.month}
                    <Badge className="ml-2" variant="secondary">
                      {t(`payslips.status.${p.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className={NUM}>{f.money(p.gross, 'VND')}</TableCell>
                  <TableCell className={NUM}>{f.money(p.net, 'VND')}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={PHONE_TARGET}
                      onClick={() => setOpenLineId(p.lineId)}
                      data-testid="hr-my-payslip-open"
                    >
                      {t('payslips.open')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </DataTable>
          )}
          {openLineId && <SelfPayslipDetail key={openLineId} lineId={openLineId} onClose={() => setOpenLineId(null)} />}
        </Card>
      )}

      {profile && linked && <HrSelfOnboardingCard />}
      {profile && (linked || managesTeam) && <HrSelfOvertimeCard linked={linked} prefill={otPrefill} />}
      {profile && (linked || managesTeam) && <HrSelfAdvanceTripCards linked={linked} />}
      {profile && linked && <HrSelfAssetsCard />}
    </>
  );
}

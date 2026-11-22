// SPDX-License-Identifier: AGPL-3.0-only
// Modular self-service onboarding checklist and 2-level overtime (OT) request cards for /hr/my (#4448 Stage 5B).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  HR_OVERTIME_DAY_TYPES,
  vietnamToday,
  type HrOvertimeDayType,
  type HrSelfOvertimeSubmitResult,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { BankSelect } from './bank-select.tsx';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const PHONE_TARGET = 'max-md:min-h-11';
const STATUS_BADGE = {
  pending: 'warning',
  pending_l1: 'warning',
  pending_final: 'secondary',
  approved: 'success',
  rejected: 'destructive',
  cancelled: 'outline',
} as const;

const isValidOtHoursText = (raw: string): boolean => {
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(raw)) return false;
  const [w, f = ''] = raw.split('.');
  const centi = Number.parseInt(w ?? '0', 10) * 100 + Number.parseInt(f.padEnd(2, '0'), 10);
  return centi > 0 && centi <= 2400;
};

export function HrSelfOnboardingCard() {
  const t = useTranslations('hrMy.onboarding');
  const f = useFormat();
  const [contactConfirmed, setContactConfirmed] = useState(false);
  const [idConfirmed, setIdConfirmed] = useState(false);
  const [bankConfirmed, setBankConfirmed] = useState(false);
  const [handbookConfirmed, setHandbookConfirmed] = useState(false);
  const [address, setAddress] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [identityNumber, setIdentityNumber] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [taxCode, setTaxCode] = useState('');
  const [insuranceNumber, setInsuranceNumber] = useState('');
  const [note, setNote] = useState('');

  const q = useQuery({
    ...orpc.hr.self.onboarding.get.queryOptions({ input: {} }),
    ...ONCE,
    gcTime: 0,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.self.key() });

  const submit = useMutation({
    mutationFn: () =>
      client.hr.self.onboarding.submit({
        contactConfirmed,
        idConfirmed,
        bankConfirmed,
        handbookConfirmed,
        ...(address.trim() ? { address: address.trim() } : {}),
        ...(birthDate ? { birthDate } : {}),
        ...(identityNumber.trim() ? { identityNumber: identityNumber.trim() } : {}),
        ...(bankCode ? { bankCode } : {}),
        ...(accountNumber.trim() ? { accountNumber: accountNumber.trim() } : {}),
        ...(taxCode.trim() ? { taxCode: taxCode.trim() } : {}),
        ...(insuranceNumber.trim() ? { insuranceNumber: insuranceNumber.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: async () => {
      setAddress('');
      setBirthDate('');
      setIdentityNumber('');
      setBankCode('');
      setAccountNumber('');
      setTaxCode('');
      setInsuranceNumber('');
      setNote('');
      await refresh();
    },
  });

  const cancel = useMutation({
    mutationFn: (submissionId: string) => client.hr.self.onboarding.cancel({ submissionId }),
    onSuccess: refresh,
  });

  const hasPayload =
    contactConfirmed ||
    idConfirmed ||
    bankConfirmed ||
    handbookConfirmed ||
    address.trim() !== '' ||
    birthDate !== '' ||
    identityNumber.trim() !== '' ||
    bankCode !== '' ||
    accountNumber.trim() !== '' ||
    taxCode.trim() !== '' ||
    insuranceNumber.trim() !== '' ||
    note.trim() !== '';

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!hasPayload || submit.isPending) return;
    submit.mutate();
  };

  const checklist = q.data?.checklist;
  const submissions = q.data?.submissions ?? [];

  return (
    <Card className="mt-6 block p-4" data-testid="hr-my-onboarding">
      <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
      <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>

      {q.error && <ErrorText>{errorMessage(q.error)}</ErrorText>}

      {checklist && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {[
            { label: t('itemAddress'), onFile: checklist.hasAddress, confirmed: checklist.contactConfirmed },
            { label: t('itemBirthDate'), onFile: checklist.hasBirthDate, confirmed: checklist.contactConfirmed },
            { label: t('itemId'), onFile: checklist.hasIdentityNumber, confirmed: checklist.idConfirmed },
            { label: t('itemBank'), onFile: checklist.hasBankAccount, confirmed: checklist.bankConfirmed },
            { label: t('itemHandbook'), onFile: checklist.handbookConfirmed, confirmed: checklist.handbookConfirmed },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border p-2 text-xs">
              <div className="font-medium text-foreground">{item.label}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Badge variant={item.onFile ? 'success' : 'secondary'}>
                  {item.onFile ? t('statusDone') : t('statusMissing')}
                </Badge>
                {item.confirmed && <Badge variant="outline">{t('confirmedBadge')}</Badge>}
              </div>
            </div>
          ))}
        </div>
      )}

      <form noValidate onSubmit={onSubmit} className="mt-4 space-y-3 border-t pt-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={contactConfirmed}
              onChange={(e) => setContactConfirmed(e.target.checked)}
              data-testid="hr-my-onboarding-confirm-contact"
            />
            {t('confirmContact')}
          </label>
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={idConfirmed}
              onChange={(e) => setIdConfirmed(e.target.checked)}
              data-testid="hr-my-onboarding-confirm-id"
            />
            {t('confirmId')}
          </label>
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={bankConfirmed}
              onChange={(e) => setBankConfirmed(e.target.checked)}
              data-testid="hr-my-onboarding-confirm-bank"
            />
            {t('confirmBank')}
          </label>
          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={handbookConfirmed}
              onChange={(e) => setHandbookConfirmed(e.target.checked)}
              data-testid="hr-my-onboarding-confirm-handbook"
            />
            {t('confirmHandbook')}
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="hr-my-ob-address">{t('addressLabel')}</Label>
            <Input
              id="hr-my-ob-address"
              className={PHONE_TARGET}
              value={address}
              maxLength={500}
              onChange={(e) => setAddress(e.target.value)}
              data-testid="hr-my-ob-address"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-my-ob-birth">{t('birthDateLabel')}</Label>
            <Input
              id="hr-my-ob-birth"
              type="date"
              className={PHONE_TARGET}
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              data-testid="hr-my-ob-birth"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-my-ob-identity">{t('identityLabel')}</Label>
            <Input
              id="hr-my-ob-identity"
              className={PHONE_TARGET}
              value={identityNumber}
              maxLength={30}
              autoComplete="off"
              onChange={(e) => setIdentityNumber(e.target.value)}
              data-testid="hr-my-ob-identity"
            />
          </div>
          <div className="space-y-1 max-md:[&_select]:min-h-11">
            <Label htmlFor="hr-my-ob-bank">{t('bankCodeLabel')}</Label>
            <BankSelect id="hr-my-ob-bank" value={bankCode} onChange={setBankCode} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-my-ob-account">{t('accountLabel')}</Label>
            <Input
              id="hr-my-ob-account"
              className={PHONE_TARGET}
              value={accountNumber}
              maxLength={34}
              autoComplete="off"
              onChange={(e) => setAccountNumber(e.target.value)}
              data-testid="hr-my-ob-account"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-my-ob-tax">{t('taxCodeLabel')}</Label>
            <Input
              id="hr-my-ob-tax"
              className={PHONE_TARGET}
              value={taxCode}
              inputMode="numeric"
              maxLength={12}
              autoComplete="off"
              onChange={(e) => setTaxCode(e.target.value)}
              data-testid="hr-my-ob-tax"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hr-my-ob-insurance">{t('insuranceLabel')}</Label>
            <Input
              id="hr-my-ob-insurance"
              className={PHONE_TARGET}
              value={insuranceNumber}
              inputMode="numeric"
              maxLength={12}
              autoComplete="off"
              onChange={(e) => setInsuranceNumber(e.target.value)}
              data-testid="hr-my-ob-insurance"
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="hr-my-ob-note">{t('noteLabel')}</Label>
            <Input
              id="hr-my-ob-note"
              className={PHONE_TARGET}
              value={note}
              maxLength={2000}
              onChange={(e) => setNote(e.target.value)}
              data-testid="hr-my-ob-note"
            />
          </div>
        </div>

        <Button
          type="submit"
          className={PHONE_TARGET}
          disabled={!hasPayload}
          loading={submit.isPending}
          data-testid="hr-my-onboarding-submit"
        >
          {t('submit')}
        </Button>
        {submit.error && <ErrorText>{errorMessage(submit.error)}</ErrorText>}
        {cancel.error && <ErrorText>{errorMessage(cancel.error)}</ErrorText>}
      </form>

      <div className="mt-4 border-t pt-4">
        <h3 className="text-sm font-medium text-foreground">{t('historyTitle')}</h3>
        {submissions.length === 0 ? (
          <p className="mt-1 text-xs text-subtle-foreground">{t('historyEmpty')}</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b text-subtle-foreground">
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('submittedAtColumn')}
                  </th>
                  <th scope="col" className="py-2 pr-3 font-medium">
                    {t('statusColumn')}
                  </th>
                  <th scope="col" className="py-2 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {submissions.map((s) => (
                  <tr key={s.id} className="border-b last:border-b-0" data-testid="hr-my-onboarding-row">
                    <td className="py-2 pr-3">
                      <div className="font-medium text-foreground">{f.date(s.createdAt)}</div>
                      {s.decisionNote && <div className="text-subtle-foreground">{s.decisionNote}</div>}
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={STATUS_BADGE[s.status]}>{t(`statuses.${s.status}`)}</Badge>
                    </td>
                    <td className="py-2 text-right">
                      {s.status === 'pending' && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className={PHONE_TARGET}
                          loading={cancel.isPending && cancel.variables === s.id}
                          onClick={() => cancel.mutate(s.id)}
                          data-testid="hr-my-onboarding-cancel"
                        >
                          {t('cancel')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

export function HrSelfOvertimeCard({ linked = true }: { linked?: boolean } = {}) {
  const t = useTranslations('hrMy.overtime');
  const f = useFormat();
  const today = vietnamToday();
  const [workDate, setWorkDate] = useState(today);
  const [hours, setHours] = useState('2');
  const [dayType, setDayType] = useState<HrOvertimeDayType>('weekday');
  const [isNight, setIsNight] = useState(false);
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [lastSubmit, setLastSubmit] = useState<HrSelfOvertimeSubmitResult | null>(null);

  const q = useQuery({
    ...orpc.hr.self.overtime.list.queryOptions({ input: { month: workDate.slice(0, 7), limit: 100 } }),
    ...ONCE,
    gcTime: 0,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.self.key() });

  const submit = useMutation({
    mutationFn: () =>
      client.hr.self.overtime.submit({
        workDate,
        hours: hours.trim(),
        dayType,
        isNight,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: async (res) => {
      setLastSubmit(res);
      setReason('');
      await refresh();
    },
  });

  const cancel = useMutation({
    mutationFn: (requestId: string) => client.hr.self.overtime.cancel({ requestId }),
    onSuccess: refresh,
  });

  const approveL1 = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note?: string }) =>
      client.hr.overtimeRequests.approveL1({ requestId, ...(note ? { note } : {}) }),
    onSuccess: refresh,
  });

  const reject = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note?: string }) =>
      client.hr.overtimeRequests.reject({ requestId, ...(note ? { note } : {}) }),
    onSuccess: refresh,
  });

  const canSubmit = workDate !== '' && isValidOtHoursText(hours.trim()) && !submit.isPending;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    submit.mutate();
  };

  const requests = q.data?.requests ?? [];
  const teamPending = q.data?.teamPending ?? [];
  const monthApprovedHours = q.data?.monthApprovedHours ?? '0';

  return (
    <>
      {linked && (
      <Card className="mt-6 block p-4" data-testid="hr-my-overtime">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
            <p className="mt-1 text-xs text-subtle-foreground">{t('subtitle')}</p>
          </div>
          <div className="rounded-lg border px-3 py-2 text-right">
            <div className="text-xs text-subtle-foreground">{t('monthApproved')}</div>
            <div className="text-lg font-semibold tabular-nums text-foreground">
              {t('hoursUnit', { hours: monthApprovedHours })}
            </div>
          </div>
        </div>

        {q.error && <ErrorText>{errorMessage(q.error)}</ErrorText>}

        <form noValidate onSubmit={onSubmit} className="mt-4 space-y-3 border-t pt-4">
          <h3 className="text-sm font-medium text-foreground">{t('formTitle')}</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="hr-my-ot-date">{t('workDate')}</Label>
              <Input
                id="hr-my-ot-date"
                type="date"
                className={PHONE_TARGET}
                value={workDate}
                onChange={(e) => setWorkDate(e.target.value)}
                data-testid="hr-my-ot-date"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hr-my-ot-hours">{t('hours')}</Label>
              <Input
                id="hr-my-ot-hours"
                className={PHONE_TARGET}
                value={hours}
                inputMode="decimal"
                maxLength={6}
                onChange={(e) => setHours(e.target.value.replace(/,/g, '.').replace(/[^\d.]/g, ''))}
                data-testid="hr-my-ot-hours"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="hr-my-ot-day-type">{t('dayType')}</Label>
              <NativeSelect
                id="hr-my-ot-day-type"
                className="max-md:min-h-11 [&_select]:max-md:min-h-11"
                value={dayType}
                onChange={(e) => setDayType(e.target.value as HrOvertimeDayType)}
                data-testid="hr-my-ot-day-type"
              >
                {HR_OVERTIME_DAY_TYPES.map((k) => (
                  <NativeSelectOption key={k} value={k}>
                    {t(`dayTypes.${k}`)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
          </div>

          <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={isNight}
              onChange={(e) => setIsNight(e.target.checked)}
              data-testid="hr-my-ot-night"
            />
            {t('isNight')}
          </label>

          <div className="space-y-1">
            <Label htmlFor="hr-my-ot-reason">{t('reason')}</Label>
            <Input
              id="hr-my-ot-reason"
              className={PHONE_TARGET}
              value={reason}
              maxLength={2000}
              onChange={(e) => setReason(e.target.value)}
              data-testid="hr-my-ot-reason"
            />
          </div>

          {lastSubmit?.exceedsMonthlyCap && (
            <p className="rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning" data-testid="hr-my-ot-cap-warning">
              {t('capWarning', { month: lastSubmit.month, total: lastSubmit.monthHoursTotal })}
            </p>
          )}

          <Button
            type="submit"
            className={PHONE_TARGET}
            disabled={!canSubmit}
            loading={submit.isPending}
            data-testid="hr-my-ot-submit"
          >
            {t('submit')}
          </Button>
          {submit.error && <ErrorText>{errorMessage(submit.error)}</ErrorText>}
          {cancel.error && <ErrorText>{errorMessage(cancel.error)}</ErrorText>}
        </form>

        <div className="mt-4 border-t pt-4">
          <h3 className="text-sm font-medium text-foreground">{t('myRequestsTitle')}</h3>
          {requests.length === 0 ? (
            <p className="mt-1 text-xs text-subtle-foreground">{t('myRequestsEmpty')}</p>
          ) : (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b text-subtle-foreground">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t('workDate')}
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t('dayType')}
                    </th>
                    <th scope="col" className="py-2 pr-3 text-right font-medium">
                      {t('hours')}
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      {t('statusColumn')}
                    </th>
                    <th scope="col" className="py-2 text-right font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} className="border-b last:border-b-0" data-testid="hr-my-ot-row">
                      <td className="py-2 pr-3 font-medium text-foreground">
                        <div>{f.date(r.workDate)}</div>
                        {r.reason && <div className="font-normal text-subtle-foreground">{r.reason}</div>}
                      </td>
                      <td className="py-2 pr-3">
                        <div>{t(`dayTypes.${r.dayType}`)}</div>
                        <div className="text-[11px] text-subtle-foreground">
                          {t('commentaryNote', { percent: String(r.multiplierPercent) })}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{t('hoursUnit', { hours: r.hours })}</td>
                      <td className="py-2 pr-3">
                        <Badge variant={STATUS_BADGE[r.status]}>{t(`statuses.${r.status}`)}</Badge>
                      </td>
                      <td className="py-2 text-right">
                        {(r.status === 'pending_l1' || r.status === 'pending_final') && (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className={PHONE_TARGET}
                            loading={cancel.isPending && cancel.variables === r.id}
                            onClick={() => cancel.mutate(r.id)}
                            data-testid="hr-my-ot-cancel"
                          >
                            {t('cancel')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>
      )}

      {teamPending.length > 0 && (
        <Card className="mt-6 block p-4" data-testid="hr-my-ot-team-queue">
          <h2 className="text-base font-medium text-foreground">{t('teamQueueTitle')}</h2>
          <p className="mt-1 text-xs text-subtle-foreground">{t('teamQueueSubtitle')}</p>
          {(approveL1.error || reject.error) && (
            <ErrorText>{errorMessage(approveL1.error ?? reject.error)}</ErrorText>
          )}
          <div className="mt-3 space-y-2">
            {teamPending.map((r) => {
              const note = notes[r.id]?.trim() || undefined;
              return (
                <div key={r.id} className="rounded-lg border p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">
                      {r.employeeName} · {f.date(r.workDate)} · {t('hoursUnit', { hours: r.hours })}
                    </span>
                    <Badge variant="warning">{t(`statuses.${r.status}`)}</Badge>
                  </div>
                  <div className="mt-1 text-xs text-subtle-foreground">
                    {t(`dayTypes.${r.dayType}`)} {r.reason ? `· ${r.reason}` : ''}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      className={`max-w-xs ${PHONE_TARGET}`}
                      aria-label={t('notePlaceholder')}
                      value={notes[r.id] ?? ''}
                      maxLength={2000}
                      placeholder={t('notePlaceholder')}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    />
                    <Button
                      type="button"
                      size="sm"
                      className={PHONE_TARGET}
                      loading={approveL1.isPending && approveL1.variables?.requestId === r.id}
                      onClick={() => approveL1.mutate({ requestId: r.id, ...(note ? { note } : {}) })}
                      data-testid="hr-my-ot-approve-l1"
                    >
                      {t('approveL1')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={PHONE_TARGET}
                      loading={reject.isPending && reject.variables?.requestId === r.id}
                      onClick={() => reject.mutate({ requestId: r.id, ...(note ? { note } : {}) })}
                      data-testid="hr-my-ot-reject"
                    >
                      {t('reject')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// Owner/admin HR review queues for employee onboarding confirmations and 2-level overtime (OT) requests (#4448, Stage 5B).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  HR_ONBOARDING_STATUSES,
  HR_OVERTIME_STATUSES,
  type HrOnboardingStatus,
  type HrOnboardingSubmissionView,
  type HrOvertimeRequestView,
  type HrOvertimeStatus,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { ErrorText, TableSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const PHONE_TARGET = 'max-md:min-h-11';
const PHONE_SELECT_TARGET = 'max-md:min-h-11 [&_select]:max-md:min-h-11';

const refreshHr = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });

export function HrOnboardingReviewQueue() {
  const t = useTranslations('hrEmployees.onboardingQueue');
  const f = useFormat();
  const [statusFilter, setStatusFilter] = useState<HrOnboardingStatus | ''>('');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const q = useQuery({
    ...orpc.hr.onboarding.list.queryOptions({
      input: {
        limit: 100,
        ...(statusFilter ? { status: statusFilter } : {}),
      },
    }),
    ...ONCE,
  });

  const approve = useMutation({
    mutationFn: ({ submissionId, note }: { submissionId: string; note?: string }) =>
      client.hr.onboarding.approve({ submissionId, ...(note ? { note } : {}) }),
    onSuccess: refreshHr,
  });
  const reject = useMutation({
    mutationFn: ({ submissionId, note }: { submissionId: string; note?: string }) =>
      client.hr.onboarding.reject({ submissionId, ...(note ? { note } : {}) }),
    onSuccess: refreshHr,
  });

  const rows: readonly HrOnboardingSubmissionView[] = q.data ?? [];

  return (
    <Card className="mt-6 block space-y-3 p-4" data-testid="hr-onboarding-queue">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
          <p className="text-xs text-subtle-foreground">{t('subtitle')}</p>
        </div>
        <NativeSelect
          className={PHONE_SELECT_TARGET}
          aria-label={t('filterLabel')}
          value={statusFilter}
          onChange={(ev) => setStatusFilter((ev.target.value || '') as HrOnboardingStatus | '')}
          data-testid="hr-onboarding-queue-filter"
        >
          <NativeSelectOption value="">{t('filterAll')}</NativeSelectOption>
          {HR_ONBOARDING_STATUSES.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {t(`statuses.${s}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {approve.error && <ErrorText>{errorMessage(approve.error)}</ErrorText>}
      {reject.error && <ErrorText>{errorMessage(reject.error)}</ErrorText>}
      {q.isPending ? (
        <TableSkeleton columns={4} rows={2} />
      ) : q.error ? (
        <ErrorText>{errorMessage(q.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <p className="text-sm text-subtle-foreground" data-testid="hr-onboarding-queue-empty">
          {t('empty')}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const note = notes[r.id]?.trim() || undefined;
            const confirmedItems = [
              r.contactConfirmed ? t('itemContact') : null,
              r.idConfirmed ? t('itemId') : null,
              r.bankConfirmed ? t('itemBank') : null,
              r.handbookConfirmed ? t('itemHandbook') : null,
            ].filter(Boolean);
            const updatedFields = [
              r.address ? `${t('fieldAddress')}: ${r.address}` : null,
              r.birthDate ? `${t('fieldBirthDate')}: ${f.date(r.birthDate)}` : null,
              r.hasIdentityNumber ? t('fieldIdentity') : null,
              r.bankCode ? `${t('fieldBank')}: ${r.bankCode}` : null,
              r.hasBankAccount ? t('fieldAccount') : null,
              r.hasTaxCode ? t('fieldTaxCode') : null,
              r.hasInsuranceNumber ? t('fieldInsurance') : null,
            ].filter(Boolean);
            return (
              <div key={r.id} className="space-y-2 rounded-md border p-3 text-sm" data-testid="hr-onboarding-queue-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{r.employeeName}</span>
                    {r.departmentName && <Badge variant="outline">{r.departmentName}</Badge>}
                    <Badge variant={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'destructive' : 'secondary'}>
                      {t(`statuses.${r.status}`)}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground">{f.dateTime(r.createdAt)}</span>
                </div>
                {confirmedItems.length > 0 && (
                  <p className="text-xs text-subtle-foreground">{t('itemsConfirmed', { items: confirmedItems.join(', ') })}</p>
                )}
                <p className="text-xs text-foreground">
                  {updatedFields.length > 0
                    ? t('pendingFields', { fields: updatedFields.join(' · ') })
                    : t('noFieldsHint')}
                </p>
                {r.note && <p className="text-xs text-subtle-foreground">{r.note}</p>}
                {r.decisionNote && <p className="text-xs text-muted-foreground">{r.decisionNote}</p>}
                {r.status === 'pending' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className={`min-w-48 flex-1 ${PHONE_TARGET}`}
                      aria-label={t('notePlaceholder')}
                      placeholder={t('notePlaceholder')}
                      value={notes[r.id] ?? ''}
                      onChange={(ev) => setNotes((cur) => ({ ...cur, [r.id]: ev.target.value }))}
                      data-testid="hr-onboarding-queue-note"
                    />
                    <Button
                      type="button"
                      size="sm"
                      className={PHONE_TARGET}
                      loading={approve.isPending && approve.variables?.submissionId === r.id}
                      onClick={() => approve.mutate({ submissionId: r.id, ...(note ? { note } : {}) })}
                      data-testid="hr-onboarding-queue-approve"
                    >
                      {t('approve')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={PHONE_TARGET}
                      loading={reject.isPending && reject.variables?.submissionId === r.id}
                      onClick={() => reject.mutate({ submissionId: r.id, ...(note ? { note } : {}) })}
                      data-testid="hr-onboarding-queue-reject"
                    >
                      {t('reject')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

export function HrOvertimeReviewQueue() {
  const t = useTranslations('hrEmployees.overtimeQueue');
  const tm = useTranslations('hrMy.overtime');
  const f = useFormat();
  const [statusFilter, setStatusFilter] = useState<HrOvertimeStatus | ''>('');
  const [notes, setNotes] = useState<Record<string, string>>({});

  const q = useQuery({
    ...orpc.hr.overtimeRequests.list.queryOptions({
      input: {
        limit: 100,
        ...(statusFilter ? { status: statusFilter } : {}),
      },
    }),
    ...ONCE,
  });

  const approveL1 = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note?: string }) =>
      client.hr.overtimeRequests.approveL1({ requestId, ...(note ? { note } : {}) }),
    onSuccess: refreshHr,
  });
  const approveFinal = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note?: string }) =>
      client.hr.overtimeRequests.approveFinal({ requestId, ...(note ? { note } : {}) }),
    onSuccess: refreshHr,
  });
  const reject = useMutation({
    mutationFn: ({ requestId, note }: { requestId: string; note?: string }) =>
      client.hr.overtimeRequests.reject({ requestId, ...(note ? { note } : {}) }),
    onSuccess: refreshHr,
  });

  const rows: readonly HrOvertimeRequestView[] = q.data ?? [];

  return (
    <Card className="mt-6 block space-y-3 p-4" data-testid="hr-overtime-queue">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
          <p className="text-xs text-subtle-foreground">{t('subtitle')}</p>
        </div>
        <NativeSelect
          className={PHONE_SELECT_TARGET}
          aria-label={t('filterLabel')}
          value={statusFilter}
          onChange={(ev) => setStatusFilter((ev.target.value || '') as HrOvertimeStatus | '')}
          data-testid="hr-overtime-queue-filter"
        >
          <NativeSelectOption value="">{t('filterAll')}</NativeSelectOption>
          {HR_OVERTIME_STATUSES.map((s) => (
            <NativeSelectOption key={s} value={s}>
              {t(`statuses.${s}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      {approveL1.error && <ErrorText>{errorMessage(approveL1.error)}</ErrorText>}
      {approveFinal.error && <ErrorText>{errorMessage(approveFinal.error)}</ErrorText>}
      {reject.error && <ErrorText>{errorMessage(reject.error)}</ErrorText>}
      {q.isPending ? (
        <TableSkeleton columns={4} rows={2} />
      ) : q.error ? (
        <ErrorText>{errorMessage(q.error)}</ErrorText>
      ) : rows.length === 0 ? (
        <p className="text-sm text-subtle-foreground" data-testid="hr-overtime-queue-empty">
          {t('empty')}
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const note = notes[r.id]?.trim() || undefined;
            const pending = r.status === 'pending_l1' || r.status === 'pending_final';
            return (
              <div key={r.id} className="space-y-2 rounded-md border p-3 text-sm" data-testid="hr-overtime-queue-row">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{r.employeeName}</span>
                    {r.departmentName && <Badge variant="outline">{r.departmentName}</Badge>}
                    <span>
                      {f.date(r.workDate)} · {tm('hoursUnit', { hours: r.hours })}
                    </span>
                    <Badge variant="outline">{tm(`dayTypes.${r.dayType}`)}</Badge>
                    <Badge variant="warning" data-testid="hr-overtime-commentary-badge">
                      {t('commentaryBadge', { percent: String(r.multiplierPercent) })}
                    </Badge>
                    <Badge variant={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'destructive' : 'secondary'}>
                      {t(`statuses.${r.status}`)}
                    </Badge>
                  </div>
                </div>
                {r.reason && <p className="text-xs text-subtle-foreground">{r.reason}</p>}
                {r.decisionNote && <p className="text-xs text-muted-foreground">{r.decisionNote}</p>}
                {pending && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className={`min-w-48 flex-1 ${PHONE_TARGET}`}
                      aria-label={t('notePlaceholder')}
                      placeholder={t('notePlaceholder')}
                      value={notes[r.id] ?? ''}
                      onChange={(ev) => setNotes((cur) => ({ ...cur, [r.id]: ev.target.value }))}
                      data-testid="hr-overtime-queue-note"
                    />
                    {r.status === 'pending_l1' && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className={PHONE_TARGET}
                        loading={approveL1.isPending && approveL1.variables?.requestId === r.id}
                        onClick={() => approveL1.mutate({ requestId: r.id, ...(note ? { note } : {}) })}
                        data-testid="hr-overtime-queue-approve-l1"
                      >
                        {t('approveL1')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      className={PHONE_TARGET}
                      loading={approveFinal.isPending && approveFinal.variables?.requestId === r.id}
                      onClick={() => approveFinal.mutate({ requestId: r.id, ...(note ? { note } : {}) })}
                      data-testid="hr-overtime-queue-approve-final"
                    >
                      {t('approveFinal')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className={PHONE_TARGET}
                      loading={reject.isPending && reject.variables?.requestId === r.id}
                      onClick={() => reject.mutate({ requestId: r.id, ...(note ? { note } : {}) })}
                      data-testid="hr-overtime-queue-reject"
                    >
                      {t('reject')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

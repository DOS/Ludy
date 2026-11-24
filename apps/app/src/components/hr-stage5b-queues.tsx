// SPDX-License-Identifier: AGPL-3.0-only
// Owner/admin HR review queues for employee onboarding confirmations and 2-level overtime (OT) requests (#4448, Stage 5B).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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
import { cn } from '@ludy/ui/lib/utils';
import { HrApprovalPeekSheet } from './hr-approval-peek.tsx';
import { ErrorText, TableSkeleton } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { useListPeekNav } from '../lib/list-peek-nav.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const PHONE_TARGET = 'max-md:min-h-11';
const PHONE_SELECT_TARGET = 'max-md:min-h-11 [&_select]:max-md:min-h-11';

const refreshHr = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });

export function HrOnboardingReviewQueue() {
  const t = useTranslations('hrEmployees.onboardingQueue');
  const th = useTranslations('hrEmployees');
  const f = useFormat();
  const [statusFilter, setStatusFilter] = useState<HrOnboardingStatus | ''>('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);

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
  const peek = useListPeekNav({
    items: rows,
    getId: (row) => row.id,
    containerRef: listRef,
    resetKey: statusFilter,
  });
  const activeRow = peek.activeItem;

  useEffect(() => {
    approve.reset?.();
    reject.reset?.();
  }, [activeRow?.id]);

  const describeOnboarding = (r: HrOnboardingSubmissionView) => {
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
    return { confirmedItems, updatedFields };
  };

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
        <div ref={listRef} className="space-y-2">
          {rows.map((r) => {
            const note = notes[r.id]?.trim() || undefined;
            const { confirmedItems, updatedFields } = describeOnboarding(r);
            const selected = peek.selectedId === r.id;
            return (
              <div
                key={r.id}
                data-peek-row={r.id}
                data-selected={selected ? 'true' : undefined}
                onClick={(event) => peek.onRowClick(r.id, event)}
                className={cn(
                  'cursor-pointer space-y-2 rounded-md border p-3 text-sm transition-colors',
                  selected ? 'border-primary/50 bg-primary/5' : 'hover:bg-muted/40',
                )}
                data-testid="hr-onboarding-queue-row"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{r.employeeName}</span>
                    {r.departmentName && <Badge variant="outline">{r.departmentName}</Badge>}
                    <Badge variant={r.status === 'approved' ? 'success' : r.status === 'rejected' ? 'destructive' : 'secondary'}>
                      {t(`statuses.${r.status}`)}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{f.dateTime(r.createdAt)}</span>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      data-peek-trigger={r.id}
                      data-testid="hr-onboarding-queue-peek-btn"
                      aria-label={th('peek.inspectOf', { name: r.employeeName })}
                      onClick={() => peek.openPeek(r.id)}
                    >
                      {th('peek.inspect')}
                    </Button>
                  </div>
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
                      disabled={approve.isPending || reject.isPending}
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
                      disabled={approve.isPending || reject.isPending}
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
      {activeRow ? (() => {
        const { confirmedItems, updatedFields } = describeOnboarding(activeRow);
        const note = notes[activeRow.id]?.trim() || undefined;
        return (
          <HrApprovalPeekSheet
            peek={peek}
            testId="hr-onboarding-peek-sheet"
            title={activeRow.employeeName}
            description={activeRow.departmentName}
            badges={
              <Badge variant={activeRow.status === 'approved' ? 'success' : activeRow.status === 'rejected' ? 'destructive' : 'secondary'}>
                {t(`statuses.${activeRow.status}`)}
              </Badge>
            }
            fields={[
              { label: th('peek.employee'), value: activeRow.employeeName },
              ...(activeRow.departmentName ? [{ label: th('peek.department'), value: activeRow.departmentName }] : []),
              { label: th('peek.status'), value: t(`statuses.${activeRow.status}`) },
              { label: th('peek.submittedAt'), value: f.dateTime(activeRow.createdAt), mono: true },
              {
                label: t('title'),
                value: updatedFields.length > 0 ? updatedFields.join(' · ') : t('noFieldsHint'),
                span2: true,
              },
              ...(confirmedItems.length > 0
                ? [{ label: th('peek.details'), value: t('itemsConfirmed', { items: confirmedItems.join(', ') }), span2: true }]
                : []),
              ...(activeRow.note ? [{ label: th('peek.reason'), value: activeRow.note, span2: true }] : []),
              ...(activeRow.decisionNote ? [{ label: th('peek.decisionNote'), value: activeRow.decisionNote, span2: true }] : []),
            ]}
            noteSection={
              activeRow.status === 'pending'
                ? {
                    id: `hr-onboarding-peek-note-${activeRow.id}`,
                    value: notes[activeRow.id] ?? '',
                    placeholder: t('notePlaceholder'),
                    onChange: (next) => setNotes((cur) => ({ ...cur, [activeRow.id]: next })),
                    testId: 'hr-onboarding-peek-note',
                  }
                : null
            }
            errorMessage={
              approve.error || reject.error ? errorMessage(approve.error ?? reject.error) : null
            }
            actions={
              activeRow.status === 'pending'
                ? [
                    {
                      label: t('reject'),
                      variant: 'outline',
                      disabled: approve.isPending || reject.isPending,
                      loading: reject.isPending && reject.variables?.submissionId === activeRow.id,
                      onClick: () => reject.mutate({ submissionId: activeRow.id, ...(note ? { note } : {}) }),
                      testId: 'hr-onboarding-peek-reject',
                    },
                    {
                      label: t('approve'),
                      variant: 'default',
                      disabled: approve.isPending || reject.isPending,
                      loading: approve.isPending && approve.variables?.submissionId === activeRow.id,
                      onClick: () => approve.mutate({ submissionId: activeRow.id, ...(note ? { note } : {}) }),
                      testId: 'hr-onboarding-peek-approve',
                    },
                  ]
                : []
            }
          />
        );
      })() : null}
    </Card>
  );
}

export function HrOvertimeReviewQueue() {
  const t = useTranslations('hrEmployees.overtimeQueue');
  const th = useTranslations('hrEmployees');
  const tm = useTranslations('hrMy.overtime');
  const f = useFormat();
  const [statusFilter, setStatusFilter] = useState<HrOvertimeStatus | ''>('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const listRef = useRef<HTMLDivElement>(null);

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
  const peek = useListPeekNav({
    items: rows,
    getId: (row) => row.id,
    containerRef: listRef,
    resetKey: statusFilter,
  });
  const activeRow = peek.activeItem;

  useEffect(() => {
    approveL1.reset?.();
    approveFinal.reset?.();
    reject.reset?.();
  }, [activeRow?.id]);

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
        <div ref={listRef} className="space-y-2">
          {rows.map((r) => {
            const note = notes[r.id]?.trim() || undefined;
            const pending = r.status === 'pending_l1' || r.status === 'pending_final';
            const selected = peek.selectedId === r.id;
            return (
              <div
                key={r.id}
                data-peek-row={r.id}
                data-selected={selected ? 'true' : undefined}
                onClick={(event) => peek.onRowClick(r.id, event)}
                className={cn(
                  'cursor-pointer space-y-2 rounded-md border p-3 text-sm transition-colors',
                  selected ? 'border-primary/50 bg-primary/5' : 'hover:bg-muted/40',
                )}
                data-testid="hr-overtime-queue-row"
              >
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
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    data-peek-trigger={r.id}
                    data-testid="hr-overtime-queue-peek-btn"
                    aria-label={th('peek.inspectOf', { name: r.employeeName })}
                    onClick={() => peek.openPeek(r.id)}
                  >
                    {th('peek.inspect')}
                  </Button>
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
                        disabled={approveL1.isPending || approveFinal.isPending || reject.isPending}
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
                      disabled={approveL1.isPending || approveFinal.isPending || reject.isPending}
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
                      disabled={approveL1.isPending || approveFinal.isPending || reject.isPending}
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
      {activeRow ? (() => {
        const pending = activeRow.status === 'pending_l1' || activeRow.status === 'pending_final';
        const note = notes[activeRow.id]?.trim() || undefined;
        return (
          <HrApprovalPeekSheet
            peek={peek}
            testId="hr-overtime-peek-sheet"
            title={activeRow.employeeName}
            description={`${f.date(activeRow.workDate)} · ${tm('hoursUnit', { hours: activeRow.hours })}`}
            badges={
              <>
                <Badge variant="outline">{tm(`dayTypes.${activeRow.dayType}`)}</Badge>
                <Badge variant="warning">{t('commentaryBadge', { percent: String(activeRow.multiplierPercent) })}</Badge>
                <Badge variant={activeRow.status === 'approved' ? 'success' : activeRow.status === 'rejected' ? 'destructive' : 'secondary'}>
                  {t(`statuses.${activeRow.status}`)}
                </Badge>
              </>
            }
            fields={[
              { label: th('peek.employee'), value: activeRow.employeeName },
              ...(activeRow.departmentName ? [{ label: th('peek.department'), value: activeRow.departmentName }] : []),
              { label: th('peek.status'), value: t(`statuses.${activeRow.status}`) },
              {
                label: tm('hours'),
                value: `${f.date(activeRow.workDate)} · ${tm('hoursUnit', { hours: activeRow.hours })}`,
                mono: true,
              },
              ...(activeRow.reason ? [{ label: th('peek.reason'), value: activeRow.reason, span2: true }] : []),
              ...(activeRow.decisionNote ? [{ label: th('peek.decisionNote'), value: activeRow.decisionNote, span2: true }] : []),
            ]}
            noteSection={
              pending
                ? {
                    id: `hr-overtime-peek-note-${activeRow.id}`,
                    value: notes[activeRow.id] ?? '',
                    placeholder: t('notePlaceholder'),
                    onChange: (next) => setNotes((cur) => ({ ...cur, [activeRow.id]: next })),
                    testId: 'hr-overtime-peek-note',
                  }
                : null
            }
            errorMessage={
              approveL1.error || approveFinal.error || reject.error
                ? errorMessage(approveL1.error ?? approveFinal.error ?? reject.error)
                : null
            }
            actions={
              pending
                ? [
                    ...(activeRow.status === 'pending_l1'
                      ? [
                          {
                            label: t('approveL1'),
                            variant: 'outline' as const,
                            disabled: approveL1.isPending || approveFinal.isPending || reject.isPending,
                            loading: approveL1.isPending && approveL1.variables?.requestId === activeRow.id,
                            onClick: () => approveL1.mutate({ requestId: activeRow.id, ...(note ? { note } : {}) }),
                            testId: 'hr-overtime-peek-approve-l1',
                          },
                        ]
                      : []),
                    {
                      label: t('reject'),
                      variant: 'outline',
                      disabled: approveL1.isPending || approveFinal.isPending || reject.isPending,
                      loading: reject.isPending && reject.variables?.requestId === activeRow.id,
                      onClick: () => reject.mutate({ requestId: activeRow.id, ...(note ? { note } : {}) }),
                      testId: 'hr-overtime-peek-reject',
                    },
                    {
                      label: t('approveFinal'),
                      variant: 'default',
                      disabled: approveL1.isPending || approveFinal.isPending || reject.isPending,
                      loading: approveFinal.isPending && approveFinal.variables?.requestId === activeRow.id,
                      onClick: () => approveFinal.mutate({ requestId: activeRow.id, ...(note ? { note } : {}) }),
                      testId: 'hr-overtime-peek-approve-final',
                    },
                  ]
                : []
            }
          />
        );
      })() : null}
    </Card>
  );
}

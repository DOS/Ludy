// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 6B UI components (#4527): self-service salary advances & business trips (/hr/my),
// manager approval queues (/hr/employees), and retro/offset adjustment panel (/hr/payroll).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { useTranslations } from 'use-intl';
import {
  HR_PAYROLL_ADJUSTMENT_KINDS,
  vietnamToday,
  type HrAdvanceRequestView,
  type HrAdjustmentItemView,
  type HrPayrollAdjustmentKind,
  type HrSelfAdvanceSubmitResult,
  type HrSelfTripSubmitResult,
  type HrTripRequestView,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { cn } from '@ludy/ui/lib/utils';
import { HrApprovalPeekSheet } from './hr-approval-peek.tsx';
import { ErrorText } from './ui.tsx';
import { useFormat } from '../i18n/provider.tsx';
import { client, errorMessage, orpc, queryClient } from '../lib/api.ts';
import { useListPeekNav } from '../lib/list-peek-nav.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const PHONE_SELECT_TARGET = 'max-md:min-h-11 [&_select]:max-md:min-h-11';

const STATUS_BADGE = {
  pending: 'warning',
  pending_l1: 'warning',
  pending_final: 'secondary',
  approved: 'success',
  rejected: 'destructive',
  cancelled: 'outline',
} as const;

const invalidateHr = () => queryClient.invalidateQueries({ queryKey: orpc.hr.key() });

const normalizeAmount = (raw: string) => raw.replaceAll(',', '.').replace(/[^\d.]/g, '');
const optionalNote = (notes: Record<string, string>, id: string): { note?: string } => {
  const trimmed = notes[id]?.trim();
  return trimmed ? { note: trimmed } : {};
};

function ApprovalQueueRow(props: {
  id: string;
  testId: string;
  title: ReactNode;
  subtitle: ReactNode;
  status: keyof typeof STATUS_BADGE;
  statusLabel: string;
  noteValue: string;
  notePlaceholder: string;
  onNoteChange: (val: string) => void;
  canApproveL1: boolean;
  canApproveFinal: boolean;
  lockedNotice?: string | undefined;
  busy: boolean;
  l1Loading?: boolean;
  finalLoading?: boolean;
  rejectLoading?: boolean;
  l1Label: string;
  finalLabel: string;
  rejectLabel: string;
  onApproveL1: () => void;
  onApproveFinal: () => void;
  onReject: () => void;
  selected?: boolean;
  inspectLabel?: string;
  inspectAriaLabel?: string;
  onInspect?: () => void;
  onRowClick?: (event: MouseEvent<HTMLElement>) => void;
}) {
  return (
    <div
      data-peek-row={props.id}
      data-selected={props.selected ? 'true' : undefined}
      onClick={props.onRowClick}
      className={cn(
        'space-y-2 rounded-md border p-3 text-sm transition-colors',
        props.onRowClick ? 'cursor-pointer' : undefined,
        props.selected ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-muted/40',
      )}
      data-testid={props.testId}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">{props.title}</div>
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_BADGE[props.status]}>{props.statusLabel}</Badge>
          {props.onInspect && props.inspectLabel ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              data-peek-trigger={props.id}
              data-testid={`${props.testId}-peek-btn`}
              aria-label={props.inspectAriaLabel ?? props.inspectLabel}
              onClick={props.onInspect}
            >
              {props.inspectLabel}
            </Button>
          ) : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{props.subtitle}</p>
      {props.lockedNotice && (
        <p className="text-xs font-medium text-warning" data-testid={`${props.testId}-locked`}>
          {props.lockedNotice}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Input
          aria-label={props.notePlaceholder}
          placeholder={props.notePlaceholder}
          value={props.noteValue}
          onChange={(e) => props.onNoteChange(e.target.value)}
          className={`min-w-48 flex-1 ${PHONE_TARGET}`}
          data-testid={`${props.testId}-note`}
        />
        {props.canApproveL1 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            loading={props.l1Loading ?? false}
            disabled={props.busy}
            className={PHONE_TARGET}
            onClick={props.onApproveL1}
            data-testid={`${props.testId}-l1`}
          >
            {props.l1Label}
          </Button>
        )}
        {props.canApproveFinal && (
          <Button
            type="button"
            size="sm"
            loading={props.finalLoading ?? false}
            disabled={props.busy}
            className={PHONE_TARGET}
            onClick={props.onApproveFinal}
            data-testid={`${props.testId}-final`}
          >
            {props.finalLabel}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          loading={props.rejectLoading ?? false}
          disabled={props.busy}
          className={PHONE_TARGET}
          onClick={props.onReject}
          data-testid={`${props.testId}-reject`}
        >
          {props.rejectLabel}
        </Button>
      </div>
    </div>
  );
}

export function HrSelfAdvanceTripCards({ linked }: { linked: boolean }) {
  const t = useTranslations('hrMy.stage6b');
  const th = useTranslations('hrEmployees');
  const f = useFormat();
  const today = vietnamToday();
  const currentMonth = today.slice(0, 7);
  const advL1Ref = useRef<HTMLDivElement>(null);
  const tripL1Ref = useRef<HTMLDivElement>(null);

  // Salary advance state
  const [advMonth, setAdvMonth] = useState(currentMonth);
  const [advAmount, setAdvAmount] = useState('1000000');
  const [advReason, setAdvReason] = useState('');
  const [advLastSubmit, setAdvLastSubmit] = useState<HrSelfAdvanceSubmitResult | null>(null);
  const [advNotes, setAdvNotes] = useState<Record<string, string>>({});

  // Business trip state
  const [tripDestination, setTripDestination] = useState('');
  const [tripPurpose, setTripPurpose] = useState('');
  const [tripStartOn, setTripStartOn] = useState(today);
  const [tripEndOn, setTripEndOn] = useState(today);
  const [tripAllowance, setTripAllowance] = useState('0');
  const [tripLastSubmit, setTripLastSubmit] = useState<HrSelfTripSubmitResult | null>(null);
  const [tripNotes, setTripNotes] = useState<Record<string, string>>({});

  const advList = useQuery({
    ...orpc.hr.self.salaryAdvance.list.queryOptions({ input: { limit: 100 } }),
    ...ONCE,
  });

  const tripList = useQuery({
    ...orpc.hr.self.businessTrips.list.queryOptions({ input: { limit: 100 } }),
    ...ONCE,
  });

  const submitAdvance = useMutation({
    mutationFn: () =>
      client.hr.self.salaryAdvance.submit({
        month: advMonth.trim(),
        amount: advAmount.trim(),
        reason: advReason.trim(),
      }),
    onSuccess: async (res) => {
      setAdvLastSubmit(res);
      setAdvReason('');
      await invalidateHr();
    },
  });

  const cancelAdvance = useMutation({
    mutationFn: (requestId: string) => client.hr.self.salaryAdvance.cancel({ requestId }),
    onSuccess: invalidateHr,
  });

  const advL1Decide = useMutation({
    mutationFn: ({ requestId, approve, note }: { requestId: string; approve: boolean; note?: string }) =>
      approve
        ? client.hr.salaryAdvances.approveL1({ requestId, ...(note ? { note } : {}) })
        : client.hr.salaryAdvances.reject({ requestId, ...(note ? { note } : {}) }),
    onSuccess: invalidateHr,
  });

  const submitTrip = useMutation({
    mutationFn: () =>
      client.hr.self.businessTrips.submit({
        destination: tripDestination.trim(),
        purpose: tripPurpose.trim(),
        startOn: tripStartOn,
        endOn: tripEndOn,
        estimatedAllowance: tripAllowance.trim() || '0',
      }),
    onSuccess: async (res) => {
      setTripLastSubmit(res);
      setTripDestination('');
      setTripPurpose('');
      setTripAllowance('0');
      await invalidateHr();
    },
  });

  const cancelTrip = useMutation({
    mutationFn: (requestId: string) => client.hr.self.businessTrips.cancel({ requestId }),
    onSuccess: invalidateHr,
  });

  const tripL1Decide = useMutation({
    mutationFn: ({ requestId, approve, note }: { requestId: string; approve: boolean; note?: string }) =>
      approve
        ? client.hr.businessTrips.approveL1({ requestId, ...(note ? { note } : {}) })
        : client.hr.businessTrips.reject({ requestId, ...(note ? { note } : {}) }),
    onSuccess: invalidateHr,
  });

  const handleSubmitAdvance = (e: FormEvent) => {
    e.preventDefault();
    submitAdvance.mutate();
  };

  const handleSubmitTrip = (e: FormEvent) => {
    e.preventDefault();
    submitTrip.mutate();
  };

  const advances = advList.data?.items ?? [];
  const advL1Queue = advList.data?.l1Queue ?? [];
  const trips = tripList.data?.items ?? [];
  const tripL1Queue = tripList.data?.l1Queue ?? [];

  const advL1Peek = useListPeekNav({
    items: advL1Queue,
    getId: (item) => item.id,
    containerRef: advL1Ref,
    enabled: advL1Queue.length > 0,
  });
  const activeSelfAdvance = advL1Peek.activeItem;

  const tripL1Peek = useListPeekNav({
    items: tripL1Queue,
    getId: (item) => item.id,
    containerRef: tripL1Ref,
    enabled: tripL1Queue.length > 0,
  });
  const activeSelfTrip = tripL1Peek.activeItem;

  useEffect(() => {
    advL1Decide.reset?.();
  }, [activeSelfAdvance?.id]);

  useEffect(() => {
    tripL1Decide.reset?.();
  }, [activeSelfTrip?.id]);

  return (
    <div className="space-y-6">
      <Card className="p-6" data-testid="hr-self-advance-card">
        <div className="mb-4">
          <h2 className="text-base font-semibold">{t('advanceTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('advanceSubtitle')}</p>
        </div>

        {linked && (
          <form onSubmit={handleSubmitAdvance} className="mb-6 grid gap-3 sm:grid-cols-3" data-testid="hr-self-advance-form">
            <div className="space-y-1">
              <Label htmlFor="adv-month">{t('advanceMonthLabel')}</Label>
              <Input
                id="adv-month"
                value={advMonth}
                onChange={(e) => setAdvMonth(e.target.value)}
                placeholder="YYYY-MM"
                className={PHONE_TARGET}
                data-testid="hr-self-advance-month"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="adv-amount">{t('advanceAmountLabel')}</Label>
              <Input
                id="adv-amount"
                inputMode="decimal"
                value={advAmount}
                onChange={(e) => setAdvAmount(normalizeAmount(e.target.value))}
                className={PHONE_TARGET}
                data-testid="hr-self-advance-amount"
              />
            </div>
            <div className="space-y-1 sm:col-span-3">
              <Label htmlFor="adv-reason">{t('advanceReasonLabel')}</Label>
              <Input
                id="adv-reason"
                value={advReason}
                maxLength={2000}
                onChange={(e) => setAdvReason(e.target.value)}
                placeholder={t('advanceReasonPlaceholder')}
                className={PHONE_TARGET}
                data-testid="hr-self-advance-reason"
              />
            </div>
            <div className="sm:col-span-3 flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                size="sm"
                loading={submitAdvance.isPending}
                disabled={advReason.trim() === '' || advAmount.trim() === ''}
                className={PHONE_TARGET}
                data-testid="hr-self-advance-submit"
              >
                {t('advanceSubmit')}
              </Button>
              {advLastSubmit && (
                <span className="text-xs text-muted-foreground">
                  {t('submittedStatus', { status: t(`statuses.${advLastSubmit.status}`) })}
                </span>
              )}
              {submitAdvance.error && <ErrorText>{errorMessage(submitAdvance.error)}</ErrorText>}
            </div>
          </form>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('advanceMyTitle')}</h3>
          {advList.error && <ErrorText>{errorMessage(advList.error)}</ErrorText>}
          {advances.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('advanceMyEmpty')}</p>
          ) : (
            <div className="space-y-2">
              {advances.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
                  data-testid="hr-self-advance-item"
                >
                  <div>
                    <div className="font-medium">
                      {item.month} | <span className="tabular-nums">{f.money(item.amount, 'VND')}</span>
                    </div>
                    {item.reason && <p className="text-xs text-muted-foreground">{item.reason}</p>}
                    {item.decisionNote && (
                      <p className="text-xs text-muted-foreground">{t('decisionNotePrefix', { note: item.decisionNote })}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_BADGE[item.status]}>{t(`statuses.${item.status}`)}</Badge>
                    {item.canCancel && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={cancelAdvance.isPending}
                        className={PHONE_TARGET}
                        onClick={() => cancelAdvance.mutate(item.id)}
                        data-testid="hr-self-advance-cancel"
                      >
                        {t('cancel')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {cancelAdvance.error && <ErrorText>{errorMessage(cancelAdvance.error)}</ErrorText>}
        </div>

        {advL1Queue.length > 0 && (
          <div ref={advL1Ref} className="mt-6 space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">{t('advanceTeamTitle')}</h3>
            {advL1Queue.map((item) => (
              <ApprovalQueueRow
                key={item.id}
                id={item.id}
                testId="hr-self-advance-l1-item"
                title={
                  <>
                    {item.employeeName} | {item.month} | <span className="tabular-nums">{f.money(item.amount, 'VND')}</span>
                  </>
                }
                subtitle={item.reason ?? item.departmentName ?? ''}
                status={item.status}
                statusLabel={t(`statuses.${item.status}`)}
                noteValue={advNotes[item.id] ?? ''}
                notePlaceholder={t('notePlaceholder')}
                onNoteChange={(val) => setAdvNotes((prev) => ({ ...prev, [item.id]: val }))}
                canApproveL1={item.canApproveL1}
                canApproveFinal={false}
                busy={advL1Decide.isPending}
                l1Loading={advL1Decide.isPending && advL1Decide.variables?.requestId === item.id && advL1Decide.variables.approve}
                rejectLoading={advL1Decide.isPending && advL1Decide.variables?.requestId === item.id && !advL1Decide.variables.approve}
                l1Label={t('approveL1')}
                finalLabel={t('approveFinal')}
                rejectLabel={t('reject')}
                selected={advL1Peek.selectedId === item.id}
                inspectLabel={th('peek.inspect')}
                inspectAriaLabel={th('peek.inspectOf', { name: item.employeeName })}
                onInspect={() => advL1Peek.openPeek(item.id)}
                onRowClick={(event) => advL1Peek.onRowClick(item.id, event)}
                onApproveL1={() =>
                  advL1Decide.mutate({ requestId: item.id, approve: true, ...optionalNote(advNotes, item.id) })
                }
                onApproveFinal={() => undefined}
                onReject={() =>
                  advL1Decide.mutate({ requestId: item.id, approve: false, ...optionalNote(advNotes, item.id) })
                }
              />
            ))}
            {advL1Decide.error && <ErrorText>{errorMessage(advL1Decide.error)}</ErrorText>}
            {activeSelfAdvance ? (
              <HrApprovalPeekSheet
                peek={advL1Peek}
                testId="hr-self-advance-peek-sheet"
                title={activeSelfAdvance.employeeName}
                description={`${activeSelfAdvance.month} · ${f.money(activeSelfAdvance.amount, 'VND')}`}
                badges={<Badge variant={STATUS_BADGE[activeSelfAdvance.status]}>{t(`statuses.${activeSelfAdvance.status}`)}</Badge>}
                fields={[
                  { label: th('peek.employee'), value: activeSelfAdvance.employeeName },
                  ...(activeSelfAdvance.departmentName
                    ? [{ label: th('peek.department'), value: activeSelfAdvance.departmentName }]
                    : []),
                  { label: th('peek.status'), value: t(`statuses.${activeSelfAdvance.status}`) },
                  { label: t('advanceAmountLabel'), value: f.money(activeSelfAdvance.amount, 'VND'), mono: true },
                  { label: t('advanceMonthLabel'), value: activeSelfAdvance.month, mono: true },
                  ...(activeSelfAdvance.reason ? [{ label: th('peek.reason'), value: activeSelfAdvance.reason, span2: true }] : []),
                ]}
                noteSection={{
                  id: `hr-self-advance-peek-note-${activeSelfAdvance.id}`,
                  value: advNotes[activeSelfAdvance.id] ?? '',
                  placeholder: t('notePlaceholder'),
                  onChange: (val) => setAdvNotes((prev) => ({ ...prev, [activeSelfAdvance.id]: val })),
                  testId: 'hr-self-advance-peek-note',
                }}
                errorMessage={advL1Decide.error ? errorMessage(advL1Decide.error) : null}
                actions={[
                  {
                    label: t('reject'),
                    variant: 'outline',
                    disabled: advL1Decide.isPending,
                    loading:
                      advL1Decide.isPending &&
                      advL1Decide.variables?.requestId === activeSelfAdvance.id &&
                      !advL1Decide.variables.approve,
                    onClick: () =>
                      advL1Decide.mutate({
                        requestId: activeSelfAdvance.id,
                        approve: false,
                        ...optionalNote(advNotes, activeSelfAdvance.id),
                      }),
                    testId: 'hr-self-advance-peek-reject',
                  },
                  ...(activeSelfAdvance.canApproveL1
                    ? [
                        {
                          label: t('approveL1'),
                          variant: 'default' as const,
                          disabled: advL1Decide.isPending,
                          loading:
                            advL1Decide.isPending &&
                            advL1Decide.variables?.requestId === activeSelfAdvance.id &&
                            advL1Decide.variables.approve,
                          onClick: () =>
                            advL1Decide.mutate({
                              requestId: activeSelfAdvance.id,
                              approve: true,
                              ...optionalNote(advNotes, activeSelfAdvance.id),
                            }),
                          testId: 'hr-self-advance-peek-approve-l1',
                        },
                      ]
                    : []),
                ]}
              />
            ) : null}
          </div>
        )}
      </Card>

      <Card className="p-6" data-testid="hr-self-trip-card">
        <div className="mb-4">
          <h2 className="text-base font-semibold">{t('tripTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('tripSubtitle')}</p>
        </div>

        {linked && (
          <form onSubmit={handleSubmitTrip} className="mb-6 grid gap-3 sm:grid-cols-2" data-testid="hr-self-trip-form">
            <div className="space-y-1">
              <Label htmlFor="trip-dest">{t('tripDestinationLabel')}</Label>
              <Input
                id="trip-dest"
                value={tripDestination}
                maxLength={200}
                onChange={(e) => setTripDestination(e.target.value)}
                placeholder={t('tripDestinationPlaceholder')}
                className={PHONE_TARGET}
                data-testid="hr-self-trip-destination"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="trip-allowance">{t('tripAllowanceLabel')}</Label>
              <Input
                id="trip-allowance"
                inputMode="decimal"
                value={tripAllowance}
                onChange={(e) => setTripAllowance(normalizeAmount(e.target.value))}
                className={PHONE_TARGET}
                data-testid="hr-self-trip-allowance"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="trip-start">{t('tripStartLabel')}</Label>
              <Input
                id="trip-start"
                type="date"
                value={tripStartOn}
                onChange={(e) => setTripStartOn(e.target.value)}
                className={PHONE_TARGET}
                data-testid="hr-self-trip-start"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="trip-end">{t('tripEndLabel')}</Label>
              <Input
                id="trip-end"
                type="date"
                value={tripEndOn}
                onChange={(e) => setTripEndOn(e.target.value)}
                className={PHONE_TARGET}
                data-testid="hr-self-trip-end"
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="trip-purpose">{t('tripPurposeLabel')}</Label>
              <Input
                id="trip-purpose"
                value={tripPurpose}
                maxLength={2000}
                onChange={(e) => setTripPurpose(e.target.value)}
                placeholder={t('tripPurposePlaceholder')}
                className={PHONE_TARGET}
                data-testid="hr-self-trip-purpose"
              />
            </div>
            <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
              <Button
                type="submit"
                size="sm"
                loading={submitTrip.isPending}
                disabled={tripDestination.trim() === '' || tripPurpose.trim() === ''}
                className={PHONE_TARGET}
                data-testid="hr-self-trip-submit"
              >
                {t('tripSubmit')}
              </Button>
              {tripLastSubmit && (
                <span className="text-xs text-muted-foreground">
                  {t('submittedStatus', { status: t(`statuses.${tripLastSubmit.status}`) })}
                </span>
              )}
              {submitTrip.error && <ErrorText>{errorMessage(submitTrip.error)}</ErrorText>}
            </div>
          </form>
        )}

        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('tripMyTitle')}</h3>
          {tripList.error && <ErrorText>{errorMessage(tripList.error)}</ErrorText>}
          {trips.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('tripMyEmpty')}</p>
          ) : (
            <div className="space-y-2">
              {trips.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
                  data-testid="hr-self-trip-item"
                >
                  <div>
                    <div className="font-medium">
                      {item.destination ?? '-'} | {item.startOn} - {item.endOn}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {item.purpose ?? ''} | <span className="tabular-nums">{f.money(item.estimatedAllowance, 'VND')}</span>
                    </p>
                    {item.decisionNote && (
                      <p className="text-xs text-muted-foreground">{t('decisionNotePrefix', { note: item.decisionNote })}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_BADGE[item.status]}>{t(`statuses.${item.status}`)}</Badge>
                    {item.canCancel && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={cancelTrip.isPending}
                        className={PHONE_TARGET}
                        onClick={() => cancelTrip.mutate(item.id)}
                        data-testid="hr-self-trip-cancel"
                      >
                        {t('cancel')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {cancelTrip.error && <ErrorText>{errorMessage(cancelTrip.error)}</ErrorText>}
        </div>

        {tripL1Queue.length > 0 && (
          <div ref={tripL1Ref} className="mt-6 space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium">{t('tripTeamTitle')}</h3>
            {tripL1Queue.map((item) => (
              <ApprovalQueueRow
                key={item.id}
                id={item.id}
                testId="hr-self-trip-l1-item"
                title={
                  <>
                    {item.employeeName} | {item.destination ?? '-'} | {item.startOn} - {item.endOn}
                  </>
                }
                subtitle={item.purpose ?? ''}
                status={item.status}
                statusLabel={t(`statuses.${item.status}`)}
                noteValue={tripNotes[item.id] ?? ''}
                notePlaceholder={t('notePlaceholder')}
                onNoteChange={(val) => setTripNotes((prev) => ({ ...prev, [item.id]: val }))}
                canApproveL1={item.canApproveL1}
                canApproveFinal={false}
                busy={tripL1Decide.isPending}
                l1Loading={tripL1Decide.isPending && tripL1Decide.variables?.requestId === item.id && tripL1Decide.variables.approve}
                rejectLoading={tripL1Decide.isPending && tripL1Decide.variables?.requestId === item.id && !tripL1Decide.variables.approve}
                l1Label={t('approveL1')}
                finalLabel={t('approveFinal')}
                rejectLabel={t('reject')}
                selected={tripL1Peek.selectedId === item.id}
                inspectLabel={th('peek.inspect')}
                inspectAriaLabel={th('peek.inspectOf', { name: item.employeeName })}
                onInspect={() => tripL1Peek.openPeek(item.id)}
                onRowClick={(event) => tripL1Peek.onRowClick(item.id, event)}
                onApproveL1={() =>
                  tripL1Decide.mutate({ requestId: item.id, approve: true, ...optionalNote(tripNotes, item.id) })
                }
                onApproveFinal={() => undefined}
                onReject={() =>
                  tripL1Decide.mutate({ requestId: item.id, approve: false, ...optionalNote(tripNotes, item.id) })
                }
              />
            ))}
            {tripL1Decide.error && <ErrorText>{errorMessage(tripL1Decide.error)}</ErrorText>}
            {activeSelfTrip ? (
              <HrApprovalPeekSheet
                peek={tripL1Peek}
                testId="hr-self-trip-peek-sheet"
                title={activeSelfTrip.employeeName}
                description={`${activeSelfTrip.destination ?? '-'} · ${activeSelfTrip.startOn} - ${activeSelfTrip.endOn}`}
                badges={<Badge variant={STATUS_BADGE[activeSelfTrip.status]}>{t(`statuses.${activeSelfTrip.status}`)}</Badge>}
                fields={[
                  { label: th('peek.employee'), value: activeSelfTrip.employeeName },
                  { label: th('peek.status'), value: t(`statuses.${activeSelfTrip.status}`) },
                  { label: t('tripDestinationLabel'), value: activeSelfTrip.destination ?? '-' },
                  { label: t('tripAllowanceLabel'), value: f.money(activeSelfTrip.estimatedAllowance, 'VND'), mono: true },
                  { label: t('tripStartLabel'), value: f.date(activeSelfTrip.startOn), mono: true },
                  { label: t('tripEndLabel'), value: f.date(activeSelfTrip.endOn), mono: true },
                  ...(activeSelfTrip.purpose ? [{ label: th('peek.reason'), value: activeSelfTrip.purpose, span2: true }] : []),
                ]}
                noteSection={{
                  id: `hr-self-trip-peek-note-${activeSelfTrip.id}`,
                  value: tripNotes[activeSelfTrip.id] ?? '',
                  placeholder: t('notePlaceholder'),
                  onChange: (val) => setTripNotes((prev) => ({ ...prev, [activeSelfTrip.id]: val })),
                  testId: 'hr-self-trip-peek-note',
                }}
                errorMessage={tripL1Decide.error ? errorMessage(tripL1Decide.error) : null}
                actions={[
                  {
                    label: t('reject'),
                    variant: 'outline',
                    disabled: tripL1Decide.isPending,
                    loading:
                      tripL1Decide.isPending &&
                      tripL1Decide.variables?.requestId === activeSelfTrip.id &&
                      !tripL1Decide.variables.approve,
                    onClick: () =>
                      tripL1Decide.mutate({
                        requestId: activeSelfTrip.id,
                        approve: false,
                        ...optionalNote(tripNotes, activeSelfTrip.id),
                      }),
                    testId: 'hr-self-trip-peek-reject',
                  },
                  ...(activeSelfTrip.canApproveL1
                    ? [
                        {
                          label: t('approveL1'),
                          variant: 'default' as const,
                          disabled: tripL1Decide.isPending,
                          loading:
                            tripL1Decide.isPending &&
                            tripL1Decide.variables?.requestId === activeSelfTrip.id &&
                            tripL1Decide.variables.approve,
                          onClick: () =>
                            tripL1Decide.mutate({
                              requestId: activeSelfTrip.id,
                              approve: true,
                              ...optionalNote(tripNotes, activeSelfTrip.id),
                            }),
                          testId: 'hr-self-trip-peek-approve-l1',
                        },
                      ]
                    : []),
                ]}
              />
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}

export function HrStage6bApprovalQueues(props: { entities?: readonly { id: string; name: string }[] } = {}) {
  const t = useTranslations('hrEmployees.stage6bQueues');
  const th = useTranslations('hrEmployees');
  const tm = useTranslations('hrMy.stage6b');
  const f = useFormat();
  const [legalEntityId, setLegalEntityId] = useState('');
  const [advNotes, setAdvNotes] = useState<Record<string, string>>({});
  const [tripNotes, setTripNotes] = useState<Record<string, string>>({});
  const [advSyncNotice, setAdvSyncNotice] = useState<'synced' | 'awaiting' | null>(null);
  const advQueueRef = useRef<HTMLDivElement>(null);
  const tripQueueRef = useRef<HTMLDivElement>(null);
  const entities = props.entities ?? [];
  const entityInput = legalEntityId ? { legalEntityId } : {};

  const advList = useQuery({
    ...orpc.hr.salaryAdvances.list.queryOptions({ input: { ...entityInput, limit: 100 } }),
    ...ONCE,
  });

  const tripList = useQuery({
    ...orpc.hr.businessTrips.list.queryOptions({ input: { ...entityInput, limit: 100 } }),
    ...ONCE,
  });

  const runsList = useQuery({
    ...orpc.hr.payroll.runs.list.queryOptions({ input: { ...entityInput, limit: 120 } }),
    ...ONCE,
  });

  const lockedRunMonths = new Set(
    (runsList.data ?? [])
      .filter((r) => r.status !== 'draft')
      .map((r) => `${r.legalEntityId}:${r.month}`),
  );

  const advDecide = useMutation({
    mutationFn: ({
      requestId,
      action,
      note,
    }: {
      requestId: string;
      action: 'l1' | 'final' | 'reject';
      note?: string;
    }) => {
      if (action === 'l1') return client.hr.salaryAdvances.approveL1({ requestId, ...(note ? { note } : {}) });
      if (action === 'final') return client.hr.salaryAdvances.approveFinal({ requestId, ...(note ? { note } : {}) });
      return client.hr.salaryAdvances.reject({ requestId, ...(note ? { note } : {}) });
    },
    onSuccess: async (res, vars) => {
      if (vars.action === 'final') {
        setAdvSyncNotice(res.payrollSynced ? 'synced' : 'awaiting');
      } else {
        setAdvSyncNotice(null);
      }
      await invalidateHr();
    },
  });

  const tripDecide = useMutation({
    mutationFn: ({
      requestId,
      action,
      note,
    }: {
      requestId: string;
      action: 'l1' | 'final' | 'reject';
      note?: string;
    }) => {
      if (action === 'l1') return client.hr.businessTrips.approveL1({ requestId, ...(note ? { note } : {}) });
      if (action === 'final') return client.hr.businessTrips.approveFinal({ requestId, ...(note ? { note } : {}) });
      return client.hr.businessTrips.reject({ requestId, ...(note ? { note } : {}) });
    },
    onSuccess: invalidateHr,
  });

  const pendingAdvances: HrAdvanceRequestView[] = (advList.data ?? []).filter(
    (r) => r.status === 'pending_l1' || r.status === 'pending_final',
  );
  const pendingTrips: HrTripRequestView[] = (tripList.data ?? []).filter(
    (r) => r.status === 'pending_l1' || r.status === 'pending_final',
  );
  const advPeek = useListPeekNav({
    items: pendingAdvances,
    getId: (item) => item.id,
    containerRef: advQueueRef,
    enabled: pendingAdvances.length > 0,
    resetKey: legalEntityId,
  });
  const activeAdvance = advPeek.activeItem;

  const tripPeek = useListPeekNav({
    items: pendingTrips,
    getId: (item) => item.id,
    containerRef: tripQueueRef,
    enabled: pendingTrips.length > 0,
    resetKey: legalEntityId,
  });
  const activeTrip = tripPeek.activeItem;

  useEffect(() => {
    advDecide.reset?.();
  }, [activeAdvance?.id]);

  useEffect(() => {
    tripDecide.reset?.();
  }, [activeTrip?.id]);

  return (
    <div className="mt-6 space-y-4">
      {entities.length > 1 && (
        <div className={`flex flex-wrap items-center gap-2 ${PHONE_SELECT_TARGET}`}>
          <Label htmlFor="stage6b-queue-entity" className="text-xs text-muted-foreground">
            {t('entityFilterLabel')}
          </Label>
          <NativeSelect
            id="stage6b-queue-entity"
            value={legalEntityId}
            onChange={(e) => {
              setLegalEntityId(e.target.value);
              setAdvSyncNotice(null);
            }}
            data-testid="hr-stage6b-queue-entity-filter"
          >
            <NativeSelectOption value="">{t('allEntities')}</NativeSelectOption>
            {entities.map((e) => (
              <NativeSelectOption key={e.id} value={e.id}>
                {e.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6" data-testid="hr-advance-queue">
          <div className="mb-4">
            <h3 className="text-base font-semibold">{t('advanceTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('advanceSubtitle')}</p>
          </div>
          {advList.error && <ErrorText>{errorMessage(advList.error)}</ErrorText>}
          {advSyncNotice && (
            <p className="mb-3 text-xs text-muted-foreground" data-testid="hr-advance-sync-notice">
              {advSyncNotice === 'synced' ? t('approvedSyncedRun') : t('approvedAwaitingRun')}
            </p>
          )}
          {pendingAdvances.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('advanceEmpty')}</p>
          ) : (
            <div ref={advQueueRef} className="space-y-3">
              {pendingAdvances.map((item) => {
                const runLocked = lockedRunMonths.has(`${item.legalEntityId}:${item.month}`);
                return (
                  <ApprovalQueueRow
                    key={item.id}
                    id={item.id}
                    testId="hr-advance-queue-row"
                    title={
                      <>
                        {item.employeeName} | {item.month} | <span className="tabular-nums">{f.money(item.amount, 'VND')}</span>
                      </>
                    }
                    subtitle={item.reason ?? item.departmentName ?? ''}
                    status={item.status}
                    statusLabel={tm(`statuses.${item.status}`)}
                    noteValue={advNotes[item.id] ?? ''}
                    notePlaceholder={t('notePlaceholder')}
                    onNoteChange={(val) => setAdvNotes((prev) => ({ ...prev, [item.id]: val }))}
                    canApproveL1={item.canApproveL1 && !runLocked}
                    canApproveFinal={item.canApproveFinal && !runLocked}
                    lockedNotice={runLocked ? t('runLockedNotice', { month: item.month }) : undefined}
                    busy={advDecide.isPending}
                    l1Loading={advDecide.isPending && advDecide.variables?.requestId === item.id && advDecide.variables.action === 'l1'}
                    finalLoading={advDecide.isPending && advDecide.variables?.requestId === item.id && advDecide.variables.action === 'final'}
                    rejectLoading={advDecide.isPending && advDecide.variables?.requestId === item.id && advDecide.variables.action === 'reject'}
                    l1Label={t('approveL1')}
                    finalLabel={t('approveFinal')}
                    rejectLabel={t('reject')}
                    selected={advPeek.selectedId === item.id}
                    inspectLabel={th('peek.inspect')}
                    inspectAriaLabel={th('peek.inspectOf', { name: item.employeeName })}
                    onInspect={() => advPeek.openPeek(item.id)}
                    onRowClick={(event) => advPeek.onRowClick(item.id, event)}
                    onApproveL1={() =>
                      advDecide.mutate({ requestId: item.id, action: 'l1', ...optionalNote(advNotes, item.id) })
                    }
                    onApproveFinal={() =>
                      advDecide.mutate({ requestId: item.id, action: 'final', ...optionalNote(advNotes, item.id) })
                    }
                    onReject={() =>
                      advDecide.mutate({ requestId: item.id, action: 'reject', ...optionalNote(advNotes, item.id) })
                    }
                  />
                );
              })}
            </div>
          )}
          {advDecide.error && <ErrorText>{errorMessage(advDecide.error)}</ErrorText>}
          {activeAdvance ? (() => {
            const runLocked = lockedRunMonths.has(`${activeAdvance.legalEntityId}:${activeAdvance.month}`);
            return (
              <HrApprovalPeekSheet
                peek={advPeek}
                testId="hr-advance-peek-sheet"
                title={activeAdvance.employeeName}
                description={`${activeAdvance.month} · ${f.money(activeAdvance.amount, 'VND')}`}
                badges={<Badge variant={STATUS_BADGE[activeAdvance.status]}>{tm(`statuses.${activeAdvance.status}`)}</Badge>}
                fields={[
                  { label: th('peek.employee'), value: activeAdvance.employeeName },
                  ...(activeAdvance.departmentName
                    ? [{ label: th('peek.department'), value: activeAdvance.departmentName }]
                    : []),
                  { label: th('peek.status'), value: tm(`statuses.${activeAdvance.status}`) },
                  { label: tm('advanceAmountLabel'), value: f.money(activeAdvance.amount, 'VND'), mono: true },
                  { label: tm('advanceMonthLabel'), value: activeAdvance.month, mono: true },
                  ...(activeAdvance.reason ? [{ label: th('peek.reason'), value: activeAdvance.reason, span2: true }] : []),
                ]}
                extraContent={
                  runLocked ? (
                    <p className="text-xs font-medium text-warning" data-testid="hr-advance-peek-locked">
                      {t('runLockedNotice', { month: activeAdvance.month })}
                    </p>
                  ) : null
                }
                noteSection={{
                  id: `hr-advance-peek-note-${activeAdvance.id}`,
                  value: advNotes[activeAdvance.id] ?? '',
                  placeholder: t('notePlaceholder'),
                  onChange: (val) => setAdvNotes((prev) => ({ ...prev, [activeAdvance.id]: val })),
                  testId: 'hr-advance-peek-note',
                }}
                errorMessage={advDecide.error ? errorMessage(advDecide.error) : null}
                actions={[
                  ...(activeAdvance.canApproveL1 && !runLocked
                    ? [
                        {
                          label: t('approveL1'),
                          variant: 'outline' as const,
                          disabled: advDecide.isPending,
                          loading:
                            advDecide.isPending &&
                            advDecide.variables?.requestId === activeAdvance.id &&
                            advDecide.variables.action === 'l1',
                          onClick: () =>
                            advDecide.mutate({ requestId: activeAdvance.id, action: 'l1', ...optionalNote(advNotes, activeAdvance.id) }),
                          testId: 'hr-advance-peek-l1',
                        },
                      ]
                    : []),
                  {
                    label: t('reject'),
                    variant: 'outline',
                    disabled: advDecide.isPending,
                    loading:
                      advDecide.isPending &&
                      advDecide.variables?.requestId === activeAdvance.id &&
                      advDecide.variables.action === 'reject',
                    onClick: () =>
                      advDecide.mutate({ requestId: activeAdvance.id, action: 'reject', ...optionalNote(advNotes, activeAdvance.id) }),
                    testId: 'hr-advance-peek-reject',
                  },
                  ...(activeAdvance.canApproveFinal && !runLocked
                    ? [
                        {
                          label: t('approveFinal'),
                          variant: 'default' as const,
                          disabled: advDecide.isPending,
                          loading:
                            advDecide.isPending &&
                            advDecide.variables?.requestId === activeAdvance.id &&
                            advDecide.variables.action === 'final',
                          onClick: () =>
                            advDecide.mutate({ requestId: activeAdvance.id, action: 'final', ...optionalNote(advNotes, activeAdvance.id) }),
                          testId: 'hr-advance-peek-final',
                        },
                      ]
                    : []),
                ]}
              />
            );
          })() : null}
        </Card>

      <Card className="p-6" data-testid="hr-trip-queue">
        <div className="mb-4">
          <h3 className="text-base font-semibold">{t('tripTitle')}</h3>
          <p className="text-sm text-muted-foreground">{t('tripSubtitle')}</p>
        </div>
        {tripList.error && <ErrorText>{errorMessage(tripList.error)}</ErrorText>}
        {pendingTrips.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('tripEmpty')}</p>
        ) : (
          <div ref={tripQueueRef} className="space-y-3">
            {pendingTrips.map((item) => (
              <ApprovalQueueRow
                key={item.id}
                id={item.id}
                testId="hr-trip-queue-row"
                title={
                  <>
                    {item.employeeName} | {item.destination ?? '-'} | {item.startOn} - {item.endOn}
                  </>
                }
                subtitle={
                  <>
                    {item.purpose ?? ''} | <span className="tabular-nums">{f.money(item.estimatedAllowance, 'VND')}</span>
                  </>
                }
                status={item.status}
                statusLabel={tm(`statuses.${item.status}`)}
                noteValue={tripNotes[item.id] ?? ''}
                notePlaceholder={t('notePlaceholder')}
                onNoteChange={(val) => setTripNotes((prev) => ({ ...prev, [item.id]: val }))}
                canApproveL1={item.canApproveL1}
                canApproveFinal={item.canApproveFinal}
                busy={tripDecide.isPending}
                l1Loading={tripDecide.isPending && tripDecide.variables?.requestId === item.id && tripDecide.variables.action === 'l1'}
                finalLoading={tripDecide.isPending && tripDecide.variables?.requestId === item.id && tripDecide.variables.action === 'final'}
                rejectLoading={tripDecide.isPending && tripDecide.variables?.requestId === item.id && tripDecide.variables.action === 'reject'}
                l1Label={t('approveL1')}
                finalLabel={t('approveFinal')}
                rejectLabel={t('reject')}
                selected={tripPeek.selectedId === item.id}
                inspectLabel={th('peek.inspect')}
                inspectAriaLabel={th('peek.inspectOf', { name: item.employeeName })}
                onInspect={() => tripPeek.openPeek(item.id)}
                onRowClick={(event) => tripPeek.onRowClick(item.id, event)}
                onApproveL1={() =>
                  tripDecide.mutate({ requestId: item.id, action: 'l1', ...optionalNote(tripNotes, item.id) })
                }
                onApproveFinal={() =>
                  tripDecide.mutate({ requestId: item.id, action: 'final', ...optionalNote(tripNotes, item.id) })
                }
                onReject={() =>
                  tripDecide.mutate({ requestId: item.id, action: 'reject', ...optionalNote(tripNotes, item.id) })
                }
              />
            ))}
          </div>
        )}
        {tripDecide.error && <ErrorText>{errorMessage(tripDecide.error)}</ErrorText>}
        {activeTrip ? (
          <HrApprovalPeekSheet
            peek={tripPeek}
            testId="hr-trip-peek-sheet"
            title={activeTrip.employeeName}
            description={`${activeTrip.destination ?? '-'} · ${activeTrip.startOn} - ${activeTrip.endOn}`}
            badges={<Badge variant={STATUS_BADGE[activeTrip.status]}>{tm(`statuses.${activeTrip.status}`)}</Badge>}
            fields={[
              { label: th('peek.employee'), value: activeTrip.employeeName },
              { label: th('peek.status'), value: tm(`statuses.${activeTrip.status}`) },
              { label: tm('tripDestinationLabel'), value: activeTrip.destination ?? '-' },
              { label: tm('tripAllowanceLabel'), value: f.money(activeTrip.estimatedAllowance, 'VND'), mono: true },
              { label: tm('tripStartLabel'), value: f.date(activeTrip.startOn), mono: true },
              { label: tm('tripEndLabel'), value: f.date(activeTrip.endOn), mono: true },
              ...(activeTrip.purpose ? [{ label: th('peek.reason'), value: activeTrip.purpose, span2: true }] : []),
            ]}
            noteSection={{
              id: `hr-trip-peek-note-${activeTrip.id}`,
              value: tripNotes[activeTrip.id] ?? '',
              placeholder: t('notePlaceholder'),
              onChange: (val) => setTripNotes((prev) => ({ ...prev, [activeTrip.id]: val })),
              testId: 'hr-trip-peek-note',
            }}
            errorMessage={tripDecide.error ? errorMessage(tripDecide.error) : null}
            actions={[
              ...(activeTrip.canApproveL1
                ? [
                    {
                      label: t('approveL1'),
                      variant: 'outline' as const,
                      disabled: tripDecide.isPending,
                      loading:
                        tripDecide.isPending &&
                        tripDecide.variables?.requestId === activeTrip.id &&
                        tripDecide.variables.action === 'l1',
                      onClick: () =>
                        tripDecide.mutate({ requestId: activeTrip.id, action: 'l1', ...optionalNote(tripNotes, activeTrip.id) }),
                      testId: 'hr-trip-peek-l1',
                    },
                  ]
                : []),
              {
                label: t('reject'),
                variant: 'outline',
                disabled: tripDecide.isPending,
                loading:
                  tripDecide.isPending &&
                  tripDecide.variables?.requestId === activeTrip.id &&
                  tripDecide.variables.action === 'reject',
                onClick: () =>
                  tripDecide.mutate({ requestId: activeTrip.id, action: 'reject', ...optionalNote(tripNotes, activeTrip.id) }),
                testId: 'hr-trip-peek-reject',
              },
              ...(activeTrip.canApproveFinal
                ? [
                    {
                      label: t('approveFinal'),
                      variant: 'default' as const,
                      disabled: tripDecide.isPending,
                      loading:
                        tripDecide.isPending &&
                        tripDecide.variables?.requestId === activeTrip.id &&
                        tripDecide.variables.action === 'final',
                      onClick: () =>
                        tripDecide.mutate({ requestId: activeTrip.id, action: 'final', ...optionalNote(tripNotes, activeTrip.id) }),
                      testId: 'hr-trip-peek-final',
                    },
                  ]
                : []),
            ]}
          />
        ) : null}
      </Card>
      </div>
    </div>
  );
}

export function HrPayrollAdjustmentsPanel(props: {
  legalEntityId: string;
  month: string;
  draft: boolean;
  employees: readonly { id: string; name: string }[];
  onChanged: () => Promise<unknown>;
}) {
  const t = useTranslations('hrPayroll.stage6b');
  const th = useTranslations('hrEmployees');
  const f = useFormat();
  const adjListRef = useRef<HTMLDivElement>(null);
  const [employeeId, setEmployeeId] = useState(props.employees[0]?.id ?? '');
  const selectedEmployeeId = employeeId || props.employees[0]?.id || '';
  const [kind, setKind] = useState<HrPayrollAdjustmentKind>('retro_pay');
  const [amount, setAmount] = useState('500000');
  const [reason, setReason] = useState('');
  const [syncNotice, setSyncNotice] = useState<'synced' | 'awaiting' | null>(null);

  const list = useQuery({
    ...orpc.hr.payroll.adjustments.list.queryOptions({
      input: { legalEntityId: props.legalEntityId, month: props.month, limit: 100 },
    }),
    ...ONCE,
  });

  const create = useMutation({
    mutationFn: () =>
      client.hr.payroll.adjustments.create({
        employeeId: selectedEmployeeId,
        month: props.month,
        kind,
        amount: amount.trim(),
        reason: reason.trim(),
      }),
    onSuccess: async () => {
      setReason('');
      setSyncNotice(null);
      await props.onChanged();
    },
  });

  const act = useMutation({
    mutationFn: ({ itemId, action }: { itemId: string; action: 'approve' | 'reject' | 'cancel' }) => {
      if (action === 'approve') return client.hr.payroll.adjustments.approve({ itemId });
      if (action === 'reject') return client.hr.payroll.adjustments.reject({ itemId });
      return client.hr.payroll.adjustments.cancel({ itemId });
    },
    onSuccess: async (res, vars) => {
      if (vars.action === 'approve') {
        setSyncNotice(res.payrollSynced ? 'synced' : 'awaiting');
      } else {
        setSyncNotice(null);
      }
      await props.onChanged();
    },
  });

  const items: HrAdjustmentItemView[] = list.data ?? [];
  const adjPeek = useListPeekNav({
    items,
    getId: (item) => item.id,
    containerRef: adjListRef,
    enabled: items.length > 0,
    resetKey: `${props.legalEntityId}:${props.month}`,
  });
  const activeAdj = adjPeek.activeItem;

  useEffect(() => {
    act.reset?.();
  }, [activeAdj?.id]);

  return (
    <Card className="mb-4 p-4" data-testid="hr-adjustments-panel">
      <div className="mb-3">
        <h3 className="text-base font-semibold">{t('panelTitle')}</h3>
        <p className="text-sm text-muted-foreground">{t('panelSubtitle')}</p>
      </div>

      {props.draft && props.employees.length > 0 && (
        <div className="mb-4 grid gap-3 sm:grid-cols-4" data-testid="hr-adjustments-form">
          <div className={`space-y-1 ${PHONE_SELECT_TARGET}`}>
            <Label htmlFor="adj-emp">{t('employeeLabel')}</Label>
            <NativeSelect
              id="adj-emp"
              value={selectedEmployeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              data-testid="hr-adj-employee"
            >
              {props.employees.map((e) => (
                <NativeSelectOption key={e.id} value={e.id}>
                  {e.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className={`space-y-1 ${PHONE_SELECT_TARGET}`}>
            <Label htmlFor="adj-kind">{t('kindLabel')}</Label>
            <NativeSelect
              id="adj-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as HrPayrollAdjustmentKind)}
              data-testid="hr-adj-kind"
            >
              {HR_PAYROLL_ADJUSTMENT_KINDS.map((k) => (
                <NativeSelectOption key={k} value={k}>
                  {t(`kinds.${k}`)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
          <div className="space-y-1">
            <Label htmlFor="adj-amount">{t('amountLabel')}</Label>
            <Input
              id="adj-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(normalizeAmount(e.target.value))}
              className={PHONE_TARGET}
              data-testid="hr-adj-amount"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="adj-reason">{t('reasonLabel')}</Label>
            <Input
              id="adj-reason"
              value={reason}
              maxLength={2000}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
              className={PHONE_TARGET}
              data-testid="hr-adj-reason"
            />
          </div>
          <div className="sm:col-span-4 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              loading={create.isPending}
              disabled={!selectedEmployeeId || amount.trim() === '' || reason.trim() === ''}
              className={PHONE_TARGET}
              onClick={() => create.mutate()}
              data-testid="hr-adj-create"
            >
              {t('createBtn')}
            </Button>
            {create.error && <ErrorText>{errorMessage(create.error)}</ErrorText>}
          </div>
        </div>
      )}

      {list.error && <ErrorText>{errorMessage(list.error)}</ErrorText>}
      {!props.draft && items.some((i) => i.status === 'pending') && (
        <p className="mb-3 text-xs font-medium text-warning" data-testid="hr-adj-nondraft-notice">
          {t('nonDraftNotice')}
        </p>
      )}
      {syncNotice && (
        <p className="mb-3 text-xs text-muted-foreground" data-testid="hr-adj-sync-notice">
          {syncNotice === 'synced' ? t('approvedSynced') : t('approvedAwaitingSync')}
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div ref={adjListRef} className="space-y-2">
          {items.map((item) => {
            const selected = adjPeek.selectedId === item.id;
            return (
              <div
                key={item.id}
                data-peek-row={item.id}
                data-selected={selected ? 'true' : undefined}
                onClick={(event) => adjPeek.onRowClick(item.id, event)}
                className={cn(
                  'flex cursor-pointer flex-wrap items-center justify-between gap-2 rounded-md border p-3 text-sm transition-colors',
                  selected ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-muted/40',
                )}
                data-testid="hr-adj-item"
              >
                <div>
                  <div className="font-medium">
                    {item.employeeName} | {t(`kinds.${item.kind}`)} |{' '}
                    <span className="tabular-nums">{f.money(item.amount, 'VND')}</span>
                  </div>
                  {item.reason && <p className="text-xs text-muted-foreground">{item.reason}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    data-peek-trigger={item.id}
                    data-testid="hr-adj-peek-btn"
                    aria-label={th('peek.inspectOf', { name: item.employeeName })}
                    onClick={() => adjPeek.openPeek(item.id)}
                  >
                    {th('peek.inspect')}
                  </Button>
                  <Badge variant={STATUS_BADGE[item.status]}>{t(`statuses.${item.status}`)}</Badge>
                  {props.draft && item.canApprove && (
                    <Button
                      type="button"
                      size="sm"
                      loading={act.isPending && act.variables?.itemId === item.id && act.variables.action === 'approve'}
                      disabled={act.isPending}
                      className={PHONE_TARGET}
                      onClick={() => act.mutate({ itemId: item.id, action: 'approve' })}
                      data-testid="hr-adj-approve"
                    >
                      {t('approveBtn')}
                    </Button>
                  )}
                  {item.status === 'pending' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      loading={act.isPending && act.variables?.itemId === item.id && act.variables.action === 'reject'}
                      disabled={act.isPending}
                      className={PHONE_TARGET}
                      onClick={() => act.mutate({ itemId: item.id, action: 'reject' })}
                      data-testid="hr-adj-reject"
                    >
                      {t('rejectBtn')}
                    </Button>
                  )}
                  {item.canCancel && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      loading={act.isPending && act.variables?.itemId === item.id && act.variables.action === 'cancel'}
                      disabled={act.isPending}
                      className={PHONE_TARGET}
                      onClick={() => act.mutate({ itemId: item.id, action: 'cancel' })}
                      data-testid="hr-adj-cancel"
                    >
                      {t('cancelBtn')}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {act.error && <ErrorText>{errorMessage(act.error)}</ErrorText>}
      {activeAdj ? (
        <HrApprovalPeekSheet
          peek={adjPeek}
          testId="hr-adj-peek-sheet"
          title={activeAdj.employeeName}
          description={`${t(`kinds.${activeAdj.kind}`)} · ${f.money(activeAdj.amount, 'VND')}`}
          badges={<Badge variant={STATUS_BADGE[activeAdj.status]}>{t(`statuses.${activeAdj.status}`)}</Badge>}
          fields={[
            { label: th('peek.employee'), value: activeAdj.employeeName },
            { label: th('peek.status'), value: t(`statuses.${activeAdj.status}`) },
            { label: t('kindLabel'), value: t(`kinds.${activeAdj.kind}`) },
            { label: t('amountLabel'), value: f.money(activeAdj.amount, 'VND'), mono: true },
            ...(activeAdj.reason ? [{ label: th('peek.reason'), value: activeAdj.reason, span2: true }] : []),
          ]}
          extraContent={
            !props.draft && activeAdj.status === 'pending' ? (
              <p className="text-xs font-medium text-warning" data-testid="hr-adj-peek-nondraft">
                {t('nonDraftNotice')}
              </p>
            ) : null
          }
          errorMessage={act.error ? errorMessage(act.error) : null}
          actions={[
            ...(activeAdj.canCancel
              ? [
                  {
                    label: t('cancelBtn'),
                    variant: 'ghost' as const,
                    disabled: act.isPending,
                    loading: act.isPending && act.variables?.itemId === activeAdj.id && act.variables.action === 'cancel',
                    onClick: () => act.mutate({ itemId: activeAdj.id, action: 'cancel' }),
                    testId: 'hr-adj-peek-cancel',
                  },
                ]
              : []),
            ...(activeAdj.status === 'pending'
              ? [
                  {
                    label: t('rejectBtn'),
                    variant: 'outline' as const,
                    disabled: act.isPending,
                    loading: act.isPending && act.variables?.itemId === activeAdj.id && act.variables.action === 'reject',
                    onClick: () => act.mutate({ itemId: activeAdj.id, action: 'reject' }),
                    testId: 'hr-adj-peek-reject',
                  },
                ]
              : []),
            ...(props.draft && activeAdj.canApprove
              ? [
                  {
                    label: t('approveBtn'),
                    variant: 'default' as const,
                    disabled: act.isPending,
                    loading: act.isPending && act.variables?.itemId === activeAdj.id && act.variables.action === 'approve',
                    onClick: () => act.mutate({ itemId: activeAdj.id, action: 'approve' }),
                    testId: 'hr-adj-peek-approve',
                  },
                ]
              : []),
          ]}
        />
      ) : null}
    </Card>
  );
}

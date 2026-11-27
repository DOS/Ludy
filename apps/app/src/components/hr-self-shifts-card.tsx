// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 7A (#5216): Embedded weekly shift viewer and 1-step shift swap submission card inside /hr/my.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import { vietnamToday, type HrShiftSwapStatus } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Empty, ErrorText } from './ui.tsx';
import { addDaysLocal, formatMinuteClock, mondayOfWeekLocal } from './hr-shifts-panel.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

const PHONE_SELECT = 'max-md:min-h-11 [&_select]:max-md:min-h-11';

const SWAP_BADGE: Record<HrShiftSwapStatus, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'destructive',
  cancelled: 'secondary',
};

export function HrSelfShiftsCard({ enabled = true }: { enabled?: boolean }) {
  const t = useTranslations('hrMy.shifts');
  const [weekStart, setWeekStart] = useState(() => mondayOfWeekLocal(vietnamToday(new Date())));
  const [swapAssignmentId, setSwapAssignmentId] = useState<string | null>(null);
  const [targetEmployeeId, setTargetEmployeeId] = useState('');
  const [reason, setReason] = useState('');

  const shiftsQ = useQuery({
    ...orpc.hr.self.shifts.list.queryOptions({ input: { weekStart } }),
    enabled,
    staleTime: 15_000,
  });

  const refreshSelfShifts = async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.hr.self.shifts.key() });
    await queryClient.invalidateQueries({ queryKey: orpc.hr.shifts.key() });
  };

  const submitSwapMut = useMutation({
    ...orpc.hr.self.shifts.swapSubmit.mutationOptions(),
    onSuccess: async () => {
      setSwapAssignmentId(null);
      setTargetEmployeeId('');
      setReason('');
      await refreshSelfShifts();
    },
  });

  const cancelSwapMut = useMutation({
    ...orpc.hr.self.shifts.swapCancel.mutationOptions(),
    onSuccess: refreshSelfShifts,
  });

  if (!enabled) return null;

  const data = shiftsQ.data;
  const assignments = data?.assignments ?? [];
  const peers = data?.peerCandidates ?? [];
  const swaps = data?.swaps ?? [];

  const handleSubmitSwap = (e: FormEvent) => {
    e.preventDefault();
    if (!swapAssignmentId || !targetEmployeeId) return;
    submitSwapMut.mutate({
      requesterAssignmentId: swapAssignmentId,
      targetEmployeeId,
      reason: reason.trim() ? reason.trim() : null,
    });
  };

  return (
    <Card className="mb-6 block space-y-4 p-4" data-testid="hr-my-shifts-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-medium text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">
            {t('weekLabel', { start: weekStart, end: data?.weekEnd ?? addDaysLocal(weekStart, 6) })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={PHONE_TARGET}
            onClick={() => setWeekStart((w) => addDaysLocal(w, -7))}
            data-testid="hr-my-shifts-prev"
          >
            {t('prevWeekBtn')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={PHONE_TARGET}
            onClick={() => setWeekStart(mondayOfWeekLocal(vietnamToday(new Date())))}
            data-testid="hr-my-shifts-today"
          >
            {t('thisWeekBtn')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={PHONE_TARGET}
            onClick={() => setWeekStart((w) => addDaysLocal(w, 7))}
            data-testid="hr-my-shifts-next"
          >
            {t('nextWeekBtn')}
          </Button>
        </div>
      </div>

      {shiftsQ.error && <ErrorText>{errorMessage(shiftsQ.error)}</ErrorText>}
      {cancelSwapMut.error && <ErrorText>{errorMessage(cancelSwapMut.error)}</ErrorText>}

      {!shiftsQ.isLoading && assignments.length === 0 ? (
        <Empty title={t('emptyTitle')} body={t('emptyBody')} />
      ) : (
        <div className="space-y-2">
          {assignments.map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
              data-testid={`hr-my-shift-row-${a.workDate}`}
            >
              <div>
                <div className="font-medium text-foreground">
                  {a.workDate} · {a.shiftCode} ({a.shiftName})
                </div>
                <div className="text-xs text-muted-foreground tabular-nums">
                  {formatMinuteClock(a.startMinute)} - {formatMinuteClock(a.endMinute)} · {t('breakLabel', { minutes: String(a.breakMinutes) })}
                  {a.note ? ` · ${a.note}` : ''}
                </div>
              </div>
              {peers.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={PHONE_TARGET}
                  onClick={() => {
                    setSwapAssignmentId(a.id);
                    setTargetEmployeeId(peers[0]?.id ?? '');
                  }}
                  data-testid={`hr-my-shift-swap-open-${a.id}`}
                >
                  {t('requestSwapBtn')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {swapAssignmentId && (
        <form
          onSubmit={handleSubmitSwap}
          className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
          data-testid="hr-my-shift-swap-form"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-foreground">{t('swapFormTitle')}</span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={PHONE_TARGET}
              onClick={() => setSwapAssignmentId(null)}
            >
              {t('cancelFormBtn')}
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="hr-my-swap-peer">{t('targetPeerLabel')}</Label>
              <div className={PHONE_SELECT}>
                <NativeSelect
                  id="hr-my-swap-peer"
                  value={targetEmployeeId}
                  onChange={(e) => setTargetEmployeeId(e.target.value)}
                  data-testid="hr-my-swap-peer"
                >
                  {peers.map((p) => (
                    <NativeSelectOption key={p.id} value={p.id}>
                      {p.displayName}{p.departmentName ? ` (${p.departmentName})` : ''}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="hr-my-swap-reason">{t('reasonLabel')}</Label>
              <Input
                id="hr-my-swap-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
                className={PHONE_TARGET}
                data-testid="hr-my-swap-reason"
              />
            </div>
          </div>
          {submitSwapMut.error && <ErrorText>{errorMessage(submitSwapMut.error)}</ErrorText>}
          <Button
            type="submit"
            size="sm"
            className={PHONE_TARGET}
            disabled={submitSwapMut.isPending || !targetEmployeeId}
            data-testid="hr-my-swap-submit"
          >
            {t('submitSwapBtn')}
          </Button>
        </form>
      )}

      {swaps.length > 0 && (
        <div className="space-y-2 pt-2" data-testid="hr-my-swaps-list">
          <h3 className="text-sm font-medium text-foreground">{t('swapsHistoryTitle')}</h3>
          {swaps.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2.5 text-sm"
              data-testid={`hr-my-swap-row-${s.id}`}
            >
              <div>
                <div className="font-medium text-foreground">
                  {s.workDate}: {s.requesterName} ({s.requesterShiftCode}) → {s.targetName} (
                  {s.targetShiftCode ?? t('coverShiftLabel')})
                </div>
                {s.reason && <div className="text-xs text-muted-foreground">{s.reason}</div>}
                {s.decisionNote && (
                  <div className="text-xs text-muted-foreground">
                    {t('decisionNoteLabel')}: {s.decisionNote}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={SWAP_BADGE[s.status]}>{t(`swapStatuses.${s.status}`)}</Badge>
                {s.status === 'pending' && s.requesterEmployeeId === data?.employeeId && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className={PHONE_TARGET}
                    disabled={cancelSwapMut.isPending}
                    onClick={() => cancelSwapMut.mutate({ swapId: s.id })}
                    data-testid={`hr-my-swap-cancel-${s.id}`}
                  >
                    {t('cancelSwapBtn')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

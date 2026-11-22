// SPDX-License-Identifier: AGPL-3.0-only
// Self-service 1-click attendance check-in/out & office QR widget for /o/$slug/hr/my (#4447 Stage 5C).
// Kept standalone so integration into hr-my.tsx stays minimal and clean.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { vietnamMonth, type HrAttendanceLogView, type HrSelfAttendanceListResult } from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { DataTable, ErrorText, TableSkeleton } from './ui.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

const ONCE = { staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false } as const;
const VN_OFFSET_MS = 7 * 3_600_000;
const PHONE_INPUT_TARGET = 'max-md:min-h-11';

function readInitialQrFromLocation(): string {
  if (typeof window === 'undefined') return '';
  try {
    return new URLSearchParams(window.location.search).get('qr')?.trim() ?? '';
  } catch {
    return '';
  }
}

export function formatMinutesLabel(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${String(m).padStart(2, '0')}m`;
}

export function formatVietnamTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(11, 16);
}

function effectiveStatusKey(row: HrAttendanceLogView, today: string): 'present' | 'half_day' | 'missing_checkout' | 'checked_in_open' | 'adjusted' {
  if (row.status === 'missing_checkout' && row.workDate === today && row.checkedOutAt === null) {
    return 'checked_in_open';
  }
  return row.status;
}

export function HrAttendanceCheckinCard({ enabled = true }: { enabled?: boolean }) {
  const t = useTranslations('hrMy.attendance');
  const [month, setMonth] = useState(() => vietnamMonth(new Date()));
  const [note, setNote] = useState('');
  const [qrOpen, setQrOpen] = useState(() => readInitialQrFromLocation().length > 0);
  const [qrToken, setQrToken] = useState(() => readInitialQrFromLocation());

  useEffect(() => {
    const param = readInitialQrFromLocation();
    if (param) {
      setQrOpen(true);
      setQrToken(param);
    }
  }, []);

  const listQ = useQuery({
    ...orpc.hr.self.attendance.list.queryOptions({ input: { month } }),
    enabled,
    ...ONCE,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.hr.self.attendance.key() });

  const checkInWeb = useMutation({
    ...orpc.hr.self.attendance.checkIn.mutationOptions(),
    onSuccess: async () => {
      setNote('');
      await refresh();
    },
  });

  const checkInQr = useMutation({
    ...orpc.hr.self.attendance.checkIn.mutationOptions(),
    onSuccess: async () => {
      setNote('');
      setQrToken('');
      setQrOpen(false);
      await refresh();
    },
  });

  const checkOut = useMutation({
    ...orpc.hr.self.attendance.checkOut.mutationOptions(),
    onSuccess: async () => {
      setNote('');
      await refresh();
    },
  });

  const data: HrSelfAttendanceListResult | undefined = listQ.data;
  const today = data?.today ?? '';
  const todayLog = data?.todayLog ?? null;
  const logs = data?.logs ?? [];
  const summary = data?.summary;
  const pending = checkInWeb.isPending || checkInQr.isPending || checkOut.isPending;

  return (
    <Card className="mb-6 block space-y-4 p-4" data-testid="hr-my-attendance-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t('title')}</h2>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="hr-my-attendance-month" className="text-xs text-muted-foreground">
            {t('monthLabel')}
          </Label>
          <Input
            id="hr-my-attendance-month"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            className={`w-40 ${PHONE_INPUT_TARGET}`}
            data-testid="hr-my-attendance-month"
          />
        </div>
      </div>

      {listQ.isLoading && <TableSkeleton columns={4} rows={3} />}
      {listQ.error && <ErrorText>{errorMessage(listQ.error)}</ErrorText>}

      {data && (
        <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3" data-testid="hr-my-attendance-today">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="text-xs font-medium text-muted-foreground">{t('todayStatusLabel')}</div>
              {todayLog === null ? (
                <div className="text-sm font-medium">{t('notCheckedIn')}</div>
              ) : todayLog.checkedOutAt === null ? (
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>{t('checkedInAt', { time: formatVietnamTime(todayLog.checkedInAt) })}</span>
                  <Badge variant="brand">{t(`methods.${todayLog.checkInMethod}`)}</Badge>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span>
                    {t('completedToday', {
                      inTime: formatVietnamTime(todayLog.checkedInAt),
                      outTime: formatVietnamTime(todayLog.checkedOutAt),
                      duration: formatMinutesLabel(todayLog.workedMinutes),
                    })}
                  </span>
                  <Badge variant="secondary">{t(`statuses.${effectiveStatusKey(todayLog, today)}`)}</Badge>
                </div>
              )}
            </div>

            {todayLog === null ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  loading={checkInWeb.isPending}
                  disabled={pending}
                  className={PHONE_TARGET}
                  onClick={() => checkInWeb.mutate({ method: 'web', ...(note.trim() ? { note: note.trim() } : {}) })}
                  data-testid="hr-my-checkin-btn"
                >
                  {t('checkInBtn')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  className={PHONE_TARGET}
                  onClick={() => setQrOpen((v) => !v)}
                  data-testid="hr-my-checkin-qr-toggle"
                >
                  {t('checkInQrToggle')}
                </Button>
              </div>
            ) : todayLog.checkedOutAt === null ? (
              <Button
                type="button"
                loading={checkOut.isPending}
                disabled={pending}
                className={PHONE_TARGET}
                onClick={() => checkOut.mutate({ workDate: todayLog.workDate, ...(note.trim() ? { note: note.trim() } : {}) })}
                data-testid="hr-my-checkout-btn"
              >
                {t('checkOutBtn')}
              </Button>
            ) : null}
          </div>

          {(todayLog === null || todayLog.checkedOutAt === null) && (
            <div>
              <Label htmlFor="hr-my-attendance-note" className="text-xs text-muted-foreground">
                {t('noteLabel')}
              </Label>
              <Input
                id="hr-my-attendance-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder={t('notePlaceholder')}
                className={`mt-1 ${PHONE_INPUT_TARGET}`}
                data-testid="hr-my-attendance-note"
              />
            </div>
          )}

          {todayLog === null && qrOpen && (
            <div className="rounded-md border border-border bg-card p-3 space-y-2" data-testid="hr-my-checkin-qr-panel">
              <Label htmlFor="hr-my-qr-token" className="text-xs font-medium">
                {t('qrTokenLabel')}
              </Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id="hr-my-qr-token"
                  value={qrToken}
                  onChange={(e) => setQrToken(e.target.value)}
                  placeholder={t('qrTokenPlaceholder')}
                  className={`flex-1 min-w-48 ${PHONE_INPUT_TARGET}`}
                  data-testid="hr-my-qr-token-input"
                />
                <Button
                  type="button"
                  loading={checkInQr.isPending}
                  disabled={pending || qrToken.trim().length === 0}
                  className={PHONE_TARGET}
                  onClick={() =>
                    checkInQr.mutate({
                      method: 'qr',
                      qrToken: qrToken.trim(),
                      ...(note.trim() ? { note: note.trim() } : {}),
                    })
                  }
                  data-testid="hr-my-checkin-qr-submit"
                >
                  {t('checkInQrBtn')}
                </Button>
              </div>
            </div>
          )}

          {checkInWeb.error && <ErrorText>{errorMessage(checkInWeb.error)}</ErrorText>}
          {checkInQr.error && <ErrorText>{errorMessage(checkInQr.error)}</ErrorText>}
          {checkOut.error && <ErrorText>{errorMessage(checkOut.error)}</ErrorText>}
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="hr-my-attendance-summary">
          <div className="rounded-md border border-border p-3">
            <div className="text-xs text-muted-foreground">{t('summaryPresent')}</div>
            <div className="text-lg font-semibold tabular-nums">{summary.presentDays}</div>
          </div>
          <div className="rounded-md border border-border p-3">
            <div className="text-xs text-muted-foreground">{t('summaryHalfDay')}</div>
            <div className="text-lg font-semibold tabular-nums">{summary.halfDays}</div>
          </div>
          <div className="rounded-md border border-border p-3">
            <div className="text-xs text-muted-foreground">{t('summaryMissing')}</div>
            <div className="text-lg font-semibold tabular-nums">{summary.missingCheckoutDays}</div>
          </div>
          <div className="rounded-md border border-border p-3">
            <div className="text-xs text-muted-foreground">{t('summaryTotalHours')}</div>
            <div className="text-lg font-semibold tabular-nums">{formatMinutesLabel(summary.totalWorkedMinutes) || '0h'}</div>
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 text-sm font-medium">{t('historyTitle', { month })}</h3>
        {!listQ.isLoading && logs.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="hr-my-attendance-empty">
            {t('empty')}
          </p>
        ) : logs.length > 0 ? (
          <DataTable head={[t('colDate'), t('colIn'), t('colOut'), t('colDuration'), t('colMethod'), t('colStatus'), t('colNote')]}>
            {logs.map((row) => {
              const statusKey = effectiveStatusKey(row, today);
              return (
                <TableRow key={row.id} data-testid={`hr-my-attendance-row-${row.workDate}`}>
                  <TableCell className="px-4 py-2 font-medium tabular-nums">{row.workDate}</TableCell>
                  <TableCell className="px-4 py-2 tabular-nums">{formatVietnamTime(row.checkedInAt)}</TableCell>
                  <TableCell className="px-4 py-2 tabular-nums">{formatVietnamTime(row.checkedOutAt)}</TableCell>
                  <TableCell className="px-4 py-2 tabular-nums">{formatMinutesLabel(row.workedMinutes)}</TableCell>
                  <TableCell className="px-4 py-2">{t(`methods.${row.checkInMethod}`)}</TableCell>
                  <TableCell className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={statusKey === 'missing_checkout' ? 'destructive' : statusKey === 'present' ? 'brand' : 'secondary'}>
                        {t(`statuses.${statusKey}`)}
                      </Badge>
                      {row.anomalies.map((kind) => (
                        <Badge key={kind} variant="outline">
                          {t(`anomalies.${kind}`)}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-2 text-sm text-muted-foreground">{row.note ?? ''}</TableCell>
                </TableRow>
              );
            })}
          </DataTable>
        ) : null}
      </div>
    </Card>
  );
}

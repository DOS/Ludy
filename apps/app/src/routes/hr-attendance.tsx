// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 5C (#4447): Admin monthly attendance sheet, office QR poster management,
// deterministic anomalies + Ly narration, manual adjustment, and 1-click rollup into draft payroll.
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  HR_ATTENDANCE_METHODS,
  vietnamMonth,
  vietnamToday,
  type HrAdminAttendanceRow,
  type HrAttendanceAnomaliesBrief,
  type HrAttendanceQrRotateResult,
  type HrAttendanceRollupResult,
  type HrEmployeeSummary,
  type HrRunSummary,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { TableCell, TableRow } from '@ludy/ui/components/table';
import { formatMinutesLabel, formatVietnamTime } from '../components/hr-attendance-checkin-card.tsx';
import { DataTable, ErrorText, PageHeader, TableSkeleton } from '../components/ui.tsx';
import { useFormat, useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { encodeQrMatrix, qrSvgPath } from '../lib/qr-svg.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const PHONE_SELECT_TARGET = 'max-md:min-h-11 [&_select]:max-md:min-h-11';
const PHONE_INPUT_TARGET = 'max-md:min-h-11';

function toVnIsoTimestamp(workDate: string, hhmm: string): string | null {
  const clean = hhmm.trim();
  if (!clean) return null;
  if (!/^\d{2}:\d{2}$/.test(clean)) return null;
  const parsed = Date.parse(`${workDate}T${clean}:00+07:00`);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function toVnOutTimestamp(workDate: string, inHhmm: string, outHhmm: string): string | null {
  const outClean = outHhmm.trim();
  if (!outClean) return null;
  const inClean = inHhmm.trim();
  const isOvernight = /^\d{2}:\d{2}$/.test(inClean) && /^\d{2}:\d{2}$/.test(outClean) && outClean < inClean;
  const targetDate = isOvernight
    ? new Date(Date.parse(`${workDate}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10)
    : workDate;
  return toVnIsoTimestamp(targetDate, outClean);
}

function buildSafeQrSvg(primaryText: string, fallbackText: string): ReturnType<typeof qrSvgPath> | null {
  if (!primaryText) return null;
  try {
    return qrSvgPath(encodeQrMatrix(primaryText));
  } catch {
    if (fallbackText && fallbackText !== primaryText) {
      try {
        return qrSvgPath(encodeQrMatrix(fallbackText));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function toVnTimeInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + VN_OFFSET_MS).toISOString().slice(11, 16);
}

export function HrAttendancePage() {
  const { slug } = useParams({ strict: false }) as { slug?: string };
  const t = useTranslations('hrAttendance');
  const ta = useTranslations('hrMy.attendance');
  const f = useFormat();
  const { locale } = useLocaleSetting();

  const [month, setMonth] = useState(() => vietnamMonth(new Date()));
  const [selectedEntityId, setSelectedEntityId] = useState('');
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const [rotatedQr, setRotatedQr] = useState<HrAttendanceQrRotateResult | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [lyBrief, setLyBrief] = useState<HrAttendanceAnomaliesBrief | null>(null);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [allowIncomplete, setAllowIncomplete] = useState(false);
  const [rollupResult, setRollupResult] = useState<HrAttendanceRollupResult | null>(null);

  const [adjustOpen, setAdjustOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<HrAdminAttendanceRow | null>(null);
  const [adjEmpId, setAdjEmpId] = useState('');
  const [adjDate, setAdjDate] = useState(() => vietnamToday(new Date()));
  const [adjIn, setAdjIn] = useState('08:30');
  const [adjOut, setAdjOut] = useState('17:30');
  const [adjMethod, setAdjMethod] = useState<'manual' | 'web' | 'qr'>('manual');
  const [adjStatus, setAdjStatus] = useState<'adjusted' | 'present' | 'half_day'>('adjusted');
  const [adjNote, setAdjNote] = useState('');

  const meQ = useQuery(orpc.me.get.queryOptions());
  const roleHere = meQ.data?.orgs.find((o) => o.slug === slug)?.role;
  const canManage = roleHere === 'owner' || roleHere === 'admin';

  const entitiesQ = useQuery({
    ...orpc.legalEntities.list.queryOptions(),
    enabled: canManage,
    staleTime: 30_000,
  });

  const listQ = useQuery({
    ...orpc.hr.attendance.list.queryOptions({
      input: { month, anomaliesOnly, ...(selectedEntityId ? { legalEntityId: selectedEntityId } : {}) },
    }),
    enabled: canManage,
  });

  const employeesQ = useQuery({
    ...orpc.hr.payroll.employees.list.queryOptions({ input: {} }),
    enabled: canManage,
    staleTime: 30_000,
  });

  const runsQ = useQuery({
    ...orpc.hr.payroll.runs.list.queryOptions({ input: { limit: 60 } }),
    enabled: canManage,
  });

  const refreshAttendance = async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.hr.attendance.key() });
    await queryClient.invalidateQueries({ queryKey: orpc.hr.self.attendance.key() });
  };

  const rotateQr = useMutation({
    ...orpc.hr.attendance.qr.rotate.mutationOptions(),
    onSuccess: async (data) => {
      setRotatedQr(data);
      setCopiedUrl(false);
      await refreshAttendance();
    },
  });

  const askLy = useMutation({
    ...orpc.hr.attendance.anomaliesBrief.mutationOptions(),
    onSuccess: (data) => {
      setLyBrief(data);
    },
  });

  const saveAdjust = useMutation({
    ...orpc.hr.attendance.adjust.mutationOptions(),
    onSuccess: async () => {
      setAdjustOpen(false);
      setEditingRow(null);
      setAdjNote('');
      await refreshAttendance();
    },
  });

  const rollupMut = useMutation({
    ...orpc.hr.attendance.rollupToPayroll.mutationOptions(),
    onSuccess: async (data) => {
      setRollupResult(data);
      await queryClient.invalidateQueries({ queryKey: orpc.hr.payroll.key() });
    },
  });

  const data = listQ.data;
  const entities = entitiesQ.data ?? [];
  const activeEntityId = selectedEntityId || data?.legalEntityId || '';
  const scopedEmployees: readonly HrEmployeeSummary[] = (employeesQ.data ?? []).filter(
    (e) => (e.status === 'active' || e.id === adjEmpId) && (!activeEntityId || e.legalEntityId === activeEntityId),
  );
  const draftRunsForMonth: readonly HrRunSummary[] = (runsQ.data ?? []).filter(
    (r) => r.month === month && r.status === 'draft' && (!activeEntityId || r.legalEntityId === activeEntityId),
  );

  useEffect(() => {
    if (draftRunsForMonth.length > 0 && !draftRunsForMonth.some((r) => r.id === selectedRunId)) {
      setSelectedRunId(draftRunsForMonth[0]!.id);
    } else if (draftRunsForMonth.length === 0) {
      setSelectedRunId('');
    }
  }, [draftRunsForMonth, selectedRunId]);

  useEffect(() => {
    if (!scopedEmployees.some((e) => e.id === adjEmpId)) {
      setAdjEmpId(scopedEmployees[0]?.id ?? '');
    }
  }, [scopedEmployees, adjEmpId]);

  if (meQ.isPending) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <TableSkeleton rows={5} columns={6} />
      </div>
    );
  }

  if (!canManage) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <div data-testid="hr-attendance-forbidden">
          <ErrorText>{t('forbidden')}</ErrorText>
        </div>
      </div>
    );
  }

  if (listQ.isError && !data) {
    return (
      <div className="space-y-6">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <ErrorText>{errorMessage(listQ.error)}</ErrorText>
      </div>
    );
  }

  const checkInLink =
    rotatedQr && slug && typeof window !== 'undefined'
      ? `${window.location.origin}/o/${slug}/hr/my#qr=${encodeURIComponent(rotatedQr.secret)}`
      : rotatedQr?.secret ?? '';

  const qrSvg = rotatedQr ? buildSafeQrSvg(checkInLink, rotatedQr.secret) : null;

  const openNewAdjust = () => {
    if (adjustOpen && editingRow === null) {
      setAdjustOpen(false);
      return;
    }
    setEditingRow(null);
    setAdjEmpId(scopedEmployees[0]?.id ?? '');
    setAdjDate(data?.today ?? vietnamToday(new Date()));
    setAdjIn('08:30');
    setAdjOut('17:30');
    setAdjMethod('manual');
    setAdjStatus('adjusted');
    setAdjNote('');
    setAdjustOpen(true);
  };

  const openEditRow = (row: HrAdminAttendanceRow) => {
    setEditingRow(row);
    setAdjEmpId(row.employeeId);
    setAdjDate(row.workDate);
    setAdjIn(toVnTimeInput(row.checkedInAt));
    setAdjOut(toVnTimeInput(row.checkedOutAt));
    setAdjMethod(row.checkInMethod);
    setAdjStatus(row.status === 'missing_checkout' ? 'adjusted' : row.status);
    setAdjNote(row.note ?? '');
    setAdjustOpen(true);
  };

  const logs = data?.logs ?? [];
  const anomalies = data?.anomalies ?? [];

  return (
    <div className="space-y-6">
      <div className="print:hidden">
        <PageHeader
          title={t('title')}
          subtitle={t('subtitle')}
          actions={
            <div className="flex flex-wrap items-center gap-3">
              {entities.length > 1 && (
                <div className="flex items-center gap-2">
                  <Label htmlFor="hr-attendance-entity" className="text-xs text-muted-foreground">
                    {t('entityLabel')}
                  </Label>
                  <NativeSelect
                    id="hr-attendance-entity"
                    value={activeEntityId}
                    onChange={(e) => {
                      setSelectedEntityId(e.target.value);
                      setRotatedQr(null);
                      setLyBrief(null);
                      setRollupResult(null);
                    }}
                    className={PHONE_SELECT_TARGET}
                    data-testid="hr-attendance-entity"
                  >
                    {entities.map((ent) => (
                      <NativeSelectOption key={ent.id} value={ent.id}>
                        {ent.name}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              )}
              <div className="flex items-center gap-2">
                <Label htmlFor="hr-attendance-month" className="text-xs text-muted-foreground">
                  {t('monthLabel')}
                </Label>
                <Input
                  id="hr-attendance-month"
                  type="month"
                  value={month}
                  onChange={(e) => {
                    setMonth(e.target.value);
                    setLyBrief(null);
                    setRollupResult(null);
                  }}
                  className={`w-40 ${PHONE_INPUT_TARGET}`}
                  data-testid="hr-attendance-month"
                />
              </div>
              <label className={`inline-flex items-center gap-2 text-sm cursor-pointer ${PHONE_TARGET}`}>
                <input
                  type="checkbox"
                  checked={anomaliesOnly}
                  onChange={(e) => setAnomaliesOnly(e.target.checked)}
                  data-testid="hr-attendance-anomalies-only"
                />
                <span>{t('anomaliesOnly')}</span>
              </label>
            </div>
          }
        />
      </div>

      {listQ.isLoading && <TableSkeleton rows={5} columns={6} />}
      {listQ.error && <ErrorText>{errorMessage(listQ.error)}</ErrorText>}

      {/* Office QR Management */}
      <Card className="block space-y-4 p-4 print:border-0 print:p-0" data-testid="hr-attendance-qr-card">
        <div className="flex flex-wrap items-start justify-between gap-3 print:hidden">
          <div>
            <h2 className="text-base font-semibold">{t('qrTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('qrPrivacyNote')}</p>
            {data?.qrConfig.configured && data.qrConfig.rotatedAt ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('qrConfigured', { time: f.dateTime(data.qrConfig.rotatedAt) })}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">{t('qrNotConfigured')}</p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            loading={rotateQr.isPending}
            className={PHONE_TARGET}
            onClick={() => rotateQr.mutate(activeEntityId ? { legalEntityId: activeEntityId } : {})}
            data-testid="hr-attendance-qr-rotate"
          >
            {t('qrRotateBtn')}
          </Button>
        </div>

        {rotateQr.error && <ErrorText>{errorMessage(rotateQr.error)}</ErrorText>}

        {rotatedQr && qrSvg && (
          <div
            className="flex flex-wrap items-center gap-6 rounded-lg border border-border bg-muted/20 p-4 print:border-0 print:bg-transparent print:p-0"
            data-testid="hr-attendance-qr-poster"
          >
            <div className="rounded-lg border border-border bg-image-surface p-3 text-foreground dark:text-background">
              <svg
                viewBox={qrSvg.viewBox}
                className="h-44 w-44"
                role="img"
                aria-label={t('qrPosterTitle')}
                shapeRendering="crispEdges"
              >
                <path d={qrSvg.d} fill="currentColor" />
              </svg>
            </div>
            <div className="flex-1 min-w-60 space-y-2">
              <h3 className="text-sm font-semibold">{t('qrPosterTitle')}</h3>
              <div>
                <div className="text-xs text-muted-foreground">{t('qrSecretLabel')}</div>
                <code className="block break-all rounded bg-muted px-2 py-1 text-xs" data-testid="hr-attendance-qr-secret">
                  {rotatedQr.secret}
                </code>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">{t('qrLinkLabel')}</div>
                <code className="block break-all rounded bg-muted px-2 py-1 text-xs">{checkInLink}</code>
              </div>
              <div className="flex flex-wrap gap-2 pt-1 print:hidden">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={PHONE_TARGET}
                  onClick={async () => {
                    if (typeof navigator !== 'undefined' && navigator.clipboard) {
                      try {
                        await navigator.clipboard.writeText(checkInLink);
                        setCopiedUrl(true);
                      } catch {
                        // Ignore denied clipboard permissions cleanly.
                      }
                    }
                  }}
                >
                  {copiedUrl ? t('qrCopied') : t('qrCopyLink')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className={PHONE_TARGET}
                  onClick={() => {
                    if (typeof window !== 'undefined') window.print();
                  }}
                >
                  {t('qrPrintBtn')}
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      {/* Deterministic Anomalies & Optional Ly Brief */}
      <Card className="block space-y-3 p-4 print:hidden" data-testid="hr-attendance-anomalies-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">
            {t('anomaliesTitle')} ({anomalies.length})
          </h2>
          {anomalies.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              loading={askLy.isPending}
              className={PHONE_TARGET}
              onClick={() =>
                askLy.mutate({
                  month,
                  ...(activeEntityId ? { legalEntityId: activeEntityId } : {}),
                  lang: locale === 'en' ? 'en' : 'vi',
                })
              }
              data-testid="hr-attendance-anomalies-ask"
            >
              {t('anomaliesAskLy')}
            </Button>
          )}
        </div>

        {askLy.error && <ErrorText>{errorMessage(askLy.error)}</ErrorText>}

        {anomalies.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('anomaliesEmpty', { month })}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {anomalies.slice(0, 12).map((a) => (
              <Badge key={`${a.logId}:${a.kind}`} variant="outline">
                {a.employeeName} · {a.workDate}: {ta(`anomalies.${a.kind}`)}
              </Badge>
            ))}
          </div>
        )}

        {lyBrief && (
          <div className="rounded-md border border-border bg-muted/20 p-3 text-sm space-y-1" data-testid="hr-attendance-ly-brief">
            {lyBrief.summary && <p className="font-medium">{lyBrief.summary}</p>}
            {lyBrief.highlights.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                {lyBrief.highlights.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            )}
            {!lyBrief.ai.ok && <p className="text-xs text-muted-foreground">{t('anomaliesAiOff')}</p>}
          </div>
        )}
      </Card>

      {/* Monthly Rollup to Draft Payroll */}
      <Card className="block space-y-4 p-4 print:hidden" data-testid="hr-attendance-rollup-card">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">{t('rollupTitle')}</h2>
            <p className="text-sm text-muted-foreground">{t('rollupSubtitle')}</p>
          </div>
          {slug && (
            <Link
              to="/o/$slug/hr/payroll"
              params={{ slug }}
              className={`inline-flex items-center text-sm font-medium text-link underline-offset-4 hover:underline ${PHONE_TARGET}`}
            >
              {t('openPayrollLink')}
            </Link>
          )}
        </div>

        {draftRunsForMonth.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="hr-attendance-no-draft-run">
            {t('rollupNoDraftRun', { month })}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-56">
                <Label htmlFor="hr-attendance-rollup-run" className="text-xs text-muted-foreground">
                  {t('rollupRunLabel')}
                </Label>
                <NativeSelect
                  id="hr-attendance-rollup-run"
                  value={selectedRunId}
                  onChange={(e) => setSelectedRunId(e.target.value)}
                  className={`mt-1 w-full ${PHONE_SELECT_TARGET}`}
                  data-testid="hr-attendance-rollup-run"
                >
                  {draftRunsForMonth.map((r) => (
                    <NativeSelectOption key={r.id} value={r.id}>
                      {r.month} ({r.workingDays}d · {r.lines})
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <Button
                type="button"
                loading={rollupMut.isPending}
                disabled={!selectedRunId}
                className={PHONE_TARGET}
                onClick={() => rollupMut.mutate({ runId: selectedRunId, allowIncomplete })}
                data-testid="hr-attendance-rollup-btn"
              >
                {t('rollupBtn')}
              </Button>
            </div>

            <label className={`inline-flex items-center gap-2 text-xs text-muted-foreground cursor-pointer ${PHONE_TARGET}`}>
              <input
                type="checkbox"
                checked={allowIncomplete}
                onChange={(e) => setAllowIncomplete(e.target.checked)}
                data-testid="hr-attendance-allow-incomplete"
              />
              <span>{t('rollupAllowIncomplete')}</span>
            </label>
          </div>
        )}

        {rollupMut.error && <ErrorText>{errorMessage(rollupMut.error)}</ErrorText>}

        {rollupResult && rollupResult.runId === selectedRunId && rollupResult.month === month && (
          <div className="space-y-3" data-testid="hr-attendance-rollup-result">
            <p className="text-sm font-medium">
              {t('rollupDone', { updated: String(rollupResult.updatedCount), skipped: String(rollupResult.skippedEmployeeCount) })}
            </p>
            {rollupResult.rows.length > 0 && (
              <DataTable
                head={[
                  t('rollupTableEmployee'),
                  t('rollupTableWorkedDays'),
                  t('rollupTablePaidLeave'),
                  t('rollupTableUnpaidLeave'),
                  t('rollupTableWorkedHours'),
                  t('rollupTableOtHours'),
                  t('rollupTableNightHours'),
                ]}
                numeric={[1, 2, 3, 4, 5, 6]}
              >
                {rollupResult.rows.map((r) => (
                  <TableRow key={r.lineId}>
                    <TableCell className="px-4 py-2 font-medium">{r.employeeName}</TableCell>
                    <TableCell className="px-4 py-2 text-right tabular-nums">{r.workedDays}</TableCell>
                    <TableCell className="px-4 py-2 text-right tabular-nums">{r.paidLeaveDays}</TableCell>
                    <TableCell className="px-4 py-2 text-right tabular-nums">{r.unpaidLeaveDays}</TableCell>
                    <TableCell className="px-4 py-2 text-right tabular-nums">{r.workedHours ?? '-'}</TableCell>
                    <TableCell className="px-4 py-2 text-right tabular-nums">{r.overtimeHours}</TableCell>
                    <TableCell className="px-4 py-2 text-right tabular-nums">{r.nightHours}</TableCell>
                  </TableRow>
                ))}
              </DataTable>
            )}
          </div>
        )}
      </Card>

      {/* Attendance Logs & Manual Adjustment */}
      <Card className="block space-y-4 p-4 print:hidden" data-testid="hr-attendance-logs-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{t('logsTitle', { count: String(logs.length) })}</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={PHONE_TARGET}
            onClick={openNewAdjust}
            data-testid="hr-attendance-add-adjust"
          >
            {t('addAdjustBtn')}
          </Button>
        </div>

        {adjustOpen && (
          <form
            className="rounded-lg border border-border bg-muted/20 p-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!adjEmpId || !adjDate) return;
              const isSameEditTarget =
                editingRow !== null && editingRow.employeeId === adjEmpId && editingRow.workDate === adjDate;
              const checkedInAt =
                isSameEditTarget && adjIn.trim() === toVnTimeInput(editingRow.checkedInAt)
                  ? editingRow.checkedInAt
                  : toVnIsoTimestamp(adjDate, adjIn);
              const checkedOutAt =
                isSameEditTarget && adjOut.trim() === toVnTimeInput(editingRow.checkedOutAt)
                  ? editingRow.checkedOutAt
                  : toVnOutTimestamp(adjDate, adjIn, adjOut);
              saveAdjust.mutate({
                employeeId: adjEmpId,
                workDate: adjDate,
                checkedInAt,
                checkedOutAt,
                checkInMethod: adjMethod,
                status: adjStatus,
                ...(adjNote.trim() ? { note: adjNote.trim() } : { note: null }),
              });
            }}
            data-testid="hr-attendance-adjust-form"
          >
            <h3 className="text-sm font-semibold">{t('adjustTitle')}</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <Label htmlFor="adj-emp" className="text-xs text-muted-foreground">
                  {t('adjustEmployee')}
                </Label>
                <NativeSelect
                  id="adj-emp"
                  value={adjEmpId}
                  onChange={(e) => setAdjEmpId(e.target.value)}
                  className={`mt-1 w-full ${PHONE_SELECT_TARGET}`}
                  data-testid="hr-attendance-adj-employee"
                >
                  {scopedEmployees.map((emp) => (
                    <NativeSelectOption key={emp.id} value={emp.id}>
                      {emp.displayName}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div>
                <Label htmlFor="adj-date" className="text-xs text-muted-foreground">
                  {t('adjustDate')}
                </Label>
                <Input
                  id="adj-date"
                  type="date"
                  value={adjDate}
                  onChange={(e) => setAdjDate(e.target.value)}
                  className={`mt-1 ${PHONE_INPUT_TARGET}`}
                  required
                  data-testid="hr-attendance-adj-date"
                />
              </div>
              <div>
                <Label htmlFor="adj-status" className="text-xs text-muted-foreground">
                  {t('adjustStatus')}
                </Label>
                <NativeSelect
                  id="adj-status"
                  value={adjStatus}
                  onChange={(e) => setAdjStatus(e.target.value as 'adjusted' | 'present' | 'half_day')}
                  className={`mt-1 w-full ${PHONE_SELECT_TARGET}`}
                >
                  <NativeSelectOption value="adjusted">{ta('statuses.adjusted')}</NativeSelectOption>
                  <NativeSelectOption value="present">{ta('statuses.present')}</NativeSelectOption>
                  <NativeSelectOption value="half_day">{ta('statuses.half_day')}</NativeSelectOption>
                </NativeSelect>
              </div>
              <div>
                <Label htmlFor="adj-in" className="text-xs text-muted-foreground">
                  {t('adjustIn')}
                </Label>
                <Input
                  id="adj-in"
                  type="time"
                  value={adjIn}
                  onChange={(e) => setAdjIn(e.target.value)}
                  className={`mt-1 ${PHONE_INPUT_TARGET}`}
                  data-testid="hr-attendance-adj-in"
                />
              </div>
              <div>
                <Label htmlFor="adj-out" className="text-xs text-muted-foreground">
                  {t('adjustOut')}
                </Label>
                <Input
                  id="adj-out"
                  type="time"
                  value={adjOut}
                  onChange={(e) => setAdjOut(e.target.value)}
                  className={`mt-1 ${PHONE_INPUT_TARGET}`}
                  data-testid="hr-attendance-adj-out"
                />
              </div>
              <div>
                <Label htmlFor="adj-method" className="text-xs text-muted-foreground">
                  {t('adjustMethod')}
                </Label>
                <NativeSelect
                  id="adj-method"
                  value={adjMethod}
                  onChange={(e) => setAdjMethod(e.target.value as 'manual' | 'web' | 'qr')}
                  className={`mt-1 w-full ${PHONE_SELECT_TARGET}`}
                >
                  {HR_ATTENDANCE_METHODS.map((m) => (
                    <NativeSelectOption key={m} value={m}>
                      {ta(`methods.${m}`)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            </div>
            <div>
              <Label htmlFor="adj-note" className="text-xs text-muted-foreground">
                {t('adjustNote')}
              </Label>
              <Input
                id="adj-note"
                value={adjNote}
                onChange={(e) => setAdjNote(e.target.value)}
                maxLength={500}
                className={`mt-1 ${PHONE_INPUT_TARGET}`}
                data-testid="hr-attendance-adj-note"
              />
            </div>
            {saveAdjust.error && <ErrorText>{errorMessage(saveAdjust.error)}</ErrorText>}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                loading={saveAdjust.isPending}
                disabled={!adjEmpId}
                className={PHONE_TARGET}
                data-testid="hr-attendance-adj-save"
              >
                {t('adjustSave')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className={PHONE_TARGET}
                onClick={() => {
                  setAdjustOpen(false);
                  setEditingRow(null);
                }}
              >
                {t('adjustCancel')}
              </Button>
            </div>
          </form>
        )}

        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          <DataTable
            head={[
              t('colEmployee'),
              t('colDate'),
              t('colIn'),
              t('colOut'),
              t('colDuration'),
              t('colMethod'),
              t('colStatus'),
              t('colNote'),
              t('colActions'),
            ]}
          >
            {logs.map((row) => (
              <TableRow key={row.id} data-testid={`hr-attendance-row-${row.id}`}>
                <TableCell className="px-4 py-2 font-medium">{row.employeeName}</TableCell>
                <TableCell className="px-4 py-2 tabular-nums">{row.workDate}</TableCell>
                <TableCell className="px-4 py-2 tabular-nums">{formatVietnamTime(row.checkedInAt)}</TableCell>
                <TableCell className="px-4 py-2 tabular-nums">{formatVietnamTime(row.checkedOutAt)}</TableCell>
                <TableCell className="px-4 py-2 tabular-nums">{formatMinutesLabel(row.workedMinutes)}</TableCell>
                <TableCell className="px-4 py-2">{ta(`methods.${row.checkInMethod}`)}</TableCell>
                <TableCell className="px-4 py-2">
                  <div className="flex flex-wrap gap-1">
                    <Badge
                      variant={
                        row.status === 'missing_checkout' && row.workDate < (data?.today ?? '')
                          ? 'destructive'
                          : row.status === 'present'
                            ? 'brand'
                            : 'secondary'
                      }
                    >
                      {ta(`statuses.${row.status}`)}
                    </Badge>
                    {row.anomalies.map((kind) => (
                      <Badge key={kind} variant="outline">
                        {ta(`anomalies.${kind}`)}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="px-4 py-2 text-sm text-muted-foreground">{row.note ?? ''}</TableCell>
                <TableCell className="px-4 py-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className={PHONE_TARGET}
                    onClick={() => openEditRow(row)}
                    data-testid={`hr-attendance-edit-${row.id}`}
                  >
                    {t('editBtn')}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
        )}
      </Card>
    </div>
  );
}

// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 7A (#5216): Embedded weekly shift roster, shift template manager,
// 1-step shift swap approval queue, and Ly coverage suggestion panel inside /hr/attendance.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslations } from 'use-intl';
import {
  vietnamToday,
  type HrShiftAssignmentView,
  type HrShiftConflictKind,
  type HrShiftCoverageBrief,
  type HrShiftSwapStatus,
  type HrShiftTemplateView,
} from '@ludy/kernel-contract';
import { Badge } from '@ludy/ui/components/badge';
import { Button } from '@ludy/ui/components/button';
import { Card } from '@ludy/ui/components/card';
import { Input } from '@ludy/ui/components/input';
import { Label } from '@ludy/ui/components/label';
import { NativeSelect, NativeSelectOption } from '@ludy/ui/components/native-select';
import { Empty, ErrorText, TableSkeleton } from './ui.tsx';
import { useLocaleSetting } from '../i18n/provider.tsx';
import { errorMessage, orpc, queryClient } from '../lib/api.ts';
import { PHONE_TARGET } from '../lib/touch-target.ts';

const DAY_MS = 86_400_000;
const PHONE_SELECT = 'max-md:min-h-11 [&_select]:max-md:min-h-11';

export function mondayOfWeekLocal(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = Date.UTC(y!, m! - 1, d!);
  const dow = new Date(utc).getUTCDay();
  const offset = (dow + 6) % 7;
  return new Date(utc - offset * DAY_MS).toISOString().slice(0, 10);
}

export function addDaysLocal(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function formatMinuteClock(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function parseClockToMinute(clock: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(clock.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

const SWAP_BADGE: Record<HrShiftSwapStatus, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'destructive',
  cancelled: 'secondary',
};

const CONFLICT_BADGE: Record<HrShiftConflictKind, 'default' | 'secondary' | 'success' | 'warning' | 'destructive'> = {
  approved_leave: 'destructive',
  approved_trip: 'warning',
  public_holiday: 'default',
  short_rest: 'destructive',
};

export function HrShiftsPanel({
  legalEntityId,
  canManageOrgRoster,
}: {
  legalEntityId: string;
  canManageOrgRoster: boolean;
}) {
  const t = useTranslations('hrAttendance.shifts');
  const { locale } = useLocaleSetting();
  const lang = locale === 'en' ? 'en' : 'vi';

  const [weekStart, setWeekStart] = useState(() => mondayOfWeekLocal(vietnamToday(new Date())));
  const [departmentId, setDepartmentId] = useState('');
  const [editingCell, setEditingCell] = useState<{
    employeeId: string;
    employeeName: string;
    workDate: string;
    existing: HrShiftAssignmentView | null;
  } | null>(null);
  const [cellTemplateId, setCellTemplateId] = useState('');
  const [cellNote, setCellNote] = useState('');

  const [coverageBrief, setCoverageBrief] = useState<HrShiftCoverageBrief | null>(null);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});

  const [tplOpen, setTplOpen] = useState(false);
  const [editingTpl, setEditingTpl] = useState<HrShiftTemplateView | null>(null);
  const [tplCode, setTplCode] = useState('');
  const [tplName, setTplName] = useState('');
  const [tplStart, setTplStart] = useState('08:00');
  const [tplEnd, setTplEnd] = useState('17:00');
  const [tplBreak, setTplBreak] = useState('60');
  const [tplGraceLate, setTplGraceLate] = useState('15');
  const [tplGraceEarly, setTplGraceEarly] = useState('15');
  const [tplCrossesMidnight, setTplCrossesMidnight] = useState(false);

  const rosterInput = {
    ...(legalEntityId ? { legalEntityId } : {}),
    weekStart,
    ...(departmentId ? { departmentId } : {}),
  };

  const rosterQ = useQuery({
    ...orpc.hr.shifts.roster.get.queryOptions({ input: rosterInput }),
    staleTime: 15_000,
  });

  const swapsQ = useQuery({
    ...orpc.hr.shifts.swaps.list.queryOptions({
      input: {
        ...(legalEntityId ? { legalEntityId } : {}),
        ...(departmentId ? { departmentId } : {}),
      },
    }),
    staleTime: 15_000,
  });

  const deptsQ = useQuery({
    ...orpc.hr.departments.list.queryOptions({
      input: legalEntityId ? { legalEntityId } : {},
    }),
    enabled: canManageOrgRoster,
    staleTime: 30_000,
  });

  const refreshShifts = async () => {
    await queryClient.invalidateQueries({ queryKey: orpc.hr.shifts.key() });
    await queryClient.invalidateQueries({ queryKey: orpc.hr.attendance.key() });
  };

  const seedDefaultsMut = useMutation({
    ...orpc.hr.shifts.templates.seedDefaults.mutationOptions(),
    onSuccess: refreshShifts,
  });

  const createTplMut = useMutation({
    ...orpc.hr.shifts.templates.create.mutationOptions(),
    onSuccess: async () => {
      setTplOpen(false);
      setEditingTpl(null);
      await refreshShifts();
    },
  });

  const updateTplMut = useMutation({
    ...orpc.hr.shifts.templates.update.mutationOptions(),
    onSuccess: async () => {
      setTplOpen(false);
      setEditingTpl(null);
      await refreshShifts();
    },
  });

  const archiveTplMut = useMutation({
    ...orpc.hr.shifts.templates.archive.mutationOptions(),
    onSuccess: refreshShifts,
  });

  const upsertAssignMut = useMutation({
    ...orpc.hr.shifts.assignments.upsert.mutationOptions(),
    onSuccess: async () => {
      setEditingCell(null);
      setCellNote('');
      await refreshShifts();
    },
  });

  const deleteAssignMut = useMutation({
    ...orpc.hr.shifts.assignments.delete.mutationOptions(),
    onSuccess: async () => {
      setEditingCell(null);
      setCellNote('');
      await refreshShifts();
    },
  });

  const approveSwapMut = useMutation({
    ...orpc.hr.shifts.swaps.approve.mutationOptions(),
    onSuccess: refreshShifts,
  });

  const rejectSwapMut = useMutation({
    ...orpc.hr.shifts.swaps.reject.mutationOptions(),
    onSuccess: refreshShifts,
  });

  const coverageMut = useMutation({
    ...orpc.hr.shifts.coverage.suggest.mutationOptions(),
    onSuccess: (data) => {
      setCoverageBrief(data);
    },
  });

  const roster = rosterQ.data;
  const templates = roster?.templates ?? [];
  const employees = roster?.employees ?? [];
  const assignments = roster?.assignments ?? [];
  const swaps = swapsQ.data?.swaps ?? [];

  const weekDates = Array.from({ length: 7 }, (_, i) => addDaysLocal(weekStart, i));
  const assignmentByCell = new Map(assignments.map((a) => [`${a.employeeId}:${a.workDate}`, a]));

  const deptOptions: Array<{ id: string; name: string }> =
    canManageOrgRoster && deptsQ.data
      ? deptsQ.data.filter((d) => d.archivedAt === null).map((d) => ({ id: d.id, name: d.name }))
      : Array.from(
          new Map(
            employees
              .filter((e) => e.departmentId && e.departmentName)
              .map((e) => [e.departmentId!, e.departmentName!]),
          ).entries(),
        ).map(([id, name]) => ({ id, name }));

  const openCellEditor = (empId: string, empName: string, workDate: string) => {
    const existing = assignmentByCell.get(`${empId}:${workDate}`) ?? null;
    setEditingCell({ employeeId: empId, employeeName: empName, workDate, existing });
    setCellTemplateId(existing?.shiftTemplateId ?? templates[0]?.id ?? '');
    setCellNote(existing?.note ?? '');
  };

  const handleSaveCell = (e: FormEvent) => {
    e.preventDefault();
    if (!editingCell || !cellTemplateId) return;
    upsertAssignMut.mutate({
      ...(legalEntityId ? { legalEntityId } : {}),
      employeeId: editingCell.employeeId,
      shiftTemplateId: cellTemplateId,
      workDate: editingCell.workDate,
      note: cellNote.trim() ? cellNote.trim() : null,
    });
  };

  const openNewTemplate = () => {
    setEditingTpl(null);
    setTplCode('');
    setTplName('');
    setTplStart('08:00');
    setTplEnd('17:00');
    setTplBreak('60');
    setTplGraceLate('15');
    setTplGraceEarly('15');
    setTplCrossesMidnight(false);
    setTplOpen(true);
  };

  const openEditTemplate = (tpl: HrShiftTemplateView) => {
    setEditingTpl(tpl);
    setTplCode(tpl.code);
    setTplName(tpl.name);
    setTplStart(formatMinuteClock(tpl.startMinute));
    setTplEnd(formatMinuteClock(tpl.endMinute));
    setTplBreak(String(tpl.breakMinutes));
    setTplGraceLate(String(tpl.graceLateMinutes));
    setTplGraceEarly(String(tpl.graceEarlyMinutes));
    setTplCrossesMidnight(tpl.crossesMidnight);
    setTplOpen(true);
  };

  const handleSaveTemplate = (e: FormEvent) => {
    e.preventDefault();
    const startMinute = parseClockToMinute(tplStart);
    const endMinute = parseClockToMinute(tplEnd);
    if (startMinute === null || endMinute === null) return;
    const breakMinutes = Number(tplBreak) || 0;
    const graceLateMinutes = Number(tplGraceLate) || 0;
    const graceEarlyMinutes = Number(tplGraceEarly) || 0;
    if (editingTpl) {
      updateTplMut.mutate({
        templateId: editingTpl.id,
        code: tplCode,
        name: tplName,
        startMinute,
        endMinute,
        breakMinutes,
        graceLateMinutes,
        graceEarlyMinutes,
        crossesMidnight: tplCrossesMidnight,
      });
    } else {
      createTplMut.mutate({
        ...(legalEntityId ? { legalEntityId } : {}),
        code: tplCode,
        name: tplName,
        startMinute,
        endMinute,
        breakMinutes,
        graceLateMinutes,
        graceEarlyMinutes,
        crossesMidnight: tplCrossesMidnight,
      });
    }
  };

  const applyCoverageSuggestion = (workDate: string, shiftCode: string | null, candidateId: string | null) => {
    if (!candidateId || !shiftCode) return;
    const tpl = templates.find((item) => item.code === shiftCode);
    if (!tpl) return;
    upsertAssignMut.mutate({
      ...(legalEntityId ? { legalEntityId } : {}),
      employeeId: candidateId,
      shiftTemplateId: tpl.id,
      workDate,
      note: t('appliedSuggestionNote'),
    });
  };

  if (rosterQ.isLoading && !roster) {
    return <TableSkeleton rows={5} columns={8} />;
  }

  return (
    <div className="space-y-6" data-testid="hr-shifts-panel">
      {/* Toolbar & Weekly Roster Card */}
      <Card className="block space-y-4 p-4" data-testid="hr-shifts-roster-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-medium text-foreground">{t('rosterTitle')}</h2>
            <p className="text-sm text-muted-foreground">
              {t('weekRangeLabel', { start: weekStart, end: roster?.weekEnd ?? addDaysLocal(weekStart, 6) })}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={PHONE_TARGET}
              onClick={() => {
                setWeekStart((w) => addDaysLocal(w, -7));
                setCoverageBrief(null);
              }}
              data-testid="hr-shifts-prev-week"
            >
              {t('prevWeekBtn')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={PHONE_TARGET}
              onClick={() => {
                setWeekStart(mondayOfWeekLocal(vietnamToday(new Date())));
                setCoverageBrief(null);
              }}
              data-testid="hr-shifts-this-week"
            >
              {t('thisWeekBtn')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={PHONE_TARGET}
              onClick={() => {
                setWeekStart((w) => addDaysLocal(w, 7));
                setCoverageBrief(null);
              }}
              data-testid="hr-shifts-next-week"
            >
              {t('nextWeekBtn')}
            </Button>
            {deptOptions.length > 0 && (
              <div className={PHONE_SELECT}>
                <NativeSelect
                  value={departmentId}
                  onChange={(e) => {
                    setDepartmentId(e.target.value);
                    setCoverageBrief(null);
                  }}
                  aria-label={t('departmentFilterLabel')}
                  data-testid="hr-shifts-dept-filter"
                >
                  <NativeSelectOption value="">{t('allDepartments')}</NativeSelectOption>
                  {deptOptions.map((d) => (
                    <NativeSelectOption key={d.id} value={d.id}>
                      {d.name}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
            )}
            {(canManageOrgRoster || roster?.canManageOrgRoster) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={PHONE_TARGET}
                disabled={seedDefaultsMut.isPending}
                onClick={() => seedDefaultsMut.mutate(legalEntityId ? { legalEntityId } : {})}
                data-testid="hr-shifts-seed-defaults"
              >
                {t('seedDefaultsBtn')}
              </Button>
            )}
          </div>
        </div>

        {rosterQ.error && <ErrorText>{errorMessage(rosterQ.error)}</ErrorText>}
        {seedDefaultsMut.error && <ErrorText>{errorMessage(seedDefaultsMut.error)}</ErrorText>}

        {templates.length === 0 ? (
          <Empty
            title={t('noTemplatesTitle')}
            body={t('noTemplatesBody')}
          />
        ) : employees.length === 0 ? (
          <Empty
            title={t('noEmployeesTitle')}
            body={t('noEmployeesBody')}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm" data-testid="hr-shifts-grid">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">{t('colEmployee')}</th>
                  {weekDates.map((d) => (
                    <th key={d} className="min-w-28 px-2 py-2 font-medium tabular-nums">
                      {d.slice(5)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {employees.map((emp) => (
                  <tr key={emp.id} className="border-b border-border/60">
                    <td className="py-2 pr-3 align-top">
                      <div className="font-medium text-foreground">{emp.displayName}</div>
                      {emp.departmentName && (
                        <div className="text-xs text-muted-foreground">{emp.departmentName}</div>
                      )}
                    </td>
                    {weekDates.map((d) => {
                      const assign = assignmentByCell.get(`${emp.id}:${d}`);
                      return (
                        <td key={d} className="px-2 py-2 align-top">
                          <button
                            type="button"
                            onClick={() => openCellEditor(emp.id, emp.displayName, d)}
                            className="flex min-h-11 w-full flex-col items-start justify-center rounded-md border border-border bg-muted/20 px-2 py-1 text-left transition-colors hover:border-primary"
                            aria-label={t('cellAria', { name: emp.displayName, date: d })}
                            data-testid={`hr-shift-cell-${emp.id}-${d}`}
                          >
                            {assign ? (
                              <>
                                <span className="font-medium text-foreground">{assign.shiftCode}</span>
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  {formatMinuteClock(assign.startMinute)} - {formatMinuteClock(assign.endMinute)}
                                </span>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground">{t('assignCellEmpty')}</span>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {editingCell && (
          <form
            onSubmit={handleSaveCell}
            className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
            data-testid="hr-shifts-cell-form"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm font-medium text-foreground">
                {t('editCellTitle', { name: editingCell.employeeName, date: editingCell.workDate })}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={PHONE_TARGET}
                onClick={() => setEditingCell(null)}
              >
                {t('cancelBtn')}
              </Button>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="hr-shift-cell-template">{t('templateFieldLabel')}</Label>
                <div className={PHONE_SELECT}>
                  <NativeSelect
                    id="hr-shift-cell-template"
                    value={cellTemplateId}
                    onChange={(e) => setCellTemplateId(e.target.value)}
                    data-testid="hr-shifts-cell-template"
                  >
                    {templates.map((tpl) => (
                      <NativeSelectOption key={tpl.id} value={tpl.id}>
                        {tpl.code} - {tpl.name} ({formatMinuteClock(tpl.startMinute)} - {formatMinuteClock(tpl.endMinute)})
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="hr-shift-cell-note">{t('noteFieldLabel')}</Label>
                <Input
                  id="hr-shift-cell-note"
                  value={cellNote}
                  onChange={(e) => setCellNote(e.target.value)}
                  maxLength={500}
                  className={PHONE_TARGET}
                  data-testid="hr-shifts-cell-note"
                />
              </div>
            </div>
            {(upsertAssignMut.error || deleteAssignMut.error) && (
              <ErrorText>{errorMessage(upsertAssignMut.error ?? deleteAssignMut.error)}</ErrorText>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="submit"
                size="sm"
                className={PHONE_TARGET}
                disabled={upsertAssignMut.isPending || !cellTemplateId}
                data-testid="hr-shifts-cell-save"
              >
                {t('saveCellBtn')}
              </Button>
              {editingCell.existing && (
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  className={PHONE_TARGET}
                  disabled={deleteAssignMut.isPending}
                  onClick={() => deleteAssignMut.mutate({ assignmentId: editingCell.existing!.id })}
                  data-testid="hr-shifts-cell-delete"
                >
                  {t('deleteCellBtn')}
                </Button>
              )}
            </div>
          </form>
        )}
      </Card>

      {/* Coverage Conflicts & Ly Coverage Coworker */}
      <Card className="block space-y-4 p-4" data-testid="hr-shifts-coverage-card">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-medium text-foreground">{t('coverageTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('coverageHint')}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={PHONE_TARGET}
            disabled={coverageMut.isPending}
            onClick={() =>
              coverageMut.mutate({
                ...(legalEntityId ? { legalEntityId } : {}),
                weekStart,
                ...(departmentId ? { departmentId } : {}),
                lang,
              })
            }
            data-testid="hr-shifts-coverage-ask"
          >
            {coverageMut.isPending ? t('coverageLoadingBtn') : t('coverageAskBtn')}
          </Button>
        </div>

        {coverageMut.error && <ErrorText>{errorMessage(coverageMut.error)}</ErrorText>}

        {coverageBrief && (
          <div className="space-y-3" data-testid="hr-shifts-coverage-result">
            <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-foreground">{t('lyCoverageTitle')}</span>
                <Badge variant={coverageBrief.ai.ok ? 'success' : 'secondary'}>
                  {coverageBrief.ai.ok ? t('aiOkBadge') : t('aiFallbackBadge')}
                </Badge>
              </div>
              <p className="text-sm text-foreground">{coverageBrief.summary}</p>
              {coverageBrief.highlights.length > 0 && (
                <ul className="list-disc pl-5 text-sm text-muted-foreground space-y-1">
                  {coverageBrief.highlights.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              )}
            </div>

            {coverageBrief.conflicts.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">{t('conflictsListTitle')}</div>
                <div className="space-y-2">
                  {coverageBrief.conflicts.map((c) => (
                    <div
                      key={`${c.assignmentId}:${c.kind}`}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2.5 text-sm"
                    >
                      <div>
                        <span className="font-medium">{c.employeeName}</span>{' '}
                        <span className="text-muted-foreground">({c.workDate} · {c.shiftCode})</span>
                        <div className="text-xs text-muted-foreground">{c.detail}</div>
                      </div>
                      <Badge variant={CONFLICT_BADGE[c.kind]}>{t(`conflictKinds.${c.kind}`)}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {coverageBrief.gaps.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">{t('suggestionsListTitle')}</div>
                {coverageBrief.gaps.map((gap) => (
                  <div
                    key={`${gap.date}:${gap.shiftCode ?? ''}:${gap.departmentId ?? ''}`}
                    className="space-y-2 rounded-md border border-border p-3 text-sm"
                  >
                    <div className="font-medium">
                      {gap.date} · {gap.shiftCode ?? ''} ({gap.departmentName ?? t('noDepartmentLabel')})
                    </div>
                    <div className="text-xs text-muted-foreground">{gap.reason}</div>
                    {gap.candidates.length === 0 ? (
                      <div className="text-xs text-muted-foreground">{t('noCandidatesLabel')}</div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {gap.candidates.map((cand) => (
                          <Button
                            key={cand.employeeId}
                            type="button"
                            variant="outline"
                            size="sm"
                            className={PHONE_TARGET}
                            disabled={upsertAssignMut.isPending}
                            onClick={() => applyCoverageSuggestion(gap.date, gap.shiftCode, cand.employeeId)}
                          >
                            {t('applyCandidateBtn', { name: cand.employeeName, count: String(cand.weeklyShiftCount) })}
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* 1-Step Shift Swap Approval Queue */}
      <Card className="block space-y-4 p-4" data-testid="hr-shifts-swaps-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-medium text-foreground">{t('swapsTitle')}</h3>
            <p className="text-sm text-muted-foreground">{t('swapsHint')}</p>
          </div>
          <Badge variant="outline">
            {t('pendingSwapsCount', { count: String(swaps.filter((s) => s.status === 'pending').length) })}
          </Badge>
        </div>

        {(approveSwapMut.error || rejectSwapMut.error) && (
          <ErrorText>{errorMessage(approveSwapMut.error ?? rejectSwapMut.error)}</ErrorText>
        )}

        {swaps.length === 0 ? (
          <Empty title={t('noSwapsTitle')} body={t('noSwapsBody')} />
        ) : (
          <div className="space-y-3">
            {swaps.map((s) => (
              <div
                key={s.id}
                className="space-y-2 rounded-md border border-border p-3 text-sm"
                data-testid={`hr-shift-swap-row-${s.id}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-foreground">
                    {s.requesterName} ({s.requesterShiftCode}) → {s.targetName} (
                    {s.targetShiftCode ?? t('unscheduledTakeover')}) · {s.workDate}
                  </div>
                  <Badge variant={SWAP_BADGE[s.status]}>{t(`swapStatuses.${s.status}`)}</Badge>
                </div>
                {s.reason && <p className="text-xs text-muted-foreground">{s.reason}</p>}
                {s.decisionNote && (
                  <p className="text-xs text-muted-foreground">
                    {t('decisionNotePrefix')}: {s.decisionNote}
                  </p>
                )}
                {s.status === 'pending' && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Input
                      value={decisionNotes[s.id] ?? ''}
                      onChange={(e) => setDecisionNotes((prev) => ({ ...prev, [s.id]: e.target.value }))}
                      aria-label={t('decisionNotePlaceholder')}
                      placeholder={t('decisionNotePlaceholder')}
                      maxLength={1000}
                      className={`max-w-xs ${PHONE_TARGET}`}
                      data-testid={`hr-shift-swap-note-${s.id}`}
                    />
                    <Button
                      type="button"
                      size="sm"
                      className={PHONE_TARGET}
                      disabled={approveSwapMut.isPending || rejectSwapMut.isPending}
                      onClick={() =>
                        approveSwapMut.mutate({
                          swapId: s.id,
                          decisionNote: decisionNotes[s.id]?.trim() || null,
                        })
                      }
                      data-testid={`hr-shift-swap-approve-${s.id}`}
                    >
                      {t('approveSwapBtn')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={PHONE_TARGET}
                      disabled={approveSwapMut.isPending || rejectSwapMut.isPending}
                      onClick={() =>
                        rejectSwapMut.mutate({
                          swapId: s.id,
                          decisionNote: decisionNotes[s.id]?.trim() || null,
                        })
                      }
                      data-testid={`hr-shift-swap-reject-${s.id}`}
                    >
                      {t('rejectSwapBtn')}
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Shift Templates Admin Section */}
      {(canManageOrgRoster || roster?.canManageOrgRoster) && (
        <Card className="block space-y-4 p-4" data-testid="hr-shifts-templates-card">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-medium text-foreground">{t('templatesTitle')}</h3>
              <p className="text-sm text-muted-foreground">{t('templatesHint')}</p>
            </div>
            <Button
              type="button"
              size="sm"
              className={PHONE_TARGET}
              onClick={openNewTemplate}
              data-testid="hr-shifts-template-new"
            >
              {t('newTemplateBtn')}
            </Button>
          </div>

          {tplOpen && (
            <form
              onSubmit={handleSaveTemplate}
              className="space-y-3 rounded-lg border border-border bg-muted/20 p-4"
              data-testid="hr-shifts-template-form"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1">
                  <Label htmlFor="hr-tpl-code">{t('tplCodeLabel')}</Label>
                  <Input
                    id="hr-tpl-code"
                    value={tplCode}
                    onChange={(e) => setTplCode(e.target.value)}
                    placeholder="CA_TOI"
                    required
                    className={PHONE_TARGET}
                  />
                </div>
                <div className="space-y-1 sm:col-span-2">
                  <Label htmlFor="hr-tpl-name">{t('tplNameLabel')}</Label>
                  <Input
                    id="hr-tpl-name"
                    value={tplName}
                    onChange={(e) => setTplName(e.target.value)}
                    placeholder={t('tplNamePlaceholder')}
                    required
                    className={PHONE_TARGET}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="hr-tpl-start">{t('tplStartLabel')}</Label>
                  <Input
                    id="hr-tpl-start"
                    type="time"
                    value={tplStart}
                    onChange={(e) => setTplStart(e.target.value)}
                    required
                    className={PHONE_TARGET}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="hr-tpl-end">{t('tplEndLabel')}</Label>
                  <Input
                    id="hr-tpl-end"
                    type="time"
                    value={tplEnd}
                    onChange={(e) => setTplEnd(e.target.value)}
                    required
                    className={PHONE_TARGET}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="hr-tpl-break">{t('tplBreakLabel')}</Label>
                  <Input
                    id="hr-tpl-break"
                    type="number"
                    min={0}
                    max={480}
                    value={tplBreak}
                    onChange={(e) => setTplBreak(e.target.value)}
                    className={PHONE_TARGET}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="hr-tpl-late">{t('tplGraceLateLabel')}</Label>
                  <Input
                    id="hr-tpl-late"
                    type="number"
                    min={0}
                    max={120}
                    value={tplGraceLate}
                    onChange={(e) => setTplGraceLate(e.target.value)}
                    className={PHONE_TARGET}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="hr-tpl-early">{t('tplGraceEarlyLabel')}</Label>
                  <Input
                    id="hr-tpl-early"
                    type="number"
                    min={0}
                    max={120}
                    value={tplGraceEarly}
                    onChange={(e) => setTplGraceEarly(e.target.value)}
                    className={PHONE_TARGET}
                  />
                </div>
                <label className="flex min-h-11 items-center gap-2 pt-5 text-sm">
                  <input
                    type="checkbox"
                    checked={tplCrossesMidnight}
                    onChange={(e) => setTplCrossesMidnight(e.target.checked)}
                    className="h-4 w-4"
                  />
                  <span>{t('tplCrossesMidnightLabel')}</span>
                </label>
              </div>
              {(createTplMut.error || updateTplMut.error) && (
                <ErrorText>{errorMessage(createTplMut.error ?? updateTplMut.error)}</ErrorText>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="submit"
                  size="sm"
                  className={PHONE_TARGET}
                  disabled={createTplMut.isPending || updateTplMut.isPending}
                >
                  {t('saveTemplateBtn')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={PHONE_TARGET}
                  onClick={() => {
                    setTplOpen(false);
                    setEditingTpl(null);
                  }}
                >
                  {t('cancelBtn')}
                </Button>
              </div>
            </form>
          )}

          {templates.length > 0 && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {templates.map((tpl) => (
                <div
                  key={tpl.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border p-3 text-sm"
                >
                  <div>
                    <div className="flex items-center gap-2 font-medium text-foreground">
                      <span>{tpl.code}</span>
                      <span className="text-muted-foreground">· {tpl.name}</span>
                      {tpl.crossesMidnight && <Badge variant="secondary">{t('overnightBadge')}</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatMinuteClock(tpl.startMinute)} - {formatMinuteClock(tpl.endMinute)} · {t('breakSummary', { minutes: String(tpl.breakMinutes) })} · {t('graceSummary', { late: String(tpl.graceLateMinutes), early: String(tpl.graceEarlyMinutes) })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={PHONE_TARGET}
                      onClick={() => openEditTemplate(tpl)}
                    >
                      {t('editBtn')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className={PHONE_TARGET}
                      disabled={archiveTplMut.isPending}
                      onClick={() => archiveTplMut.mutate({ templateId: tpl.id })}
                    >
                      {t('archiveBtn')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

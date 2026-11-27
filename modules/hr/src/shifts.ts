// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 7A (#5216): SME shift templates, weekly roster, 1-step shift swap,
// shift adherence / Art. 106 break-adjusted night minute math, and deterministic coverage read/audit.
import { sql } from 'kysely';
import {
  HR_DEFAULT_SHIFT_TEMPLATES,
  isValidShiftWindow,
  isVietnamHoliday,
  shiftDurationMinutes,
  tableWrite,
  vietnamToday,
  zHrSelfShiftSwapCancel,
  zHrSelfShiftSwapSubmit,
  zHrSelfShiftsList,
  zHrShiftAssignmentDelete,
  zHrShiftAssignmentUpsert,
  zHrShiftCoverageAsk,
  zHrShiftCoverageAudit,
  zHrShiftRosterGet,
  zHrShiftSwapDecide,
  zHrShiftSwapList,
  zHrShiftTemplateArchive,
  zHrShiftTemplateCreate,
  zHrShiftTemplateList,
  zHrShiftTemplateSeedDefaults,
  zHrShiftTemplateUpdate,
  type HrAttendanceStatus,
  type HrSelfShiftSwapCancel,
  type HrSelfShiftSwapSubmit,
  type HrSelfShiftsList,
  type HrSelfShiftsResult,
  type HrShiftAssignmentDelete,
  type HrShiftAssignmentDeleteResult,
  type HrShiftAssignmentUpsert,
  type HrShiftAssignmentView,
  type HrShiftCoverageAsk,
  type HrShiftCoverageAudit,
  type HrShiftCoverageCandidate,
  type HrShiftCoverageConflict,
  type HrShiftCoverageGap,
  type HrShiftCoverageSnapshot,
  type HrShiftRosterGet,
  type HrShiftRosterResult,
  type HrShiftSwapDecide,
  type HrShiftSwapList,
  type HrShiftSwapListResult,
  type HrShiftSwapStatus,
  type HrShiftSwapView,
  type HrShiftTemplateArchive,
  type HrShiftTemplateCreate,
  type HrShiftTemplateList,
  type HrShiftTemplateListResult,
  type HrShiftTemplateSeedDefaults,
  type HrShiftTemplateSeedResult,
  type HrShiftTemplateUpdate,
  type HrShiftTemplateView,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { MANAGERS, resolveEntity, userOf } from './employees.ts';
import { STAFF_ROLES, resolveSelfEmployee } from './leave-requests.ts';
import { hrManifest } from './manifest.ts';
import {
  isSoleOwnerOrg,
  loadDepartmentNameMap,
  loadManagedDepartmentSet,
  requireStage6bRole,
} from './stage6b-shared.ts';

export const VN_OFFSET_MS = 7 * 3_600_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const SHORT_REST_MIN_MS = 12 * HOUR_MS;

type Trx = QueryContext['trx'];

export interface ShiftTemplateWindow {
  id: string;
  code: string;
  name: string;
  startMinute: number;
  endMinute: number;
  breakMinutes: number;
  graceLateMinutes: number;
  graceEarlyMinutes: number;
  crossesMidnight: boolean;
}

interface VisibleShiftEmployee {
  id: string;
  legal_entity_id: string;
  department_id: string | null;
  display_name: string;
  status: string;
}

interface LockedShiftEmployee extends VisibleShiftEmployee {
  is_erased: boolean;
  user_id: string | null;
}

interface UnavailableSpan {
  employee_id: string;
  source: string;
  start_on: Date | string;
  end_on: Date | string;
}

function isoDateOnly(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function isoTs(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoTsNullable(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return isoTs(value);
}

export function addDaysLocalDate(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export function mondayOfLocalWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = Date.UTC(y!, m! - 1, d!);
  const dow = new Date(utc).getUTCDay();
  const offset = (dow + 6) % 7;
  return new Date(utc - offset * DAY_MS).toISOString().slice(0, 10);
}

export function formatShiftTime(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Exact overlap minutes between `[startAt, endAt)` and Vietnam night hours 22:00-06:00 (BLLĐ Art. 106). */
export function nightOverlapMinutes(startAt: Date | null, endAt: Date | null): number {
  if (!startAt || !endAt || endAt.getTime() <= startAt.getTime()) return 0;
  const startVn = startAt.getTime() + VN_OFFSET_MS;
  const endVn = endAt.getTime() + VN_OFFSET_MS;
  const firstDay = Math.floor(startVn / DAY_MS) - 1;
  const lastDay = Math.floor(endVn / DAY_MS) + 1;
  let overlapMs = 0;
  for (let d = firstDay; d <= lastDay; d += 1) {
    const winStart = d * DAY_MS + 22 * HOUR_MS;
    const winEnd = (d + 1) * DAY_MS + 6 * HOUR_MS;
    const lo = Math.max(startVn, winStart);
    const hi = Math.min(endVn, winEnd);
    if (hi > lo) overlapMs += hi - lo;
  }
  return Math.floor(overlapMs / 60_000);
}

/** Computes exact start and end epoch milliseconds in UTC for an assigned shift on `workDate` (+07:00). */
export function computeShiftWindowMs(
  workDate: string,
  shift: Pick<ShiftTemplateWindow, 'startMinute' | 'endMinute' | 'crossesMidnight'>,
): { startMs: number; endMs: number; spanMinutes: number } {
  const dayStartMs = Date.parse(`${workDate}T00:00:00.000+07:00`);
  const spanMinutes = shiftDurationMinutes(shift.startMinute, shift.endMinute, shift.crossesMidnight);
  const startMs = dayStartMs + shift.startMinute * 60_000;
  const endMs = startMs + spanMinutes * 60_000;
  return { startMs, endMs, spanMinutes };
}

/**
 * Pure per-log adherence calculation: computes late arrival and early leave minutes beyond grace thresholds.
 * Lateness is informational only; Vietnamese Labor Code Art. 127 prohibits deducting wages as disciplinary fines.
 */
export function computeShiftAdherence(args: {
  workDate: string;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  status: HrAttendanceStatus;
  shift: Pick<ShiftTemplateWindow, 'startMinute' | 'endMinute' | 'graceLateMinutes' | 'graceEarlyMinutes' | 'crossesMidnight'> | null | undefined;
}): { lateMinutes: number; earlyLeaveMinutes: number } {
  const { workDate, checkedInAt, checkedOutAt, status, shift } = args;
  if (!shift) return { lateMinutes: 0, earlyLeaveMinutes: 0 };

  const { startMs, endMs } = computeShiftWindowMs(workDate, shift);
  let lateMinutes = 0;
  if (checkedInAt) {
    const rawLate = Math.floor((checkedInAt.getTime() - startMs) / 60_000);
    if (rawLate > shift.graceLateMinutes) {
      lateMinutes = rawLate;
    }
  }

  let earlyLeaveMinutes = 0;
  if (checkedOutAt && status !== 'missing_checkout') {
    const rawEarly = Math.floor((endMs - checkedOutAt.getTime()) / 60_000);
    if (rawEarly > shift.graceEarlyMinutes) {
      earlyLeaveMinutes = rawEarly;
    }
  }

  return { lateMinutes, earlyLeaveMinutes };
}

/**
 * Computes raw Art. 106 22:00-06:00 night minutes over `[startAt, endAt)`, capped by `capMinutes`.
 * Under BLLĐ Art. 109(1), breaks inside continuous >= 6h shifts count as paid working time and
 * are not deducted from night overlap.
 */
export function computeShiftAdjustedNightMinutes(
  startAt: Date | null,
  endAt: Date | null,
  capMinutes: number,
): number {
  if (!startAt || !endAt || capMinutes <= 0) return 0;
  const spanMinutes = Math.max(0, Math.floor((endAt.getTime() - startAt.getTime()) / 60_000));
  if (spanMinutes <= 0) return 0;
  const rawNight = Math.min(spanMinutes, nightOverlapMinutes(startAt, endAt));
  return Math.min(capMinutes, rawNight);
}

function toTemplateView(row: {
  id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  start_minute: number;
  end_minute: number;
  break_minutes: number;
  grace_late_minutes: number;
  grace_early_minutes: number;
  crosses_midnight: boolean;
  archived_at: Date | string | null;
  updated_at: Date | string;
}): HrShiftTemplateView {
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    code: row.code,
    name: row.name,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    breakMinutes: row.break_minutes,
    graceLateMinutes: row.grace_late_minutes,
    graceEarlyMinutes: row.grace_early_minutes,
    crossesMidnight: row.crosses_midnight,
    durationMinutes: shiftDurationMinutes(row.start_minute, row.end_minute, row.crosses_midnight),
    archivedAt: isoTsNullable(row.archived_at),
    updatedAt: isoTs(row.updated_at),
  };
}

export function toShiftTemplateWindow(row: {
  id: string;
  code: string;
  name: string;
  start_minute: number;
  end_minute: number;
  break_minutes: number;
  grace_late_minutes: number;
  grace_early_minutes: number;
  crosses_midnight: boolean;
}): ShiftTemplateWindow {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    startMinute: row.start_minute,
    endMinute: row.end_minute,
    breakMinutes: row.break_minutes,
    graceLateMinutes: row.grace_late_minutes,
    graceEarlyMinutes: row.grace_early_minutes,
    crossesMidnight: row.crosses_midnight,
  };
}

function isPgCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function forbiddenRosterError(): DomainError {
  return new DomainError('FORBIDDEN', 403, 'Chỉ quản lý phòng ban hoặc quản trị viên nhân sự mới được thao tác lịch phân ca');
}

function templateNotFound(): DomainError {
  return new DomainError('NOT_FOUND', 404, 'Không tìm thấy mẫu ca làm việc');
}

function assignmentNotFound(): DomainError {
  return new DomainError('NOT_FOUND', 404, 'Không tìm thấy lịch phân ca');
}

function swapNotFound(): DomainError {
  return new DomainError('NOT_FOUND', 404, 'Không tìm thấy yêu cầu đổi ca');
}

async function lockShiftEmployee(
  trx: Trx,
  orgId: string,
  employeeId: string,
  opts: { allowEnded?: boolean } = {},
): Promise<LockedShiftEmployee> {
  const { rows } = await sql<LockedShiftEmployee>`
    SELECT id, legal_entity_id, department_id, display_name, status, is_erased, user_id
      FROM ludy_hr.lock_shift_employee_active(${orgId}::uuid, ${employeeId}::uuid)
  `.execute(trx);
  const emp = rows[0];
  if (!emp) {
    throw new DomainError('NOT_FOUND', 404, 'Không tìm thấy hồ sơ nhân viên');
  }
  if (emp.is_erased) {
    throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã được xóa theo yêu cầu');
  }
  if (!opts.allowEnded && emp.status !== 'active') {
    throw new DomainError('HR_EMPLOYEE_ENDED', 409, 'Nhân viên đã kết thúc làm việc, không thể phân ca hoặc đổi ca');
  }
  return emp;
}

async function loadVisibleEmployees(trx: Trx, orgId: string, legalEntityId: string): Promise<VisibleShiftEmployee[]> {
  const { rows } = await sql<VisibleShiftEmployee>`
    SELECT id, legal_entity_id, department_id, display_name, status
      FROM ludy_hr.shift_visible_employees(${orgId}::uuid, ${legalEntityId}::uuid)
  `.execute(trx);
  return rows;
}

async function loadUnavailableSpans(
  trx: Trx,
  orgId: string,
  legalEntityId: string,
  startOn: string,
  endOn: string,
): Promise<UnavailableSpan[]> {
  const { rows } = await sql<UnavailableSpan>`
    SELECT employee_id, source, start_on, end_on
      FROM ludy_hr.shift_unavailable_employee_dates(
        ${orgId}::uuid,
        ${legalEntityId}::uuid,
        ${startOn}::date,
        ${endOn}::date
      )
  `.execute(trx);
  return rows;
}

async function loadShiftDeptNames(
  trx: Trx,
  orgId: string,
  departmentIds: readonly (string | null | undefined)[],
): Promise<Map<string, string>> {
  const unique = [...new Set(departmentIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return new Map();
  const map = await loadDepartmentNameMap(trx, orgId, unique);
  const out = new Map<string, string>();
  for (const [id, info] of map.entries()) {
    out.set(id, info.name);
  }
  return out;
}

async function loadSwapAssignmentLabels(
  trx: Trx,
  orgId: string,
  legalEntityId: string,
  assignmentIds: readonly string[],
): Promise<Map<string, { code: string; name: string }>> {
  if (assignmentIds.length === 0) return new Map();
  const { rows } = await sql<{
    assignment_id: string;
    shift_template_id: string;
    shift_code: string;
    shift_name: string;
  }>`
    SELECT assignment_id, shift_template_id, shift_code, shift_name
      FROM ludy_hr.shift_swap_assignment_labels(
        ${orgId}::uuid,
        ${legalEntityId}::uuid,
        ${[...assignmentIds]}::uuid[]
      )
  `.execute(trx);
  return new Map(rows.map((r) => [r.assignment_id, { code: r.shift_code, name: r.shift_name }]));
}

async function resolveManagerScope(
  ctx: Parameters<Parameters<typeof defineQuery>[0]['handler']>[0],
  requestedEntityId: string | undefined,
  requestedDepartmentId?: string | undefined,
): Promise<{
  callerUserId: string;
  isAdmin: boolean;
  legalEntityId: string;
  managedDeptIds: Set<string>;
}> {
  const callerUserId = userOf(ctx.actor);
  const isAdmin = ctx.role === 'owner' || ctx.role === 'admin';
  const managedDepts = isAdmin ? [] : await loadManagedDepartmentSet(ctx.trx, ctx.orgId, callerUserId);
  const managedDeptIds = new Set(managedDepts.map((d) => d.id));

  if (!isAdmin && managedDeptIds.size === 0) {
    throw forbiddenRosterError();
  }

  let legalEntityId: string;
  if (requestedEntityId) {
    legalEntityId = await resolveEntity(ctx, requestedEntityId);
  } else if (!isAdmin && managedDeptIds.size > 0) {
    const firstManaged = await ctx.trx
      .selectFrom('ludy_hr.department')
      .select(['legal_entity_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', [...managedDeptIds])
      .where('archived_at', 'is', null)
      .orderBy('id', 'asc')
      .limit(1)
      .executeTakeFirst();
    legalEntityId = firstManaged?.legal_entity_id ?? (await resolveEntity(ctx, undefined));
  } else {
    legalEntityId = await resolveEntity(ctx, undefined);
  }

  if (requestedDepartmentId && !isAdmin && !managedDeptIds.has(requestedDepartmentId)) {
    throw forbiddenRosterError();
  }

  return { callerUserId, isAdmin, legalEntityId, managedDeptIds };
}

async function assertCanManageDepartment(
  trx: Trx,
  orgId: string,
  isAdmin: boolean,
  departmentId: string | null,
): Promise<void> {
  if (isAdmin) return;
  if (!departmentId) {
    throw forbiddenRosterError();
  }
  const { rows } = await sql<{ locked: boolean }>`
    SELECT ludy_hr.lock_active_department_manager(${orgId}::uuid, ${departmentId}::uuid) AS locked
  `.execute(trx);
  if (!rows[0]?.locked) {
    throw forbiddenRosterError();
  }
}

async function mapAssignmentViews(
  trx: Trx,
  orgId: string,
  legalEntityId: string,
  rows: readonly {
    id: string;
    legal_entity_id: string;
    employee_id: string;
    department_id: string | null;
    shift_template_id: string;
    work_date: Date | string;
    note: string | null;
    updated_at: Date | string;
  }[],
  preloaded?: {
    visibleEmps?: VisibleShiftEmployee[];
    deptNames?: Map<string, string>;
  },
): Promise<HrShiftAssignmentView[]> {
  if (rows.length === 0) return [];
  const tplIds = [...new Set(rows.map((r) => r.shift_template_id))];
  const [visibleEmps, deptNames, tplRows] = await Promise.all([
    preloaded?.visibleEmps ? Promise.resolve(preloaded.visibleEmps) : loadVisibleEmployees(trx, orgId, legalEntityId),
    preloaded?.deptNames
      ? Promise.resolve(preloaded.deptNames)
      : loadShiftDeptNames(trx, orgId, rows.map((r) => r.department_id)),
    trx
      .selectFrom('ludy_hr.shift_template')
      .select([
        'id',
        'code',
        'name',
        'start_minute',
        'end_minute',
        'break_minutes',
        'grace_late_minutes',
        'grace_early_minutes',
        'crosses_midnight',
      ])
      .where('org_id', '=', orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('id', 'in', tplIds)
      .execute(),
  ]);

  const empNameById = new Map(visibleEmps.map((e) => [e.id, e.display_name]));
  const tplById = new Map(tplRows.map((t) => [t.id, t]));

  return rows.map((row) => {
    const tpl = tplById.get(row.shift_template_id);
    return {
      id: row.id,
      legalEntityId: row.legal_entity_id,
      employeeId: row.employee_id,
      employeeName: empNameById.get(row.employee_id) ?? 'Nhân viên',
      departmentId: row.department_id,
      departmentName: row.department_id ? (deptNames.get(row.department_id) ?? null) : null,
      shiftTemplateId: row.shift_template_id,
      shiftCode: tpl?.code ?? '',
      shiftName: tpl?.name ?? '',
      startMinute: tpl?.start_minute ?? 0,
      endMinute: tpl?.end_minute ?? 60,
      breakMinutes: tpl?.break_minutes ?? 0,
      graceLateMinutes: tpl?.grace_late_minutes ?? 0,
      graceEarlyMinutes: tpl?.grace_early_minutes ?? 0,
      crossesMidnight: tpl?.crosses_midnight ?? false,
      workDate: isoDateOnly(row.work_date),
      note: row.note,
      updatedAt: isoTs(row.updated_at),
    };
  });
}

async function mapSwapViews(
  trx: Trx,
  orgId: string,
  legalEntityId: string,
  rows: readonly {
    id: string;
    legal_entity_id: string;
    requester_employee_id: string;
    target_employee_id: string;
    requester_assignment_id: string;
    target_assignment_id: string | null;
    department_id: string | null;
    work_date: Date | string;
    reason: string | null;
    status: HrShiftSwapStatus;
    decided_by: string | null;
    decided_at: Date | string | null;
    decision_note: string | null;
    created_at: Date | string;
    updated_at: Date | string;
  }[],
  preloaded?: {
    visibleEmps?: VisibleShiftEmployee[];
    deptNames?: Map<string, string>;
  },
): Promise<HrShiftSwapView[]> {
  if (rows.length === 0) return [];
  const assignmentIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.requester_assignment_id, r.target_assignment_id])
        .filter((v): v is string => typeof v === 'string' && v.length > 0),
    ),
  ];

  const [visibleEmps, deptNames, tplByAssignId] = await Promise.all([
    preloaded?.visibleEmps ? Promise.resolve(preloaded.visibleEmps) : loadVisibleEmployees(trx, orgId, legalEntityId),
    preloaded?.deptNames
      ? Promise.resolve(preloaded.deptNames)
      : loadShiftDeptNames(trx, orgId, rows.map((r) => r.department_id)),
    loadSwapAssignmentLabels(trx, orgId, legalEntityId, assignmentIds),
  ]);

  const empNameById = new Map(visibleEmps.map((e) => [e.id, e.display_name]));

  return rows.map((row) => {
    const reqTpl = tplByAssignId.get(row.requester_assignment_id) ?? null;
    const tgtTpl = row.target_assignment_id ? (tplByAssignId.get(row.target_assignment_id) ?? null) : null;
    return {
      id: row.id,
      legalEntityId: row.legal_entity_id,
      requesterEmployeeId: row.requester_employee_id,
      requesterName: empNameById.get(row.requester_employee_id) ?? 'Nhân viên',
      targetEmployeeId: row.target_employee_id,
      targetName: empNameById.get(row.target_employee_id) ?? 'Nhân viên',
      requesterAssignmentId: row.requester_assignment_id,
      requesterShiftCode: reqTpl?.code ?? '',
      requesterShiftName: reqTpl?.name ?? '',
      targetAssignmentId: row.target_assignment_id,
      targetShiftCode: tgtTpl?.code ?? null,
      targetShiftName: tgtTpl?.name ?? null,
      departmentId: row.department_id,
      departmentName: row.department_id ? (deptNames.get(row.department_id) ?? null) : null,
      workDate: isoDateOnly(row.work_date),
      reason: row.reason,
      status: row.status,
      decidedBy: row.decided_by,
      decidedAt: isoTsNullable(row.decided_at),
      decisionNote: row.decision_note,
      createdAt: isoTs(row.created_at),
      updatedAt: isoTs(row.updated_at),
    };
  });
}

// ---------------------------------------------------------------------------
// Pure deterministic conflict & candidate analysis (testable without DB)
// ---------------------------------------------------------------------------

export interface CoverageAnalysisAssignment {
  id: string;
  employeeId: string;
  employeeName: string;
  departmentId: string | null;
  departmentName: string | null;
  shiftTemplateId: string;
  shiftCode: string;
  shiftName: string;
  startMinute: number;
  endMinute: number;
  crossesMidnight: boolean;
  workDate: string;
}

export interface CoverageAnalysisEmployee {
  id: string;
  displayName: string;
  departmentId: string | null;
  departmentName: string | null;
}

export interface CoverageAnalysisUnavailability {
  employeeId: string;
  source: 'leave' | 'trip';
  startOn: string;
  endOn: string;
}

function hasShortRestWithShift(
  candidateShifts: readonly CoverageAnalysisAssignment[],
  targetDate: string,
  targetStartMs: number,
  targetEndMs: number,
): boolean {
  for (const s of candidateShifts) {
    if (s.workDate === targetDate) return true;
    const { startMs, endMs } = computeShiftWindowMs(s.workDate, s);
    const gapBefore = targetStartMs - endMs;
    const gapAfter = startMs - targetEndMs;
    const overlaps = startMs < targetEndMs && endMs > targetStartMs;
    if (overlaps) return true;
    if (gapBefore >= 0 && gapBefore < SHORT_REST_MIN_MS) return true;
    if (gapAfter >= 0 && gapAfter < SHORT_REST_MIN_MS) return true;
  }
  return false;
}

/**
 * Pure deterministic Stage 7A coverage analyzer (0 LLM tokens):
 * flags approved leave, approved business trips, VN public holidays, and `< 12h` short-rest gaps,
 * then ranks unscheduled non-erased active candidates who are free and satisfy >= 12h adjacent rest.
 */
export function analyzeWeeklyShiftCoverage(args: {
  weekStart: string;
  weekEnd: string;
  employees: readonly CoverageAnalysisEmployee[];
  assignmentsInExtendedWindow: readonly CoverageAnalysisAssignment[];
  unavailabilities: readonly CoverageAnalysisUnavailability[];
}): {
  conflicts: HrShiftCoverageConflict[];
  gaps: HrShiftCoverageGap[];
  eligibleCandidates: HrShiftCoverageCandidate[];
} {
  const { weekStart, weekEnd, employees, assignmentsInExtendedWindow, unavailabilities } = args;
  const byEmpExtended = new Map<string, CoverageAnalysisAssignment[]>();
  const weeklyCountByEmp = new Map<string, number>();

  for (const a of assignmentsInExtendedWindow) {
    const list = byEmpExtended.get(a.employeeId) ?? [];
    list.push(a);
    byEmpExtended.set(a.employeeId, list);
    if (a.workDate >= weekStart && a.workDate <= weekEnd) {
      weeklyCountByEmp.set(a.employeeId, (weeklyCountByEmp.get(a.employeeId) ?? 0) + 1);
    }
  }

  for (const list of byEmpExtended.values()) {
    list.sort((a, b) => a.workDate.localeCompare(b.workDate) || a.startMinute - b.startMinute);
  }

  const isUnavailableOn = (employeeId: string, date: string): 'leave' | 'trip' | null => {
    for (const u of unavailabilities) {
      if (u.employeeId === employeeId && date >= u.startOn && date <= u.endOn) {
        return u.source;
      }
    }
    return null;
  };

  const weekAssignments = assignmentsInExtendedWindow
    .filter((a) => a.workDate >= weekStart && a.workDate <= weekEnd)
    .sort((a, b) => a.workDate.localeCompare(b.workDate) || a.employeeName.localeCompare(b.employeeName));

  const conflicts: HrShiftCoverageConflict[] = [];
  const shortRestEmpIds = new Set<string>();

  for (const a of weekAssignments) {
    const unavail = isUnavailableOn(a.employeeId, a.workDate);
    if (unavail === 'leave') {
      conflicts.push({
        assignmentId: a.id,
        employeeId: a.employeeId,
        employeeName: a.employeeName,
        departmentId: a.departmentId,
        departmentName: a.departmentName,
        shiftTemplateId: a.shiftTemplateId,
        shiftCode: a.shiftCode,
        shiftName: a.shiftName,
        workDate: a.workDate,
        kind: 'approved_leave',
        detail: `${a.employeeName} có đơn nghỉ phép đã duyệt trong ngày ${a.workDate}`,
      });
    } else if (unavail === 'trip') {
      conflicts.push({
        assignmentId: a.id,
        employeeId: a.employeeId,
        employeeName: a.employeeName,
        departmentId: a.departmentId,
        departmentName: a.departmentName,
        shiftTemplateId: a.shiftTemplateId,
        shiftCode: a.shiftCode,
        shiftName: a.shiftName,
        workDate: a.workDate,
        kind: 'approved_trip',
        detail: `${a.employeeName} đang công tác đã duyệt trong ngày ${a.workDate}`,
      });
    }

    if (isVietnamHoliday(a.workDate)) {
      conflicts.push({
        assignmentId: a.id,
        employeeId: a.employeeId,
        employeeName: a.employeeName,
        departmentId: a.departmentId,
        departmentName: a.departmentName,
        shiftTemplateId: a.shiftTemplateId,
        shiftCode: a.shiftCode,
        shiftName: a.shiftName,
        workDate: a.workDate,
        kind: 'public_holiday',
        detail: `Ngày ${a.workDate} là ngày nghỉ lễ theo quy định (BLLĐ Điều 112)`,
      });
    }

    const empShifts = byEmpExtended.get(a.employeeId) ?? [];
    const { startMs } = computeShiftWindowMs(a.workDate, a);
    for (const prev of empShifts) {
      if (prev.id === a.id) continue;
      const prevWin = computeShiftWindowMs(prev.workDate, prev);
      const restMs = startMs - prevWin.endMs;
      if (prevWin.startMs < startMs && restMs < SHORT_REST_MIN_MS) {
        const restHours = (restMs / HOUR_MS).toFixed(1).replace(/\.0$/, '');
        shortRestEmpIds.add(a.employeeId);
        conflicts.push({
          assignmentId: a.id,
          employeeId: a.employeeId,
          employeeName: a.employeeName,
          departmentId: a.departmentId,
          departmentName: a.departmentName,
          shiftTemplateId: a.shiftTemplateId,
          shiftCode: a.shiftCode,
          shiftName: a.shiftName,
          workDate: a.workDate,
          kind: 'short_rest',
          detail: `Thời gian nghỉ giữa ca ${prev.shiftCode} (${prev.workDate}) và ${a.shiftCode} (${a.workDate}) chỉ ${restHours} giờ (< 12 giờ)`,
        });
        break;
      }
    }
  }

  const candidatePoolBySlot = new Map<string, HrShiftCoverageGap>();
  for (const c of conflicts) {
    if (c.kind === 'public_holiday') continue;
    const targetAssign = weekAssignments.find((a) => a.id === c.assignmentId);
    if (!targetAssign) continue;

    const slotKey = `${c.workDate}:${c.shiftTemplateId}:${c.departmentId ?? ''}`;
    if (candidatePoolBySlot.has(slotKey)) continue;

    const { startMs, endMs } = computeShiftWindowMs(targetAssign.workDate, targetAssign);
    const ranked: HrShiftCoverageCandidate[] = [];
    for (const emp of employees) {
      if (emp.id === targetAssign.employeeId) continue;
      if (isUnavailableOn(emp.id, targetAssign.workDate) !== null) continue;
      const empShifts = byEmpExtended.get(emp.id) ?? [];
      if (hasShortRestWithShift(empShifts, targetAssign.workDate, startMs, endMs)) continue;

      ranked.push({
        employeeId: emp.id,
        employeeName: emp.displayName,
        departmentId: emp.departmentId,
        departmentName: emp.departmentName,
        weeklyShiftCount: weeklyCountByEmp.get(emp.id) ?? 0,
        hasAdjacentRestGap: false,
      });
    }

    ranked.sort((a, b) => {
      const aSameDept = a.departmentId === targetAssign.departmentId ? 0 : 1;
      const bSameDept = b.departmentId === targetAssign.departmentId ? 0 : 1;
      if (aSameDept !== bSameDept) return aSameDept - bSameDept;
      if (a.weeklyShiftCount !== b.weeklyShiftCount) return a.weeklyShiftCount - b.weeklyShiftCount;
      return a.employeeName.localeCompare(b.employeeName);
    });

    candidatePoolBySlot.set(slotKey, {
      date: c.workDate,
      departmentId: c.departmentId,
      departmentName: c.departmentName,
      shiftCode: c.shiftCode,
      shiftName: c.shiftName,
      reason: c.detail,
      candidates: ranked.slice(0, 8),
    });
  }

  const eligibleCandidates: HrShiftCoverageCandidate[] = employees
    .map((emp) => ({
      employeeId: emp.id,
      employeeName: emp.displayName,
      departmentId: emp.departmentId,
      departmentName: emp.departmentName,
      weeklyShiftCount: weeklyCountByEmp.get(emp.id) ?? 0,
      hasAdjacentRestGap: shortRestEmpIds.has(emp.id),
    }))
    .sort((a, b) => {
      if (a.hasAdjacentRestGap !== b.hasAdjacentRestGap) return a.hasAdjacentRestGap ? 1 : -1;
      if (a.weeklyShiftCount !== b.weeklyShiftCount) return a.weeklyShiftCount - b.weeklyShiftCount;
      return a.employeeName.localeCompare(b.employeeName);
    });

  return {
    conflicts,
    gaps: [...candidatePoolBySlot.values()],
    eligibleCandidates,
  };
}

// ---------------------------------------------------------------------------
// Shift Templates
// ---------------------------------------------------------------------------

export const shiftTemplateList = defineQuery({
  name: 'hr.shift.template.list',
  input: zHrShiftTemplateList,
  access: STAFF_ROLES,
  handler: async (ctx, input: HrShiftTemplateList): Promise<HrShiftTemplateListResult> => {
    const parsed = zHrShiftTemplateList.parse(input);
    const legalEntityId = await resolveEntity(ctx, parsed.legalEntityId);
    let q = ctx.trx
      .selectFrom('ludy_hr.shift_template')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId);
    if (!parsed.includeArchived) {
      q = q.where('archived_at', 'is', null);
    }
    const rows = await q.orderBy('start_minute', 'asc').orderBy('code', 'asc').execute();
    return {
      legalEntityId,
      templates: rows.map(toTemplateView),
    };
  },
});

export const shiftTemplateCreate = defineCommand({
  name: 'hr.shift.template.create',
  input: zHrShiftTemplateCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: HrShiftTemplateCreate) =>
    input.legalEntityId ? { type: 'hr.shift_template', id: input.legalEntityId } : null,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'shift_template', [
      'org_id',
      'legal_entity_id',
      'code',
      'name',
      'start_minute',
      'end_minute',
      'break_minutes',
      'grace_late_minutes',
      'grace_early_minutes',
      'crosses_midnight',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrShiftTemplateCreate): Promise<HrShiftTemplateView> => {
    const callerUserId = userOf(ctx.actor);
    const parsed = zHrShiftTemplateCreate.parse(input);
    const legalEntityId = await resolveEntity(ctx, parsed.legalEntityId);

    const dup = await ctx.trx
      .selectFrom('ludy_hr.shift_template')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('code', '=', parsed.code)
      .where('archived_at', 'is', null)
      .executeTakeFirst();
    if (dup) {
      throw new DomainError('HR_SHIFT_TEMPLATE_CODE_EXISTS', 409, `Mã ca ${parsed.code} đã tồn tại`);
    }

    try {
      const inserted = await ctx.trx
        .insertInto('ludy_hr.shift_template')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: legalEntityId,
          code: parsed.code,
          name: parsed.name,
          start_minute: parsed.startMinute,
          end_minute: parsed.endMinute,
          break_minutes: parsed.breakMinutes,
          grace_late_minutes: parsed.graceLateMinutes,
          grace_early_minutes: parsed.graceEarlyMinutes,
          crosses_midnight: parsed.crossesMidnight,
          created_by: callerUserId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      ctx.audit({ templateId: inserted.id, code: inserted.code, legalEntityId });
      return toTemplateView(inserted);
    } catch (error: unknown) {
      if (isPgCode(error, '23505')) {
        throw new DomainError('HR_SHIFT_TEMPLATE_CODE_EXISTS', 409, `Mã ca ${parsed.code} đã tồn tại`);
      }
      throw error;
    }
  },
});

export const shiftTemplateUpdate = defineCommand({
  name: 'hr.shift.template.update',
  input: zHrShiftTemplateUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: HrShiftTemplateUpdate) => ({ type: 'hr.shift_template', id: input.templateId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'shift_template', [
      'code',
      'name',
      'start_minute',
      'end_minute',
      'break_minutes',
      'grace_late_minutes',
      'grace_early_minutes',
      'crosses_midnight',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrShiftTemplateUpdate): Promise<HrShiftTemplateView> => {
    userOf(ctx.actor);
    const parsed = zHrShiftTemplateUpdate.parse(input);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.shift_template')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', parsed.templateId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw templateNotFound();
    if (existing.archived_at !== null) {
      throw new DomainError('HR_SHIFT_TEMPLATE_ARCHIVED', 409, 'Không thể chỉnh sửa mẫu ca đã lưu trữ');
    }

    const nextCode = parsed.code ?? existing.code;
    const nextStart = parsed.startMinute ?? existing.start_minute;
    const nextEnd = parsed.endMinute ?? existing.end_minute;
    const nextBreak = parsed.breakMinutes ?? existing.break_minutes;
    const nextCrosses = parsed.crossesMidnight ?? existing.crosses_midnight;
    if (!isValidShiftWindow(nextStart, nextEnd, nextBreak, nextCrosses)) {
      throw new DomainError(
        'HR_SHIFT_WINDOW_INVALID',
        422,
        'Thời lượng ca phải lớn hơn thời gian nghỉ và phù hợp tùy chọn qua đêm',
      );
    }

    if (nextCode !== existing.code) {
      const dup = await ctx.trx
        .selectFrom('ludy_hr.shift_template')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('legal_entity_id', '=', existing.legal_entity_id)
        .where('code', '=', nextCode)
        .where('archived_at', 'is', null)
        .where('id', '!=', existing.id)
        .executeTakeFirst();
      if (dup) {
        throw new DomainError('HR_SHIFT_TEMPLATE_CODE_EXISTS', 409, `Mã ca ${nextCode} đã tồn tại`);
      }
    }

    const updated = await ctx.trx
      .updateTable('ludy_hr.shift_template')
      .set({
        code: nextCode,
        name: parsed.name ?? existing.name,
        start_minute: nextStart,
        end_minute: nextEnd,
        break_minutes: nextBreak,
        grace_late_minutes: parsed.graceLateMinutes ?? existing.grace_late_minutes,
        grace_early_minutes: parsed.graceEarlyMinutes ?? existing.grace_early_minutes,
        crosses_midnight: nextCrosses,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    ctx.audit({ templateId: updated.id, code: updated.code });
    return toTemplateView(updated);
  },
});

export const shiftTemplateArchive = defineCommand({
  name: 'hr.shift.template.archive',
  input: zHrShiftTemplateArchive,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: HrShiftTemplateArchive) => ({ type: 'hr.shift_template', id: input.templateId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'shift_template', ['archived_at', 'updated_at'])],
  handler: async (ctx, input: HrShiftTemplateArchive): Promise<HrShiftTemplateView> => {
    userOf(ctx.actor);
    const parsed = zHrShiftTemplateArchive.parse(input);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.shift_template')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', parsed.templateId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw templateNotFound();
    if (existing.archived_at !== null) {
      return toTemplateView(existing);
    }

    const updated = await ctx.trx
      .updateTable('ludy_hr.shift_template')
      .set({ archived_at: ctx.now, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    ctx.audit({ templateId: updated.id, code: updated.code });
    return toTemplateView(updated);
  },
});

export const shiftTemplateSeedDefaults = defineCommand({
  name: 'hr.shift.template.seed_defaults',
  input: zHrShiftTemplateSeedDefaults,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: HrShiftTemplateSeedDefaults) =>
    input.legalEntityId ? { type: 'hr.shift_template', id: input.legalEntityId } : null,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'shift_template', [
      'org_id',
      'legal_entity_id',
      'code',
      'name',
      'start_minute',
      'end_minute',
      'break_minutes',
      'grace_late_minutes',
      'grace_early_minutes',
      'crosses_midnight',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrShiftTemplateSeedDefaults): Promise<HrShiftTemplateSeedResult> => {
    const callerUserId = userOf(ctx.actor);
    const parsed = zHrShiftTemplateSeedDefaults.parse(input);
    const legalEntityId = await resolveEntity(ctx, parsed.legalEntityId);

    const existing = await ctx.trx
      .selectFrom('ludy_hr.shift_template')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('archived_at', 'is', null)
      .execute();

    const activeCodes = new Set(existing.map((r) => r.code.toUpperCase()));
    let createdCount = 0;
    for (const preset of HR_DEFAULT_SHIFT_TEMPLATES) {
      if (activeCodes.has(preset.code)) continue;
      await ctx.trx
        .insertInto('ludy_hr.shift_template')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: legalEntityId,
          code: preset.code,
          name: preset.name,
          start_minute: preset.startMinute,
          end_minute: preset.endMinute,
          break_minutes: preset.breakMinutes,
          grace_late_minutes: preset.graceLateMinutes,
          grace_early_minutes: preset.graceEarlyMinutes,
          crosses_midnight: preset.crossesMidnight,
          created_by: callerUserId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .execute();
      createdCount += 1;
    }

    const finalRows = await ctx.trx
      .selectFrom('ludy_hr.shift_template')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('archived_at', 'is', null)
      .orderBy('start_minute', 'asc')
      .orderBy('code', 'asc')
      .execute();

    ctx.audit({ legalEntityId, createdCount });
    return {
      legalEntityId,
      createdCount,
      templates: finalRows.map(toTemplateView),
    };
  },
});

// ---------------------------------------------------------------------------
// Weekly Roster & Assignments
// ---------------------------------------------------------------------------

export const shiftRosterGet = defineQuery({
  name: 'hr.shift.roster.get',
  input: zHrShiftRosterGet,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input: HrShiftRosterGet): Promise<HrShiftRosterResult> => {
    const parsed = zHrShiftRosterGet.parse(input);
    const { isAdmin, legalEntityId, managedDeptIds } = await resolveManagerScope(
      ctx,
      parsed.legalEntityId,
      parsed.departmentId,
    );

    const today = vietnamToday(new Date());
    const weekStart = parsed.weekStart ?? mondayOfLocalWeek(today);
    const weekEnd = addDaysLocalDate(weekStart, 6);

    const [tplRows, visibleEmps, assignRows, pendingSwaps] = await Promise.all([
      ctx.trx
        .selectFrom('ludy_hr.shift_template')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where('legal_entity_id', '=', legalEntityId)
        .where('archived_at', 'is', null)
        .orderBy('start_minute', 'asc')
        .orderBy('code', 'asc')
        .execute(),
      loadVisibleEmployees(ctx.trx, ctx.orgId, legalEntityId),
      (() => {
        let q = ctx.trx
          .selectFrom('ludy_hr.shift_assignment')
          .selectAll()
          .where('org_id', '=', ctx.orgId)
          .where('legal_entity_id', '=', legalEntityId)
          .where('work_date', '>=', weekStart)
          .where('work_date', '<=', weekEnd);
        if (parsed.departmentId) {
          q = q.where('department_id', '=', parsed.departmentId);
        } else if (!isAdmin) {
          q = q.where('department_id', 'in', [...managedDeptIds]);
        }
        return q.orderBy('work_date', 'asc').execute();
      })(),
      (() => {
        let q = ctx.trx
          .selectFrom('ludy_hr.shift_swap_request')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('legal_entity_id', '=', legalEntityId)
          .where('status', '=', 'pending');
        if (parsed.departmentId) {
          q = q.where('department_id', '=', parsed.departmentId);
        } else if (!isAdmin) {
          q = q.where('department_id', 'in', [...managedDeptIds]);
        }
        return q.execute();
      })(),
    ]);

    const deptNames = await loadShiftDeptNames(ctx.trx, ctx.orgId, [
      ...visibleEmps.map((e) => e.department_id),
      ...assignRows.map((a) => a.department_id),
    ]);

    const scopedEmps = visibleEmps.filter((e) => {
      if (parsed.departmentId) return e.department_id === parsed.departmentId;
      if (isAdmin) return true;
      return e.department_id !== null && managedDeptIds.has(e.department_id);
    });

    const assignments = await mapAssignmentViews(ctx.trx, ctx.orgId, legalEntityId, assignRows, {
      visibleEmps,
      deptNames,
    });

    return {
      legalEntityId,
      weekStart,
      weekEnd,
      canManageOrgRoster: isAdmin,
      manageableDepartmentIds: [...managedDeptIds],
      templates: tplRows.map(toTemplateView),
      employees: scopedEmps.map((e) => ({
        id: e.id,
        displayName: e.display_name,
        departmentId: e.department_id,
        departmentName: e.department_id ? (deptNames.get(e.department_id) ?? null) : null,
      })),
      assignments,
      pendingSwapsCount: pendingSwaps.length,
    };
  },
});

export const shiftAssignmentUpsert = defineCommand({
  name: 'hr.shift.assignment.upsert',
  input: zHrShiftAssignmentUpsert,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: HrShiftAssignmentUpsert) => ({ type: 'hr.shift_assignment', id: input.employeeId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'shift_assignment', [
      'org_id',
      'legal_entity_id',
      'employee_id',
      'department_id',
      'shift_template_id',
      'work_date',
      'note',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrShiftAssignmentUpsert): Promise<HrShiftAssignmentView> => {
    const callerUserId = userOf(ctx.actor);
    const isAdmin = ctx.role === 'owner' || ctx.role === 'admin';
    const parsed = zHrShiftAssignmentUpsert.parse(input);

    const emp = await lockShiftEmployee(ctx.trx, ctx.orgId, parsed.employeeId);
    if (parsed.legalEntityId && parsed.legalEntityId !== emp.legal_entity_id) {
      throw new DomainError('FORBIDDEN', 403, 'Nhân viên không thuộc pháp nhân đã chọn');
    }
    await assertCanManageDepartment(ctx.trx, ctx.orgId, isAdmin, emp.department_id);

    const tpl = await ctx.trx
      .selectFrom('ludy_hr.shift_template')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', emp.legal_entity_id)
      .where('id', '=', parsed.shiftTemplateId)
      .executeTakeFirst();
    if (!tpl) throw templateNotFound();
    if (tpl.archived_at !== null) {
      throw new DomainError('HR_SHIFT_TEMPLATE_ARCHIVED', 409, 'Không thể phân ca bằng mẫu ca đã lưu trữ');
    }

    const existing = await ctx.trx
      .selectFrom('ludy_hr.shift_assignment')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', emp.legal_entity_id)
      .where('employee_id', '=', emp.id)
      .where('work_date', '=', parsed.workDate)
      .forUpdate()
      .executeTakeFirst();

    let saved;
    if (existing) {
      saved = await ctx.trx
        .updateTable('ludy_hr.shift_assignment')
        .set({
          shift_template_id: tpl.id,
          department_id: emp.department_id,
          note: parsed.note !== undefined ? (parsed.note ?? null) : existing.note,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } else {
      saved = await ctx.trx
        .insertInto('ludy_hr.shift_assignment')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: emp.legal_entity_id,
          employee_id: emp.id,
          department_id: emp.department_id,
          shift_template_id: tpl.id,
          work_date: parsed.workDate,
          note: parsed.note ?? null,
          created_by: callerUserId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    ctx.audit({
      assignmentId: saved.id,
      employeeId: emp.id,
      workDate: parsed.workDate,
      shiftCode: tpl.code,
      action: existing ? 'updated' : 'created',
    });

    const [view] = await mapAssignmentViews(ctx.trx, ctx.orgId, emp.legal_entity_id, [saved]);
    return view!;
  },
});

export const shiftAssignmentDelete = defineCommand({
  name: 'hr.shift.assignment.delete',
  input: zHrShiftAssignmentDelete,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: HrShiftAssignmentDelete) => ({ type: 'hr.shift_assignment', id: input.assignmentId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'shift_assignment', ['id'])],
  handler: async (ctx, input: HrShiftAssignmentDelete): Promise<HrShiftAssignmentDeleteResult> => {
    userOf(ctx.actor);
    const isAdmin = ctx.role === 'owner' || ctx.role === 'admin';
    const parsed = zHrShiftAssignmentDelete.parse(input);

    const preExisting = await ctx.trx
      .selectFrom('ludy_hr.shift_assignment')
      .select(['id', 'employee_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', parsed.assignmentId)
      .executeTakeFirst();
    if (!preExisting) throw assignmentNotFound();

    await lockShiftEmployee(ctx.trx, ctx.orgId, preExisting.employee_id, { allowEnded: true });

    const existing = await ctx.trx
      .selectFrom('ludy_hr.shift_assignment')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', parsed.assignmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw assignmentNotFound();

    await assertCanManageDepartment(ctx.trx, ctx.orgId, isAdmin, existing.department_id);

    const swapRef = await ctx.trx
      .selectFrom('ludy_hr.shift_swap_request')
      .select(['id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where((eb) =>
        eb.or([
          eb('requester_assignment_id', '=', existing.id),
          eb.and([eb('target_assignment_id', '=', existing.id), eb('status', '=', 'pending')]),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    if (swapRef) {
      throw new DomainError(
        'HR_SHIFT_ASSIGNMENT_IN_SWAP',
        409,
        'Không thể xóa ca đã gắn với yêu cầu đổi ca',
      );
    }

    await ctx.trx
      .deleteFrom('ludy_hr.shift_assignment')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({ assignmentId: existing.id, employeeId: existing.employee_id, workDate: isoDateOnly(existing.work_date) });
    return { assignmentId: existing.id, deleted: true };
  },
});

// ---------------------------------------------------------------------------
// Self-Service Shifts & 1-Step Shift Swaps
// ---------------------------------------------------------------------------

export const selfShiftsList = defineQuery({
  name: 'hr.self.shifts.list',
  input: zHrSelfShiftsList,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input: HrSelfShiftsList): Promise<HrSelfShiftsResult> => {
    const uid = userOf(ctx.actor);
    const parsed = zHrSelfShiftsList.parse(input);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, uid);
    if (!emp) {
      throw new DomainError('HR_SELF_NOT_LINKED', 403, 'Tài khoản của bạn chưa được liên kết với hồ sơ nhân viên nào');
    }

    const today = vietnamToday(new Date());
    const weekStart = parsed.weekStart ?? mondayOfLocalWeek(today);
    const weekEnd = addDaysLocalDate(weekStart, 6);

    const [assignRows, swapRows, visibleEmps] = await Promise.all([
      ctx.trx
        .selectFrom('ludy_hr.shift_assignment')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where('employee_id', '=', emp.id)
        .where('work_date', '>=', weekStart)
        .where('work_date', '<=', weekEnd)
        .orderBy('work_date', 'asc')
        .execute(),
      ctx.trx
        .selectFrom('ludy_hr.shift_swap_request')
        .selectAll()
        .where('org_id', '=', ctx.orgId)
        .where((eb) => eb.or([eb('requester_employee_id', '=', emp.id), eb('target_employee_id', '=', emp.id)]))
        .orderBy('created_at', 'desc')
        .limit(50)
        .execute(),
      emp.status === 'active'
        ? loadVisibleEmployees(ctx.trx, ctx.orgId, emp.legal_entity_id)
        : Promise.resolve([]),
    ]);

    const deptNames = await loadShiftDeptNames(ctx.trx, ctx.orgId, [
      ...visibleEmps.map((e) => e.department_id),
      ...assignRows.map((a) => a.department_id),
      ...swapRows.map((s) => s.department_id),
    ]);

    const [assignments, swaps] = await Promise.all([
      mapAssignmentViews(ctx.trx, ctx.orgId, emp.legal_entity_id, assignRows, { visibleEmps, deptNames }),
      mapSwapViews(ctx.trx, ctx.orgId, emp.legal_entity_id, swapRows, { visibleEmps, deptNames }),
    ]);

    const peerCandidates = visibleEmps
      .filter((e) => e.id !== emp.id)
      .map((e) => ({
        id: e.id,
        displayName: e.display_name,
        departmentId: e.department_id,
        departmentName: e.department_id ? (deptNames.get(e.department_id) ?? null) : null,
      }))
      .sort((a, b) => {
        const aSame = a.departmentId === emp.department_id ? 0 : 1;
        const bSame = b.departmentId === emp.department_id ? 0 : 1;
        if (aSame !== bSame) return aSame - bSame;
        return a.displayName.localeCompare(b.displayName);
      });

    return {
      employeeId: emp.id,
      legalEntityId: emp.legal_entity_id,
      departmentId: emp.department_id,
      weekStart,
      weekEnd,
      assignments,
      peerCandidates,
      swaps,
    };
  },
});

export const selfShiftSwapSubmit = defineCommand({
  name: 'hr.self.shift_swap.submit',
  input: zHrSelfShiftSwapSubmit,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: HrSelfShiftSwapSubmit) => ({ type: 'hr.shift_swap_request', id: input.requesterAssignmentId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'shift_swap_request', [
      'org_id',
      'legal_entity_id',
      'requester_employee_id',
      'target_employee_id',
      'requester_assignment_id',
      'target_assignment_id',
      'department_id',
      'work_date',
      'reason',
      'status',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrSelfShiftSwapSubmit): Promise<HrShiftSwapView> => {
    const uid = userOf(ctx.actor);
    const parsed = zHrSelfShiftSwapSubmit.parse(input);
    const selfEmp = await resolveSelfEmployee(ctx.trx, ctx.orgId, uid);
    if (!selfEmp) {
      throw new DomainError('HR_SELF_NOT_LINKED', 403, 'Tài khoản của bạn chưa được liên kết với hồ sơ nhân viên nào');
    }
    if (selfEmp.id === parsed.targetEmployeeId) {
      throw new DomainError('HR_SHIFT_SWAP_SAME_EMPLOYEE', 422, 'Không thể gửi yêu cầu đổi ca cho chính mình');
    }

    const sortedIds = [selfEmp.id, parsed.targetEmployeeId].sort();
    const lockedA = await lockShiftEmployee(ctx.trx, ctx.orgId, sortedIds[0]!);
    const lockedB = await lockShiftEmployee(ctx.trx, ctx.orgId, sortedIds[1]!);
    const reqEmp = lockedA.id === selfEmp.id ? lockedA : lockedB;
    const tgtEmp = lockedA.id === parsed.targetEmployeeId ? lockedA : lockedB;

    if (reqEmp.legal_entity_id !== tgtEmp.legal_entity_id) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ được đổi ca với đồng nghiệp cùng pháp nhân');
    }

    // lockShiftEmployee serializes writers; FOR SHARE triggers UPDATE RLS which excludes staff.
    const reqAssignment = await ctx.trx
      .selectFrom('ludy_hr.shift_assignment')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', parsed.requesterAssignmentId)
      .where('employee_id', '=', reqEmp.id)
      .executeTakeFirst();
    if (!reqAssignment) {
      throw assignmentNotFound();
    }

    const workDate = isoDateOnly(reqAssignment.work_date);
    const { rows: tgtRows } = await sql<{ assignment_id: string; shift_template_id: string }>`
      SELECT assignment_id, shift_template_id
        FROM ludy_hr.resolve_self_shift_swap_target(
          ${ctx.orgId}::uuid,
          ${reqEmp.legal_entity_id}::uuid,
          ${tgtEmp.id}::uuid,
          ${workDate}::date
        )
    `.execute(ctx.trx);
    const tgtAssignment = tgtRows[0];

    if (tgtAssignment && tgtAssignment.shift_template_id === reqAssignment.shift_template_id) {
      throw new DomainError('HR_SHIFT_SWAP_IDENTICAL_SHIFT', 422, 'Hai nhân viên đang được xếp cùng một mẫu ca');
    }

    const existingPending = await ctx.trx
      .selectFrom('ludy_hr.shift_swap_request')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', reqEmp.legal_entity_id)
      .where('requester_assignment_id', '=', reqAssignment.id)
      .where('status', '=', 'pending')
      .executeTakeFirst();
    if (existingPending) {
      throw new DomainError('HR_SHIFT_SWAP_DUPLICATE_PENDING', 409, 'Ca này đã có yêu cầu đổi ca đang chờ duyệt');
    }

    const inserted = await ctx.trx
      .insertInto('ludy_hr.shift_swap_request')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: reqEmp.legal_entity_id,
        requester_employee_id: reqEmp.id,
        target_employee_id: tgtEmp.id,
        requester_assignment_id: reqAssignment.id,
        target_assignment_id: tgtAssignment?.assignment_id ?? null,
        department_id: reqAssignment.department_id ?? reqEmp.department_id,
        work_date: workDate,
        reason: parsed.reason && parsed.reason.length > 0 ? parsed.reason : null,
        status: 'pending',
        created_by: uid,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    ctx.audit({
      swapId: inserted.id,
      requesterEmployeeId: reqEmp.id,
      targetEmployeeId: tgtEmp.id,
      workDate,
      hasTargetAssignment: tgtAssignment !== undefined,
    });

    const [view] = await mapSwapViews(ctx.trx, ctx.orgId, reqEmp.legal_entity_id, [inserted]);
    return view!;
  },
});

export const selfShiftSwapCancel = defineCommand({
  name: 'hr.self.shift_swap.cancel',
  input: zHrSelfShiftSwapCancel,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: HrSelfShiftSwapCancel) => ({ type: 'hr.shift_swap_request', id: input.swapId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'shift_swap_request', ['status', 'updated_at'])],
  handler: async (ctx, input: HrSelfShiftSwapCancel): Promise<HrShiftSwapView> => {
    const uid = userOf(ctx.actor);
    const parsed = zHrSelfShiftSwapCancel.parse(input);
    const selfEmp = await resolveSelfEmployee(ctx.trx, ctx.orgId, uid);
    if (!selfEmp) {
      throw new DomainError('HR_SELF_NOT_LINKED', 403, 'Tài khoản của bạn chưa được liên kết với hồ sơ nhân viên nào');
    }

    await lockShiftEmployee(ctx.trx, ctx.orgId, selfEmp.id, { allowEnded: true });

    const swap = await ctx.trx
      .selectFrom('ludy_hr.shift_swap_request')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', parsed.swapId)
      .forUpdate()
      .executeTakeFirst();
    if (!swap) throw swapNotFound();
    if (swap.requester_employee_id !== selfEmp.id) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ người gửi yêu cầu mới được hủy đơn đổi ca');
    }

    if (swap.status !== 'pending') {
      throw new DomainError('HR_SHIFT_SWAP_NOT_PENDING', 409, 'Chỉ hủy được yêu cầu đổi ca đang chờ duyệt');
    }

    const updated = await ctx.trx
      .updateTable('ludy_hr.shift_swap_request')
      .set({ status: 'cancelled', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', swap.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    ctx.audit({ swapId: updated.id, employeeId: selfEmp.id, workDate: isoDateOnly(updated.work_date) });
    const [view] = await mapSwapViews(ctx.trx, ctx.orgId, updated.legal_entity_id, [updated]);
    return view!;
  },
});

export const shiftSwapList = defineQuery({
  name: 'hr.shift_swap.list',
  input: zHrShiftSwapList,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input: HrShiftSwapList): Promise<HrShiftSwapListResult> => {
    const parsed = zHrShiftSwapList.parse(input);
    const { isAdmin, legalEntityId, managedDeptIds } = await resolveManagerScope(
      ctx,
      parsed.legalEntityId,
      parsed.departmentId,
    );

    let q = ctx.trx
      .selectFrom('ludy_hr.shift_swap_request')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId);
    if (parsed.status) {
      q = q.where('status', '=', parsed.status);
    }
    if (parsed.weekStart) {
      q = q.where('work_date', '>=', parsed.weekStart).where('work_date', '<=', addDaysLocalDate(parsed.weekStart, 6));
    }
    if (parsed.departmentId) {
      q = q.where('department_id', '=', parsed.departmentId);
    } else if (!isAdmin) {
      q = q.where('department_id', 'in', [...managedDeptIds]);
    }

    const rows = await q.orderBy('created_at', 'desc').limit(100).execute();
    const swaps = await mapSwapViews(ctx.trx, ctx.orgId, legalEntityId, rows);
    return { legalEntityId, swaps };
  },
});

async function lockSwapDecisionPair(
  ctx: Parameters<Parameters<typeof defineCommand>[0]['handler']>[0],
  swapId: string,
  opts: { allowEnded?: boolean } = {},
) {
  const callerUserId = userOf(ctx.actor);
  const role = requireStage6bRole(ctx.role);
  const isAdmin = role === 'owner' || role === 'admin';

  const swapPre = await ctx.trx
    .selectFrom('ludy_hr.shift_swap_request')
    .select(['id', 'requester_employee_id', 'target_employee_id'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', swapId)
    .executeTakeFirst();
  if (!swapPre) throw swapNotFound();

  const sortedIds = [swapPre.requester_employee_id, swapPre.target_employee_id].sort();
  const lockedA = await lockShiftEmployee(ctx.trx, ctx.orgId, sortedIds[0]!, opts);
  const lockedB = await lockShiftEmployee(ctx.trx, ctx.orgId, sortedIds[1]!, opts);
  const reqEmp = lockedA.id === swapPre.requester_employee_id ? lockedA : lockedB;
  const tgtEmp = lockedA.id === swapPre.target_employee_id ? lockedA : lockedB;

  const swap = await ctx.trx
    .selectFrom('ludy_hr.shift_swap_request')
    .selectAll()
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', swapId)
    .forUpdate()
    .executeTakeFirst();
  if (!swap) throw swapNotFound();

  await assertCanManageDepartment(ctx.trx, ctx.orgId, isAdmin, swap.department_id);

  const callerInSwap =
    callerUserId === reqEmp.user_id || callerUserId === tgtEmp.user_id || callerUserId === swap.created_by;
  if (callerInSwap) {
    const soleOwner = await isSoleOwnerOrg(ctx.trx, ctx.orgId, callerUserId, role);
    if (!soleOwner) {
      throw new DomainError('FORBIDDEN', 403, 'Không thể tự duyệt hoặc từ chối yêu cầu đổi ca liên quan tới bản thân');
    }
  }

  if (swap.status !== 'pending') {
    throw new DomainError('HR_SHIFT_SWAP_NOT_PENDING', 409, 'Yêu cầu đổi ca này đã được xử lý trước đó');
  }

  return { callerUserId, isAdmin, swap, reqEmp, tgtEmp };
}

export const shiftSwapApprove = defineCommand({
  name: 'hr.shift_swap.approve',
  input: zHrShiftSwapDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: HrShiftSwapDecide) => ({ type: 'hr.shift_swap_request', id: input.swapId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'shift_swap_request', [
      'status',
      'decided_by',
      'decided_at',
      'decision_note',
      'updated_at',
    ]),
    tableWrite(hrManifest.tables, 'ludy_hr', 'shift_assignment', [
      'employee_id',
      'department_id',
      'shift_template_id',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrShiftSwapDecide): Promise<HrShiftSwapView> => {
    const parsed = zHrShiftSwapDecide.parse(input);
    const { callerUserId, isAdmin, swap, tgtEmp } = await lockSwapDecisionPair(ctx, parsed.swapId);

    const reqAssignment = await ctx.trx
      .selectFrom('ludy_hr.shift_assignment')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', swap.requester_assignment_id)
      .forUpdate()
      .executeTakeFirst();
    if (!reqAssignment || reqAssignment.employee_id !== swap.requester_employee_id) {
      throw new DomainError('HR_SHIFT_SWAP_ASSIGNMENT_CHANGED', 409, 'Lịch ca gốc của người gửi đã thay đổi');
    }

    const workDate = isoDateOnly(swap.work_date);
    const currentTgtAssign = await ctx.trx
      .selectFrom('ludy_hr.shift_assignment')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', swap.legal_entity_id)
      .where('employee_id', '=', swap.target_employee_id)
      .where('work_date', '=', workDate)
      .forUpdate()
      .executeTakeFirst();

    const neededTplIds =
      swap.target_assignment_id && currentTgtAssign
        ? [...new Set([reqAssignment.shift_template_id, currentTgtAssign.shift_template_id])]
        : [reqAssignment.shift_template_id];
    const usedTpls = await ctx.trx
      .selectFrom('ludy_hr.shift_template')
      .select(['id', 'archived_at'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', swap.legal_entity_id)
      .where('id', 'in', neededTplIds)
      .execute();
    if (usedTpls.length !== neededTplIds.length || usedTpls.some((t) => t.archived_at !== null)) {
      throw new DomainError('HR_SHIFT_TEMPLATE_ARCHIVED', 409, 'Không thể duyệt đổi ca vì mẫu ca đã bị lưu trữ');
    }

    if (swap.target_assignment_id) {
      if (!currentTgtAssign || currentTgtAssign.id !== swap.target_assignment_id) {
        throw new DomainError('HR_SHIFT_SWAP_ASSIGNMENT_CHANGED', 409, 'Lịch ca của đồng nghiệp nhận đổi đã thay đổi');
      }
      if (currentTgtAssign.shift_template_id === reqAssignment.shift_template_id) {
        throw new DomainError('HR_SHIFT_SWAP_IDENTICAL_SHIFT', 422, 'Hai nhân viên đang được xếp cùng một mẫu ca');
      }
      if (!isAdmin && currentTgtAssign.department_id !== swap.department_id) {
        await assertCanManageDepartment(ctx.trx, ctx.orgId, false, currentTgtAssign.department_id);
      }

      await ctx.trx
        .updateTable('ludy_hr.shift_assignment')
        .set({ shift_template_id: currentTgtAssign.shift_template_id, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', reqAssignment.id)
        .execute();

      await ctx.trx
        .updateTable('ludy_hr.shift_assignment')
        .set({ shift_template_id: reqAssignment.shift_template_id, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', currentTgtAssign.id)
        .execute();
    } else {
      if (currentTgtAssign) {
        throw new DomainError(
          'HR_SHIFT_SWAP_TARGET_BUSY',
          409,
          'Đồng nghiệp nhận ca đã được phân một ca khác trong ngày này',
        );
      }
      if (!isAdmin && tgtEmp.department_id !== swap.department_id) {
        await assertCanManageDepartment(ctx.trx, ctx.orgId, false, tgtEmp.department_id);
      }
      await ctx.trx
        .updateTable('ludy_hr.shift_assignment')
        .set({
          employee_id: swap.target_employee_id,
          department_id: tgtEmp.department_id,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', reqAssignment.id)
        .execute();
    }

    const updated = await ctx.trx
      .updateTable('ludy_hr.shift_swap_request')
      .set({
        status: 'approved',
        decided_by: callerUserId,
        decided_at: ctx.now,
        decision_note: parsed.decisionNote && parsed.decisionNote.length > 0 ? parsed.decisionNote : null,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', swap.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    ctx.audit({
      swapId: updated.id,
      requesterEmployeeId: swap.requester_employee_id,
      targetEmployeeId: swap.target_employee_id,
      workDate,
    });

    const [view] = await mapSwapViews(ctx.trx, ctx.orgId, updated.legal_entity_id, [updated]);
    return view!;
  },
});

export const shiftSwapReject = defineCommand({
  name: 'hr.shift_swap.reject',
  input: zHrShiftSwapDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: HrShiftSwapDecide) => ({ type: 'hr.shift_swap_request', id: input.swapId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'shift_swap_request', [
      'status',
      'decided_by',
      'decided_at',
      'decision_note',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrShiftSwapDecide): Promise<HrShiftSwapView> => {
    const parsed = zHrShiftSwapDecide.parse(input);
    const { callerUserId, swap } = await lockSwapDecisionPair(ctx, parsed.swapId, { allowEnded: true });

    const updated = await ctx.trx
      .updateTable('ludy_hr.shift_swap_request')
      .set({
        status: 'rejected',
        decided_by: callerUserId,
        decided_at: ctx.now,
        decision_note: parsed.decisionNote && parsed.decisionNote.length > 0 ? parsed.decisionNote : null,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', swap.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    ctx.audit({
      swapId: updated.id,
      requesterEmployeeId: swap.requester_employee_id,
      targetEmployeeId: swap.target_employee_id,
      workDate: isoDateOnly(updated.work_date),
    });

    const [view] = await mapSwapViews(ctx.trx, ctx.orgId, updated.legal_entity_id, [updated]);
    return view!;
  },
});

// ---------------------------------------------------------------------------
// Deterministic Coverage Snapshot & AI Audit
// ---------------------------------------------------------------------------

export const shiftCoverageRead = defineQuery({
  name: 'hr.shift.coverage.read',
  input: zHrShiftCoverageAsk,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input: HrShiftCoverageAsk): Promise<HrShiftCoverageSnapshot> => {
    const parsed = zHrShiftCoverageAsk.parse(input);
    const { isAdmin, legalEntityId, managedDeptIds } = await resolveManagerScope(
      ctx,
      parsed.legalEntityId,
      parsed.departmentId,
    );

    const today = vietnamToday(new Date());
    const weekStart = parsed.weekStart ?? mondayOfLocalWeek(today);
    const weekEnd = addDaysLocalDate(weekStart, 6);
    const extStart = addDaysLocalDate(weekStart, -1);
    const extEnd = addDaysLocalDate(weekEnd, 1);

    const [visibleEmps, assignRows, unavailRows] = await Promise.all([
      loadVisibleEmployees(ctx.trx, ctx.orgId, legalEntityId),
      (() => {
        let q = ctx.trx
          .selectFrom('ludy_hr.shift_assignment')
          .selectAll()
          .where('org_id', '=', ctx.orgId)
          .where('legal_entity_id', '=', legalEntityId)
          .where('work_date', '>=', extStart)
          .where('work_date', '<=', extEnd);
        if (parsed.departmentId) {
          q = q.where('department_id', '=', parsed.departmentId);
        } else if (!isAdmin) {
          q = q.where('department_id', 'in', [...managedDeptIds]);
        }
        return q.execute();
      })(),
      loadUnavailableSpans(ctx.trx, ctx.orgId, legalEntityId, weekStart, weekEnd),
    ]);

    const deptNames = await loadShiftDeptNames(ctx.trx, ctx.orgId, [
      ...visibleEmps.map((e) => e.department_id),
      ...assignRows.map((a) => a.department_id),
    ]);

    const scopedEmps = visibleEmps.filter((e) => {
      if (parsed.departmentId) return e.department_id === parsed.departmentId;
      if (isAdmin) return true;
      return e.department_id !== null && managedDeptIds.has(e.department_id);
    });

    const mappedAssignments = await mapAssignmentViews(ctx.trx, ctx.orgId, legalEntityId, assignRows, {
      visibleEmps,
      deptNames,
    });
    const scopedEmpIds = new Set(scopedEmps.map((e) => e.id));

    const analysis = analyzeWeeklyShiftCoverage({
      weekStart,
      weekEnd,
      employees: scopedEmps.map((e) => ({
        id: e.id,
        displayName: e.display_name,
        departmentId: e.department_id,
        departmentName: e.department_id ? (deptNames.get(e.department_id) ?? null) : null,
      })),
      assignmentsInExtendedWindow: mappedAssignments.map((a) => ({
        id: a.id,
        employeeId: a.employeeId,
        employeeName: a.employeeName,
        departmentId: a.departmentId,
        departmentName: a.departmentName,
        shiftTemplateId: a.shiftTemplateId,
        shiftCode: a.shiftCode,
        shiftName: a.shiftName,
        startMinute: a.startMinute,
        endMinute: a.endMinute,
        crossesMidnight: a.crossesMidnight,
        workDate: a.workDate,
      })),
      unavailabilities: unavailRows
        .filter((u) => scopedEmpIds.has(u.employee_id))
        .map((u) => ({
          employeeId: u.employee_id,
          source: u.source === 'trip' ? 'trip' : 'leave',
          startOn: isoDateOnly(u.start_on),
          endOn: isoDateOnly(u.end_on),
        })),
    });

    return {
      legalEntityId,
      weekStart,
      weekEnd,
      lang: parsed.lang ?? 'vi',
      conflicts: analysis.conflicts,
      gaps: analysis.gaps,
      eligibleCandidates: analysis.eligibleCandidates,
    };
  },
});

export const shiftCoverageAudit = defineCommand({
  name: 'hr.shift.coverage.audit',
  input: zHrShiftCoverageAudit,
  risk: 'R0',
  sideEffect: 'none',
  access: STAFF_ROLES,
  target: (input: HrShiftCoverageAudit) => ({ type: 'hr.shift_assignment', id: input.legalEntityId }),
  writes: [],
  handler: async (ctx, input: HrShiftCoverageAudit): Promise<{ ok: true }> => {
    const parsed = zHrShiftCoverageAudit.parse(input);
    await resolveManagerScope(ctx, parsed.legalEntityId);
    ctx.audit({
      legalEntityId: parsed.legalEntityId,
      weekStart: parsed.weekStart,
      aiReason: parsed.aiReason,
      conflictCount: parsed.conflictCount,
    });
    return { ok: true };
  },
});

export const hrShiftCommands = [
  shiftTemplateCreate,
  shiftTemplateUpdate,
  shiftTemplateArchive,
  shiftTemplateSeedDefaults,
  shiftAssignmentUpsert,
  shiftAssignmentDelete,
  selfShiftSwapSubmit,
  selfShiftSwapCancel,
  shiftSwapApprove,
  shiftSwapReject,
  shiftCoverageAudit,
] as const;

export const hrShiftQueries = [
  shiftTemplateList,
  shiftRosterGet,
  selfShiftsList,
  shiftSwapList,
  shiftCoverageRead,
] as const;

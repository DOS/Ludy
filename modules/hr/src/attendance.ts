// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 5C (#4447): Web/PWA 1-click attendance check-in/out, office QR stamp,
// deterministic anomaly checks, audited Ly narration snapshot, and monthly payroll rollup via decimal.js.
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import {
  isVietnamHoliday,
  tableWrite,
  vietnamMonth,
  vietnamToday,
  weekdayOf,
  zHrAttendanceAdjust,
  zHrAttendanceAnomaliesAsk,
  zHrAttendanceAnomaliesAudit,
  zHrAttendanceList,
  zHrAttendanceQrRotate,
  zHrAttendanceRollupToPayroll,
  zHrPayrollInputs,
  zHrSelfAttendanceCheckIn,
  zHrSelfAttendanceCheckOut,
  zHrSelfAttendanceList,
  type HrAdminAttendanceRow,
  type HrAttendanceAdjust,
  type HrAttendanceAnomaliesAsk,
  type HrAttendanceAnomaliesAudit,
  type HrAttendanceAnomaliesSnapshot,
  type HrAttendanceAnomaly,
  type HrAttendanceAnomalyKind,
  type HrAttendanceList,
  type HrAttendanceListResult,
  type HrAttendanceLogView,
  type HrAttendanceQrRotate,
  type HrAttendanceQrRotateResult,
  type HrAttendanceRollupResult,
  type HrAttendanceRollupRow,
  type HrAttendanceRollupToPayroll,
  type HrAttendanceStatus,
  type HrAttendanceSummary,
  type HrOvertimeDayKind,
  type HrPayBasis,
  type HrPayrollInputs,
  type HrSelfAttendanceCheckIn,
  type HrSelfAttendanceCheckOut,
  type HrSelfAttendanceList,
  type HrSelfAttendanceListResult,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { money, toMoney } from '@ludy/l10n-vn';
import { MANAGERS, resolveEntity, userOf } from './employees.ts';
import { STAFF_ROLES, resolveSelfEmployee } from './leave-requests.ts';
import { hrManifest } from './manifest.ts';
import {
  LINE_UPDATE_COLUMNS,
  applyBatchLineUpdates,
  figuresOf,
  lockDraftLines,
  resolveDraftLineTarget,
  sameOvertimeEntries,
} from './payroll-run.ts';

export const HALF_DAY_THRESHOLD_MINUTES = 360;
export const SHORT_DAY_ANOMALY_MINUTES = 240;
export const LONG_DAY_ANOMALY_MINUTES = 600;
export const REGULAR_SHIFT_MINUTES = 540;
const VN_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const QR_HASH_PREFIX = 'crove-attendance-qr:v1:';

/** Extracts the raw QR secret from either a direct token or an app check-in link containing `#qr=...` or `?qr=...`. */
export function normalizeAttendanceQrToken(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('/')) {
      const url = new URL(trimmed, 'https://app.ludy.local');
      if (url.hash) {
        const hashParams = new URLSearchParams(url.hash.slice(1));
        const hp = hashParams.get('qr')?.trim();
        if (hp) return hp;
      }
      const qp = url.searchParams.get('qr')?.trim();
      if (qp) return qp;
    }
  } catch {
    // Not a URL; treat as raw secret below.
  }
  const match = /(?:^|[?&#])qr=([^&#]+)/.exec(trimmed);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]).trim();
    } catch {
      return match[1].trim();
    }
  }
  return trimmed;
}

/** Deterministic SHA-256 hash stored and matched against `crove_hr.attendance_qr_config.qr_secret_hash`. */
export function hashAttendanceQrSecret(orgId: string, legalEntityId: string, rawToken: string): string {
  const token = normalizeAttendanceQrToken(rawToken);
  return createHash('sha256').update(`${QR_HASH_PREFIX}${orgId}:${legalEntityId}:${token}`).digest('hex');
}

function isoDateOnly(d: Date | string): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

function monthRange(month: string): { start: string; end: string } {
  const [yStr, mStr] = month.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, '0')}`,
  };
}

/** Counts scheduled Mon-Sat days in the month and Mon-Sat Vietnam public holidays within the active employment window. */
function monthCalendarRollupMetrics(args: {
  month: string;
  hireDate?: string | null | undefined;
  endedOn?: string | null | undefined;
}): { scheduledMonSatDays: number; paidHolidayDays: number } {
  const { start, end } = monthRange(args.month);
  const [yearStr, monthStr] = args.month.split('-');
  const lastDay = Number(end.slice(8, 10));
  const activeStart = args.hireDate && args.hireDate > start ? args.hireDate : start;
  const activeEnd = args.endedOn && args.endedOn < end ? args.endedOn : end;
  let scheduledMonSatDays = 0;
  let paidHolidayDays = 0;
  for (let day = 1; day <= lastDay; day += 1) {
    const date = `${yearStr}-${monthStr}-${String(day).padStart(2, '0')}`;
    if (weekdayOf(date) === 7) continue;
    scheduledMonSatDays += 1;
    if (date >= activeStart && date <= activeEnd && isVietnamHoliday(date)) {
      paidHolidayDays += 1;
    }
  }
  return { scheduledMonSatDays, paidHolidayDays };
}

function elapsedMinutes(checkedInAt: Date, checkedOutAt: Date): number {
  const diff = Math.floor((checkedOutAt.getTime() - checkedInAt.getTime()) / 60_000);
  return Math.min(1440, Math.max(0, diff));
}

/** Deterministic anomaly classification (0 LLM tokens): weekend/holiday work, missing checkout, < 4h, > 10h. */
export function detectAttendanceAnomalies(row: {
  workDate: string;
  today: string;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  workedMinutes: number | null;
  status: HrAttendanceStatus;
}): HrAttendanceAnomalyKind[] {
  const out: HrAttendanceAnomalyKind[] = [];
  if (isVietnamHoliday(row.workDate)) {
    out.push('holiday_work');
  } else if (weekdayOf(row.workDate) === 7) {
    out.push('weekend_work');
  }
  if ((row.status === 'missing_checkout' || row.checkedOutAt === null) && row.workDate < row.today) {
    out.push('missing_checkout');
  }
  if (
    row.workedMinutes !== null &&
    row.workedMinutes < SHORT_DAY_ANOMALY_MINUTES &&
    row.status !== 'missing_checkout' &&
    (row.workedMinutes > 0 || row.checkedInAt !== null)
  ) {
    out.push('short_day');
  }
  if (row.workedMinutes !== null && row.workedMinutes > LONG_DAY_ANOMALY_MINUTES) {
    out.push('long_day');
  }
  return out;
}

/** Exact Vietnam (+07:00) night interval overlap minutes (22:00..06:00). */
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

function formatDecimalString(dec: ReturnType<typeof money>, scale: number): string {
  const fixed = dec.toDecimalPlaces(scale).toFixed(scale);
  if (!fixed.includes('.')) return fixed;
  const trimmed = fixed.replace(/\.?0+$/, '');
  return trimmed === '' || trimmed === '-0' ? '0' : trimmed;
}

export interface AttendanceRollupEntry {
  workDate: string;
  checkedInAt: Date | null;
  checkedOutAt: Date | null;
  workedMinutes: number | null;
  status: HrAttendanceStatus;
}

export interface ComputedEmployeeAttendanceRollup {
  workedDays: string;
  paidLeaveDays: string;
  unpaidLeaveDays: string;
  workedHours: string | null;
  overtimeHours: string;
  nightHours: string;
  overtime: HrPayrollInputs['overtime'];
}

function dayKindForDate(workDate: string): HrOvertimeDayKind {
  if (isVietnamHoliday(workDate)) return 'holiday';
  if (weekdayOf(workDate) === 7) return 'weekly_rest_day';
  return 'normal_day';
}

function isWithinEmploymentWindow(workDate: string, hireDate?: string | null, endedOn?: string | null): boolean {
  return (!hireDate || workDate >= hireDate) && (!endedOn || workDate <= endedOn);
}

/** Deterministic decimal.js rollup of an employee's month attendance into payroll inputs (100% parity with CSV import). */
export function computeEmployeeAttendanceRollup(args: {
  month: string;
  workingDays: string;
  payBasis: HrPayBasis;
  existingInputs: HrPayrollInputs;
  paidLeaveDays: string;
  hireDate?: string | null | undefined;
  endedOn?: string | null | undefined;
  entries: readonly AttendanceRollupEntry[];
}): ComputedEmployeeAttendanceRollup {
  let workedDaysDec = money('0');
  let normalRegularMinutes = 0;
  let ordinaryNightMinutes = 0;
  const otMinutes: Record<`${HrOvertimeDayKind}:${'day' | 'night'}`, number> = {
    'normal_day:day': 0,
    'normal_day:night': 0,
    'weekly_rest_day:day': 0,
    'weekly_rest_day:night': 0,
    'holiday:day': 0,
    'holiday:night': 0,
  };

  for (const e of args.entries) {
    if (!isWithinEmploymentWindow(e.workDate, args.hireDate, args.endedOn)) continue;
    if (e.status === 'missing_checkout' || e.workedMinutes === null) continue;
    const mins = Math.max(0, Math.min(1440, e.workedMinutes));
    const kind = dayKindForDate(e.workDate);

    if (kind === 'normal_day') {
      if (e.status === 'present') {
        workedDaysDec = workedDaysDec.plus('1');
      } else if (e.status === 'half_day') {
        workedDaysDec = workedDaysDec.plus('0.5');
      } else if (e.status === 'adjusted') {
        if (mins >= HALF_DAY_THRESHOLD_MINUTES) workedDaysDec = workedDaysDec.plus('1');
        else if (mins > 0) workedDaysDec = workedDaysDec.plus('0.5');
      }

      const regularMins = Math.min(mins, REGULAR_SHIFT_MINUTES);
      const extraMins = Math.max(0, mins - REGULAR_SHIFT_MINUTES);
      normalRegularMinutes += regularMins;

      const regularEnd =
        e.checkedInAt && e.checkedOutAt
          ? new Date(Math.min(e.checkedOutAt.getTime(), e.checkedInAt.getTime() + regularMins * 60_000))
          : null;
      const ordNight =
        regularMins > 0 && e.checkedInAt && regularEnd
          ? Math.min(regularMins, nightOverlapMinutes(e.checkedInAt, regularEnd))
          : 0;
      const otStart = e.checkedInAt ? new Date(e.checkedInAt.getTime() + REGULAR_SHIFT_MINUTES * 60_000) : null;
      const otEnd =
        extraMins > 0 && otStart && e.checkedOutAt
          ? new Date(Math.min(e.checkedOutAt.getTime(), otStart.getTime() + extraMins * 60_000))
          : null;
      const otNight =
        extraMins > 0 && otStart && otEnd
          ? Math.min(extraMins, nightOverlapMinutes(otStart, otEnd))
          : 0;
      ordinaryNightMinutes += ordNight;
      otMinutes['normal_day:night'] += otNight;
      otMinutes['normal_day:day'] += Math.max(0, extraMins - otNight);
    } else {
      const creditedEnd =
        e.checkedInAt && e.checkedOutAt
          ? new Date(Math.min(e.checkedOutAt.getTime(), e.checkedInAt.getTime() + mins * 60_000))
          : null;
      const night = e.checkedInAt && creditedEnd ? Math.min(mins, nightOverlapMinutes(e.checkedInAt, creditedEnd)) : 0;
      otMinutes[`${kind}:night`] += night;
      otMinutes[`${kind}:day`] += Math.max(0, mins - night);
    }
  }

  const { scheduledMonSatDays, paidHolidayDays } = monthCalendarRollupMetrics({
    month: args.month,
    hireDate: args.hireDate,
    endedOn: args.endedOn,
  });
  const paidLeaveDec = money(args.paidLeaveDays);
  const workingDaysDec = money(args.workingDays);
  const scheduledCapDec = money(scheduledMonSatDays);
  // Cap standard working days to the calendar's actual Mon-Sat count (e.g. Feb = 24), and credit Mon-Sat public holidays
  // within the employee's active employment dates per VN Labor Code Art. 112 without double-counting daysNotEmployed.
  const effectiveWorkingDaysDec = workingDaysDec.lt(scheduledCapDec) ? workingDaysDec : scheduledCapDec;
  const compensatedDec = workedDaysDec
    .plus(paidHolidayDays)
    .plus(paidLeaveDec)
    .plus(args.existingInputs.daysNotEmployed)
    .plus(args.existingInputs.sicknessBhxhDays)
    .plus(args.existingInputs.maternityBhxhDays);
  const shortfallDec = effectiveWorkingDaysDec.minus(compensatedDec);
  const unpaidLeaveDec = shortfallDec.gt(0)
    ? shortfallDec.gt(workingDaysDec)
      ? workingDaysDec
      : shortfallDec
    : money('0');

  const otOrder: readonly { dayKind: HrOvertimeDayKind; night: boolean; key: keyof typeof otMinutes }[] = [
    { dayKind: 'normal_day', night: false, key: 'normal_day:day' },
    { dayKind: 'weekly_rest_day', night: false, key: 'weekly_rest_day:day' },
    { dayKind: 'holiday', night: false, key: 'holiday:day' },
    { dayKind: 'normal_day', night: true, key: 'normal_day:night' },
    { dayKind: 'weekly_rest_day', night: true, key: 'weekly_rest_day:night' },
    { dayKind: 'holiday', night: true, key: 'holiday:night' },
  ];

  const overtime: HrPayrollInputs['overtime'] = [];
  let totalOtHoursDec = money('0');
  for (const spec of otOrder) {
    const m = otMinutes[spec.key];
    if (m <= 0) continue;
    const hDec = money(m).div(60).toDecimalPlaces(2);
    if (!hDec.gt(0)) continue;
    totalOtHoursDec = totalOtHoursDec.plus(hDec);
    overtime.push({ dayKind: spec.dayKind, night: spec.night, hours: formatDecimalString(hDec, 2) });
  }

  const nightHoursDec = money(ordinaryNightMinutes).div(60).toDecimalPlaces(2);
  const workedHoursStr =
    args.payBasis === 'hourly'
      ? formatDecimalString(money(normalRegularMinutes).div(60).toDecimalPlaces(2), 2)
      : null;

  return {
    workedDays: formatDecimalString(workedDaysDec, 1),
    paidLeaveDays: formatDecimalString(paidLeaveDec, 1),
    unpaidLeaveDays: formatDecimalString(unpaidLeaveDec, 1),
    workedHours: workedHoursStr,
    overtimeHours: formatDecimalString(totalOtHoursDec, 2),
    nightHours: formatDecimalString(nightHoursDec, 2),
    overtime,
  };
}

function toAttendanceLogView(
  row: {
    id: string;
    legal_entity_id: string;
    employee_id: string;
    work_date: Date | string;
    checked_in_at: Date | null;
    checked_out_at: Date | null;
    check_in_method: 'web' | 'qr' | 'manual';
    worked_minutes: number | null;
    status: HrAttendanceStatus;
    note: string | null;
    updated_at: Date;
  },
  today: string,
): HrAttendanceLogView {
  const workDate = isoDateOnly(row.work_date);
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    employeeId: row.employee_id,
    workDate,
    checkedInAt: row.checked_in_at ? row.checked_in_at.toISOString() : null,
    checkedOutAt: row.checked_out_at ? row.checked_out_at.toISOString() : null,
    checkInMethod: row.check_in_method,
    workedMinutes: row.worked_minutes,
    status: row.status,
    note: row.note,
    anomalies: detectAttendanceAnomalies({
      workDate,
      today,
      checkedInAt: row.checked_in_at,
      checkedOutAt: row.checked_out_at,
      workedMinutes: row.worked_minutes,
      status: row.status,
    }),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function requireLinkedEmployee(ctx: Parameters<Parameters<typeof defineQuery>[0]['handler']>[0]) {
  const uid = userOf(ctx.actor);
  const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, uid);
  if (!emp) {
    throw new DomainError('HR_SELF_NOT_LINKED', 403, 'Tài khoản của bạn chưa được liên kết với hồ sơ nhân viên nào');
  }
  return { uid, emp };
}

async function requireLinkedActiveEmployee(ctx: Parameters<Parameters<typeof defineQuery>[0]['handler']>[0]) {
  const { uid, emp } = await requireLinkedEmployee(ctx);
  if (emp.status !== 'active') {
    throw new DomainError('HR_EMPLOYEE_ENDED', 409, 'Hồ sơ nhân viên này đã kết thúc làm việc');
  }
  return { uid, emp };
}

export const selfAttendanceCheckIn = defineCommand({
  name: 'hr.self.attendance.check_in',
  input: zHrSelfAttendanceCheckIn,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'attendance_log', [
      'org_id',
      'legal_entity_id',
      'employee_id',
      'work_date',
      'checked_in_at',
      'checked_out_at',
      'check_in_method',
      'worked_minutes',
      'status',
      'note',
      'created_by',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrSelfAttendanceCheckIn): Promise<HrAttendanceLogView> => {
    const parsed = zHrSelfAttendanceCheckIn.parse(input);
    const { uid, emp } = await requireLinkedActiveEmployee(ctx);
    const today = vietnamToday(ctx.now);

    if (parsed.method === 'qr') {
      const qrHash = hashAttendanceQrSecret(ctx.orgId, emp.legal_entity_id, parsed.qrToken ?? '');
      const { rows } = await sql<{ ok: boolean }>`
        SELECT crove_hr.verify_attendance_qr(${ctx.orgId}::uuid, ${emp.legal_entity_id}::uuid, ${qrHash}) AS ok
      `.execute(ctx.trx);
      if (!rows[0]?.ok) {
        throw new DomainError('HR_ATTENDANCE_QR_INVALID', 400, 'Mã QR điểm danh không hợp lệ hoặc đã thay đổi');
      }
    }

    const existing = await ctx.trx
      .selectFrom('crove_hr.attendance_log')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', emp.id)
      .where('work_date', '=', today)
      .executeTakeFirst();
    if (existing) {
      throw new DomainError('HR_ATTENDANCE_ALREADY_CHECKED_IN', 409, 'Bạn đã check-in cho ngày hôm nay rồi');
    }

    // Handle concurrent check-ins on the same (org_id, employee_id, work_date) atomically with ON CONFLICT DO NOTHING
    // instead of selecting FOR UPDATE on payroll_employee (read-only for non-admin members under RLS).
    const inserted = await ctx.trx
      .insertInto('crove_hr.attendance_log')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: emp.legal_entity_id,
        employee_id: emp.id,
        work_date: today,
        checked_in_at: ctx.now,
        checked_out_at: null,
        check_in_method: parsed.method,
        worked_minutes: null,
        status: 'missing_checkout',
        note: parsed.note ?? null,
        created_by: uid,
        updated_at: ctx.now,
      })
      .onConflict((oc) => oc.columns(['org_id', 'employee_id', 'work_date']).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (!inserted) {
      throw new DomainError('HR_ATTENDANCE_ALREADY_CHECKED_IN', 409, 'Bạn đã check-in cho ngày hôm nay rồi');
    }

    ctx.audit({
      employeeId: emp.id,
      workDate: today,
      method: parsed.method,
      status: 'missing_checkout',
    });
    return toAttendanceLogView(inserted, today);
  },
});

export const selfAttendanceCheckOut = defineCommand({
  name: 'hr.self.attendance.check_out',
  input: zHrSelfAttendanceCheckOut,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'attendance_log', [
      'checked_out_at',
      'worked_minutes',
      'status',
      'note',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrSelfAttendanceCheckOut): Promise<HrAttendanceLogView> => {
    const parsed = zHrSelfAttendanceCheckOut.parse(input);
    const { emp } = await requireLinkedActiveEmployee(ctx);
    const today = vietnamToday(ctx.now);
    const yesterday = vietnamToday(new Date(ctx.now.getTime() - DAY_MS));
    const workDate = parsed.workDate ?? today;
    if (workDate !== today && workDate !== yesterday) {
      throw new DomainError('HR_ATTENDANCE_TIME_INVALID', 422, 'Chỉ tự check-out được cho ngày hôm nay hoặc ca qua đêm hôm qua');
    }

    const existing = await ctx.trx
      .selectFrom('crove_hr.attendance_log')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', emp.id)
      .where('work_date', '=', workDate)
      .forUpdate()
      .executeTakeFirst();

    if (!existing) {
      throw new DomainError('HR_ATTENDANCE_NOT_CHECKED_IN', 404, 'Chưa có lượt check-in cho ngày này');
    }
    if (!existing.checked_in_at || existing.checked_out_at !== null || existing.status === 'adjusted') {
      throw new DomainError('HR_ATTENDANCE_ALREADY_CHECKED_OUT', 409, 'Ngày công này đã check-out hoặc đã được điều chỉnh');
    }
    if (ctx.now.getTime() < existing.checked_in_at.getTime()) {
      throw new DomainError('HR_ATTENDANCE_TIME_INVALID', 409, 'Thời điểm check-out sớm hơn thời điểm check-in');
    }

    const mins = elapsedMinutes(existing.checked_in_at, ctx.now);
    const nextStatus: HrAttendanceStatus = mins >= HALF_DAY_THRESHOLD_MINUTES ? 'present' : 'half_day';
    const [updated] = await ctx.trx
      .updateTable('crove_hr.attendance_log')
      .set({
        checked_out_at: ctx.now,
        worked_minutes: mins,
        status: nextStatus,
        note: parsed.note ?? existing.note,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .returningAll()
      .execute();

    ctx.audit({
      logId: existing.id,
      employeeId: emp.id,
      workDate,
      workedMinutes: mins,
      status: nextStatus,
    });
    return toAttendanceLogView(updated!, today);
  },
});

export const selfAttendanceList = defineQuery({
  name: 'hr.self.attendance.list',
  input: zHrSelfAttendanceList,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input: HrSelfAttendanceList): Promise<HrSelfAttendanceListResult> => {
    const parsed = zHrSelfAttendanceList.parse(input);
    const { emp } = await requireLinkedEmployee(ctx);
    const now = new Date();
    const today = vietnamToday(now);
    const yesterday = vietnamToday(new Date(now.getTime() - DAY_MS));
    const month = parsed.month ?? vietnamMonth(now);
    const { start, end } = monthRange(month);

    const rows = await ctx.trx
      .selectFrom('crove_hr.attendance_log')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', emp.id)
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .orderBy('work_date', 'desc')
      .execute();

    const logs = rows.map((r) => toAttendanceLogView(r, today));
    const recentOpenRows = await ctx.trx
      .selectFrom('crove_hr.attendance_log')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', emp.id)
      .where('work_date', 'in', [today, yesterday])
      .execute();
    const recentByDate = new Map(recentOpenRows.map((r) => [isoDateOnly(r.work_date), toAttendanceLogView(r, today)]));
    const todayRow = recentByDate.get(today) ?? null;
    const yesterdayRow = recentByDate.get(yesterday) ?? null;
    const isEligibleOpen = (row: HrAttendanceLogView | null): boolean =>
      row !== null && row.checkedOutAt === null && row.status === 'missing_checkout';
    const openLog =
      emp.status === 'active'
        ? isEligibleOpen(todayRow)
          ? todayRow
          : todayRow === null && isEligibleOpen(yesterdayRow)
            ? yesterdayRow
            : null
        : null;

    const summary: HrAttendanceSummary = {
      presentDays: 0,
      halfDays: 0,
      missingCheckoutDays: 0,
      adjustedDays: 0,
      totalWorkedMinutes: 0,
    };
    for (const l of logs) {
      if (l.status === 'present') summary.presentDays += 1;
      else if (l.status === 'half_day') summary.halfDays += 1;
      else if (l.status === 'missing_checkout' && l.workDate < today) summary.missingCheckoutDays += 1;
      else if (l.status === 'adjusted') summary.adjustedDays += 1;
      if (l.workedMinutes !== null) summary.totalWorkedMinutes += l.workedMinutes;
    }

    return {
      employeeId: emp.id,
      legalEntityId: emp.legal_entity_id,
      month,
      today,
      todayLog: todayRow,
      openLog,
      logs,
      summary,
    };
  },
});

async function loadAdminAttendanceData(
  ctx: Parameters<Parameters<typeof defineQuery>[0]['handler']>[0],
  opts: { month: string; legalEntityId: string; employeeId?: string },
) {
  const today = vietnamToday(new Date());
  const { start, end } = monthRange(opts.month);

  let q = ctx.trx
    .selectFrom('crove_hr.attendance_log as a')
    .innerJoin('crove_hr.payroll_employee as e', (j) => j.onRef('e.org_id', '=', 'a.org_id').onRef('e.id', '=', 'a.employee_id'))
    .select([
      'a.id',
      'a.legal_entity_id',
      'a.employee_id',
      'a.work_date',
      'a.checked_in_at',
      'a.checked_out_at',
      'a.check_in_method',
      'a.worked_minutes',
      'a.status',
      'a.note',
      'a.updated_at',
      'e.display_name as employee_name',
    ])
    .where('a.org_id', '=', ctx.orgId)
    .where('a.legal_entity_id', '=', opts.legalEntityId)
    .where('a.work_date', '>=', start)
    .where('a.work_date', '<=', end)
    .orderBy('a.work_date', 'desc')
    .orderBy('e.display_name', 'asc');
  if (opts.employeeId) {
    q = q.where('a.employee_id', '=', opts.employeeId);
  }
  const rows = await q.execute();

  const empIds = [...new Set(rows.map((r) => r.employee_id))];
  const payBasisByEmp = new Map<string, HrPayBasis>();
  if (empIds.length > 0) {
    const terms = await ctx.trx
      .selectFrom('crove_hr.payroll_employment')
      .select(['employee_id', 'pay_basis', 'effective_from'])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', 'in', empIds)
      .where('effective_from', '<=', end)
      .orderBy('effective_from', 'asc')
      .execute();
    for (const t of terms) {
      payBasisByEmp.set(t.employee_id, t.pay_basis ?? 'monthly');
    }
  }

  const allLogs: HrAdminAttendanceRow[] = [];
  const anomalies: HrAttendanceAnomaly[] = [];
  for (const r of rows) {
    const view = toAttendanceLogView(r, today);
    const adminRow: HrAdminAttendanceRow = {
      ...view,
      employeeName: r.employee_name,
      payBasis: payBasisByEmp.get(r.employee_id) ?? 'monthly',
    };
    allLogs.push(adminRow);
    for (const kind of view.anomalies) {
      anomalies.push({
        logId: view.id,
        employeeId: view.employeeId,
        employeeName: r.employee_name,
        workDate: view.workDate,
        kind,
        workedMinutes: view.workedMinutes,
        status: view.status,
      });
    }
  }
  return { today, allLogs, anomalies };
}

export const attendanceList = defineQuery({
  name: 'hr.attendance.list',
  input: zHrAttendanceList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input: HrAttendanceList): Promise<HrAttendanceListResult> => {
    const parsed = zHrAttendanceList.parse(input);
    const legalEntityId = await resolveEntity(ctx, parsed.legalEntityId);
    const month = parsed.month ?? vietnamMonth(new Date());

    const { today, allLogs, anomalies } = await loadAdminAttendanceData(ctx, {
      month,
      legalEntityId,
      ...(parsed.employeeId ? { employeeId: parsed.employeeId } : {}),
    });

    const activeQr = await ctx.trx
      .selectFrom('crove_hr.attendance_qr_config')
      .select(['id', 'created_at'])
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('active', '=', true)
      .executeTakeFirst();

    const filteredLogs = parsed.anomaliesOnly ? allLogs.filter((l) => l.anomalies.length > 0) : allLogs;

    return {
      month,
      today,
      legalEntityId,
      logs: filteredLogs,
      anomalies,
      qrConfig: {
        configured: Boolean(activeQr),
        activeConfigId: activeQr?.id ?? null,
        legalEntityId,
        rotatedAt: activeQr ? activeQr.created_at.toISOString() : null,
      },
    };
  },
});

export const attendanceAdjust = defineCommand({
  name: 'hr.attendance.adjust',
  input: zHrAttendanceAdjust,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input) => ({ type: 'hr.attendance_log', id: input.employeeId }),
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'attendance_log', [
      'org_id',
      'legal_entity_id',
      'employee_id',
      'work_date',
      'checked_in_at',
      'checked_out_at',
      'check_in_method',
      'worked_minutes',
      'status',
      'note',
      'created_by',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrAttendanceAdjust): Promise<HrAdminAttendanceRow> => {
    const parsed = zHrAttendanceAdjust.parse(input);
    const uid = userOf(ctx.actor);
    const today = vietnamToday(ctx.now);

    const emp = await ctx.trx
      .selectFrom('crove_hr.payroll_employee')
      .select(['id', 'legal_entity_id', 'display_name', 'erased_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', parsed.employeeId)
      .forUpdate()
      .executeTakeFirst();
    if (!emp) {
      throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên');
    }
    if (emp.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Không thể điều chỉnh chấm công của nhân viên đã xóa dữ liệu');
    }

    const existing = await ctx.trx
      .selectFrom('crove_hr.attendance_log')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', emp.id)
      .where('work_date', '=', parsed.workDate)
      .forUpdate()
      .executeTakeFirst();

    if (
      parsed.expectedUpdatedAt !== undefined &&
      (!existing || existing.updated_at.toISOString() !== new Date(parsed.expectedUpdatedAt).toISOString())
    ) {
      throw new DomainError(
        'HR_ATTENDANCE_CONFLICT',
        409,
        'Bảng chấm công đã được cập nhật bởi thao tác khác. Vui lòng tải lại trước khi lưu.',
      );
    }

    const checkedInAt =
      parsed.checkedInAt !== undefined
        ? parsed.checkedInAt
          ? new Date(parsed.checkedInAt)
          : null
        : existing?.checked_in_at ?? null;
    const checkedOutAt =
      parsed.checkedOutAt !== undefined
        ? parsed.checkedOutAt
          ? new Date(parsed.checkedOutAt)
          : null
        : existing?.checked_out_at ?? null;

    if (checkedInAt && checkedOutAt && checkedOutAt.getTime() < checkedInAt.getTime()) {
      throw new DomainError('HR_ATTENDANCE_TIME_INVALID', 422, 'Giờ check-out không thể sớm hơn giờ check-in');
    }
    if (!checkedInAt && parsed.status !== 'adjusted') {
      throw new DomainError('HR_ATTENDANCE_CHECKIN_REQUIRED', 422, 'Cần có giờ check-in trừ khi trạng thái là điều chỉnh');
    }
    if ((parsed.status === 'present' || parsed.status === 'half_day') && !checkedOutAt) {
      throw new DomainError(
        'HR_ATTENDANCE_TIME_INVALID',
        422,
        'Trạng thái đã chấm công hoặc nửa ngày công phải có giờ check-out',
      );
    }

    const inChanged =
      parsed.checkedInAt !== undefined &&
      (checkedInAt?.getTime() ?? null) !== (existing?.checked_in_at?.getTime() ?? null);
    const outChanged =
      parsed.checkedOutAt !== undefined &&
      (checkedOutAt?.getTime() ?? null) !== (existing?.checked_out_at?.getTime() ?? null);

    const workedMinutes =
      parsed.workedMinutes !== undefined
        ? parsed.workedMinutes
        : checkedInAt && checkedOutAt
          ? existing && !inChanged && !outChanged && existing.worked_minutes !== null
            ? existing.worked_minutes
            : elapsedMinutes(checkedInAt, checkedOutAt)
          : existing && !inChanged && !outChanged
            ? existing.worked_minutes
            : null;
    if ((parsed.status === 'present' || parsed.status === 'half_day') && workedMinutes === null) {
      throw new DomainError(
        'HR_ATTENDANCE_MINUTES_REQUIRED',
        422,
        'Trạng thái đã chấm công hoặc nửa ngày công phải có số phút công hợp lệ',
      );
    }

    const note = parsed.note !== undefined ? parsed.note : existing?.note ?? null;

    let saved;
    if (existing) {
      const [updated] = await ctx.trx
        .updateTable('crove_hr.attendance_log')
        .set({
          checked_in_at: checkedInAt,
          checked_out_at: checkedOutAt,
          check_in_method: parsed.checkInMethod,
          worked_minutes: workedMinutes,
          status: parsed.status,
          note,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .returningAll()
        .execute();
      saved = updated!;
    } else {
      const [inserted] = await ctx.trx
        .insertInto('crove_hr.attendance_log')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: emp.legal_entity_id,
          employee_id: emp.id,
          work_date: parsed.workDate,
          checked_in_at: checkedInAt,
          checked_out_at: checkedOutAt,
          check_in_method: parsed.checkInMethod,
          worked_minutes: workedMinutes,
          status: parsed.status,
          note,
          created_by: uid,
          updated_at: ctx.now,
        })
        .returningAll()
        .execute();
      saved = inserted!;
    }

    const term = await ctx.trx
      .selectFrom('crove_hr.payroll_employment')
      .select(['pay_basis'])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', emp.id)
      .where('effective_from', '<=', monthRange(parsed.workDate.slice(0, 7)).end)
      .orderBy('effective_from', 'desc')
      .executeTakeFirst();

    ctx.audit({
      logId: saved.id,
      employeeId: emp.id,
      workDate: parsed.workDate,
      status: saved.status,
      workedMinutes: saved.worked_minutes,
    });

    return {
      ...toAttendanceLogView(saved, today),
      employeeName: emp.display_name,
      payBasis: term?.pay_basis ?? 'monthly',
    };
  },
});

export const attendanceQrRotate = defineCommand({
  name: 'hr.attendance.qr.rotate',
  input: zHrAttendanceQrRotate,
  risk: 'R2',
  sideEffect: 'internal',
  noIdempotency: true,
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input) => (input.legalEntityId ? { type: 'hr.attendance_qr_config', id: input.legalEntityId } : null),
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'attendance_qr_config', [
      'org_id',
      'legal_entity_id',
      'qr_secret_hash',
      'active',
      'created_by',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input: HrAttendanceQrRotate): Promise<HrAttendanceQrRotateResult> => {
    const parsed = zHrAttendanceQrRotate.parse(input);
    const uid = userOf(ctx.actor);
    const legalEntityId = await resolveEntity(ctx, parsed.legalEntityId);

    // Serialize concurrent QR rotations on the legal entity row so deactivate + insert never collides on active_entity_uq (23505).
    await ctx.trx
      .selectFrom('ludy_kernel.legal_entity')
      .select(['id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', legalEntityId)
      .forUpdate()
      .executeTakeFirst();

    await ctx.trx
      .updateTable('crove_hr.attendance_qr_config')
      .set({ active: false, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('legal_entity_id', '=', legalEntityId)
      .where('active', '=', true)
      .execute();

    const secret = randomBytes(24).toString('base64url');
    const hash = hashAttendanceQrSecret(ctx.orgId, legalEntityId, secret);
    const [inserted] = await ctx.trx
      .insertInto('crove_hr.attendance_qr_config')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: legalEntityId,
        qr_secret_hash: hash,
        active: true,
        created_by: uid,
        updated_at: ctx.now,
      })
      .returning(['id', 'created_at'])
      .execute();

    ctx.audit({ configId: inserted!.id, legalEntityId });
    return {
      configId: inserted!.id,
      legalEntityId,
      secret,
      rotatedAt: inserted!.created_at.toISOString(),
    };
  },
});

export const attendanceAnomaliesRead = defineQuery({
  name: 'hr.attendance.anomalies.read',
  input: zHrAttendanceAnomaliesAsk,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input: HrAttendanceAnomaliesAsk): Promise<HrAttendanceAnomaliesSnapshot> => {
    const parsed = zHrAttendanceAnomaliesAsk.parse(input);
    const legalEntityId = await resolveEntity(ctx, parsed.legalEntityId);
    const month = parsed.month ?? vietnamMonth(new Date());
    const { today, anomalies } = await loadAdminAttendanceData(ctx, { month, legalEntityId });

    return {
      month,
      today,
      legalEntityId,
      lang: parsed.lang,
      anomalies,
    };
  },
});

export const attendanceAnomaliesAudit = defineCommand({
  name: 'hr.attendance.anomalies.audit',
  input: zHrAttendanceAnomaliesAudit,
  risk: 'R0',
  sideEffect: 'none',
  access: MANAGERS,
  target: (input) => ({ type: 'hr.attendance_log', id: input.legalEntityId }),
  writes: [],
  handler: async (ctx, input: HrAttendanceAnomaliesAudit): Promise<{ ok: true }> => {
    ctx.audit({ month: input.month, legalEntityId: input.legalEntityId, aiReason: input.aiReason });
    return { ok: true };
  },
});

export const attendanceRollupToPayroll = defineCommand({
  name: 'hr.attendance.rollup_to_payroll',
  input: zHrAttendanceRollupToPayroll,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input) => ({ type: 'hr.payroll_run', id: input.runId }),
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_line', [...LINE_UPDATE_COLUMNS]),
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_run', ['updated_at']),
  ],
  handler: async (ctx, input: HrAttendanceRollupToPayroll): Promise<HrAttendanceRollupResult> => {
    const parsed = zHrAttendanceRollupToPayroll.parse(input);
    userOf(ctx.actor);
    const { payRun, byLineId, people } = await lockDraftLines(ctx, parsed.runId);
    const { start, end } = monthRange(payRun.month);
    const payableEmpIds = [
      ...new Set(
        [...byLineId.values()]
          .filter((lineRow) => lineRow.kind === 'pay' && people.has(lineRow.employee_id))
          .map((lineRow) => lineRow.employee_id),
      ),
    ];

    const logRows =
      payableEmpIds.length === 0
        ? []
        : await ctx.trx
            .selectFrom('crove_hr.attendance_log')
            .select(['employee_id', 'work_date', 'checked_in_at', 'checked_out_at', 'worked_minutes', 'status'])
            .where('org_id', '=', ctx.orgId)
            .where('legal_entity_id', '=', payRun.legal_entity_id)
            .where('employee_id', 'in', payableEmpIds)
            .where('work_date', '>=', start)
            .where('work_date', '<=', end)
            .orderBy('work_date', 'asc')
            .execute();

    const empIds = [...people.keys()];
    const nameByEmpId = new Map<string, string>();
    const firstHireByEmpId = new Map<string, string>();
    if (empIds.length > 0) {
      const empRows = await ctx.trx
        .selectFrom('crove_hr.payroll_employee')
        .select(['id', 'display_name'])
        .where('org_id', '=', ctx.orgId)
        .where('id', 'in', empIds)
        .execute();
      for (const er of empRows) nameByEmpId.set(er.id, er.display_name);

      const employmentRows = await ctx.trx
        .selectFrom('crove_hr.payroll_employment')
        .select(['employee_id', 'effective_from'])
        .where('org_id', '=', ctx.orgId)
        .where('employee_id', 'in', empIds)
        .orderBy('effective_from', 'asc')
        .execute();
      for (const em of employmentRows) {
        if (!firstHireByEmpId.has(em.employee_id)) {
          firstHireByEmpId.set(em.employee_id, isoDateOnly(em.effective_from));
        }
      }
    }

    const logsByEmp = new Map<string, AttendanceRollupEntry[]>();
    let missingCheckoutCount = 0;
    const openNonNormalDates: string[] = [];
    for (const r of logRows) {
      const workDate = isoDateOnly(r.work_date);
      const person = people.get(r.employee_id);
      const hireDate = firstHireByEmpId.get(r.employee_id) ?? person?.terms.effectiveFrom ?? null;
      const endedOn = person?.endedOn ?? null;
      if (!isWithinEmploymentWindow(workDate, hireDate, endedOn)) {
        continue;
      }
      if (r.status === 'missing_checkout' || r.worked_minutes === null) {
        missingCheckoutCount += 1;
        if (dayKindForDate(workDate) !== 'normal_day') {
          openNonNormalDates.push(workDate);
        }
      }
      const arr = logsByEmp.get(r.employee_id) ?? [];
      arr.push({
        workDate,
        checkedInAt: r.checked_in_at,
        checkedOutAt: r.checked_out_at,
        workedMinutes: r.worked_minutes,
        status: r.status,
      });
      logsByEmp.set(r.employee_id, arr);
    }

    if (missingCheckoutCount > 0 && !parsed.allowIncomplete) {
      throw new DomainError(
        'HR_ATTENDANCE_MISSING_CHECKOUT',
        409,
        `Còn ${missingCheckoutCount} ngày công chưa check-out trong tháng ${payRun.month}. Vui lòng điều chỉnh trước khi tổng hợp vào bảng lương.`,
      );
    }

    // Even under allowIncomplete, open rows on Sundays or public holidays carry secondary overtime anomalies
    // that cannot be silently discarded without human review.
    if (missingCheckoutCount > 0 && parsed.allowIncomplete && openNonNormalDates.length > 0) {
      throw new DomainError(
        'HR_ATTENDANCE_MISSING_CHECKOUT',
        409,
        `Không thể bỏ qua ngày thiếu check-out rơi vào Chủ nhật/ngày lễ (${openNonNormalDates.join(', ')}). Vui lòng điều chỉnh trước khi tổng hợp.`,
      );
    }

    const leaveRows =
      payableEmpIds.length === 0
        ? []
        : await ctx.trx
            .selectFrom('crove_hr.payroll_leave_entry')
            .select(['employee_id', 'kind', 'days'])
            .where('org_id', '=', ctx.orgId)
            .where('legal_entity_id', '=', payRun.legal_entity_id)
            .where('employee_id', 'in', payableEmpIds)
            .where('month', '=', payRun.month)
            .where('kind', 'in', ['annual_leave', 'personal_paid'])
            .where('approved', '=', true)
            .execute();
    const paidLeaveByEmp = new Map<string, ReturnType<typeof money>>();
    for (const lr of leaveRows) {
      const prev = paidLeaveByEmp.get(lr.employee_id) ?? money('0');
      paidLeaveByEmp.set(lr.employee_id, prev.plus(lr.days));
    }

    const updates: {
      lineId: string;
      employmentId: string;
      inputs: HrPayrollInputs;
      figures: ReturnType<typeof figuresOf>;
    }[] = [];
    const rollupRows: HrAttendanceRollupRow[] = [];
    let skippedEmployeeCount = 0;

    for (const [lineId, lineRow] of byLineId.entries()) {
      if (lineRow.kind !== 'pay') continue;
      if (!people.has(lineRow.employee_id)) {
        skippedEmployeeCount += 1;
        continue;
      }
      // Conservative policy under allowIncomplete: only completed/adjusted rows earn worked-day credit,
      // so unverified open days stay uncredited (increasing unpaid shortfall unless admin adjusts or logs leave).
      const empLogs = logsByEmp.get(lineRow.employee_id);
      const completedLogs = empLogs?.filter((e) => e.status !== 'missing_checkout' && e.workedMinutes !== null) ?? [];
      if (completedLogs.length === 0) {
        skippedEmployeeCount += 1;
        continue;
      }
      const { line, person, existing } = resolveDraftLineTarget(byLineId, people, lineId);
      const paidLeaveDays = toMoney(paidLeaveByEmp.get(line.employee_id) ?? money('0'));
      const computed = computeEmployeeAttendanceRollup({
        month: payRun.month,
        workingDays: payRun.working_days,
        payBasis: person.terms.payBasis,
        existingInputs: existing,
        paidLeaveDays,
        hireDate: firstHireByEmpId.get(line.employee_id) ?? person.terms.effectiveFrom,
        endedOn: person.endedOn,
        entries: completedLogs,
      });
      if (person.terms.payBasis === 'hourly' && computed.workedHours === null) {
        throw new DomainError('HR_ROLLUP_HOURLY_MISSING', 422, 'Nhân viên lương theo giờ thiếu giờ công hợp lệ');
      }
      const merged = zHrPayrollInputs.parse({
        ...existing,
        unpaidLeaveDays: computed.unpaidLeaveDays,
        unpaidLeaveFromLedger: false,
        overtime: computed.overtime,
        overtimeFromRequests: sameOvertimeEntries(computed.overtime, existing.overtime)
          ? existing.overtimeFromRequests
          : false,
        nightHours: computed.nightHours,
        ...(person.terms.payBasis === 'hourly' && computed.workedHours !== null ? { workedHours: computed.workedHours } : {}),
      });
      updates.push({
        lineId: line.id,
        employmentId: person.terms.id,
        inputs: merged,
        figures: figuresOf(person, merged, payRun.month, payRun.working_days),
      });
      rollupRows.push({
        lineId: line.id,
        employeeId: line.employee_id,
        employeeName: nameByEmpId.get(line.employee_id) ?? '',
        workedDays: computed.workedDays,
        paidLeaveDays: computed.paidLeaveDays,
        unpaidLeaveDays: computed.unpaidLeaveDays,
        workedHours: computed.workedHours,
        overtimeHours: computed.overtimeHours,
        nightHours: computed.nightHours,
      });
    }

    if (updates.length > 0) {
      await applyBatchLineUpdates(ctx, payRun.id, updates);
    }

    ctx.audit({
      runId: payRun.id,
      month: payRun.month,
      updatedCount: updates.length,
      skippedEmployeeCount,
      missingCheckoutCount,
    });

    return {
      runId: payRun.id,
      month: payRun.month,
      updatedCount: updates.length,
      skippedEmployeeCount,
      missingCheckoutCount,
      rows: rollupRows,
    };
  },
});

export const hrAttendanceCommands = [
  selfAttendanceCheckIn,
  selfAttendanceCheckOut,
  attendanceAdjust,
  attendanceQrRotate,
  attendanceAnomaliesAudit,
  attendanceRollupToPayroll,
];

export const hrAttendanceQueries = [
  selfAttendanceList,
  attendanceList,
  attendanceAnomaliesRead,
];

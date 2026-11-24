// SPDX-License-Identifier: AGPL-3.0-only
// Employee self-service portal & multi-level leave approval workflow (issue #4300, Stage 4A).
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import { memberProfiles } from '@ludy/kernel';
import {
  tableWrite,
  auditValue,
  zHrLeaveRequestDecide,
  zHrLeaveRequestList,
  zHrLeaveRequestRef,
  zHrPayslipRef,
  zHrSelfLeaveBalanceAsk,
  zHrSelfLeaveRequestList,
  zHrSelfLeaveRequestSubmit,
  zHrSelfPayslipsList,
  zHrSelfProfileAsk,
  type HrLeaveEntryView,
  type HrLeaveRequestActionResult,
  type HrLeaveRequestView,
  type HrPayslip,
  type HrSelfLeaveBalanceResult,
  type HrSelfLeaveSubmitResult,
  type HrSelfPayslipSummary,
  type HrSelfProfile,
} from '@ludy/kernel-contract';
import { money, toMoney } from '@ludy/l10n-vn';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { MANAGERS, memberLabel, userOf } from './employees.ts';
import { erasedError, evaluateLeaveBalanceSummary, loadEmployeeForLeave, validateMonthlyLeaveBounds } from './leave.ts';
import { hrManifest } from './manifest.ts';
import { isoDate as iso } from './payroll-dates.ts';
import { employerName, figuresOfLine, LINE_COLUMNS, type StoredLine } from './payroll-run.ts';

export const STAFF_ROLES: readonly MemberRole[] = ['owner', 'admin', 'member'];
const LEAVE_REQUEST = hrManifest.tables.ludy_hr.leave_request;

export const selfNotLinked = () =>
  new DomainError('HR_SELF_NOT_LINKED', 403, 'Tài khoản của bạn chưa được liên kết với hồ sơ nhân viên nào');
const requestNotFound = () =>
  new DomainError('HR_LEAVE_REQUEST_NOT_FOUND', 404, 'Không tìm thấy đơn xin nghỉ phép này');
const invalidState = (message: string) =>
  new DomainError('HR_LEAVE_REQUEST_INVALID_STATE', 409, message);
const selfApprovalBlocked = () =>
  new DomainError('HR_LEAVE_REQUEST_SELF_APPROVAL', 403, 'Bạn không thể tự duyệt hoặc từ chối đơn xin nghỉ của chính mình');

export async function resolveSelfEmployee(trx: QueryContext['trx'], orgId: string, userId: string) {
  return trx
    .selectFrom('ludy_hr.payroll_employee as e')
    .leftJoin('ludy_kernel.legal_entity as le', (j) => j.onRef('le.org_id', '=', 'e.org_id').onRef('le.id', '=', 'e.legal_entity_id'))
    .leftJoin('ludy_hr.department as d', (j) => j.onRef('d.org_id', '=', 'e.org_id').onRef('d.id', '=', 'e.department_id'))
    .select([
      'e.id',
      'e.legal_entity_id',
      'le.name as legal_entity_name',
      'e.display_name',
      'e.department_id',
      'd.name as department_name',
      'd.manager_user_id as department_manager_user_id',
      'e.job_title',
      'e.status',
      'e.ended_on',
      'e.erased_at',
    ])
    .where('e.org_id', '=', orgId)
    .where('e.user_id', '=', userId)
    .where('e.erased_at', 'is', null)
    .executeTakeFirst();
}

async function resolveSelfHireDate(trx: QueryContext['trx'], orgId: string, employeeId: string): Promise<string | null> {
  const { rows } = await sql<{ hire_date: Date | string | null }>`
    SELECT ludy_hr.self_hire_date(${orgId}::uuid, ${employeeId}::uuid) AS hire_date
  `.execute(trx);
  const raw = rows[0]?.hire_date ?? null;
  return raw === null ? null : iso(raw);
}

interface LeaveRequestRawRow {
  id: string;
  legal_entity_id: string;
  employee_id: string;
  employee_name: string | null;
  department_id: string | null;
  department_name: string | null;
  month: string;
  start_on: Date | string;
  end_on: Date | string;
  kind: 'annual_leave' | 'personal_paid' | 'unpaid_leave';
  days: string;
  status: 'pending_l1' | 'pending_final' | 'approved' | 'rejected' | 'cancelled';
  reason: string | null;
  decision_note: string | null;
  l1_approver_user_id: string | null;
  l1_acted_at: Date | string | null;
  final_acted_by: string | null;
  final_acted_at: Date | string | null;
  payroll_leave_entry_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

async function hydrateLeaveRequestViews(
  trx: QueryContext['trx'],
  rows: readonly LeaveRequestRawRow[],
): Promise<HrLeaveRequestView[]> {
  if (rows.length === 0) return [];
  const approverIds = rows.flatMap((r) => [r.l1_approver_user_id, r.final_acted_by]).filter((id): id is string => id !== null);
  const profiles = await memberProfiles(trx, approverIds);
  return rows.map((r) => ({
    id: r.id,
    legalEntityId: r.legal_entity_id,
    employeeId: r.employee_id,
    employeeName: r.employee_name ?? '',
    departmentId: r.department_id,
    departmentName: r.department_name ?? null,
    month: r.month,
    startOn: iso(r.start_on),
    endOn: iso(r.end_on),
    kind: r.kind,
    days: toMoney(money(r.days)),
    status: r.status,
    reason: r.employee_name === null ? null : r.reason,
    decisionNote: r.employee_name === null ? null : r.decision_note,
    l1ApproverUserId: r.l1_approver_user_id,
    l1ApproverName: r.l1_approver_user_id ? memberLabel(profiles.get(r.l1_approver_user_id)) : null,
    l1ActedAt: r.l1_acted_at === null ? null : new Date(r.l1_acted_at).toISOString(),
    finalActedBy: r.final_acted_by,
    finalActedByName: r.final_acted_by ? memberLabel(profiles.get(r.final_acted_by)) : null,
    finalActedAt: r.final_acted_at === null ? null : new Date(r.final_acted_at).toISOString(),
    payrollLeaveEntryId: r.payroll_leave_entry_id,
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

function parseIsoDayUtc(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export const selfProfileGet = defineQuery({
  name: 'hr.self.profile.get',
  input: zHrSelfProfileAsk,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx): Promise<HrSelfProfile> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    const managedRows = await ctx.trx
      .selectFrom('ludy_hr.department')
      .select(['id', 'legal_entity_id', 'name', 'code'])
      .where('org_id', '=', ctx.orgId)
      .where('manager_user_id', '=', callerUserId)
      .where('archived_at', 'is', null)
      .orderBy('name', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const managedDepartments = managedRows.map((d) => ({
      id: d.id,
      legalEntityId: d.legal_entity_id,
      name: d.name,
      code: d.code,
    }));

    if (!emp) {
      return {
        linked: false,
        employeeId: null,
        displayName: null,
        legalEntityId: null,
        legalEntityName: null,
        departmentId: null,
        departmentName: null,
        departmentManagerName: null,
        jobTitle: null,
        status: null,
        hireDate: null,
        endedOn: null,
        managesDepartmentCount: managedDepartments.length,
        managedDepartments,
      };
    }

    const hireDate = await resolveSelfHireDate(ctx.trx, ctx.orgId, emp.id);
    const managerProfiles =
      emp.department_manager_user_id !== null
        ? await memberProfiles(ctx.trx, [emp.department_manager_user_id])
        : new Map();
    const departmentManagerName =
      emp.department_manager_user_id !== null
        ? memberLabel(managerProfiles.get(emp.department_manager_user_id))
        : null;

    return {
      linked: true,
      employeeId: emp.id,
      displayName: emp.display_name,
      legalEntityId: emp.legal_entity_id,
      legalEntityName: emp.legal_entity_name ?? null,
      departmentId: emp.department_id,
      departmentName: emp.department_name ?? null,
      departmentManagerName,
      jobTitle: emp.job_title,
      status: emp.status,
      hireDate,
      endedOn: emp.ended_on === null ? null : iso(emp.ended_on),
      managesDepartmentCount: managedDepartments.length,
      managedDepartments,
    };
  },
});

export const selfLeaveBalance = defineQuery({
  name: 'hr.self.leave.balance',
  input: zHrSelfLeaveBalanceAsk,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<HrSelfLeaveBalanceResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) {
      return {
        linked: false,
        employeeId: null,
        year: input.year,
        category: input.category,
        hireDate: null,
        endedOn: null,
        entries: [],
        balance: null,
      };
    }
    const hireDate = await resolveSelfHireDate(ctx.trx, ctx.orgId, emp.id);
    const endedOn = emp.ended_on === null ? null : iso(emp.ended_on);
    const rows = await ctx.trx
      .selectFrom('ludy_hr.payroll_leave_entry')
      .select(['id', 'employee_id', 'month', 'kind', 'days', 'approved'])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', emp.id)
      .where('month', '>=', `${input.year}-01`)
      .where('month', '<=', `${input.year}-12`)
      .orderBy('month', 'asc')
      .orderBy('kind', 'asc')
      .orderBy('id', 'asc')
      .execute();
    const entries: HrLeaveEntryView[] = rows.map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      month: r.month,
      kind: r.kind,
      days: toMoney(money(r.days)),
      approved: r.approved,
    }));
    if (hireDate === null) {
      return {
        linked: true,
        employeeId: emp.id,
        year: input.year,
        category: input.category,
        hireDate: null,
        endedOn,
        entries,
        balance: null,
      };
    }
    const balance = evaluateLeaveBalanceSummary({
      year: input.year,
      category: input.category,
      ...(input.standardAnnualDays !== undefined ? { standardAnnualDays: input.standardAnnualDays } : {}),
      ...(input.asOfMonth !== undefined ? { asOfMonth: input.asOfMonth } : {}),
      ...(input.workweek !== undefined ? { workweek: input.workweek } : {}),
      hireDate,
      endedOn,
      entries,
    });
    return {
      linked: true,
      employeeId: emp.id,
      year: input.year,
      category: input.category,
      hireDate,
      endedOn,
      entries,
      balance,
    };
  },
});

export const selfLeaveRequests = defineQuery({
  name: 'hr.self.leave.requests',
  input: zHrSelfLeaveRequestList,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<HrLeaveRequestView[]> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    const managedRows = await ctx.trx
      .selectFrom('ludy_hr.department')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('manager_user_id', '=', callerUserId)
      .where('archived_at', 'is', null)
      .execute();
    const managedDeptIds = managedRows.map((d) => d.id);
    const callerEmpId = emp?.id ?? null;

    if (input.scope === 'mine' && callerEmpId === null) return [];
    if (input.scope === 'team' && managedDeptIds.length === 0) return [];
    if (input.scope === 'all' && callerEmpId === null && managedDeptIds.length === 0) return [];

    let q = ctx.trx
      .selectFrom('ludy_hr.leave_request as r')
      .leftJoin('ludy_hr.department as d', (j) => j.onRef('d.org_id', '=', 'r.org_id').onRef('d.id', '=', 'r.department_id'))
      .select([
        'r.id',
        'r.legal_entity_id',
        'r.employee_id',
        sql<string | null>`ludy_hr.leave_request_employee_name(r.org_id, r.id)`.as('employee_name'),
        'r.department_id',
        'd.name as department_name',
        'r.month',
        'r.start_on',
        'r.end_on',
        'r.kind',
        'r.days',
        'r.status',
        'r.reason',
        'r.decision_note',
        'r.l1_approver_user_id',
        'r.l1_acted_at',
        'r.final_acted_by',
        'r.final_acted_at',
        'r.payroll_leave_entry_id',
        'r.created_at',
        'r.updated_at',
      ])
      .where('r.org_id', '=', ctx.orgId);

    if (input.scope === 'mine') {
      q = q.where('r.employee_id', '=', callerEmpId!);
    } else if (input.scope === 'team') {
      q = q.where('r.department_id', 'in', managedDeptIds);
    } else {
      q = q.where((eb) => {
        const parts = [];
        if (callerEmpId !== null) parts.push(eb('r.employee_id', '=', callerEmpId));
        if (managedDeptIds.length > 0) parts.push(eb('r.department_id', 'in', managedDeptIds));
        return eb.or(parts);
      });
    }

    if (input.status !== undefined) q = q.where('r.status', '=', input.status);
    if (input.year !== undefined) {
      q = q.where('r.month', '>=', `${input.year}-01`).where('r.month', '<=', `${input.year}-12`);
    }

    const rows = await q
      .orderBy(sql`CASE WHEN r.status IN ('pending_l1', 'pending_final') THEN 0 ELSE 1 END`, 'asc')
      .orderBy('r.created_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(input.limit)
      .execute();

    return hydrateLeaveRequestViews(ctx.trx, rows as LeaveRequestRawRow[]);
  },
});

export const selfLeaveRequestSubmit = defineCommand({
  name: 'hr.self.leave.request_submit',
  input: zHrSelfLeaveRequestSubmit,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'leave_request', [
      'org_id',
      'legal_entity_id',
      'employee_id',
      'department_id',
      'month',
      'start_on',
      'end_on',
      'kind',
      'days',
      'status',
      'reason',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrSelfLeaveSubmitResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();
    if (emp.status !== 'active') {
      throw new DomainError('HR_EMPLOYEE_ENDED', 409, 'Nhân viên này đã nghỉ việc, không thể gửi đơn xin nghỉ mới');
    }

    const month = input.startOn.slice(0, 7);
    if (input.endOn.slice(0, 7) !== month) {
      throw new DomainError('HR_LEAVE_REQUEST_MULTI_MONTH', 422, 'Đơn xin nghỉ chỉ áp dụng trong cùng một tháng');
    }

    const days = money(input.days);
    if (!days.greaterThan('0')) {
      throw new DomainError('HR_LEAVE_DAYS_OUT_OF_RANGE', 422, 'Số ngày nghỉ phải lớn hơn 0');
    }

    const spanDays = Math.round((parseIsoDayUtc(input.endOn) - parseIsoDayUtc(input.startOn)) / 86_400_000) + 1;
    if (days.greaterThan(String(spanDays))) {
      throw new DomainError(
        'HR_LEAVE_REQUEST_DAYS_EXCEED_SPAN',
        422,
        `Số ngày nghỉ (${input.days}) không được vượt quá ${spanDays} ngày trong khoảng đã chọn`,
      );
    }

    const hireDate = await resolveSelfHireDate(ctx.trx, ctx.orgId, emp.id);
    const storedDays = validateMonthlyLeaveBounds({
      month,
      kind: input.kind,
      days,
      hireDate,
      endedOn: emp.ended_on,
    });

    let initialStatus: 'pending_l1' | 'pending_final' = 'pending_final';
    if (emp.department_id !== null) {
      const dept = await ctx.trx
        .selectFrom('ludy_hr.department')
        .select(['manager_user_id', 'archived_at'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', emp.department_id)
        .executeTakeFirst();
      if (
        dept &&
        dept.archived_at === null &&
        dept.manager_user_id !== null &&
        dept.manager_user_id !== callerUserId
      ) {
        const managerMember = await ctx.trx
          .selectFrom('ludy_kernel.tenant_member')
          .select('role')
          .where('org_id', '=', ctx.orgId)
          .where('user_id', '=', dept.manager_user_id)
          .executeTakeFirst();
        if (managerMember && managerMember.role !== 'viewer') {
          initialStatus = 'pending_l1';
        }
      }
    }

    let overlapCount = 0;
    if (emp.department_id !== null) {
      const { rows } = await sql<{ n: number }>`
        SELECT ludy_hr.dept_overlap_leave_count(
          ${ctx.orgId}::uuid,
          ${emp.department_id}::uuid,
          ${emp.id}::uuid,
          ${input.startOn}::date,
          ${input.endOn}::date
        ) AS n
      `.execute(ctx.trx);
      overlapCount = Number(rows[0]?.n ?? 0);
    }

    const saved = await ctx.trx
      .insertInto('ludy_hr.leave_request')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: emp.legal_entity_id,
        employee_id: emp.id,
        department_id: emp.department_id,
        month,
        start_on: input.startOn,
        end_on: input.endOn,
        kind: input.kind,
        days: storedDays,
        status: initialStatus,
        reason: input.reason ?? null,
        created_by: callerUserId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    ctx.audit({
      requestId: saved.id,
      employeeId: emp.id,
      month,
      kind: input.kind,
      status: initialStatus,
      overlapCount,
      ...(input.reason !== undefined ? { reason: auditValue(LEAVE_REQUEST, 'reason', input.reason) } : {}),
    });

    return {
      requestId: saved.id,
      status: initialStatus,
      overlapCount,
    };
  },
});

export const selfLeaveRequestCancel = defineCommand({
  name: 'hr.self.leave.request_cancel',
  input: zHrLeaveRequestRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.leave_request', id: input.requestId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'leave_request', ['status', 'updated_at'])],
  handler: async (ctx, input): Promise<HrLeaveRequestActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();

    // Plain SELECT first so UPDATE RLS on status/self-ownership does not mask 403/409 errors as 404.
    const existing = await ctx.trx
      .selectFrom('ludy_hr.leave_request')
      .select(['id', 'employee_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!existing || existing.employee_id !== emp.id) throw requestNotFound();
    if (existing.status !== 'pending_l1' && existing.status !== 'pending_final') {
      throw invalidState('Chỉ hủy được đơn xin nghỉ đang chờ duyệt');
    }

    const updated = await ctx.trx
      .updateTable('ludy_hr.leave_request')
      .set({ status: 'cancelled', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .where('status', 'in', ['pending_l1', 'pending_final'])
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw invalidState('Chỉ hủy được đơn xin nghỉ đang chờ duyệt');

    ctx.audit({
      requestId: existing.id,
      employeeId: existing.employee_id,
      fromStatus: existing.status,
      toStatus: 'cancelled',
    });

    return {
      requestId: existing.id,
      status: 'cancelled',
      payrollLeaveEntryId: null,
    };
  },
});

export const selfPayslipsList = defineQuery({
  name: 'hr.self.payslips.list',
  input: zHrSelfPayslipsList,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<HrSelfPayslipSummary[]> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) return [];

    const rows = await ctx.trx
      .selectFrom('ludy_hr.payroll_line as l')
      .innerJoin('ludy_hr.payroll_run as r', (j) => j.onRef('r.org_id', '=', 'l.org_id').onRef('r.id', '=', 'l.run_id'))
      .select(['l.id as line_id', 'r.id as run_id', 'r.month', 'r.status', 'l.gross', 'l.net', 'r.approved_at'])
      .where('l.org_id', '=', ctx.orgId)
      .where('l.employee_id', '=', emp.id)
      .where('l.kind', '=', 'pay')
      .where('l.status', '=', 'calculated')
      .where('r.status', 'in', ['approved', 'paid', 'closed'])
      .orderBy('r.month', 'desc')
      .orderBy('l.id', 'desc')
      .limit(input.limit)
      .execute();

    return rows.map((r) => ({
      lineId: r.line_id,
      runId: r.run_id,
      month: r.month,
      status: r.status,
      gross: r.gross ?? '0',
      net: r.net ?? '0',
      approvedAt: r.approved_at === null ? null : new Date(r.approved_at).toISOString(),
    }));
  },
});

export const selfPayslipGet = defineQuery({
  name: 'hr.self.payslip.get',
  input: zHrPayslipRef,
  access: STAFF_ROLES,
  sensitive: true,
  target: (input: { lineId: string }) => ({ type: 'hr.payroll_line', id: input.lineId }),
  handler: async (ctx, input): Promise<HrPayslip> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();

    const line = await ctx.trx
      .selectFrom('ludy_hr.payroll_line')
      .select([...LINE_COLUMNS, 'run_id', 'breakdown'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.lineId)
      .where('employee_id', '=', emp.id)
      .executeTakeFirst();
    if (!line) throw new DomainError('HR_LINE_NOT_FOUND', 404, 'Không tìm thấy phiếu lương này');
    if (line.kind !== 'pay' || line.status !== 'calculated' || line.breakdown === null) {
      throw new DomainError('HR_NO_PAYSLIP', 422, 'Dòng này chưa có phiếu lương');
    }

    const run = await ctx.trx
      .selectFrom('ludy_hr.payroll_run')
      .select(['id', 'legal_entity_id', 'month', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', line.run_id)
      .where('status', 'in', ['approved', 'paid', 'closed'])
      .executeTakeFirst();
    if (!run) throw new DomainError('HR_LINE_NOT_FOUND', 404, 'Không tìm thấy phiếu lương đã duyệt này');

    const figures = figuresOfLine(line as StoredLine);
    if (!figures) throw new DomainError('HR_NO_PAYSLIP', 422, 'Dòng này chưa có phiếu lương');

    return {
      lineId: line.id,
      runId: run.id,
      month: run.month,
      status: run.status,
      employerName: await employerName(ctx, run.legal_entity_id),
      employeeName: emp.display_name,
      figures,
      breakdown: line.breakdown as Record<string, unknown>,
      inputs: (line.inputs ?? {}) as Record<string, unknown>,
    };
  },
});

export const leaveRequestList = defineQuery({
  name: 'hr.leave_request.list',
  input: zHrLeaveRequestList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrLeaveRequestView[]> => {
    let q = ctx.trx
      .selectFrom('ludy_hr.leave_request as r')
      .leftJoin('ludy_hr.payroll_employee as e', (j) => j.onRef('e.org_id', '=', 'r.org_id').onRef('e.id', '=', 'r.employee_id'))
      .leftJoin('ludy_hr.department as d', (j) => j.onRef('d.org_id', '=', 'r.org_id').onRef('d.id', '=', 'r.department_id'))
      .select([
        'r.id',
        'r.legal_entity_id',
        'r.employee_id',
        sql<string | null>`CASE WHEN e.erased_at IS NULL THEN e.display_name ELSE NULL END`.as('employee_name'),
        'r.department_id',
        'd.name as department_name',
        'r.month',
        'r.start_on',
        'r.end_on',
        'r.kind',
        'r.days',
        'r.status',
        sql<string | null>`CASE WHEN e.erased_at IS NULL THEN r.reason ELSE NULL END`.as('reason'),
        sql<string | null>`CASE WHEN e.erased_at IS NULL THEN r.decision_note ELSE NULL END`.as('decision_note'),
        'r.l1_approver_user_id',
        'r.l1_acted_at',
        'r.final_acted_by',
        'r.final_acted_at',
        'r.payroll_leave_entry_id',
        'r.created_at',
        'r.updated_at',
      ])
      .where('r.org_id', '=', ctx.orgId);

    if (input.status !== undefined) q = q.where('r.status', '=', input.status);
    if (input.departmentId !== undefined) q = q.where('r.department_id', '=', input.departmentId);
    if (input.legalEntityId !== undefined) q = q.where('r.legal_entity_id', '=', input.legalEntityId);
    if (input.employeeId !== undefined) q = q.where('r.employee_id', '=', input.employeeId);

    const rows = await q
      .orderBy(sql`CASE WHEN r.status IN ('pending_l1', 'pending_final') THEN 0 ELSE 1 END`, 'asc')
      .orderBy('r.created_at', 'desc')
      .orderBy('r.id', 'desc')
      .limit(input.limit)
      .execute();

    return hydrateLeaveRequestViews(ctx.trx, rows as LeaveRequestRawRow[]);
  },
});

export async function assertNotSelfApprover(
  trx: QueryContext['trx'],
  orgId: string,
  callerUserId: string,
  role: MemberRole,
  employeeId: string,
  allowSoleOwner: boolean,
): Promise<boolean> {
  const callerEmp = await resolveSelfEmployee(trx, orgId, callerUserId);
  if (!callerEmp || callerEmp.id !== employeeId) return false;
  if (!allowSoleOwner || role !== 'owner') {
    throw selfApprovalBlocked();
  }
  const otherApprover = await trx
    .selectFrom('ludy_kernel.tenant_member')
    .select('user_id')
    .where('org_id', '=', orgId)
    .where('user_id', '!=', callerUserId)
    .where('role', 'in', ['owner', 'admin'])
    .limit(1)
    .executeTakeFirst();
  if (otherApprover) {
    throw selfApprovalBlocked();
  }
  return true;
}

export async function assertL1Authority(
  trx: QueryContext['trx'],
  orgId: string,
  callerUserId: string,
  req: { employee_id: string; department_id: string | null },
): Promise<'owner' | 'admin' | 'member'> {
  const member = await trx
    .selectFrom('ludy_kernel.tenant_member')
    .select('role')
    .where('org_id', '=', orgId)
    .where('user_id', '=', callerUserId)
    .executeTakeFirstOrThrow();
  const role = member.role as MemberRole;
  if (role === 'viewer') {
    throw new DomainError('FORBIDDEN', 403, 'Người xem (viewer) không có quyền duyệt đơn nghỉ phép');
  }
  await assertNotSelfApprover(trx, orgId, callerUserId, role, req.employee_id, false);
  if (role === 'owner' || role === 'admin') {
    return role;
  }
  if (req.department_id === null) {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ quản lý phòng ban được phân công hoặc quản trị viên mới duyệt được đơn này');
  }
  const dept = await trx
    .selectFrom('ludy_hr.department')
    .select(['manager_user_id', 'archived_at'])
    .where('org_id', '=', orgId)
    .where('id', '=', req.department_id)
    .executeTakeFirst();
  if (!dept || dept.archived_at !== null || dept.manager_user_id !== callerUserId) {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ quản lý phòng ban được phân công hoặc quản trị viên mới duyệt được đơn này');
  }
  return role;
}

async function assertEmployeeNotErasedForLeaveRequest(
  trx: QueryContext['trx'],
  orgId: string,
  role: MemberRole,
  employeeId: string,
  requestId: string,
): Promise<void> {
  if (role === 'owner' || role === 'admin') {
    await loadEmployeeForLeave(trx, orgId, employeeId, true);
    return;
  }
  // L1 department managers (role = 'member') cannot SELECT another employee's payroll_employee row under RLS;
  // ludy_hr.leave_request_employee_name verifies manager access and returns NULL iff e.erased_at IS NOT NULL.
  const { rows } = await sql<{ name: string | null }>`
    SELECT ludy_hr.leave_request_employee_name(${orgId}::uuid, ${requestId}::uuid) AS name
  `.execute(trx);
  if (rows[0]?.name == null) {
    throw erasedError();
  }
}

async function transitionLeaveRequestGuarded(
  trx: QueryContext['trx'],
  opts: {
    orgId: string;
    callerUserId: string;
    role: MemberRole;
    employeeId: string;
    departmentId: string | null;
    requestId: string;
    allowedStatuses: readonly ('pending_l1' | 'pending_final')[];
    currentStatus: 'pending_l1' | 'pending_final' | 'approved' | 'rejected' | 'cancelled';
    invalidStateMessage: string;
    values: {
      status: 'pending_final' | 'rejected';
      l1_approver_user_id?: string;
      l1_acted_at?: Date;
      final_acted_by?: string;
      final_acted_at?: Date;
      decision_note?: string;
      updated_at: Date;
    };
  },
): Promise<void> {
  await assertEmployeeNotErasedForLeaveRequest(trx, opts.orgId, opts.role, opts.employeeId, opts.requestId);
  if (!opts.allowedStatuses.includes(opts.currentStatus as 'pending_l1' | 'pending_final')) {
    throw invalidState(opts.invalidStateMessage);
  }
  const updated = await trx
    .updateTable('ludy_hr.leave_request')
    .set(opts.values)
    .where('org_id', '=', opts.orgId)
    .where('id', '=', opts.requestId)
    .where('status', 'in', [...opts.allowedStatuses])
    .where(sql<boolean>`ludy_hr.leave_request_employee_name(org_id, id) IS NOT NULL`)
    .returning('id')
    .executeTakeFirst();
  if (!updated) {
    if (opts.role !== 'owner' && opts.role !== 'admin') {
      await assertL1Authority(trx, opts.orgId, opts.callerUserId, {
        employee_id: opts.employeeId,
        department_id: opts.departmentId,
      });
    }
    await assertEmployeeNotErasedForLeaveRequest(trx, opts.orgId, opts.role, opts.employeeId, opts.requestId);
    throw invalidState(opts.invalidStateMessage);
  }
}

export const leaveRequestApproveL1 = defineCommand({
  name: 'hr.leave_request.approve_l1',
  input: zHrLeaveRequestDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.leave_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'leave_request', [
      'status',
      'l1_approver_user_id',
      'l1_acted_at',
      'decision_note',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrLeaveRequestActionResult> => {
    const callerUserId = userOf(ctx.actor);
    // Plain SELECT first so L1 UPDATE RLS does not mask 403 self-approval or 409 state errors as 404.
    const existing = await ctx.trx
      .selectFrom('ludy_hr.leave_request')
      .select(['id', 'employee_id', 'department_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!existing) throw requestNotFound();

    const role = await assertL1Authority(ctx.trx, ctx.orgId, callerUserId, existing);
    await transitionLeaveRequestGuarded(ctx.trx, {
      orgId: ctx.orgId,
      callerUserId,
      role,
      employeeId: existing.employee_id,
      departmentId: existing.department_id,
      requestId: existing.id,
      allowedStatuses: ['pending_l1'],
      currentStatus: existing.status,
      invalidStateMessage: 'Đơn xin nghỉ không ở trạng thái chờ duyệt bước 1',
      values: {
        status: 'pending_final',
        l1_approver_user_id: callerUserId,
        l1_acted_at: ctx.now,
        ...(input.note !== undefined ? { decision_note: input.note } : {}),
        updated_at: ctx.now,
      },
    });

    const noted = input.note !== undefined;
    ctx.audit({
      requestId: existing.id,
      employeeId: existing.employee_id,
      fromStatus: 'pending_l1',
      toStatus: 'pending_final',
      noted,
    });

    return {
      requestId: existing.id,
      status: 'pending_final',
      payrollLeaveEntryId: null,
    };
  },
});

export const leaveRequestApproveFinal = defineCommand({
  name: 'hr.leave_request.approve_final',
  input: zHrLeaveRequestDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { requestId: string }) => ({ type: 'hr.leave_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_leave_entry', [
      'org_id',
      'legal_entity_id',
      'employee_id',
      'month',
      'kind',
      'days',
      'approved',
      'created_by',
      'created_at',
      'updated_at',
    ]),
    tableWrite(hrManifest.tables, 'ludy_hr', 'leave_request', [
      'status',
      'final_acted_by',
      'final_acted_at',
      'decision_note',
      'payroll_leave_entry_id',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrLeaveRequestActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const member = await ctx.trx
      .selectFrom('ludy_kernel.tenant_member')
      .select('role')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', callerUserId)
      .executeTakeFirstOrThrow();
    const role = member.role as MemberRole;

    // Read employee_id unlocked first, then lock payroll_employee before leave_request and payroll_leave_entry
    // so lock acquisition order always matches leaveSet/leaveDelete (zero 40P01 deadlock risk).
    const preRead = await ctx.trx
      .selectFrom('ludy_hr.leave_request')
      .select(['id', 'employee_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!preRead) throw requestNotFound();
    const selfApproved = await assertNotSelfApprover(ctx.trx, ctx.orgId, callerUserId, role, preRead.employee_id, true);
    const employee = await loadEmployeeForLeave(ctx.trx, ctx.orgId, preRead.employee_id, true);
    if (preRead.status !== 'pending_l1' && preRead.status !== 'pending_final') {
      throw invalidState('Chỉ duyệt chốt được đơn đang chờ duyệt');
    }
    const existing = await ctx.trx
      .selectFrom('ludy_hr.leave_request')
      .select(['id', 'employee_id', 'month', 'kind', 'days', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw requestNotFound();
    if (existing.status !== 'pending_l1' && existing.status !== 'pending_final') {
      throw invalidState('Chỉ duyệt chốt được đơn đang chờ duyệt');
    }

    const firstTerm = await ctx.trx
      .selectFrom('ludy_hr.payroll_employment')
      .select(['effective_from'])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', employee.id)
      .orderBy('effective_from', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (!firstTerm) {
      throw new DomainError('HR_EMPLOYEE_NOT_PAID', 409, 'Nhân viên này chưa có hợp đồng làm việc');
    }

    const priorEntry = await ctx.trx
      .selectFrom('ludy_hr.payroll_leave_entry')
      .select(['id', 'days'])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', employee.id)
      .where('month', '=', existing.month)
      .where('kind', '=', existing.kind)
      .forUpdate()
      .executeTakeFirst();

    const combinedDays = priorEntry ? money(priorEntry.days).plus(money(existing.days)) : money(existing.days);
    const storedDays = validateMonthlyLeaveBounds({
      month: existing.month,
      kind: existing.kind,
      days: combinedDays,
      hireDate: iso(firstTerm.effective_from),
      endedOn: employee.ended_on,
    });

    const savedEntry = await ctx.trx
      .insertInto('ludy_hr.payroll_leave_entry')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: employee.legal_entity_id,
        employee_id: employee.id,
        month: existing.month,
        kind: existing.kind,
        days: storedDays,
        approved: true,
        created_by: callerUserId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'employee_id', 'month', 'kind']).doUpdateSet({
          days: storedDays,
          approved: true,
          updated_at: ctx.now,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();

    await ctx.trx
      .updateTable('ludy_hr.leave_request')
      .set({
        status: 'approved',
        final_acted_by: callerUserId,
        final_acted_at: ctx.now,
        payroll_leave_entry_id: savedEntry.id,
        ...(input.note !== undefined ? { decision_note: input.note } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    const noted = input.note !== undefined;
    ctx.audit({
      requestId: existing.id,
      employeeId: existing.employee_id,
      fromStatus: existing.status,
      toStatus: 'approved',
      payrollLeaveEntryId: savedEntry.id,
      month: existing.month,
      kind: existing.kind,
      noted,
      ...(selfApproved ? { selfApproved: true } : {}),
    });

    return {
      requestId: existing.id,
      status: 'approved',
      payrollLeaveEntryId: savedEntry.id,
    };
  },
});

export const leaveRequestReject = defineCommand({
  name: 'hr.leave_request.reject',
  input: zHrLeaveRequestDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.leave_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'leave_request', [
      'status',
      'l1_approver_user_id',
      'l1_acted_at',
      'final_acted_by',
      'final_acted_at',
      'decision_note',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrLeaveRequestActionResult> => {
    const callerUserId = userOf(ctx.actor);
    // Plain SELECT first so L1 UPDATE RLS does not mask 403 self-approval or 409 state errors as 404.
    const existing = await ctx.trx
      .selectFrom('ludy_hr.leave_request')
      .select(['id', 'employee_id', 'department_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!existing) throw requestNotFound();

    const member = await ctx.trx
      .selectFrom('ludy_kernel.tenant_member')
      .select('role')
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', callerUserId)
      .executeTakeFirstOrThrow();
    const role = member.role as MemberRole;

    let selfApproved = false;
    if (role === 'owner' || role === 'admin') {
      selfApproved = await assertNotSelfApprover(ctx.trx, ctx.orgId, callerUserId, role, existing.employee_id, true);
      await transitionLeaveRequestGuarded(ctx.trx, {
        orgId: ctx.orgId,
        callerUserId,
        role,
        employeeId: existing.employee_id,
        departmentId: existing.department_id,
        requestId: existing.id,
        allowedStatuses: ['pending_l1', 'pending_final'],
        currentStatus: existing.status,
        invalidStateMessage: 'Chỉ từ chối được đơn xin nghỉ đang chờ duyệt',
        values: {
          status: 'rejected',
          final_acted_by: callerUserId,
          final_acted_at: ctx.now,
          ...(input.note !== undefined ? { decision_note: input.note } : {}),
          updated_at: ctx.now,
        },
      });
    } else {
      await assertL1Authority(ctx.trx, ctx.orgId, callerUserId, existing);
      // DB hr_leave_request_update WITH CHECK requires L1 fields (and NULL final fields) when a member L1 manager rejects.
      await transitionLeaveRequestGuarded(ctx.trx, {
        orgId: ctx.orgId,
        callerUserId,
        role,
        employeeId: existing.employee_id,
        departmentId: existing.department_id,
        requestId: existing.id,
        allowedStatuses: ['pending_l1'],
        currentStatus: existing.status,
        invalidStateMessage: 'Quản lý bộ phận chỉ từ chối được đơn đang chờ duyệt bước 1',
        values: {
          status: 'rejected',
          l1_approver_user_id: callerUserId,
          l1_acted_at: ctx.now,
          ...(input.note !== undefined ? { decision_note: input.note } : {}),
          updated_at: ctx.now,
        },
      });
    }

    const noted = input.note !== undefined;
    ctx.audit({
      requestId: existing.id,
      employeeId: existing.employee_id,
      fromStatus: existing.status,
      toStatus: 'rejected',
      noted,
      ...(selfApproved ? { selfApproved: true } : {}),
    });

    return {
      requestId: existing.id,
      status: 'rejected',
      payrollLeaveEntryId: null,
    };
  },
});

export const hrLeaveRequestCommands = [
  selfLeaveRequestSubmit,
  selfLeaveRequestCancel,
  leaveRequestApproveL1,
  leaveRequestApproveFinal,
  leaveRequestReject,
];

export const hrLeaveRequestQueries = [
  selfProfileGet,
  selfLeaveBalance,
  selfLeaveRequests,
  selfPayslipsList,
  selfPayslipGet,
  leaveRequestList,
];

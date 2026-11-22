// SPDX-License-Identifier: AGPL-3.0-only
// HR 2-level overtime (OT) request workflow with DB/server anti-self-approval and payroll rollup (#4448, Stage 5B).
import { sql } from 'kysely';
import {
  auditValue,
  HR_OVERTIME_COMMENTARY_RULES,
  HR_OVERTIME_MONTHLY_CAP_HOURS,
  tableWrite,
  zHrOvertimeDecide,
  zHrOvertimeList,
  zHrOvertimeRef,
  zHrSelfOvertimeList,
  zHrSelfOvertimeSubmit,
  type HrOvertimeActionResult,
  type HrOvertimeDayType,
  type HrOvertimeRequestView,
  type HrOvertimeStatus,
  type HrSelfOvertimeListResult,
  type HrSelfOvertimeSubmitResult,
} from '@ludy/kernel-contract';
import { money } from '@ludy/l10n-vn';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { MANAGERS, userOf } from './employees.ts';
import { assertL1Authority, assertNotSelfApprover, resolveSelfEmployee, selfNotLinked, STAFF_ROLES } from './leave-requests.ts';
import { hrManifest } from './manifest.ts';
import { isoDate as iso } from './payroll-dates.ts';
import { syncEmployeeDraftPayrollOvertime } from './payroll-run.ts';

const OVERTIME = hrManifest.tables.crove_hr.overtime_request;

const otNotFound = () =>
  new DomainError('HR_OVERTIME_NOT_FOUND', 404, 'Không tìm thấy đơn xin làm thêm giờ này');
const invalidOtState = (message: string) =>
  new DomainError('HR_OVERTIME_INVALID_STATE', 409, message);

interface RawOvertimeRow {
  id: string;
  legal_entity_id: string;
  employee_id: string;
  employee_name: string | null;
  department_id: string | null;
  department_name: string | null;
  month: string;
  work_date: Date | string;
  hours: string;
  day_type: HrOvertimeDayType;
  is_night: boolean;
  status: HrOvertimeStatus;
  l1_approver_user_id: string | null;
  l1_acted_at: Date | string | null;
  final_acted_by: string | null;
  final_acted_at: Date | string | null;
  reason: string | null;
  decision_note: string | null;
  created_at: Date | string;
}

function formatHoursString(raw: ReturnType<typeof money>): string {
  const fixed = raw.toDecimalPlaces(2).toFixed();
  return fixed.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function mapOvertimeView(row: RawOvertimeRow): HrOvertimeRequestView {
  const rule = HR_OVERTIME_COMMENTARY_RULES[row.day_type];
  const erased = row.employee_name === null;
  return {
    id: row.id,
    employeeId: row.employee_id,
    employeeName: row.employee_name ?? '',
    legalEntityId: row.legal_entity_id,
    departmentId: row.department_id,
    departmentName: row.department_name,
    month: row.month,
    workDate: iso(row.work_date),
    hours: formatHoursString(money(row.hours)),
    dayType: row.day_type,
    isNight: row.is_night,
    multiplierPercent: rule.multiplierPercent,
    ruleStatus: rule.status,
    ruleId: rule.ruleId,
    status: row.status,
    l1ApproverUserId: row.l1_approver_user_id,
    l1ActedAt: row.l1_acted_at === null ? null : new Date(row.l1_acted_at).toISOString(),
    finalActedBy: row.final_acted_by,
    finalActedAt: row.final_acted_at === null ? null : new Date(row.final_acted_at).toISOString(),
    reason: erased ? null : row.reason,
    decisionNote: erased ? null : row.decision_note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

async function queryOvertimeViews(
  trx: QueryContext['trx'],
  orgId: string,
  filters: {
    employeeId?: string;
    departmentId?: string;
    departmentIds?: readonly string[];
    legalEntityId?: string;
    month?: string;
    status?: HrOvertimeStatus;
    limit: number;
  },
): Promise<HrOvertimeRequestView[]> {
  let q = trx
    .selectFrom('crove_hr.overtime_request as ot')
    .leftJoin('crove_hr.department as d', (j) =>
      j.onRef('d.org_id', '=', 'ot.org_id').onRef('d.id', '=', 'ot.department_id'),
    )
    .select([
      'ot.id',
      'ot.legal_entity_id',
      'ot.employee_id',
      sql<string | null>`crove_hr.overtime_request_employee_name(ot.org_id, ot.id)`.as('employee_name'),
      'ot.department_id',
      'd.name as department_name',
      'ot.month',
      'ot.work_date',
      'ot.hours',
      'ot.day_type',
      'ot.is_night',
      'ot.status',
      'ot.l1_approver_user_id',
      'ot.l1_acted_at',
      'ot.final_acted_by',
      'ot.final_acted_at',
      'ot.reason',
      'ot.decision_note',
      'ot.created_at',
    ])
    .where('ot.org_id', '=', orgId)
    .orderBy('ot.work_date', 'desc')
    .orderBy('ot.created_at', 'desc')
    .orderBy('ot.id', 'desc')
    .limit(filters.limit);

  if (filters.employeeId !== undefined) q = q.where('ot.employee_id', '=', filters.employeeId);
  if (filters.departmentId !== undefined) q = q.where('ot.department_id', '=', filters.departmentId);
  if (filters.departmentIds !== undefined && filters.departmentIds.length > 0) {
    q = q.where('ot.department_id', 'in', [...filters.departmentIds]);
  }
  if (filters.legalEntityId !== undefined) q = q.where('ot.legal_entity_id', '=', filters.legalEntityId);
  if (filters.month !== undefined) q = q.where('ot.month', '=', filters.month);
  if (filters.status !== undefined) q = q.where('ot.status', '=', filters.status);

  const rows = (await q.execute()) as RawOvertimeRow[];
  return rows.map(mapOvertimeView);
}

async function assertEmployeeNotErasedForRequest(
  trx: QueryContext['trx'],
  orgId: string,
  requestId: string,
): Promise<void> {
  const { rows } = await sql<{ name: string | null }>`
    SELECT crove_hr.overtime_request_employee_name(${orgId}::uuid, ${requestId}::uuid) AS name
  `.execute(trx);
  if (!rows[0]?.name) {
    throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã được xóa theo yêu cầu');
  }
}

async function assertEmployeeNotErasedForOvertime(trx: QueryContext['trx'], orgId: string, employeeId: string) {
  const emp = await trx
    .selectFrom('crove_hr.payroll_employee')
    .select(['id', 'erased_at'])
    .where('org_id', '=', orgId)
    .where('id', '=', employeeId)
    .executeTakeFirst();
  if (!emp || emp.erased_at !== null) {
    throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã được xóa theo yêu cầu');
  }
}

export const selfOvertimeSubmit = defineCommand({
  name: 'hr.self.overtime.submit',
  input: zHrSelfOvertimeSubmit,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'overtime_request', [
      'org_id',
      'legal_entity_id',
      'employee_id',
      'department_id',
      'month',
      'work_date',
      'hours',
      'day_type',
      'is_night',
      'status',
      'reason',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrSelfOvertimeSubmitResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();
    await assertEmployeeNotErasedForOvertime(ctx.trx, ctx.orgId, emp.id);
    if (emp.status !== 'active') {
      throw new DomainError('HR_EMPLOYEE_ENDED', 409, 'Nhân viên đã nghỉ việc, không thể gửi đơn làm thêm giờ');
    }

    const month = input.workDate.slice(0, 7);
    const existingRows = await ctx.trx
      .selectFrom('crove_hr.overtime_request')
      .select('hours')
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', emp.id)
      .where('month', '=', month)
      .where('status', 'in', ['pending_l1', 'pending_final', 'approved'])
      .execute();

    let totalHours = money(input.hours);
    for (const row of existingRows) {
      totalHours = totalHours.plus(money(row.hours));
    }

    let initialStatus: 'pending_l1' | 'pending_final' = 'pending_final';
    if (emp.department_id !== null) {
      const dept = await ctx.trx
        .selectFrom('crove_hr.department')
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
          .selectFrom('crove_kernel.tenant_member')
          .select('role')
          .where('org_id', '=', ctx.orgId)
          .where('user_id', '=', dept.manager_user_id)
          .executeTakeFirst();
        if (managerMember && managerMember.role !== 'viewer') {
          initialStatus = 'pending_l1';
        }
      }
    }

    const inserted = await ctx.trx
      .insertInto('crove_hr.overtime_request')
      .values({
        org_id: ctx.orgId,
        employee_id: emp.id,
        department_id: emp.department_id,
        month,
        work_date: input.workDate,
        hours: formatHoursString(money(input.hours)),
        day_type: input.dayType,
        is_night: input.isNight,
        status: initialStatus,
        reason: input.reason ?? null,
        created_by: callerUserId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'legal_entity_id'])
      .executeTakeFirstOrThrow();

    const monthHoursTotal = formatHoursString(totalHours);
    const exceedsMonthlyCap = totalHours.greaterThan(money(HR_OVERTIME_MONTHLY_CAP_HOURS));

    ctx.audit({
      requestId: inserted.id,
      employeeId: emp.id,
      legalEntityId: inserted.legal_entity_id,
      month,
      hours: formatHoursString(money(input.hours)),
      dayType: input.dayType,
      isNight: input.isNight,
      status: initialStatus,
      exceedsMonthlyCap,
      ...(input.reason !== undefined ? { reason: auditValue(OVERTIME, 'reason', input.reason) } : {}),
    });

    return {
      requestId: inserted.id,
      status: initialStatus,
      month,
      monthHoursTotal,
      exceedsMonthlyCap,
    };
  },
});

export const selfOvertimeCancel = defineCommand({
  name: 'hr.self.overtime.cancel',
  input: zHrOvertimeRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.overtime_request', id: input.requestId }),
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'overtime_request', ['status', 'updated_at'])],
  handler: async (ctx, input): Promise<HrOvertimeActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();

    const existing = await ctx.trx
      .selectFrom('crove_hr.overtime_request')
      .select(['id', 'employee_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw otNotFound();
    if (existing.employee_id !== emp.id) {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ nhân viên gửi đơn mới có thể hủy đơn làm thêm giờ này');
    }
    if (existing.status !== 'pending_l1' && existing.status !== 'pending_final') {
      throw invalidOtState('Chỉ hủy được đơn làm thêm giờ đang chờ duyệt');
    }

    await ctx.trx
      .updateTable('crove_hr.overtime_request')
      .set({ status: 'cancelled', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({ requestId: existing.id, employeeId: existing.employee_id });
    return { requestId: existing.id, status: 'cancelled', payrollRunUpdated: false };
  },
});

export const selfOvertimeList = defineQuery({
  name: 'hr.self.overtime.list',
  input: zHrSelfOvertimeList,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<HrSelfOvertimeListResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    const managedRows = await ctx.trx
      .selectFrom('crove_hr.department')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('manager_user_id', '=', callerUserId)
      .where('archived_at', 'is', null)
      .execute();
    const managedDeptIds = managedRows.map((d) => d.id);

    const requests = emp
      ? await queryOvertimeViews(ctx.trx, ctx.orgId, {
          employeeId: emp.id,
          ...(input.month !== undefined ? { month: input.month } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          limit: input.limit,
        })
      : [];

    const teamPending =
      managedDeptIds.length > 0
        ? (
            await queryOvertimeViews(ctx.trx, ctx.orgId, {
              departmentIds: managedDeptIds,
              status: 'pending_l1',
              ...(input.month !== undefined ? { month: input.month } : {}),
              limit: input.limit,
            })
          ).filter((r) => !emp || r.employeeId !== emp.id)
        : [];

    let approvedSum = money(0);
    for (const r of requests) {
      if (r.status === 'approved' && (input.month === undefined || r.month === input.month)) {
        approvedSum = approvedSum.plus(money(r.hours));
      }
    }

    return {
      requests,
      teamPending,
      monthApprovedHours: formatHoursString(approvedSum),
    };
  },
});

export const overtimeList = defineQuery({
  name: 'hr.overtime.list',
  input: zHrOvertimeList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrOvertimeRequestView[]> => {
    userOf(ctx.actor);
    return queryOvertimeViews(ctx.trx, ctx.orgId, {
      ...(input.employeeId !== undefined ? { employeeId: input.employeeId } : {}),
      ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      ...(input.legalEntityId !== undefined ? { legalEntityId: input.legalEntityId } : {}),
      ...(input.month !== undefined ? { month: input.month } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      limit: input.limit,
    });
  },
});

export const overtimeApproveL1 = defineCommand({
  name: 'hr.overtime.approve_l1',
  input: zHrOvertimeDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.overtime_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'overtime_request', [
      'status',
      'l1_approver_user_id',
      'l1_acted_at',
      'decision_note',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrOvertimeActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const role = ctx.role;
    if (!role) throw new DomainError('FORBIDDEN', 403, 'Chưa xác định vai trò trong tổ chức');

    const existing = await ctx.trx
      .selectFrom('crove_hr.overtime_request')
      .select(['id', 'employee_id', 'department_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw otNotFound();

    await assertEmployeeNotErasedForRequest(ctx.trx, ctx.orgId, existing.id);
    const authority = await assertL1Authority(ctx.trx, ctx.orgId, callerUserId, existing);
    if (existing.status !== 'pending_l1') {
      throw invalidOtState('Chỉ duyệt cấp 1 được đơn đang ở trạng thái chờ cấp 1');
    }

    await ctx.trx
      .updateTable('crove_hr.overtime_request')
      .set({
        status: 'pending_final',
        l1_approver_user_id: callerUserId,
        l1_acted_at: ctx.now,
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
      authority,
      noted,
    });

    return { requestId: existing.id, status: 'pending_final', payrollRunUpdated: false };
  },
});

export const overtimeApproveFinal = defineCommand({
  name: 'hr.overtime.approve_final',
  input: zHrOvertimeDecide,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { requestId: string }) => ({ type: 'hr.overtime_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'overtime_request', [
      'status',
      'final_acted_by',
      'final_acted_at',
      'decision_note',
      'updated_at',
    ]),
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_line', [
      'employment_id',
      'inputs',
      'status',
      'gross',
      'employee_insurance',
      'employer_insurance',
      'union_fee',
      'taxable_income',
      'pit',
      'net',
      'employer_cost',
      'breakdown',
      'checks',
      'rules_used',
      'refusal',
      'updated_at',
    ]),
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_run', ['updated_at']),
  ],
  handler: async (ctx, input): Promise<HrOvertimeActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const role = ctx.role;
    if (!role) throw new DomainError('FORBIDDEN', 403, 'Chưa xác định vai trò trong tổ chức');

    const preRead = await ctx.trx
      .selectFrom('crove_hr.overtime_request')
      .select(['id', 'employee_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!preRead) throw otNotFound();

    const selfApproved = await assertNotSelfApprover(ctx.trx, ctx.orgId, callerUserId, role, preRead.employee_id, true);
    await assertEmployeeNotErasedForRequest(ctx.trx, ctx.orgId, preRead.id);
    if (preRead.status !== 'pending_l1' && preRead.status !== 'pending_final') {
      throw invalidOtState('Chỉ duyệt chốt được đơn làm thêm giờ đang chờ duyệt');
    }

    const existing = await ctx.trx
      .selectFrom('crove_hr.overtime_request')
      .select(['id', 'legal_entity_id', 'employee_id', 'month', 'hours', 'day_type', 'is_night', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw otNotFound();
    if (existing.status !== 'pending_l1' && existing.status !== 'pending_final') {
      throw invalidOtState('Chỉ duyệt chốt được đơn làm thêm giờ đang chờ duyệt');
    }

    await ctx.trx
      .updateTable('crove_hr.overtime_request')
      .set({
        status: 'approved',
        final_acted_by: callerUserId,
        final_acted_at: ctx.now,
        ...(input.note !== undefined ? { decision_note: input.note } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    const payrollRunUpdated = await syncEmployeeDraftPayrollOvertime(
      ctx,
      existing.legal_entity_id,
      existing.month,
      existing.employee_id,
    );

    const noted = input.note !== undefined;
    ctx.audit({
      requestId: existing.id,
      employeeId: existing.employee_id,
      month: existing.month,
      hours: formatHoursString(money(existing.hours)),
      dayType: existing.day_type,
      isNight: existing.is_night,
      selfApproved,
      payrollRunUpdated,
      noted,
    });

    return { requestId: existing.id, status: 'approved', payrollRunUpdated };
  },
});

export const overtimeReject = defineCommand({
  name: 'hr.overtime.reject',
  input: zHrOvertimeDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.overtime_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'overtime_request', [
      'status',
      'l1_approver_user_id',
      'l1_acted_at',
      'final_acted_by',
      'final_acted_at',
      'decision_note',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrOvertimeActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const role = ctx.role;
    if (!role) throw new DomainError('FORBIDDEN', 403, 'Chưa xác định vai trò trong tổ chức');

    const existing = await ctx.trx
      .selectFrom('crove_hr.overtime_request')
      .select(['id', 'employee_id', 'department_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) throw otNotFound();

    await assertEmployeeNotErasedForRequest(ctx.trx, ctx.orgId, existing.id);
    if (existing.status !== 'pending_l1' && existing.status !== 'pending_final') {
      throw invalidOtState('Chỉ từ chối được đơn làm thêm giờ đang chờ duyệt');
    }

    let authority: 'l1' | 'owner' | 'admin';
    let selfApproved = false;
    if (existing.status === 'pending_l1') {
      if (role === 'owner' || role === 'admin') {
        selfApproved = await assertNotSelfApprover(ctx.trx, ctx.orgId, callerUserId, role, existing.employee_id, true);
        authority = role;
      } else {
        await assertL1Authority(ctx.trx, ctx.orgId, callerUserId, existing);
        authority = 'l1';
      }
    } else {
      if (role !== 'owner' && role !== 'admin') {
        throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới từ chối được đơn chờ duyệt chính thức');
      }
      selfApproved = await assertNotSelfApprover(ctx.trx, ctx.orgId, callerUserId, role, existing.employee_id, true);
      authority = role;
    }

    const patch =
      authority === 'l1'
        ? {
            status: 'rejected' as const,
            l1_approver_user_id: callerUserId,
            l1_acted_at: ctx.now,
            ...(input.note !== undefined ? { decision_note: input.note } : {}),
            updated_at: ctx.now,
          }
        : {
            status: 'rejected' as const,
            final_acted_by: callerUserId,
            final_acted_at: ctx.now,
            ...(input.note !== undefined ? { decision_note: input.note } : {}),
            updated_at: ctx.now,
          };

    await ctx.trx
      .updateTable('crove_hr.overtime_request')
      .set(patch)
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    const noted = input.note !== undefined;
    ctx.audit({
      requestId: existing.id,
      employeeId: existing.employee_id,
      authority,
      selfApproved,
      noted,
    });

    return { requestId: existing.id, status: 'rejected', payrollRunUpdated: false };
  },
});

export const hrOvertimeCommands = [
  selfOvertimeSubmit,
  selfOvertimeCancel,
  overtimeApproveL1,
  overtimeApproveFinal,
  overtimeReject,
];

export const hrOvertimeQueries = [
  selfOvertimeList,
  overtimeList,
];

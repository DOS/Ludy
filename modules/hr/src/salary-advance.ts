// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 6B salary advance 2-level workflow with payroll draft rollup (#4527).
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  HR_ERASED_NAME,
  tableWrite,
  zHrAdvanceDecide,
  zHrAdvanceList,
  zHrAdvanceRef,
  zHrSelfAdvanceList,
  zHrSelfAdvanceSubmit,
  type HrAdvanceActionResult,
  type HrAdvanceRequestView,
  type HrSelfAdvanceListResult,
  type HrSelfAdvanceSubmitResult,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { MANAGERS, lockEmployeeErasure, userOf } from './employees.ts';
import { resolveSelfEmployee, selfNotLinked, STAFF_ROLES } from './leave-requests.ts';
import { hrManifest } from './manifest.ts';
import { LINE_UPDATE_COLUMNS, lockOvertimeRun, syncEmployeeDraftPayrollStage6b } from './payroll-run.ts';
import {
  assertDraftOrNoPayrollRun,
  assertStage6bL1Authority,
  assertStage6bNotSelfApprover,
  assertStage6bRejectAuthority,
  isSoleOwnerOrg,
  isoTimestamp,
  loadActiveEmployeeStatus,
  loadDepartmentNameMap,
  loadManagedDepartmentSet,
  normalizeStage6bMoney,
  requireStage6bRole,
  resolveTwoLevelInitialStatus,
} from './stage6b-shared.ts';

const advanceNotFound = () =>
  new DomainError('HR_SALARY_ADVANCE_NOT_FOUND', 404, 'Không tìm thấy đơn tạm ứng lương này');
const invalidAdvanceState = (msg: string) =>
  new DomainError('HR_SALARY_ADVANCE_INVALID_STATE', 409, msg);

interface RawAdvanceRow {
  id: string;
  legal_entity_id: string;
  employee_id: string;
  employee_name: string | null;
  department_id: string | null;
  department_name: string | null;
  month: string;
  amount: string;
  reason: string | null;
  status: HrAdvanceRequestView['status'];
  l1_approver_user_id: string | null;
  l1_acted_at: Date | string | null;
  final_acted_by: string | null;
  final_acted_at: Date | string | null;
  decision_note: string | null;
  payroll_run_id: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapAdvanceView(
  row: RawAdvanceRow,
  ctx: {
    callerUserId: string;
    callerRole: MemberRole;
    callerEmployeeId: string | null;
    managedDeptIds: ReadonlySet<string>;
    soleOwnerOpc: boolean;
  },
): HrAdvanceRequestView {
  const isOwnerOrAdmin = ctx.callerRole === 'owner' || ctx.callerRole === 'admin';
  const isSelf = ctx.callerEmployeeId === row.employee_id || (row.created_by !== null && row.created_by === ctx.callerUserId);
  const isActiveDeptMgr = row.department_id !== null && ctx.managedDeptIds.has(row.department_id);
  const isPending = row.status === 'pending_l1' || row.status === 'pending_final';
  return {
    id: row.id,
    legalEntityId: row.legal_entity_id,
    employeeId: row.employee_id,
    employeeName: row.employee_name ?? HR_ERASED_NAME,
    departmentId: row.department_id,
    departmentName: row.department_name,
    month: row.month,
    amount: normalizeStage6bMoney(row.amount),
    reason: row.reason,
    status: row.status,
    l1ApproverUserId: row.l1_approver_user_id,
    l1ActedAt: isoTimestamp(row.l1_acted_at),
    finalActedBy: row.final_acted_by,
    finalActedAt: isoTimestamp(row.final_acted_at),
    decisionNote: row.decision_note,
    payrollRunId: row.payroll_run_id,
    createdAt: isoTimestamp(row.created_at) ?? new Date().toISOString(),
    updatedAt: isoTimestamp(row.updated_at) ?? new Date().toISOString(),
    canApproveL1: row.status === 'pending_l1' && (!isSelf || ctx.soleOwnerOpc) && (isActiveDeptMgr || isOwnerOrAdmin),
    canApproveFinal: row.status === 'pending_final' && isOwnerOrAdmin && (!isSelf || ctx.soleOwnerOpc),
    canCancel: isPending && (ctx.callerEmployeeId === row.employee_id || isOwnerOrAdmin),
  };
}

export const selfSalaryAdvanceSubmit = defineCommand({
  name: 'hr.self.salary_advance.submit',
  input: zHrSelfAdvanceSubmit,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'salary_advance_request', [
      'id', 'legal_entity_id', 'employee_id', 'department_id', 'month', 'amount', 'reason', 'status', 'created_by', 'created_at', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrSelfAdvanceSubmitResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();

    await lockOvertimeRun(ctx.trx, ctx.orgId, emp.legal_entity_id, input.month);
    await lockEmployeeErasure(ctx.trx, ctx.orgId, emp.id);
    const record = await loadActiveEmployeeStatus(ctx.trx, ctx.orgId, emp.id);
    if (!record || record.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã được xóa theo yêu cầu');
    }
    if (record.status !== 'active') {
      throw new DomainError('HR_EMPLOYEE_ENDED', 409, 'Nhân viên đã nghỉ việc, không thể gửi đơn tạm ứng lương');
    }
    await assertDraftOrNoPayrollRun(ctx.trx, ctx.orgId, record.legal_entity_id, input.month);

    const initialStatus = await resolveTwoLevelInitialStatus(ctx.trx, ctx.orgId, record.department_id, callerUserId);
    const amount = normalizeStage6bMoney(input.amount);
    const inserted = await ctx.trx
      .insertInto('ludy_hr.salary_advance_request')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: record.legal_entity_id,
        employee_id: emp.id,
        department_id: record.department_id,
        month: input.month,
        amount,
        reason: input.reason,
        status: initialStatus,
        created_by: callerUserId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();

    ctx.audit({
      requestId: inserted.id,
      employeeId: emp.id,
      month: input.month,
      status: inserted.status,
    });
    return { requestId: inserted.id, status: inserted.status };
  },
});

export const selfSalaryAdvanceCancel = defineCommand({
  name: 'hr.self.salary_advance.cancel',
  input: zHrAdvanceRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.salary_advance_request', id: input.requestId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'salary_advance_request', ['status', 'updated_at'])],
  handler: async (ctx, input): Promise<HrAdvanceActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();

    await lockEmployeeErasure(ctx.trx, ctx.orgId, emp.id);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.salary_advance_request')
      .select(['id', 'employee_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .where('employee_id', '=', emp.id)
      .executeTakeFirst();
    if (!existing) throw advanceNotFound();
    if (existing.status !== 'pending_l1' && existing.status !== 'pending_final') {
      throw invalidAdvanceState('Chỉ hủy được đơn tạm ứng đang chờ duyệt');
    }

    const updated = await ctx.trx
      .updateTable('ludy_hr.salary_advance_request')
      .set({ status: 'cancelled', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .where('employee_id', '=', emp.id)
      .where('status', 'in', ['pending_l1', 'pending_final'])
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw invalidAdvanceState('Trạng thái đơn tạm ứng đã thay đổi, vui lòng thử lại');

    ctx.audit({ requestId: input.requestId, employeeId: emp.id, status: 'cancelled' });
    return { requestId: input.requestId, status: 'cancelled' };
  },
});

export const selfSalaryAdvanceList = defineQuery({
  name: 'hr.self.salary_advance.list',
  input: zHrSelfAdvanceList,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<HrSelfAdvanceListResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    const role = requireStage6bRole(ctx.role);
    const soleOwnerOpc = await isSoleOwnerOrg(ctx.trx, ctx.orgId, callerUserId, role);
    const managedDepts = await loadManagedDepartmentSet(ctx.trx, ctx.orgId, callerUserId);
    const managedDeptIds = new Set(managedDepts.map((d) => d.id));

    let items: HrAdvanceRequestView[] = [];
    if (emp) {
      let q = ctx.trx
        .selectFrom('ludy_hr.salary_advance_request as r')
        .leftJoin('ludy_hr.department as d', (j) => j.onRef('d.org_id', '=', 'r.org_id').onRef('d.id', '=', 'r.department_id'))
        .select([
          'r.id', 'r.legal_entity_id', 'r.employee_id',
          'r.department_id', 'd.name as department_name', 'r.month', 'r.amount', 'r.reason', 'r.status',
          'r.l1_approver_user_id', 'r.l1_acted_at', 'r.final_acted_by', 'r.final_acted_at',
          'r.decision_note', 'r.payroll_run_id', 'r.created_by', 'r.created_at', 'r.updated_at',
        ])
        .where('r.org_id', '=', ctx.orgId)
        .where('r.employee_id', '=', emp.id);
      if (input.status) q = q.where('r.status', '=', input.status);
      if (input.month) q = q.where('r.month', '=', input.month);
      const ownRows = await q.orderBy('r.created_at', 'desc').limit(input.limit).execute();

      items = ownRows.map((row) =>
        mapAdvanceView(
          { ...row, employee_name: emp.display_name },
          { callerUserId, callerRole: role, callerEmployeeId: emp.id, managedDeptIds, soleOwnerOpc },
        ),
      );
    }

    let l1Queue: HrAdvanceRequestView[] = [];
    if (managedDepts.length > 0) {
      let l1q = ctx.trx
        .selectFrom('ludy_hr.salary_advance_request as r')
        .leftJoin('ludy_hr.department as d', (j) => j.onRef('d.org_id', '=', 'r.org_id').onRef('d.id', '=', 'r.department_id'))
        .select([
          'r.id', 'r.legal_entity_id', 'r.employee_id',
          sql<string | null>`ludy_hr.hr_stage6b_request_employee_name(r.org_id, 'salary_advance', r.id)`.as('employee_name'),
          'r.department_id', 'd.name as department_name', 'r.month', 'r.amount', 'r.reason', 'r.status',
          'r.l1_approver_user_id', 'r.l1_acted_at', 'r.final_acted_by', 'r.final_acted_at',
          'r.decision_note', 'r.payroll_run_id', 'r.created_by', 'r.created_at', 'r.updated_at',
        ])
        .where('r.org_id', '=', ctx.orgId)
        .where('r.status', '=', 'pending_l1')
        .where('r.department_id', 'in', [...managedDeptIds]);
      if (emp) l1q = l1q.where('r.employee_id', '!=', emp.id);
      if (input.month) l1q = l1q.where('r.month', '=', input.month);
      const l1Rows = await l1q.orderBy('r.created_at', 'asc').limit(input.limit).execute();
      l1Queue = l1Rows.map((row) =>
        mapAdvanceView(row, { callerUserId, callerRole: role, callerEmployeeId: emp?.id ?? null, managedDeptIds, soleOwnerOpc }),
      );
    }

    return {
      employeeId: emp?.id ?? null,
      employeeName: emp?.display_name ?? null,
      departmentId: emp?.department_id ?? null,
      items,
      l1Queue,
    };
  },
});

export const salaryAdvanceList = defineQuery({
  name: 'hr.salary_advance.list',
  input: zHrAdvanceList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrAdvanceRequestView[]> => {
    const callerUserId = userOf(ctx.actor);
    const role = requireStage6bRole(ctx.role);
    const soleOwnerOpc = await isSoleOwnerOrg(ctx.trx, ctx.orgId, callerUserId, role);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    const managedDepts = await loadManagedDepartmentSet(ctx.trx, ctx.orgId, callerUserId);
    const managedDeptIds = new Set(managedDepts.map((d) => d.id));

    let q = ctx.trx
      .selectFrom('ludy_hr.salary_advance_request as r')
      .leftJoin('ludy_hr.payroll_employee as e', (j) => j.onRef('e.org_id', '=', 'r.org_id').onRef('e.id', '=', 'r.employee_id'))
      .leftJoin('ludy_hr.department as d', (j) => j.onRef('d.org_id', '=', 'r.org_id').onRef('d.id', '=', 'r.department_id'))
      .select([
        'r.id', 'r.legal_entity_id', 'r.employee_id', 'e.display_name as employee_name',
        'r.department_id', 'd.name as department_name', 'r.month', 'r.amount', 'r.reason', 'r.status',
        'r.l1_approver_user_id', 'r.l1_acted_at', 'r.final_acted_by', 'r.final_acted_at',
        'r.decision_note', 'r.payroll_run_id', 'r.created_by', 'r.created_at', 'r.updated_at',
      ])
      .where('r.org_id', '=', ctx.orgId);
    if (input.legalEntityId) q = q.where('r.legal_entity_id', '=', input.legalEntityId);
    if (input.status) q = q.where('r.status', '=', input.status);
    if (input.month) q = q.where('r.month', '=', input.month);
    const rows = await q.orderBy('r.created_at', 'desc').limit(input.limit).execute();

    // Filter L1 flags accurately when department still has another active manager.
    const deptMeta = await loadDepartmentNameMap(
      ctx.trx,
      ctx.orgId,
      [...new Set(rows.map((r) => r.department_id).filter((v): v is string => v !== null))],
    );
    return rows.map((row) => {
      const view = mapAdvanceView(row, {
        callerUserId,
        callerRole: role,
        callerEmployeeId: emp?.id ?? null,
        managedDeptIds,
        soleOwnerOpc,
      });
      const dept = row.department_id ? deptMeta.get(row.department_id) : undefined;
      if (dept && dept.active && dept.managerUserId && dept.managerUserId !== callerUserId) {
        view.canApproveL1 = false;
      }
      return view;
    });
  },
});

export const salaryAdvanceApproveL1 = defineCommand({
  name: 'hr.salary_advance.approve_l1',
  input: zHrAdvanceDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.salary_advance_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'salary_advance_request', [
      'status', 'l1_approver_user_id', 'l1_acted_at', 'decision_note', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrAdvanceActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const preRead = await ctx.trx
      .selectFrom('ludy_hr.salary_advance_request')
      .select(['id', 'legal_entity_id', 'employee_id', 'month'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!preRead) throw advanceNotFound();

    await lockOvertimeRun(ctx.trx, ctx.orgId, preRead.legal_entity_id, preRead.month);
    await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.salary_advance_request')
      .select(['id', 'legal_entity_id', 'employee_id', 'department_id', 'month', 'status', 'created_by'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!existing) throw advanceNotFound();
    if (existing.status !== 'pending_l1') {
      throw invalidAdvanceState('Đơn tạm ứng không ở trạng thái chờ duyệt cấp 1');
    }
    await assertDraftOrNoPayrollRun(ctx.trx, ctx.orgId, existing.legal_entity_id, existing.month);

    const { role, selfApproved } = await assertStage6bL1Authority(ctx.trx, ctx.orgId, callerUserId, existing);
    const updated = await ctx.trx
      .updateTable('ludy_hr.salary_advance_request')
      .set({
        status: 'pending_final',
        l1_approver_user_id: callerUserId,
        l1_acted_at: ctx.now,
        ...(input.note !== undefined ? { decision_note: input.note } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .where('status', '=', 'pending_l1')
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw invalidAdvanceState('Trạng thái đơn tạm ứng đã thay đổi, vui lòng thử lại');

    ctx.audit({ requestId: input.requestId, employeeId: existing.employee_id, status: 'pending_final', role, selfApproved });
    return { requestId: input.requestId, status: 'pending_final' };
  },
});

export const salaryAdvanceApproveFinal = defineCommand({
  name: 'hr.salary_advance.approve_final',
  input: zHrAdvanceDecide,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { requestId: string }) => ({ type: 'hr.salary_advance_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'salary_advance_request', [
      'status', 'final_acted_by', 'final_acted_at', 'decision_note', 'payroll_run_id', 'updated_at',
    ]),
    tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_adjustment_item', ['payroll_run_id', 'updated_at']),
    tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_line', [...LINE_UPDATE_COLUMNS]),
    tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_run', ['updated_at']),
  ],
  handler: async (ctx, input): Promise<HrAdvanceActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const role = requireStage6bRole(ctx.role);
    const preRead = await ctx.trx
      .selectFrom('ludy_hr.salary_advance_request')
      .select(['id', 'legal_entity_id', 'employee_id', 'month'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!preRead) throw advanceNotFound();

    await lockOvertimeRun(ctx.trx, ctx.orgId, preRead.legal_entity_id, preRead.month);
    await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);

    const existing = await ctx.trx
      .selectFrom('ludy_hr.salary_advance_request')
      .select(['id', 'legal_entity_id', 'employee_id', 'month', 'amount', 'status', 'created_by'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!existing) throw advanceNotFound();
    if (existing.status !== 'pending_final') {
      throw invalidAdvanceState('Đơn tạm ứng phải qua bước chờ duyệt cuối (pending_final)');
    }

    const emp = await loadActiveEmployeeStatus(ctx.trx, ctx.orgId, existing.employee_id);
    if (!emp || emp.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã được xóa theo yêu cầu');
    }
    await assertDraftOrNoPayrollRun(ctx.trx, ctx.orgId, existing.legal_entity_id, existing.month);

    const selfApproved = await assertStage6bNotSelfApprover(
      ctx.trx,
      ctx.orgId,
      callerUserId,
      role,
      existing.employee_id,
      existing.created_by,
      true,
    );

    const updated = await ctx.trx
      .updateTable('ludy_hr.salary_advance_request')
      .set({
        status: 'approved',
        final_acted_by: callerUserId,
        final_acted_at: ctx.now,
        ...(input.note !== undefined ? { decision_note: input.note } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .where('status', '=', 'pending_final')
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw invalidAdvanceState('Trạng thái đơn tạm ứng đã thay đổi, vui lòng thử lại');

    const payrollSynced = await syncEmployeeDraftPayrollStage6b(
      ctx,
      existing.legal_entity_id,
      existing.month,
      existing.employee_id,
    );

    ctx.audit({
      requestId: input.requestId,
      employeeId: existing.employee_id,
      month: existing.month,
      status: 'approved',
      selfApproved,
      payrollSynced,
    });
    return { requestId: input.requestId, status: 'approved', payrollSynced };
  },
});

export const salaryAdvanceReject = defineCommand({
  name: 'hr.salary_advance.reject',
  input: zHrAdvanceDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.salary_advance_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'salary_advance_request', [
      'status', 'l1_approver_user_id', 'l1_acted_at', 'final_acted_by', 'final_acted_at', 'decision_note', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrAdvanceActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const preRead = await ctx.trx
      .selectFrom('ludy_hr.salary_advance_request')
      .select(['id', 'employee_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!preRead) throw advanceNotFound();

    await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.salary_advance_request')
      .select(['id', 'employee_id', 'department_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!existing) throw advanceNotFound();
    if (existing.status !== 'pending_l1' && existing.status !== 'pending_final') {
      throw invalidAdvanceState('Chỉ từ chối được đơn tạm ứng đang chờ duyệt');
    }

    const role = await assertStage6bRejectAuthority(ctx.trx, ctx.orgId, callerUserId, existing);
    const isAdminOrOwner = role === 'owner' || role === 'admin';
    const updated = await ctx.trx
      .updateTable('ludy_hr.salary_advance_request')
      .set({
        status: 'rejected',
        ...(isAdminOrOwner
          ? { final_acted_by: callerUserId, final_acted_at: ctx.now }
          : { l1_approver_user_id: callerUserId, l1_acted_at: ctx.now }),
        ...(input.note !== undefined ? { decision_note: input.note } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .where('status', 'in', ['pending_l1', 'pending_final'])
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw invalidAdvanceState('Trạng thái đơn tạm ứng đã thay đổi, vui lòng thử lại');

    ctx.audit({ requestId: input.requestId, employeeId: existing.employee_id, status: 'rejected' });
    return { requestId: input.requestId, status: 'rejected' };
  },
});

export const hrSalaryAdvanceCommands = [
  selfSalaryAdvanceSubmit,
  selfSalaryAdvanceCancel,
  salaryAdvanceApproveL1,
  salaryAdvanceApproveFinal,
  salaryAdvanceReject,
];
export const hrSalaryAdvanceQueries = [selfSalaryAdvanceList, salaryAdvanceList];

// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 6B retro pay (truy linh) and offset deduction (bu tru) payroll adjustment workflow (#4527).
import {
  HR_ERASED_NAME,
  tableWrite,
  zHrAdjustmentCreate,
  zHrAdjustmentDecide,
  zHrAdjustmentList,
  zHrAdjustmentRef,
  type HrAdjustmentActionResult,
  type HrAdjustmentItemView,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { MANAGERS, lockEmployeeErasure, userOf } from './employees.ts';
import { hrManifest } from './manifest.ts';
import { LINE_UPDATE_COLUMNS, lockOvertimeRun, syncEmployeeDraftPayrollStage6b } from './payroll-run.ts';
import {
  assertDraftOrNoPayrollRun,
  assertStage6bNotSelfApprover,
  isSoleOwnerOrg,
  isoTimestamp,
  loadActiveEmployeeStatus,
  normalizeStage6bMoney,
  requireStage6bRole,
} from './stage6b-shared.ts';

const adjustmentNotFound = () =>
  new DomainError('HR_PAYROLL_ADJUSTMENT_NOT_FOUND', 404, 'Không tìm thấy khoản truy lĩnh hoặc bù trừ này');
const invalidAdjustmentState = (msg: string) =>
  new DomainError('HR_PAYROLL_ADJUSTMENT_INVALID_STATE', 409, msg);

export const adjustmentList = defineQuery({
  name: 'hr.payroll.adjustment.list',
  input: zHrAdjustmentList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrAdjustmentItemView[]> => {
    const callerUserId = userOf(ctx.actor);
    const role = requireStage6bRole(ctx.role);
    let q = ctx.trx
      .selectFrom('ludy_hr.payroll_adjustment_item as a')
      .leftJoin('ludy_hr.payroll_employee as e', (j) => j.onRef('e.org_id', '=', 'a.org_id').onRef('e.id', '=', 'a.employee_id'))
      .select([
        'a.id', 'a.legal_entity_id', 'a.employee_id', 'e.display_name as employee_name',
        'e.user_id as employee_user_id', 'a.month', 'a.kind', 'a.amount', 'a.reason', 'a.status',
        'a.reviewed_by', 'a.reviewed_at', 'a.decision_note', 'a.payroll_run_id',
        'a.created_by', 'a.created_at', 'a.updated_at',
      ])
      .where('a.org_id', '=', ctx.orgId);
    if (input.legalEntityId) q = q.where('a.legal_entity_id', '=', input.legalEntityId);
    if (input.month) q = q.where('a.month', '=', input.month);
    if (input.status) q = q.where('a.status', '=', input.status);
    if (input.employeeId) q = q.where('a.employee_id', '=', input.employeeId);
    const rows = await q.orderBy('a.created_at', 'desc').limit(input.limit).execute();

    // Check if this org is sole-owner OPC once so UI accurately renders canApprove.
    const soleOwnerOpc = await isSoleOwnerOrg(ctx.trx, ctx.orgId, callerUserId, role);

    return rows.map((row) => {
      const isSelf = row.created_by === callerUserId || row.employee_user_id === callerUserId;
      return {
        id: row.id,
        legalEntityId: row.legal_entity_id,
        employeeId: row.employee_id,
        employeeName: row.employee_name ?? HR_ERASED_NAME,
        month: row.month,
        kind: row.kind,
        amount: normalizeStage6bMoney(row.amount),
        reason: row.reason,
        status: row.status,
        reviewedBy: row.reviewed_by,
        reviewedAt: isoTimestamp(row.reviewed_at),
        decisionNote: row.decision_note,
        payrollRunId: row.payroll_run_id,
        createdBy: row.created_by,
        createdAt: isoTimestamp(row.created_at) ?? new Date().toISOString(),
        updatedAt: isoTimestamp(row.updated_at) ?? new Date().toISOString(),
        canApprove: row.status === 'pending' && (!isSelf || soleOwnerOpc),
        canCancel: row.status === 'pending',
      };
    });
  },
});

export const adjustmentCreate = defineCommand({
  name: 'hr.payroll.adjustment.create',
  input: zHrAdjustmentCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_adjustment_item', [
      'id', 'legal_entity_id', 'employee_id', 'month', 'kind', 'amount', 'reason', 'status', 'created_by', 'created_at', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrAdjustmentActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const preEmp = await loadActiveEmployeeStatus(ctx.trx, ctx.orgId, input.employeeId);
    if (!preEmp) throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên');
    await lockOvertimeRun(ctx.trx, ctx.orgId, preEmp.legal_entity_id, input.month);
    await lockEmployeeErasure(ctx.trx, ctx.orgId, input.employeeId);
    const emp = await loadActiveEmployeeStatus(ctx.trx, ctx.orgId, input.employeeId);
    if (!emp) throw new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên');
    if (emp.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã được xóa theo yêu cầu');
    }
    await assertDraftOrNoPayrollRun(ctx.trx, ctx.orgId, emp.legal_entity_id, input.month);

    const amount = normalizeStage6bMoney(input.amount);
    const inserted = await ctx.trx
      .insertInto('ludy_hr.payroll_adjustment_item')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: emp.legal_entity_id,
        employee_id: emp.id,
        month: input.month,
        kind: input.kind,
        amount,
        reason: input.reason,
        status: 'pending',
        created_by: callerUserId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();

    ctx.audit({
      itemId: inserted.id,
      employeeId: emp.id,
      month: input.month,
      kind: input.kind,
      status: inserted.status,
    });
    return { itemId: inserted.id, status: inserted.status };
  },
});

export const adjustmentApprove = defineCommand({
  name: 'hr.payroll.adjustment.approve',
  input: zHrAdjustmentDecide,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { itemId: string }) => ({ type: 'hr.payroll_adjustment_item', id: input.itemId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_adjustment_item', [
      'status', 'reviewed_by', 'reviewed_at', 'decision_note', 'payroll_run_id', 'updated_at',
    ]),
    tableWrite(hrManifest.tables, 'ludy_hr', 'salary_advance_request', ['payroll_run_id', 'updated_at']),
    tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_line', [...LINE_UPDATE_COLUMNS]),
    tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_run', ['updated_at']),
  ],
  handler: async (ctx, input): Promise<HrAdjustmentActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const role = requireStage6bRole(ctx.role);
    const preRead = await ctx.trx
      .selectFrom('ludy_hr.payroll_adjustment_item')
      .select(['id', 'legal_entity_id', 'employee_id', 'month'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .executeTakeFirst();
    if (!preRead) throw adjustmentNotFound();

    await lockOvertimeRun(ctx.trx, ctx.orgId, preRead.legal_entity_id, preRead.month);
    await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);

    const existing = await ctx.trx
      .selectFrom('ludy_hr.payroll_adjustment_item')
      .select(['id', 'legal_entity_id', 'employee_id', 'month', 'kind', 'amount', 'status', 'created_by'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .executeTakeFirst();
    if (!existing) throw adjustmentNotFound();
    if (existing.status !== 'pending') {
      throw invalidAdjustmentState('Chỉ duyệt được khoản điều chỉnh đang ở trạng thái chờ duyệt');
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
      .updateTable('ludy_hr.payroll_adjustment_item')
      .set({
        status: 'approved',
        reviewed_by: callerUserId,
        reviewed_at: ctx.now,
        ...(input.note !== undefined ? { decision_note: input.note } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw invalidAdjustmentState('Trạng thái khoản điều chỉnh đã thay đổi, vui lòng thử lại');

    const payrollSynced = await syncEmployeeDraftPayrollStage6b(
      ctx,
      existing.legal_entity_id,
      existing.month,
      existing.employee_id,
    );

    ctx.audit({
      itemId: input.itemId,
      employeeId: existing.employee_id,
      month: existing.month,
      kind: existing.kind,
      status: 'approved',
      selfApproved,
      payrollSynced,
    });
    return { itemId: input.itemId, status: 'approved', payrollSynced };
  },
});

export const adjustmentReject = defineCommand({
  name: 'hr.payroll.adjustment.reject',
  input: zHrAdjustmentDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { itemId: string }) => ({ type: 'hr.payroll_adjustment_item', id: input.itemId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_adjustment_item', [
      'status', 'reviewed_by', 'reviewed_at', 'decision_note', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrAdjustmentActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const preRead = await ctx.trx
      .selectFrom('ludy_hr.payroll_adjustment_item')
      .select(['id', 'employee_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .executeTakeFirst();
    if (!preRead) throw adjustmentNotFound();
    await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);
    if (preRead.status !== 'pending') {
      throw invalidAdjustmentState('Chỉ từ chối được khoản điều chỉnh đang chờ duyệt');
    }

    const updated = await ctx.trx
      .updateTable('ludy_hr.payroll_adjustment_item')
      .set({
        status: 'rejected',
        reviewed_by: callerUserId,
        reviewed_at: ctx.now,
        ...(input.note !== undefined ? { decision_note: input.note } : {}),
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw invalidAdjustmentState('Trạng thái khoản điều chỉnh đã thay đổi, vui lòng thử lại');

    ctx.audit({ itemId: input.itemId, employeeId: preRead.employee_id, status: 'rejected' });
    return { itemId: input.itemId, status: 'rejected' };
  },
});

export const adjustmentCancel = defineCommand({
  name: 'hr.payroll.adjustment.cancel',
  input: zHrAdjustmentRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { itemId: string }) => ({ type: 'hr.payroll_adjustment_item', id: input.itemId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'payroll_adjustment_item', ['status', 'updated_at'])],
  handler: async (ctx, input): Promise<HrAdjustmentActionResult> => {
    userOf(ctx.actor);
    const preRead = await ctx.trx
      .selectFrom('ludy_hr.payroll_adjustment_item')
      .select(['id', 'employee_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .executeTakeFirst();
    if (!preRead) throw adjustmentNotFound();
    await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);
    if (preRead.status !== 'pending') {
      throw invalidAdjustmentState('Chỉ hủy được khoản điều chỉnh đang chờ duyệt');
    }

    const updated = await ctx.trx
      .updateTable('ludy_hr.payroll_adjustment_item')
      .set({ status: 'cancelled', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .where('status', '=', 'pending')
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw invalidAdjustmentState('Trạng thái khoản điều chỉnh đã thay đổi, vui lòng thử lại');

    ctx.audit({ itemId: input.itemId, employeeId: preRead.employee_id, status: 'cancelled' });
    return { itemId: input.itemId, status: 'cancelled' };
  },
});

export const hrPayrollAdjustmentCommands = [
  adjustmentCreate,
  adjustmentApprove,
  adjustmentReject,
  adjustmentCancel,
];
export const hrPayrollAdjustmentQueries = [adjustmentList];

// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 6B business trip requests with 2-level approval (#4527).
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import {
  HR_ERASED_NAME,
  auditValue,
  tableWrite,
  zHrSelfTripList,
  zHrSelfTripSubmit,
  zHrTripDecide,
  zHrTripList,
  zHrTripRef,
  type HrSelfTripListResult,
  type HrSelfTripSubmitResult,
  type HrTripActionResult,
  type HrTripRequestView,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { MANAGERS, lockEmployeeErasure, userOf } from './employees.ts';
import { resolveSelfEmployee, selfNotLinked, STAFF_ROLES } from './leave-requests.ts';
import { hrManifest } from './manifest.ts';
import { isoDate as iso } from './payroll-dates.ts';
import {
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

const TRIPS = hrManifest.tables.ludy_hr.business_trip_request;

const tripNotFound = () =>
  new DomainError('HR_BUSINESS_TRIP_NOT_FOUND', 404, 'Không tìm thấy đơn công tác này');
const invalidTripState = (msg: string) =>
  new DomainError('HR_BUSINESS_TRIP_INVALID_STATE', 409, msg);

interface RawTripRow {
  id: string;
  legal_entity_id: string;
  employee_id: string;
  employee_name: string | null;
  department_id: string | null;
  department_name: string | null;
  destination: string | null;
  purpose: string | null;
  start_on: Date | string;
  end_on: Date | string;
  estimated_allowance: string;
  status: HrTripRequestView['status'];
  l1_approver_user_id: string | null;
  l1_acted_at: Date | string | null;
  final_acted_by: string | null;
  final_acted_at: Date | string | null;
  decision_note: string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function mapTripView(
  row: RawTripRow,
  ctx: {
    callerUserId: string;
    callerRole: MemberRole;
    callerEmployeeId: string | null;
    managedDeptIds: ReadonlySet<string>;
    soleOwnerOpc: boolean;
  },
): HrTripRequestView {
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
    destination: row.destination,
    purpose: row.purpose,
    startOn: iso(row.start_on),
    endOn: iso(row.end_on),
    estimatedAllowance: normalizeStage6bMoney(row.estimated_allowance),
    status: row.status,
    l1ApproverUserId: row.l1_approver_user_id,
    l1ActedAt: isoTimestamp(row.l1_acted_at),
    finalActedBy: row.final_acted_by,
    finalActedAt: isoTimestamp(row.final_acted_at),
    decisionNote: row.decision_note,
    createdAt: isoTimestamp(row.created_at) ?? new Date().toISOString(),
    updatedAt: isoTimestamp(row.updated_at) ?? new Date().toISOString(),
    canApproveL1: row.status === 'pending_l1' && (!isSelf || ctx.soleOwnerOpc) && (isActiveDeptMgr || isOwnerOrAdmin),
    canApproveFinal: row.status === 'pending_final' && isOwnerOrAdmin && (!isSelf || ctx.soleOwnerOpc),
    canCancel: isPending && (ctx.callerEmployeeId === row.employee_id || isOwnerOrAdmin),
  };
}

export const selfBusinessTripSubmit = defineCommand({
  name: 'hr.self.business_trip.submit',
  input: zHrSelfTripSubmit,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'business_trip_request', [
      'id', 'legal_entity_id', 'employee_id', 'department_id', 'destination', 'purpose', 'start_on', 'end_on', 'estimated_allowance', 'status', 'created_by', 'created_at', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrSelfTripSubmitResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();

    await lockEmployeeErasure(ctx.trx, ctx.orgId, emp.id);
    const record = await loadActiveEmployeeStatus(ctx.trx, ctx.orgId, emp.id);
    if (!record || record.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã được xóa theo yêu cầu');
    }
    if (record.status !== 'active') {
      throw new DomainError('HR_EMPLOYEE_ENDED', 409, 'Nhân viên đã nghỉ việc, không thể gửi đơn công tác');
    }

    const initialStatus = await resolveTwoLevelInitialStatus(ctx.trx, ctx.orgId, record.department_id, callerUserId);
    const allowance = normalizeStage6bMoney(input.estimatedAllowance);
    const inserted = await ctx.trx
      .insertInto('ludy_hr.business_trip_request')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: record.legal_entity_id,
        employee_id: emp.id,
        department_id: record.department_id,
        destination: input.destination,
        purpose: input.purpose,
        start_on: input.startOn,
        end_on: input.endOn,
        estimated_allowance: allowance,
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
      startOn: input.startOn,
      endOn: input.endOn,
      status: inserted.status,
      estimatedAllowance: auditValue(TRIPS, 'estimated_allowance', allowance),
    });
    return { requestId: inserted.id, status: inserted.status };
  },
});

export const selfBusinessTripCancel = defineCommand({
  name: 'hr.self.business_trip.cancel',
  input: zHrTripRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.business_trip_request', id: input.requestId }),
  writes: [tableWrite(hrManifest.tables, 'ludy_hr', 'business_trip_request', ['status', 'updated_at'])],
  handler: async (ctx, input): Promise<HrTripActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    if (!emp) throw selfNotLinked();

    await lockEmployeeErasure(ctx.trx, ctx.orgId, emp.id);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.business_trip_request')
      .select(['id', 'employee_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .where('employee_id', '=', emp.id)
      .executeTakeFirst();
    if (!existing) throw tripNotFound();
    if (existing.status !== 'pending_l1' && existing.status !== 'pending_final') {
      throw invalidTripState('Chỉ hủy được đơn công tác đang chờ duyệt');
    }

    const updated = await ctx.trx
      .updateTable('ludy_hr.business_trip_request')
      .set({ status: 'cancelled', updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .where('employee_id', '=', emp.id)
      .where('status', 'in', ['pending_l1', 'pending_final'])
      .returning('id')
      .executeTakeFirst();
    if (!updated) throw invalidTripState('Trạng thái đơn công tác đã thay đổi, vui lòng thử lại');

    ctx.audit({ requestId: input.requestId, employeeId: emp.id, status: 'cancelled' });
    return { requestId: input.requestId, status: 'cancelled' };
  },
});

export const selfBusinessTripList = defineQuery({
  name: 'hr.self.business_trip.list',
  input: zHrSelfTripList,
  access: STAFF_ROLES,
  sensitive: true,
  handler: async (ctx, input): Promise<HrSelfTripListResult> => {
    const callerUserId = userOf(ctx.actor);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    const role = requireStage6bRole(ctx.role);
    const soleOwnerOpc = await isSoleOwnerOrg(ctx.trx, ctx.orgId, callerUserId, role);
    const managedDepts = await loadManagedDepartmentSet(ctx.trx, ctx.orgId, callerUserId);
    const managedDeptIds = new Set(managedDepts.map((d) => d.id));

    let items: HrTripRequestView[] = [];
    if (emp) {
      let q = ctx.trx
        .selectFrom('ludy_hr.business_trip_request as r')
        .leftJoin('ludy_hr.department as d', (j) => j.onRef('d.org_id', '=', 'r.org_id').onRef('d.id', '=', 'r.department_id'))
        .select([
          'r.id', 'r.legal_entity_id', 'r.employee_id', 'r.department_id',
          'd.name as department_name', 'r.destination', 'r.purpose', 'r.start_on', 'r.end_on',
          'r.estimated_allowance', 'r.status', 'r.l1_approver_user_id', 'r.l1_acted_at',
          'r.final_acted_by', 'r.final_acted_at', 'r.decision_note', 'r.created_by', 'r.created_at', 'r.updated_at',
        ])
        .where('r.org_id', '=', ctx.orgId)
        .where('r.employee_id', '=', emp.id);
      if (input.status) q = q.where('r.status', '=', input.status);
      const ownRows = await q.orderBy('r.created_at', 'desc').limit(input.limit).execute();

      items = ownRows.map((row) =>
        mapTripView(
          { ...row, employee_name: emp.display_name },
          { callerUserId, callerRole: role, callerEmployeeId: emp.id, managedDeptIds, soleOwnerOpc },
        ),
      );
    }

    let l1Queue: HrTripRequestView[] = [];
    if (managedDepts.length > 0) {
      let l1q = ctx.trx
        .selectFrom('ludy_hr.business_trip_request as r')
        .leftJoin('ludy_hr.department as d', (j) => j.onRef('d.org_id', '=', 'r.org_id').onRef('d.id', '=', 'r.department_id'))
        .select([
          'r.id', 'r.legal_entity_id', 'r.employee_id',
          sql<string | null>`ludy_hr.hr_stage6b_request_employee_name(r.org_id, 'business_trip', r.id)`.as('employee_name'),
          'r.department_id', 'd.name as department_name', 'r.destination', 'r.purpose', 'r.start_on', 'r.end_on',
          'r.estimated_allowance', 'r.status', 'r.l1_approver_user_id', 'r.l1_acted_at',
          'r.final_acted_by', 'r.final_acted_at', 'r.decision_note', 'r.created_by', 'r.created_at', 'r.updated_at',
        ])
        .where('r.org_id', '=', ctx.orgId)
        .where('r.status', '=', 'pending_l1')
        .where('r.department_id', 'in', [...managedDeptIds]);
      if (emp) l1q = l1q.where('r.employee_id', '!=', emp.id);
      const l1Rows = await l1q.orderBy('r.created_at', 'asc').limit(input.limit).execute();
      l1Queue = l1Rows.map((row) =>
        mapTripView(row, { callerUserId, callerRole: role, callerEmployeeId: emp?.id ?? null, managedDeptIds, soleOwnerOpc }),
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

export const businessTripList = defineQuery({
  name: 'hr.business_trip.list',
  input: zHrTripList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrTripRequestView[]> => {
    const callerUserId = userOf(ctx.actor);
    const role = requireStage6bRole(ctx.role);
    const soleOwnerOpc = await isSoleOwnerOrg(ctx.trx, ctx.orgId, callerUserId, role);
    const emp = await resolveSelfEmployee(ctx.trx, ctx.orgId, callerUserId);
    const managedDepts = await loadManagedDepartmentSet(ctx.trx, ctx.orgId, callerUserId);
    const managedDeptIds = new Set(managedDepts.map((d) => d.id));

    let q = ctx.trx
      .selectFrom('ludy_hr.business_trip_request as r')
      .leftJoin('ludy_hr.payroll_employee as e', (j) => j.onRef('e.org_id', '=', 'r.org_id').onRef('e.id', '=', 'r.employee_id'))
      .leftJoin('ludy_hr.department as d', (j) => j.onRef('d.org_id', '=', 'r.org_id').onRef('d.id', '=', 'r.department_id'))
      .select([
        'r.id', 'r.legal_entity_id', 'r.employee_id', 'e.display_name as employee_name',
        'r.department_id', 'd.name as department_name', 'r.destination', 'r.purpose', 'r.start_on', 'r.end_on',
        'r.estimated_allowance', 'r.status', 'r.l1_approver_user_id', 'r.l1_acted_at',
        'r.final_acted_by', 'r.final_acted_at', 'r.decision_note', 'r.created_by', 'r.created_at', 'r.updated_at',
      ])
      .where('r.org_id', '=', ctx.orgId);
    if (input.legalEntityId) q = q.where('r.legal_entity_id', '=', input.legalEntityId);
    if (input.status) q = q.where('r.status', '=', input.status);
    const rows = await q.orderBy('r.created_at', 'desc').limit(input.limit).execute();

    const deptMeta = await loadDepartmentNameMap(
      ctx.trx,
      ctx.orgId,
      [...new Set(rows.map((r) => r.department_id).filter((v): v is string => v !== null))],
    );
    return rows.map((row) => {
      const view = mapTripView(row, {
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

export const businessTripApproveL1 = defineCommand({
  name: 'hr.business_trip.approve_l1',
  input: zHrTripDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.business_trip_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'business_trip_request', [
      'status', 'l1_approver_user_id', 'l1_acted_at', 'decision_note', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrTripActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const preRead = await ctx.trx
      .selectFrom('ludy_hr.business_trip_request')
      .select(['id', 'employee_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!preRead) throw tripNotFound();

    await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.business_trip_request')
      .select(['id', 'employee_id', 'department_id', 'status', 'created_by'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!existing) throw tripNotFound();
    if (existing.status !== 'pending_l1') {
      throw invalidTripState('Đơn công tác không ở trạng thái chờ duyệt cấp 1');
    }

    const { role, selfApproved } = await assertStage6bL1Authority(ctx.trx, ctx.orgId, callerUserId, existing);
    const updated = await ctx.trx
      .updateTable('ludy_hr.business_trip_request')
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
    if (!updated) throw invalidTripState('Trạng thái đơn công tác đã thay đổi, vui lòng thử lại');

    ctx.audit({ requestId: input.requestId, employeeId: existing.employee_id, status: 'pending_final', role, selfApproved });
    return { requestId: input.requestId, status: 'pending_final' };
  },
});

export const businessTripApproveFinal = defineCommand({
  name: 'hr.business_trip.approve_final',
  input: zHrTripDecide,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { requestId: string }) => ({ type: 'hr.business_trip_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'business_trip_request', [
      'status', 'final_acted_by', 'final_acted_at', 'decision_note', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrTripActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const role = requireStage6bRole(ctx.role);
    const preRead = await ctx.trx
      .selectFrom('ludy_hr.business_trip_request')
      .select(['id', 'employee_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!preRead) throw tripNotFound();

    await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.business_trip_request')
      .select(['id', 'employee_id', 'status', 'created_by'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!existing) throw tripNotFound();
    if (existing.status !== 'pending_final') {
      throw invalidTripState('Đơn công tác phải qua bước chờ duyệt cuối (pending_final)');
    }

    const emp = await loadActiveEmployeeStatus(ctx.trx, ctx.orgId, existing.employee_id);
    if (!emp || emp.erased_at !== null) {
      throw new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên đã được xóa theo yêu cầu');
    }

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
      .updateTable('ludy_hr.business_trip_request')
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
    if (!updated) throw invalidTripState('Trạng thái đơn công tác đã thay đổi, vui lòng thử lại');

    ctx.audit({ requestId: input.requestId, employeeId: existing.employee_id, status: 'approved', selfApproved });
    return { requestId: input.requestId, status: 'approved' };
  },
});

export const businessTripReject = defineCommand({
  name: 'hr.business_trip.reject',
  input: zHrTripDecide,
  risk: 'R1',
  sideEffect: 'internal',
  access: STAFF_ROLES,
  target: (input: { requestId: string }) => ({ type: 'hr.business_trip_request', id: input.requestId }),
  writes: [
    tableWrite(hrManifest.tables, 'ludy_hr', 'business_trip_request', [
      'status', 'l1_approver_user_id', 'l1_acted_at', 'final_acted_by', 'final_acted_at', 'decision_note', 'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<HrTripActionResult> => {
    const callerUserId = userOf(ctx.actor);
    const preRead = await ctx.trx
      .selectFrom('ludy_hr.business_trip_request')
      .select(['id', 'employee_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!preRead) throw tripNotFound();

    await lockEmployeeErasure(ctx.trx, ctx.orgId, preRead.employee_id);
    const existing = await ctx.trx
      .selectFrom('ludy_hr.business_trip_request')
      .select(['id', 'employee_id', 'department_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.requestId)
      .executeTakeFirst();
    if (!existing) throw tripNotFound();
    if (existing.status !== 'pending_l1' && existing.status !== 'pending_final') {
      throw invalidTripState('Chỉ từ chối được đơn công tác đang chờ duyệt');
    }

    const role = await assertStage6bRejectAuthority(ctx.trx, ctx.orgId, callerUserId, existing);
    const isAdminOrOwner = role === 'owner' || role === 'admin';
    const updated = await ctx.trx
      .updateTable('ludy_hr.business_trip_request')
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
    if (!updated) throw invalidTripState('Trạng thái đơn công tác đã thay đổi, vui lòng thử lại');

    ctx.audit({ requestId: input.requestId, employeeId: existing.employee_id, status: 'rejected' });
    return { requestId: input.requestId, status: 'rejected' };
  },
});

export const hrBusinessTripCommands = [
  selfBusinessTripSubmit,
  selfBusinessTripCancel,
  businessTripApproveL1,
  businessTripApproveFinal,
  businessTripReject,
];
export const hrBusinessTripQueries = [selfBusinessTripList, businessTripList];

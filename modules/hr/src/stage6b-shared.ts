// SPDX-License-Identifier: AGPL-3.0-only
// Shared authorization, 2-level workflow, and money helpers for HR Stage 6B (#4527).
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import { money } from '@ludy/l10n-vn';
import { DomainError, type QueryContext } from '@ludy/kernel-runtime';
import { resolveSelfEmployee } from './leave-requests.ts';

export function normalizeStage6bMoney(value: string): string {
  return money(value).toDecimalPlaces(2).toFixed();
}

export function requireStage6bRole(role: MemberRole | null | undefined): MemberRole {
  if (!role) {
    throw new DomainError('FORBIDDEN', 403, 'Chưa xác định vai trò trong tổ chức');
  }
  return role;
}

export async function assertDraftOrNoPayrollRun(
  trx: QueryContext['trx'],
  orgId: string,
  legalEntityId: string,
  month: string,
): Promise<void> {
  const res = await sql<{ locked: boolean }>`
    SELECT ludy_hr.hr_stage6b_payroll_run_locked(${orgId}::uuid, ${legalEntityId}::uuid, ${month}) AS locked
  `.execute(trx);
  if (res.rows[0]?.locked) {
    throw new DomainError(
      'HR_RUN_NOT_DRAFT',
      409,
      'Bảng lương của tháng này đã được duyệt, không thể gửi hoặc duyệt thêm tạm ứng hay điều chỉnh; sửa sai bằng dòng điều chỉnh ở kỳ lương sau',
    );
  }
}

export function isoTimestamp(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export async function loadActiveEmployeeStatus(
  trx: QueryContext['trx'],
  orgId: string,
  employeeId: string,
): Promise<{
  id: string;
  legal_entity_id: string;
  department_id: string | null;
  status: string;
  erased_at: Date | null;
  user_id: string | null;
} | null> {
  const row = await trx
    .selectFrom('ludy_hr.payroll_employee')
    .select(['id', 'legal_entity_id', 'department_id', 'status', 'erased_at', 'user_id'])
    .where('org_id', '=', orgId)
    .where('id', '=', employeeId)
    .executeTakeFirst();
  return row ?? null;
}

export async function isSoleOwnerOrg(
  trx: QueryContext['trx'],
  orgId: string,
  callerUserId: string,
  role: MemberRole,
): Promise<boolean> {
  if (role !== 'owner') return false;
  const otherApprover = await trx
    .selectFrom('ludy_kernel.tenant_member')
    .select('user_id')
    .where('org_id', '=', orgId)
    .where('user_id', '!=', callerUserId)
    .where('role', 'in', ['owner', 'admin'])
    .limit(1)
    .executeTakeFirst();
  return !otherApprover;
}

export async function resolveTwoLevelInitialStatus(
  trx: QueryContext['trx'],
  orgId: string,
  departmentId: string | null,
  employeeUserId: string | null,
): Promise<'pending_l1' | 'pending_final'> {
  if (!departmentId) return 'pending_final';
  const dept = await trx
    .selectFrom('ludy_hr.department')
    .select(['manager_user_id', 'archived_at'])
    .where('org_id', '=', orgId)
    .where('id', '=', departmentId)
    .executeTakeFirst();
  if (
    !dept ||
    dept.archived_at !== null ||
    dept.manager_user_id === null ||
    dept.manager_user_id === employeeUserId
  ) {
    return 'pending_final';
  }
  const activeMgr = await trx
    .selectFrom('ludy_kernel.tenant_member')
    .select('user_id')
    .where('org_id', '=', orgId)
    .where('user_id', '=', dept.manager_user_id)
    .where('role', 'in', ['owner', 'admin', 'member'])
    .limit(1)
    .executeTakeFirst();
  return activeMgr ? 'pending_l1' : 'pending_final';
}

export async function assertStage6bNotSelfApprover(
  trx: QueryContext['trx'],
  orgId: string,
  callerUserId: string,
  role: MemberRole,
  employeeId: string,
  createdBy: string | null,
  allowSoleOwner: boolean,
): Promise<boolean> {
  const callerEmp = await resolveSelfEmployee(trx, orgId, callerUserId);
  const isSelfEmployee = callerEmp !== undefined && callerEmp.id === employeeId;
  const isCreator = createdBy !== null && createdBy === callerUserId;
  if (!isSelfEmployee && !isCreator) return false;

  const block = () =>
    new DomainError('HR_SELF_APPROVAL_BLOCKED', 403, 'Không thể tự duyệt đơn hoặc khoản điều chỉnh của chính mình');

  if (!allowSoleOwner || !(await isSoleOwnerOrg(trx, orgId, callerUserId, role))) {
    throw block();
  }
  return true;
}

export async function assertStage6bL1Authority(
  trx: QueryContext['trx'],
  orgId: string,
  callerUserId: string,
  req: { employee_id: string; department_id: string | null; created_by: string | null },
): Promise<{ role: 'owner' | 'admin' | 'member'; selfApproved: boolean }> {
  const member = await trx
    .selectFrom('ludy_kernel.tenant_member')
    .select('role')
    .where('org_id', '=', orgId)
    .where('user_id', '=', callerUserId)
    .executeTakeFirstOrThrow();
  const role = member.role as MemberRole;
  if (role === 'viewer') {
    throw new DomainError('FORBIDDEN', 403, 'Người xem (viewer) không có quyền duyệt');
  }
  const selfApproved = await assertStage6bNotSelfApprover(
    trx,
    orgId,
    callerUserId,
    role,
    req.employee_id,
    req.created_by,
    true,
  );

  // Use SECURITY DEFINER helper / direct check carefully: active non-archived department with assigned manager.
  if (req.department_id !== null) {
    const activeManagerResult = await sql<{ allowed: boolean; has_active_non_self_mgr: boolean }>`
      SELECT
        ludy_hr.is_active_dept_manager(${orgId}::uuid, ${req.department_id}::uuid) AS allowed,
        EXISTS (
          SELECT 1 FROM ludy_hr.department d
          LEFT JOIN ludy_hr.payroll_employee e ON e.org_id = d.org_id AND e.id = ${req.employee_id}::uuid
           WHERE d.org_id = ${orgId}::uuid
             AND d.id = ${req.department_id}::uuid
             AND d.archived_at IS NULL
             AND d.manager_user_id IS NOT NULL
             AND d.manager_user_id IS DISTINCT FROM e.user_id
             AND EXISTS (
               SELECT 1 FROM ludy_kernel.tenant_member mm
                WHERE mm.org_id = d.org_id
                  AND mm.user_id = d.manager_user_id
                  AND mm.role IN ('owner', 'admin', 'member')
             )
        ) AS has_active_non_self_mgr
    `.execute(trx);
    const meta = activeManagerResult.rows[0];
    if (meta?.allowed) {
      return { role, selfApproved };
    }
    if (meta?.has_active_non_self_mgr) {
      throw new DomainError(
        'FORBIDDEN',
        403,
        'Đơn phải do quản lý trực tiếp của phòng ban đang hoạt động duyệt cấp 1',
      );
    }
  }

  if (role === 'owner' || role === 'admin') {
    return { role, selfApproved };
  }
  throw new DomainError(
    'FORBIDDEN',
    403,
    'Chỉ quản lý phòng ban đang hoạt động hoặc quản trị viên mới duyệt được cấp 1',
  );
}

export async function assertStage6bRejectAuthority(
  trx: QueryContext['trx'],
  orgId: string,
  callerUserId: string,
  req: { status: string; department_id: string | null },
): Promise<'owner' | 'admin' | 'member'> {
  const member = await trx
    .selectFrom('ludy_kernel.tenant_member')
    .select('role')
    .where('org_id', '=', orgId)
    .where('user_id', '=', callerUserId)
    .executeTakeFirstOrThrow();
  const role = member.role as MemberRole;
  if (role === 'viewer') {
    throw new DomainError('FORBIDDEN', 403, 'Người xem (viewer) không có quyền từ chối đơn');
  }
  if (role === 'owner' || role === 'admin') return role;
  if (req.status === 'pending_l1' && req.department_id !== null) {
    const { rows } = await sql<{ allowed: boolean }>`
      SELECT ludy_hr.is_active_dept_manager(${orgId}::uuid, ${req.department_id}::uuid) AS allowed
    `.execute(trx);
    if (rows[0]?.allowed) return role;
  }
  throw new DomainError('FORBIDDEN', 403, 'Chỉ người có thẩm quyền mới từ chối được đơn này');
}

export async function loadManagedDepartmentSet(
  trx: QueryContext['trx'],
  orgId: string,
  userId: string,
): Promise<{ id: string; name: string }[]> {
  return trx
    .selectFrom('ludy_hr.department')
    .select(['id', 'name'])
    .where('org_id', '=', orgId)
    .where('manager_user_id', '=', userId)
    .where('archived_at', 'is', null)
    .execute();
}

export async function loadDepartmentNameMap(
  trx: QueryContext['trx'],
  orgId: string,
  deptIds: readonly string[],
): Promise<Map<string, { name: string; active: boolean; managerUserId: string | null }>> {
  const map = new Map<string, { name: string; active: boolean; managerUserId: string | null }>();
  if (deptIds.length === 0) return map;
  const rows = await trx
    .selectFrom('ludy_hr.department')
    .select(['id', 'name', 'archived_at', 'manager_user_id'])
    .where('org_id', '=', orgId)
    .where('id', 'in', [...deptIds])
    .execute();
  for (const r of rows) {
    map.set(r.id, { name: r.name, active: r.archived_at === null, managerUserId: r.manager_user_id });
  }
  return map;
}

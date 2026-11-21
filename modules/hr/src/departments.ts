// SPDX-License-Identifier: AGPL-3.0-only
// HR departments per legal entity (issue #3412, Part of #3403 Stage 3 Slice 3a): optional team structure with a default pay_function.
// SME zero-setup default: employees can stay unassigned (department_id NULL) and run payroll with zero department setup.
// Owners and admins only, in the commands/queries and in the database's RESTRICTIVE owner_admin and le_scope policies.
import { sql } from 'kysely';
import type { MemberRole } from '@ludy/db';
import { memberProfiles } from '@ludy/kernel';
import {
  tableWrite,
  zHrDepartmentAdd,
  zHrDepartmentEdit,
  zHrDepartmentList,
  zHrDepartmentRef,
  zHrDepartmentSetManager,
  type HrDepartmentView,
  type HrDepartmentWritten,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { sum, toMoney } from '@ludy/l10n-vn';
import { memberLabel, resolveEntity, vietnamDay } from './employees.ts';
import { hrManifest } from './manifest.ts';
import { isoDate } from './payroll-dates.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];

const userOf = (actor: QueryContext['actor']): string => {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
};

const notFound = () => new DomainError('HR_DEPARTMENT_NOT_FOUND', 404, 'Không tìm thấy phòng ban này');
const archivedError = () => new DomainError('HR_DEPARTMENT_ARCHIVED', 409, 'Phòng ban này đã được lưu trữ nên không sửa được');
const nameTaken = () => new DomainError('HR_DEPARTMENT_NAME_TAKEN', 409, 'Pháp nhân này đã có phòng ban với tên đó');
const isNameTaken = (error: unknown): boolean => {
  const pg = error as { code?: string; constraint?: string };
  return pg.code === '23505' && pg.constraint === 'department_entity_name_uq';
};
const targetOf = (input: { departmentId: string }) => ({ type: 'hr.department', id: input.departmentId });

export const departmentAdd = defineCommand({
  name: 'hr.department.add',
  input: zHrDepartmentAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'department', ['org_id', 'id', 'legal_entity_id', 'name', 'code', 'pay_function', 'created_by', 'created_at', 'updated_at'])],
  handler: async (ctx, input): Promise<HrDepartmentWritten> => {
    const userId = userOf(ctx.actor);
    const legalEntityId = await resolveEntity(ctx, input.legalEntityId);
    try {
      const row = await ctx.trx
        .insertInto('crove_hr.department')
        .values({
          org_id: ctx.orgId,
          legal_entity_id: legalEntityId,
          name: input.name,
          code: input.code ?? null,
          pay_function: input.payFunction,
          created_by: userId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ctx.audit({ departmentId: row.id, legalEntityId, payFunction: input.payFunction });
      return { departmentId: row.id };
    } catch (error) {
      if (isNameTaken(error)) throw nameTaken();
      throw error;
    }
  },
});

export const departmentEdit = defineCommand({
  name: 'hr.department.edit',
  input: zHrDepartmentEdit,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: targetOf,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'department', ['name', 'code', 'pay_function', 'updated_at'])],
  handler: async (ctx, input): Promise<HrDepartmentWritten> => {
    const found = await ctx.trx
      .selectFrom('crove_hr.department')
      .select(['id', 'archived_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.departmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!found) throw notFound();
    if (found.archived_at !== null) throw archivedError();
    try {
      await ctx.trx
        .updateTable('crove_hr.department')
        .set({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.code === undefined ? {} : { code: input.code }),
          ...(input.payFunction === undefined ? {} : { pay_function: input.payFunction }),
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.departmentId)
        .execute();
    } catch (error) {
      if (isNameTaken(error)) throw nameTaken();
      throw error;
    }
    ctx.audit({
      departmentId: input.departmentId,
      changed: Object.keys(input).filter(
        (k) => k !== 'departmentId' && input[k as keyof typeof input] !== undefined,
      ),
    });
    return { departmentId: input.departmentId };
  },
});

export const departmentArchive = defineCommand({
  name: 'hr.department.archive',
  input: zHrDepartmentRef,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: targetOf,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'department', ['archived_at', 'updated_at'])],
  handler: async (ctx, input): Promise<HrDepartmentWritten> => {
    const found = await ctx.trx
      .selectFrom('crove_hr.department')
      .select(['id', 'archived_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.departmentId)
      .forUpdate()
      .executeTakeFirst();
    if (!found) throw notFound();
    if (found.archived_at !== null) {
      ctx.audit({ departmentId: input.departmentId, alreadyArchived: true });
      return { departmentId: input.departmentId };
    }
    await ctx.trx
      .updateTable('crove_hr.department')
      .set({ archived_at: ctx.now, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.departmentId)
      .execute();
    ctx.audit({ departmentId: input.departmentId, alreadyArchived: false });
    return { departmentId: input.departmentId };
  },
});

export const departmentSetManager = defineCommand({
  name: 'hr.department.set_manager',
  input: zHrDepartmentSetManager,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: targetOf,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'department', ['manager_user_id', 'updated_at'])],
  handler: async (ctx, input): Promise<HrDepartmentWritten> => {
    userOf(ctx.actor);
    const existing = await ctx.trx
      .selectFrom('crove_hr.department')
      .select(['id', 'archived_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.departmentId)
      .executeTakeFirst();
    if (!existing) throw notFound();
    if (existing.archived_at !== null) throw archivedError();
    if (input.managerUserId !== null) {
      const member = await ctx.trx
        .selectFrom('crove_kernel.tenant_member')
        .select('role')
        .where('org_id', '=', ctx.orgId)
        .where('user_id', '=', input.managerUserId)
        .executeTakeFirst();
      if (!member) {
        throw new DomainError('HR_MEMBER_NOT_FOUND', 404, 'Không tìm thấy thành viên này trong tổ chức');
      }
      if (member.role === 'viewer') {
        throw new DomainError('HR_MEMBER_ROLE_VIEWER', 422, 'Người xem (viewer) không thể làm quản lý phòng ban');
      }
    }
    await ctx.trx
      .updateTable('crove_hr.department')
      .set({ manager_user_id: input.managerUserId, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.departmentId)
      .execute();
    ctx.audit({ departmentId: input.departmentId, managerUserId: input.managerUserId });
    return { departmentId: input.departmentId };
  },
});

// Reads active headcount and summed base_wage over active employees' current employment as of today: audited before reading.
export const departmentList = defineQuery({
  name: 'hr.department.list',
  input: zHrDepartmentList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrDepartmentView[]> => {
    let q = ctx.trx
      .selectFrom('crove_hr.department')
      .select(['id', 'legal_entity_id', 'name', 'code', 'pay_function', 'manager_user_id', 'archived_at'])
      .where('org_id', '=', ctx.orgId);
    if (input.legalEntityId !== undefined) q = q.where('legal_entity_id', '=', input.legalEntityId);
    if (!input.includeArchived) q = q.where('archived_at', 'is', null);
    const departments = await q
      .orderBy(sql`archived_at IS NOT NULL`, 'asc')
      .orderBy('name', 'asc')
      .orderBy('id', 'asc')
      .execute();
    if (departments.length === 0) return [];

    const activeEmployees = await ctx.trx
      .selectFrom('crove_hr.payroll_employee')
      .select(['id', 'department_id'])
      .where('org_id', '=', ctx.orgId)
      .where('status', '=', 'active')
      .where(
        'department_id',
        'in',
        departments.map((d) => d.id),
      )
      .execute();

    const currentWageByEmployee = new Map<string, string>();
    if (activeEmployees.length > 0) {
      const today = vietnamDay(new Date());
      const terms = await ctx.trx
        .selectFrom('crove_hr.payroll_employment')
        .select(['employee_id', 'effective_from', 'base_wage'])
        .where('org_id', '=', ctx.orgId)
        .where(
          'employee_id',
          'in',
          activeEmployees.map((e) => e.id),
        )
        .orderBy('effective_from', 'desc')
        .execute();
      for (const term of terms) {
        if (currentWageByEmployee.has(term.employee_id)) continue;
        if (isoDate(term.effective_from) <= today) currentWageByEmployee.set(term.employee_id, term.base_wage);
      }
    }

    const headcountByDept = new Map<string, number>();
    const wagesByDept = new Map<string, string[]>();
    for (const emp of activeEmployees) {
      if (!emp.department_id) continue;
      headcountByDept.set(emp.department_id, (headcountByDept.get(emp.department_id) ?? 0) + 1);
      const wage = currentWageByEmployee.get(emp.id);
      if (wage !== undefined) {
        const list = wagesByDept.get(emp.department_id) ?? [];
        list.push(wage);
        wagesByDept.set(emp.department_id, list);
      }
    }

    const managerProfiles = await memberProfiles(
      ctx.trx,
      departments.map((d) => d.manager_user_id).filter((id): id is string => id !== null),
    );

    return departments.map((d) => {
      const managerName = memberLabel(d.manager_user_id ? managerProfiles.get(d.manager_user_id) : undefined);
      return {
        id: d.id,
        legalEntityId: d.legal_entity_id,
        name: d.name,
        code: d.code,
        payFunction: d.pay_function,
        managerUserId: d.manager_user_id,
        managerName,
        archivedAt: d.archived_at === null ? null : new Date(d.archived_at).toISOString(),
        activeEmployees: headcountByDept.get(d.id) ?? 0,
        activeBaseWageTotal: toMoney(sum(wagesByDept.get(d.id) ?? [])),
      };
    });
  },
});

export const hrDepartmentCommands = [departmentAdd, departmentEdit, departmentSetManager, departmentArchive];
export const hrDepartmentQueries = [departmentList];

// SPDX-License-Identifier: AGPL-3.0-only
// Monthly employee leave ledger & statutory leave balance (issue #3394, #2540 slice 1c-2, docs/plan/payroll.md section 5 rows 3 & 6.7, section 7, ADR-0046).
// Owners and admins only, in the commands/queries and in the database's policies (crove_hr.payroll_leave_entry owner_admin and le_scope).
// Audit facts carry ids, month, kind, approved and auditValue(..., 'days') only, never raw sensitive day counts.
import { calculateLeaveBalance, money, PAYROLL_RULES, PayrollRefusedError, toMoney } from '@crove/l10n-vn';
import type { MemberRole } from '@crove/db';
import {
  auditValue,
  tableWrite,
  zHrLeaveBalanceAsk,
  zHrLeaveDelete,
  zHrLeaveSet,
  type HrLeaveBalanceResult,
  type HrLeaveEntryView,
  type HrLeaveWritten,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { hrManifest } from './manifest.ts';
import { isoDate as iso } from './payroll-dates.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const LEAVE_ENTRY = hrManifest.tables.crove_hr.payroll_leave_entry;

const userOf = (actor: QueryContext['actor']): string => {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
};

const employeeNotFound = () => new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên này');
const erasedError = () => new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên này đã được xóa theo yêu cầu, không sửa được nữa');
const entryNotFound = () => new DomainError('HR_LEAVE_ENTRY_NOT_FOUND', 404, 'Không tìm thấy dòng nghỉ phép này');

async function loadEmployeeForLeave(trx: QueryContext['trx'], orgId: string, employeeId: string, lock: boolean) {
  let q = trx
    .selectFrom('crove_hr.payroll_employee')
    .select(['id', 'legal_entity_id', 'status', 'ended_on', 'erased_at'])
    .where('org_id', '=', orgId)
    .where('id', '=', employeeId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw employeeNotFound();
  if (row.erased_at !== null) throw erasedError();
  return row;
}

export const leaveSet = defineCommand({
  name: 'hr.payroll.leave.set',
  input: zHrLeaveSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { employeeId: string }) => ({ type: 'hr.payroll_employee', id: input.employeeId }),
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_leave_entry', [
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
  ],
  handler: async (ctx, input): Promise<HrLeaveWritten> => {
    const userId = userOf(ctx.actor);
    const employee = await loadEmployeeForLeave(ctx.trx, ctx.orgId, input.employeeId, true);
    const firstTerm = await ctx.trx
      .selectFrom('crove_hr.payroll_employment')
      .select(['effective_from'])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', employee.id)
      .orderBy('effective_from', 'asc')
      .limit(1)
      .executeTakeFirst();
    const days = money(input.days);
    if (input.kind !== 'opening_balance') {
      if (firstTerm && input.month < iso(firstTerm.effective_from).slice(0, 7)) {
        throw new DomainError('HR_LEAVE_BEFORE_HIRE', 422, 'Tháng nghỉ phép không thể trước tháng vào làm');
      }
      if (days.greaterThan('31')) {
        throw new DomainError('HR_LEAVE_DAYS_EXCEEDS_MONTH', 422, 'Số ngày nghỉ trong một tháng không vượt quá 31 ngày');
      }
    }
    if (days.isZero()) {
      const deleted = await ctx.trx
        .deleteFrom('crove_hr.payroll_leave_entry')
        .where('org_id', '=', ctx.orgId)
        .where('employee_id', '=', employee.id)
        .where('month', '=', input.month)
        .where('kind', '=', input.kind)
        .returning('id')
        .executeTakeFirst();
      ctx.audit({
        employeeId: employee.id,
        entryId: deleted?.id ?? null,
        month: input.month,
        kind: input.kind,
        cleared: true,
        days: auditValue(LEAVE_ENTRY, 'days', input.days),
      });
      return { employeeId: employee.id, entryId: deleted?.id ?? null, deleted: Boolean(deleted) };
    }
    const storedDays = days.toDecimalPlaces(2).toFixed();
    const saved = await ctx.trx
      .insertInto('crove_hr.payroll_leave_entry')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: employee.legal_entity_id,
        employee_id: employee.id,
        month: input.month,
        kind: input.kind,
        days: storedDays,
        approved: input.approved,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .onConflict((oc) =>
        oc.columns(['org_id', 'employee_id', 'month', 'kind']).doUpdateSet({
          days: storedDays,
          approved: input.approved,
          updated_at: ctx.now,
        }),
      )
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({
      employeeId: employee.id,
      entryId: saved.id,
      month: input.month,
      kind: input.kind,
      approved: input.approved,
      days: auditValue(LEAVE_ENTRY, 'days', input.days),
    });
    return { employeeId: employee.id, entryId: saved.id, deleted: false };
  },
});

export const leaveDelete = defineCommand({
  name: 'hr.payroll.leave.delete',
  input: zHrLeaveDelete,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { entryId: string }) => ({ type: 'hr.payroll_leave_entry', id: input.entryId }),
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_leave_entry', ['id'])],
  handler: async (ctx, input): Promise<HrLeaveWritten> => {
    userOf(ctx.actor);
    const found = await ctx.trx
      .selectFrom('crove_hr.payroll_leave_entry')
      .select(['id', 'employee_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.entryId)
      .executeTakeFirst();
    if (!found) throw entryNotFound();
    // Acquire employee lock before leave_entry mutation to stay consistent with leaveSet lock order.
    await loadEmployeeForLeave(ctx.trx, ctx.orgId, found.employee_id, true);
    const deleted = await ctx.trx
      .deleteFrom('crove_hr.payroll_leave_entry')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', found.id)
      .returning(['id', 'employee_id'])
      .executeTakeFirst();
    if (!deleted) throw entryNotFound();
    ctx.audit({ entryId: deleted.id, employeeId: deleted.employee_id });
    return { employeeId: deleted.employee_id, entryId: deleted.id, deleted: true };
  },
});

export const leaveBalance = defineQuery({
  name: 'hr.payroll.leave.balance',
  input: zHrLeaveBalanceAsk,
  access: MANAGERS,
  sensitive: true,
  target: (input: { employeeId: string }) => ({ type: 'hr.payroll_employee', id: input.employeeId }),
  handler: async (ctx, input): Promise<HrLeaveBalanceResult> => {
    userOf(ctx.actor);
    const employee = await loadEmployeeForLeave(ctx.trx, ctx.orgId, input.employeeId, false);
    const firstTerm = await ctx.trx
      .selectFrom('crove_hr.payroll_employment')
      .select(['effective_from'])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', employee.id)
      .orderBy('effective_from', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (!firstTerm) throw employeeNotFound();
    const rows = await ctx.trx
      .selectFrom('crove_hr.payroll_leave_entry')
      .select(['id', 'employee_id', 'month', 'kind', 'days', 'approved'])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', employee.id)
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
    const hireDate = iso(firstTerm.effective_from);
    const endedOn = employee.ended_on === null ? null : iso(employee.ended_on);
    let balance: ReturnType<typeof calculateLeaveBalance>;
    try {
      balance = calculateLeaveBalance(
        {
          year: input.year,
          category: input.category,
          hireDate,
          endedOn,
          entries: entries.map((e) => ({ kind: e.kind, month: e.month, days: e.days, approved: e.approved })),
          ...(input.asOfMonth !== undefined ? { asOfMonth: input.asOfMonth } : {}),
          ...(input.workweek !== undefined ? { workweek: input.workweek } : {}),
        },
        PAYROLL_RULES,
      );
    } catch (error) {
      if (error instanceof PayrollRefusedError) {
        throw new DomainError('HR_LEAVE_BALANCE_UNAVAILABLE', 422, error.message);
      }
      throw error;
    }
    return {
      employeeId: employee.id,
      year: input.year,
      category: input.category,
      hireDate,
      endedOn,
      entries,
      balance,
    };
  },
});

export const hrLeaveCommands = [leaveSet, leaveDelete];
export const hrLeaveQueries = [leaveBalance];

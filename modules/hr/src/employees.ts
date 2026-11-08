// SPDX-License-Identifier: AGPL-3.0-only
// Employees, their employment terms and their dependents (issue #2530; payroll plan docs/plan/payroll.md §6.1 and §6.6, ADR-0046, ADR-0017). Owners and admins only: the commands'
// and queries' access says so and so do the database's policies (crove_hr's owner_admin), so a member, a viewer, an agent or the system reads and writes none of it.
//
// What a person's record holds, and where:
// - the identity number and the bank account number are sealed under the person's own key (ctx.seal under the subject `employee:<id>`, ADR-0017). A command takes them as input
//   and declares them in `sealedInput`, so the runtime keeps them out of every hash, response, event, statement and error; only the sensitive query `hr.payroll.employee.get`
//   opens them, for the one employee asked for. No image of an identity document is stored anywhere.
// - the name and the address are pii: the erasure clears them (a placeholder), after the person's key is shredded.
// - the terms (contract type, region, base wage) are rows that are never edited: a raise is a new row, so a past month recomputes to the same figures.
//
// Audit facts carry ids, counts, the changed field names and a marker for every classified value (auditValue), never a value. Results carry ids only (idempotency rows keep them).
import { sql } from 'kysely';
import type { MemberRole } from '@crove/db';
import { kernelManifest } from '@crove/kernel';
import {
  HR_ERASED_NAME,
  HR_RETENTION_YEARS,
  auditValue,
  tableWrite,
  zHrDependentAdd,
  zHrDependentEnd,
  zHrEmployeeAdd,
  zHrEmployeeEdit,
  zHrEmployeeEnd,
  zHrEmployeeList,
  zHrEmployeeRef,
  zHrEmploymentAdd,
  zHrFinalizationSet,
  type HrDependentView,
  type HrEmployee,
  type HrEmployeeErased,
  type HrEmployeeSummary,
  type HrEmploymentView,
  type HrWritten,
} from '@crove/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { hrManifest } from './manifest.ts';

const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const OWNERS: readonly MemberRole[] = ['owner'];
const EMPLOYEE = hrManifest.tables.crove_hr.payroll_employee;
const DEPENDENT = hrManifest.tables.crove_hr.payroll_dependent;
const EMPLOYMENT = hrManifest.tables.crove_hr.payroll_employment;

// Where the sealed values are stored: a value opens only at the place it was sealed for (ctx.open), so a sealed text copied to another column never reads.
export const IDENTITY_PLACE = 'crove_hr.payroll_employee.national_id_sealed';
export const ACCOUNT_PLACE = 'crove_hr.payroll_employee.bank_account_sealed';
export const TAX_CODE_PLACE = 'crove_hr.payroll_employee.tax_code_sealed';
export const INSURANCE_PLACE = 'crove_hr.payroll_employee.insurance_number_sealed';
// The subject every sealed value of one person is under: one key to shred.
export const subjectOf = (employeeId: string): string => `employee:${employeeId}`;

const EMPLOYEE_COLUMNS = ['org_id', 'id', 'legal_entity_id', 'display_name', 'address', 'national_id_sealed', 'bank_account_sealed', 'birth_date', 'tax_code_sealed', 'insurance_number_sealed', 'created_by', 'created_at', 'updated_at'] as const;
const EMPLOYMENT_COLUMNS = ['org_id', 'id', 'legal_entity_id', 'employee_id', 'effective_from', 'contract_type', 'region', 'base_wage', 'pay_function', 'created_by', 'created_at'] as const;
const DEPENDENT_COLUMNS = ['org_id', 'id', 'legal_entity_id', 'employee_id', 'display_name', 'relation', 'registered_on', 'created_by', 'created_at'] as const;

const userOf = (actor: QueryContext['actor']): string => {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
};

const notFound = () => new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên này');
const erasedError = () => new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên này đã được xóa theo yêu cầu, không sửa được nữa');

// Today as a date in Vietnam (UTC+7), the day an employment's start is compared with.
export const vietnamDay = (now: Date): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

const iso = (value: Date | string): string => (typeof value === 'string' ? value : value.toISOString().slice(0, 10));

type Ctx = CommandContext;

// The org's legal entity a new employee belongs to: the one named (it must exist), else the org's default entity.
export async function resolveEntity(ctx: Pick<QueryContext, 'trx' | 'orgId'>, requested: string | undefined): Promise<string> {
  const row = requested
    ? await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('id', '=', requested).executeTakeFirst()
    : await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('is_default', '=', true).executeTakeFirst();
  if (!row) throw new DomainError('HR_LEGAL_ENTITY_REQUIRED', 422, 'Hãy chọn pháp nhân của nhân viên');
  return row.id;
}

// An employee row, locked for the change that follows. An erased one cannot be changed any more.
async function loadEmployee(ctx: Ctx, employeeId: string, options: { allowErased?: boolean } = {}) {
  const row = await ctx.trx
    .selectFrom('crove_hr.payroll_employee')
    .select(['id', 'legal_entity_id', 'status', 'ended_on', 'erased_at'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', employeeId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound();
  if (row.erased_at !== null && !options.allowErased) throw erasedError();
  return row;
}

const requireActive = (employee: { status: string }): void => {
  if (employee.status !== 'active') throw new DomainError('HR_EMPLOYEE_ENDED', 409, 'Nhân viên này đã nghỉ việc');
};

const targetOf = (input: { employeeId: string }) => ({ type: 'hr.payroll_employee', id: input.employeeId });

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

export const employeeAdd = defineCommand({
  name: 'hr.payroll.employee.add',
  input: zHrEmployeeAdd,
  // The identity number and the account number are sealed under the new person's key; the runtime keeps them out of every record the command leaves.
  sealedInput: ['identityNumber', 'accountNumber', 'taxCode', 'insuranceNumber'],
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employee', EMPLOYEE_COLUMNS),
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employment', EMPLOYMENT_COLUMNS),
  ],
  handler: async (ctx, input): Promise<HrWritten> => {
    const userId = userOf(ctx.actor);
    const legalEntityId = await resolveEntity(ctx, input.legalEntityId);
    // The id first: the subject of the sealed values names it.
    const { rows } = await sql<{ id: string }>`SELECT crove_kernel.uuid_v7() AS id`.execute(ctx.trx);
    const employeeId = rows[0]?.id;
    if (!employeeId) throw new DomainError('INTERNAL', 500, 'Lỗi hệ thống');
    const subject = subjectOf(employeeId);
    const identity = input.identityNumber === undefined ? null : await ctx.seal(subject, IDENTITY_PLACE, input.identityNumber);
    const account = input.accountNumber === undefined ? null : await ctx.seal(subject, ACCOUNT_PLACE, input.accountNumber);
    const taxSealed = input.taxCode === undefined ? null : await ctx.seal(subject, TAX_CODE_PLACE, input.taxCode);
    const insuranceSealed = input.insuranceNumber === undefined ? null : await ctx.seal(subject, INSURANCE_PLACE, input.insuranceNumber);
    await ctx.trx
      .insertInto('crove_hr.payroll_employee')
      .values({
        org_id: ctx.orgId,
        id: employeeId,
        legal_entity_id: legalEntityId,
        display_name: input.displayName,
        address: input.address ?? null,
        national_id_sealed: identity,
        bank_account_sealed: account,
        birth_date: input.birthDate ?? null,
        tax_code_sealed: taxSealed,
        insurance_number_sealed: insuranceSealed,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .execute();
    const terms = input.employment;
    const employment = await ctx.trx
      .insertInto('crove_hr.payroll_employment')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: legalEntityId,
        employee_id: employeeId,
        effective_from: terms.effectiveFrom,
        contract_type: terms.contractType,
        region: terms.region,
        base_wage: terms.baseWage,
        pay_function: terms.payFunction,
        created_by: userId,
        created_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({
      employeeId,
      employmentId: employment.id,
      legalEntityId,
      name: auditValue(EMPLOYEE, 'display_name', input.displayName),
      address: auditValue(EMPLOYEE, 'address', input.address ?? null),
      hasIdentityNumber: identity !== null,
      hasAccountNumber: account !== null,
      hasTaxNumber: taxSealed !== null,
      hasInsuranceNo: insuranceSealed !== null,
      birth: auditValue(EMPLOYEE, 'birth_date', input.birthDate ?? null),
      effectiveFrom: terms.effectiveFrom,
      contractType: terms.contractType,
      region: terms.region,
      payFunction: terms.payFunction,
      baseWage: auditValue(EMPLOYMENT, 'base_wage', terms.baseWage),
    });
    return { employeeId, employmentId: employment.id };
  },
});

export const employeeEdit = defineCommand({
  name: 'hr.payroll.employee.edit',
  input: zHrEmployeeEdit,
  sealedInput: ['identityNumber', 'accountNumber', 'taxCode', 'insuranceNumber'],
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: targetOf,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employee', ['display_name', 'address', 'national_id_sealed', 'bank_account_sealed', 'birth_date', 'tax_code_sealed', 'insurance_number_sealed', 'updated_at'])],
  handler: async (ctx, input): Promise<HrWritten> => {
    // A former employee's record is kept as it is for the retention: no change, and no clearing of the numbers, the name or the address; the owner's erasure is the way out. The one
    // exception is what the declarations need of a leaver (#2533): the birth date, the tax code and the insurance number may be set or corrected, audited like any edit.
    const employee = await loadEmployee(ctx, input.employeeId);
    if (employee.status !== 'active' && (input.displayName !== undefined || input.address !== undefined || input.identityNumber !== undefined || input.accountNumber !== undefined)) requireActive(employee);
    const subject = subjectOf(input.employeeId);
    const changed: string[] = [];
    const set: {
      display_name?: string;
      address?: string | null;
      national_id_sealed?: string | null;
      bank_account_sealed?: string | null;
      birth_date?: string | null;
      tax_code_sealed?: string | null;
      insurance_number_sealed?: string | null;
      updated_at: Date;
    } = { updated_at: ctx.now };
    if (input.displayName !== undefined) {
      set.display_name = input.displayName;
      changed.push('displayName');
    }
    if (input.address !== undefined) {
      set.address = input.address;
      changed.push('address');
    }
    if (input.identityNumber !== undefined) {
      set.national_id_sealed = input.identityNumber === null ? null : await ctx.seal(subject, IDENTITY_PLACE, input.identityNumber);
      changed.push('identityNumber');
    }
    if (input.accountNumber !== undefined) {
      set.bank_account_sealed = input.accountNumber === null ? null : await ctx.seal(subject, ACCOUNT_PLACE, input.accountNumber);
      changed.push('accountNumber');
    }
    if (input.birthDate !== undefined) {
      set.birth_date = input.birthDate;
      changed.push('birthDate');
    }
    if (input.taxCode !== undefined) {
      set.tax_code_sealed = input.taxCode === null ? null : await ctx.seal(subject, TAX_CODE_PLACE, input.taxCode);
      changed.push('taxCode');
    }
    if (input.insuranceNumber !== undefined) {
      set.insurance_number_sealed = input.insuranceNumber === null ? null : await ctx.seal(subject, INSURANCE_PLACE, input.insuranceNumber);
      changed.push('insuranceNumber');
    }
    await ctx.trx.updateTable('crove_hr.payroll_employee').set(set).where('org_id', '=', ctx.orgId).where('id', '=', input.employeeId).execute();
    ctx.audit({ employeeId: input.employeeId, changed });
    return { employeeId: input.employeeId };
  },
});

// The person's authorization for the payer to finalize their income tax for a year (08/UQ-QTT-TNCN, #2533). A fact about the person, not a payroll figure: a former employee's
// record is not changed (the ended person finalizes alone), and the list holds a year once.
export const employeeFinalizationSet = defineCommand({
  name: 'hr.payroll.employee.finalization.set',
  input: zHrFinalizationSet,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: targetOf,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employee', ['finalization_authorized_years', 'updated_at'])],
  handler: async (ctx, input): Promise<HrWritten> => {
    requireActive(await loadEmployee(ctx, input.employeeId));
    // A year that has not begun cannot be authorized yet (Vietnam's year).
    if (input.year > Number(vietnamDay(ctx.now).slice(0, 4))) throw new DomainError('HR_YEAR_NOT_BEGUN', 422, 'Chưa thể ghi nhận ủy quyền cho một năm chưa bắt đầu');
    const row = await ctx.trx.selectFrom('crove_hr.payroll_employee').select('finalization_authorized_years').where('org_id', '=', ctx.orgId).where('id', '=', input.employeeId).executeTakeFirstOrThrow();
    const years = new Set<number>(row.finalization_authorized_years);
    if (input.authorized) years.add(input.year);
    else years.delete(input.year);
    await ctx.trx
      .updateTable('crove_hr.payroll_employee')
      .set({ finalization_authorized_years: [...years].sort((a, b) => a - b), updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.employeeId)
      .execute();
    ctx.audit({ employeeId: input.employeeId, year: input.year, authorized: input.authorized });
    return { employeeId: input.employeeId };
  },
});

export const employmentAdd = defineCommand({
  name: 'hr.payroll.employment.add',
  input: zHrEmploymentAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: targetOf,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employment', EMPLOYMENT_COLUMNS)],
  handler: async (ctx, input): Promise<HrWritten> => {
    const employee = await loadEmployee(ctx, input.employeeId);
    requireActive(employee);
    // A new row starts after the newest one: a past month keeps the figures it was computed with.
    const newest = await ctx.trx
      .selectFrom('crove_hr.payroll_employment')
      .select('effective_from')
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', input.employeeId)
      .orderBy('effective_from', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (newest && input.effectiveFrom <= iso(newest.effective_from)) {
      throw new DomainError('HR_EMPLOYMENT_NOT_NEWER', 422, 'Ngày hiệu lực phải sau ngày hiệu lực của dòng gần nhất');
    }
    const row = await ctx.trx
      .insertInto('crove_hr.payroll_employment')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: employee.legal_entity_id,
        employee_id: input.employeeId,
        effective_from: input.effectiveFrom,
        contract_type: input.contractType,
        region: input.region,
        base_wage: input.baseWage,
        pay_function: input.payFunction,
        created_by: userOf(ctx.actor),
        created_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({
      employeeId: input.employeeId,
      employmentId: row.id,
      effectiveFrom: input.effectiveFrom,
      contractType: input.contractType,
      region: input.region,
      payFunction: input.payFunction,
      baseWage: auditValue(EMPLOYMENT, 'base_wage', input.baseWage),
    });
    return { employeeId: input.employeeId, employmentId: row.id };
  },
});

export const employeeEnd = defineCommand({
  name: 'hr.payroll.employee.end',
  input: zHrEmployeeEnd,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: targetOf,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employee', ['status', 'ended_on', 'updated_at'])],
  handler: async (ctx, input): Promise<HrWritten> => {
    const employee = await loadEmployee(ctx, input.employeeId);
    requireActive(employee);
    // The last day of work cannot come before the first day of the first terms. A raise already scheduled after it stays as it is: its row cannot be changed.
    const first = await ctx.trx
      .selectFrom('crove_hr.payroll_employment')
      .select('effective_from')
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', input.employeeId)
      .orderBy('effective_from', 'asc')
      .limit(1)
      .executeTakeFirst();
    if (first && input.endedOn < iso(first.effective_from)) {
      throw new DomainError('HR_END_BEFORE_START', 422, 'Ngày nghỉ việc không thể trước ngày bắt đầu làm việc');
    }
    await ctx.trx
      .updateTable('crove_hr.payroll_employee')
      .set({ status: 'ended', ended_on: input.endedOn, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.employeeId)
      .execute();
    ctx.audit({ employeeId: input.employeeId, endedOn: input.endedOn });
    return { employeeId: input.employeeId };
  },
});

export const dependentAdd = defineCommand({
  name: 'hr.payroll.dependent.add',
  input: zHrDependentAdd,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: targetOf,
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_dependent', DEPENDENT_COLUMNS)],
  handler: async (ctx, input): Promise<HrWritten> => {
    const employee = await loadEmployee(ctx, input.employeeId);
    requireActive(employee);
    const row = await ctx.trx
      .insertInto('crove_hr.payroll_dependent')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: employee.legal_entity_id,
        employee_id: input.employeeId,
        display_name: input.displayName,
        relation: input.relation,
        registered_on: input.registeredOn,
        created_by: userOf(ctx.actor),
        created_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({
      employeeId: input.employeeId,
      dependentId: row.id,
      name: auditValue(DEPENDENT, 'display_name', input.displayName),
      relation: input.relation,
      registeredOn: input.registeredOn,
    });
    return { employeeId: input.employeeId, dependentId: row.id };
  },
});

export const dependentEnd = defineCommand({
  name: 'hr.payroll.dependent.end',
  input: zHrDependentEnd,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  permission: 'hr.payroll.run',
  target: (input: { dependentId: string }) => ({ type: 'hr.payroll_dependent', id: input.dependentId }),
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_dependent', ['ended_on'])],
  handler: async (ctx, input): Promise<HrWritten> => {
    const dependent = await ctx.trx
      .selectFrom('crove_hr.payroll_dependent')
      .select(['id', 'employee_id', 'registered_on', 'ended_on'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.dependentId)
      .forUpdate()
      .executeTakeFirst();
    if (!dependent) throw new DomainError('HR_DEPENDENT_NOT_FOUND', 404, 'Không tìm thấy người phụ thuộc này');
    await loadEmployee(ctx, dependent.employee_id);
    if (dependent.ended_on !== null) throw new DomainError('HR_DEPENDENT_ENDED', 409, 'Người phụ thuộc này đã được kết thúc');
    if (input.endedOn < iso(dependent.registered_on)) throw new DomainError('HR_DEPENDENT_END_BEFORE_START', 422, 'Ngày kết thúc không thể trước ngày đăng ký');
    await ctx.trx.updateTable('crove_hr.payroll_dependent').set({ ended_on: input.endedOn }).where('org_id', '=', ctx.orgId).where('id', '=', input.dependentId).execute();
    ctx.audit({ employeeId: dependent.employee_id, dependentId: input.dependentId, endedOn: input.endedOn });
    return { employeeId: dependent.employee_id, dependentId: input.dependentId };
  },
});

// The day an ended employee's retention runs out: HR_RETENTION_YEARS after the last day of work.
export function retentionEnds(endedOn: string): string {
  const [year, month, day] = endedOn.split('-').map(Number) as [number, number, number];
  const ends = new Date(Date.UTC(year + HR_RETENTION_YEARS, month - 1, day));
  return ends.toISOString().slice(0, 10);
}

// The erasure of an ended employee after the retention (plan 6.6): the name, the address and the dependents' names are cleared, and the person's key is shredded, so the identity
// number and the account number, which stay in their row byte for byte, can never be opened again. The employment rows stay: amounts that tie to no person. R3 for owners: it
// cannot be undone, so it asks for a fresh second factor first; subject_key_shred itself asserts an owner.
export const employeeErase = defineCommand({
  name: 'hr.payroll.employee.erase',
  input: zHrEmployeeRef,
  risk: 'R3',
  sideEffect: 'irreversible',
  access: OWNERS,
  target: targetOf,
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employee', ['display_name', 'address', 'birth_date', 'erased_at', 'updated_at']),
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_dependent', ['display_name']),
    // The person's key, deleted by crove_kernel.subject_key_shred.
    tableWrite(kernelManifest.tables, 'crove_kernel', 'subject_key', ['ref']),
  ],
  handler: async (ctx, input): Promise<HrEmployeeErased> => {
    const employee = await loadEmployee(ctx, input.employeeId);
    if (employee.status !== 'ended' || employee.ended_on === null) {
      throw new DomainError('HR_EMPLOYEE_NOT_ENDED', 409, 'Chỉ xóa được hồ sơ của nhân viên đã nghỉ việc');
    }
    const until = retentionEnds(iso(employee.ended_on));
    // The record is kept through the end of that day: the erasure may run from the next one.
    if (vietnamDay(ctx.now) <= until) {
      throw new DomainError('HR_RETENTION_NOT_PASSED', 409, `Hồ sơ phải được giữ đến hết ngày ${until} (thời hạn lưu trữ ${HR_RETENTION_YEARS} năm sau ngày nghỉ việc)`);
    }
    const dependents = await ctx.trx
      .updateTable('crove_hr.payroll_dependent')
      .set({ display_name: HR_ERASED_NAME })
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', input.employeeId)
      .returning('id')
      .execute();
    await ctx.trx
      .updateTable('crove_hr.payroll_employee')
      .set({ display_name: HR_ERASED_NAME, address: null, birth_date: null, erased_at: ctx.now, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.employeeId)
      .execute();
    const { rows } = await sql<{ n: number }>`SELECT crove_kernel.subject_key_shred(ARRAY[${subjectOf(input.employeeId)}]::text[]) AS n`.execute(ctx.trx);
    const shreddedKeys = Number(rows[0]?.n ?? 0);
    ctx.audit({ employeeId: input.employeeId, shreddedKeys, dependentsCleared: dependents.length, retentionEnded: until });
    return {
      employeeId: input.employeeId,
      shreddedKeys,
      cleared: ['name', 'address', 'birth date', 'dependents names'],
      kept: [
        { what: 'the identity number, the account number, the tax code and the insurance number', reason: 'They stay in their row, but the key that opens them is deleted: nobody can read them again' },
        { what: 'the employment terms and their wages', reason: 'Amounts that tie to no person once the name is gone; the books keep what accounting law requires' },
      ],
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Queries: every one sensitive (the audit row of the read is committed before it starts).
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------

interface TermsRow {
  id: string;
  employee_id: string;
  effective_from: Date | string;
  contract_type: HrEmploymentView['contractType'];
  region: HrEmploymentView['region'];
  base_wage: string;
  pay_function: HrEmploymentView['payFunction'];
}

const termsView = (r: TermsRow): HrEmploymentView => ({
  id: r.id,
  effectiveFrom: iso(r.effective_from),
  contractType: r.contract_type,
  region: r.region,
  baseWage: r.base_wage,
  payFunction: r.pay_function,
});

// The terms in force on a day: the newest row that starts on or before it, in a list sorted newest first.
const inForce = (terms: readonly HrEmploymentView[], day: string): HrEmploymentView | null => terms.find((t) => t.effectiveFrom <= day) ?? null;

export const employeeList = defineQuery({
  name: 'hr.payroll.employee.list',
  input: zHrEmployeeList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrEmployeeSummary[]> => {
    let q = ctx.trx
      .selectFrom('crove_hr.payroll_employee')
      .select(['id', 'legal_entity_id', 'display_name', 'status', 'ended_on', 'national_id_sealed', 'bank_account_sealed'])
      .where('org_id', '=', ctx.orgId);
    if (input.status !== 'all') q = q.where('status', '=', input.status);
    const employees = await q.orderBy('display_name').orderBy('id').limit(input.limit).execute();
    if (employees.length === 0) return [];
    const terms = await ctx.trx
      .selectFrom('crove_hr.payroll_employment')
      .select(['id', 'employee_id', 'effective_from', 'contract_type', 'region', 'base_wage', 'pay_function'])
      .where('org_id', '=', ctx.orgId)
      .where(
        'employee_id',
        'in',
        employees.map((e) => e.id),
      )
      .orderBy('effective_from', 'desc')
      .execute();
    const byEmployee = new Map<string, HrEmploymentView[]>();
    for (const t of terms) byEmployee.set(t.employee_id, [...(byEmployee.get(t.employee_id) ?? []), termsView(t as TermsRow)]);
    const today = vietnamDay(new Date());
    return employees.map((e) => ({
      id: e.id,
      legalEntityId: e.legal_entity_id,
      displayName: e.display_name,
      status: e.status,
      endedOn: e.ended_on === null ? null : iso(e.ended_on),
      current: inForce(byEmployee.get(e.id) ?? [], today),
      hasIdentityNumber: e.national_id_sealed !== null,
      hasAccountNumber: e.bank_account_sealed !== null,
    }));
  },
});

export const employeeGet = defineQuery({
  name: 'hr.payroll.employee.get',
  input: zHrEmployeeRef,
  access: MANAGERS,
  sensitive: true,
  target: (input: { employeeId: string }) => ({ type: 'hr.payroll_employee', id: input.employeeId }),
  handler: async (ctx, input): Promise<HrEmployee> => {
    const e = await ctx.trx
      .selectFrom('crove_hr.payroll_employee')
      .select(['id', 'legal_entity_id', 'display_name', 'address', 'status', 'ended_on', 'erased_at', 'national_id_sealed', 'bank_account_sealed', 'birth_date', 'tax_code_sealed', 'insurance_number_sealed', 'finalization_authorized_years'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.employeeId)
      .executeTakeFirst();
    if (!e) throw notFound();
    const terms = (
      await ctx.trx
        .selectFrom('crove_hr.payroll_employment')
        .select(['id', 'employee_id', 'effective_from', 'contract_type', 'region', 'base_wage', 'pay_function'])
        .where('org_id', '=', ctx.orgId)
        .where('employee_id', '=', input.employeeId)
        .orderBy('effective_from', 'desc')
        .execute()
    ).map((t) => termsView(t as TermsRow));
    const dependents: HrDependentView[] = (
      await ctx.trx
        .selectFrom('crove_hr.payroll_dependent')
        .select(['id', 'display_name', 'relation', 'registered_on', 'ended_on'])
        .where('org_id', '=', ctx.orgId)
        .where('employee_id', '=', input.employeeId)
        .orderBy('registered_on')
        .orderBy('id')
        .execute()
    ).map((d) => ({
      id: d.id,
      displayName: d.display_name,
      relation: d.relation as HrDependentView['relation'],
      registeredOn: iso(d.registered_on),
      endedOn: d.ended_on === null ? null : iso(d.ended_on),
    }));
    let identityNumber: string | null = null;
    let accountNumber: string | null = null;
    let taxCode: string | null = null;
    let insuranceNumber: string | null = null;
    let erased = e.erased_at !== null;
    if (!erased) {
      // The sealed values opened, here and only here, for this one employee: the audit row of this read is already committed.
      const subject = subjectOf(e.id);
      const items: { sealed: string; place: string; ref: string }[] = [];
      if (e.national_id_sealed !== null) items.push({ sealed: e.national_id_sealed, place: IDENTITY_PLACE, ref: subject });
      if (e.bank_account_sealed !== null) items.push({ sealed: e.bank_account_sealed, place: ACCOUNT_PLACE, ref: subject });
      if (e.tax_code_sealed !== null) items.push({ sealed: e.tax_code_sealed, place: TAX_CODE_PLACE, ref: subject });
      if (e.insurance_number_sealed !== null) items.push({ sealed: e.insurance_number_sealed, place: INSURANCE_PLACE, ref: subject });
      const opened = items.length === 0 ? [] : await ctx.openMany(items);
      let next = 0;
      const take = (present: boolean): string | null => {
        if (!present) return null;
        const value = opened[next++];
        if (typeof value === 'string') return value;
        erased = true;
        return null;
      };
      identityNumber = take(e.national_id_sealed !== null);
      accountNumber = take(e.bank_account_sealed !== null);
      taxCode = take(e.tax_code_sealed !== null);
      insuranceNumber = take(e.insurance_number_sealed !== null);
    }
    return {
      id: e.id,
      legalEntityId: e.legal_entity_id,
      displayName: e.display_name,
      status: e.status,
      endedOn: e.ended_on === null ? null : iso(e.ended_on),
      current: inForce(terms, vietnamDay(new Date())),
      hasIdentityNumber: e.national_id_sealed !== null,
      hasAccountNumber: e.bank_account_sealed !== null,
      address: e.address,
      identityNumber,
      accountNumber,
      birthDate: e.erased_at === null && e.birth_date !== null ? iso(e.birth_date) : null,
      taxCode,
      insuranceNumber,
      finalizationAuthorizedYears: [...e.finalization_authorized_years],
      erased,
      employments: terms,
      dependents,
    };
  },
});

export const hrEmployeeCommands = [employeeAdd, employeeEdit, employeeFinalizationSet, employmentAdd, employeeEnd, dependentAdd, dependentEnd, employeeErase];
export const hrEmployeeQueries = [employeeList, employeeGet];

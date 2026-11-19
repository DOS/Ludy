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
import type { MemberRole } from '@ludy/db';
import { kernelManifest } from '@ludy/kernel';
import {
  HR_ERASED_NAME,
  HR_RETENTION_YEARS,
  auditValue,
  tableWrite,
  zHrDependentAdd,
  zHrDependentEnd,
  zHrEmployeeAdd,
  zHrEmployeeContractPdfAsk,
  zHrEmployeeEdit,
  zHrEmployeeEnd,
  zHrEmployeeList,
  zHrEmployeeRef,
  zHrEmployeeSeveranceAsk,
  zHrEmploymentAdd,
  zHrFinalizationSet,
  zHrPayrollInputs,
  type HrContractAlert,
  type HrContractForm,
  type HrDependentView,
  type HrEmployee,
  type HrEmployeeContractPdf,
  type HrEmployeeErased,
  type HrEmployeeSeveranceResult,
  type HrEmployeeSummary,
  type HrEmploymentTerms,
  type HrEmploymentView,
  type HrPayFunction,
  type HrProbationRoleTier,
  type HrWritten,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { calculateSeveranceAllowance, checkLaborContractTerms, countCompletedCalendarMonths, deriveFixedTermEndDateIso, evaluateContractAlerts, isBankCode, money, sum, toMoney } from '@ludy/l10n-vn';
import {
  contractFilename,
  contractTitle,
  defaultContractNumber,
  defaultEmployeeCode,
  isFlatTaxContract,
  renderLaborContractPdf,
} from './contract-pdf.ts';
import { hrManifest } from './manifest.ts';
import { isoDate as iso, monthEnd, previousMonth, termsInForceForMonth } from './payroll-dates.ts';

export const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
export const OWNERS: readonly MemberRole[] = ['owner'];
export const EMPLOYEE = hrManifest.tables.crove_hr.payroll_employee;
const DEPENDENT = hrManifest.tables.crove_hr.payroll_dependent;
export const EMPLOYMENT = hrManifest.tables.crove_hr.payroll_employment;

// Where the sealed values are stored: a value opens only at the place it was sealed for (ctx.open), so a sealed text copied to another column never reads.
export const IDENTITY_PLACE = 'crove_hr.payroll_employee.national_id_sealed';
export const ACCOUNT_PLACE = 'crove_hr.payroll_employee.bank_account_sealed';
export const TAX_CODE_PLACE = 'crove_hr.payroll_employee.tax_code_sealed';
export const INSURANCE_PLACE = 'crove_hr.payroll_employee.insurance_number_sealed';
// The subject every sealed value of one person is under: one key to shred.
export const subjectOf = (employeeId: string): string => `employee:${employeeId}`;

export const EMPLOYEE_COLUMNS = ['org_id', 'id', 'legal_entity_id', 'department_id', 'job_title', 'display_name', 'address', 'national_id_sealed', 'bank_account_sealed', 'bank_code', 'birth_date', 'tax_code_sealed', 'insurance_number_sealed', 'created_by', 'created_at', 'updated_at'] as const;
export const EMPLOYMENT_COLUMNS = [
  'org_id',
  'id',
  'legal_entity_id',
  'employee_id',
  'effective_from',
  'contract_type',
  'contract_form',
  'term_months',
  'contract_end_on',
  'fixed_term_sequence',
  'probation_role_tier',
  'probation_end_on',
  'probation_wage',
  'region',
  'base_wage',
  'pay_function',
  'created_by',
  'created_at',
] as const;
const DEPENDENT_COLUMNS = ['org_id', 'id', 'legal_entity_id', 'employee_id', 'display_name', 'relation', 'registered_on', 'created_by', 'created_at'] as const;

interface PreparedEmploymentRow {
  effective_from: string;
  contract_type: HrEmploymentTerms['contractType'];
  contract_form: HrContractForm | null;
  term_months: number | null;
  contract_end_on: string | null;
  fixed_term_sequence: number | null;
  probation_role_tier: HrProbationRoleTier | null;
  probation_end_on: string | null;
  probation_wage: string | null;
  region: HrEmploymentTerms['region'];
  base_wage: string;
  pay_function: HrEmploymentTerms['payFunction'];
}

type EmploymentTermsInput = Omit<HrEmploymentTerms, 'payFunction'> & { payFunction?: HrPayFunction | undefined };

export function prepareEmploymentTerms(terms: EmploymentTermsInput, defaultPayFunction: HrPayFunction = 'admin'): PreparedEmploymentRow {
  const contractForm = terms.contractForm ?? null;
  const termMonths = terms.termMonths ?? null;
  const fixedTermSequence = terms.fixedTermSequence ?? null;
  const probationRoleTier = terms.probationRoleTier ?? null;
  const probationEndOn = terms.probationEndOn ?? null;
  const probationWage = terms.probationWage ?? null;
  const contractEndOn =
    terms.contractEndOn ??
    (terms.contractType === 'fixed_term' && termMonths !== null
      ? deriveFixedTermEndDateIso(terms.effectiveFrom, termMonths)
      : null);

  const hasMetadata =
    contractForm !== null ||
    termMonths !== null ||
    contractEndOn !== null ||
    fixedTermSequence !== null ||
    probationRoleTier !== null ||
    probationEndOn !== null ||
    probationWage !== null;

  if (hasMetadata) {
    const hasProbation = probationRoleTier !== null || probationEndOn !== null || probationWage !== null;
    const check = checkLaborContractTerms({
      contractKind: terms.contractType === 'none' ? 'under_one_month' : terms.contractType,
      ...(contractForm !== null ? { form: contractForm } : {}),
      startDate: terms.effectiveFrom,
      endDate: contractEndOn,
      termMonths,
      fixedTermSequence,
      contractWage: terms.baseWage,
      probation: hasProbation
        ? {
            roleTier: probationRoleTier ?? '',
            startDate: terms.effectiveFrom,
            endDate: probationEndOn,
            wage: probationWage,
          }
        : null,
    });
    const errorFindings = check.findings.filter((f) => f.severity === 'error');
    if (terms.contractType !== 'fixed_term' && (termMonths !== null || fixedTermSequence !== null)) {
      if (fixedTermSequence !== null && !errorFindings.some((f) => f.field === 'fixedTermSequence')) {
        errorFindings.push({
          code: 'invalid_fixed_term_sequence',
          severity: 'error',
          field: 'fixedTermSequence',
          message: 'fixedTermSequence is only valid for fixed_term contracts.',
          cite: 'Labor Code 2019 Art. 20(2)',
        });
      }
      if (termMonths !== null && !errorFindings.some((f) => f.field === 'termMonths')) {
        errorFindings.push({
          code: 'invalid_fixed_term_duration',
          severity: 'error',
          field: 'termMonths',
          message: 'termMonths is only valid for fixed_term contracts.',
          cite: 'Labor Code 2019 Art. 20(1)(b)',
        });
      }
    }
    if (errorFindings.length > 0) {
      throw new DomainError(
        'HR_CONTRACT_INVALID',
        422,
        'Thông tin hợp đồng hoặc thử việc chưa đáp ứng quy định của Bộ luật Lao động 2019',
        { findings: errorFindings },
      );
    }
  }

  return {
    effective_from: terms.effectiveFrom,
    contract_type: terms.contractType,
    contract_form: contractForm,
    term_months: termMonths,
    contract_end_on: contractEndOn,
    fixed_term_sequence: fixedTermSequence,
    probation_role_tier: probationRoleTier,
    probation_end_on: probationEndOn,
    probation_wage: probationWage,
    region: terms.region,
    base_wage: terms.baseWage,
    pay_function: terms.payFunction ?? defaultPayFunction,
  };
}

export const userOf = (actor: QueryContext['actor']): string => {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ người dùng mới thực hiện được việc này');
  return actor.userId;
};

const notFound = () => new DomainError('HR_EMPLOYEE_NOT_FOUND', 404, 'Không tìm thấy nhân viên này');
const erasedError = () => new DomainError('HR_EMPLOYEE_ERASED', 409, 'Hồ sơ nhân viên này đã được xóa theo yêu cầu, không sửa được nữa');

// Today as a date in Vietnam (UTC+7), the day an employment's start is compared with.
export const vietnamDay = (now: Date): string => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

type Ctx = CommandContext;

// The org's legal entity a new employee belongs to: the one named (it must exist), else the org's default entity.
export async function resolveEntity(ctx: Pick<QueryContext, 'trx' | 'orgId'>, requested: string | undefined): Promise<string> {
  const row = requested
    ? await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('id', '=', requested).executeTakeFirst()
    : await ctx.trx.selectFrom('crove_kernel.legal_entity').select('id').where('org_id', '=', ctx.orgId).where('is_default', '=', true).executeTakeFirst();
  if (!row) throw new DomainError('HR_LEGAL_ENTITY_REQUIRED', 422, 'Hãy chọn pháp nhân của nhân viên');
  return row.id;
}

// A bank code of the list kept as data in @ludy/l10n-vn: a code that is not in it is refused, so the file cut by bank never meets a code nobody can name (#2897).
function requireKnownBank(code: string | null | undefined): void {
  if (code !== null && code !== undefined && !isBankCode(code)) throw new DomainError('HR_BANK_UNKNOWN', 422, 'Ngân hàng này chưa có trong danh sách');
}

// An employee row, locked for the change that follows. An erased one cannot be changed any more.
async function loadEmployee(ctx: Ctx, employeeId: string, options: { allowErased?: boolean } = {}) {
  const row = await ctx.trx
    .selectFrom('crove_hr.payroll_employee')
    .select(['id', 'legal_entity_id', 'department_id', 'status', 'ended_on', 'erased_at'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', employeeId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw notFound();
  if (row.erased_at !== null && !options.allowErased) throw erasedError();
  return row;
}

export async function resolveDepartment(
  ctx: Pick<Ctx, 'trx' | 'orgId'>,
  departmentId: string,
  legalEntityId: string,
  currentDepartmentId: string | null = null,
): Promise<{ id: string; name: string; payFunction: HrPayFunction }> {
  const dept = await ctx.trx
    .selectFrom('crove_hr.department')
    .select(['id', 'legal_entity_id', 'name', 'pay_function', 'archived_at'])
    .where('org_id', '=', ctx.orgId)
    .where('id', '=', departmentId)
    .forShare()
    .executeTakeFirst();
  if (!dept) throw new DomainError('HR_DEPARTMENT_NOT_FOUND', 404, 'Không tìm thấy phòng ban này');
  if (dept.legal_entity_id !== legalEntityId) {
    throw new DomainError('HR_DEPARTMENT_WRONG_ENTITY', 422, 'Phòng ban không thuộc pháp nhân của nhân viên');
  }
  if (dept.archived_at !== null && currentDepartmentId !== dept.id) {
    throw new DomainError('HR_DEPARTMENT_ARCHIVED', 409, 'Phòng ban này đã ngừng sử dụng, không thể gán cho nhân viên');
  }
  return { id: dept.id, name: dept.name, payFunction: dept.pay_function };
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
    requireKnownBank(input.bankCode);
    const legalEntityId = await resolveEntity(ctx, input.legalEntityId);
    const dept = input.departmentId === undefined ? null : await resolveDepartment(ctx, input.departmentId, legalEntityId);
    const prepared = prepareEmploymentTerms(input.employment, dept?.payFunction ?? 'admin');
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
        department_id: dept?.id ?? null,
        job_title: input.jobTitle ?? null,
        display_name: input.displayName,
        address: input.address ?? null,
        national_id_sealed: identity,
        bank_account_sealed: account,
        bank_code: input.bankCode ?? null,
        birth_date: input.birthDate ?? null,
        tax_code_sealed: taxSealed,
        insurance_number_sealed: insuranceSealed,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .execute();
    const employment = await ctx.trx
      .insertInto('crove_hr.payroll_employment')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: legalEntityId,
        employee_id: employeeId,
        ...prepared,
        created_by: userId,
        created_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({
      employeeId,
      employmentId: employment.id,
      legalEntityId,
      departmentId: dept?.id ?? null,
      hasJobTitle: input.jobTitle !== undefined,
      name: auditValue(EMPLOYEE, 'display_name', input.displayName),
      address: auditValue(EMPLOYEE, 'address', input.address ?? null),
      hasIdentityNumber: identity !== null,
      hasAccountNumber: account !== null,
      bank: auditValue(EMPLOYEE, 'bank_code', input.bankCode ?? null),
      hasTaxNumber: taxSealed !== null,
      hasInsuranceNo: insuranceSealed !== null,
      birth: auditValue(EMPLOYEE, 'birth_date', input.birthDate ?? null),
      effectiveFrom: prepared.effective_from,
      contractType: prepared.contract_type,
      contractForm: prepared.contract_form,
      termMonths: prepared.term_months,
      contractEndOn: prepared.contract_end_on,
      fixedTermSequence: prepared.fixed_term_sequence,
      probationRoleTier: prepared.probation_role_tier,
      probationEndOn: prepared.probation_end_on,
      probationWage: auditValue(EMPLOYMENT, 'probation_wage', prepared.probation_wage),
      region: prepared.region,
      payFunction: prepared.pay_function,
      baseWage: auditValue(EMPLOYMENT, 'base_wage', prepared.base_wage),
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
  writes: [tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employee', ['display_name', 'address', 'national_id_sealed', 'bank_account_sealed', 'bank_code', 'birth_date', 'tax_code_sealed', 'insurance_number_sealed', 'department_id', 'job_title', 'updated_at'])],
  handler: async (ctx, input): Promise<HrWritten> => {
    // A former employee's record is kept as it is for the retention: no change, and no clearing of the numbers, the name or the address; the owner's erasure is the way out. The one
    // exceptions are what a leaver still needs: for the declarations (#2533) the birth date, the tax code and the insurance number, and for paying what is still owed (a final month, a
    // refund) the account number and the bank (#2905); all audited like any edit. An erased person is refused by loadEmployee before this point.
    requireKnownBank(input.bankCode);
    const employee = await loadEmployee(ctx, input.employeeId);
    if (
      employee.status !== 'active' &&
      (input.displayName !== undefined ||
        input.address !== undefined ||
        input.identityNumber !== undefined ||
        input.departmentId !== undefined ||
        input.jobTitle !== undefined)
    ) {
      requireActive(employee);
    }
    const subject = subjectOf(input.employeeId);
    const changed: string[] = [];
    const set: {
      display_name?: string;
      address?: string | null;
      national_id_sealed?: string | null;
      bank_account_sealed?: string | null;
      bank_code?: string | null;
      birth_date?: string | null;
      tax_code_sealed?: string | null;
      insurance_number_sealed?: string | null;
      department_id?: string | null;
      job_title?: string | null;
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
    if (input.bankCode !== undefined) {
      set.bank_code = input.bankCode;
      changed.push('bankCode');
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
    if (input.departmentId !== undefined) {
      if (input.departmentId === null) {
        set.department_id = null;
      } else {
        const dept = await resolveDepartment(ctx, input.departmentId, employee.legal_entity_id, employee.department_id);
        set.department_id = dept.id;
      }
      changed.push('departmentId');
    }
    if (input.jobTitle !== undefined) {
      set.job_title = input.jobTitle;
      changed.push('jobTitle');
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
    const prepared = prepareEmploymentTerms(input);
    const row = await ctx.trx
      .insertInto('crove_hr.payroll_employment')
      .values({
        org_id: ctx.orgId,
        legal_entity_id: employee.legal_entity_id,
        employee_id: input.employeeId,
        ...prepared,
        created_by: userOf(ctx.actor),
        created_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ctx.audit({
      employeeId: input.employeeId,
      employmentId: row.id,
      effectiveFrom: prepared.effective_from,
      contractType: prepared.contract_type,
      contractForm: prepared.contract_form,
      termMonths: prepared.term_months,
      contractEndOn: prepared.contract_end_on,
      fixedTermSequence: prepared.fixed_term_sequence,
      probationRoleTier: prepared.probation_role_tier,
      probationEndOn: prepared.probation_end_on,
      probationWage: auditValue(EMPLOYMENT, 'probation_wage', prepared.probation_wage),
      region: prepared.region,
      payFunction: prepared.pay_function,
      baseWage: auditValue(EMPLOYMENT, 'base_wage', prepared.base_wage),
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

// The erasure of an ended employee after the retention (plan 6.6): the name, the address, the birth date, the bank and the dependents' names are cleared, and the person's key is shredded, so the identity
// number and the account number, which stay in their row byte for byte, can never be opened again. The employment rows stay: amounts that tie to no person. R3 for owners: it
// cannot be undone, so it asks for a fresh second factor first; subject_key_shred itself asserts an owner.
export const employeeErase = defineCommand({
  name: 'hr.payroll.employee.erase',
  runsWhenOff: 'erases an ended employee\'s personal data after the retention, which the owner may still do while the app is off',
  input: zHrEmployeeRef,
  risk: 'R3',
  sideEffect: 'irreversible',
  access: OWNERS,
  target: targetOf,
  writes: [
    tableWrite(hrManifest.tables, 'crove_hr', 'payroll_employee', ['display_name', 'address', 'birth_date', 'bank_code', 'department_id', 'job_title', 'erased_at', 'updated_at']),
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
      .set({ display_name: HR_ERASED_NAME, address: null, birth_date: null, bank_code: null, department_id: null, job_title: null, erased_at: ctx.now, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.employeeId)
      .execute();
    const { rows } = await sql<{ n: number }>`SELECT crove_kernel.subject_key_shred(ARRAY[${subjectOf(input.employeeId)}]::text[]) AS n`.execute(ctx.trx);
    const shreddedKeys = Number(rows[0]?.n ?? 0);
    ctx.audit({ employeeId: input.employeeId, shreddedKeys, dependentsCleared: dependents.length, retentionEnded: until });
    return {
      employeeId: input.employeeId,
      shreddedKeys,
      cleared: ['name', 'address', 'birth date', 'bank', 'department', 'job title', 'dependents names'],
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

const TERMS_SELECT_COLUMNS = [
  'id',
  'employee_id',
  'effective_from',
  'contract_type',
  'contract_form',
  'term_months',
  'contract_end_on',
  'fixed_term_sequence',
  'probation_role_tier',
  'probation_end_on',
  'probation_wage',
  'region',
  'base_wage',
  'pay_function',
] as const;

interface TermsRow {
  id: string;
  employee_id: string;
  effective_from: Date | string;
  contract_type: HrEmploymentView['contractType'];
  contract_form: HrEmploymentView['contractForm'];
  term_months: number | null;
  contract_end_on: Date | string | null;
  fixed_term_sequence: number | null;
  probation_role_tier: HrEmploymentView['probationRoleTier'];
  probation_end_on: Date | string | null;
  probation_wage: string | null;
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
  contractForm: r.contract_form,
  termMonths: r.term_months,
  contractEndOn: r.contract_end_on === null ? null : iso(r.contract_end_on),
  fixedTermSequence: r.fixed_term_sequence,
  probationRoleTier: r.probation_role_tier,
  probationEndOn: r.probation_end_on === null ? null : iso(r.probation_end_on),
  probationWage: r.probation_wage,
});

function contractAlertsFor(status: 'active' | 'ended', current: HrEmploymentView | null, asOf: string): HrContractAlert[] {
  if (status !== 'active' || current === null) return [];
  if (
    current.termMonths === null &&
    current.contractEndOn === null &&
    current.fixedTermSequence === null &&
    current.probationEndOn === null
  ) {
    return [];
  }
  return evaluateContractAlerts(
    {
      contractKind: current.contractType === 'none' ? 'under_one_month' : current.contractType,
      ...(current.contractForm !== null ? { form: current.contractForm } : {}),
      startDate: current.effectiveFrom,
      endDate: current.contractEndOn,
      termMonths: current.termMonths,
      fixedTermSequence: current.fixedTermSequence,
      contractWage: current.baseWage,
      ...(current.probationEndOn !== null
        ? {
            probation: {
              roleTier: current.probationRoleTier ?? 'other',
              startDate: current.effectiveFrom,
              endDate: current.probationEndOn,
              wage: current.probationWage,
            },
          }
        : {}),
    },
    { asOf, noticeDays: 30 },
  ).alerts;
}

// The terms in force on a day: the newest row that starts on or before it, in a list sorted newest first.
const inForce = (terms: readonly HrEmploymentView[], day: string): HrEmploymentView | null => terms.find((t) => t.effectiveFrom <= day) ?? null;

function recentCompletedMonths(endedOn: string, count: number): string[] {
  const endMonth = endedOn.slice(0, 7);
  let cursor = endedOn === monthEnd(endMonth) ? endMonth : previousMonth(endMonth);
  const months: string[] = [];
  for (let i = 0; i < count; i += 1) {
    months.push(cursor);
    cursor = previousMonth(cursor);
  }
  return months.reverse();
}

function baseWageInForceForMonth(termsAsc: readonly { effective_from: Date | string; base_wage: string }[], month: string): string {
  const matched = termsInForceForMonth(termsAsc, month) ?? termsAsc[0];
  return matched ? matched.base_wage : '0';
}

export const employeeList = defineQuery({
  name: 'hr.payroll.employee.list',
  input: zHrEmployeeList,
  access: MANAGERS,
  sensitive: true,
  handler: async (ctx, input): Promise<HrEmployeeSummary[]> => {
    let q = ctx.trx
      .selectFrom('crove_hr.payroll_employee as e')
      .leftJoin('crove_hr.department as d', (join) => join.onRef('d.org_id', '=', 'e.org_id').onRef('d.id', '=', 'e.department_id'))
      .select([
        'e.id',
        'e.legal_entity_id',
        'e.display_name',
        'e.department_id',
        'd.name as department_name',
        'e.job_title',
        'e.status',
        'e.ended_on',
        'e.erased_at',
        'e.national_id_sealed',
        'e.bank_account_sealed',
      ])
      .where('e.org_id', '=', ctx.orgId);
    if (input.status !== 'all') q = q.where('e.status', '=', input.status);
    if (input.departmentId !== undefined) q = q.where('e.department_id', '=', input.departmentId);
    const employees = await q.orderBy('e.display_name').orderBy('e.id').limit(input.limit).execute();
    if (employees.length === 0) return [];
    const terms = await ctx.trx
      .selectFrom('crove_hr.payroll_employment')
      .select(TERMS_SELECT_COLUMNS)
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
    return employees.map((e) => {
      const current = inForce(byEmployee.get(e.id) ?? [], today);
      const erased = e.erased_at !== null;
      return {
        id: e.id,
        legalEntityId: e.legal_entity_id,
        displayName: e.display_name,
        departmentId: erased ? null : e.department_id,
        departmentName: erased ? null : (e.department_name ?? null),
        jobTitle: erased ? null : e.job_title,
        status: e.status,
        endedOn: e.ended_on === null ? null : iso(e.ended_on),
        current,
        hasIdentityNumber: e.national_id_sealed !== null,
        hasAccountNumber: e.bank_account_sealed !== null,
        contractAlerts: contractAlertsFor(e.status, current, today),
      };
    });
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
      .selectFrom('crove_hr.payroll_employee as e')
      .leftJoin('crove_hr.department as d', (join) => join.onRef('d.org_id', '=', 'e.org_id').onRef('d.id', '=', 'e.department_id'))
      .select([
        'e.id',
        'e.legal_entity_id',
        'e.display_name',
        'e.department_id',
        'd.name as department_name',
        'e.job_title',
        'e.address',
        'e.status',
        'e.ended_on',
        'e.erased_at',
        'e.national_id_sealed',
        'e.bank_account_sealed',
        'e.bank_code',
        'e.birth_date',
        'e.tax_code_sealed',
        'e.insurance_number_sealed',
        'e.finalization_authorized_years',
      ])
      .where('e.org_id', '=', ctx.orgId)
      .where('e.id', '=', input.employeeId)
      .executeTakeFirst();
    if (!e) throw notFound();
    const terms = (
      await ctx.trx
        .selectFrom('crove_hr.payroll_employment')
        .select(TERMS_SELECT_COLUMNS)
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
    const today = vietnamDay(new Date());
    const current = inForce(terms, today);
    return {
      id: e.id,
      legalEntityId: e.legal_entity_id,
      displayName: e.display_name,
      departmentId: erased ? null : e.department_id,
      departmentName: erased ? null : (e.department_name ?? null),
      jobTitle: erased ? null : e.job_title,
      status: e.status,
      endedOn: e.ended_on === null ? null : iso(e.ended_on),
      current,
      hasIdentityNumber: e.national_id_sealed !== null,
      hasAccountNumber: e.bank_account_sealed !== null,
      contractAlerts: contractAlertsFor(e.status, current, today),
      address: e.address,
      identityNumber,
      accountNumber,
      bankCode: erased ? null : e.bank_code,
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

export const employeeSeverance = defineQuery({
  name: 'hr.payroll.employee.severance',
  input: zHrEmployeeSeveranceAsk,
  access: MANAGERS,
  sensitive: true,
  target: targetOf,
  handler: async (ctx, input): Promise<HrEmployeeSeveranceResult> => {
    const e = await ctx.trx
      .selectFrom('crove_hr.payroll_employee')
      .select(['id', 'legal_entity_id', 'status', 'ended_on', 'erased_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.employeeId)
      .executeTakeFirst();
    if (!e) throw notFound();
    if (e.erased_at !== null) throw erasedError();
    const termsAsc = await ctx.trx
      .selectFrom('crove_hr.payroll_employment')
      .select(['effective_from', 'base_wage'])
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', e.id)
      .orderBy('effective_from', 'asc')
      .execute();
    const first = termsAsc[0];
    if (!first) throw notFound();
    const hireDate = iso(first.effective_from);
    const today = vietnamDay(new Date());
    const effectiveEndedOn =
      input.endedOn !== undefined
        ? input.endedOn
        : e.ended_on !== null
          ? iso(e.ended_on)
          : today < hireDate
            ? hireDate
            : today;
    if (effectiveEndedOn < hireDate) {
      throw new DomainError('HR_END_BEFORE_START', 422, 'Ngày nghỉ việc không thể trước ngày bắt đầu làm việc');
    }
    const totalWorkedMonths = input.totalWorkedMonths ?? countCompletedCalendarMonths(hireDate, effectiveEndedOn);
    const unemploymentInsuredMonths = input.unemploymentInsuredMonths ?? 0;
    const priorSettledMonths = input.priorSettledMonths ?? 0;
    const terminationReason = input.terminationReason ?? 'contract_expired';

    const wageMonthsCount = totalWorkedMonths >= 6 ? 6 : Math.max(1, totalWorkedMonths);
    const months = recentCompletedMonths(effectiveEndedOn, wageMonthsCount);
    const payLines = await ctx.trx
      .selectFrom('crove_hr.payroll_line as l')
      .innerJoin('crove_hr.payroll_run as r', (join) => join.onRef('r.org_id', '=', 'l.org_id').onRef('r.id', '=', 'l.run_id'))
      .select(['r.month', 'l.inputs'])
      .where('l.org_id', '=', ctx.orgId)
      .where('r.legal_entity_id', '=', e.legal_entity_id)
      .where('l.employee_id', '=', e.id)
      .where('l.kind', '=', 'pay')
      .where('r.status', '!=', 'draft')
      .where('r.month', 'in', months)
      .execute();
    const allowancesByMonth = new Map<string, string>();
    for (const line of payLines) {
      const parsed = zHrPayrollInputs.parse(line.inputs ?? {});
      const named = parsed.allowances.filter((a) => a.namedInContract).map((a) => a.amount);
      allowancesByMonth.set(line.month, toMoney(sum(named)));
    }
    const sixMonthWages = months.map((month) => {
      const baseWage = baseWageInForceForMonth(termsAsc, month);
      const allowanceTotal = allowancesByMonth.get(month) ?? '0';
      return toMoney(money(baseWage).plus(money(allowanceTotal)));
    });
    const calc = calculateSeveranceAllowance({
      totalWorkedMonths,
      unemploymentInsuredMonths,
      priorSettledMonths,
      sixMonthWages,
      terminationReason,
      ...(input.paidAmount !== undefined ? { paidAmount: input.paidAmount } : {}),
    });
    return {
      employeeId: e.id,
      status: e.status,
      hireDate,
      endedOn: effectiveEndedOn,
      terminationReason,
      totalWorkedMonths,
      unemploymentInsuredMonths,
      priorSettledMonths,
      sixMonthWages,
      qualifyingMonths: calc.qualifyingMonths,
      qualifyingYears: calc.qualifyingYears,
      averageWage: calc.averageWage,
      eligible: calc.eligible,
      reason: calc.reason,
      amount: calc.amount,
      paidAmount: calc.paidAmount,
      pitExemptAmount: calc.pitExemptAmount,
      taxableExcess: calc.taxableExcess,
      rulesUsed: [...calc.rulesUsed],
    };
  },
});

export const employeeContractPdf = defineQuery({
  name: 'hr.employee.contract_pdf',
  input: zHrEmployeeContractPdfAsk,
  access: MANAGERS,
  sensitive: true,
  target: targetOf,
  handler: async (ctx, input): Promise<HrEmployeeContractPdf> => {
    const e = await ctx.trx
      .selectFrom('crove_hr.payroll_employee as e')
      .leftJoin('crove_hr.department as d', (join) => join.onRef('d.org_id', '=', 'e.org_id').onRef('d.id', '=', 'e.department_id'))
      .select([
        'e.id',
        'e.legal_entity_id',
        'e.display_name',
        'e.department_id',
        'd.name as department_name',
        'e.job_title',
        'e.address',
        'e.birth_date',
        'e.erased_at',
      ])
      .where('e.org_id', '=', ctx.orgId)
      .where('e.id', '=', input.employeeId)
      .executeTakeFirst();
    if (!e) throw notFound();
    if (e.erased_at !== null) throw erasedError();

    const termRow = await ctx.trx
      .selectFrom('crove_hr.payroll_employment')
      .select(TERMS_SELECT_COLUMNS)
      .where('org_id', '=', ctx.orgId)
      .where('employee_id', '=', e.id)
      .where('id', '=', input.termsId)
      .executeTakeFirst();
    if (!termRow) throw notFound();

    const [entity, tenant, hiredCandidate] = await Promise.all([
      ctx.trx
        .selectFrom('crove_kernel.legal_entity')
        .select(['name', 'tax_code'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', e.legal_entity_id)
        .executeTakeFirst(),
      ctx.trx
        .selectFrom('crove_kernel.tenant')
        .select(['name', 'tax_code', 'address'])
        .where('org_id', '=', ctx.orgId)
        .executeTakeFirst(),
      ctx.trx
        .selectFrom('crove_hr.candidate')
        .select(['email'])
        .where('org_id', '=', ctx.orgId)
        .where('legal_entity_id', '=', e.legal_entity_id)
        .where('hired_employee_id', '=', e.id)
        .where('erased_at', 'is', null)
        .orderBy('updated_at', 'desc')
        .orderBy('id', 'desc')
        .limit(1)
        .executeTakeFirst(),
    ]);

    const term = termsView(termRow as TermsRow);
    const contractNumber = defaultContractNumber(term.effectiveFrom, term.id);
    const employerName = entity?.name ?? tenant?.name ?? '';
    const employerTaxCode = entity?.tax_code ?? tenant?.tax_code ?? null;
    const employerAddress = tenant?.address ?? null;

    const pdfBytes = renderLaborContractPdf({
      employer: {
        name: employerName,
        taxCode: employerTaxCode,
        address: employerAddress,
      },
      employee: {
        id: e.id,
        code: defaultEmployeeCode(e.id),
        displayName: e.display_name,
        birthDate: e.birth_date === null ? null : iso(e.birth_date),
        address: e.address,
        jobTitle: e.job_title,
        departmentName: e.department_name ?? null,
        workplace: employerAddress,
      },
      terms: {
        id: term.id,
        contractNumber,
        contractType: term.contractType,
        contractForm: term.contractForm,
        termMonths: term.termMonths,
        effectiveFrom: term.effectiveFrom,
        contractEndOn: term.contractEndOn,
        fixedTermSequence: term.fixedTermSequence,
        probationRoleTier: term.probationRoleTier,
        probationEndOn: term.probationEndOn,
        probationWage: term.probationWage,
        baseWage: term.baseWage,
        region: term.region,
        payFunction: term.payFunction,
        employeeInsurable: term.contractType !== 'none',
        taxResident: true,
        flatTax: isFlatTaxContract(term),
      },
    });

    return {
      filename: contractFilename(e.display_name, term.effectiveFrom),
      contentType: 'application/pdf',
      pdfBase64: Buffer.from(pdfBytes).toString('base64'),
      title: contractTitle(e.display_name, term.effectiveFrom),
      contractNumber,
      employeeName: e.display_name,
      employeeEmail: hiredCandidate?.email ?? null,
    };
  },
});

export const hrEmployeeCommands = [employeeAdd, employeeEdit, employeeFinalizationSet, employmentAdd, employeeEnd, dependentAdd, dependentEnd, employeeErase];
export const hrEmployeeQueries = [employeeList, employeeGet, employeeSeverance, employeeContractPdf];

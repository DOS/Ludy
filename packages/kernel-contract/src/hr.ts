// SPDX-License-Identifier: AGPL-3.0-only
// The HR module (issue #2530, docs/plan/payroll.md section 6.1 and 6.6, ADR-0046): the people payroll is run for, per legal entity. Employees, their effective-dated
// employment terms and their dependents. Only owners and admins see any of it (the database's owner_admin policy), and every query that reads it is sensitive (the audit row
// is written before the read). The identity number and the bank account number are sealed under the person's own key (ADR-0017): a command takes them, a query opens them for
// the one employee a person asked to see, and an erasure after the retention shreds the key. No image of an identity document is stored.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';
import { vietnamToday } from './vietnam-time.ts';

export const HR_CONTRACT_TYPES = ['indefinite', 'fixed_term', 'none'] as const;
export type HrContractType = (typeof HR_CONTRACT_TYPES)[number];
export const HR_CONTRACT_FORMS = ['written', 'electronic', 'oral'] as const;
export type HrContractForm = (typeof HR_CONTRACT_FORMS)[number];
export const HR_PROBATION_ROLE_TIERS = ['enterprise_manager', 'college_or_above', 'intermediate_technical', 'other'] as const;
export type HrProbationRoleTier = (typeof HR_PROBATION_ROLE_TIERS)[number];
export const HR_CONTRACT_ALERT_CODES = [
  'contract_expired',
  'contract_expiring_soon',
  'probation_ending_soon',
  'final_fixed_term_renewal',
  'must_convert_to_indefinite',
  'work_permit_expired',
  'work_permit_expiring_soon',
] as const;
export type HrContractAlertCode = (typeof HR_CONTRACT_ALERT_CODES)[number];
// The wage regions of Decree 74/2024 (the minimum wage by workplace).
export const HR_REGIONS = ['I', 'II', 'III', 'IV'] as const;
export type HrRegion = (typeof HR_REGIONS)[number];
// What a person's work is for: it picks the expense account of the pay in the posting (the accounts per regime are data in @ludy/l10n-vn, whose PAY_FUNCTIONS this list equals).
export const HR_PAY_FUNCTIONS = ['admin', 'sales', 'production', 'overhead', 'construction'] as const;
export type HrPayFunction = (typeof HR_PAY_FUNCTIONS)[number];
export const HR_PAY_BASES = ['monthly', 'hourly', 'piece_rate'] as const;
export type HrPayBasis = (typeof HR_PAY_BASES)[number];
export const HR_RELATIONS = ['child', 'spouse', 'parent', 'other'] as const;
export type HrRelation = (typeof HR_RELATIONS)[number];
export const HR_STATUSES = ['active', 'ended'] as const;
export type HrStatus = (typeof HR_STATUSES)[number];
export const HR_LEAVE_CATEGORIES = ['standard', 'heavy', 'special_heavy'] as const;
export type HrLeaveCategory = (typeof HR_LEAVE_CATEGORIES)[number];

// Contractual or policy annual leave baseline days/year (>= 12 statutory floor, <= 366, at most 2 decimals).
export const zHrAnnualLeaveBaseline = z
  .string()
  .trim()
  .regex(
    /^(?:366(?:\.0{1,2})?|36[0-5](?:\.\d{1,2})?|3[0-5]\d(?:\.\d{1,2})?|[12]\d{2}(?:\.\d{1,2})?|[2-9]\d(?:\.\d{1,2})?|1[2-9](?:\.\d{1,2})?)$/,
    'annual leave baseline 12..366',
  );

export function leaveBaselineMeetsCategoryFloor(category: HrLeaveCategory, baselineDays: string): boolean {
  const floor = category === 'standard' ? 12 : category === 'heavy' ? 14 : 16;
  const [wholeRaw = '0', fracRaw = ''] = baselineDays.trim().split('.');
  const hundredths = Number(wholeRaw) * 100 + Number(fracRaw.padEnd(2, '0').slice(0, 2));
  return Number.isSafeInteger(hundredths) && hundredths >= floor * 100;
}

// Years an ended employee's payroll records stay before an erasure may delete the person's key: the ten years the Accounting Law (88/2015, Art. 41) keeps accounting
// records, payroll being accounting evidence. An erasure cannot run earlier. A lawyer's later answer (payroll plan, row 22) may lengthen it, never shorten it.
export const HR_RETENTION_YEARS = 10;

// What an erased name reads as: the row keeps a name (it cannot be empty), nothing ties it to the person.
export const HR_ERASED_NAME = 'Đã xóa theo yêu cầu';

// A wage as a decimal string of at most two decimals (VND has none in practice), never a JS number.
export const zHrWage = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/, 'decimal string');
// An identity number (CCCD, CMND or passport) as the person writes it, and a bank account number: both go into the sealed columns.
export const zHrIdentityNumber = z.string().trim().min(6).max(30).regex(/^[A-Za-z0-9][A-Za-z0-9 .-]*$/, 'identity number');
export const zHrAccountNumber = z.string().trim().min(6).max(34).regex(/^[A-Za-z0-9][A-Za-z0-9 .-]*$/, 'account number');
// The tax code and the social insurance number (#2533): sealed like the identity number, since the tax code is in most cases that number.
// A personal tax code and a social insurance number are 10 digits (the old numbers) or 12 (the identity number that replaces them), nothing else: a short or lettered value is refused here, not
// stored sealed where nobody can look at it again.
export const zHrTaxCode = z.string().trim().regex(/^(\d{10}|\d{12})$/, 'tax code: 10 or 12 digits');
export const zHrInsuranceNumber = z.string().trim().regex(/^(\d{10}|\d{12})$/, 'insurance number: 10 or 12 digits');
export const zHrWorkPermitNumber = z.string().trim().min(4).max(30).regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/, 'work permit number');
// A birth date from 1900-01-01 to today (Vietnam).
export const zHrBirthDate = zLocalDate.refine((v) => v >= '1900-01-01' && v <= vietnamToday(), 'birth date between 1900-01-01 and today');
const noNul = (value: string): boolean => !value.includes('\u0000');
export const HR_DEPARTMENT_NAME_MAX = 120;
export const HR_DEPARTMENT_CODE_MAX = 32;
export const HR_JOB_TITLE_MAX = 160;
const zName = z.string().trim().min(1).max(200);
const zAddress = z.string().trim().min(1).max(500);
export const zHrDepartmentName = z.string().trim().min(1).max(HR_DEPARTMENT_NAME_MAX).refine(noNul, 'no NUL character');
export const zHrDepartmentCode = z.string().trim().min(1).max(HR_DEPARTMENT_CODE_MAX).regex(/^[A-Za-z0-9._-]+$/, 'department code');
export const zHrJobTitle = z.string().trim().min(1).max(HR_JOB_TITLE_MAX).refine(noNul, 'no NUL character');

export const zHrDepartmentList = z.strictObject({
  legalEntityId: zId.optional(),
  includeArchived: z.boolean().default(false),
});
export type HrDepartmentList = z.input<typeof zHrDepartmentList>;

export const zHrDepartmentAdd = z.strictObject({
  legalEntityId: zId.optional(),
  name: zHrDepartmentName,
  code: zHrDepartmentCode.optional(),
  payFunction: z.enum(HR_PAY_FUNCTIONS).default('admin'),
});
export type HrDepartmentAdd = z.input<typeof zHrDepartmentAdd>;

export const zHrDepartmentEdit = z
  .strictObject({
    departmentId: zId,
    name: zHrDepartmentName.optional(),
    code: zHrDepartmentCode.nullable().optional(),
    payFunction: z.enum(HR_PAY_FUNCTIONS).optional(),
  })
  .refine((v) => v.name !== undefined || v.code !== undefined || v.payFunction !== undefined, 'at least one field');
export type HrDepartmentEdit = z.infer<typeof zHrDepartmentEdit>;

export const zHrDepartmentRef = z.strictObject({ departmentId: zId });
export type HrDepartmentRef = z.infer<typeof zHrDepartmentRef>;

export const zHrDepartmentSetManager = z.strictObject({
  departmentId: zId,
  managerUserId: zId.nullable(),
});
export type HrDepartmentSetManager = z.infer<typeof zHrDepartmentSetManager>;

export const zHrDepartmentWritten = z.strictObject({ departmentId: zId });
export type HrDepartmentWritten = z.infer<typeof zHrDepartmentWritten>;

export const zHrDepartmentView = z.strictObject({
  id: zId,
  legalEntityId: zId,
  name: z.string(),
  code: z.string().nullable(),
  payFunction: z.enum(HR_PAY_FUNCTIONS),
  managerUserId: zId.nullable(),
  managerName: z.string().nullable(),
  archivedAt: z.string().nullable(),
  activeEmployees: z.number().int().nonnegative(),
  activeBaseWageTotal: z.string(),
});
export type HrDepartmentView = z.infer<typeof zHrDepartmentView>;

const isPositiveDecimalString = (value: string | null | undefined): boolean =>
  value !== null && value !== undefined && /[1-9]/.test(value);

function validateEmploymentRates(
  v: { payBasis: HrPayBasis; baseWage?: string | undefined; hourlyRate?: string | null | undefined; pieceRate?: string | null | undefined },
  ctx: z.RefinementCtx,
): void {
  if (v.payBasis === 'monthly' && v.baseWage === undefined) {
    ctx.addIssue({ code: 'custom', message: 'baseWage is required when payBasis is monthly', path: ['baseWage'] });
  }
  if (v.payBasis === 'hourly' && !isPositiveDecimalString(v.hourlyRate)) {
    ctx.addIssue({ code: 'custom', message: 'hourlyRate must be above zero when payBasis is hourly', path: ['hourlyRate'] });
  }
  if (v.payBasis === 'piece_rate' && !isPositiveDecimalString(v.pieceRate)) {
    ctx.addIssue({ code: 'custom', message: 'pieceRate must be above zero when payBasis is piece_rate', path: ['pieceRate'] });
  }
}

const zHrEmploymentTermsShape = {
  effectiveFrom: zLocalDate,
  contractType: z.enum(HR_CONTRACT_TYPES),
  region: z.enum(HR_REGIONS),
  baseWage: zHrWage.optional(),
  // Administration unless said otherwise: the default every small business has.
  payFunction: z.enum(HR_PAY_FUNCTIONS).default('admin'),
  payBasis: z.enum(HR_PAY_BASES).default('monthly'),
  hourlyRate: zHrWage.nullable().optional(),
  pieceRate: zHrWage.nullable().optional(),
  taxResident: z.boolean().default(true),
  contractForm: z.enum(HR_CONTRACT_FORMS).nullable().optional(),
  termMonths: z.number().int().min(1).max(36).nullable().optional(),
  contractEndOn: zLocalDate.nullable().optional(),
  fixedTermSequence: z.number().int().min(1).max(2).nullable().optional(),
  probationRoleTier: z.enum(HR_PROBATION_ROLE_TIERS).nullable().optional(),
  probationEndOn: zLocalDate.nullable().optional(),
  probationWage: zHrWage.nullable().optional(),
};

export const zHrEmploymentTerms = z
  .strictObject(zHrEmploymentTermsShape)
  .superRefine(validateEmploymentRates)
  .transform((v) => ({ ...v, baseWage: v.baseWage ?? '0' }));
export type HrEmploymentTerms = z.infer<typeof zHrEmploymentTerms>;

// Initial employment on employee.add keeps payFunction optional so assigning a department can default it when omitted.
export const zHrEmployeeInitialEmployment = z
  .strictObject({ ...zHrEmploymentTermsShape, payFunction: z.enum(HR_PAY_FUNCTIONS).optional() })
  .superRefine(validateEmploymentRates)
  .transform((v) => ({ ...v, baseWage: v.baseWage ?? '0' }));
export type HrEmployeeInitialEmployment = z.infer<typeof zHrEmployeeInitialEmployment>;

// A new employee with the first terms. The legal entity is the org's default one when none is named.
// The code of the bank a person is paid at (#2897): 2 to 12 capital letters or digits, a code of the list kept as data in @ludy/l10n-vn (VN_BANKS). The shape is checked here and in the database;
// that the code is in the list is checked by the command, so this package needs no copy of the list.
export const zHrBankCode = z.string().regex(/^[A-Z0-9]{2,12}$/, 'bank code: 2 to 12 capital letters or digits');

export const zHrEmployeeAdd = z.strictObject({
  displayName: zName,
  address: zAddress.optional(),
  identityNumber: zHrIdentityNumber.optional(),
  accountNumber: zHrAccountNumber.optional(),
  bankCode: zHrBankCode.optional(),
  birthDate: zHrBirthDate.optional(),
  taxCode: zHrTaxCode.optional(),
  insuranceNumber: zHrInsuranceNumber.optional(),
  isForeign: z.boolean().default(false),
  workPermitExempt: z.boolean().default(false),
  workPermitNumber: zHrWorkPermitNumber.optional(),
  workPermitExpiresOn: zLocalDate.optional(),
  legalEntityId: zId.optional(),
  departmentId: zId.optional(),
  jobTitle: zHrJobTitle.optional(),
  employment: zHrEmployeeInitialEmployment,
});
export type HrEmployeeAdd = z.infer<typeof zHrEmployeeAdd>;

// A change of the personal details; null clears one. At least one field.
export const zHrEmployeeEdit = z
  .strictObject({
    employeeId: zId,
    displayName: zName.optional(),
    address: zAddress.nullable().optional(),
    identityNumber: zHrIdentityNumber.nullable().optional(),
    accountNumber: zHrAccountNumber.nullable().optional(),
    bankCode: zHrBankCode.nullable().optional(),
    birthDate: zHrBirthDate.nullable().optional(),
    taxCode: zHrTaxCode.nullable().optional(),
    insuranceNumber: zHrInsuranceNumber.nullable().optional(),
    isForeign: z.boolean().optional(),
    workPermitExempt: z.boolean().optional(),
    workPermitNumber: zHrWorkPermitNumber.nullable().optional(),
    workPermitExpiresOn: zLocalDate.nullable().optional(),
    departmentId: zId.nullable().optional(),
    jobTitle: zHrJobTitle.nullable().optional(),
  })
  .refine(
    (v) =>
      v.displayName !== undefined ||
      v.address !== undefined ||
      v.identityNumber !== undefined ||
      v.accountNumber !== undefined ||
      v.bankCode !== undefined ||
      v.birthDate !== undefined ||
      v.taxCode !== undefined ||
      v.insuranceNumber !== undefined ||
      v.isForeign !== undefined ||
      v.workPermitExempt !== undefined ||
      v.workPermitNumber !== undefined ||
      v.workPermitExpiresOn !== undefined ||
      v.departmentId !== undefined ||
      v.jobTitle !== undefined,
    'at least one field',
  );
export type HrEmployeeEdit = z.infer<typeof zHrEmployeeEdit>;

// A raise, a new contract or a change of region: a new row, never an edit of an old one.
export const zHrEmploymentAdd = z
  .strictObject({ ...zHrEmploymentTermsShape, employeeId: zId })
  .superRefine(validateEmploymentRates)
  .transform((v) => ({ ...v, baseWage: v.baseWage ?? '0' }));
export type HrEmploymentAdd = z.infer<typeof zHrEmploymentAdd>;

// The person authorized (or no longer authorizes) the payer to finalize their income tax for a tax year (08/UQ-QTT-TNCN); the list of years is kept sorted, one entry per year.
export const zHrFinalizationSet = z.strictObject({ employeeId: zId, year: z.number().int().min(2026).max(2100), authorized: z.boolean() });
export type HrFinalizationSet = z.infer<typeof zHrFinalizationSet>;

export const zHrEmployeeEnd = z.strictObject({ employeeId: zId, endedOn: zLocalDate });
export type HrEmployeeEnd = z.infer<typeof zHrEmployeeEnd>;

export const zHrDependentAdd = z.strictObject({ employeeId: zId, displayName: zName, relation: z.enum(HR_RELATIONS), registeredOn: zLocalDate });
export type HrDependentAdd = z.infer<typeof zHrDependentAdd>;

export const zHrDependentEnd = z.strictObject({ dependentId: zId, endedOn: zLocalDate });
export type HrDependentEnd = z.infer<typeof zHrDependentEnd>;

export const zHrEmployeeRef = z.strictObject({ employeeId: zId });
export type HrEmployeeRef = z.infer<typeof zHrEmployeeRef>;

export const zHrEmployeeLinkMember = z.strictObject({
  employeeId: zId,
  userId: zId.nullable(),
});
export type HrEmployeeLinkMember = z.infer<typeof zHrEmployeeLinkMember>;

export const zHrEmployeeList = z.strictObject({
  status: z.enum(['active', 'ended', 'all']).default('active'),
  departmentId: zId.optional(),
  limit: z.number().int().min(1).max(500).default(200),
});
export type HrEmployeeList = z.input<typeof zHrEmployeeList>;

// What a command returns: ids, never a value (idempotency rows keep results).
export const zHrWritten = z.object({ employeeId: zId.optional(), employmentId: zId.optional(), dependentId: zId.optional() });
export type HrWritten = z.infer<typeof zHrWritten>;

export const zHrContractAlert = z.object({
  code: z.enum(HR_CONTRACT_ALERT_CODES),
  severity: z.enum(['error', 'warning']),
  targetDate: z.string().nullable(),
  daysRemaining: z.number().int().nullable(),
  message: z.string(),
  cite: z.string(),
});
export type HrContractAlert = z.infer<typeof zHrContractAlert>;

const zTerms = z.object({
  id: zId,
  effectiveFrom: z.string(),
  contractType: z.enum(HR_CONTRACT_TYPES),
  region: z.enum(HR_REGIONS),
  baseWage: z.string(),
  payFunction: z.enum(HR_PAY_FUNCTIONS),
  payBasis: z.enum(HR_PAY_BASES),
  hourlyRate: z.string().nullable(),
  pieceRate: z.string().nullable(),
  taxResident: z.boolean(),
  contractForm: z.enum(HR_CONTRACT_FORMS).nullable(),
  termMonths: z.number().int().nullable(),
  contractEndOn: z.string().nullable(),
  fixedTermSequence: z.number().int().nullable(),
  probationRoleTier: z.enum(HR_PROBATION_ROLE_TIERS).nullable(),
  probationEndOn: z.string().nullable(),
  probationWage: z.string().nullable(),
});
export type HrEmploymentView = z.infer<typeof zTerms>;

export const zHrEmployeeSummary = z.object({
  id: zId,
  legalEntityId: zId,
  displayName: z.string(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  linkedUserId: zId.nullable(),
  linkedMemberName: z.string().nullable(),
  status: z.enum(HR_STATUSES),
  endedOn: z.string().nullable(),
  isForeign: z.boolean(),
  workPermitExempt: z.boolean(),
  workPermitExpiresOn: z.string().nullable(),
  hasWorkPermitNumber: z.boolean(),
  // The terms in force today: the newest row that starts on or before today, or null when the first starts later.
  current: zTerms.nullable(),
  hasIdentityNumber: z.boolean(),
  hasAccountNumber: z.boolean(),
  contractAlerts: z.array(zHrContractAlert),
});
export type HrEmployeeSummary = z.infer<typeof zHrEmployeeSummary>;

export const zHrDependentView = z.object({ id: zId, displayName: z.string(), relation: z.enum(HR_RELATIONS), registeredOn: z.string(), endedOn: z.string().nullable() });
export type HrDependentView = z.infer<typeof zHrDependentView>;

// One employee, with the sealed values opened. `erased` says the person's key is gone: the two numbers then read as none, and the name and address are the placeholder.
export const zHrEmployee = zHrEmployeeSummary.extend({
  address: z.string().nullable(),
  identityNumber: z.string().nullable(),
  accountNumber: z.string().nullable(),
  workPermitNumber: z.string().nullable(),
  // The code of the bank the person is paid at (#2897); the sensitive read only, null once erased.
  bankCode: z.string().nullable(),
  birthDate: z.string().nullable(),
  taxCode: z.string().nullable(),
  insuranceNumber: z.string().nullable(),
  finalizationAuthorizedYears: z.array(z.number().int()),
  erased: z.boolean(),
  employments: z.array(zTerms),
  dependents: z.array(zHrDependentView),
});
export type HrEmployee = z.infer<typeof zHrEmployee>;

// An erasure's answer: what went and what stays, with the reason, as the personal-data erase's.
export const zHrEmployeeErased = z.object({
  employeeId: zId,
  shreddedKeys: z.number().int(),
  cleared: z.array(z.string()),
  kept: z.array(z.object({ what: z.string(), reason: z.string() })),
});
export type HrEmployeeErased = z.infer<typeof zHrEmployeeErased>;

// Statutory severance and 13th-month rule citation metadata (matches LaborRuleRef in @ludy/l10n-vn).
export const zHrLaborRuleRef = z.object({
  id: z.string(),
  planRow: z.number().int(),
  status: z.enum(['confirmed', 'commentary']),
  confidence: z.enum(['primary', 'gov', 'commentary', 'unverified']),
  cite: z.string(),
});
export type HrLaborRuleRef = z.infer<typeof zHrLaborRuleRef>;

// Statutory severance termination & ineligibility codes (equal to SEVERANCE_TERMINATION_REASONS / SeveranceIneligibleReason in @ludy/l10n-vn).
export const HR_SEVERANCE_TERMINATION_REASONS = [
  'contract_expired',
  'task_completed',
  'mutual_agreement',
  'lawful_unilateral',
  'other_eligible',
  'retirement_pension',
  'disciplinary_dismissal',
  'unlawful_resignation',
  'job_loss_redundancy',
] as const;
export type HrSeveranceTerminationReason = (typeof HR_SEVERANCE_TERMINATION_REASONS)[number];

export const HR_SEVERANCE_INELIGIBLE_REASONS = [
  'worked_under_12_months',
  'retirement_pension',
  'disciplinary_dismissal',
  'unlawful_resignation',
  'job_loss_redundancy',
] as const;
export type HrSeveranceIneligibleReason = (typeof HR_SEVERANCE_INELIGIBLE_REASONS)[number];

const terminationAllowanceAskFields = {
  employeeId: zId,
  endedOn: zLocalDate.optional(),
  totalWorkedMonths: z.number().int().min(0).max(1200).optional(),
  unemploymentInsuredMonths: z.number().int().min(0).max(1200).optional(),
  priorSettledMonths: z.number().int().min(0).max(1200).optional(),
  paidAmount: zHrWage.optional(),
};

const terminationAllowanceResultFields = {
  employeeId: zId,
  status: z.enum(HR_STATUSES),
  hireDate: z.string(),
  endedOn: z.string(),
  totalWorkedMonths: z.number().int(),
  unemploymentInsuredMonths: z.number().int(),
  priorSettledMonths: z.number().int(),
  sixMonthWages: z.array(z.string()),
  qualifyingMonths: z.number().int(),
  qualifyingYears: z.string(),
  averageWage: z.string(),
  eligible: z.boolean(),
  amount: z.string(),
  paidAmount: z.string().nullable(),
  pitExemptAmount: z.string(),
  taxableExcess: z.string(),
  rulesUsed: z.array(zHrLaborRuleRef),
};

export const zHrEmployeeSeveranceAsk = z.strictObject({
  ...terminationAllowanceAskFields,
  terminationReason: z.enum(HR_SEVERANCE_TERMINATION_REASONS).optional(),
});
export type HrEmployeeSeveranceAsk = z.input<typeof zHrEmployeeSeveranceAsk>;

export const zHrEmployeeSeveranceResult = z.object({
  ...terminationAllowanceResultFields,
  terminationReason: z.enum(HR_SEVERANCE_TERMINATION_REASONS),
  reason: z.enum(HR_SEVERANCE_INELIGIBLE_REASONS).nullable(),
});
export type HrEmployeeSeveranceResult = z.infer<typeof zHrEmployeeSeveranceResult>;

// Statutory job-loss allowance termination & ineligibility codes (equal to JOB_LOSS_TERMINATION_REASONS / JobLossIneligibleReason in @ludy/l10n-vn).
export const HR_JOB_LOSS_TERMINATION_REASONS = [
  'organizational_restructuring',
  'economic_reasons',
  'merger_division_transfer',
  'other_non_art42_art43',
] as const;
export type HrJobLossTerminationReason = (typeof HR_JOB_LOSS_TERMINATION_REASONS)[number];

export const HR_JOB_LOSS_INELIGIBLE_REASONS = [
  'worked_under_12_months',
  'not_job_loss_reason',
] as const;
export type HrJobLossIneligibleReason = (typeof HR_JOB_LOSS_INELIGIBLE_REASONS)[number];

export const zHrEmployeeJobLossAsk = z.strictObject({
  ...terminationAllowanceAskFields,
  terminationReason: z.enum(HR_JOB_LOSS_TERMINATION_REASONS).optional(),
});
export type HrEmployeeJobLossAsk = z.input<typeof zHrEmployeeJobLossAsk>;

export const zHrEmployeeJobLossResult = z.object({
  ...terminationAllowanceResultFields,
  terminationReason: z.enum(HR_JOB_LOSS_TERMINATION_REASONS),
  reason: z.enum(HR_JOB_LOSS_INELIGIBLE_REASONS).nullable(),
  minimumFloorApplied: z.boolean(),
});
export type HrEmployeeJobLossResult = z.infer<typeof zHrEmployeeJobLossResult>;

export const zHrEmployeeContractPdfAsk = z.strictObject({
  employeeId: zId,
  termsId: zId,
});
export type HrEmployeeContractPdfAsk = z.infer<typeof zHrEmployeeContractPdfAsk>;

export const zHrEmployeeContractPdf = z.strictObject({
  filename: z.string(),
  contentType: z.literal('application/pdf'),
  pdfBase64: z.string(),
  title: z.string(),
  contractNumber: z.string().nullable(),
  employeeName: z.string(),
  employeeEmail: z.string().nullable(),
});
export type HrEmployeeContractPdf = z.infer<typeof zHrEmployeeContractPdf>;


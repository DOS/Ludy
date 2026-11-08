// SPDX-License-Identifier: AGPL-3.0-only
// The HR module (issue #2530, docs/plan/payroll.md section 6.1 and 6.6, ADR-0046): the people payroll is run for, per legal entity. Employees, their effective-dated
// employment terms and their dependents. Only owners and admins see any of it (the database's owner_admin policy), and every query that reads it is sensitive (the audit row
// is written before the read). The identity number and the bank account number are sealed under the person's own key (ADR-0017): a command takes them, a query opens them for
// the one employee a person asked to see, and an erasure after the retention shreds the key. No image of an identity document is stored.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

export const HR_CONTRACT_TYPES = ['indefinite', 'fixed_term', 'none'] as const;
export type HrContractType = (typeof HR_CONTRACT_TYPES)[number];
// The wage regions of Decree 74/2024 (the minimum wage by workplace).
export const HR_REGIONS = ['I', 'II', 'III', 'IV'] as const;
export type HrRegion = (typeof HR_REGIONS)[number];
// What a person's work is for: it picks the expense account of the pay in the posting (the accounts per regime are data in @crove/l10n-vn, whose PAY_FUNCTIONS this list equals).
export const HR_PAY_FUNCTIONS = ['admin', 'sales', 'production', 'overhead', 'construction'] as const;
export type HrPayFunction = (typeof HR_PAY_FUNCTIONS)[number];
export const HR_RELATIONS = ['child', 'spouse', 'parent', 'other'] as const;
export type HrRelation = (typeof HR_RELATIONS)[number];
export const HR_STATUSES = ['active', 'ended'] as const;
export type HrStatus = (typeof HR_STATUSES)[number];

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
export const zHrTaxCode = z.string().trim().min(6).max(20).regex(/^[0-9][0-9-]*$/, 'tax code');
export const zHrInsuranceNumber = z.string().trim().min(6).max(20).regex(/^[A-Za-z0-9][A-Za-z0-9 .-]*$/, 'insurance number');
export const zHrBirthDate = zLocalDate;
const zName = z.string().trim().min(1).max(200);
const zAddress = z.string().trim().min(1).max(500);

export const zHrEmploymentTerms = z.strictObject({
  effectiveFrom: zLocalDate,
  contractType: z.enum(HR_CONTRACT_TYPES),
  region: z.enum(HR_REGIONS),
  baseWage: zHrWage,
  // Administration unless said otherwise: the default every small business has.
  payFunction: z.enum(HR_PAY_FUNCTIONS).default('admin'),
});
export type HrEmploymentTerms = z.infer<typeof zHrEmploymentTerms>;

// A new employee with the first terms. The legal entity is the org's default one when none is named.
export const zHrEmployeeAdd = z.strictObject({
  displayName: zName,
  address: zAddress.optional(),
  identityNumber: zHrIdentityNumber.optional(),
  accountNumber: zHrAccountNumber.optional(),
  birthDate: zHrBirthDate.optional(),
  taxCode: zHrTaxCode.optional(),
  insuranceNumber: zHrInsuranceNumber.optional(),
  legalEntityId: zId.optional(),
  employment: zHrEmploymentTerms,
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
    birthDate: zHrBirthDate.nullable().optional(),
    taxCode: zHrTaxCode.nullable().optional(),
    insuranceNumber: zHrInsuranceNumber.nullable().optional(),
  })
  .refine(
    (v) =>
      v.displayName !== undefined ||
      v.address !== undefined ||
      v.identityNumber !== undefined ||
      v.accountNumber !== undefined ||
      v.birthDate !== undefined ||
      v.taxCode !== undefined ||
      v.insuranceNumber !== undefined,
    'at least one field',
  );
export type HrEmployeeEdit = z.infer<typeof zHrEmployeeEdit>;

// A raise, a new contract or a change of region: a new row, never an edit of an old one.
export const zHrEmploymentAdd = zHrEmploymentTerms.extend({ employeeId: zId });
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

export const zHrEmployeeList = z.strictObject({ status: z.enum(['active', 'ended', 'all']).default('active'), limit: z.number().int().min(1).max(500).default(200) });
export type HrEmployeeList = z.input<typeof zHrEmployeeList>;

// What a command returns: ids, never a value (idempotency rows keep results).
export const zHrWritten = z.object({ employeeId: zId.optional(), employmentId: zId.optional(), dependentId: zId.optional() });
export type HrWritten = z.infer<typeof zHrWritten>;

const zTerms = z.object({ id: zId, effectiveFrom: z.string(), contractType: z.enum(HR_CONTRACT_TYPES), region: z.enum(HR_REGIONS), baseWage: z.string(), payFunction: z.enum(HR_PAY_FUNCTIONS) });
export type HrEmploymentView = z.infer<typeof zTerms>;

export const zHrEmployeeSummary = z.object({
  id: zId,
  legalEntityId: zId,
  displayName: z.string(),
  status: z.enum(HR_STATUSES),
  endedOn: z.string().nullable(),
  // The terms in force today: the newest row that starts on or before today, or null when the first starts later.
  current: zTerms.nullable(),
  hasIdentityNumber: z.boolean(),
  hasAccountNumber: z.boolean(),
});
export type HrEmployeeSummary = z.infer<typeof zHrEmployeeSummary>;

export const zHrDependentView = z.object({ id: zId, displayName: z.string(), relation: z.enum(HR_RELATIONS), registeredOn: z.string(), endedOn: z.string().nullable() });
export type HrDependentView = z.infer<typeof zHrDependentView>;

// One employee, with the sealed values opened. `erased` says the person's key is gone: the two numbers then read as none, and the name and address are the placeholder.
export const zHrEmployee = zHrEmployeeSummary.extend({
  address: z.string().nullable(),
  identityNumber: z.string().nullable(),
  accountNumber: z.string().nullable(),
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

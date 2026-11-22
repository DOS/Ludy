// SPDX-License-Identifier: AGPL-3.0-only
// Employee annual leave ledger & statutory balance (issue #3394, #2540 slice 1c-2, docs/plan/payroll.md section 5 rows 3 & 6.7, section 7, ADR-0046).
import { z } from 'zod';
import {
  HR_LEAVE_CATEGORIES,
  HR_STATUSES,
  leaveBaselineMeetsCategoryFloor,
  zHrAnnualLeaveBaseline,
} from './hr.ts';
import { HR_RUN_STATUSES, zHrMonth, zHrRuleRef } from './hr-payroll.ts';
import { zId, zLocalDate } from './schemas.ts';

export const HR_LEAVE_ENTRY_KINDS = ['opening_balance', 'annual_leave', 'personal_paid', 'unpaid_leave', 'sickness_bhxh', 'maternity_bhxh'] as const;
export type HrLeaveEntryKind = (typeof HR_LEAVE_ENTRY_KINDS)[number];

export const HR_LEAVE_REQUEST_KINDS = ['annual_leave', 'personal_paid', 'unpaid_leave'] as const;
export type HrLeaveRequestKind = (typeof HR_LEAVE_REQUEST_KINDS)[number];

export const HR_LEAVE_REQUEST_STATUSES = ['pending_l1', 'pending_final', 'approved', 'rejected', 'cancelled'] as const;
export type HrLeaveRequestStatus = (typeof HR_LEAVE_REQUEST_STATUSES)[number];

export const HR_LEAVE_WORKWEEKS = ['mon_fri', 'mon_sat', 'all_days'] as const;
export type HrLeaveWorkweek = (typeof HR_LEAVE_WORKWEEKS)[number];

export const zHrLeaveYear = z.string().regex(/^\d{4}$/, 'YYYY');

// Non-negative decimal string supporting 0..366 with up to 2 decimal places (matches crove_hr.payroll_leave_entry.days numeric(6, 2)).
// `unpaid_leave` entries sync into `zHrPayrollInputs.unpaidLeaveDays` (`zHrDays`, at most 1 decimal place), so write-time validation
// enforces at most 1 significant decimal place on `unpaid_leave` rather than accepting 2 decimals and failing on sync.
export const zHrLeaveDays = z
  .string()
  .trim()
  .regex(/^(?:366(?:\.0{1,2})?|36[0-5](?:\.\d{1,2})?|3[0-5]\d(?:\.\d{1,2})?|[12]\d{2}(?:\.\d{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/, 'leave days 0..366');

export const HR_UNPAID_LEAVE_PRECISION_RE = /^\d{1,3}(?:\.\d0?)?$/;

export const zHrLeaveSet = z
  .strictObject({
    employeeId: zId,
    month: zHrMonth,
    kind: z.enum(HR_LEAVE_ENTRY_KINDS),
    days: zHrLeaveDays,
    approved: z.boolean().default(true),
  })
  .refine((v) => v.kind !== 'unpaid_leave' || HR_UNPAID_LEAVE_PRECISION_RE.test(v.days), {
    message: 'unpaid_leave supports at most 1 decimal place',
    path: ['days'],
  });
export type HrLeaveSet = z.input<typeof zHrLeaveSet>;

export const zHrLeaveDelete = z.strictObject({
  entryId: zId,
});
export type HrLeaveDelete = z.infer<typeof zHrLeaveDelete>;

export const zHrLeaveWritten = z.object({
  employeeId: zId,
  entryId: zId.nullable(),
  deleted: z.boolean(),
});
export type HrLeaveWritten = z.infer<typeof zHrLeaveWritten>;

export const zHrLeaveBalanceAsk = z
  .strictObject({
    employeeId: zId,
    year: zHrLeaveYear,
    category: z.enum(HR_LEAVE_CATEGORIES).default('standard'),
    standardAnnualDays: zHrAnnualLeaveBaseline.optional(),
    asOfMonth: zHrMonth.optional(),
    workweek: z.enum(HR_LEAVE_WORKWEEKS).optional(),
  })
  .refine((v) => v.asOfMonth === undefined || v.asOfMonth.startsWith(`${v.year}-`), {
    message: 'asOfMonth must be within year',
    path: ['asOfMonth'],
  })
  .refine((v) => v.standardAnnualDays === undefined || leaveBaselineMeetsCategoryFloor(v.category, v.standardAnnualDays), {
    message: 'standardAnnualDays cannot be below the statutory minimum for category',
    path: ['standardAnnualDays'],
  });
export type HrLeaveBalanceAsk = z.input<typeof zHrLeaveBalanceAsk>;

export const zHrLeaveEntryView = z.object({
  id: zId,
  employeeId: zId,
  month: z.string(),
  kind: z.enum(HR_LEAVE_ENTRY_KINDS),
  days: z.string(),
  approved: z.boolean(),
});
export type HrLeaveEntryView = z.infer<typeof zHrLeaveEntryView>;

export const zHrLeaveBalanceSummary = z.object({
  year: z.string(),
  eligibleMonths: z.number().int(),
  entitlementDays: z.string(),
  seniorityYears: z.number().int(),
  seniorityDays: z.string(),
  totalEntitlementDays: z.string(),
  openingDays: z.string(),
  takenAnnualDays: z.string(),
  signedBalanceDays: z.string(),
  remainingAnnualDays: z.string(),
  exceededAnnualDays: z.string(),
  personalPaidDays: z.string(),
  unpaidDaysByMonth: z.record(z.string(), z.string()),
  sicknessBhxhDays: z.string(),
  maternityBhxhDays: z.string(),
  sicknessBhxhDaysByMonth: z.record(z.string(), z.string()),
  maternityBhxhDaysByMonth: z.record(z.string(), z.string()),
  rulesUsed: z.array(zHrRuleRef),
});
export type HrLeaveBalanceSummary = z.infer<typeof zHrLeaveBalanceSummary>;

export const zHrLeaveBalanceResult = z.object({
  employeeId: zId,
  year: z.string(),
  category: z.enum(HR_LEAVE_CATEGORIES),
  hireDate: z.string(),
  endedOn: z.string().nullable(),
  entries: z.array(zHrLeaveEntryView),
  balance: zHrLeaveBalanceSummary,
});
export type HrLeaveBalanceResult = z.infer<typeof zHrLeaveBalanceResult>;

export const zHrLeaveRequestDays = zHrLeaveDays.refine((v) => Number(v) > 0, 'leave request days must be > 0');

export const zHrLeaveNote = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((v) => !v.includes('\u0000'), 'no NUL character');

export const zHrSelfManagedDepartment = z.object({
  id: zId,
  legalEntityId: zId,
  name: z.string(),
  code: z.string().nullable(),
});
export type HrSelfManagedDepartment = z.infer<typeof zHrSelfManagedDepartment>;

export const zHrSelfProfileAsk = z.strictObject({});
export type HrSelfProfileAsk = z.infer<typeof zHrSelfProfileAsk>;

export const zHrSelfProfile = z.object({
  linked: z.boolean(),
  employeeId: zId.nullable(),
  displayName: z.string().nullable(),
  legalEntityId: zId.nullable(),
  legalEntityName: z.string().nullable(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  departmentManagerName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  status: z.enum(HR_STATUSES).nullable(),
  hireDate: z.string().nullable(),
  endedOn: z.string().nullable(),
  managesDepartmentCount: z.number().int().nonnegative(),
  managedDepartments: z.array(zHrSelfManagedDepartment),
});
export type HrSelfProfile = z.infer<typeof zHrSelfProfile>;

export const zHrSelfLeaveBalanceAsk = z
  .strictObject({
    year: zHrLeaveYear,
    category: z.enum(HR_LEAVE_CATEGORIES).default('standard'),
    standardAnnualDays: zHrAnnualLeaveBaseline.optional(),
    asOfMonth: zHrMonth.optional(),
    workweek: z.enum(HR_LEAVE_WORKWEEKS).optional(),
  })
  .refine((v) => v.asOfMonth === undefined || v.asOfMonth.startsWith(`${v.year}-`), {
    message: 'asOfMonth must be within year',
    path: ['asOfMonth'],
  })
  .refine((v) => v.standardAnnualDays === undefined || leaveBaselineMeetsCategoryFloor(v.category, v.standardAnnualDays), {
    message: 'standardAnnualDays cannot be below the statutory minimum for category',
    path: ['standardAnnualDays'],
  });
export type HrSelfLeaveBalanceAsk = z.input<typeof zHrSelfLeaveBalanceAsk>;

export const zHrSelfLeaveBalanceResult = z.object({
  linked: z.boolean(),
  employeeId: zId.nullable(),
  year: z.string(),
  category: z.enum(HR_LEAVE_CATEGORIES),
  hireDate: z.string().nullable(),
  endedOn: z.string().nullable(),
  entries: z.array(zHrLeaveEntryView),
  balance: zHrLeaveBalanceSummary.nullable(),
});
export type HrSelfLeaveBalanceResult = z.infer<typeof zHrSelfLeaveBalanceResult>;

export const zHrLeaveRequestRef = z.strictObject({ requestId: zId });
export type HrLeaveRequestRef = z.infer<typeof zHrLeaveRequestRef>;

export const zHrLeaveRequestView = z.object({
  id: zId,
  legalEntityId: zId,
  employeeId: zId,
  employeeName: z.string(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  month: z.string(),
  startOn: z.string(),
  endOn: z.string(),
  kind: z.enum(HR_LEAVE_REQUEST_KINDS),
  days: z.string(),
  status: z.enum(HR_LEAVE_REQUEST_STATUSES),
  reason: z.string().nullable(),
  decisionNote: z.string().nullable(),
  l1ApproverUserId: zId.nullable(),
  l1ApproverName: z.string().nullable(),
  l1ActedAt: z.string().nullable(),
  finalActedBy: zId.nullable(),
  finalActedByName: z.string().nullable(),
  finalActedAt: z.string().nullable(),
  payrollLeaveEntryId: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HrLeaveRequestView = z.infer<typeof zHrLeaveRequestView>;

export const zHrSelfLeaveRequestList = z.strictObject({
  scope: z.enum(['mine', 'team', 'all']).default('all'),
  status: z.enum(HR_LEAVE_REQUEST_STATUSES).optional(),
  year: zHrLeaveYear.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrSelfLeaveRequestList = z.input<typeof zHrSelfLeaveRequestList>;

export const zHrSelfLeaveRequestSubmit = z
  .strictObject({
    startOn: zLocalDate,
    endOn: zLocalDate,
    kind: z.enum(HR_LEAVE_REQUEST_KINDS),
    days: zHrLeaveRequestDays,
    reason: zHrLeaveNote.optional(),
  })
  .refine((v) => v.endOn >= v.startOn, {
    message: 'endOn must be on or after startOn',
    path: ['endOn'],
  })
  .refine((v) => v.startOn.slice(0, 7) === v.endOn.slice(0, 7), {
    message: 'leave request must stay within a single month',
    path: ['endOn'],
  })
  .refine((v) => v.kind !== 'unpaid_leave' || HR_UNPAID_LEAVE_PRECISION_RE.test(v.days), {
    message: 'unpaid_leave supports at most 1 decimal place',
    path: ['days'],
  });
export type HrSelfLeaveRequestSubmit = z.input<typeof zHrSelfLeaveRequestSubmit>;

export const zHrSelfLeaveSubmitResult = z.object({
  requestId: zId,
  status: z.enum(['pending_l1', 'pending_final']),
  overlapCount: z.number().int().nonnegative(),
});
export type HrSelfLeaveSubmitResult = z.infer<typeof zHrSelfLeaveSubmitResult>;

export const zHrLeaveRequestList = z.strictObject({
  status: z.enum(HR_LEAVE_REQUEST_STATUSES).optional(),
  departmentId: zId.optional(),
  legalEntityId: zId.optional(),
  employeeId: zId.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrLeaveRequestList = z.input<typeof zHrLeaveRequestList>;

export const zHrLeaveRequestDecide = z.strictObject({
  requestId: zId,
  note: zHrLeaveNote.optional(),
});
export type HrLeaveRequestDecide = z.input<typeof zHrLeaveRequestDecide>;

export const zHrLeaveRequestActionResult = z.object({
  requestId: zId,
  status: z.enum(HR_LEAVE_REQUEST_STATUSES),
  payrollLeaveEntryId: zId.nullable(),
});
export type HrLeaveRequestActionResult = z.infer<typeof zHrLeaveRequestActionResult>;

export const zHrSelfPayslipsList = z.strictObject({
  limit: z.number().int().min(1).max(120).default(24),
});
export type HrSelfPayslipsList = z.input<typeof zHrSelfPayslipsList>;

export const zHrSelfPayslipSummary = z.object({
  lineId: zId,
  runId: zId,
  month: z.string(),
  status: z.enum(HR_RUN_STATUSES),
  gross: z.string(),
  net: z.string(),
  approvedAt: z.string().nullable(),
});
export type HrSelfPayslipSummary = z.infer<typeof zHrSelfPayslipSummary>;

// SPDX-License-Identifier: AGPL-3.0-only
// Employee annual leave ledger & statutory balance (issue #3394, #2540 slice 1c-2, docs/plan/payroll.md section 5 rows 3 & 6.7, section 7, ADR-0046).
import { z } from 'zod';
import {
  HR_LEAVE_CATEGORIES,
  leaveBaselineMeetsCategoryFloor,
  zHrAnnualLeaveBaseline,
} from './hr.ts';
import { zHrMonth, zHrRuleRef } from './hr-payroll.ts';
import { zId } from './schemas.ts';

export const HR_LEAVE_ENTRY_KINDS = ['opening_balance', 'annual_leave', 'personal_paid', 'unpaid_leave'] as const;
export type HrLeaveEntryKind = (typeof HR_LEAVE_ENTRY_KINDS)[number];

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

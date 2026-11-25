// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 6B contracts (#4527): salary advances, retro/offset payroll adjustments, and business trip requests.
import { z } from 'zod';
import { zHrWage } from './hr.ts';
import { zHrMonth } from './hr-payroll.ts';
import { zId, zLocalDate } from './schemas.ts';

const noNul = (value: string): boolean => !value.includes('\0');
const withinNumeric14_2 = (value: string): boolean => /^\d{1,12}(\.\d{1,2})?$/.test(value.trim());
const positiveDecimal = (value: string): boolean => {
  const trimmed = value.trim();
  return withinNumeric14_2(trimmed) && /[1-9]/.test(trimmed);
};

export const HR_SALARY_ADVANCE_STATUSES = ['pending_l1', 'pending_final', 'approved', 'rejected', 'cancelled'] as const;
export type HrSalaryAdvanceStatus = (typeof HR_SALARY_ADVANCE_STATUSES)[number];

export const HR_PAYROLL_ADJUSTMENT_KINDS = ['retro_pay', 'offset_deduction'] as const;
export type HrPayrollAdjustmentKind = (typeof HR_PAYROLL_ADJUSTMENT_KINDS)[number];

export const HR_PAYROLL_ADJUSTMENT_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type HrPayrollAdjustmentStatus = (typeof HR_PAYROLL_ADJUSTMENT_STATUSES)[number];

export const HR_BUSINESS_TRIP_STATUSES = ['pending_l1', 'pending_final', 'approved', 'rejected', 'cancelled'] as const;
export type HrBusinessTripStatus = (typeof HR_BUSINESS_TRIP_STATUSES)[number];

export const HR_STAGE6B_SYNC_SKIP_REASONS = ['manual_override'] as const;
export type HrStage6bSyncSkipReason = (typeof HR_STAGE6B_SYNC_SKIP_REASONS)[number];

export const zHrStage6bMoney = zHrWage.refine(withinNumeric14_2, 'amount exceeds numeric(14,2) range');
export const zHrPositiveMoney = zHrStage6bMoney.refine(positiveDecimal, 'amount must be greater than zero');
export const zHrStage6bReason = z.string().trim().min(1).max(2000).refine(noNul, 'no NUL character');
export const zHrStage6bDecisionNote = z.string().trim().min(1).max(1000).refine(noNul, 'no NUL character');
export const zHrTripDestination = z.string().trim().min(1).max(200).refine(noNul, 'no NUL character');

// Salary advance requests.
export const zHrSelfAdvanceSubmit = z.strictObject({
  month: zHrMonth,
  amount: zHrPositiveMoney,
  reason: zHrStage6bReason,
});
export type HrSelfAdvanceSubmit = z.input<typeof zHrSelfAdvanceSubmit>;

export const zHrSelfAdvanceSubmitResult = z.object({
  requestId: zId,
  status: z.enum(HR_SALARY_ADVANCE_STATUSES),
});
export type HrSelfAdvanceSubmitResult = z.infer<typeof zHrSelfAdvanceSubmitResult>;

export const zHrAdvanceRef = z.strictObject({
  requestId: zId,
});
export type HrAdvanceRef = z.input<typeof zHrAdvanceRef>;

export const zHrAdvanceDecide = z.strictObject({
  requestId: zId,
  note: zHrStage6bDecisionNote.optional(),
});
export type HrAdvanceDecide = z.input<typeof zHrAdvanceDecide>;

export const zHrAdvanceRequestView = z.object({
  id: zId,
  legalEntityId: zId,
  employeeId: zId,
  employeeName: z.string(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  month: zHrMonth,
  amount: z.string(),
  reason: z.string().nullable(),
  status: z.enum(HR_SALARY_ADVANCE_STATUSES),
  l1ApproverUserId: zId.nullable(),
  l1ActedAt: z.string().nullable(),
  finalActedBy: zId.nullable(),
  finalActedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  payrollRunId: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canApproveL1: z.boolean(),
  canApproveFinal: z.boolean(),
  canCancel: z.boolean(),
  payrollRunLocked: z.boolean().optional(),
});
export type HrAdvanceRequestView = z.infer<typeof zHrAdvanceRequestView>;

export const zHrSelfAdvanceList = z.strictObject({
  status: z.enum(HR_SALARY_ADVANCE_STATUSES).optional(),
  month: zHrMonth.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrSelfAdvanceList = z.input<typeof zHrSelfAdvanceList>;

export const zHrSelfAdvanceListResult = z.object({
  employeeId: zId.nullable(),
  employeeName: z.string().nullable(),
  departmentId: zId.nullable(),
  lockedMonths: z.array(zHrMonth).optional(),
  items: z.array(zHrAdvanceRequestView),
  l1Queue: z.array(zHrAdvanceRequestView),
});
export type HrSelfAdvanceListResult = z.infer<typeof zHrSelfAdvanceListResult>;

export const zHrAdvanceList = z.strictObject({
  legalEntityId: zId.optional(),
  status: z.enum(HR_SALARY_ADVANCE_STATUSES).optional(),
  month: zHrMonth.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrAdvanceList = z.input<typeof zHrAdvanceList>;

export const zHrAdvanceActionResult = z.object({
  requestId: zId,
  status: z.enum(HR_SALARY_ADVANCE_STATUSES),
  payrollSynced: z.boolean().optional(),
  payrollSyncSkippedReason: z.enum(HR_STAGE6B_SYNC_SKIP_REASONS).optional(),
});
export type HrAdvanceActionResult = z.infer<typeof zHrAdvanceActionResult>;

// Retro / offset payroll adjustment items.
export const zHrAdjustmentCreate = z.strictObject({
  employeeId: zId,
  month: zHrMonth,
  kind: z.enum(HR_PAYROLL_ADJUSTMENT_KINDS),
  amount: zHrPositiveMoney,
  reason: zHrStage6bReason,
});
export type HrAdjustmentCreate = z.input<typeof zHrAdjustmentCreate>;

export const zHrAdjustmentList = z.strictObject({
  legalEntityId: zId.optional(),
  month: zHrMonth.optional(),
  status: z.enum(HR_PAYROLL_ADJUSTMENT_STATUSES).optional(),
  employeeId: zId.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrAdjustmentList = z.input<typeof zHrAdjustmentList>;

export const zHrAdjustmentRef = z.strictObject({
  itemId: zId,
});
export type HrAdjustmentRef = z.input<typeof zHrAdjustmentRef>;

export const zHrAdjustmentDecide = z.strictObject({
  itemId: zId,
  note: zHrStage6bDecisionNote.optional(),
});
export type HrAdjustmentDecide = z.input<typeof zHrAdjustmentDecide>;

export const zHrAdjustmentItemView = z.object({
  id: zId,
  legalEntityId: zId,
  employeeId: zId,
  employeeName: z.string(),
  month: zHrMonth,
  kind: z.enum(HR_PAYROLL_ADJUSTMENT_KINDS),
  amount: z.string(),
  reason: z.string().nullable(),
  status: z.enum(HR_PAYROLL_ADJUSTMENT_STATUSES),
  reviewedBy: zId.nullable(),
  reviewedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  payrollRunId: zId.nullable(),
  createdBy: zId.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canApprove: z.boolean(),
  canCancel: z.boolean(),
});
export type HrAdjustmentItemView = z.infer<typeof zHrAdjustmentItemView>;

export const zHrAdjustmentActionResult = z.object({
  itemId: zId,
  status: z.enum(HR_PAYROLL_ADJUSTMENT_STATUSES),
  payrollSynced: z.boolean().optional(),
  payrollSyncSkippedReason: z.enum(HR_STAGE6B_SYNC_SKIP_REASONS).optional(),
});
export type HrAdjustmentActionResult = z.infer<typeof zHrAdjustmentActionResult>;

// Business trip requests.
export const zHrSelfTripSubmit = z
  .strictObject({
    destination: zHrTripDestination,
    purpose: zHrStage6bReason,
    startOn: zLocalDate,
    endOn: zLocalDate,
    estimatedAllowance: zHrStage6bMoney.default('0'),
  })
  .refine((v) => v.endOn >= v.startOn, { message: 'endOn must be on or after startOn', path: ['endOn'] });
export type HrSelfTripSubmit = z.input<typeof zHrSelfTripSubmit>;

export const zHrSelfTripSubmitResult = z.object({
  requestId: zId,
  status: z.enum(HR_BUSINESS_TRIP_STATUSES),
});
export type HrSelfTripSubmitResult = z.infer<typeof zHrSelfTripSubmitResult>;

export const zHrTripRef = z.strictObject({
  requestId: zId,
});
export type HrTripRef = z.input<typeof zHrTripRef>;

export const zHrTripDecide = z.strictObject({
  requestId: zId,
  note: zHrStage6bDecisionNote.optional(),
});
export type HrTripDecide = z.input<typeof zHrTripDecide>;

export const zHrTripRequestView = z.object({
  id: zId,
  legalEntityId: zId,
  employeeId: zId,
  employeeName: z.string(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  destination: z.string().nullable(),
  purpose: z.string().nullable(),
  startOn: zLocalDate,
  endOn: zLocalDate,
  estimatedAllowance: z.string(),
  status: z.enum(HR_BUSINESS_TRIP_STATUSES),
  l1ApproverUserId: zId.nullable(),
  l1ActedAt: z.string().nullable(),
  finalActedBy: zId.nullable(),
  finalActedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  canApproveL1: z.boolean(),
  canApproveFinal: z.boolean(),
  canCancel: z.boolean(),
});
export type HrTripRequestView = z.infer<typeof zHrTripRequestView>;

export const zHrSelfTripList = z.strictObject({
  status: z.enum(HR_BUSINESS_TRIP_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrSelfTripList = z.input<typeof zHrSelfTripList>;

export const zHrSelfTripListResult = z.object({
  employeeId: zId.nullable(),
  employeeName: z.string().nullable(),
  departmentId: zId.nullable(),
  items: z.array(zHrTripRequestView),
  l1Queue: z.array(zHrTripRequestView),
});
export type HrSelfTripListResult = z.infer<typeof zHrSelfTripListResult>;

export const zHrTripList = z.strictObject({
  legalEntityId: zId.optional(),
  status: z.enum(HR_BUSINESS_TRIP_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrTripList = z.input<typeof zHrTripList>;

export const zHrTripActionResult = z.object({
  requestId: zId,
  status: z.enum(HR_BUSINESS_TRIP_STATUSES),
});
export type HrTripActionResult = z.infer<typeof zHrTripActionResult>;

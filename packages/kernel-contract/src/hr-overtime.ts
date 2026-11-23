// SPDX-License-Identifier: AGPL-3.0-only
// HR 2-level overtime (OT) request workflow contracts and Art. 98 multiplier metadata (#4448, Stage 5B).
import { z } from 'zod';
import { zHrMonth } from './hr-payroll.ts';
import { zId, zLocalDate } from './schemas.ts';

export const HR_OVERTIME_STATUSES = ['pending_l1', 'pending_final', 'approved', 'rejected', 'cancelled'] as const;
export type HrOvertimeStatus = (typeof HR_OVERTIME_STATUSES)[number];

export const HR_OVERTIME_DAY_TYPES = ['weekday', 'weekend', 'holiday'] as const;
export type HrOvertimeDayType = (typeof HR_OVERTIME_DAY_TYPES)[number];

// Vietnam Labor Code 2019 Art. 107(2)(b) ordinary monthly OT cap (40 hours/month warning threshold).
export const HR_OVERTIME_MONTHLY_CAP_HOURS = '40';

// Art. 98 multipliers explicitly marked commentary until accountant primary confirmation (#2535).
export const HR_OVERTIME_COMMENTARY_RULES: Record<
  HrOvertimeDayType,
  { multiplierPercent: number; ruleId: string; status: 'commentary' }
> = {
  weekday: { multiplierPercent: 150, ruleId: 'overtime_multiples.normal_day', status: 'commentary' },
  weekend: { multiplierPercent: 200, ruleId: 'overtime_multiples.weekly_rest_day', status: 'commentary' },
  holiday: { multiplierPercent: 300, ruleId: 'overtime_multiples.holiday', status: 'commentary' },
};

const noNul = (value: string): boolean => !value.includes('\0');
const centiHours = (value: string): number => {
  const [whole, frac = ''] = value.split('.');
  return Number.parseInt(whole ?? '0', 10) * 100 + Number.parseInt(frac.padEnd(2, '0'), 10);
};

export const zHrOvertimeHours = z
  .string()
  .trim()
  .regex(/^\d{1,2}(\.\d{1,2})?$/, 'decimal hours with up to 2 decimals')
  .refine((v) => {
    const centi = centiHours(v);
    return centi > 0 && centi <= 2400;
  }, 'hours must be > 0 and <= 24');

export const zHrOvertimeNote = z.string().trim().min(1).max(2000).refine(noNul, 'no NUL character');

export const zHrSelfOvertimeSubmit = z.strictObject({
  workDate: zLocalDate,
  hours: zHrOvertimeHours,
  dayType: z.enum(HR_OVERTIME_DAY_TYPES),
  isNight: z.boolean().default(false),
  reason: zHrOvertimeNote.optional(),
});
export type HrSelfOvertimeSubmit = z.input<typeof zHrSelfOvertimeSubmit>;

export const zHrSelfOvertimeSubmitResult = z.object({
  requestId: zId,
  status: z.enum(['pending_l1', 'pending_final']),
  month: zHrMonth,
  monthHoursTotal: z.string(),
  exceedsMonthlyCap: z.boolean(),
});
export type HrSelfOvertimeSubmitResult = z.infer<typeof zHrSelfOvertimeSubmitResult>;

export const zHrOvertimeRef = z.strictObject({
  requestId: zId,
});
export type HrOvertimeRef = z.input<typeof zHrOvertimeRef>;

export const zHrOvertimeRequestView = z.object({
  id: zId,
  employeeId: zId,
  employeeName: z.string(),
  legalEntityId: zId,
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  month: zHrMonth,
  workDate: z.string(),
  hours: z.string(),
  dayType: z.enum(HR_OVERTIME_DAY_TYPES),
  isNight: z.boolean(),
  multiplierPercent: z.number().int(),
  ruleStatus: z.literal('commentary'),
  ruleId: z.string(),
  status: z.enum(HR_OVERTIME_STATUSES),
  l1ApproverUserId: zId.nullable(),
  l1ActedAt: z.string().nullable(),
  finalActedBy: zId.nullable(),
  finalActedAt: z.string().nullable(),
  reason: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
});
export type HrOvertimeRequestView = z.infer<typeof zHrOvertimeRequestView>;

export const zHrSelfOvertimeList = z.strictObject({
  month: zHrMonth.optional(),
  status: z.enum(HR_OVERTIME_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrSelfOvertimeList = z.input<typeof zHrSelfOvertimeList>;

export const zHrSelfOvertimeListResult = z.object({
  requests: z.array(zHrOvertimeRequestView),
  teamPending: z.array(zHrOvertimeRequestView),
  monthApprovedHours: z.string(),
});
export type HrSelfOvertimeListResult = z.infer<typeof zHrSelfOvertimeListResult>;

export const zHrOvertimeList = z.strictObject({
  month: zHrMonth.optional(),
  status: z.enum(HR_OVERTIME_STATUSES).optional(),
  departmentId: zId.optional(),
  legalEntityId: zId.optional(),
  employeeId: zId.optional(),
  limit: z.number().int().min(1).max(200).default(100),
});
export type HrOvertimeList = z.input<typeof zHrOvertimeList>;

export const zHrOvertimeDecide = z.strictObject({
  requestId: zId,
  note: zHrOvertimeNote.optional(),
});
export type HrOvertimeDecide = z.input<typeof zHrOvertimeDecide>;

export const zHrOvertimeActionResult = z.object({
  requestId: zId,
  status: z.enum(HR_OVERTIME_STATUSES),
  payrollRunUpdated: z.boolean(),
});
export type HrOvertimeActionResult = z.infer<typeof zHrOvertimeActionResult>;

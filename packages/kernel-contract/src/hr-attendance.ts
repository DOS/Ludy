// SPDX-License-Identifier: AGPL-3.0-only
// HR Stage 5C (#4447): Web/PWA 1-click attendance check-in/out, office QR stamp,
// deterministic anomaly detection, metered Ly narration, and monthly payroll rollup.
// Zero biometric, FaceID, photo, or location tracking stored (Vietnam PDPL 91/2025/QH15).
import { z } from 'zod';
import { zHrMonth } from './hr-payroll.ts';
import { zId, zLocalDate } from './schemas.ts';

export const HR_ATTENDANCE_METHODS = ['web', 'qr', 'manual'] as const;
export type HrAttendanceMethod = (typeof HR_ATTENDANCE_METHODS)[number];

export const HR_ATTENDANCE_SELF_CHECKIN_METHODS = ['web', 'qr'] as const;
export type HrAttendanceSelfCheckinMethod = (typeof HR_ATTENDANCE_SELF_CHECKIN_METHODS)[number];

export const HR_ATTENDANCE_STATUSES = ['present', 'half_day', 'missing_checkout', 'adjusted'] as const;
export type HrAttendanceStatus = (typeof HR_ATTENDANCE_STATUSES)[number];

export const HR_ATTENDANCE_ANOMALY_KINDS = [
  'missing_checkout',
  'short_day',
  'long_day',
  'weekend_work',
  'holiday_work',
] as const;
export type HrAttendanceAnomalyKind = (typeof HR_ATTENDANCE_ANOMALY_KINDS)[number];

export const HR_ATTENDANCE_NOTE_MAX = 500;
export const HR_ATTENDANCE_QR_TOKEN_MAX = 512;

export const zHrSelfAttendanceCheckIn = z
  .strictObject({
    method: z.enum(HR_ATTENDANCE_SELF_CHECKIN_METHODS).default('web'),
    qrToken: z.string().trim().min(1).max(HR_ATTENDANCE_QR_TOKEN_MAX).optional(),
    note: z.string().trim().min(1).max(HR_ATTENDANCE_NOTE_MAX).optional(),
  })
  .refine((v) => v.method !== 'qr' || (typeof v.qrToken === 'string' && v.qrToken.length > 0), {
    message: 'qrToken is required when check-in method is qr',
    path: ['qrToken'],
  });
export type HrSelfAttendanceCheckIn = z.input<typeof zHrSelfAttendanceCheckIn>;

export const zHrSelfAttendanceCheckOut = z.strictObject({
  workDate: zLocalDate.optional(),
  note: z.string().trim().min(1).max(HR_ATTENDANCE_NOTE_MAX).optional(),
});
export type HrSelfAttendanceCheckOut = z.input<typeof zHrSelfAttendanceCheckOut>;

export const zHrSelfAttendanceList = z.strictObject({
  month: zHrMonth.optional(),
});
export type HrSelfAttendanceList = z.input<typeof zHrSelfAttendanceList>;

export const zHrAttendanceLogView = z.object({
  id: zId,
  legalEntityId: zId,
  employeeId: zId,
  workDate: zLocalDate,
  checkedInAt: z.string().nullable(),
  checkedOutAt: z.string().nullable(),
  checkInMethod: z.enum(HR_ATTENDANCE_METHODS),
  workedMinutes: z.number().int().min(0).max(1440).nullable(),
  status: z.enum(HR_ATTENDANCE_STATUSES),
  note: z.string().nullable(),
  anomalies: z.array(z.enum(HR_ATTENDANCE_ANOMALY_KINDS)),
  updatedAt: z.string(),
});
export type HrAttendanceLogView = z.infer<typeof zHrAttendanceLogView>;

export const zHrAttendanceSummary = z.object({
  presentDays: z.number().int().min(0),
  halfDays: z.number().int().min(0),
  missingCheckoutDays: z.number().int().min(0),
  adjustedDays: z.number().int().min(0),
  totalWorkedMinutes: z.number().int().min(0),
});
export type HrAttendanceSummary = z.infer<typeof zHrAttendanceSummary>;

export const zHrSelfAttendanceListResult = z.object({
  employeeId: zId,
  legalEntityId: zId,
  month: zHrMonth,
  today: zLocalDate,
  todayLog: zHrAttendanceLogView.nullable(),
  openLog: zHrAttendanceLogView.nullable(),
  logs: z.array(zHrAttendanceLogView),
  summary: zHrAttendanceSummary,
});
export type HrSelfAttendanceListResult = z.infer<typeof zHrSelfAttendanceListResult>;

export const zHrAttendanceList = z.strictObject({
  month: zHrMonth.optional(),
  legalEntityId: zId.optional(),
  employeeId: zId.optional(),
  anomaliesOnly: z.boolean().default(false),
});
export type HrAttendanceList = z.input<typeof zHrAttendanceList>;

export const zHrAdminAttendanceRow = zHrAttendanceLogView.extend({
  employeeName: z.string(),
  payBasis: z.enum(['monthly', 'hourly', 'piece_rate']),
});
export type HrAdminAttendanceRow = z.infer<typeof zHrAdminAttendanceRow>;

export const zHrAttendanceAnomaly = z.object({
  logId: zId,
  employeeId: zId,
  employeeName: z.string(),
  workDate: zLocalDate,
  kind: z.enum(HR_ATTENDANCE_ANOMALY_KINDS),
  workedMinutes: z.number().int().min(0).max(1440).nullable(),
  status: z.enum(HR_ATTENDANCE_STATUSES),
});
export type HrAttendanceAnomaly = z.infer<typeof zHrAttendanceAnomaly>;

export const zHrAttendanceQrStatus = z.object({
  configured: z.boolean(),
  activeConfigId: zId.nullable(),
  legalEntityId: zId,
  rotatedAt: z.string().nullable(),
});
export type HrAttendanceQrStatus = z.infer<typeof zHrAttendanceQrStatus>;

export const zHrAttendanceListResult = z.object({
  month: zHrMonth,
  today: zLocalDate,
  legalEntityId: zId,
  logs: z.array(zHrAdminAttendanceRow),
  anomalies: z.array(zHrAttendanceAnomaly),
  qrConfig: zHrAttendanceQrStatus,
});
export type HrAttendanceListResult = z.infer<typeof zHrAttendanceListResult>;

export const zHrAttendanceAdjust = z
  .strictObject({
    employeeId: zId,
    workDate: zLocalDate,
    checkedInAt: z.string().datetime({ offset: true }).nullable().optional(),
    checkedOutAt: z.string().datetime({ offset: true }).nullable().optional(),
    checkInMethod: z.enum(HR_ATTENDANCE_METHODS).default('manual'),
    workedMinutes: z.number().int().min(0).max(1440).nullable().optional(),
    status: z.enum(['present', 'half_day', 'adjusted']).default('adjusted'),
    note: z.string().trim().min(1).max(HR_ATTENDANCE_NOTE_MAX).nullable().optional(),
    expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine(
    (v) => {
      if (!v.checkedInAt || !v.checkedOutAt) return true;
      return Date.parse(v.checkedOutAt) >= Date.parse(v.checkedInAt);
    },
    { message: 'checkedOutAt cannot be earlier than checkedInAt', path: ['checkedOutAt'] },
  );
export type HrAttendanceAdjust = z.input<typeof zHrAttendanceAdjust>;

export const zHrAttendanceQrRotate = z.strictObject({
  legalEntityId: zId.optional(),
});
export type HrAttendanceQrRotate = z.input<typeof zHrAttendanceQrRotate>;

export const zHrAttendanceQrRotateResult = z.object({
  configId: zId,
  legalEntityId: zId,
  secret: z.string(),
  rotatedAt: z.string(),
});
export type HrAttendanceQrRotateResult = z.infer<typeof zHrAttendanceQrRotateResult>;

export const zHrAttendanceRollupToPayroll = z.strictObject({
  runId: zId,
  allowIncomplete: z.boolean().default(false),
});
export type HrAttendanceRollupToPayroll = z.input<typeof zHrAttendanceRollupToPayroll>;

export const zHrAttendanceRollupRow = z.object({
  lineId: zId,
  employeeId: zId,
  employeeName: z.string(),
  workedDays: z.string(),
  paidLeaveDays: z.string(),
  unpaidLeaveDays: z.string(),
  workedHours: z.string().nullable(),
  overtimeHours: z.string(),
  nightHours: z.string(),
});
export type HrAttendanceRollupRow = z.infer<typeof zHrAttendanceRollupRow>;

export const zHrAttendanceRollupResult = z.object({
  runId: zId,
  month: zHrMonth,
  updatedCount: z.number().int().min(0),
  skippedEmployeeCount: z.number().int().min(0),
  missingCheckoutCount: z.number().int().min(0),
  rows: z.array(zHrAttendanceRollupRow),
});
export type HrAttendanceRollupResult = z.infer<typeof zHrAttendanceRollupResult>;

export const ATTENDANCE_ANOMALY_AI_REASONS = ['ok', 'off', 'budget', 'rate_limited', 'unavailable', 'refused'] as const;
export type AttendanceAnomalyAiReason = (typeof ATTENDANCE_ANOMALY_AI_REASONS)[number];

export const zHrAttendanceAnomaliesAudit = z.strictObject({
  month: zHrMonth,
  legalEntityId: zId,
  aiReason: z.enum(ATTENDANCE_ANOMALY_AI_REASONS),
});
export type HrAttendanceAnomaliesAudit = z.infer<typeof zHrAttendanceAnomaliesAudit>;

export const zHrAttendanceAnomaliesAsk = z.strictObject({
  month: zHrMonth.optional(),
  legalEntityId: zId.optional(),
  lang: z.enum(['vi', 'en']).default('vi'),
});
export type HrAttendanceAnomaliesAsk = z.input<typeof zHrAttendanceAnomaliesAsk>;

export const zHrAttendanceAnomaliesSnapshot = z.object({
  month: zHrMonth,
  today: zLocalDate,
  legalEntityId: zId,
  lang: z.enum(['vi', 'en']),
  anomalies: z.array(zHrAttendanceAnomaly),
});
export type HrAttendanceAnomaliesSnapshot = z.infer<typeof zHrAttendanceAnomaliesSnapshot>;

export const zHrAttendanceAnomaliesBrief = z.object({
  month: zHrMonth,
  legalEntityId: zId,
  anomalies: z.array(zHrAttendanceAnomaly),
  summary: z.string().nullable(),
  highlights: z.array(z.string()),
  ai: z.object({
    ok: z.boolean(),
    reason: z.enum(ATTENDANCE_ANOMALY_AI_REASONS),
  }),
});
export type HrAttendanceAnomaliesBrief = z.infer<typeof zHrAttendanceAnomaliesBrief>;

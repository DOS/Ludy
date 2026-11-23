// SPDX-License-Identifier: AGPL-3.0-only
// HR end-of-probation review contracts with deterministic Projects evidence and optional Ly draft note (#4448, Stage 5B).
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';

export const HR_PROBATION_DECISIONS = ['pass', 'extend', 'terminate'] as const;
export type HrProbationDecision = (typeof HR_PROBATION_DECISIONS)[number];

export const HR_PROBATION_AI_STATES = ['used', 'off', 'busy', 'budget', 'failed', 'no_data'] as const;
export type HrProbationAiState = (typeof HR_PROBATION_AI_STATES)[number];

const noNul = (value: string): boolean => !value.includes('\0');
export const zHrProbationNote = z.string().trim().min(1).max(4000).refine(noNul, 'no NUL character');

export const zHrProbationTaskFact = z.object({
  taskId: zId,
  title: z.string(),
  projectId: zId.nullable(),
  projectName: z.string().nullable(),
  completedAt: z.string(),
});
export type HrProbationTaskFact = z.infer<typeof zHrProbationTaskFact>;

export const zProjectMemberCompletedTasksAsk = z.strictObject({
  userId: zId,
  from: zLocalDate,
  to: zLocalDate,
  limit: z.number().int().min(1).max(100).default(50),
});
export type ProjectMemberCompletedTasksAsk = z.input<typeof zProjectMemberCompletedTasksAsk>;

export const zProjectMemberCompletedTasksResult = z.object({
  totalCount: z.number().int().nonnegative(),
  tasks: z.array(zHrProbationTaskFact),
});
export type ProjectMemberCompletedTasksResult = z.infer<typeof zProjectMemberCompletedTasksResult>;

export const zHrProbationAttendanceSummary = z.object({
  monthCount: z.number().int().nonnegative(),
  annualLeaveDays: z.string(),
  personalPaidLeaveDays: z.string(),
  unpaidLeaveDays: z.string(),
  sicknessBhxhDays: z.string(),
  maternityBhxhDays: z.string(),
  overtimeHours: z.string(),
  overtimeRequestsCount: z.number().int().nonnegative(),
});
export type HrProbationAttendanceSummary = z.infer<typeof zHrProbationAttendanceSummary>;

export const zHrProbationPreviewAsk = z
  .strictObject({
    employeeId: zId,
    periodStart: zLocalDate.optional(),
    periodEnd: zLocalDate.optional(),
  })
  .refine((v) => v.periodStart === undefined || v.periodEnd === undefined || v.periodEnd >= v.periodStart, {
    message: 'periodEnd must be on or after periodStart',
    path: ['periodEnd'],
  });
export type HrProbationPreviewAsk = z.input<typeof zHrProbationPreviewAsk>;

export const zHrProbationPreviewResult = z.object({
  employeeId: zId,
  employeeName: z.string(),
  linkedUserId: zId.nullable(),
  departmentName: z.string().nullable(),
  jobTitle: z.string().nullable(),
  probationEndOn: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  projectsAvailable: z.boolean(),
  completedTasksCount: z.number().int().nonnegative(),
  completedTasks: z.array(zHrProbationTaskFact),
  attendance: zHrProbationAttendanceSummary,
});
export type HrProbationPreviewResult = z.infer<typeof zHrProbationPreviewResult>;

export const zHrProbationDraftAsk = z
  .strictObject({
    employeeId: zId,
    periodStart: zLocalDate.optional(),
    periodEnd: zLocalDate.optional(),
    lang: z.enum(['vi', 'en']).optional(),
  })
  .refine((v) => v.periodStart === undefined || v.periodEnd === undefined || v.periodEnd >= v.periodStart, {
    message: 'periodEnd must be on or after periodStart',
    path: ['periodEnd'],
  });
export type HrProbationDraftAsk = z.input<typeof zHrProbationDraftAsk>;

export const zHrProbationDraftResult = z.object({
  status: z.enum(HR_PROBATION_AI_STATES),
  draftNote: z.string().nullable(),
  preview: zHrProbationPreviewResult,
});
export type HrProbationDraftResult = z.infer<typeof zHrProbationDraftResult>;

export const zHrProbationDecide = z
  .strictObject({
    employeeId: zId,
    periodStart: zLocalDate,
    periodEnd: zLocalDate,
    probationEndOn: zLocalDate.nullable().optional(),
    decision: z.enum(HR_PROBATION_DECISIONS),
    extendedUntil: zLocalDate.nullable().optional(),
    reviewNote: zHrProbationNote.optional(),
    aiDraftNote: zHrProbationNote.nullable().optional(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, {
    message: 'periodEnd must be on or after periodStart',
    path: ['periodEnd'],
  })
  .refine((v) => v.decision !== 'extend' || (v.extendedUntil !== undefined && v.extendedUntil !== null && v.extendedUntil > v.periodEnd), {
    message: 'extendedUntil after periodEnd is required when extending probation',
    path: ['extendedUntil'],
  });
export type HrProbationDecide = z.input<typeof zHrProbationDecide>;

export const zHrProbationDecideResult = z.object({
  reviewId: zId,
  decision: z.enum(HR_PROBATION_DECISIONS),
});
export type HrProbationDecideResult = z.infer<typeof zHrProbationDecideResult>;

export const zHrProbationAiStatusAsk = z.strictObject({});

export const zHrProbationBriefAudit = z.strictObject({
  employeeId: zId,
  aiStatus: z.enum(HR_PROBATION_AI_STATES),
  completedTasksCount: z.number().int().nonnegative(),
});

export const zHrProbationList = z.strictObject({
  employeeId: zId.optional(),
  decision: z.enum(HR_PROBATION_DECISIONS).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
export type HrProbationList = z.input<typeof zHrProbationList>;

export const zHrProbationReviewView = z.object({
  id: zId,
  employeeId: zId,
  employeeName: z.string(),
  reviewerUserId: zId.nullable(),
  probationEndOn: z.string().nullable(),
  periodStart: z.string(),
  periodEnd: z.string(),
  completedTasksCount: z.number().int().nonnegative(),
  completedTasks: z.array(zHrProbationTaskFact),
  projectsAvailable: z.boolean(),
  attendance: zHrProbationAttendanceSummary,
  decision: z.enum(HR_PROBATION_DECISIONS),
  extendedUntil: z.string().nullable(),
  reviewNote: z.string().nullable(),
  aiDraftNote: z.string().nullable(),
  decidedAt: z.string(),
  createdAt: z.string(),
});
export type HrProbationReviewView = z.infer<typeof zHrProbationReviewView>;

// SPDX-License-Identifier: AGPL-3.0-only
// Projects Triage Inbox contracts (#4493, ADR-0058): authenticated routes only (private projects never appear publicly).
import { z } from 'zod';
import {
  zProjectColumn,
  zProjectCycleStatus,
  zProjectSeat,
  zProjectStatus,
  zProjectVisibility,
} from './projects.ts';
import { zId, zLocalDate, zTaskStatus } from './schemas.ts';

export const PROJECT_TRIAGE_TITLE_MAX = 300;
export const PROJECT_TRIAGE_DESCRIPTION_MAX = 10000;
export const PROJECT_TRIAGE_DECLINE_REASON_MAX = 1000;
export const PROJECT_TRIAGE_REASON_MAX = 400;
export const PROJECT_TRIAGE_LIST_LIMIT_MAX = 200;
export const PROJECT_TRIAGE_LIST_DEFAULT_LIMIT = 50;
export const PROJECT_TRIAGE_OPEN_TASKS_LIMIT = 150;

export const PROJECT_TRIAGE_SOURCE_TYPES = ['roadmap.item', 'kernel.conversation', 'meetings.meeting', 'manual'] as const;
export type ProjectTriageSourceType = (typeof PROJECT_TRIAGE_SOURCE_TYPES)[number];
export const zProjectTriageSourceType = z.enum(PROJECT_TRIAGE_SOURCE_TYPES);

export const PROJECT_TRIAGE_STATUSES = ['pending', 'snoozed', 'accepted', 'merged', 'declined'] as const;
export type ProjectTriageStatus = (typeof PROJECT_TRIAGE_STATUSES)[number];
export const zProjectTriageStatus = z.enum(PROJECT_TRIAGE_STATUSES);

export const PROJECT_TRIAGE_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export type ProjectTriagePriority = (typeof PROJECT_TRIAGE_PRIORITIES)[number];
export const zProjectTriagePriority = z.enum(PROJECT_TRIAGE_PRIORITIES);

export const PROJECT_TRIAGE_AI_STATES = ['used', 'off', 'paused', 'budget', 'busy', 'refused', 'empty', 'failed'] as const;
export type ProjectTriageAiState = (typeof PROJECT_TRIAGE_AI_STATES)[number];
export const zProjectTriageAiState = z.enum(PROJECT_TRIAGE_AI_STATES);

const zCleanLine = (max: number) =>
  z
    .string()
    .trim()
    .refine((v) => !v.includes('\u0000'), 'Control character NUL is not allowed')
    .pipe(z.string().min(1).max(max));

const zOptionalCleanText = (max: number) =>
  z
    .string()
    .trim()
    .refine((v) => !v.includes('\u0000'), 'Control character NUL is not allowed')
    .pipe(z.string().max(max))
    .nullable()
    .optional();

export const zProjectTriageItem = z.strictObject({
  id: zId,
  projectId: zId,
  projectName: z.string(),
  projectVisibility: zProjectVisibility,
  sourceType: zProjectTriageSourceType,
  sourceId: zId.nullable(),
  sourceLabel: z.string().nullable(),
  status: zProjectTriageStatus,
  priority: zProjectTriagePriority,
  title: z.string(),
  description: z.string().nullable(),
  tainted: z.boolean(),
  snoozedUntil: z.string().nullable(),
  snoozeElapsed: z.boolean(),
  acceptedTaskId: zId.nullable(),
  mergedIntoTaskId: zId.nullable(),
  declineReason: z.string().nullable(),
  triagedBy: zId.nullable(),
  triagedByName: z.string().nullable(),
  triagedAt: z.string().nullable(),
  createdBy: zId.nullable(),
  createdByName: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectTriageItem = z.infer<typeof zProjectTriageItem>;

export const zProjectTriageCreateFields = z.strictObject({
  projectId: zId,
  sourceType: zProjectTriageSourceType,
  sourceId: zId.nullable().optional(),
  priority: zProjectTriagePriority.optional(),
  title: zCleanLine(PROJECT_TRIAGE_TITLE_MAX),
  description: zOptionalCleanText(PROJECT_TRIAGE_DESCRIPTION_MAX),
  tainted: z.boolean().optional(),
});

export function validProjectTriageSourcePair(v: { sourceType: ProjectTriageSourceType; sourceId?: string | null | undefined }): boolean {
  if (v.sourceType === 'manual') return v.sourceId === undefined || v.sourceId === null;
  return typeof v.sourceId === 'string' && v.sourceId.length > 0;
}

export const PROJECT_TRIAGE_SOURCE_PAIR_ISSUE = {
  message: 'sourceId must be null/omitted when sourceType is manual and required for all other source types',
  path: ['sourceId'],
};

export const zProjectTriageCreateInput = zProjectTriageCreateFields.refine(
  validProjectTriageSourcePair,
  PROJECT_TRIAGE_SOURCE_PAIR_ISSUE,
);
export type ProjectTriageCreateInput = z.infer<typeof zProjectTriageCreateInput>;

export const zProjectTriageCursor = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  id: zId,
});
export type ProjectTriageCursor = z.infer<typeof zProjectTriageCursor>;

export const zProjectTriageListInput = z.strictObject({
  projectId: zId.optional(),
  statuses: z.array(zProjectTriageStatus).min(1).max(PROJECT_TRIAGE_STATUSES.length).optional(),
  cursor: zProjectTriageCursor.optional(),
  limit: z.number().int().min(1).max(PROJECT_TRIAGE_LIST_LIMIT_MAX).optional(),
});
export type ProjectTriageListInput = z.infer<typeof zProjectTriageListInput>;

export const zProjectTriageCounts = z.strictObject({
  pending: z.number().int().nonnegative(),
  snoozed: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  merged: z.number().int().nonnegative(),
  declined: z.number().int().nonnegative(),
  snoozeElapsed: z.number().int().nonnegative(),
});
export type ProjectTriageCounts = z.infer<typeof zProjectTriageCounts>;

export const zProjectTriageProjectOption = z.strictObject({
  id: zId,
  name: z.string(),
  visibility: zProjectVisibility,
  status: zProjectStatus,
  canWrite: z.boolean(),
});
export type ProjectTriageProjectOption = z.infer<typeof zProjectTriageProjectOption>;

export const zProjectTriageSeatOption = zProjectSeat.extend({
  projectIds: z.array(zId),
});
export type ProjectTriageSeatOption = z.infer<typeof zProjectTriageSeatOption>;

export const zProjectTriageCycleOption = z.strictObject({
  id: zId,
  projectId: zId,
  number: z.number().int().positive(),
  name: z.string(),
  status: zProjectCycleStatus,
  startsOn: zLocalDate,
  endsOn: zLocalDate,
});
export type ProjectTriageCycleOption = z.infer<typeof zProjectTriageCycleOption>;

export const zProjectTriageTaskOption = z.strictObject({
  id: zId,
  projectId: zId,
  title: z.string(),
  status: zTaskStatus,
});
export type ProjectTriageTaskOption = z.infer<typeof zProjectTriageTaskOption>;

export const zProjectTriageAiAvailability = z.strictObject({
  available: z.boolean(),
  reason: z.enum(['off', 'forbidden', 'paused', 'budget']).nullable(),
  resetOn: z.string().nullable(),
});
export type ProjectTriageAiAvailability = z.infer<typeof zProjectTriageAiAvailability>;

export const zProjectTriageListResult = z.strictObject({
  items: z.array(zProjectTriageItem),
  nextCursor: zProjectTriageCursor.nullable(),
  counts: zProjectTriageCounts,
  projects: z.array(zProjectTriageProjectOption),
  seats: z.array(zProjectTriageSeatOption),
  columns: z.array(zProjectColumn),
  cycles: z.array(zProjectTriageCycleOption),
  openTasks: z.array(zProjectTriageTaskOption),
  aiStatus: zProjectTriageAiAvailability,
});
export type ProjectTriageListResult = z.infer<typeof zProjectTriageListResult>;

export const zProjectTriageMutateResult = z.strictObject({
  item: zProjectTriageItem,
});
export type ProjectTriageMutateResult = z.infer<typeof zProjectTriageMutateResult>;

export const zProjectTriageAcceptInput = z.strictObject({
  itemId: zId,
  title: zCleanLine(PROJECT_TRIAGE_TITLE_MAX).optional(),
  description: zOptionalCleanText(PROJECT_TRIAGE_DESCRIPTION_MAX),
  assigneePositionId: zId.nullable().optional(),
  columnId: zId.nullable().optional(),
  cycleId: zId.nullable().optional(),
  due: z.iso.datetime({ offset: true }).nullable().optional(),
  priority: zProjectTriagePriority.optional(),
});
export type ProjectTriageAcceptInput = z.infer<typeof zProjectTriageAcceptInput>;

export const zProjectTriageAcceptResult = z.strictObject({
  item: zProjectTriageItem,
  taskId: zId,
  projectId: zId,
});
export type ProjectTriageAcceptResult = z.infer<typeof zProjectTriageAcceptResult>;

export const zProjectTriageMergeInput = z.strictObject({
  itemId: zId,
  targetTaskId: zId,
});
export type ProjectTriageMergeInput = z.infer<typeof zProjectTriageMergeInput>;

export const zProjectTriageSnoozeInput = z.strictObject({
  itemId: zId,
  snoozedUntil: z.iso.datetime({ offset: true }),
});
export type ProjectTriageSnoozeInput = z.infer<typeof zProjectTriageSnoozeInput>;

export const zProjectTriageDeclineInput = z.strictObject({
  itemId: zId,
  declineReason: zOptionalCleanText(PROJECT_TRIAGE_DECLINE_REASON_MAX),
});
export type ProjectTriageDeclineInput = z.infer<typeof zProjectTriageDeclineInput>;

export const zProjectTriageReopenInput = z.strictObject({
  itemId: zId,
});
export type ProjectTriageReopenInput = z.infer<typeof zProjectTriageReopenInput>;

export const zProjectTriageAssistInput = z.strictObject({
  itemId: zId,
  language: z.enum(['vi', 'en']).optional(),
});
export type ProjectTriageAssistInput = z.infer<typeof zProjectTriageAssistInput>;

export const zProjectTriageAssistProposal = z.strictObject({
  recommendedPriority: zProjectTriagePriority,
  suggestedAssigneePositionId: zId.nullable(),
  suggestedAssigneeLabel: z.string().nullable(),
  suggestedCycleId: zId.nullable(),
  suggestedCycleLabel: z.string().nullable(),
  duplicateTaskId: zId.nullable(),
  duplicateTaskTitle: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ProjectTriageAssistProposal = z.infer<typeof zProjectTriageAssistProposal>;

export const zProjectTriageAssistResult = z.strictObject({
  ai: zProjectTriageAiState,
  proposal: zProjectTriageAssistProposal.nullable(),
});
export type ProjectTriageAssistResult = z.infer<typeof zProjectTriageAssistResult>;

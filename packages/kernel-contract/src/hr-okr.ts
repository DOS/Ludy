// SPDX-License-Identifier: AGPL-3.0-only
// HR quarterly OKR contracts: Company -> Department -> Individual alignment, Ludy Cong tac project linkage, and optional Ly check-in draft (#4529, Stage 6D).
import { z } from 'zod';
import { zId } from './schemas.ts';

export const HR_OKR_SCOPES = ['company', 'department', 'individual'] as const;
export type HrOkrScope = (typeof HR_OKR_SCOPES)[number];

export const HR_OKR_STATUSES = ['draft', 'active', 'completed', 'archived'] as const;
export type HrOkrStatus = (typeof HR_OKR_STATUSES)[number];

export const HR_OKR_METRIC_TYPES = ['percent', 'number', 'currency', 'boolean', 'project_tasks'] as const;
export type HrOkrMetricType = (typeof HR_OKR_METRIC_TYPES)[number];

export const HR_OKR_AI_STATES = ['used', 'off', 'busy', 'budget', 'failed', 'no_data'] as const;
export type HrOkrAiState = (typeof HR_OKR_AI_STATES)[number];

export const HR_OKR_QUARTER_RE = /^[0-9]{4}-Q[1-4]$/;
export const HR_OKR_DECIMAL_RE = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;

const noNul = (value: string): boolean => !value.includes('\0');

export const zHrOkrQuarter = z.string().regex(HR_OKR_QUARTER_RE, 'quarter must match YYYY-QN');
export const zHrOkrTitle = z.string().trim().min(1).max(300).refine(noNul, 'no NUL character');
export const zHrOkrUnit = z.string().trim().min(1).max(32).refine(noNul, 'no NUL character');
export const zHrOkrNote = z.string().trim().min(1).max(2000).refine(noNul, 'no NUL character');
export const zHrOkrDecimal = z.string().trim().regex(HR_OKR_DECIMAL_RE, 'must be a non-negative decimal with at most 2 decimals');

export const zHrOkrLinkedTaskView = z.object({
  id: zId,
  title: z.string(),
  status: z.string(),
  completed: z.boolean(),
  statusName: z.string().nullable(),
});
export type HrOkrLinkedTaskView = z.infer<typeof zHrOkrLinkedTaskView>;

export const zHrOkrKeyResultView = z.object({
  id: zId,
  objectiveId: zId,
  title: z.string(),
  metricType: z.enum(HR_OKR_METRIC_TYPES),
  targetValue: z.string(),
  currentValue: z.string(),
  unit: z.string().nullable(),
  linkedProjectId: zId.nullable(),
  linkedProjectName: z.string().nullable(),
  linkedProjectAccessible: z.boolean(),
  linkedTaskIds: z.array(zId),
  linkedTasks: z.array(zHrOkrLinkedTaskView),
  completedLinkedTasks: z.number().int().nonnegative(),
  totalLinkedTasks: z.number().int().nonnegative(),
  progressPct: z.string(),
  lastCheckinNote: z.string().nullable(),
  lastCheckinAt: z.string().nullable(),
  lastCheckinBy: zId.nullable(),
  lastCheckinByName: z.string().nullable(),
  canCheckin: z.boolean(),
  canEdit: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HrOkrKeyResultView = z.infer<typeof zHrOkrKeyResultView>;

export const zHrOkrObjectiveView = z.object({
  id: zId,
  legalEntityId: zId,
  quarter: zHrOkrQuarter,
  scope: z.enum(HR_OKR_SCOPES),
  title: z.string(),
  ownerEmployeeId: zId.nullable(),
  ownerEmployeeName: z.string().nullable(),
  departmentId: zId.nullable(),
  departmentName: z.string().nullable(),
  parentObjectiveId: zId.nullable(),
  status: z.enum(HR_OKR_STATUSES),
  progressPct: z.string(),
  keyResults: z.array(zHrOkrKeyResultView),
  canManage: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type HrOkrObjectiveView = z.infer<typeof zHrOkrObjectiveView>;

export const zHrOkrTreeAsk = z.strictObject({
  quarter: zHrOkrQuarter.optional(),
  scope: z.enum(HR_OKR_SCOPES).optional(),
  departmentId: zId.optional(),
  employeeId: zId.optional(),
  includeArchived: z.boolean().default(false),
});
export type HrOkrTreeAsk = z.input<typeof zHrOkrTreeAsk>;

export const zHrOkrTreeResult = z.object({
  quarter: zHrOkrQuarter,
  availableQuarters: z.array(zHrOkrQuarter),
  projectsAvailable: z.boolean(),
  canManageAny: z.boolean(),
  selfEmployeeId: zId.nullable(),
  manageableDepartments: z.array(z.object({ id: zId, name: z.string(), legalEntityId: zId })),
  manageableEmployees: z.array(z.object({ id: zId, displayName: z.string(), departmentId: zId.nullable(), jobTitle: z.string().nullable() })),
  objectives: z.array(zHrOkrObjectiveView),
});
export type HrOkrTreeResult = z.infer<typeof zHrOkrTreeResult>;

export const zHrOkrProjectOptionsAsk = z.strictObject({
  includeArchived: z.boolean().default(false),
});
export type HrOkrProjectOptionsAsk = z.input<typeof zHrOkrProjectOptionsAsk>;

export const zHrOkrProjectOption = z.object({
  id: zId,
  name: z.string(),
  status: z.string(),
  archived: z.boolean(),
  openTaskCount: z.number().int().nonnegative(),
  doneTaskCount: z.number().int().nonnegative(),
});
export type HrOkrProjectOption = z.infer<typeof zHrOkrProjectOption>;

export const zHrOkrProjectOptionsResult = z.object({
  projectsAvailable: z.boolean(),
  projects: z.array(zHrOkrProjectOption),
});
export type HrOkrProjectOptionsResult = z.infer<typeof zHrOkrProjectOptionsResult>;

export const zHrOkrProjectTasksAsk = z.strictObject({
  projectId: zId,
});
export type HrOkrProjectTasksAsk = z.input<typeof zHrOkrProjectTasksAsk>;

export const zHrOkrProjectTasksResult = z.object({
  projectsAvailable: z.boolean(),
  projectAccessible: z.boolean(),
  tasks: z.array(zHrOkrLinkedTaskView),
});
export type HrOkrProjectTasksResult = z.infer<typeof zHrOkrProjectTasksResult>;

export const zHrOkrObjectiveCreate = z
  .strictObject({
    quarter: zHrOkrQuarter,
    scope: z.enum(HR_OKR_SCOPES),
    title: zHrOkrTitle,
    departmentId: zId.nullable().optional(),
    ownerEmployeeId: zId.nullable().optional(),
    parentObjectiveId: zId.nullable().optional(),
    activate: z.boolean().default(true),
  })
  .refine((v) => v.scope !== 'company' || (!v.departmentId && !v.parentObjectiveId), {
    message: 'company objective cannot have departmentId or parentObjectiveId',
    path: ['scope'],
  })
  .refine((v) => v.scope !== 'department' || Boolean(v.departmentId), {
    message: 'departmentId is required for department objectives',
    path: ['departmentId'],
  })
  .refine((v) => v.scope !== 'individual' || Boolean(v.ownerEmployeeId), {
    message: 'ownerEmployeeId is required for individual objectives',
    path: ['ownerEmployeeId'],
  });
export type HrOkrObjectiveCreate = z.input<typeof zHrOkrObjectiveCreate>;

export const zHrOkrObjectiveUpdate = z.strictObject({
  objectiveId: zId,
  quarter: zHrOkrQuarter.optional(),
  title: zHrOkrTitle.optional(),
  departmentId: zId.nullable().optional(),
  ownerEmployeeId: zId.nullable().optional(),
  parentObjectiveId: zId.nullable().optional(),
});
export type HrOkrObjectiveUpdate = z.input<typeof zHrOkrObjectiveUpdate>;

export const zHrOkrObjectiveSetStatus = z.strictObject({
  objectiveId: zId,
  status: z.enum(HR_OKR_STATUSES),
});
export type HrOkrObjectiveSetStatus = z.input<typeof zHrOkrObjectiveSetStatus>;

export const zHrOkrObjectiveMutationResult = z.object({
  objectiveId: zId,
  status: z.enum(HR_OKR_STATUSES),
});
export type HrOkrObjectiveMutationResult = z.infer<typeof zHrOkrObjectiveMutationResult>;

export const zHrOkrKeyResultAdd = z
  .strictObject({
    objectiveId: zId,
    title: zHrOkrTitle,
    metricType: z.enum(HR_OKR_METRIC_TYPES),
    targetValue: zHrOkrDecimal.optional(),
    currentValue: zHrOkrDecimal.optional(),
    unit: zHrOkrUnit.nullable().optional(),
    linkedProjectId: zId.nullable().optional(),
    linkedTaskIds: z.array(zId).max(50).optional(),
  })
  .refine(
    (v) => v.metricType === 'project_tasks' || v.metricType === 'percent' || v.metricType === 'boolean' || v.targetValue !== undefined,
    { message: 'targetValue is required for numeric and currency key results', path: ['targetValue'] },
  );
export type HrOkrKeyResultAdd = z.input<typeof zHrOkrKeyResultAdd>;

export const zHrOkrKeyResultUpdate = z.strictObject({
  keyResultId: zId,
  title: zHrOkrTitle.optional(),
  metricType: z.enum(HR_OKR_METRIC_TYPES).optional(),
  targetValue: zHrOkrDecimal.optional(),
  unit: zHrOkrUnit.nullable().optional(),
  linkedProjectId: zId.nullable().optional(),
  linkedTaskIds: z.array(zId).max(50).optional(),
});
export type HrOkrKeyResultUpdate = z.input<typeof zHrOkrKeyResultUpdate>;

export const zHrOkrKeyResultRemove = z.strictObject({
  keyResultId: zId,
});
export type HrOkrKeyResultRemove = z.input<typeof zHrOkrKeyResultRemove>;

export const zHrOkrKeyResultRemoveResult = z.object({
  removed: z.literal(true),
  keyResultId: zId,
});
export type HrOkrKeyResultRemoveResult = z.infer<typeof zHrOkrKeyResultRemoveResult>;

export const zHrOkrKeyResultCheckin = z.strictObject({
  keyResultId: zId,
  currentValue: zHrOkrDecimal.optional(),
  syncFromProjects: z.boolean().default(false),
  note: zHrOkrNote.nullable().optional(),
});
export type HrOkrKeyResultCheckin = z.input<typeof zHrOkrKeyResultCheckin>;

export const zHrOkrKeyResultMutationResult = z.object({
  keyResultId: zId,
  objectiveId: zId,
  currentValue: z.string(),
  targetValue: z.string(),
  progressPct: z.string(),
  completedLinkedTasks: z.number().int().nonnegative(),
  totalLinkedTasks: z.number().int().nonnegative(),
  projectsAvailable: z.boolean(),
  projectAccessible: z.boolean(),
});
export type HrOkrKeyResultMutationResult = z.infer<typeof zHrOkrKeyResultMutationResult>;

export const zHrOkrKeyResultSyncProjects = z.strictObject({
  keyResultId: zId,
});
export type HrOkrKeyResultSyncProjects = z.input<typeof zHrOkrKeyResultSyncProjects>;

export const zHrOkrDraftCheckinAsk = z.strictObject({
  keyResultId: zId,
  lang: z.enum(['vi', 'en']).optional(),
});
export type HrOkrDraftCheckinAsk = z.input<typeof zHrOkrDraftCheckinAsk>;

export const zHrOkrDraftCheckinResult = z.object({
  status: z.enum(HR_OKR_AI_STATES),
  draftNote: z.string().nullable(),
  deterministicSummary: z.string(),
  progressPct: z.string(),
  completedLinkedTasks: z.number().int().nonnegative(),
  totalLinkedTasks: z.number().int().nonnegative(),
});
export type HrOkrDraftCheckinResult = z.infer<typeof zHrOkrDraftCheckinResult>;

export const zHrOkrDraftReadResult = z.object({
  keyResultId: zId,
  objectiveId: zId,
  quarter: zHrOkrQuarter,
  objectiveScope: z.enum(HR_OKR_SCOPES),
  objectiveTitle: z.string(),
  keyResultTitle: z.string(),
  metricType: z.enum(HR_OKR_METRIC_TYPES),
  targetValue: z.string(),
  currentValue: z.string(),
  unit: z.string().nullable(),
  progressPct: z.string(),
  ownerEmployeeId: zId.nullable(),
  ownerName: z.string().nullable(),
  departmentName: z.string().nullable(),
  lastCheckinNote: z.string().nullable(),
  lastCheckinAt: z.string().nullable(),
  projectsAvailable: z.boolean(),
  projectAccessible: z.boolean(),
  linkedProjectName: z.string().nullable(),
  completedLinkedTasks: z.number().int().nonnegative(),
  totalLinkedTasks: z.number().int().nonnegative(),
  linkedTaskTitles: z.array(z.object({ title: z.string(), completed: z.boolean() })),
});
export type HrOkrDraftReadResult = z.infer<typeof zHrOkrDraftReadResult>;

export const zHrOkrAiStatusAsk = z.strictObject({});

export const zHrOkrDraftAudit = z.strictObject({
  keyResultId: zId,
  aiStatus: z.enum(HR_OKR_AI_STATES),
  progressPct: z.string(),
  completedLinkedTasks: z.number().int().nonnegative(),
});

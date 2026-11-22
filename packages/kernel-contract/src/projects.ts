// SPDX-License-Identifier: AGPL-3.0-only
// Projects and a task board on kernel tasks (issue #2591, plan docs/plan/projects.md section 4, ADR-0048).
import { z } from 'zod';
import { DEFAULT_TIME_ZONE, zTimeZone } from './calendar.ts';
import { NOTE_TITLE_MAX } from './notes.ts';
import { zFilterAstShape, zSavedViewSortShape } from './saved-view.ts';
import { zId, zLocalDate, zPositionStatus, zRole, zTaskChecklist, zTaskChecklistStepView, zTaskStatus } from './schemas.ts';

export const PROJECT_NAME_MAX = 200;
export const PROJECT_DESCRIPTION_MAX = 2000;
export const PROJECT_BOARD_LIMIT = 300;
export const PROJECT_LIST_LIMIT = 200;
export const PROJECT_UNASSIGNED_LIMIT = 100;
export const PROJECT_TASK_MAP_LIMIT = 500;
export const PROJECT_NOTE_PROPOSAL_MAX = 20;
export const PROJECT_TASK_TITLE_MAX = 300;
export const PROJECT_TEMPLATE_TASKS_MAX = 50;
export const PROJECT_TEMPLATE_TASK_DESCRIPTION_MAX = 2000;
export const PROJECT_TEMPLATE_TASK_DUE_OFFSET_MAX = 365;
export const PROJECT_TASK_RECURRENCE_INTERVAL_MAX = 12;
export const PROJECT_TASK_RECURRENCE_TIMES_MAX = 500;
export const PROJECT_COLUMNS_MAX = 12;
export const PROJECT_COLUMN_NAME_MAX = 80;
export const PROJECT_COLUMN_WIP_MAX = 200;
export const PROJECT_CYCLE_NAME_MAX = 120;
export const PROJECT_CYCLE_GOAL_MAX = 1000;
export const PROJECT_CYCLE_DURATION_WEEKS_MIN = 1;
export const PROJECT_CYCLE_DURATION_WEEKS_MAX = 4;
export const PROJECT_CYCLE_MAX_DAYS = 90;
export const PROJECT_CYCLE_LIST_LIMIT = 100;
export const PROJECT_CYCLE_VELOCITY_LIMIT = 12;
export const PROJECT_TASK_STORY_POINTS_MIN = 0;
export const PROJECT_TASK_STORY_POINTS_MAX = 100;

export const BUILTIN_PROJECT_TEMPLATE_KEYS = ['monthly-close', 'client-onboarding', 'campaign-launch'] as const;
export type BuiltinProjectTemplateKey = (typeof BUILTIN_PROJECT_TEMPLATE_KEYS)[number];
export const zBuiltinProjectTemplateKey = z.enum(BUILTIN_PROJECT_TEMPLATE_KEYS);

export const PROJECT_TASK_RECURRENCE_CADENCES = ['weekly', 'monthly'] as const;
export type ProjectTaskRecurrenceCadence = (typeof PROJECT_TASK_RECURRENCE_CADENCES)[number];

export const zProjectTaskRecurrence = z
  .strictObject({
    cadence: z.enum(PROJECT_TASK_RECURRENCE_CADENCES),
    interval: z.number().int().min(1).max(PROJECT_TASK_RECURRENCE_INTERVAL_MAX),
    weekday: z.number().int().min(0).max(6).nullable().optional(),
    monthDay: z
      .number()
      .int()
      .refine((v) => v === -1 || (v >= 1 && v <= 28), 'monthDay must be 1..28 or -1')
      .nullable()
      .optional(),
    timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
    until: zLocalDate.nullable().optional(),
    times: z.number().int().min(1).max(PROJECT_TASK_RECURRENCE_TIMES_MAX).nullable().optional(),
  })
  .superRefine((v, ctx) => {
    if (v.cadence === 'weekly') {
      if (v.weekday === undefined || v.weekday === null) {
        ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'weekday is required for weekly cadence' });
      }
      if (v.monthDay !== undefined && v.monthDay !== null) {
        ctx.addIssue({ code: 'custom', path: ['monthDay'], message: 'monthDay is only allowed for monthly cadence' });
      }
    } else {
      if (v.monthDay === undefined || v.monthDay === null) {
        ctx.addIssue({ code: 'custom', path: ['monthDay'], message: 'monthDay is required for monthly cadence' });
      }
      if (v.weekday !== undefined && v.weekday !== null) {
        ctx.addIssue({ code: 'custom', path: ['weekday'], message: 'weekday is only allowed for weekly cadence' });
      }
    }
  });
export type ProjectTaskRecurrence = z.infer<typeof zProjectTaskRecurrence>;
export type ProjectTaskRecurrenceInput = z.input<typeof zProjectTaskRecurrence>;

export const PROJECT_STATUSES = ['active', 'on_hold', 'done', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const zProjectStatus = z.enum(PROJECT_STATUSES);

export const PROJECT_VISIBILITIES = ['org', 'private'] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];
export const zProjectVisibility = z.enum(PROJECT_VISIBILITIES);

// Board columns are the five open/done statuses; cancelled sits behind a filter (ADR-0048 point 2).
export const BOARD_TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'in_review', 'done'] as const;
export type BoardTaskStatus = (typeof BOARD_TASK_STATUSES)[number];
export const zProjectColumnStatus = z.enum(BOARD_TASK_STATUSES);

// Custom project board column semantic colors mapped to @ludy/ui tokens (#2605, ADR-0056).
export const PROJECT_COLUMN_COLORS = ['neutral', 'primary', 'warning', 'proposal', 'success', 'destructive'] as const;
export type ProjectColumnColor = (typeof PROJECT_COLUMN_COLORS)[number];
export const zProjectColumnColor = z.enum(PROJECT_COLUMN_COLORS);

export const zProjectColumnName = z.string().trim().min(1).max(PROJECT_COLUMN_NAME_MAX);
export const zProjectColumnWipLimit = z.number().int().min(1).max(PROJECT_COLUMN_WIP_MAX).nullable();

export const zProjectColumn = z.object({
  id: zId,
  projectId: zId,
  name: z.string(),
  taskStatus: zProjectColumnStatus,
  color: zProjectColumnColor,
  wipLimit: zProjectColumnWipLimit,
  sortKey: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectColumn = z.infer<typeof zProjectColumn>;

export const zProjectColumnInitDefaultsInput = z.strictObject({
  projectId: zId,
  language: z.enum(['vi', 'en']).default('vi'),
});
export type ProjectColumnInitDefaultsInput = z.input<typeof zProjectColumnInitDefaultsInput>;

export const zProjectColumnInitDefaultsResult = z.object({
  projectId: zId,
  columns: z.array(zProjectColumn),
  initialized: z.boolean(),
});
export type ProjectColumnInitDefaultsResult = z.infer<typeof zProjectColumnInitDefaultsResult>;

export const zProjectColumnCreateFields = z.strictObject({
  projectId: zId,
  name: zProjectColumnName,
  taskStatus: zProjectColumnStatus,
  color: zProjectColumnColor.optional(),
  wipLimit: zProjectColumnWipLimit.optional(),
  place: z.enum(['before', 'after']).optional(),
  anchorId: zId.optional(),
});
export const validColumnCreatePlacement = (v: {
  place?: 'before' | 'after' | undefined;
  anchorId?: string | undefined;
}): boolean => (v.place === undefined) === (v.anchorId === undefined);
export const COLUMN_CREATE_PLACEMENT_ISSUE = {
  message: 'Both place and anchorId are required when placing relative to another column',
  path: ['anchorId'],
};
export const zProjectColumnCreateInput = zProjectColumnCreateFields.refine(
  validColumnCreatePlacement,
  COLUMN_CREATE_PLACEMENT_ISSUE,
);
export type ProjectColumnCreateInput = z.infer<typeof zProjectColumnCreateInput>;

export const zProjectColumnUpdateInput = z.strictObject({
  projectId: zId,
  columnId: zId,
  name: zProjectColumnName.optional(),
  taskStatus: zProjectColumnStatus.optional(),
  color: zProjectColumnColor.optional(),
  wipLimit: zProjectColumnWipLimit.optional(),
});
export type ProjectColumnUpdateInput = z.infer<typeof zProjectColumnUpdateInput>;

export const zProjectColumnMutateResult = z.object({
  projectId: zId,
  column: zProjectColumn,
});
export type ProjectColumnMutateResult = z.infer<typeof zProjectColumnMutateResult>;

export const zProjectColumnReorderFields = z.strictObject({
  projectId: zId,
  columnId: zId,
  place: z.enum(['before', 'after']),
  anchorId: zId,
});
export const distinctColumnReorderTargets = (v: { columnId: string; anchorId: string }): boolean => v.columnId !== v.anchorId;
export const REORDER_SAME_COLUMN_ISSUE = { message: 'A column is not moved next to itself', path: ['anchorId'] };
export const zProjectColumnReorderInput = zProjectColumnReorderFields.refine(
  distinctColumnReorderTargets,
  REORDER_SAME_COLUMN_ISSUE,
);
export type ProjectColumnReorderInput = z.infer<typeof zProjectColumnReorderInput>;

export const zProjectColumnReorderResult = z.object({
  projectId: zId,
  columns: z.array(zProjectColumn),
});
export type ProjectColumnReorderResult = z.infer<typeof zProjectColumnReorderResult>;

export const zProjectColumnDeleteFields = z.strictObject({
  projectId: zId,
  columnId: zId,
  fallbackColumnId: zId,
});
export const distinctDeleteFallbackColumn = (v: { columnId: string; fallbackColumnId: string }): boolean =>
  v.columnId !== v.fallbackColumnId;
export const DELETE_SAME_FALLBACK_COLUMN_ISSUE = {
  message: 'Fallback column must be different from the deleted column',
  path: ['fallbackColumnId'],
};
export const zProjectColumnDeleteInput = zProjectColumnDeleteFields.refine(
  distinctDeleteFallbackColumn,
  DELETE_SAME_FALLBACK_COLUMN_ISSUE,
);
export type ProjectColumnDeleteInput = z.infer<typeof zProjectColumnDeleteInput>;

export const zProjectColumnDeleteResult = z.object({
  projectId: zId,
  deletedColumnId: zId,
  fallbackColumnId: zId,
  columns: z.array(zProjectColumn),
});
export type ProjectColumnDeleteResult = z.infer<typeof zProjectColumnDeleteResult>;

export const zProjectTaskMoveColumnFields = z.strictObject({
  projectId: zId,
  taskId: zId,
  columnId: zId,
  place: z.enum(['before', 'after']).optional(),
  anchorId: zId.optional(),
});
export const validTaskMoveColumnPlacement = (v: {
  taskId: string;
  place?: 'before' | 'after' | undefined;
  anchorId?: string | undefined;
}): boolean => {
  if ((v.place === undefined) !== (v.anchorId === undefined)) return false;
  if (v.anchorId !== undefined && v.anchorId === v.taskId) return false;
  return true;
};
export const TASK_MOVE_COLUMN_PLACEMENT_ISSUE = {
  message: 'Both place and anchorId are required when placing relative to another task, and anchorId must differ from taskId',
  path: ['anchorId'],
};
export const zProjectTaskMoveColumnInput = zProjectTaskMoveColumnFields.refine(
  validTaskMoveColumnPlacement,
  TASK_MOVE_COLUMN_PLACEMENT_ISSUE,
);
export type ProjectTaskMoveColumnInput = z.infer<typeof zProjectTaskMoveColumnInput>;

export const zProjectTaskMoveColumnResult = z.object({
  projectId: zId,
  taskId: zId,
  columnId: zId,
  status: zProjectColumnStatus,
});
export type ProjectTaskMoveColumnResult = z.infer<typeof zProjectTaskMoveColumnResult>;

export const zProjectName = z.string().trim().min(1).max(PROJECT_NAME_MAX);
export const zProjectDescription = z.string().trim().max(PROJECT_DESCRIPTION_MAX);

export const zProjectCreate = z.strictObject({
  name: zProjectName,
  description: zProjectDescription.nullable().optional(),
  ownerUserId: zId.optional(),
  memberUserIds: z.array(zId).max(200).optional(),
  visibility: zProjectVisibility.optional(),
});
export type ProjectCreateInput = z.infer<typeof zProjectCreate>;

export const zProjectCycleDurationWeeks = z.number().int().min(PROJECT_CYCLE_DURATION_WEEKS_MIN).max(PROJECT_CYCLE_DURATION_WEEKS_MAX);
export const zProjectStoryPoints = z.number().int().min(PROJECT_TASK_STORY_POINTS_MIN).max(PROJECT_TASK_STORY_POINTS_MAX);

export const zProjectUpdate = z.strictObject({
  projectId: zId,
  name: zProjectName.optional(),
  description: zProjectDescription.nullable().optional(),
  visibility: zProjectVisibility.optional(),
  cyclesEnabled: z.boolean().optional(),
  cycleDurationWeeks: zProjectCycleDurationWeeks.optional(),
  pointsEnabled: z.boolean().optional(),
});
export type ProjectUpdateInput = z.infer<typeof zProjectUpdate>;

export const zProjectSetStatus = z.strictObject({
  projectId: zId,
  status: zProjectStatus,
});
export type ProjectSetStatusInput = z.infer<typeof zProjectSetStatus>;

export const zProjectArchive = z.strictObject({
  projectId: zId,
});

export const zProjectSetOwner = z.strictObject({
  projectId: zId,
  ownerUserId: zId,
});

export const zProjectMemberMutate = z.strictObject({
  projectId: zId,
  userId: zId,
});

export const zProjectTaskMutate = z.strictObject({
  projectId: zId,
  taskId: zId,
});

export const zProjectTaskReorderFields = z.strictObject({
  projectId: zId,
  taskId: zId,
  place: z.enum(['before', 'after']),
  anchorId: zId,
});
export const distinctReorderTargets = (v: { taskId: string; anchorId: string }): boolean => v.taskId !== v.anchorId;
export const REORDER_SAME_TASK_ISSUE = { message: 'A task is not moved next to itself', path: ['anchorId'] };

export const zProjectTaskReorder = zProjectTaskReorderFields.refine(distinctReorderTargets, REORDER_SAME_TASK_ISSUE);
export type ProjectTaskReorderInput = z.infer<typeof zProjectTaskReorder>;

export const zProjectTaskReorderResult = z.object({
  projectId: zId,
  taskId: zId,
});
export type ProjectTaskReorderResult = z.infer<typeof zProjectTaskReorderResult>;

export const zProjectTaskCreate = z.strictObject({
  projectId: zId,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10000).optional(),
  assigneePositionId: zId.nullable(),
  startOn: zLocalDate.nullable().optional(),
  due: z.iso.datetime().optional(),
  status: z.enum(BOARD_TASK_STATUSES).optional(),
  columnId: zId.optional(),
  checklist: zTaskChecklist.optional(),
  cycleId: zId.nullable().optional(),
  storyPoints: zProjectStoryPoints.nullable().optional(),
});
export type ProjectTaskCreateInput = z.infer<typeof zProjectTaskCreate>;

export const zProjectSummary = z.object({
  id: zId,
  name: z.string(),
  description: z.string().nullable(),
  ownerUserId: zId.nullable(),
  ownerName: z.string().nullable(),
  status: zProjectStatus,
  visibility: zProjectVisibility,
  cyclesEnabled: z.boolean().optional(),
  cycleDurationWeeks: zProjectCycleDurationWeeks.optional(),
  pointsEnabled: z.boolean().optional(),
  memberCount: z.number().int().nonnegative(),
  openTaskCount: z.number().int().nonnegative(),
  doneTaskCount: z.number().int().nonnegative(),
  canManage: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectSummary = z.infer<typeof zProjectSummary>;

export const zProjectDetail = z.object({
  id: zId,
  name: z.string(),
  description: z.string().nullable(),
  ownerUserId: zId.nullable(),
  ownerName: z.string().nullable(),
  status: zProjectStatus,
  visibility: zProjectVisibility,
  cyclesEnabled: z.boolean().optional(),
  cycleDurationWeeks: zProjectCycleDurationWeeks.optional(),
  pointsEnabled: z.boolean().optional(),
  canManage: z.boolean(),
  canWrite: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectDetail = z.infer<typeof zProjectDetail>;

export const zProjectMemberView = z.object({
  userId: zId,
  role: zRole,
  displayName: z.string().nullable(),
  email: z.string().nullable(),
  onProject: z.boolean(),
});
export type ProjectMemberView = z.infer<typeof zProjectMemberView>;

export const zProjectSeatHolder = z.union([
  z.object({ type: z.literal('user'), userId: zId, displayName: z.string().nullable(), email: z.string().nullable() }),
  z.object({ type: z.literal('agent'), agentId: zId, name: z.string().nullable() }),
]);
export type ProjectSeatHolder = z.infer<typeof zProjectSeatHolder>;

export const zProjectSeat = z.object({
  id: zId,
  title: z.string(),
  status: zPositionStatus,
  onProject: z.boolean(),
  holder: zProjectSeatHolder.nullable(),
});
export type ProjectSeat = z.infer<typeof zProjectSeat>;

export const zProjectTaskCard = z.object({
  id: zId,
  title: z.string(),
  description: z.string().nullable(),
  status: zTaskStatus,
  columnId: zId.nullable().optional(),
  assigneePositionId: zId.nullable(),
  startOn: zLocalDate.nullable().optional(),
  due: z.string().nullable(),
  checklist: z.array(zTaskChecklistStepView),
  tainted: z.boolean(),
  checkedOut: z.boolean(),
  commentCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  addedAt: z.string(),
  cycleId: zId.nullable().optional(),
  storyPoints: zProjectStoryPoints.nullable().optional(),
  recurrence: zProjectTaskRecurrence.nullable().optional(),
  recurrenceCount: z.number().int().nonnegative().optional(),
  recurrenceLastDue: zLocalDate.nullable().optional(),
  recurrenceNextAt: z.string().nullable().optional(),
  recurrenceSourceTaskId: zId.nullable().optional(),
  openBlockerCount: z.number().int().nonnegative().optional(),
  blockingCount: z.number().int().nonnegative().optional(),
});
export type ProjectTaskCard = z.infer<typeof zProjectTaskCard>;

export const PROJECT_CYCLE_STATUSES = ['upcoming', 'active', 'completed'] as const;
export type ProjectCycleStatus = (typeof PROJECT_CYCLE_STATUSES)[number];
export const zProjectCycleStatus = z.enum(PROJECT_CYCLE_STATUSES);

export const zProjectCycle = z.object({
  id: zId,
  projectId: zId,
  number: z.number().int().positive(),
  name: z.string(),
  goal: z.string().nullable(),
  status: zProjectCycleStatus,
  startsOn: zLocalDate,
  endsOn: zLocalDate,
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  totalTasks: z.number().int().nonnegative(),
  openTasks: z.number().int().nonnegative(),
  doneTasks: z.number().int().nonnegative(),
  cancelledTasks: z.number().int().nonnegative(),
  totalPoints: z.number().int().nonnegative(),
  donePoints: z.number().int().nonnegative(),
});
export type ProjectCycle = z.infer<typeof zProjectCycle>;

export const zProjectCycleFilter = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('all') }),
  z.strictObject({ mode: z.literal('active') }),
  z.strictObject({ mode: z.literal('backlog') }),
  z.strictObject({ mode: z.literal('upcoming') }),
  z.strictObject({ mode: z.literal('cycle'), cycleId: zId }),
]);
export type ProjectCycleFilter = z.infer<typeof zProjectCycleFilter>;

export const zProjectListInput = z.strictObject({
  status: z.array(zProjectStatus).max(4).optional(),
});

export const zProjectListResult = z.object({
  projects: z.array(zProjectSummary),
  canWrite: z.boolean(),
  truncated: z.boolean(),
});
export type ProjectListResult = z.infer<typeof zProjectListResult>;

export const zProjectBoardInput = z.strictObject({
  projectId: zId,
  positionId: z.union([zId, z.literal('root')]).optional(),
  status: z.array(zTaskStatus).max(6).optional(),
  includeCancelled: z.boolean().optional(),
  cycleFilter: zProjectCycleFilter.optional(),
  filters: zFilterAstShape.optional(),
  sort: zSavedViewSortShape.nullable().optional(),
});
export type ProjectBoardInput = z.infer<typeof zProjectBoardInput>;

export const zProjectBoard = z.object({
  project: zProjectDetail,
  members: z.array(zProjectMemberView),
  seats: z.array(zProjectSeat),
  isTeamOrg: z.boolean(),
  viewerHasSeat: z.boolean(),
  columns: z.array(zProjectColumn).optional(),
  tasks: z.array(zProjectTaskCard),
  activeCycle: zProjectCycle.nullable().optional(),
  totalVisible: z.number().int().nonnegative(),
  hiddenByEntityCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ProjectBoard = z.infer<typeof zProjectBoard>;

export const zProjectCandidateTask = z.object({
  id: zId,
  title: z.string(),
  // The title is an AI coworker's text (a task made from an approved ask): the picker marks the invisible characters (#4421).
  tainted: z.boolean(),
  status: zTaskStatus,
  assigneePositionId: zId.nullable(),
  due: z.string().nullable(),
  createdAt: z.string(),
});
export type ProjectCandidateTask = z.infer<typeof zProjectCandidateTask>;

export const zProjectTaskRef = z.object({
  id: zId,
  name: z.string(),
});
export type ProjectTaskRef = z.infer<typeof zProjectTaskRef>;

export const zProjectTaskProjectsInput = z.strictObject({
  taskIds: z.array(zId).max(PROJECT_TASK_MAP_LIMIT),
});
export type ProjectTaskProjectsInput = z.infer<typeof zProjectTaskProjectsInput>;

export const zProjectTaskProjectEntry = z.object({
  taskId: zId,
  project: zProjectTaskRef,
});
export type ProjectTaskProjectEntry = z.infer<typeof zProjectTaskProjectEntry>;

// Vy's weekly status of one project (projects P6, #2597): deterministic counts and task lists read from
// crove_kernel.task and crove_kernel.task_comment only (never crove_notes), plus 3 to 5 plain sentences from Vy when
// the model is on and passes every safety check. Ephemeral to the caller: nothing is stored or sent.
export const PROJECT_WEEKLY_STATUS_STATES = [
  'used',
  'off',
  'paused',
  'budget',
  'busy',
  'refused',
  'failed',
  'empty',
  'forbidden',
] as const;
export type ProjectWeeklyStatusState = (typeof PROJECT_WEEKLY_STATUS_STATES)[number];

export const PROJECT_WEEKLY_STATUS_BUCKET_LIMIT = 20;

export const zProjectWeeklyStatusInput = z.strictObject({
  projectId: zId,
  language: z.enum(['vi', 'en']).optional(),
});
export type ProjectWeeklyStatusInput = z.infer<typeof zProjectWeeklyStatusInput>;

export const zProjectWeeklyStatusTask = z.strictObject({
  id: zId,
  title: z.string(),
  // The title is an AI coworker's text (a task made from an approved ask): the screen marks the invisible characters (#4421).
  tainted: z.boolean(),
  status: zTaskStatus,
  due: z.string().nullable(),
  commentCount: z.number().int().nonnegative(),
  latestComment: z.string().nullable(),
});
export type ProjectWeeklyStatusTask = z.infer<typeof zProjectWeeklyStatusTask>;

export const zProjectWeeklyStatusCounts = z.strictObject({
  totalVisible: z.number().int().nonnegative(),
  doneThisWeek: z.number().int().nonnegative(),
  overdue: z.number().int().nonnegative(),
  waiting: z.number().int().nonnegative(),
  dueNextWeek: z.number().int().nonnegative(),
});
export type ProjectWeeklyStatusCounts = z.infer<typeof zProjectWeeklyStatusCounts>;

export const zProjectWeeklyStatusTasks = z.strictObject({
  doneThisWeek: z.array(zProjectWeeklyStatusTask),
  overdue: z.array(zProjectWeeklyStatusTask),
  waiting: z.array(zProjectWeeklyStatusTask),
  dueNextWeek: z.array(zProjectWeeklyStatusTask),
});
export type ProjectWeeklyStatusTasks = z.infer<typeof zProjectWeeklyStatusTasks>;

export const zProjectWeeklyStatusBottleneck = z.strictObject({
  id: zId,
  title: z.string(),
  status: zTaskStatus,
  due: z.string().nullable(),
  blockedCount: z.number().int().positive(),
});
export type ProjectWeeklyStatusBottleneck = z.infer<typeof zProjectWeeklyStatusBottleneck>;

export const zProjectWeeklyStatusColumn = z.strictObject({
  id: zId,
  name: z.string(),
  taskStatus: zProjectColumnStatus,
  color: zProjectColumnColor,
  wipLimit: zProjectColumnWipLimit,
  taskCount: z.number().int().nonnegative(),
});
export type ProjectWeeklyStatusColumn = z.infer<typeof zProjectWeeklyStatusColumn>;

export const zProjectWeeklyStatusTimeSummary = z.strictObject({
  entryCount: z.number().int().nonnegative(),
  totalMinutes: z.number().int().nonnegative(),
  billableMinutes: z.number().int().nonnegative(),
  totalHours: z.string(),
  billableHours: z.string(),
  billableAmount: z.string().regex(/^\d{1,24}\.\d{2}$/, 'non-negative decimal string formatted to 2 decimals'),
});
export type ProjectWeeklyStatusTimeSummary = z.infer<typeof zProjectWeeklyStatusTimeSummary>;

export const zProjectWeeklyStatus = z.strictObject({
  ai: z.enum(PROJECT_WEEKLY_STATUS_STATES),
  project: z.strictObject({
    id: zId,
    name: z.string(),
    status: zProjectStatus,
  }),
  window: z.strictObject({
    from: zLocalDate,
    to: zLocalDate,
    nextFrom: zLocalDate,
    nextTo: zLocalDate,
    timeZone: z.string(),
  }),
  counts: zProjectWeeklyStatusCounts,
  columns: z.array(zProjectWeeklyStatusColumn).optional(),
  tasks: zProjectWeeklyStatusTasks,
  bottlenecks: z.array(zProjectWeeklyStatusBottleneck).optional(),
  timeThisWeek: zProjectWeeklyStatusTimeSummary.optional(),
  hiddenByEntityCount: z.number().int().nonnegative(),
  // Vy's 3 to 5 plain sentences: empty unless `ai` is 'used'.
  sentences: z.array(z.string().max(400)).max(5),
  truncated: z.boolean(),
});
export type ProjectWeeklyStatus = z.infer<typeof zProjectWeeklyStatus>;

export const PROJECT_WEEKLY_STATUS_NOTE_TAG = 'bao-cao-tuan';
export const PROJECT_WEEKLY_STATUS_MAIL_SOURCE = 'projects.weekly_status.send_mail';
export const PROJECT_WEEKLY_STATUS_MAIL_TEMPLATE = 'projects.weekly_status';
export const PROJECT_WEEKLY_STATUS_SUMMARY_MAX = 4000;

const zOneLineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((v) => !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(v), 'one line');

// Share a project's weekly status as an org-visible note linked to the project (#2609).
export const zProjectWeeklyStatusShareNoteInput = z.strictObject({
  projectId: zId,
  title: zOneLineText(NOTE_TITLE_MAX),
  body: z.string().trim().min(1).max(PROJECT_WEEKLY_STATUS_SUMMARY_MAX),
  // True only when the body comes unedited from Vy's weekly status generator.
  tainted: z.boolean().default(false),
});
export type ProjectWeeklyStatusShareNoteInput = z.input<typeof zProjectWeeklyStatusShareNoteInput>;

// Email a project's weekly status to the project's other members on explicit confirmation (#2609).
export const zProjectWeeklyStatusSendMailInput = z.strictObject({
  projectId: zId,
  subject: zOneLineText(NOTE_TITLE_MAX),
  summary: z.string().trim().min(1).max(PROJECT_WEEKLY_STATUS_SUMMARY_MAX),
  language: z.enum(['vi', 'en']).default('vi'),
  tainted: z.boolean().default(false),
  confirmed: z.literal(true),
});
export type ProjectWeeklyStatusSendMailInput = z.input<typeof zProjectWeeklyStatusSendMailInput>;

export const zProjectWeeklyStatusSendMailResult = z.strictObject({
  sentCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
});
export type ProjectWeeklyStatusSendMailResult = z.infer<typeof zProjectWeeklyStatusSendMailResult>;

const PROJECT_PATH_PATTERN = /^\/o\/[a-z0-9][a-z0-9-]{0,62}\/projects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const zProjectWeeklyStatusMailPayload = z.strictObject({
  batchId: zId,
  projectId: zId,
  projectName: z.string().trim().min(1).max(PROJECT_NAME_MAX),
  orgName: z.string().trim().min(1).max(200),
  projectPath: z.string().trim().regex(PROJECT_PATH_PATTERN),
  from: zLocalDate,
  to: zLocalDate,
  nextFrom: zLocalDate,
  nextTo: zLocalDate,
  counts: zProjectWeeklyStatusCounts,
  summary: z.string().trim().min(1).max(PROJECT_WEEKLY_STATUS_SUMMARY_MAX),
  language: z.enum(['vi', 'en']),
  aiGenerated: z.boolean(),
});
export type ProjectWeeklyStatusMailPayload = z.infer<typeof zProjectWeeklyStatusMailPayload>;

export const zProjectTasksFromNoteStatus = z.strictObject({
  available: z.boolean(),
  reason: z.enum(['off', 'forbidden', 'paused', 'budget']).nullable(),
  resetOn: z.string().nullable(),
});
export type ProjectTasksFromNoteStatus = z.infer<typeof zProjectTasksFromNoteStatus>;

const REAL_CALENDAR_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isRealCalendarDate(iso: string): boolean {
  const m = REAL_CALENDAR_DATE_RE.exec(iso);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

export const zProjectProposedTask = z.strictObject({
  title: z.string().trim().min(1).max(PROJECT_TASK_TITLE_MAX),
  assigneePositionId: zId.nullable(),
  dueOn: zLocalDate.refine(isRealCalendarDate, 'Invalid calendar date').nullable(),
});
export type ProjectProposedTask = z.infer<typeof zProjectProposedTask>;

export const zProjectTasksFromNoteInput = z.strictObject({
  noteId: zId,
  projectId: zId,
  timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
  language: z.enum(['vi', 'en']).default('vi'),
  today: zLocalDate.optional(),
});
export type ProjectTasksFromNoteInput = z.input<typeof zProjectTasksFromNoteInput>;

export const zProjectTasksFromNoteResult = z.strictObject({
  state: z.enum(['ready', 'failed']),
  runId: zId.nullable(),
  projectId: zId,
  projectName: z.string(),
  seats: z.array(zProjectSeat),
  proposals: z.array(zProjectProposedTask).max(PROJECT_NOTE_PROPOSAL_MAX),
  dropped: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  noteCanLink: z.boolean(),
});
export type ProjectTasksFromNoteResult = z.infer<typeof zProjectTasksFromNoteResult>;

export const zProjectTasksFromNoteConfirmInput = z.strictObject({
  noteId: zId,
  projectId: zId,
  confirmed: z.literal(true),
  timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
  items: z.array(zProjectProposedTask).min(1).max(PROJECT_NOTE_PROPOSAL_MAX),
});
export type ProjectTasksFromNoteConfirmInput = z.input<typeof zProjectTasksFromNoteConfirmInput>;

export const zProjectTasksFromNoteConfirmResult = z.strictObject({
  projectId: zId,
  noteId: zId,
  createdCount: z.number().int().nonnegative(),
  linkedCount: z.number().int().nonnegative(),
  taskIds: z.array(zId),
});
export type ProjectTasksFromNoteConfirmResult = z.infer<typeof zProjectTasksFromNoteConfirmResult>;

// Multi-source task proposals (#2608): notes, meetings, and conversations on one project board.
export const PROJECT_TASK_SOURCE_TYPES = ['notes.note', 'meetings.meeting', 'kernel.conversation'] as const;
export type ProjectTaskSourceType = (typeof PROJECT_TASK_SOURCE_TYPES)[number];
export const zProjectTaskSourceType = z.enum(PROJECT_TASK_SOURCE_TYPES);

export type ProjectTasksFromSourceStatus = ProjectTasksFromNoteStatus;

export const zProjectTasksFromSourceInput = z.strictObject({
  projectId: zId,
  sourceType: zProjectTaskSourceType,
  sourceId: zId,
  timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
  language: z.enum(['vi', 'en']).default('vi'),
  today: zLocalDate.optional(),
});
export type ProjectTasksFromSourceInput = z.input<typeof zProjectTasksFromSourceInput>;

export const zProjectTasksFromSourceResult = z.strictObject({
  state: z.enum(['ready', 'failed']),
  runId: zId.nullable(),
  projectId: zId,
  projectName: z.string(),
  sourceType: zProjectTaskSourceType,
  sourceId: zId,
  sourceTitle: z.string(),
  seats: z.array(zProjectSeat),
  proposals: z.array(zProjectProposedTask).max(PROJECT_NOTE_PROPOSAL_MAX),
  dropped: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  sourceCanLink: z.boolean(),
});
export type ProjectTasksFromSourceResult = z.infer<typeof zProjectTasksFromSourceResult>;

export const zProjectTasksFromSourceConfirmInput = z.strictObject({
  projectId: zId,
  sourceType: zProjectTaskSourceType,
  sourceId: zId,
  confirmed: z.literal(true),
  timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
  items: z.array(zProjectProposedTask).min(1).max(PROJECT_NOTE_PROPOSAL_MAX),
});
export type ProjectTasksFromSourceConfirmInput = z.input<typeof zProjectTasksFromSourceConfirmInput>;

export const zProjectTasksFromSourceConfirmResult = z.strictObject({
  projectId: zId,
  sourceType: zProjectTaskSourceType,
  sourceId: zId,
  createdCount: z.number().int().nonnegative(),
  linkedCount: z.number().int().nonnegative(),
  taskIds: z.array(zId),
});
export type ProjectTasksFromSourceConfirmResult = z.infer<typeof zProjectTasksFromSourceConfirmResult>;

// Project templates and recurring project tasks (#2607).
export const zProjectTemplateTaskInputItem = z.strictObject({
  title: z.string().trim().min(1).max(PROJECT_TASK_TITLE_MAX),
  description: z.string().trim().max(PROJECT_TEMPLATE_TASK_DESCRIPTION_MAX).nullable().optional(),
  dueOffsetDays: z.number().int().min(0).max(PROJECT_TEMPLATE_TASK_DUE_OFFSET_MAX).nullable().optional(),
});
export const zProjectTemplateTaskItem = zProjectTemplateTaskInputItem.extend({
  tainted: z.boolean().optional(),
});
export type ProjectTemplateTaskItem = z.infer<typeof zProjectTemplateTaskItem>;

export const zProjectTemplateSummary = z.object({
  id: z.string(),
  source: z.enum(['builtin', 'custom']),
  builtinKey: zBuiltinProjectTemplateKey.nullable(),
  name: z.string(),
  description: z.string().nullable(),
  status: zProjectStatus,
  tasks: z.array(zProjectTemplateTaskItem),
  taskCount: z.number().int().nonnegative(),
  canManage: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type ProjectTemplateSummary = z.infer<typeof zProjectTemplateSummary>;

export const zProjectTemplateListInput = z.strictObject({
  language: z.enum(['vi', 'en']).optional(),
  includeArchived: z.boolean().optional(),
});
export type ProjectTemplateListInput = z.infer<typeof zProjectTemplateListInput>;

export const zProjectTemplateListResult = z.object({
  templates: z.array(zProjectTemplateSummary),
  canWrite: z.boolean(),
});
export type ProjectTemplateListResult = z.infer<typeof zProjectTemplateListResult>;

export const zProjectTemplateCreateFields = z.strictObject({
  name: zProjectName,
  description: zProjectDescription.nullable().optional(),
  sourceProjectId: zId.optional(),
  tasks: z.array(zProjectTemplateTaskInputItem).max(PROJECT_TEMPLATE_TASKS_MAX).optional(),
  timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
});
export const validTemplateCreateSource = (v: {
  sourceProjectId?: string | undefined;
  tasks?: unknown[] | undefined;
}): boolean => (v.sourceProjectId !== undefined) !== (v.tasks !== undefined);
export const TEMPLATE_CREATE_SOURCE_ISSUE = {
  message: 'Provide either sourceProjectId or tasks, not both',
  path: ['tasks'],
};
export const zProjectTemplateCreateInput = zProjectTemplateCreateFields.refine(
  validTemplateCreateSource,
  TEMPLATE_CREATE_SOURCE_ISSUE,
);
export type ProjectTemplateCreateInput = z.input<typeof zProjectTemplateCreateInput>;

export const zProjectTemplateCreateResult = z.object({
  templateId: zId,
  taskCount: z.number().int().nonnegative(),
});
export type ProjectTemplateCreateResult = z.infer<typeof zProjectTemplateCreateResult>;

export const zProjectTemplateArchiveInput = z.strictObject({
  templateId: zId,
});
export type ProjectTemplateArchiveInput = z.infer<typeof zProjectTemplateArchiveInput>;

export const zProjectTemplateArchiveResult = z.object({
  templateId: zId,
  status: z.literal('archived'),
});
export type ProjectTemplateArchiveResult = z.infer<typeof zProjectTemplateArchiveResult>;

export const zProjectCreateFromTemplateFields = z.strictObject({
  templateId: zId.optional(),
  builtinKey: zBuiltinProjectTemplateKey.optional(),
  name: zProjectName.optional(),
  description: zProjectDescription.nullable().optional(),
  startDate: zLocalDate.optional(),
  timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
  language: z.enum(['vi', 'en']).default('vi'),
  ownerUserId: zId.optional(),
  memberUserIds: z.array(zId).max(200).optional(),
  visibility: zProjectVisibility.optional(),
});
export const validTemplateCreateFromSource = (v: {
  templateId?: string | undefined;
  builtinKey?: string | undefined;
}): boolean => (v.templateId !== undefined) !== (v.builtinKey !== undefined);
export const TEMPLATE_CREATE_FROM_SOURCE_ISSUE = {
  message: 'Provide either templateId or builtinKey, not both',
  path: ['templateId'],
};
export const zProjectCreateFromTemplateInput = zProjectCreateFromTemplateFields.refine(
  validTemplateCreateFromSource,
  TEMPLATE_CREATE_FROM_SOURCE_ISSUE,
);
export type ProjectCreateFromTemplateInput = z.input<typeof zProjectCreateFromTemplateInput>;

export const zProjectCreateFromTemplateResult = z.object({
  projectId: zId,
  taskIds: z.array(zId),
});
export type ProjectCreateFromTemplateResult = z.infer<typeof zProjectCreateFromTemplateResult>;

export const zProjectTaskRecurrenceSetInput = z.strictObject({
  projectId: zId,
  taskId: zId,
  recurrence: zProjectTaskRecurrence,
});
export type ProjectTaskRecurrenceSetInput = z.input<typeof zProjectTaskRecurrenceSetInput>;

export const zProjectTaskRecurrenceClearInput = z.strictObject({
  projectId: zId,
  taskId: zId,
});
export type ProjectTaskRecurrenceClearInput = z.infer<typeof zProjectTaskRecurrenceClearInput>;

export const zProjectTaskRecurrenceGetInput = z.strictObject({
  taskId: zId,
});
export type ProjectTaskRecurrenceGetInput = z.infer<typeof zProjectTaskRecurrenceGetInput>;

export const zProjectTaskRecurrenceView = z.object({
  projectId: zId,
  taskId: zId,
  recurrence: zProjectTaskRecurrence.nullable(),
  recurrenceCount: z.number().int().nonnegative(),
  recurrenceLastDue: zLocalDate.nullable(),
  recurrenceNextAt: z.string().nullable(),
  recurrenceSourceTaskId: zId.nullable(),
});
export type ProjectTaskRecurrenceView = z.infer<typeof zProjectTaskRecurrenceView>;

export const zProjectTaskRecurrenceClearResult = z.object({
  projectId: zId,
  taskId: zId,
  cleared: z.boolean(),
});
export type ProjectTaskRecurrenceClearResult = z.infer<typeof zProjectTaskRecurrenceClearResult>;

export const PROJECT_DEPENDENCIES_MAX = 500;
export const TASK_DEPENDENCIES_MAX = 20;

export const zProjectDependencyTaskRef = z.object({
  id: zId,
  title: z.string(),
  status: zTaskStatus,
  due: z.string().nullable(),
});
export type ProjectDependencyTaskRef = z.infer<typeof zProjectDependencyTaskRef>;

export const zProjectDependencyEdge = z.object({
  id: zId,
  projectId: zId,
  blockerTaskId: zId,
  blockedTaskId: zId,
  createdBy: zId.nullable(),
  createdAt: z.string(),
  blocker: zProjectDependencyTaskRef,
  blocked: zProjectDependencyTaskRef,
});
export type ProjectDependencyEdge = z.infer<typeof zProjectDependencyEdge>;

export const zProjectDependencyAddInput = z.strictObject({
  projectId: zId,
  blockerTaskId: zId,
  blockedTaskId: zId,
});
export type ProjectDependencyAddInput = z.infer<typeof zProjectDependencyAddInput>;

export const zProjectDependencyAddResult = z.object({
  dependencyId: zId,
  projectId: zId,
  blockerTaskId: zId,
  blockedTaskId: zId,
  createdAt: z.string(),
});
export type ProjectDependencyAddResult = z.infer<typeof zProjectDependencyAddResult>;

export const zProjectDependencyRemoveInput = z
  .strictObject({
    projectId: zId,
    dependencyId: zId.optional(),
    blockerTaskId: zId.optional(),
    blockedTaskId: zId.optional(),
  })
  .refine(
    (v) => v.dependencyId !== undefined || (v.blockerTaskId !== undefined && v.blockedTaskId !== undefined),
    { message: 'Provide dependencyId or both blockerTaskId and blockedTaskId' },
  );
export type ProjectDependencyRemoveInput = z.infer<typeof zProjectDependencyRemoveInput>;

export const zProjectDependencyRemoveResult = z.object({
  removed: z.boolean(),
  dependencyId: zId.nullable(),
});
export type ProjectDependencyRemoveResult = z.infer<typeof zProjectDependencyRemoveResult>;

export const zProjectDependencyListInput = z.strictObject({
  projectId: zId,
  taskId: zId.optional(),
});
export type ProjectDependencyListInput = z.infer<typeof zProjectDependencyListInput>;

export const zProjectDependencyListResult = z.object({
  projectId: zId,
  edges: z.array(zProjectDependencyEdge),
  totalEdges: z.number().int().nonnegative(),
});
export type ProjectDependencyListResult = z.infer<typeof zProjectDependencyListResult>;

// Project Gantt / Timeline view (#2599, docs/plan/projects-v2.md section 5.1, ADR-0056 section 5).
export const PROJECT_TIMELINE_LIMIT = 200;

export const zProjectTaskSetDatesInput = z.strictObject({
  projectId: zId,
  taskId: zId,
  startOn: zLocalDate.nullable().optional(),
  due: z.iso.datetime({ offset: true }).nullable().optional(),
});
export type ProjectTaskSetDatesInput = z.infer<typeof zProjectTaskSetDatesInput>;

export const zProjectTaskSetDatesResult = z.object({
  projectId: zId,
  taskId: zId,
  startOn: zLocalDate.nullable(),
  due: z.string().nullable(),
});
export type ProjectTaskSetDatesResult = z.infer<typeof zProjectTaskSetDatesResult>;

export const zProjectTimelineInput = z.strictObject({
  projectId: zId,
  positionId: z.union([zId, z.literal('root')]).optional(),
  includeCancelled: z.boolean().optional(),
});
export type ProjectTimelineInput = z.infer<typeof zProjectTimelineInput>;

export const zProjectTimelineTask = z.object({
  id: zId,
  title: z.string(),
  description: z.string().nullable(),
  status: zTaskStatus,
  startOn: zLocalDate.nullable(),
  due: z.string().nullable(),
  assigneePositionId: zId.nullable(),
  assigneeTitle: z.string().nullable(),
  tainted: z.boolean(),
  checkedOut: z.boolean(),
  commentCount: z.number().int().nonnegative(),
  openBlockerCount: z.number().int().nonnegative(),
  blockingCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectTimelineTask = z.infer<typeof zProjectTimelineTask>;

export const zProjectTimelineEdge = z.object({
  id: zId,
  blockerTaskId: zId,
  blockedTaskId: zId,
});
export type ProjectTimelineEdge = z.infer<typeof zProjectTimelineEdge>;

export const zProjectTimelineConflict = z.object({
  dependencyId: zId,
  blockerTaskId: zId,
  blockedTaskId: zId,
  blockerDueDate: zLocalDate,
  blockedTargetDate: zLocalDate,
  blockedField: z.enum(['start_on', 'due']),
});
export type ProjectTimelineConflict = z.infer<typeof zProjectTimelineConflict>;

export const zProjectTimelineCycle = z.object({
  id: zId,
  number: z.number().int().min(1),
  name: z.string(),
  status: z.enum(['upcoming', 'active', 'completed']),
  startsOn: zLocalDate,
  endsOn: zLocalDate,
});
export type ProjectTimelineCycle = z.infer<typeof zProjectTimelineCycle>;

export const zProjectTimeline = z.object({
  project: zProjectDetail,
  seats: z.array(zProjectSeat),
  tasks: z.array(zProjectTimelineTask),
  edges: z.array(zProjectTimelineEdge),
  conflicts: z.array(zProjectTimelineConflict),
  criticalPathTaskIds: z.array(zId),
  criticalPathLength: z.number().int().nonnegative(),
  criticalPathSpanDays: z.number().int().nonnegative(),
  cycles: z.array(zProjectTimelineCycle).optional(),
  totalVisible: z.number().int().nonnegative(),
  hiddenByEntityCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
  today: zLocalDate,
});
export type ProjectTimeline = z.infer<typeof zProjectTimeline>;

// Opt-in Sprints / Cycles, Story points, deterministic burndown/velocity, and Vy cycle summary (#4361, docs/plan/projects-v2.md section 4.1).
export const zProjectCycleName = z.string().trim().min(1).max(PROJECT_CYCLE_NAME_MAX);
export const zProjectCycleGoal = z.string().trim().max(PROJECT_CYCLE_GOAL_MAX);

export const zProjectCycleCreateInput = z.strictObject({
  projectId: zId,
  name: zProjectCycleName,
  goal: zProjectCycleGoal.nullable().optional(),
  startsOn: zLocalDate.optional(),
  endsOn: zLocalDate.optional(),
});
export type ProjectCycleCreateInput = z.infer<typeof zProjectCycleCreateInput>;

export const zProjectCycleUpdateInput = z.strictObject({
  projectId: zId,
  cycleId: zId,
  name: zProjectCycleName.optional(),
  goal: zProjectCycleGoal.nullable().optional(),
  startsOn: zLocalDate.optional(),
  endsOn: zLocalDate.optional(),
});
export type ProjectCycleUpdateInput = z.infer<typeof zProjectCycleUpdateInput>;

export const zProjectCycleDeleteInput = z.strictObject({
  projectId: zId,
  cycleId: zId,
});
export type ProjectCycleDeleteInput = z.infer<typeof zProjectCycleDeleteInput>;

export const zProjectCycleStartInput = z.strictObject({
  projectId: zId,
  cycleId: zId,
});
export type ProjectCycleStartInput = z.infer<typeof zProjectCycleStartInput>;

export const zProjectCycleCarryover = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('none') }),
  z.strictObject({ mode: z.literal('backlog') }),
  z.strictObject({ mode: z.literal('cycle'), targetCycleId: zId }),
]);
export type ProjectCycleCarryover = z.infer<typeof zProjectCycleCarryover>;

export const zProjectCycleCompleteInput = z.strictObject({
  projectId: zId,
  cycleId: zId,
  carryover: zProjectCycleCarryover,
});
export type ProjectCycleCompleteInput = z.infer<typeof zProjectCycleCompleteInput>;

export const zProjectTaskSetCycleInput = z.strictObject({
  projectId: zId,
  taskId: zId,
  cycleId: zId.nullable(),
});
export type ProjectTaskSetCycleInput = z.infer<typeof zProjectTaskSetCycleInput>;

export const zProjectTaskSetPointsInput = z.strictObject({
  projectId: zId,
  taskId: zId,
  storyPoints: zProjectStoryPoints.nullable(),
});
export type ProjectTaskSetPointsInput = z.infer<typeof zProjectTaskSetPointsInput>;

export const zProjectCycleMutateResult = z.object({
  cycle: zProjectCycle,
});
export type ProjectCycleMutateResult = z.infer<typeof zProjectCycleMutateResult>;

export const zProjectCycleDeleteResult = z.object({
  projectId: zId,
  cycleId: zId,
  deleted: z.boolean(),
});
export type ProjectCycleDeleteResult = z.infer<typeof zProjectCycleDeleteResult>;

export const zProjectCycleCompleteResult = z.object({
  cycle: zProjectCycle,
  carriedOverCount: z.number().int().nonnegative(),
  targetCycleId: zId.nullable(),
});
export type ProjectCycleCompleteResult = z.infer<typeof zProjectCycleCompleteResult>;

export const zProjectTaskSetCycleResult = z.object({
  projectId: zId,
  taskId: zId,
  cycleId: zId.nullable(),
});
export type ProjectTaskSetCycleResult = z.infer<typeof zProjectTaskSetCycleResult>;

export const zProjectTaskSetPointsResult = z.object({
  projectId: zId,
  taskId: zId,
  storyPoints: zProjectStoryPoints.nullable(),
});
export type ProjectTaskSetPointsResult = z.infer<typeof zProjectTaskSetPointsResult>;

export const zProjectCycleListInput = z.strictObject({
  projectId: zId,
});
export type ProjectCycleListInput = z.infer<typeof zProjectCycleListInput>;

export const zProjectCycleListResult = z.object({
  cycles: z.array(zProjectCycle),
  backlogTaskCount: z.number().int().nonnegative(),
  backlogPoints: z.number().int().nonnegative(),
  hiddenByEntityCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ProjectCycleListResult = z.infer<typeof zProjectCycleListResult>;

export const zProjectCycleBurndownPoint = z.object({
  date: zLocalDate,
  idealRemainingTasks: z.number().nonnegative(),
  idealRemainingPoints: z.number().nonnegative(),
  remainingTasks: z.number().int().nonnegative().nullable(),
  remainingPoints: z.number().int().nonnegative().nullable(),
});
export type ProjectCycleBurndownPoint = z.infer<typeof zProjectCycleBurndownPoint>;

export const zProjectCycleVelocityPoint = z.object({
  cycleId: zId,
  number: z.number().int().positive(),
  name: z.string(),
  startsOn: zLocalDate,
  endsOn: zLocalDate,
  completedTasks: z.number().int().nonnegative(),
  totalTasks: z.number().int().nonnegative(),
  completedPoints: z.number().int().nonnegative(),
  committedPoints: z.number().int().nonnegative(),
});
export type ProjectCycleVelocityPoint = z.infer<typeof zProjectCycleVelocityPoint>;

export const zProjectCycleMetricsInput = z.strictObject({
  projectId: zId,
  cycleId: zId.optional(),
});
export type ProjectCycleMetricsInput = z.infer<typeof zProjectCycleMetricsInput>;

export const zProjectCycleMetrics = z.object({
  projectId: zId,
  selectedCycle: zProjectCycle.nullable(),
  burndown: z.array(zProjectCycleBurndownPoint),
  velocity: z.array(zProjectCycleVelocityPoint),
  averageVelocityTasks: z.number().nonnegative(),
  averageVelocityPoints: z.number().nonnegative(),
  hiddenByEntityCount: z.number().int().nonnegative(),
});
export type ProjectCycleMetrics = z.infer<typeof zProjectCycleMetrics>;

export const zProjectCycleSummaryInput = z.strictObject({
  projectId: zId,
  cycleId: zId.optional(),
  language: z.enum(['vi', 'en']).optional(),
});
export type ProjectCycleSummaryInput = z.infer<typeof zProjectCycleSummaryInput>;

export const zProjectCycleSummary = z.strictObject({
  ai: z.enum(PROJECT_WEEKLY_STATUS_STATES),
  project: z.strictObject({
    id: zId,
    name: z.string(),
    status: zProjectStatus,
  }),
  cycle: zProjectCycle.nullable(),
  metrics: zProjectCycleMetrics,
  hiddenByEntityCount: z.number().int().nonnegative(),
  sentences: z.array(z.string().max(400)).max(5),
  truncated: z.boolean(),
});
export type ProjectCycleSummary = z.infer<typeof zProjectCycleSummary>;

// Lean time tracking and billable hours (#2600, docs/plan/projects-v2.md section 5.2).
export const PROJECT_TIME_NOTE_MAX = 500;
export const PROJECT_TIME_DURATION_MIN = 1;
export const PROJECT_TIME_DURATION_MAX = 14400;
export const PROJECT_TIME_ENTRIES_PAGE_LIMIT = 50;
export const PROJECT_TIME_EXPORT_LIMIT = 5000;

export const zProjectTimeHourlyRate = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,2})?$/, 'non-negative decimal string with up to 2 decimals');
export const zProjectTimeMoneyTotal = z
  .string()
  .regex(/^\d{1,24}\.\d{2}$/, 'non-negative decimal string formatted to 2 decimals');
const zProjectTimeIsoInstant = z.iso.datetime({ offset: true });
const zProjectTimeDurationMinutes = z.number().int().min(PROJECT_TIME_DURATION_MIN).max(PROJECT_TIME_DURATION_MAX);
const zProjectTimeNoteInput = z.string().trim().max(PROJECT_TIME_NOTE_MAX);

export const zProjectTimeEntry = z.object({
  id: zId,
  projectId: zId,
  taskId: zId.nullable(),
  taskTitle: z.string().nullable(),
  userId: zId.nullable(),
  userDisplayName: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMinutes: z.number().int().min(PROJECT_TIME_DURATION_MIN).max(PROJECT_TIME_DURATION_MAX).nullable(),
  billable: z.boolean(),
  hourlyRate: zProjectTimeHourlyRate.nullable(),
  billableAmount: zProjectTimeMoneyTotal.nullable(),
  note: z.string().nullable(),
  running: z.boolean(),
  canManage: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProjectTimeEntry = z.infer<typeof zProjectTimeEntry>;

export const zProjectTimeTotals = z.object({
  entryCount: z.number().int().nonnegative(),
  totalMinutes: z.number().int().nonnegative(),
  billableMinutes: z.number().int().nonnegative(),
  nonBillableMinutes: z.number().int().nonnegative(),
  totalHours: z.string(),
  billableHours: z.string(),
  nonBillableHours: z.string(),
  billableAmount: zProjectTimeMoneyTotal,
});
export type ProjectTimeTotals = z.infer<typeof zProjectTimeTotals>;

export const zProjectTimeTaskSummary = z.object({
  taskId: zId.nullable(),
  taskTitle: z.string().nullable(),
  totals: zProjectTimeTotals,
});
export type ProjectTimeTaskSummary = z.infer<typeof zProjectTimeTaskSummary>;

export const zProjectTimeMemberSummary = z.object({
  userId: zId.nullable(),
  displayName: z.string().nullable(),
  totals: zProjectTimeTotals,
});
export type ProjectTimeMemberSummary = z.infer<typeof zProjectTimeMemberSummary>;

export const zProjectTimeActiveTimer = z.object({
  entry: zProjectTimeEntry,
  projectName: z.string(),
});
export type ProjectTimeActiveTimer = z.infer<typeof zProjectTimeActiveTimer>;

export const zProjectTimeStartInput = z.strictObject({
  projectId: zId,
  taskId: zId.nullable().optional(),
  billable: z.boolean().default(false),
  hourlyRate: zProjectTimeHourlyRate.nullable().optional(),
  note: zProjectTimeNoteInput.nullable().optional(),
  stopExisting: z.boolean().default(false),
});
export type ProjectTimeStartInput = z.input<typeof zProjectTimeStartInput>;

export const zProjectTimeStartResult = z.object({
  entry: zProjectTimeEntry,
  stoppedEntry: zProjectTimeEntry.nullable(),
});
export type ProjectTimeStartResult = z.infer<typeof zProjectTimeStartResult>;

export const zProjectTimeStopInput = z.strictObject({
  projectId: zId.optional(),
  entryId: zId.optional(),
  note: zProjectTimeNoteInput.nullable().optional(),
  billable: z.boolean().optional(),
  hourlyRate: zProjectTimeHourlyRate.nullable().optional(),
});
export type ProjectTimeStopInput = z.infer<typeof zProjectTimeStopInput>;

export const zProjectTimeStopResult = z.object({
  entry: zProjectTimeEntry,
  clampedToMax: z.boolean(),
});
export type ProjectTimeStopResult = z.infer<typeof zProjectTimeStopResult>;

export function validTimeLogRange(v: {
  startedAt: string;
  endedAt?: string | undefined;
  durationMinutes?: number | undefined;
}): boolean {
  if (v.endedAt !== undefined && Date.parse(v.endedAt) < Date.parse(v.startedAt)) return false;
  return v.durationMinutes !== undefined || v.endedAt !== undefined;
}
export const PROJECT_TIME_LOG_RANGE_ISSUE = {
  message: 'Provide durationMinutes or an endedAt at or after startedAt',
  path: ['endedAt'],
};

export const zProjectTimeLogFields = z.strictObject({
  projectId: zId,
  taskId: zId.nullable().optional(),
  startedAt: zProjectTimeIsoInstant,
  endedAt: zProjectTimeIsoInstant.optional(),
  durationMinutes: zProjectTimeDurationMinutes.optional(),
  billable: z.boolean().default(false),
  hourlyRate: zProjectTimeHourlyRate.nullable().optional(),
  note: zProjectTimeNoteInput.nullable().optional(),
});
export const zProjectTimeLogInput = zProjectTimeLogFields.refine(validTimeLogRange, PROJECT_TIME_LOG_RANGE_ISSUE);
export type ProjectTimeLogInput = z.input<typeof zProjectTimeLogInput>;

export function validTimeUpdateRange(v: {
  startedAt?: string | undefined;
  endedAt?: string | undefined;
}): boolean {
  if (v.startedAt !== undefined && v.endedAt !== undefined) {
    return Date.parse(v.endedAt) >= Date.parse(v.startedAt);
  }
  return true;
}
export const PROJECT_TIME_UPDATE_RANGE_ISSUE = {
  message: 'endedAt must be at or after startedAt',
  path: ['endedAt'],
};

export const zProjectTimeUpdateFields = z.strictObject({
  projectId: zId.optional(),
  entryId: zId,
  taskId: zId.nullable().optional(),
  startedAt: zProjectTimeIsoInstant.optional(),
  endedAt: zProjectTimeIsoInstant.optional(),
  durationMinutes: zProjectTimeDurationMinutes.optional(),
  billable: z.boolean().optional(),
  hourlyRate: zProjectTimeHourlyRate.nullable().optional(),
  note: zProjectTimeNoteInput.nullable().optional(),
});
export const zProjectTimeUpdateInput = zProjectTimeUpdateFields.refine(validTimeUpdateRange, PROJECT_TIME_UPDATE_RANGE_ISSUE);
export type ProjectTimeUpdateInput = z.infer<typeof zProjectTimeUpdateInput>;

export const zProjectTimeMutateResult = z.object({
  entry: zProjectTimeEntry,
});
export type ProjectTimeMutateResult = z.infer<typeof zProjectTimeMutateResult>;

export const zProjectTimeDeleteInput = z.strictObject({
  projectId: zId.optional(),
  entryId: zId,
});
export type ProjectTimeDeleteInput = z.infer<typeof zProjectTimeDeleteInput>;

export const zProjectTimeDeleteResult = z.object({
  deleted: z.boolean(),
  entryId: zId,
  projectId: zId,
});
export type ProjectTimeDeleteResult = z.infer<typeof zProjectTimeDeleteResult>;

export const zProjectTimeSummaryInput = z
  .strictObject({
    projectId: zId,
    taskId: zId.optional(),
    userId: zId.optional(),
    from: zLocalDate.optional(),
    to: zLocalDate.optional(),
    billableOnly: z.boolean().optional(),
    timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
    limit: z.number().int().min(1).max(PROJECT_TIME_ENTRIES_PAGE_LIMIT).default(PROJECT_TIME_ENTRIES_PAGE_LIMIT),
    offset: z.number().int().min(0).default(0),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: 'from must be on or before to',
    path: ['to'],
  });
export type ProjectTimeSummaryInput = z.input<typeof zProjectTimeSummaryInput>;

export const zProjectTimeSummaryResult = z.object({
  projectId: zId,
  timeZone: z.string(),
  canWrite: z.boolean(),
  canManageProject: z.boolean(),
  activeTimer: zProjectTimeActiveTimer.nullable(),
  totals: zProjectTimeTotals,
  byTask: z.array(zProjectTimeTaskSummary),
  byMember: z.array(zProjectTimeMemberSummary),
  entries: z.array(zProjectTimeEntry),
  totalEntries: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});
export type ProjectTimeSummaryResult = z.infer<typeof zProjectTimeSummaryResult>;

export const zProjectTimeExportCsvInput = z
  .strictObject({
    projectId: zId,
    taskId: zId.optional(),
    userId: zId.optional(),
    from: zLocalDate.optional(),
    to: zLocalDate.optional(),
    billableOnly: z.boolean().optional(),
    timeZone: zTimeZone.default(DEFAULT_TIME_ZONE),
  })
  .refine((v) => v.from === undefined || v.to === undefined || v.from <= v.to, {
    message: 'from must be on or before to',
    path: ['to'],
  });
export type ProjectTimeExportCsvInput = z.input<typeof zProjectTimeExportCsvInput>;

export const zProjectTimeExportCsvResult = z.object({
  filename: z.string(),
  csv: z.string(),
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ProjectTimeExportCsvResult = z.infer<typeof zProjectTimeExportCsvResult>;


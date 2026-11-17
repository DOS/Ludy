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

// Board columns are the five open/done statuses; cancelled sits behind a filter (ADR-0048 point 2).
export const BOARD_TASK_STATUSES = ['todo', 'in_progress', 'waiting', 'in_review', 'done'] as const;
export type BoardTaskStatus = (typeof BOARD_TASK_STATUSES)[number];

export const zProjectName = z.string().trim().min(1).max(PROJECT_NAME_MAX);
export const zProjectDescription = z.string().trim().max(PROJECT_DESCRIPTION_MAX);

export const zProjectCreate = z.strictObject({
  name: zProjectName,
  description: zProjectDescription.nullable().optional(),
  ownerUserId: zId.optional(),
  memberUserIds: z.array(zId).max(200).optional(),
});
export type ProjectCreateInput = z.infer<typeof zProjectCreate>;

export const zProjectUpdate = z.strictObject({
  projectId: zId,
  name: zProjectName.optional(),
  description: zProjectDescription.nullable().optional(),
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
  due: z.iso.datetime().optional(),
  status: z.enum(BOARD_TASK_STATUSES).optional(),
  checklist: zTaskChecklist.optional(),
});
export type ProjectTaskCreateInput = z.infer<typeof zProjectTaskCreate>;

export const zProjectSummary = z.object({
  id: zId,
  name: z.string(),
  description: z.string().nullable(),
  ownerUserId: zId.nullable(),
  ownerName: z.string().nullable(),
  status: zProjectStatus,
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
  assigneePositionId: zId.nullable(),
  due: z.string().nullable(),
  checklist: z.array(zTaskChecklistStepView),
  tainted: z.boolean(),
  checkedOut: z.boolean(),
  commentCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  addedAt: z.string(),
  recurrence: zProjectTaskRecurrence.nullable().optional(),
  recurrenceCount: z.number().int().nonnegative().optional(),
  recurrenceLastDue: zLocalDate.nullable().optional(),
  recurrenceNextAt: z.string().nullable().optional(),
  recurrenceSourceTaskId: zId.nullable().optional(),
});
export type ProjectTaskCard = z.infer<typeof zProjectTaskCard>;

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
  tasks: z.array(zProjectTaskCard),
  totalVisible: z.number().int().nonnegative(),
  hiddenByEntityCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type ProjectBoard = z.infer<typeof zProjectBoard>;

export const zProjectCandidateTask = z.object({
  id: zId,
  title: z.string(),
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
  tasks: zProjectWeeklyStatusTasks,
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


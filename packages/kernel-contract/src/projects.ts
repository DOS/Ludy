// SPDX-License-Identifier: AGPL-3.0-only
// Projects and a task board on kernel tasks (issue #2591, plan docs/plan/projects.md section 4, ADR-0048).
import { z } from 'zod';
import { zId, zLocalDate, zPositionStatus, zRole, zTaskStatus } from './schemas.ts';

export const PROJECT_NAME_MAX = 200;
export const PROJECT_DESCRIPTION_MAX = 2000;
export const PROJECT_BOARD_LIMIT = 300;
export const PROJECT_LIST_LIMIT = 200;
export const PROJECT_UNASSIGNED_LIMIT = 100;
export const PROJECT_TASK_MAP_LIMIT = 500;

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

export const zProjectTaskCreate = z.strictObject({
  projectId: zId,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(10000).optional(),
  assigneePositionId: zId.nullable(),
  due: z.iso.datetime().optional(),
  status: z.enum(BOARD_TASK_STATUSES).optional(),
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
  tainted: z.boolean(),
  checkedOut: z.boolean(),
  commentCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  addedAt: z.string(),
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

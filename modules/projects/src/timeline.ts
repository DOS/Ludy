// SPDX-License-Identifier: AGPL-3.0-only
// Project Gantt / Timeline query and atomic schedule command (#2599, docs/plan/projects-v2.md section 5.1, ADR-0056 section 5).
import { sql } from 'kysely';
import type { TaskStatus } from '@ludy/db';
import { kernelManifest } from '@ludy/kernel';
import {
  PROJECT_DEPENDENCIES_MAX,
  PROJECT_TIMELINE_LIMIT,
  tableWrite,
  vietnamToday,
  zProjectTaskSetDatesInput,
  zProjectTimelineInput,
  type ProjectDetail,
  type ProjectTaskSetDatesResult,
  type ProjectTimeline,
  type ProjectTimelineEdge,
  type ProjectTimelineTask,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { computeCriticalPath, detectTimelineConflicts, isValidScheduleRange } from './domain/timeline.ts';
import { projectsManifest } from './manifest.ts';
import {
  READERS,
  WRITERS,
  assertNotArchived,
  canManageProject,
  canWriteProject,
  countHiddenProjectTasks,
  loadProject,
  loadProjectSeatsAndProfiles,
  loadProjectTaskCounts,
  memberProfilesMap,
  ownerDisplayName,
  taskNotFound,
  userOf,
} from './shared.ts';

const TABLES = projectsManifest.tables;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export const projectTaskSetDates = defineCommand({
  name: 'projects.task.set_dates',
  input: zProjectTaskSetDatesInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'project_task', ['start_on']),
    tableWrite(kernelManifest.tables, 'ludy_kernel', 'task', ['due']),
  ],
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<ProjectTaskSetDatesResult> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    // Lock kernel task first (enforcing le_scope and private_project_scope RLS), then project_task.
    const task = await ctx.trx
      .selectFrom('ludy_kernel.task')
      .select(['id', 'due', 'checkout_run_id', 'lock_expires_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.taskId)
      .forUpdate()
      .executeTakeFirst();
    if (!task) throw taskNotFound();

    const pt = await ctx.trx
      .selectFrom('ludy_projects.project_task')
      .select(['id', 'start_on'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', input.taskId)
      .forUpdate()
      .executeTakeFirst();
    if (!pt) throw taskNotFound();

    if (
      task.checkout_run_id !== null &&
      task.lock_expires_at !== null &&
      new Date(task.lock_expires_at).getTime() > ctx.now.getTime()
    ) {
      throw new DomainError('TASK_CHECKED_OUT', 409, 'Việc này đang được xử lý');
    }

    const existingStartOn = pt.start_on;
    const existingDueIso = task.due === null ? null : new Date(task.due).toISOString();
    const nextStartOn = input.startOn !== undefined ? input.startOn : existingStartOn;
    const nextDueIso =
      input.due !== undefined ? (input.due === null ? null : new Date(input.due).toISOString()) : existingDueIso;

    if (!isValidScheduleRange(nextStartOn, nextDueIso)) {
      throw new DomainError('INVALID_DATE_RANGE', 422, 'Ngày bắt đầu không được sau hạn hoàn thành');
    }

    const startChanged = nextStartOn !== existingStartOn;
    const dueChanged = nextDueIso !== existingDueIso;
    const changed = [...(startChanged ? ['startOn'] : []), ...(dueChanged ? ['due'] : [])];

    if (startChanged) {
      await ctx.trx
        .updateTable('ludy_projects.project_task')
        .set({ start_on: nextStartOn })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('task_id', '=', task.id)
        .execute();
    }

    if (dueChanged) {
      await ctx.trx
        .updateTable('ludy_kernel.task')
        .set({ due: nextDueIso === null ? null : new Date(nextDueIso) })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', task.id)
        .execute();
    }

    ctx.audit({
      projectId: project.id,
      taskId: task.id,
      changed,
      startOn: nextStartOn,
      due: nextDueIso,
    });

    if (changed.length > 0) {
      await ctx.emit('projects.task.dates_set', { projectId: project.id, taskId: task.id });
      await ctx.activity('projects.project', project.id, 'projects.task.dates_set', 'Cập nhật lịch công việc');
    }

    return {
      projectId: project.id,
      taskId: task.id,
      startOn: nextStartOn,
      due: nextDueIso,
    };
  },
});

export const projectTimeline = defineQuery({
  name: 'projects.timeline',
  input: zProjectTimelineInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectTimeline> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);

    const projectMemberRows = await ctx.trx
      .selectFrom('ludy_projects.project_member')
      .select('user_id')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', row.id)
      .execute();
    const onProjectIds = new Set(projectMemberRows.map((m) => m.user_id));

    const [{ seats }, ownerProfiles, hiddenByEntityCount] = await Promise.all([
      loadProjectSeatsAndProfiles(ctx.trx, ctx.orgId, row.id, onProjectIds),
      memberProfilesMap(ctx.trx, row.owner_user_id ? [row.owner_user_id] : []),
      countHiddenProjectTasks(ctx.trx, ctx.orgId, row.id),
    ]);

    const project: ProjectDetail = {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerUserId: row.owner_user_id,
      ownerName: ownerDisplayName(ownerProfiles, row.owner_user_id),
      status: row.status,
      visibility: row.visibility,
      canManage: canManageProject(ctx.role, userId, row.owner_user_id),
      canWrite: canWriteProject(ctx.role, row.status),
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };

    const positionFilter =
      input.positionId === 'root'
        ? sql<boolean>`t.assignee_position_id IS NULL`
        : input.positionId !== undefined
          ? sql<boolean>`t.assignee_position_id = ${input.positionId}::uuid`
          : sql<boolean>`TRUE`;
    const cancelledFilter = input.includeCancelled ? sql<boolean>`TRUE` : sql<boolean>`t.status <> 'cancelled'`;

    const { rows: rawTasks } = await sql<{
      id: string;
      title: string;
      description: string | null;
      status: string;
      start_on: string | null;
      due: Date | string | null;
      assignee_position_id: string | null;
      assignee_title: string | null;
      tainted: boolean;
      checked_out: boolean;
      created_at: Date | string;
      updated_at: Date | string;
    }>`
      SELECT
        t.id,
        t.title,
        t.description,
        t.status,
        pt.start_on,
        t.due,
        t.assignee_position_id,
        pos.title AS assignee_title,
        t.tainted,
        (t.checkout_run_id IS NOT NULL AND t.lock_expires_at > pg_catalog.now()) AS checked_out,
        t.created_at,
        t.updated_at
      FROM ludy_projects.project_task pt
      JOIN ludy_kernel.task t
        ON t.org_id = pt.org_id AND t.id = pt.task_id
      LEFT JOIN ludy_kernel.position pos
        ON pos.org_id = t.org_id AND pos.id = t.assignee_position_id
      WHERE pt.org_id = ${ctx.orgId}::uuid
        AND pt.project_id = ${row.id}::uuid
        AND (${positionFilter})
        AND (${cancelledFilter})
      ORDER BY
        (pt.start_on IS NULL AND t.due IS NULL) ASC,
        COALESCE(pt.start_on, (t.due AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) ASC NULLS LAST,
        t.due ASC NULLS LAST,
        pt.sort_key ASC NULLS LAST,
        t.created_at ASC,
        t.id ASC
      LIMIT ${PROJECT_TIMELINE_LIMIT + 1}`.execute(ctx.trx);

    const truncated = rawTasks.length > PROJECT_TIMELINE_LIMIT;
    const page = truncated ? rawTasks.slice(0, PROJECT_TIMELINE_LIMIT) : rawTasks;

    let totalVisible = page.length;
    if (truncated) {
      const { rows: countRows } = await sql<{ n: string }>`
        SELECT pg_catalog.count(*)::text AS n
          FROM ludy_projects.project_task pt
          JOIN ludy_kernel.task t
            ON t.org_id = pt.org_id AND t.id = pt.task_id
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${row.id}::uuid
           AND (${positionFilter})
           AND (${cancelledFilter})`.execute(ctx.trx);
      totalVisible = Number(countRows[0]?.n ?? page.length);
    }

    const taskIds = page.map((t) => t.id);
    const { commentCounts, openBlockerCounts, blockingCounts } = await loadProjectTaskCounts(
      ctx.trx,
      ctx.orgId,
      row.id,
      taskIds,
    );

    let edges: ProjectTimelineEdge[] = [];
    if (taskIds.length > 0) {
      const { rows: edgeRows } = await sql<{
        id: string;
        blocker_task_id: string;
        blocked_task_id: string;
      }>`
        SELECT d.id, d.blocker_task_id, d.blocked_task_id
          FROM ludy_projects.task_dependency d
          JOIN ludy_kernel.task bt
            ON bt.org_id = d.org_id AND bt.id = d.blocker_task_id
          JOIN ludy_kernel.task dt
            ON dt.org_id = d.org_id AND dt.id = d.blocked_task_id
         WHERE d.org_id = ${ctx.orgId}::uuid
           AND d.project_id = ${row.id}::uuid
           AND d.blocker_task_id = ANY(${taskIds}::uuid[])
           AND d.blocked_task_id = ANY(${taskIds}::uuid[])
         ORDER BY d.created_at ASC, d.id ASC
         LIMIT ${PROJECT_DEPENDENCIES_MAX}`.execute(ctx.trx);
      edges = edgeRows.map((e) => ({
        id: e.id,
        blockerTaskId: e.blocker_task_id,
        blockedTaskId: e.blocked_task_id,
      }));
    }

    const tasks: ProjectTimelineTask[] = page.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status as TaskStatus,
      startOn: t.start_on,
      due: t.due === null ? null : toIso(t.due),
      assigneePositionId: t.assignee_position_id,
      assigneeTitle: t.assignee_title,
      tainted: t.tainted,
      checkedOut: Boolean(t.checked_out),
      commentCount: commentCounts.get(t.id) ?? 0,
      openBlockerCount: openBlockerCounts.get(t.id) ?? 0,
      blockingCount: blockingCounts.get(t.id) ?? 0,
      createdAt: toIso(t.created_at),
      updatedAt: toIso(t.updated_at),
    }));

    const conflicts = detectTimelineConflicts(tasks, edges);
    const { criticalPathTaskIds, criticalPathLength, criticalPathSpanDays } = computeCriticalPath(tasks, edges);

    return {
      project,
      seats,
      tasks,
      edges,
      conflicts,
      criticalPathTaskIds,
      criticalPathLength,
      criticalPathSpanDays,
      cycles: [],
      totalVisible,
      hiddenByEntityCount,
      truncated,
      today: vietnamToday(),
    };
  },
});

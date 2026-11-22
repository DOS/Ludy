// SPDX-License-Identifier: AGPL-3.0-only
// Projects and a task board over kernel tasks (issue #2591, docs/plan/projects.md, ADR-0048).
import { sql } from 'kysely';
import { z } from 'zod';
import {
  PROJECT_BOARD_LIMIT,
  PROJECT_LIST_LIMIT,
  PROJECT_TIME_DURATION_MAX,
  PROJECT_TIME_DURATION_MIN,
  PROJECT_UNASSIGNED_LIMIT,
  auditValue,
  normalizeFilter,
  parseTaskChecklist,
  tableWrite,
  vietnamToday,
  zId,
  zProjectArchive,
  zProjectBoardInput,
  zProjectCreate,
  zProjectListInput,
  zProjectMemberMutate,
  zProjectSetOwner,
  zProjectSetStatus,
  zProjectTaskCreate,
  zProjectTaskMutate,
  zProjectTaskProjectsInput,
  zProjectTaskReorder,
  zProjectUpdate,
  type FilterAst,
  type ProjectBoard,
  type ProjectCandidateTask,
  type ProjectDetail,
  type ProjectListResult,
  type ProjectMemberView,
  type ProjectStatus,
  type ProjectSummary,
  type ProjectTaskCard,
  type ProjectTaskProjectEntry,
  type ProjectTaskReorderResult,
  type ProjectVisibility,
} from '@ludy/kernel-contract';
import { filterCondition, sortTerms, taskFields, taskSortColumns } from '@ludy/kernel';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { isValidScheduleRange } from './domain/timeline.ts';
import { projectsManifest } from './manifest.ts';
import { loadProjectColumns, placeProjectTaskBetween, resolveTaskColumnId, type ProjectOrderRow } from './columns.ts';
import { loadActiveCycleView, loadCycle } from './cycles.ts';
import { parseStoredRecurrence } from './recurring.ts';
import {
  READERS,
  WRITERS,
  assertCanManage,
  assertCanSetPrivateVisibility,
  assertNotArchived,
  assertOrgMembers,
  canManageProject,
  canWriteProject,
  countHiddenProjectTasks,
  descriptionOf,
  ensurePrivateMembers,
  loadOrgMembers,
  loadProject,
  loadProjectSeatsAndProfiles,
  loadProjectTaskCounts,
  memberProfilesMap,
  ownerDisplayName,
  resolveCreateMemberIds,
  taskNotFound,
  userOf,
} from './shared.ts';
import { tasksFromNoteConfirm, tasksFromNoteStart } from './tasks-from-note.ts';

export { READERS, loadProject, userOf };

const TABLES = projectsManifest.tables;
const PROJECT = TABLES.crove_projects.project;

type TaskStatus = ProjectTaskCard['status'];

const projectTarget = (input: { projectId: string }) => ({ type: 'projects.project', id: input.projectId });

export const projectCreate = defineCommand({
  name: 'projects.project.create',
  input: zProjectCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project', [
      'org_id',
      'name',
      'description',
      'owner_user_id',
      'status',
      'visibility',
      'created_by',
      'created_at',
      'updated_at',
    ]),
    tableWrite(TABLES, 'crove_projects', 'project_member', ['org_id', 'project_id', 'user_id', 'created_at']),
  ],
  handler: async (ctx, input): Promise<{ projectId: string }> => {
    const userId = userOf(ctx.actor);
    const ownerUserId = input.ownerUserId ?? userId;
    const visibility = input.visibility ?? 'org';
    assertCanSetPrivateVisibility(ctx, ownerUserId, userId, visibility);
    const memberIds = resolveCreateMemberIds(visibility, input.memberUserIds, userId, ownerUserId);
    const checkIds = [...new Set([ownerUserId, ...memberIds])];
    const orgRoles = await assertOrgMembers(ctx.trx, ctx.orgId, checkIds);
    if (orgRoles.get(ownerUserId) === 'viewer') {
      throw new DomainError('PROJECT_OWNER_FORBIDDEN', 422, 'Người chỉ có quyền xem không thể phụ trách dự án');
    }
    const description = descriptionOf(input.description);
    const created = await ctx.trx
      .insertInto('crove_projects.project')
      .values({
        org_id: ctx.orgId,
        name: input.name,
        description,
        owner_user_id: ownerUserId,
        status: 'active',
        visibility,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    if (memberIds.length > 0) {
      await ctx.trx
        .insertInto('crove_projects.project_member')
        .values(
          memberIds.map((uid) => ({
            org_id: ctx.orgId,
            project_id: created.id,
            user_id: uid,
            created_at: ctx.now,
          })),
        )
        .execute();
    }

    ctx.audit({
      projectId: created.id,
      name: auditValue(PROJECT, 'name', input.name),
      description: auditValue(PROJECT, 'description', description),
      ownerUserId,
      visibility,
      memberCount: memberIds.length,
    });
    await ctx.emit('projects.project.created', { projectId: created.id, ownerUserId });
    await ctx.activity('projects.project', created.id, 'projects.project.created', 'Tạo dự án');
    return { projectId: created.id };
  },
});

export const projectUpdate = defineCommand({
  name: 'projects.project.update',
  input: zProjectUpdate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project', [
      'name',
      'description',
      'visibility',
      'cycles_enabled',
      'cycle_duration_weeks',
      'points_enabled',
      'updated_at',
    ]),
    tableWrite(TABLES, 'crove_projects', 'project_member', ['org_id', 'project_id', 'user_id', 'created_at']),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string }> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, row, userId);
    assertNotArchived(row);

    const nextName = input.name ?? row.name;
    const nextDescription = input.description !== undefined ? descriptionOf(input.description) : row.description;
    const nextVisibility = input.visibility ?? row.visibility;
    const nextCyclesEnabled = input.cyclesEnabled ?? row.cycles_enabled;
    const nextCycleDurationWeeks = input.cycleDurationWeeks ?? row.cycle_duration_weeks;
    const nextPointsEnabled = input.pointsEnabled ?? row.points_enabled;
    const changed = [
      ...(nextName !== row.name ? ['name'] : []),
      ...(nextDescription !== row.description ? ['description'] : []),
      ...(nextVisibility !== row.visibility ? ['visibility'] : []),
      ...(nextCyclesEnabled !== row.cycles_enabled ? ['cyclesEnabled'] : []),
      ...(nextCycleDurationWeeks !== row.cycle_duration_weeks ? ['cycleDurationWeeks'] : []),
      ...(nextPointsEnabled !== row.points_enabled ? ['pointsEnabled'] : []),
    ];

    if (changed.length > 0) {
      if (row.visibility !== 'private' && nextVisibility === 'private') {
        const { rows: accRows } = await sql<{ has_acceptance: boolean }>`
          SELECT crove_projects.has_project_acceptance_envelope(${ctx.orgId}::uuid, ${row.id}::uuid) AS has_acceptance
        `.execute(ctx.trx);
        if (accRows[0]?.has_acceptance) {
          throw new DomainError(
            'PROJECT_PRIVATE_ACCEPTANCE_EXISTS',
            409,
            'Dự án đã có biên bản nghiệm thu eSign chia sẻ nên không thể chuyển sang riêng tư',
          );
        }
        const linkedBoard = await ctx.trx
          .selectFrom('crove_projects.roadmap_board')
          .select('id')
          .where('org_id', '=', ctx.orgId)
          .where('project_id', '=', row.id)
          .limit(1)
          .executeTakeFirst();
        if (linkedBoard) {
          throw new DomainError(
            'ROADMAP_PRIVATE_PROJECT_FORBIDDEN',
            422,
            'Không thể gắn dự án riêng tư vào bảng lộ trình công khai',
          );
        }
        await ensurePrivateMembers(ctx.trx, ctx.orgId, row.id, [row.owner_user_id], ctx.now);
      }
      await ctx.trx
        .updateTable('crove_projects.project')
        .set({
          name: nextName,
          description: nextDescription,
          visibility: nextVisibility,
          cycles_enabled: nextCyclesEnabled,
          cycle_duration_weeks: nextCycleDurationWeeks,
          points_enabled: nextPointsEnabled,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', row.id)
        .execute();
    }

    ctx.audit({
      projectId: row.id,
      changed,
      ...(input.name !== undefined ? { name: auditValue(PROJECT, 'name', nextName) } : {}),
      ...(input.description !== undefined ? { description: auditValue(PROJECT, 'description', nextDescription) } : {}),
      ...(input.visibility !== undefined ? { visibility: nextVisibility } : {}),
      ...(input.cyclesEnabled !== undefined ? { cyclesEnabled: nextCyclesEnabled } : {}),
      ...(input.cycleDurationWeeks !== undefined ? { cycleDurationWeeks: nextCycleDurationWeeks } : {}),
      ...(input.pointsEnabled !== undefined ? { pointsEnabled: nextPointsEnabled } : {}),
    });
    if (changed.length > 0) {
      await ctx.emit('projects.project.updated', { projectId: row.id });
      await ctx.activity('projects.project', row.id, 'projects.project.updated', 'Cập nhật thông tin dự án');
    }
    return { projectId: row.id };
  },
});

export const projectSetStatus = defineCommand({
  name: 'projects.project.set_status',
  input: zProjectSetStatus,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'project', ['status', 'updated_at'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string; status: ProjectStatus }> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, row, userId);

    if (row.status !== input.status) {
      await ctx.trx
        .updateTable('crove_projects.project')
        .set({ status: input.status, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', row.id)
        .execute();
      await ctx.emit('projects.project.status_set', { projectId: row.id, status: input.status });
      await ctx.activity('projects.project', row.id, 'projects.project.status_set', 'Đổi trạng thái dự án');
    }

    ctx.audit({ projectId: row.id, from: row.status, to: input.status });
    return { projectId: row.id, status: input.status };
  },
});

export const projectArchive = defineCommand({
  name: 'projects.project.archive',
  input: zProjectArchive,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'project', ['status', 'updated_at'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string; status: 'archived' }> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, row, userId);

    if (row.status !== 'archived') {
      await ctx.trx
        .updateTable('crove_projects.project')
        .set({ status: 'archived', updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', row.id)
        .execute();
      await ctx.emit('projects.project.archived', { projectId: row.id });
      await ctx.activity('projects.project', row.id, 'projects.project.archived', 'Lưu trữ dự án');
    }

    ctx.audit({ projectId: row.id, from: row.status });
    return { projectId: row.id, status: 'archived' };
  },
});

export const projectSetOwner = defineCommand({
  name: 'projects.project.set_owner',
  input: zProjectSetOwner,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project', ['owner_user_id', 'updated_at']),
    tableWrite(TABLES, 'crove_projects', 'project_member', ['org_id', 'project_id', 'user_id', 'created_at']),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string; ownerUserId: string }> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, row, userId);
    assertNotArchived(row);

    const roles = await assertOrgMembers(ctx.trx, ctx.orgId, [input.ownerUserId]);
    if (roles.get(input.ownerUserId) === 'viewer') {
      throw new DomainError('PROJECT_OWNER_FORBIDDEN', 422, 'Người chỉ có quyền xem không thể phụ trách dự án');
    }

    if (row.owner_user_id !== input.ownerUserId) {
      if (row.visibility === 'private') {
        await ensurePrivateMembers(
          ctx.trx,
          ctx.orgId,
          row.id,
          [input.ownerUserId, row.owner_user_id],
          ctx.now,
        );
      }
      await ctx.trx
        .updateTable('crove_projects.project')
        .set({ owner_user_id: input.ownerUserId, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', row.id)
        .execute();
      await ctx.emit('projects.project.owner_set', { projectId: row.id, ownerUserId: input.ownerUserId });
      await ctx.activity('projects.project', row.id, 'projects.project.owner_set', 'Đổi người phụ trách dự án');
    }

    ctx.audit({ projectId: row.id, fromOwnerUserId: row.owner_user_id, toOwnerUserId: input.ownerUserId });
    return { projectId: row.id, ownerUserId: input.ownerUserId };
  },
});

export const projectMemberAdd = defineCommand({
  name: 'projects.member.add',
  input: zProjectMemberMutate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'project_member', ['org_id', 'project_id', 'user_id', 'created_at'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string; userId: string; added: boolean }> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, row, userId);
    assertNotArchived(row);
    await assertOrgMembers(ctx.trx, ctx.orgId, [input.userId]);

    const inserted = await ctx.trx
      .insertInto('crove_projects.project_member')
      .values({
        org_id: ctx.orgId,
        project_id: row.id,
        user_id: input.userId,
        created_at: ctx.now,
      })
      .onConflict((oc) => oc.columns(['org_id', 'project_id', 'user_id']).doNothing())
      .returning('id')
      .executeTakeFirst();

    const added = inserted !== undefined;
    ctx.audit({ projectId: row.id, memberUserId: input.userId, added });
    if (added) {
      await ctx.emit('projects.member.added', { projectId: row.id, memberUserId: input.userId });
      await ctx.activity('projects.project', row.id, 'projects.member.added', 'Thêm thành viên dự án');
    }
    return { projectId: row.id, userId: input.userId, added };
  },
});

export const projectMemberRemove = defineCommand({
  name: 'projects.member.remove',
  input: zProjectMemberMutate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project_member', ['org_id', 'project_id', 'user_id']),
    tableWrite(TABLES, 'crove_projects', 'time_entry', ['ended_at', 'duration_minutes', 'updated_at']),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string; userId: string; removed: boolean }> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, row, userId);
    assertNotArchived(row);
    if (row.owner_user_id !== null && input.userId === row.owner_user_id) {
      throw new DomainError(
        'PROJECT_OWNER_CANNOT_REMOVE',
        409,
        'Không thể gỡ người phụ trách chính khỏi dự án; hãy đổi người phụ trách trước',
      );
    }

    const deleted = await ctx.trx
      .deleteFrom('crove_projects.project_member')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', row.id)
      .where('user_id', '=', input.userId)
      .returning('id')
      .executeTakeFirst();

    const removed = deleted !== undefined;
    if (removed && row.visibility === 'private') {
      const runningTimers = await ctx.trx
        .selectFrom('crove_projects.time_entry')
        .select(['id', 'started_at'])
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', row.id)
        .where('user_id', '=', input.userId)
        .where('ended_at', 'is', null)
        .forUpdate()
        .execute();
      for (const timer of runningTimers) {
        const startedMs = new Date(timer.started_at).getTime();
        const endedAt = ctx.now.getTime() < startedMs ? new Date(startedMs) : ctx.now;
        const rawMinutes = Math.round((endedAt.getTime() - startedMs) / 60_000);
        const durationMinutes = Math.min(PROJECT_TIME_DURATION_MAX, Math.max(PROJECT_TIME_DURATION_MIN, rawMinutes));
        await ctx.trx
          .updateTable('crove_projects.time_entry')
          .set({ ended_at: endedAt, duration_minutes: durationMinutes, updated_at: ctx.now })
          .where('org_id', '=', ctx.orgId)
          .where('id', '=', timer.id)
          .execute();
      }
    }
    ctx.audit({ projectId: row.id, memberUserId: input.userId, removed });
    if (removed) {
      await ctx.emit('projects.member.removed', { projectId: row.id, memberUserId: input.userId });
      await ctx.activity('projects.project', row.id, 'projects.member.removed', 'Gỡ thành viên dự án');
    }
    return { projectId: row.id, userId: input.userId, removed };
  },
});

export const projectTaskAdd = defineCommand({
  name: 'projects.task.add',
  input: zProjectTaskMutate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'project_task', ['org_id', 'project_id', 'task_id', 'added_by', 'created_at'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string; taskId: string; added: boolean }> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(row);

    const visibleTask = await ctx.trx
      .selectFrom('crove_kernel.task')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.taskId)
      .executeTakeFirst();
    if (!visibleTask) throw taskNotFound();

    const existing = await ctx.trx
      .selectFrom('crove_projects.project_task')
      .select(['id', 'project_id'])
      .where('org_id', '=', ctx.orgId)
      .where('task_id', '=', input.taskId)
      .executeTakeFirst();

    if (existing) {
      if (existing.project_id !== row.id) {
        throw new DomainError('TASK_ALREADY_IN_PROJECT', 409, 'Việc này đã thuộc một dự án khác');
      }
      ctx.audit({ projectId: row.id, taskId: input.taskId, added: false });
      return { projectId: row.id, taskId: input.taskId, added: false };
    }

    await ctx.trx
      .insertInto('crove_projects.project_task')
      .values({
        org_id: ctx.orgId,
        project_id: row.id,
        task_id: input.taskId,
        added_by: userId,
        created_at: ctx.now,
      })
      .execute()
      .catch((error: unknown) => {
        const pg = error as { code?: string; constraint?: string } | null | undefined;
        if (pg?.code === '23505' && pg.constraint === 'project_task_task_uq') {
          throw new DomainError('TASK_ALREADY_IN_PROJECT', 409, 'Việc này đã thuộc một dự án khác');
        }
        throw error;
      });

    ctx.audit({ projectId: row.id, taskId: input.taskId, added: true });
    await ctx.emit('projects.task.added', { projectId: row.id, taskId: input.taskId });
    await ctx.activity('projects.project', row.id, 'projects.task.added', 'Thêm việc vào dự án');
    return { projectId: row.id, taskId: input.taskId, added: true };
  },
});

export const projectTaskRemove = defineCommand({
  name: 'projects.task.remove',
  input: zProjectTaskMutate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project_task', ['org_id', 'project_id', 'task_id']),
    // Removing a task from a project cascades ON DELETE CASCADE to crove_projects.task_dependency.
    tableWrite(TABLES, 'crove_projects', 'task_dependency', ['org_id', 'project_id', 'id']),
    // Removing a task from a project clears task_id via ON DELETE SET NULL (task_id) on crove_projects.time_entry.
    tableWrite(TABLES, 'crove_projects', 'time_entry', ['task_id']),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string; taskId: string; removed: boolean }> => {
    userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(row);

    const visibleTask = await ctx.trx
      .selectFrom('crove_kernel.task')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.taskId)
      .executeTakeFirst();
    if (!visibleTask) throw taskNotFound();

    const existing = await ctx.trx
      .selectFrom('crove_projects.project_task')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', row.id)
      .where('task_id', '=', input.taskId)
      .executeTakeFirst();

    let removed = false;
    if (existing) {
      await ctx.trx
        .deleteFrom('crove_projects.project_task')
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', row.id)
        .where('task_id', '=', input.taskId)
        .execute();
      removed = true;
    }

    ctx.audit({ projectId: row.id, taskId: input.taskId, removed });
    if (removed) {
      await ctx.emit('projects.task.removed', { projectId: row.id, taskId: input.taskId });
      await ctx.activity('projects.project', row.id, 'projects.task.removed', 'Gỡ việc khỏi dự án');
    }
    return { projectId: row.id, taskId: input.taskId, removed };
  },
});

export const projectTaskReorder = defineCommand({
  name: 'projects.task.reorder',
  input: zProjectTaskReorder,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'project_task', ['sort_key'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectTaskReorderResult> => {
    userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(row);

    const visibleTasks = await ctx.trx
      .selectFrom('crove_kernel.task')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', [input.taskId, input.anchorId])
      .execute();
    if (visibleTasks.length !== 2) throw taskNotFound();

    const { rows: allRows } = await sql<ProjectOrderRow>`
      SELECT pt.task_id, pt.sort_key
        FROM crove_projects.project_task pt
        LEFT JOIN crove_kernel.task t
          ON t.org_id = pt.org_id AND t.id = pt.task_id
       WHERE pt.org_id = ${ctx.orgId}::uuid
         AND pt.project_id = ${row.id}::uuid
       ORDER BY pt.sort_key ASC NULLS LAST, t.due ASC NULLS LAST, t.created_at ASC, pt.task_id ASC, pt.created_at ASC`.execute(ctx.trx);

    if (!allRows.some((r) => r.task_id === input.taskId) || !allRows.some((r) => r.task_id === input.anchorId)) {
      throw taskNotFound();
    }

    const remaining = allRows.filter((r) => r.task_id !== input.taskId);
    const at = remaining.findIndex((r) => r.task_id === input.anchorId);
    const nextKey =
      input.place === 'before'
        ? await placeProjectTaskBetween(ctx, row.id, remaining, at - 1, at)
        : await placeProjectTaskBetween(ctx, row.id, remaining, at, at + 1);

    await ctx.trx
      .updateTable('crove_projects.project_task')
      .set({ sort_key: nextKey })
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', row.id)
      .where('task_id', '=', input.taskId)
      .execute();

    ctx.audit({ projectId: row.id, taskId: input.taskId, anchorId: input.anchorId, place: input.place });
    return { projectId: row.id, taskId: input.taskId };
  },
});

export const projectTaskCreate = defineCommand({
  name: 'projects.task.create',
  input: zProjectTaskCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // Calls kernel.task.create via ctx.run (which has no writes declaration), so omits writes to avoid checking
  // nested crove_kernel.task / wakeup inserts against a crove_projects-only declaration (human-only command).
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string; taskId: string }> => {
    const userId = userOf(ctx.actor);
    if (!isValidScheduleRange(input.startOn ?? null, input.due ?? null)) {
      throw new DomainError('INVALID_DATE_RANGE', 422, 'Ngày bắt đầu không được sau hạn hoàn thành');
    }
    // Check existence/status without a row lock before calling kernel.task.create (which locks crove_kernel.position),
    // then lock crove_projects.project afterwards so concurrent task/project writes share the position -> project lock order.
    const preview = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    assertNotArchived(preview);
    const cycleId = input.cycleId ?? null;
    if (cycleId !== null) {
      const cycle = await loadCycle(ctx.trx, ctx.orgId, preview.id, cycleId, false);
      if (cycle.status === 'completed') {
        throw new DomainError('CYCLE_COMPLETED', 409, 'Chu kỳ đã hoàn thành nên không thể chỉnh sửa hoặc gán việc');
      }
    }

    let effectiveStatus = input.status ?? 'todo';
    if (input.columnId !== undefined) {
      const requestedColumn = await ctx.trx
        .selectFrom('crove_projects.project_column')
        .select(['id', 'task_status'])
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', preview.id)
        .where('id', '=', input.columnId)
        .executeTakeFirst();
      if (!requestedColumn) {
        throw new DomainError('COLUMN_NOT_FOUND', 404, 'Không tìm thấy cột trên bảng dự án');
      }
      if (input.status !== undefined && input.status !== requestedColumn.task_status) {
        throw new DomainError('COLUMN_STATUS_MISMATCH', 400, 'Trạng thái không khớp với cột đã chọn');
      }
      effectiveStatus = requestedColumn.task_status;
    }

    const { taskId } = await ctx.run<{ taskId: string }>('kernel.task.create', {
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      assigneePositionId: input.assigneePositionId,
      ...(input.due !== undefined ? { due: input.due } : {}),
      ...(input.checklist !== undefined ? { checklist: input.checklist } : {}),
    });

    if (effectiveStatus !== 'todo') {
      await ctx.run('kernel.task.set_status', { id: taskId, status: effectiveStatus });
    }

    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(row);
    if (cycleId !== null) {
      const cycle = await loadCycle(ctx.trx, ctx.orgId, row.id, cycleId, false);
      if (cycle.status === 'completed') {
        throw new DomainError('CYCLE_COMPLETED', 409, 'Chu kỳ đã hoàn thành nên không thể chỉnh sửa hoặc gán việc');
      }
    }

    const columns = await loadProjectColumns(ctx.trx, ctx.orgId, row.id, false);
    let columnId: string | null = null;
    if (input.columnId !== undefined) {
      const matched = columns.find((c) => c.id === input.columnId);
      if (!matched) {
        throw new DomainError('COLUMN_NOT_FOUND', 404, 'Không tìm thấy cột trên bảng dự án');
      }
      if (matched.taskStatus !== effectiveStatus) {
        throw new DomainError('COLUMN_STATUS_MISMATCH', 400, 'Trạng thái không khớp với cột đã chọn');
      }
      columnId = matched.id;
    } else if (columns.length > 0) {
      columnId = resolveTaskColumnId(columns, null, effectiveStatus);
    }

    await ctx.trx
      .insertInto('crove_projects.project_task')
      .values({
        org_id: ctx.orgId,
        project_id: row.id,
        task_id: taskId,
        column_id: columnId,
        start_on: input.startOn ?? null,
        cycle_id: cycleId,
        story_points: input.storyPoints ?? null,
        added_by: userId,
        created_at: ctx.now,
      })
      .execute();

    ctx.audit({
      projectId: row.id,
      taskId,
      assigneePositionId: input.assigneePositionId,
      status: effectiveStatus,
      ...(columnId !== null ? { columnId } : {}),
      ...(cycleId !== null ? { cycleId } : {}),
      ...(input.storyPoints !== undefined ? { storyPoints: input.storyPoints } : {}),
    });
    await ctx.emit('projects.task.created', { projectId: row.id, taskId });
    await ctx.activity('projects.project', row.id, 'projects.task.created', 'Tạo việc mới trong dự án');
    return { projectId: row.id, taskId };
  },
});

export const projectList = defineQuery({
  name: 'projects.project.list',
  input: zProjectListInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectListResult> => {
    const userId = userOf(ctx.actor);
    const canWrite = ctx.role !== null && ctx.role !== 'viewer';
    if (input.status !== undefined && input.status.length === 0) {
      return { projects: [], canWrite, truncated: false };
    }

    let q = ctx.trx
      .selectFrom('crove_projects.project as p')
      .select([
        'p.id',
        'p.name',
        'p.description',
        'p.owner_user_id',
        'p.status',
        'p.visibility',
        'p.cycles_enabled',
        'p.cycle_duration_weeks',
        'p.points_enabled',
        'p.created_at',
        'p.updated_at',
      ])
      .where('p.org_id', '=', ctx.orgId)
      .where('p.is_template', '=', false);

    if (input.status !== undefined) {
      q = q.where('p.status', 'in', input.status);
    }

    const rows = await q
      .orderBy('p.updated_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(PROJECT_LIST_LIMIT + 1)
      .execute();

    const truncated = rows.length > PROJECT_LIST_LIMIT;
    const page = truncated ? rows.slice(0, PROJECT_LIST_LIMIT) : rows;
    if (page.length === 0) {
      return { projects: [], canWrite, truncated: false };
    }

    const projectIds = page.map((r) => r.id);
    const ownerIds = page.map((r) => r.owner_user_id).filter((id): id is string => id !== null);
    const profiles = await memberProfilesMap(ctx.trx, ownerIds);

    const { rows: memberCounts } = await sql<{ project_id: string; n: string }>`
      SELECT project_id, pg_catalog.count(*)::text AS n
        FROM crove_projects.project_member
       WHERE org_id = ${ctx.orgId}::uuid
         AND project_id = ANY(${projectIds}::uuid[])
       GROUP BY project_id`.execute(ctx.trx);
    const membersByProject = new Map(memberCounts.map((r) => [r.project_id, Number(r.n)]));

    // Join crove_kernel.task so open/done counts automatically follow le_scope RLS.
    const { rows: taskCounts } = await sql<{ project_id: string; open_n: string; done_n: string }>`
      SELECT pt.project_id,
             pg_catalog.count(*) FILTER (WHERE t.status IN ('todo', 'in_progress', 'waiting', 'in_review'))::text AS open_n,
             pg_catalog.count(*) FILTER (WHERE t.status = 'done')::text AS done_n
        FROM crove_projects.project_task pt
        JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
       WHERE pt.org_id = ${ctx.orgId}::uuid
         AND pt.project_id = ANY(${projectIds}::uuid[])
       GROUP BY pt.project_id`.execute(ctx.trx);
    const tasksByProject = new Map(taskCounts.map((r) => [r.project_id, { open: Number(r.open_n), done: Number(r.done_n) }]));

    const projects: ProjectSummary[] = page.map((r) => {
      const counts = tasksByProject.get(r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        ownerUserId: r.owner_user_id,
        ownerName: ownerDisplayName(profiles, r.owner_user_id),
        status: r.status as ProjectStatus,
        visibility: r.visibility as ProjectVisibility,
        cyclesEnabled: r.cycles_enabled,
        cycleDurationWeeks: r.cycle_duration_weeks,
        pointsEnabled: r.points_enabled,
        memberCount: membersByProject.get(r.id) ?? 0,
        openTaskCount: counts?.open ?? 0,
        doneTaskCount: counts?.done ?? 0,
        canManage: canManageProject(ctx.role, userId, r.owner_user_id),
        createdAt: new Date(r.created_at).toISOString(),
        updatedAt: new Date(r.updated_at).toISOString(),
      };
    });

    return { projects, canWrite, truncated };
  },
});

export const projectGet = defineQuery({
  name: 'projects.project.get',
  input: z.strictObject({ id: zId }),
  access: READERS,
  handler: async (ctx, input): Promise<ProjectDetail> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.id, false);
    const profiles = await memberProfilesMap(ctx.trx, row.owner_user_id ? [row.owner_user_id] : []);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerUserId: row.owner_user_id,
      ownerName: ownerDisplayName(profiles, row.owner_user_id),
      status: row.status,
      visibility: row.visibility,
      cyclesEnabled: row.cycles_enabled,
      cycleDurationWeeks: row.cycle_duration_weeks,
      pointsEnabled: row.points_enabled,
      canManage: canManageProject(ctx.role, userId, row.owner_user_id),
      canWrite: canWriteProject(ctx.role, row.status),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  },
});

export const projectBoard = defineQuery({
  name: 'projects.board',
  input: zProjectBoardInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectBoard> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);

    const orgMembers = await loadOrgMembers(ctx.trx, ctx.orgId);
    const isTeamOrg = orgMembers.length > 1;
    const memberIds = orgMembers.map((m) => m.userId);
    const profileIds = row.owner_user_id && !memberIds.includes(row.owner_user_id) ? [...memberIds, row.owner_user_id] : memberIds;

    const projectMemberRows = await ctx.trx
      .selectFrom('crove_projects.project_member')
      .select('user_id')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', row.id)
      .execute();
    const onProjectIds = new Set(projectMemberRows.map((m) => m.user_id));

    const { seats, profiles, positionRows } = await loadProjectSeatsAndProfiles(ctx.trx, ctx.orgId, row.id, onProjectIds, profileIds);

    const members: ProjectMemberView[] = orgMembers.map((m) => {
      const p = profiles.get(m.userId);
      return {
        userId: m.userId,
        role: m.role,
        displayName: p?.displayName ?? null,
        email: p?.email ?? null,
        onProject: onProjectIds.has(m.userId),
      };
    });

    const viewerHasSeat = positionRows.some((p) => p.status !== 'archived' && p.holder_user_id === userId);
    const hiddenByEntityCount = await countHiddenProjectTasks(ctx.trx, ctx.orgId, row.id);

    const project: ProjectDetail = {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerUserId: row.owner_user_id,
      ownerName: ownerDisplayName(profiles, row.owner_user_id),
      status: row.status,
      visibility: row.visibility,
      cyclesEnabled: row.cycles_enabled,
      cycleDurationWeeks: row.cycle_duration_weeks,
      pointsEnabled: row.points_enabled,
      canManage: canManageProject(ctx.role, userId, row.owner_user_id),
      canWrite: canWriteProject(ctx.role, row.status),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };

    const now = new Date();
    const filterExpr =
      input.filters !== undefined
        ? filterCondition('kernel.task', input.filters as FilterAst, taskFields({ isOwner: ctx.role === 'owner' }), {
            me: userId,
            today: vietnamToday(now),
            now,
          })
        : null;
    const hasStatusFilter =
      input.filters !== undefined && normalizeFilter('kernel.task', input.filters as FilterAst).all.some((c) => c.field === 'status');
    const orderTerms =
      input.sort !== undefined && input.sort !== null
        ? sortTerms('kernel.task', input.sort, taskSortColumns(), sql`t.id`, { field: 'created', dir: 'asc' })
        : null;

    const columns = await loadProjectColumns(ctx.trx, ctx.orgId, row.id, false);
    const activeCycle =
      row.cycles_enabled || input.cycleFilter?.mode === 'active'
        ? await loadActiveCycleView(ctx.trx, ctx.orgId, row.id)
        : null;

    if (input.status !== undefined && input.status.length === 0) {
      return {
        project,
        members,
        seats,
        isTeamOrg,
        viewerHasSeat,
        columns,
        tasks: [],
        activeCycle,
        totalVisible: 0,
        hiddenByEntityCount,
        truncated: false,
      };
    }

    let taskQuery = ctx.trx
      .selectFrom('crove_projects.project_task as pt')
      .innerJoin('crove_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
      .select([
        't.id',
        't.title',
        't.description',
        't.status',
        'pt.column_id',
        't.assignee_position_id',
        'pt.start_on',
        't.due',
        't.checklist',
        't.tainted',
        't.created_at',
        'pt.created_at as added_at',
        'pt.cycle_id',
        'pt.story_points',
        'pt.recurrence',
        'pt.recurrence_count',
        'pt.recurrence_last_due',
        'pt.recurrence_next_at',
        'pt.recurrence_source_task_id',
        sql<boolean>`(t.checkout_run_id IS NOT NULL AND t.lock_expires_at > pg_catalog.now())`.as('checked_out'),
      ])
      .where('pt.org_id', '=', ctx.orgId)
      .where('pt.project_id', '=', row.id);

    let countQuery = ctx.trx
      .selectFrom('crove_projects.project_task as pt')
      .innerJoin('crove_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('pt.org_id', '=', ctx.orgId)
      .where('pt.project_id', '=', row.id);

    if (input.cycleFilter) {
      switch (input.cycleFilter.mode) {
        case 'backlog':
          taskQuery = taskQuery.where('pt.cycle_id', 'is', null);
          countQuery = countQuery.where('pt.cycle_id', 'is', null);
          break;
        case 'active':
          if (activeCycle) {
            taskQuery = taskQuery.where('pt.cycle_id', '=', activeCycle.id);
            countQuery = countQuery.where('pt.cycle_id', '=', activeCycle.id);
          } else {
            taskQuery = taskQuery.where(sql<boolean>`false`);
            countQuery = countQuery.where(sql<boolean>`false`);
          }
          break;
        case 'upcoming': {
          const upcomingClause = sql<boolean>`EXISTS (
            SELECT 1 FROM crove_projects.project_cycle pc
             WHERE pc.org_id = pt.org_id
               AND pc.project_id = pt.project_id
               AND pc.id = pt.cycle_id
               AND pc.status = 'upcoming'
          )`;
          taskQuery = taskQuery.where(upcomingClause);
          countQuery = countQuery.where(upcomingClause);
          break;
        }
        case 'cycle':
          taskQuery = taskQuery.where('pt.cycle_id', '=', input.cycleFilter.cycleId);
          countQuery = countQuery.where('pt.cycle_id', '=', input.cycleFilter.cycleId);
          break;
        case 'all':
          break;
      }
    }

    if (input.positionId === 'root') {
      taskQuery = taskQuery.where('t.assignee_position_id', 'is', null);
      countQuery = countQuery.where('t.assignee_position_id', 'is', null);
    } else if (input.positionId !== undefined) {
      taskQuery = taskQuery.where('t.assignee_position_id', '=', input.positionId);
      countQuery = countQuery.where('t.assignee_position_id', '=', input.positionId);
    }

    if (input.status !== undefined) {
      taskQuery = taskQuery.where('t.status', 'in', input.status);
      countQuery = countQuery.where('t.status', 'in', input.status);
    } else if (!input.includeCancelled && !hasStatusFilter) {
      taskQuery = taskQuery.where('t.status', '<>', 'cancelled');
      countQuery = countQuery.where('t.status', '<>', 'cancelled');
    }

    if (filterExpr) {
      taskQuery = taskQuery.where(filterExpr);
      countQuery = countQuery.where(filterExpr);
    }

    if (orderTerms) {
      for (const term of orderTerms) taskQuery = taskQuery.orderBy(term);
    } else {
      taskQuery = taskQuery
        .orderBy(sql`pt.sort_key ASC NULLS LAST`)
        .orderBy(sql`t.due ASC NULLS LAST`)
        .orderBy('t.created_at', 'asc')
        .orderBy('t.id', 'asc');
    }

    const rawTasks = await taskQuery.limit(PROJECT_BOARD_LIMIT + 1).execute();

    const truncated = rawTasks.length > PROJECT_BOARD_LIMIT;
    const page = truncated ? rawTasks.slice(0, PROJECT_BOARD_LIMIT) : rawTasks;
    const totalVisible = truncated ? Number((await countQuery.executeTakeFirstOrThrow()).n) : page.length;

    const taskIds = page.map((t) => t.id);
    const { commentCounts, openBlockerCounts, blockingCounts } = await loadProjectTaskCounts(ctx.trx, ctx.orgId, row.id, taskIds);

    const tasks: ProjectTaskCard[] = page.map((t) => {
      const status = t.status as TaskStatus;
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        status,
        columnId: resolveTaskColumnId(columns, t.column_id, status),
        assigneePositionId: t.assignee_position_id,
        startOn: t.start_on,
        due: t.due === null ? null : new Date(t.due).toISOString(),
        checklist: parseTaskChecklist(t.checklist),
        tainted: t.tainted,
        checkedOut: Boolean(t.checked_out),
        commentCount: commentCounts.get(t.id) ?? 0,
        createdAt: new Date(t.created_at).toISOString(),
        addedAt: new Date(t.added_at).toISOString(),
        cycleId: t.cycle_id,
        storyPoints: t.story_points,
        recurrence: parseStoredRecurrence(t.recurrence),
        recurrenceCount: t.recurrence_count,
        recurrenceLastDue: t.recurrence_last_due,
        recurrenceNextAt: t.recurrence_next_at === null ? null : new Date(t.recurrence_next_at).toISOString(),
        recurrenceSourceTaskId: t.recurrence_source_task_id,
        openBlockerCount: openBlockerCounts.get(t.id) ?? 0,
        blockingCount: blockingCounts.get(t.id) ?? 0,
      };
    });

    return {
      project,
      members,
      seats,
      isTeamOrg,
      viewerHasSeat,
      columns,
      tasks,
      activeCycle,
      totalVisible,
      hiddenByEntityCount,
      truncated,
    };
  },
});

export const projectUnassignedTasks = defineQuery({
  name: 'projects.unassigned_tasks',
  input: z.strictObject({}),
  access: READERS,
  handler: async (ctx): Promise<ProjectCandidateTask[]> => {
    userOf(ctx.actor);
    const { rows } = await sql<{
      id: string;
      title: string;
      tainted: boolean;
      status: string;
      assignee_position_id: string | null;
      due: Date | string | null;
      created_at: Date | string;
    }>`
      SELECT t.id, t.title, t.tainted, t.status, t.assignee_position_id, t.due, t.created_at
        FROM crove_kernel.task t
       WHERE t.org_id = ${ctx.orgId}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM crove_projects.project_task pt
            WHERE pt.org_id = t.org_id AND pt.task_id = t.id
         )
       ORDER BY CASE WHEN t.status IN ('done', 'cancelled') THEN 1 ELSE 0 END ASC,
                t.due ASC NULLS LAST,
                t.created_at DESC,
                t.id DESC
       LIMIT ${PROJECT_UNASSIGNED_LIMIT}`.execute(ctx.trx);

    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      tainted: t.tainted,
      status: t.status as TaskStatus,
      assigneePositionId: t.assignee_position_id,
      due: t.due === null ? null : new Date(t.due).toISOString(),
      createdAt: new Date(t.created_at).toISOString(),
    }));
  },
});

export const projectTaskProjects = defineQuery({
  name: 'projects.task_projects',
  input: zProjectTaskProjectsInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectTaskProjectEntry[]> => {
    userOf(ctx.actor);
    const taskIds = [...new Set(input.taskIds)];
    if (taskIds.length === 0) return [];
    // Join crove_kernel.task so le_scope RLS filters out tasks outside the caller's legal entities.
    const { rows } = await sql<{ task_id: string; project_id: string; project_name: string }>`
      SELECT pt.task_id, p.id AS project_id, p.name AS project_name
        FROM crove_projects.project_task pt
        JOIN crove_projects.project p
          ON p.org_id = pt.org_id AND p.id = pt.project_id
        JOIN crove_kernel.task t
          ON t.org_id = pt.org_id AND t.id = pt.task_id
       WHERE pt.org_id = ${ctx.orgId}::uuid
         AND NOT p.is_template
         AND pt.task_id = ANY(${taskIds}::uuid[])`.execute(ctx.trx);

    return rows.map((r) => ({
      taskId: r.task_id,
      project: { id: r.project_id, name: r.project_name },
    }));
  },
});

export const projectsCommands = [
  projectCreate,
  projectUpdate,
  projectSetStatus,
  projectArchive,
  projectSetOwner,
  projectMemberAdd,
  projectMemberRemove,
  projectTaskAdd,
  projectTaskRemove,
  projectTaskReorder,
  projectTaskCreate,
  tasksFromNoteStart,
  tasksFromNoteConfirm,
];

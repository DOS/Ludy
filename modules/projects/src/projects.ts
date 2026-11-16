// SPDX-License-Identifier: AGPL-3.0-only
// Projects and a task board over kernel tasks (issue #2591, docs/plan/projects.md, ADR-0048).
import { sql } from 'kysely';
import { z } from 'zod';
import {
  PROJECT_BOARD_LIMIT,
  PROJECT_LIST_LIMIT,
  PROJECT_UNASSIGNED_LIMIT,
  auditValue,
  tableWrite,
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
  zProjectUpdate,
  type ProjectBoard,
  type ProjectCandidateTask,
  type ProjectDetail,
  type ProjectListResult,
  type ProjectMemberView,
  type ProjectSeat,
  type ProjectSeatHolder,
  type ProjectStatus,
  type ProjectSummary,
  type ProjectTaskCard,
  type ProjectTaskProjectEntry,
} from '@crove/kernel-contract';
import type { MemberRole } from '@crove/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@crove/kernel-runtime';
import { projectsManifest } from './manifest.ts';
import { tasksFromNoteConfirm, tasksFromNoteStart } from './tasks-from-note.ts';

export const READERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];

const TABLES = projectsManifest.tables;
const PROJECT = TABLES.crove_projects.project;

type Trx = QueryContext['trx'];
type TaskStatus = ProjectTaskCard['status'];
type SeatStatus = ProjectSeat['status'];

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  owner_user_id: string | null;
  status: ProjectStatus;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface MemberProfile {
  displayName: string | null;
  email: string | null;
}

export function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên mới thực hiện được việc này');
  }
  return actor.userId;
}

const projectNotFound = () => new DomainError('PROJECT_NOT_FOUND', 404, 'Không tìm thấy dự án này');
const taskNotFound = () => new DomainError('TASK_NOT_FOUND', 404, 'Không tìm thấy việc hoặc bạn không có quyền xem đơn vị của việc này');

function descriptionOf(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function canManageProject(role: MemberRole | null, userId: string, ownerUserId: string | null): boolean {
  if (role === 'owner' || role === 'admin') return true;
  if (role !== null && role !== 'viewer' && ownerUserId !== null && ownerUserId === userId) return true;
  return false;
}

function canWriteProject(role: MemberRole | null, status: ProjectStatus): boolean {
  return role !== null && role !== 'viewer' && status !== 'archived';
}

function assertCanManage(ctx: CommandContext, row: ProjectRow, userId: string): void {
  if (!canManageProject(ctx.role, userId, row.owner_user_id)) {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ người phụ trách dự án, quản trị viên hoặc chủ sở hữu mới thực hiện được việc này');
  }
}

function assertNotArchived(row: ProjectRow): void {
  if (row.status === 'archived') {
    throw new DomainError('PROJECT_ARCHIVED', 409, 'Dự án đã lưu trữ nên không thể chỉnh sửa');
  }
}

export async function loadProject(trx: Trx, orgId: string, projectId: string, lock: boolean): Promise<ProjectRow> {
  let q = trx
    .selectFrom('crove_projects.project')
    .select(['id', 'name', 'description', 'owner_user_id', 'status', 'created_by', 'created_at', 'updated_at'])
    .where('org_id', '=', orgId)
    .where('id', '=', projectId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw projectNotFound();
  return { ...row, status: row.status as ProjectStatus };
}

async function memberProfilesMap(trx: Trx, userIds: readonly string[]): Promise<Map<string, MemberProfile>> {
  const unique = [...new Set(userIds)];
  const map = new Map<string, MemberProfile>();
  if (unique.length === 0) return map;
  const { rows } = await sql<{ user_id: string; email: string; display_name: string | null }>`
    SELECT user_id, email, display_name
      FROM crove_kernel.member_profiles(${unique}::uuid[])`.execute(trx);
  for (const r of rows) {
    map.set(r.user_id, { displayName: r.display_name, email: r.email });
  }
  return map;
}

async function loadOrgMembers(trx: Trx, orgId: string): Promise<Array<{ userId: string; role: MemberRole }>> {
  const rows = await trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', orgId)
    .orderBy('created_at', 'asc')
    .orderBy('user_id', 'asc')
    .execute();
  return rows.map((r) => ({ userId: r.user_id, role: r.role as MemberRole }));
}

async function assertOrgMembers(trx: Trx, orgId: string, userIds: readonly string[]): Promise<Map<string, MemberRole>> {
  const unique = [...new Set(userIds)];
  const map = new Map<string, MemberRole>();
  if (unique.length === 0) return map;
  const rows = await trx
    .selectFrom('crove_kernel.tenant_member')
    .select(['user_id', 'role'])
    .where('org_id', '=', orgId)
    .where('user_id', 'in', unique)
    .execute();
  for (const r of rows) {
    map.set(r.user_id, r.role as MemberRole);
  }
  for (const id of unique) {
    if (!map.has(id)) {
      throw new DomainError('PROJECT_MEMBER_NOT_FOUND', 404, 'Thành viên không thuộc tổ chức này');
    }
  }
  return map;
}

function ownerDisplayName(profiles: ReadonlyMap<string, MemberProfile>, ownerUserId: string | null): string | null {
  if (ownerUserId === null) return null;
  const profile = profiles.get(ownerUserId);
  if (!profile) return null;
  return profile.displayName ?? profile.email ?? null;
}

const projectTarget = (input: { projectId: string }) => ({ type: 'projects.project', id: input.projectId });

export const projectCreate = defineCommand({
  name: 'projects.project.create',
  input: zProjectCreate,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project', ['org_id', 'name', 'description', 'owner_user_id', 'status', 'created_by', 'created_at', 'updated_at']),
    tableWrite(TABLES, 'crove_projects', 'project_member', ['org_id', 'project_id', 'user_id', 'created_at']),
  ],
  handler: async (ctx, input): Promise<{ projectId: string }> => {
    const userId = userOf(ctx.actor);
    const ownerUserId = input.ownerUserId ?? userId;
    const memberIds = input.memberUserIds !== undefined ? [...new Set(input.memberUserIds)] : [...new Set([ownerUserId, userId])];
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
  writes: [tableWrite(TABLES, 'crove_projects', 'project', ['name', 'description', 'updated_at'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string }> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, row, userId);
    assertNotArchived(row);

    const nextName = input.name ?? row.name;
    const nextDescription = input.description !== undefined ? descriptionOf(input.description) : row.description;
    const changed = [
      ...(nextName !== row.name ? ['name'] : []),
      ...(nextDescription !== row.description ? ['description'] : []),
    ];

    if (changed.length > 0) {
      await ctx.trx
        .updateTable('crove_projects.project')
        .set({
          name: nextName,
          description: nextDescription,
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
  writes: [tableWrite(TABLES, 'crove_projects', 'project', ['owner_user_id', 'updated_at'])],
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
  writes: [tableWrite(TABLES, 'crove_projects', 'project_member', ['org_id', 'project_id', 'user_id'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<{ projectId: string; userId: string; removed: boolean }> => {
    const userId = userOf(ctx.actor);
    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, row, userId);
    assertNotArchived(row);

    const deleted = await ctx.trx
      .deleteFrom('crove_projects.project_member')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', row.id)
      .where('user_id', '=', input.userId)
      .returning('id')
      .executeTakeFirst();

    const removed = deleted !== undefined;
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
  writes: [tableWrite(TABLES, 'crove_projects', 'project_task', ['org_id', 'project_id', 'task_id'])],
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
    // Check existence/status without a row lock before calling kernel.task.create (which locks crove_kernel.position),
    // then lock crove_projects.project afterwards so concurrent task/project writes share the position -> project lock order.
    const preview = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    assertNotArchived(preview);

    const { taskId } = await ctx.run<{ taskId: string }>('kernel.task.create', {
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      assigneePositionId: input.assigneePositionId,
      ...(input.due !== undefined ? { due: input.due } : {}),
    });

    if (input.status !== undefined && input.status !== 'todo') {
      await ctx.run('kernel.task.set_status', { id: taskId, status: input.status });
    }

    const row = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(row);

    await ctx.trx
      .insertInto('crove_projects.project_task')
      .values({
        org_id: ctx.orgId,
        project_id: row.id,
        task_id: taskId,
        added_by: userId,
        created_at: ctx.now,
      })
      .execute();

    ctx.audit({
      projectId: row.id,
      taskId,
      assigneePositionId: input.assigneePositionId,
      status: input.status ?? 'todo',
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
      .select(['p.id', 'p.name', 'p.description', 'p.owner_user_id', 'p.status', 'p.created_at', 'p.updated_at'])
      .where('p.org_id', '=', ctx.orgId);

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

    const { rows: usedPositionRows } = await sql<{ id: string }>`
      SELECT DISTINCT t.assignee_position_id AS id
        FROM crove_projects.project_task pt
        JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
       WHERE pt.org_id = ${ctx.orgId}::uuid
         AND pt.project_id = ${row.id}::uuid
         AND t.assignee_position_id IS NOT NULL`.execute(ctx.trx);
    const usedPositionIds = usedPositionRows.map((p) => p.id);

    const positionRows = await ctx.trx
      .selectFrom('crove_kernel.position')
      .select(['id', 'title', 'status', 'holder_user_id', 'holder_agent_id'])
      .where('org_id', '=', ctx.orgId)
      .where((eb) =>
        usedPositionIds.length > 0 ? eb.or([eb('status', '<>', 'archived'), eb('id', 'in', usedPositionIds)]) : eb('status', '<>', 'archived'),
      )
      .orderBy('title', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const agentIds = positionRows.map((p) => p.holder_agent_id).filter((id): id is string => id !== null);
    const positionUserIds = positionRows.map((p) => p.holder_user_id).filter((id): id is string => id !== null);
    const allProfileIds = [...new Set([...profileIds, ...positionUserIds])];
    const profiles = await memberProfilesMap(ctx.trx, allProfileIds);

    const agentNames = new Map<string, string>();
    if (agentIds.length > 0) {
      const agents = await ctx.trx
        .selectFrom('crove_kernel.agent')
        .select(['id', 'display_name'])
        .where('org_id', '=', ctx.orgId)
        .where('id', 'in', agentIds)
        .execute();
      for (const a of agents) agentNames.set(a.id, a.display_name);
    }

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
    const seats: ProjectSeat[] = positionRows.map((p) => {
      let holder: ProjectSeatHolder | null = null;
      if (p.holder_user_id !== null) {
        const prof = profiles.get(p.holder_user_id);
        holder = {
          type: 'user',
          userId: p.holder_user_id,
          displayName: prof?.displayName ?? null,
          email: prof?.email ?? null,
        };
      } else if (p.holder_agent_id !== null) {
        holder = {
          type: 'agent',
          agentId: p.holder_agent_id,
          name: agentNames.get(p.holder_agent_id) ?? null,
        };
      }
      return {
        id: p.id,
        title: p.title,
        status: p.status as SeatStatus,
        onProject: p.holder_user_id !== null && onProjectIds.has(p.holder_user_id),
        holder,
      };
    });

    // Compare project_task against le_scope-filtered crove_kernel.task without SECURITY DEFINER.
    const { rows: hiddenRows } = await sql<{ count: string }>`
      SELECT pg_catalog.count(*)::text AS count
        FROM crove_projects.project_task pt
       WHERE pt.org_id = ${ctx.orgId}::uuid
         AND pt.project_id = ${row.id}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM crove_kernel.task t
            WHERE t.org_id = pt.org_id AND t.id = pt.task_id
         )`.execute(ctx.trx);
    const hiddenByEntityCount = Number(hiddenRows[0]?.count ?? 0);

    const project: ProjectDetail = {
      id: row.id,
      name: row.name,
      description: row.description,
      ownerUserId: row.owner_user_id,
      ownerName: ownerDisplayName(profiles, row.owner_user_id),
      status: row.status,
      canManage: canManageProject(ctx.role, userId, row.owner_user_id),
      canWrite: canWriteProject(ctx.role, row.status),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };

    if (input.status !== undefined && input.status.length === 0) {
      return { project, members, seats, isTeamOrg, viewerHasSeat, tasks: [], totalVisible: 0, hiddenByEntityCount, truncated: false };
    }

    let taskQuery = ctx.trx
      .selectFrom('crove_projects.project_task as pt')
      .innerJoin('crove_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
      .select([
        't.id',
        't.title',
        't.description',
        't.status',
        't.assignee_position_id',
        't.due',
        't.tainted',
        't.created_at',
        'pt.created_at as added_at',
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
    } else if (!input.includeCancelled) {
      taskQuery = taskQuery.where('t.status', '<>', 'cancelled');
      countQuery = countQuery.where('t.status', '<>', 'cancelled');
    }

    const rawTasks = await taskQuery
      .orderBy(sql`t.due ASC NULLS LAST`)
      .orderBy('t.created_at', 'asc')
      .orderBy('t.id', 'asc')
      .limit(PROJECT_BOARD_LIMIT + 1)
      .execute();

    const truncated = rawTasks.length > PROJECT_BOARD_LIMIT;
    const page = truncated ? rawTasks.slice(0, PROJECT_BOARD_LIMIT) : rawTasks;
    const totalVisible = truncated ? Number((await countQuery.executeTakeFirstOrThrow()).n) : page.length;

    const commentCounts = new Map<string, number>();
    if (page.length > 0) {
      const taskIds = page.map((t) => t.id);
      const { rows: counts } = await sql<{ task_id: string; n: string }>`
        SELECT task_id, pg_catalog.count(*)::text AS n
          FROM crove_kernel.task_comment
         WHERE org_id = ${ctx.orgId}::uuid
           AND task_id = ANY(${taskIds}::uuid[])
         GROUP BY task_id`.execute(ctx.trx);
      for (const c of counts) commentCounts.set(c.task_id, Number(c.n));
    }

    const tasks: ProjectTaskCard[] = page.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status as TaskStatus,
      assigneePositionId: t.assignee_position_id,
      due: t.due === null ? null : new Date(t.due).toISOString(),
      tainted: t.tainted,
      checkedOut: Boolean(t.checked_out),
      commentCount: commentCounts.get(t.id) ?? 0,
      createdAt: new Date(t.created_at).toISOString(),
      addedAt: new Date(t.added_at).toISOString(),
    }));

    return {
      project,
      members,
      seats,
      isTeamOrg,
      viewerHasSeat,
      tasks,
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
      status: string;
      assignee_position_id: string | null;
      due: Date | string | null;
      created_at: Date | string;
    }>`
      SELECT t.id, t.title, t.status, t.assignee_position_id, t.due, t.created_at
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
  projectTaskCreate,
  tasksFromNoteStart,
  tasksFromNoteConfirm,
];

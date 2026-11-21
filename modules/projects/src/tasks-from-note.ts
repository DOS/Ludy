// SPDX-License-Identifier: AGPL-3.0-only
// Server commands and queries for Vy proposing project tasks from a note (#2598, ADR-0048, ADR-0049).
// Note text is queried via notes.note.get (caller-scoped RLS), never logged or audited in clear text.
// Confirmed batches run in one transaction through kernel.task.create_from_note (always tainted: true).
import { sql } from 'kysely';
import { z } from 'zod';
import {
  DEFAULT_TIME_ZONE,
  todoDueInstant,
  zId,
  zProjectProposedTask,
  zProjectTasksFromNoteConfirmInput,
  type Note,
  type ProjectSeat,
  type ProjectStatus,
  type ProjectTasksFromNoteConfirmResult,
  type ProjectTasksFromNoteStatus,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';

export const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const ALL_MEMBERS: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];
const MODULE = 'projects';

export function userOf(actor: QueryContext['actor']): string {
  if (actor.type !== 'user') throw new DomainError('FORBIDDEN', 403, 'Chỉ thành viên mới thực hiện được việc này');
  return actor.userId;
}

export interface ProjectRow {
  id: string;
  name: string;
  status: ProjectStatus;
}

export async function loadProject(trx: QueryContext['trx'], orgId: string, projectId: string, lock: boolean): Promise<ProjectRow> {
  let query = trx
    .selectFrom('crove_projects.project')
    .select(['id', 'name', 'status'])
    .where('org_id', '=', orgId)
    .where('id', '=', projectId)
    .where('is_template', '=', false);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw new DomainError('PROJECT_NOT_FOUND', 404, 'Không tìm thấy dự án này');
  return { id: row.id, name: row.name, status: row.status as ProjectStatus };
}

export function assertNotArchived(row: ProjectRow): void {
  if (row.status === 'archived') {
    throw new DomainError('PROJECT_ARCHIVED', 409, 'Dự án này đã được lưu trữ, không thể thêm việc mới');
  }
}

async function activeProjectMemberSeatIds(trx: QueryContext['trx'], orgId: string, projectId: string): Promise<string[]> {
  const members = await trx
    .selectFrom('crove_projects.project_member')
    .select('user_id')
    .where('org_id', '=', orgId)
    .where('project_id', '=', projectId)
    .execute();
  const memberIds = members.map((m) => m.user_id);
  if (memberIds.length === 0) return [];

  const positions = await trx
    .selectFrom('crove_kernel.position')
    .select('id')
    .where('org_id', '=', orgId)
    .where('status', '=', 'active')
    .where('holder_user_id', 'in', memberIds)
    .orderBy('title', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return positions.map((p) => p.id);
}

export async function assertSeatsAllowed(
  trx: QueryContext['trx'],
  orgId: string,
  projectId: string,
  requestedSeats: readonly string[],
): Promise<void> {
  if (requestedSeats.length === 0) return;
  const allowedSeatSet = new Set(await activeProjectMemberSeatIds(trx, orgId, projectId));
  for (const seatId of requestedSeats) {
    if (!allowedSeatSet.has(seatId)) {
      throw new DomainError(
        'VALIDATION',
        422,
        'Người được giao phải là thành viên đang giữ vị trí hoạt động trong dự án này',
      );
    }
  }
}

export async function loadReadableNote(ctx: QueryContext, noteId: string): Promise<Note> {
  if (!ctx.installed('notes')) {
    throw new DomainError('MODULE_OFF', 404, 'Ứng dụng notes chưa được bật cho công ty này', { module: 'notes' });
  }
  const answer = await ctx.query<Note>('notes.note.get', { noteId });
  if (answer.status === 'not_installed') {
    throw new DomainError('MODULE_OFF', 404, 'Ứng dụng notes chưa được bật cho công ty này', { module: 'notes' });
  }
  if (answer.value.deletedAt !== null) {
    throw new DomainError('NOTE_IN_TRASH', 409, 'Ghi chú đang ở thùng rác; hãy khôi phục trước');
  }
  return answer.value;
}

async function memberProfilesMap(trx: QueryContext['trx'], userIds: readonly string[]): Promise<Map<string, { displayName: string | null; email: string }>> {
  const unique = [...new Set(userIds)];
  const map = new Map<string, { displayName: string | null; email: string }>();
  if (unique.length === 0) return map;
  const { rows } = await sql<{ user_id: string; email: string; display_name: string | null }>`
    SELECT user_id, email, display_name
      FROM crove_kernel.member_profiles(${unique}::uuid[])`.execute(trx);
  for (const r of rows) {
    map.set(r.user_id, { displayName: r.display_name, email: r.email });
  }
  return map;
}

// Shared availability check for asking Vy to propose project tasks: checks viewer/member role, optional notes app,
// vy.use, org/module/agent/global kill switches, and projects AI budget.
export async function checkProjectsVyAccess(
  ctx: QueryContext,
  options: { requireNotes: boolean },
): Promise<ProjectTasksFromNoteStatus> {
  const userId = userOf(ctx.actor);
  if (ctx.role === null || ctx.role === 'viewer') {
    return { available: false, reason: 'forbidden', resetOn: null };
  }
  if (options.requireNotes) {
    if (!ctx.installed('notes')) {
      return { available: false, reason: 'off', resetOn: null };
    }
    try {
      const check = await ctx.query('notes.note.list', { view: 'mine', limit: 1 });
      if (check.status === 'not_installed') {
        return { available: false, reason: 'off', resetOn: null };
      }
    } catch (error) {
      if (error instanceof DomainError && error.code === 'MODULE_OFF') {
        return { available: false, reason: 'off', resetOn: null };
      }
      throw error;
    }
  }

  const allowed = await sql<{ ok: boolean }>`SELECT crove_kernel.ctx_vy_use() AS ok`.execute(ctx.trx);
  if (allowed.rows[0]?.ok !== true) {
    return { available: false, reason: 'forbidden', resetOn: null };
  }

  const agentRow = await ctx.trx
    .selectFrom('crove_kernel.agent')
    .select(['id', 'status'])
    .where('org_id', '=', ctx.orgId)
    .where('kind', '=', 'member_vy')
    .where('member_user_id', '=', userId)
    .executeTakeFirst();
  if (agentRow && agentRow.status !== 'active') {
    return { available: false, reason: 'forbidden', resetOn: null };
  }
  const agentId = agentRow?.id ?? null;

  const stopped = await sql<{ stopped: boolean }>`
    SELECT crove_kernel.global_kill_switch_on('ai') OR EXISTS (
      SELECT 1 FROM crove_kernel.kill_switch k
       WHERE k.org_id = ${ctx.orgId}::uuid
         AND k.released_at IS NULL
         AND (
           k.scope = 'org'
           OR (k.scope = 'module' AND k.target = ${MODULE})
           OR (${agentId}::uuid IS NOT NULL AND k.scope = 'agent' AND k.target = ${agentId}::text)
         )
    ) AS stopped`.execute(ctx.trx);
  if (stopped.rows[0]?.stopped === true) {
    return { available: false, reason: 'paused', resetOn: null };
  }

  const budget = await sql<{ spent: boolean; reset_on: string }>`
    SELECT crove_kernel.ai_budget_exhausted(${ctx.orgId}::uuid, ${MODULE}, ${agentId}::uuid) AS spent,
           pg_catalog.to_char(
             (pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE ${DEFAULT_TIME_ZONE}) + pg_catalog.make_interval(months => 1))::date,
             'YYYY-MM-DD'
           ) AS reset_on`
    .execute(ctx.trx);
  if (budget.rows[0]?.spent === true) {
    return { available: false, reason: 'budget', resetOn: budget.rows[0].reset_on ?? null };
  }

  return { available: true, reason: null, resetOn: null };
}

export async function queryProjectSeats(
  ctx: QueryContext,
  projectId: string,
): Promise<{ projectId: string; projectName: string; seats: ProjectSeat[] }> {
  userOf(ctx.actor);
  const project = await loadProject(ctx.trx, ctx.orgId, projectId, false);
  assertNotArchived(project);

  const members = await ctx.trx
    .selectFrom('crove_projects.project_member')
    .select('user_id')
    .where('org_id', '=', ctx.orgId)
    .where('project_id', '=', project.id)
    .execute();
  const memberIds = members.map((m) => m.user_id);
  if (memberIds.length === 0) {
    return { projectId: project.id, projectName: project.name, seats: [] };
  }

  const positions = await ctx.trx
    .selectFrom('crove_kernel.position')
    .select(['id', 'title', 'status', 'holder_user_id'])
    .where('org_id', '=', ctx.orgId)
    .where('status', '=', 'active')
    .where('holder_user_id', 'in', memberIds)
    .orderBy('title', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const holderIds = positions.map((p) => p.holder_user_id).filter((id): id is string => id !== null);
  const profiles = await memberProfilesMap(ctx.trx, holderIds);

  const seats: ProjectSeat[] = positions.map((p) => {
    const uid = p.holder_user_id!;
    const prof = profiles.get(uid);
    return {
      id: p.id,
      title: p.title,
      status: 'active',
      onProject: true,
      holder: {
        type: 'user',
        userId: uid,
        displayName: prof?.displayName ?? null,
        email: prof?.email ?? null,
      },
    };
  });

  return { projectId: project.id, projectName: project.name, seats };
}

export type ProposedTaskConfirmItem = z.infer<typeof zProjectProposedTask>;

// Runs the shared atomic batch confirmation sequence: locks referenced positions in canonical UUID order,
// invokes createTask per item, locks crove_projects.project (uniform lock ordering), re-validates seats,
// attaches tasks to crove_projects.project_task, emits events and records activity.
export async function createAndAttachConfirmedTasks(
  ctx: CommandContext,
  userId: string,
  params: {
    projectId: string;
    timeZone: string;
    items: readonly ProposedTaskConfirmItem[];
    via: string;
    activityAction: string;
    activitySummary: (count: number) => string;
    createTask: (item: ProposedTaskConfirmItem, due: string | null) => Promise<{ taskId: string }>;
  },
): Promise<{ project: ProjectRow; createdIds: string[] }> {
  const requestedSeats = [...new Set(params.items.map((item) => item.assigneePositionId).filter((id): id is string => id !== null))].sort();
  if (requestedSeats.length > 0) {
    // Lock all referenced positions in canonical UUID order before looping task creation to prevent deadlocks.
    await sql<{ id: string }>`
      SELECT id
        FROM crove_kernel.position
       WHERE org_id = ${ctx.orgId}::uuid
         AND id = ANY(${requestedSeats}::uuid[])
       ORDER BY id ASC
         FOR UPDATE`.execute(ctx.trx);

    await assertSeatsAllowed(ctx.trx, ctx.orgId, params.projectId, requestedSeats);
  }

  const createdIds: string[] = [];
  for (const item of params.items) {
    let due: string | null = null;
    if (item.dueOn !== null) {
      const dueDate = todoDueInstant(item.dueOn, '23:59', params.timeZone);
      if (Number.isNaN(dueDate.getTime())) {
        throw new DomainError('VALIDATION', 422, 'Ngày đến hạn không hợp lệ');
      }
      due = dueDate.toISOString();
    }
    const created = await params.createTask(item, due);
    createdIds.push(created.taskId);
  }

  // Lock crove_projects.project after kernel task creation (which locks crove_kernel.position) for uniform lock ordering,
  // then re-validate seats under the project lock so concurrent projects.member.remove cannot leave a removed member assigned.
  const project = await loadProject(ctx.trx, ctx.orgId, params.projectId, true);
  assertNotArchived(project);
  await assertSeatsAllowed(ctx.trx, ctx.orgId, project.id, requestedSeats);

  if (createdIds.length > 0) {
    await ctx.trx
      .insertInto('crove_projects.project_task')
      .values(
        createdIds.map((taskId) => ({
          org_id: ctx.orgId,
          project_id: project.id,
          task_id: taskId,
          added_by: userId,
          created_at: ctx.now,
        })),
      )
      .execute();

    for (const taskId of createdIds) {
      await ctx.emit('projects.task.created', { projectId: project.id, taskId, via: params.via });
    }
    await ctx.activity('projects.project', project.id, params.activityAction, params.activitySummary(createdIds.length));
  }

  return { project, createdIds };
}

// Pure availability check for asking Vy to propose project tasks from a note: checks notes app availability,
// viewer/member role, vy.use, org/module/agent/global kill switches, and projects AI budget.
export const tasksFromNoteStatus = defineQuery({
  name: 'projects.tasks_from_note.status',
  input: z.strictObject({}),
  access: ALL_MEMBERS,
  handler: (ctx): Promise<ProjectTasksFromNoteStatus> => checkProjectsVyAccess(ctx, { requireNotes: true }),
});

// Active seats held exclusively by users who belong to the target project (crove_projects.project_member).
export const tasksFromNoteSeats = defineQuery({
  name: 'projects.tasks_from_note.seats',
  input: z.strictObject({ projectId: zId }),
  access: WRITERS,
  handler: (ctx, input): Promise<{ projectId: string; projectName: string; seats: ProjectSeat[] }> =>
    queryProjectSeats(ctx, input.projectId),
});

// Validates note readability + target project and starts one member-scoped Vy run under kernel.member_vy.run.start.
// Audit targets the note only and masks `projectId` when the note is private (ADR-0037 §3: never expose which
// project or record a private note refers to before explicit confirmation).
export const tasksFromNoteStart = defineCommand({
  name: 'projects.tasks_from_note.start',
  input: z.strictObject({ noteId: zId, projectId: zId }),
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'notes.note', id: input.noteId }),
  handler: async (ctx, input): Promise<{ runId: string; noteRevision: number; noteCanLink: boolean }> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    assertNotArchived(project);
    const note = await loadReadableNote(ctx, input.noteId);
    if (`${note.title}\n${note.body}`.trim().length === 0) {
      throw new DomainError('NOTE_EMPTY', 422, 'Ghi chú chưa có nội dung để đề xuất việc');
    }

    const started = await ctx.run<{ runId: string; agentId: string }>('kernel.member_vy.run.start', {
      feature: 'projects.tasks_from_note',
      subjectType: 'note',
      subjectId: input.noteId,
    });
    ctx.audit(
      note.visibility === 'org'
        ? { projectId: project.id, noteId: input.noteId, runId: started.runId }
        : { noteId: input.noteId, target: 'private' as const, runId: started.runId },
    );
    return {
      runId: started.runId,
      noteRevision: note.revision,
      noteCanLink: note.mine && note.deletedAt === null,
    };
  },
});

// Batch-confirms edited tasks into the target project inside one atomic transaction: creates tainted kernel tasks,
// attaches them to the project, and links back to the note when caller is the note author.
export const tasksFromNoteConfirm = defineCommand({
  name: 'projects.tasks_from_note.confirm',
  input: zProjectTasksFromNoteConfirmInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // Calls kernel.task.create_from_note and notes.link.add via ctx.run / ctx.tryRun, so omits `writes` (same as projects.task.create).
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<ProjectTasksFromNoteConfirmResult> => {
    const userId = userOf(ctx.actor);
    const preview = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    assertNotArchived(preview);
    const note = await loadReadableNote(ctx, input.noteId);

    const { project, createdIds } = await createAndAttachConfirmedTasks(ctx, userId, {
      projectId: input.projectId,
      timeZone: input.timeZone,
      items: input.items,
      via: 'notes.note',
      activityAction: 'projects.tasks_from_note.confirmed',
      activitySummary: (count) => `Thêm ${count} việc vào dự án từ ghi chú`,
      createTask: (item, due) =>
        ctx.run<{ taskId: string }>('kernel.task.create_from_note', {
          noteId: input.noteId,
          title: item.title,
          positionId: item.assigneePositionId,
          due,
        }),
    });

    let linkedCount = 0;
    if (note.mine && note.deletedAt === null) {
      for (const taskId of createdIds) {
        const linked = await ctx.tryRun(
          'notes.link.add',
          { noteId: input.noteId, targetType: 'kernel.task', targetId: taskId },
          { recover: (r) => r.code === 'NOTE_AUTHOR_ONLY' || r.code === 'NOTE_LINK_LIMIT' || r.code === 'NOTE_LINK_EXISTS' },
        );
        if (linked.status === 'ok') linkedCount++;
      }
    }

    ctx.audit({
      projectId: project.id,
      noteId: input.noteId,
      count: createdIds.length,
      linkedCount,
      taskIds: createdIds,
    });

    return {
      projectId: project.id,
      noteId: input.noteId,
      createdCount: createdIds.length,
      linkedCount,
      taskIds: createdIds,
    };
  },
});

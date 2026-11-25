// SPDX-License-Identifier: AGPL-3.0-only
// Custom board columns per project mapped to canonical ludy_kernel.task.status (#2605, docs/plan/projects-v2.md section 4.2, ADR-0056).
import { sql } from 'kysely';
import {
  PROJECT_COLUMNS_MAX,
  REBALANCE_AT,
  auditValue,
  keyBetween,
  spreadKeys,
  tableWrite,
  zProjectColumnCreateInput,
  zProjectColumnDeleteInput,
  zProjectColumnInitDefaultsInput,
  zProjectColumnReorderInput,
  zProjectColumnUpdateInput,
  zProjectTaskMoveColumnInput,
  type BoardTaskStatus,
  type ProjectColumn,
  type ProjectColumnColor,
  type ProjectColumnDeleteResult,
  type ProjectColumnInitDefaultsResult,
  type ProjectColumnMutateResult,
  type ProjectColumnReorderResult,
  type ProjectTaskCard,
  type ProjectTaskMoveColumnResult,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, type CommandContext } from '@ludy/kernel-runtime';
import { projectsManifest } from './manifest.ts';
import { assertCanManage, assertNotArchived, loadProject, taskNotFound, userOf, WRITERS } from './shared.ts';

type TaskStatus = ProjectTaskCard['status'];

const TABLES = projectsManifest.tables;
const PROJECT_COLUMN = TABLES.ludy_projects.project_column;

const projectTarget = (input: { projectId: string }) => ({ type: 'projects.project', id: input.projectId });

export interface DefaultColumnSpec {
  taskStatus: BoardTaskStatus;
  color: ProjectColumnColor;
  vi: string;
  en: string;
}

const DEFAULT_COLUMNS: ReadonlyArray<DefaultColumnSpec> = [
  { taskStatus: 'todo', color: 'neutral', vi: 'Cần làm', en: 'To do' },
  { taskStatus: 'in_progress', color: 'primary', vi: 'Đang làm', en: 'In progress' },
  { taskStatus: 'waiting', color: 'warning', vi: 'Đang chờ', en: 'Waiting' },
  { taskStatus: 'in_review', color: 'proposal', vi: 'Chờ duyệt', en: 'In review' },
  { taskStatus: 'done', color: 'success', vi: 'Xong', en: 'Done' },
];

export async function insertProjectColumns(
  ctx: CommandContext,
  projectId: string,
  specs: ReadonlyArray<DefaultColumnSpec>,
  language: 'vi' | 'en',
): Promise<ProjectColumn[]> {
  if (specs.length === 0) return [];
  const keys = spreadKeys(specs.length);
  const inserted = await ctx.trx
    .insertInto('ludy_projects.project_column')
    .values(
      specs.map((spec, index) => ({
        org_id: ctx.orgId,
        project_id: projectId,
        name: language === 'en' ? spec.en : spec.vi,
        task_status: spec.taskStatus,
        color: spec.color,
        wip_limit: null,
        sort_key: keys[index] as string,
        created_at: ctx.now,
        updated_at: ctx.now,
      })),
    )
    .returning(['id', 'project_id', 'name', 'task_status', 'color', 'wip_limit', 'sort_key', 'created_at', 'updated_at'])
    .execute();

  return inserted
    .map((r) => toColumnView(r))
    .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id.localeCompare(b.id)));
}

export interface ProjectOrderRow {
  task_id: string;
  sort_key: string | null;
}

interface RawColumnRow {
  id: string;
  project_id: string;
  name: string;
  task_status: BoardTaskStatus;
  color: ProjectColumnColor;
  wip_limit: number | null;
  sort_key: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function toColumnView(row: RawColumnRow): ProjectColumn {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    taskStatus: row.task_status,
    color: row.color,
    wipLimit: row.wip_limit,
    sortKey: row.sort_key,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function columnNotFound(): DomainError {
  return new DomainError('COLUMN_NOT_FOUND', 404, 'Không tìm thấy cột trên bảng dự án');
}

function assertTodoAndDoneRemain(columns: ReadonlyArray<Pick<ProjectColumn, 'taskStatus'>>): void {
  const hasTodo = columns.some((c) => c.taskStatus === 'todo');
  const hasDone = columns.some((c) => c.taskStatus === 'done');
  if (!hasTodo || !hasDone) {
    throw new DomainError('COLUMN_STATUS_REQUIRED', 409, 'Bảng dự án phải giữ ít nhất một cột Cần làm và một cột Xong');
  }
}

export async function loadProjectColumns(
  trx: CommandContext['trx'],
  orgId: string,
  projectId: string,
  lock = false,
): Promise<ProjectColumn[]> {
  let query = trx
    .selectFrom('ludy_projects.project_column')
    .select(['id', 'project_id', 'name', 'task_status', 'color', 'wip_limit', 'sort_key', 'created_at', 'updated_at'])
    .where('org_id', '=', orgId)
    .where('project_id', '=', projectId)
    .orderBy('sort_key', 'asc')
    .orderBy('id', 'asc');
  if (lock) query = query.forUpdate();
  const rows = await query.execute();
  return rows.map((row) => toColumnView(row));
}

export async function loadColumnsForProjects(
  trx: CommandContext['trx'],
  orgId: string,
  projectIds: ReadonlyArray<string>,
): Promise<ProjectColumn[]> {
  if (projectIds.length === 0) return [];
  const rows = await trx
    .selectFrom('ludy_projects.project_column')
    .select(['id', 'project_id', 'name', 'task_status', 'color', 'wip_limit', 'sort_key', 'created_at', 'updated_at'])
    .where('org_id', '=', orgId)
    .where('project_id', 'in', [...projectIds])
    .orderBy('project_id', 'asc')
    .orderBy('sort_key', 'asc')
    .orderBy('id', 'asc')
    .execute();
  return rows.map((row) => toColumnView(row));
}

// Deterministic mapping for board reads and weekly status: keeps an explicit valid column_id when its
// mapped canonical status matches ludy_kernel.task.status, otherwise falls back to the first ordered column
// whose taskStatus matches task.status (handles agent/direct status changes without touching column_id).
export function resolveTaskColumnId(
  columns: ReadonlyArray<Pick<ProjectColumn, 'id' | 'taskStatus'>>,
  rawColumnId: string | null | undefined,
  taskStatus: TaskStatus,
): string | null {
  if (columns.length === 0 || taskStatus === 'cancelled') return null;
  if (rawColumnId) {
    const matched = columns.find((c) => c.id === rawColumnId);
    if (matched && matched.taskStatus === taskStatus) return matched.id;
  }
  const byStatus = columns.find((c) => c.taskStatus === taskStatus);
  return byStatus ? byStatus.id : null;
}

async function rebalanceProjectTasks(
  ctx: CommandContext,
  projectId: string,
  rows: ReadonlyArray<{ task_id: string }>,
): Promise<Map<string, string>> {
  const keys = spreadKeys(rows.length);
  const taskIds = rows.map((r) => r.task_id);
  if (taskIds.length > 0) {
    await sql`UPDATE ludy_projects.project_task AS pt SET sort_key = v.key
      FROM unnest(${taskIds}::uuid[], ${keys}::text[]) AS v(task_id, key)
      WHERE pt.org_id = ${ctx.orgId}::uuid
        AND pt.project_id = ${projectId}::uuid
        AND pt.task_id = v.task_id`.execute(ctx.trx);
  }
  return new Map(taskIds.map((id, i) => [id, keys[i] as string]));
}

async function ensureRemainingSortKeys(ctx: CommandContext, projectId: string, rows: Array<ProjectOrderRow>): Promise<void> {
  const firstNull = rows.findIndex((r) => r.sort_key === null);
  if (firstNull < 0) return;
  if (firstNull === 0) {
    const fresh = await rebalanceProjectTasks(ctx, projectId, rows);
    for (const r of rows) r.sort_key = fresh.get(r.task_id) ?? null;
    return;
  }
  const beforeFirstNull = rows[firstNull - 1];
  let prev: string | null = beforeFirstNull ? beforeFirstNull.sort_key : null;
  const filledIds: string[] = [];
  const filledKeys: string[] = [];
  let overflow = false;
  for (let i = firstNull; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    if (r.sort_key !== null) {
      overflow = true;
      break;
    }
    const next = keyBetween(prev, null);
    if (next.length > REBALANCE_AT) {
      overflow = true;
      break;
    }
    filledIds.push(r.task_id);
    filledKeys.push(next);
    prev = next;
  }
  if (overflow) {
    const fresh = await rebalanceProjectTasks(ctx, projectId, rows);
    for (const r of rows) r.sort_key = fresh.get(r.task_id) ?? null;
    return;
  }
  await sql`UPDATE ludy_projects.project_task AS pt SET sort_key = v.key
    FROM unnest(${filledIds}::uuid[], ${filledKeys}::text[]) AS v(task_id, key)
    WHERE pt.org_id = ${ctx.orgId}::uuid
      AND pt.project_id = ${projectId}::uuid
      AND pt.task_id = v.task_id`.execute(ctx.trx);
  for (let i = 0; i < filledIds.length; i++) {
    const targetRow = rows[firstNull + i];
    const key = filledKeys[i];
    if (targetRow && key !== undefined) targetRow.sort_key = key;
  }
}

export async function placeProjectTaskBetween(
  ctx: CommandContext,
  projectId: string,
  rows: Array<ProjectOrderRow>,
  lo: number,
  hi: number,
): Promise<string> {
  await ensureRemainingSortKeys(ctx, projectId, rows);
  const keyAt = (i: number) => (i < 0 || i >= rows.length ? null : (rows[i]?.sort_key ?? null));
  const a = keyAt(lo);
  const b = keyAt(hi);
  if (a === null || b === null || a < b) {
    const key = keyBetween(a, b);
    if (key.length <= REBALANCE_AT && (a === null || a < key) && (b === null || key < b)) return key;
  }
  const fresh = await rebalanceProjectTasks(ctx, projectId, rows);
  const freshAt = (i: number) => {
    if (i < 0 || i >= rows.length) return null;
    const item = rows[i];
    return item ? (fresh.get(item.task_id) ?? null) : null;
  };
  return keyBetween(freshAt(lo), freshAt(hi));
}

async function rebalanceProjectColumns(
  ctx: CommandContext,
  projectId: string,
  columns: ReadonlyArray<{ id: string }>,
): Promise<Map<string, string>> {
  const keys = spreadKeys(columns.length);
  const columnIds = columns.map((c) => c.id);
  if (columnIds.length > 0) {
    await sql`UPDATE ludy_projects.project_column AS pc
      SET sort_key = v.key,
          updated_at = ${ctx.now}
      FROM unnest(${columnIds}::uuid[], ${keys}::text[]) AS v(id, key)
      WHERE pc.org_id = ${ctx.orgId}::uuid
        AND pc.project_id = ${projectId}::uuid
        AND pc.id = v.id`.execute(ctx.trx);
  }
  return new Map(columnIds.map((id, i) => [id, keys[i] as string]));
}

async function placeColumnBetween(
  ctx: CommandContext,
  projectId: string,
  columns: ReadonlyArray<Pick<ProjectColumn, 'id' | 'sortKey'>>,
  lo: number,
  hi: number,
): Promise<string> {
  const keyAt = (i: number) => (i < 0 || i >= columns.length ? null : (columns[i]?.sortKey ?? null));
  const a = keyAt(lo);
  const b = keyAt(hi);
  if (a === null || b === null || a < b) {
    const key = keyBetween(a, b);
    if (key.length <= REBALANCE_AT && (a === null || a < key) && (b === null || key < b)) return key;
  }
  const fresh = await rebalanceProjectColumns(ctx, projectId, columns);
  const freshAt = (i: number) => {
    if (i < 0 || i >= columns.length) return null;
    const item = columns[i];
    return item ? (fresh.get(item.id) ?? null) : null;
  };
  return keyBetween(freshAt(lo), freshAt(hi));
}

export const projectColumnInitDefaults = defineCommand({
  name: 'projects.column.init_defaults',
  input: zProjectColumnInitDefaultsInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'project_column', [
      'org_id',
      'project_id',
      'name',
      'task_status',
      'color',
      'wip_limit',
      'sort_key',
      'created_at',
      'updated_at',
    ]),
    tableWrite(TABLES, 'ludy_projects', 'project_task', ['column_id']),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectColumnInitDefaultsResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project, userId);
    assertNotArchived(project);

    const existing = await loadProjectColumns(ctx.trx, ctx.orgId, project.id, true);
    if (existing.length > 0) {
      ctx.audit({ projectId: project.id, initialized: false, count: existing.length });
      return { projectId: project.id, columns: existing, initialized: false };
    }

    const columns = await insertProjectColumns(ctx, project.id, DEFAULT_COLUMNS, input.language);
    const statuses = columns.map((c) => c.taskStatus);
    const columnIds = columns.map((c) => c.id);

    // Map visible non-cancelled project tasks to the newly created default columns atomically.
    // Joining ludy_kernel.task respects le_scope RLS; any hidden task keeps column_id = NULL and resolves cleanly on read.
    await sql`UPDATE ludy_projects.project_task AS pt
      SET column_id = m.column_id
      FROM ludy_kernel.task AS t
      JOIN unnest(${statuses}::text[], ${columnIds}::uuid[]) AS m(task_status, column_id)
        ON m.task_status = t.status
      WHERE pt.org_id = ${ctx.orgId}::uuid
        AND pt.project_id = ${project.id}::uuid
        AND pt.column_id IS NULL
        AND t.org_id = pt.org_id
        AND t.id = pt.task_id`.execute(ctx.trx);

    ctx.audit({ projectId: project.id, initialized: true, count: columns.length, columnIds });
    await ctx.emit('projects.column.initialized', { projectId: project.id, count: columns.length });
    await ctx.activity('projects.project', project.id, 'projects.column.initialized', 'Khởi tạo cột tùy chỉnh cho bảng dự án');
    return { projectId: project.id, columns, initialized: true };
  },
});

export const projectColumnCreate = defineCommand({
  name: 'projects.column.create',
  input: zProjectColumnCreateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'project_column', [
      'org_id',
      'project_id',
      'name',
      'task_status',
      'color',
      'wip_limit',
      'sort_key',
      'created_at',
      'updated_at',
    ]),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectColumnMutateResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project, userId);
    assertNotArchived(project);

    const existing = await loadProjectColumns(ctx.trx, ctx.orgId, project.id, true);
    if (existing.length === 0) {
      throw new DomainError('COLUMN_STATUS_REQUIRED', 409, 'Hãy khởi tạo các cột mặc định trước khi thêm cột mới');
    }
    if (existing.length >= PROJECT_COLUMNS_MAX) {
      throw new DomainError('PROJECT_COLUMNS_MAX', 409, 'Mỗi dự án tối đa 12 cột');
    }

    let sortKey: string;
    if (input.place !== undefined && input.anchorId !== undefined) {
      const anchorIndex = existing.findIndex((c) => c.id === input.anchorId);
      if (anchorIndex < 0) throw columnNotFound();
      sortKey =
        input.place === 'before'
          ? await placeColumnBetween(ctx, project.id, existing, anchorIndex - 1, anchorIndex)
          : await placeColumnBetween(ctx, project.id, existing, anchorIndex, anchorIndex + 1);
    } else {
      sortKey = await placeColumnBetween(ctx, project.id, existing, existing.length - 1, existing.length);
    }

    const created = await ctx.trx
      .insertInto('ludy_projects.project_column')
      .values({
        org_id: ctx.orgId,
        project_id: project.id,
        name: input.name,
        task_status: input.taskStatus,
        color: input.color ?? 'neutral',
        wip_limit: input.wipLimit ?? null,
        sort_key: sortKey,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id', 'project_id', 'name', 'task_status', 'color', 'wip_limit', 'sort_key', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow();

    const column = toColumnView(created);
    ctx.audit({
      projectId: project.id,
      columnId: column.id,
      name: auditValue(PROJECT_COLUMN, 'name', column.name),
      taskStatus: column.taskStatus,
      color: column.color,
      wipLimit: column.wipLimit,
    });
    await ctx.emit('projects.column.created', { projectId: project.id, columnId: column.id, taskStatus: column.taskStatus });
    await ctx.activity('projects.project', project.id, 'projects.column.created', 'Thêm cột mới trên bảng dự án');
    return { projectId: project.id, column };
  },
});

export const projectColumnUpdate = defineCommand({
  name: 'projects.column.update',
  input: zProjectColumnUpdateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'project_column', ['name', 'task_status', 'color', 'wip_limit', 'updated_at']),
    tableWrite(TABLES, 'ludy_projects', 'project_task', ['column_id']),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectColumnMutateResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project, userId);
    assertNotArchived(project);

    const existing = await loadProjectColumns(ctx.trx, ctx.orgId, project.id, true);
    const target = existing.find((c) => c.id === input.columnId);
    if (!target) throw columnNotFound();

    const nextStatus = input.taskStatus ?? target.taskStatus;
    if (nextStatus !== target.taskStatus) {
      assertTodoAndDoneRemain(existing.map((c) => (c.id === target.id ? { ...c, taskStatus: nextStatus } : c)));
    }

    const patch: {
      name?: string;
      task_status?: BoardTaskStatus;
      color?: ProjectColumnColor;
      wip_limit?: number | null;
      updated_at: Date;
    } = { updated_at: ctx.now };
    if (input.name !== undefined) patch.name = input.name;
    if (input.taskStatus !== undefined) patch.task_status = input.taskStatus;
    if (input.color !== undefined) patch.color = input.color;
    if (input.wipLimit !== undefined) patch.wip_limit = input.wipLimit;

    const updated = await ctx.trx
      .updateTable('ludy_projects.project_column')
      .set(patch)
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('id', '=', target.id)
      .returning(['id', 'project_id', 'name', 'task_status', 'color', 'wip_limit', 'sort_key', 'created_at', 'updated_at'])
      .executeTakeFirstOrThrow();

    // If taskStatus changed, detach column_id on project_task rather than mutating kernel task statuses
    // silently (which would skip checked-out agent leases or touch le_scope-hidden tasks); board reads
    // fall back to a column matching each task's canonical status.
    if (nextStatus !== target.taskStatus) {
      await ctx.trx
        .updateTable('ludy_projects.project_task')
        .set({ column_id: null })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('column_id', '=', target.id)
        .execute();
    }

    const column = toColumnView(updated);
    ctx.audit({
      projectId: project.id,
      columnId: column.id,
      ...(input.name !== undefined ? { name: auditValue(PROJECT_COLUMN, 'name', column.name) } : {}),
      taskStatus: column.taskStatus,
      color: column.color,
      wipLimit: column.wipLimit,
    });
    await ctx.emit('projects.column.updated', { projectId: project.id, columnId: column.id, taskStatus: column.taskStatus });
    await ctx.activity('projects.project', project.id, 'projects.column.updated', 'Cập nhật cột trên bảng dự án');
    return { projectId: project.id, column };
  },
});

export const projectColumnReorder = defineCommand({
  name: 'projects.column.reorder',
  input: zProjectColumnReorderInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'ludy_projects', 'project_column', ['sort_key', 'updated_at'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectColumnReorderResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project, userId);
    assertNotArchived(project);

    const existing = await loadProjectColumns(ctx.trx, ctx.orgId, project.id, true);
    const moving = existing.find((c) => c.id === input.columnId);
    const anchor = existing.find((c) => c.id === input.anchorId);
    if (!moving || !anchor) throw columnNotFound();

    const remaining = existing.filter((c) => c.id !== moving.id);
    const at = remaining.findIndex((c) => c.id === anchor.id);
    const nextKey =
      input.place === 'before'
        ? await placeColumnBetween(ctx, project.id, remaining, at - 1, at)
        : await placeColumnBetween(ctx, project.id, remaining, at, at + 1);

    await ctx.trx
      .updateTable('ludy_projects.project_column')
      .set({ sort_key: nextKey, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('id', '=', moving.id)
      .execute();

    const columns = await loadProjectColumns(ctx.trx, ctx.orgId, project.id, false);
    ctx.audit({ projectId: project.id, columnId: moving.id, anchorId: anchor.id, place: input.place });
    return { projectId: project.id, columns };
  },
});

export const projectColumnDelete = defineCommand({
  name: 'projects.column.delete',
  input: zProjectColumnDeleteInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // May call kernel.task.set_status via ctx.run when the fallback column maps to a different canonical status;
  // omit writes so nested ludy_kernel.task / outbox updates are not rejected against ludy_projects-only writes.
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectColumnDeleteResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project, userId);
    assertNotArchived(project);

    const existing = await loadProjectColumns(ctx.trx, ctx.orgId, project.id, true);
    const target = existing.find((c) => c.id === input.columnId);
    if (!target) throw columnNotFound();
    const fallback = existing.find((c) => c.id === input.fallbackColumnId);
    if (!fallback) {
      throw new DomainError('COLUMN_FALLBACK_INVALID', 400, 'Cột thay thế không hợp lệ');
    }

    const remainingBeforeUpdate = existing.filter((c) => c.id !== target.id);
    assertTodoAndDoneRemain(remainingBeforeUpdate);

    // Inspect and lock visible tasks whose canonical status still matches the deleted column so stale
    // column_id pointers left by direct kernel.task.set_status updates are never pulled back or lease-checked.
    const { rows: attachedTasks } = await sql<{
      id: string;
      status: TaskStatus;
      checkout_run_id: string | null;
      lock_expires_at: Date | string | null;
    }>`SELECT t.id, t.status, t.checkout_run_id, t.lock_expires_at
      FROM ludy_projects.project_task pt
      INNER JOIN ludy_kernel.task t
        ON t.org_id = pt.org_id AND t.id = pt.task_id
      WHERE pt.org_id = ${ctx.orgId}::uuid
        AND pt.project_id = ${project.id}::uuid
        AND pt.column_id = ${target.id}::uuid
        AND t.status = ${target.taskStatus}
      FOR UPDATE OF t`.execute(ctx.trx);

    if (target.taskStatus !== fallback.taskStatus) {
      for (const task of attachedTasks) {
        const locked = task.checkout_run_id !== null && task.lock_expires_at !== null && new Date(task.lock_expires_at) > ctx.now;
        if (locked) {
          throw new DomainError('TASK_CHECKED_OUT', 409, 'Việc này đang được xử lý');
        }
      }
      for (const task of attachedTasks) {
        await ctx.run('kernel.task.set_status', { id: task.id, status: fallback.taskStatus });
      }
    }

    if (target.taskStatus === fallback.taskStatus) {
      // Move active same-status tasks and le_scope-hidden tasks (NOT EXISTS hides callers from seeing hidden rows)
      // while leaving visible stale/cancelled tasks pointing at target so ON DELETE SET NULL clears their column_id.
      await sql`UPDATE ludy_projects.project_task AS pt
        SET column_id = ${fallback.id}::uuid
        WHERE pt.org_id = ${ctx.orgId}::uuid
          AND pt.project_id = ${project.id}::uuid
          AND pt.column_id = ${target.id}::uuid
          AND NOT EXISTS (
            SELECT 1
              FROM ludy_kernel.task t
             WHERE t.org_id = pt.org_id
               AND t.id = pt.task_id
               AND t.status <> ${target.taskStatus}
          )`.execute(ctx.trx);
    } else if (attachedTasks.length > 0) {
      const visibleIds = attachedTasks.map((t) => t.id);
      await ctx.trx
        .updateTable('ludy_projects.project_task')
        .set({ column_id: fallback.id })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('column_id', '=', target.id)
        .where('task_id', 'in', visibleIds)
        .execute();
    }

    // Any remaining project_task rows pointing to target (stale status mismatches, cancelled, or le_scope-hidden
    // tasks when statuses differed) fall back to column_id = NULL via ON DELETE SET NULL (column_id).
    await ctx.trx
      .deleteFrom('ludy_projects.project_column')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('id', '=', target.id)
      .execute();

    const columns = await loadProjectColumns(ctx.trx, ctx.orgId, project.id, false);
    ctx.audit({
      projectId: project.id,
      deletedColumnId: target.id,
      fallbackColumnId: fallback.id,
      reassignedCount: attachedTasks.length,
    });
    await ctx.emit('projects.column.deleted', {
      projectId: project.id,
      deletedColumnId: target.id,
      fallbackColumnId: fallback.id,
    });
    await ctx.activity('projects.project', project.id, 'projects.column.deleted', 'Xóa cột trên bảng dự án');
    return { projectId: project.id, deletedColumnId: target.id, fallbackColumnId: fallback.id, columns };
  },
});

export const projectTaskMoveColumn = defineCommand({
  name: 'projects.task.move_column',
  input: zProjectTaskMoveColumnInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // Calls kernel.task.set_status via ctx.run when the column maps to a different status; omits writes like tasks.create.
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectTaskMoveColumnResult> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    const targetColumn = await ctx.trx
      .selectFrom('ludy_projects.project_column')
      .select(['id', 'task_status'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('id', '=', input.columnId)
      .executeTakeFirst();
    if (!targetColumn) throw columnNotFound();

    const { rows: lockedTasks } = await sql<{
      id: string;
      status: TaskStatus;
      checkout_run_id: string | null;
      lock_expires_at: Date | string | null;
    }>`SELECT t.id, t.status, t.checkout_run_id, t.lock_expires_at
      FROM ludy_projects.project_task pt
      INNER JOIN ludy_kernel.task t
        ON t.org_id = pt.org_id AND t.id = pt.task_id
      WHERE pt.org_id = ${ctx.orgId}::uuid
        AND pt.project_id = ${project.id}::uuid
        AND pt.task_id = ${input.taskId}::uuid
      FOR UPDATE OF t`.execute(ctx.trx);

    const task = lockedTasks[0];
    if (!task) throw taskNotFound();

    // Enforce active agent checkout lease before changing column or canonical task status (kernel.task.set_status
    // skips this check for human actors, so we guard here explicitly to match ADR-0056 / task.update semantics).
    if (task.checkout_run_id !== null && task.lock_expires_at !== null && new Date(task.lock_expires_at) > ctx.now) {
      throw new DomainError('TASK_CHECKED_OUT', 409, 'Việc này đang được xử lý');
    }

    let nextSortKey: string | undefined;
    if (input.place !== undefined && input.anchorId !== undefined) {
      const anchorVisible = await ctx.trx
        .selectFrom('ludy_projects.project_task as pt')
        .innerJoin('ludy_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
        .select('t.id')
        .where('pt.org_id', '=', ctx.orgId)
        .where('pt.project_id', '=', project.id)
        .where('pt.task_id', '=', input.anchorId)
        .executeTakeFirst();
      if (!anchorVisible) throw taskNotFound();

      const { rows: allRows } = await sql<ProjectOrderRow>`
        SELECT pt.task_id, pt.sort_key
          FROM ludy_projects.project_task pt
          LEFT JOIN ludy_kernel.task t
            ON t.org_id = pt.org_id AND t.id = pt.task_id
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${project.id}::uuid
         ORDER BY pt.sort_key ASC NULLS LAST, t.due ASC NULLS LAST, t.created_at ASC, pt.task_id ASC, pt.created_at ASC`.execute(ctx.trx);

      const remaining = allRows.filter((r) => r.task_id !== input.taskId);
      const at = remaining.findIndex((r) => r.task_id === input.anchorId);
      if (at < 0) throw taskNotFound();
      nextSortKey =
        input.place === 'before'
          ? await placeProjectTaskBetween(ctx, project.id, remaining, at - 1, at)
          : await placeProjectTaskBetween(ctx, project.id, remaining, at, at + 1);
    }

    if (task.status !== targetColumn.task_status) {
      await ctx.run('kernel.task.set_status', { id: input.taskId, status: targetColumn.task_status });
    }

    await ctx.trx
      .updateTable('ludy_projects.project_task')
      .set(nextSortKey !== undefined ? { column_id: targetColumn.id, sort_key: nextSortKey } : { column_id: targetColumn.id })
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', input.taskId)
      .execute();

    ctx.audit({
      projectId: project.id,
      taskId: input.taskId,
      columnId: targetColumn.id,
      status: targetColumn.task_status,
      ...(input.anchorId !== undefined ? { anchorId: input.anchorId, place: input.place } : {}),
    });
    return {
      projectId: project.id,
      taskId: input.taskId,
      columnId: targetColumn.id,
      status: targetColumn.task_status,
    };
  },
});

// SPDX-License-Identifier: AGPL-3.0-only
// What needs the member in Projects today, for Home's "Hôm nay cần bạn" (#2596, docs/plan/projects.md §5.1).
// One read, projects.today: no write, no model call, and only what the caller can open, since every table it
// reads keeps its tenant and legal-entity scope policy in PostgreSQL.
//
// Titles are message keys with numeric params only (today.items.projects.*), never rendered prose and never any
// free text (no task title, project name or person's name), so nothing a user wrote reaches Vy's Home prompt.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import { TODAY_ITEMS_MAX, vietnamToday, zTodayItems, type TodayItem, type TodayTitle } from '@crove/kernel-contract';
import { defineQuery } from '@crove/kernel-runtime';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

const DAY_MS = 86_400_000;
const PROJECT_TODAY_ROW_LIMIT = 500;
export const STUCK_WAITING_DAYS = 3;

export interface ProjectTodayRow {
  taskId: string;
  projectId: string;
  ownerUserId: string | null;
  status: string;
  due: Date | string | null;
  updatedAt: Date | string;
  createdAt: Date | string;
  assigneePositionId: string | null;
  holderUserId: string | null;
  holderAgentId: string | null;
  positionStatus: string | null;
}

interface PrioritizedItem {
  priority: number;
  sortMs: number;
  taskId: string;
  projectId: string;
  item: TodayItem;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function overdueTitle(isMine: boolean, overdueDays: number): TodayTitle {
  if (isMine) {
    return overdueDays >= 1
      ? { key: 'projects.taskOverdueDays', params: { days: overdueDays } }
      : { key: 'projects.taskOverdue', params: {} };
  }
  return overdueDays >= 1
    ? { key: 'projects.ownerTaskOverdueDays', params: { days: overdueDays } }
    : { key: 'projects.ownerTaskOverdue', params: {} };
}

/**
 * Pure projection of visible active-project open task rows into Home TodayItems for one actor.
 * Each task emits at most one item for its highest-urgency signal (overdue -> waiting stuck -> vacant seat -> due today).
 * Viewers cannot manage projects or update task state, so they receive no actionable items.
 */
export function projectsTodayItemsOf(
  rows: readonly ProjectTodayRow[],
  options: { userId: string; role: MemberRole | null; now: Date },
): TodayItem[] {
  const { userId, role, now } = options;
  if (role === null || role === 'viewer') return [];
  const isOwner = role === 'owner';
  const nowMs = now.getTime();
  const todayVn = vietnamToday(now);
  const stuckCutoffMs = nowMs - STUCK_WAITING_DAYS * DAY_MS;

  const prioritized: PrioritizedItem[] = [];

  for (const row of rows) {
    if (row.status === 'done' || row.status === 'cancelled') continue;

    // A task with no seat (assignee_position_id IS NULL) belongs to the org's owners (docs/plan/projects.md §3).
    const isMySeat =
      row.assigneePositionId !== null && row.holderUserId === userId && row.positionStatus !== 'archived';
    const isMine = isMySeat || (isOwner && row.assigneePositionId === null);
    // Removed project owners leave owner_user_id NULL, which falls back to the org's owners.
    const isProjectOwner = row.ownerUserId === userId || (row.ownerUserId === null && isOwner);
    if (!isMine && !isProjectOwner) continue;

    const href = `/projects/${row.projectId}`;
    const dueDate = row.due === null ? null : toDate(row.due);
    const dueMs = dueDate !== null && !Number.isNaN(dueDate.getTime()) ? dueDate.getTime() : null;
    const updatedMs = toDate(row.updatedAt).getTime();
    const createdMs = toDate(row.createdAt).getTime();

    const isOverdue = dueDate !== null && dueMs !== null && dueMs < nowMs;
    const isWaitingStuck =
      isProjectOwner && row.status === 'waiting' && !Number.isNaN(updatedMs) && updatedMs <= stuckCutoffMs;
    // An unassigned root task (assignee_position_id IS NULL) or archived seat is not a vacant seat.
    const isVacant =
      isProjectOwner &&
      row.assigneePositionId !== null &&
      row.positionStatus !== 'archived' &&
      row.holderUserId === null &&
      row.holderAgentId === null;
    const isDueToday =
      isMine && dueDate !== null && dueMs !== null && dueMs >= nowMs && vietnamToday(dueDate) === todayVn;

    if (isOverdue) {
      const overdueDays = Math.floor((nowMs - dueMs) / DAY_MS);
      prioritized.push({
        priority: 0,
        sortMs: dueMs,
        taskId: row.taskId,
        projectId: row.projectId,
        item: {
          kind: 'flag',
          app: 'projects',
          id: `overdue:${row.taskId}`,
          title: overdueTitle(isMine, overdueDays),
          severity: 'warn',
          dueAt: dueDate.toISOString(),
          href,
        },
      });
    } else if (isWaitingStuck) {
      const waitingDays = Math.floor((nowMs - updatedMs) / DAY_MS);
      prioritized.push({
        priority: 1,
        sortMs: updatedMs,
        taskId: row.taskId,
        projectId: row.projectId,
        item: {
          kind: 'flag',
          app: 'projects',
          id: `waiting:${row.taskId}`,
          title: { key: 'projects.waitingStuck', params: { days: waitingDays } },
          severity: 'warn',
          href,
        },
      });
    } else if (isVacant) {
      prioritized.push({
        priority: 2,
        sortMs: dueMs ?? (Number.isNaN(createdMs) ? 0 : createdMs),
        taskId: row.taskId,
        projectId: row.projectId,
        item: {
          kind: 'flag',
          app: 'projects',
          id: `vacant:${row.taskId}`,
          title: { key: 'projects.vacantSeat', params: {} },
          severity: 'warn',
          href,
        },
      });
    } else if (isDueToday) {
      prioritized.push({
        priority: 3,
        sortMs: dueMs,
        taskId: row.taskId,
        projectId: row.projectId,
        item: {
          kind: 'deadline',
          app: 'projects',
          id: `due:${row.taskId}`,
          title: { key: 'projects.taskDueToday', params: {} },
          dueAt: dueDate.toISOString(),
          href,
        },
      });
    }
  }

  prioritized.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.sortMs - b.sortMs ||
      byText(a.taskId, b.taskId) ||
      byText(a.projectId, b.projectId) ||
      byText(a.item.id, b.item.id),
  );

  const deduped: TodayItem[] = [];
  const seenTasks = new Set<string>();
  for (const entry of prioritized) {
    if (seenTasks.has(entry.taskId)) continue;
    seenTasks.add(entry.taskId);
    deduped.push(entry.item);
  }

  if (deduped.length <= TODAY_ITEMS_MAX) {
    return zTodayItems.parse(deduped);
  }

  const headCount = TODAY_ITEMS_MAX - 1;
  const overflow = deduped.length - headCount;
  const head = deduped.slice(0, headCount);
  return zTodayItems.parse([
    ...head,
    {
      kind: 'flag',
      app: 'projects',
      id: 'more',
      title: { key: 'projects.more', params: { count: overflow } },
      count: overflow,
      severity: 'warn',
      href: '/projects',
    },
  ]);
}

export const projectsToday = defineQuery({
  name: 'projects.today',
  // `now` is only passed by deterministic tests; Home passes {}.
  input: z.object({ now: z.iso.datetime({ offset: true }).optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<TodayItem[]> => {
    if (ctx.actor.type !== 'user' || ctx.role === null || ctx.role === 'viewer') return [];
    const userId = ctx.actor.userId;
    const isOwner = ctx.role === 'owner';
    const now = input.now ? new Date(input.now) : new Date();
    const todayVn = vietnamToday(now);
    const vnTomorrowStart = new Date(Date.parse(`${todayVn}T00:00:00.000+07:00`) + DAY_MS);
    const stuckCutoff = new Date(now.getTime() - STUCK_WAITING_DAYS * DAY_MS);

    // Build exact SQL predicates matching projectsTodayItemsOf so non-actionable rows (such as another person's
    // tasks due later today) never enter the window and lower-priority items cannot push overdue or stuck flags past LIMIT.
    const isMySeatExpr = sql<boolean>`t.assignee_position_id IS NOT NULL AND pos.holder_user_id = ${userId} AND pos.status IS DISTINCT FROM 'archived'`;
    const isMineExpr = isOwner
      ? sql<boolean>`((${isMySeatExpr}) OR t.assignee_position_id IS NULL)`
      : isMySeatExpr;
    const isProjectOwnerExpr = isOwner
      ? sql<boolean>`(p.owner_user_id = ${userId} OR p.owner_user_id IS NULL)`
      : sql<boolean>`p.owner_user_id = ${userId}`;
    const isVacantSeatExpr = sql<boolean>`t.assignee_position_id IS NOT NULL AND pos.holder_user_id IS NULL AND pos.holder_agent_id IS NULL AND pos.status IS DISTINCT FROM 'archived'`;

    const isOverdueExpr = sql<boolean>`t.due IS NOT NULL AND t.due < ${now} AND ((${isMineExpr}) OR (${isProjectOwnerExpr}))`;
    const isWaitingStuckExpr = sql<boolean>`(${isProjectOwnerExpr}) AND t.status = 'waiting' AND t.updated_at <= ${stuckCutoff}`;
    const isVacantItemExpr = sql<boolean>`(${isProjectOwnerExpr}) AND (${isVacantSeatExpr})`;
    const isDueTodayExpr = sql<boolean>`(${isMineExpr}) AND t.due IS NOT NULL AND t.due >= ${now} AND t.due < ${vnTomorrowStart}`;

    const rows = await ctx.trx
      .selectFrom('crove_projects.project_task as pt')
      .innerJoin('crove_projects.project as p', (join) =>
        join.onRef('p.org_id', '=', 'pt.org_id').onRef('p.id', '=', 'pt.project_id'),
      )
      .innerJoin('crove_kernel.task as t', (join) =>
        join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'),
      )
      .leftJoin('crove_kernel.position as pos', (join) =>
        join.onRef('pos.org_id', '=', 't.org_id').onRef('pos.id', '=', 't.assignee_position_id'),
      )
      .select([
        't.id as taskId',
        'pt.project_id as projectId',
        'p.owner_user_id as ownerUserId',
        't.status',
        't.due',
        't.updated_at as updatedAt',
        't.created_at as createdAt',
        't.assignee_position_id as assigneePositionId',
        'pos.holder_user_id as holderUserId',
        'pos.holder_agent_id as holderAgentId',
        'pos.status as positionStatus',
      ])
      .where('pt.org_id', '=', ctx.orgId)
      .where('p.status', '=', 'active')
      .where('t.status', 'not in', ['done', 'cancelled'])
      .where(sql<boolean>`((${isOverdueExpr}) OR (${isWaitingStuckExpr}) OR (${isVacantItemExpr}) OR (${isDueTodayExpr}))`)
      .orderBy(
        sql`CASE
          WHEN ${isOverdueExpr} THEN 0
          WHEN ${isWaitingStuckExpr} THEN 1
          WHEN ${isVacantItemExpr} THEN 2
          ELSE 3
        END ASC`,
      )
      .orderBy(
        sql`CASE
          WHEN ${isOverdueExpr} THEN t.due
          WHEN ${isWaitingStuckExpr} THEN t.updated_at
          WHEN ${isVacantItemExpr} THEN COALESCE(t.due, t.created_at)
          ELSE t.due
        END ASC`,
      )
      .orderBy('t.id', 'asc')
      .orderBy('pt.project_id', 'asc')
      .limit(PROJECT_TODAY_ROW_LIMIT)
      .execute();

    return projectsTodayItemsOf(rows, { userId, role: ctx.role, now });
  },
});

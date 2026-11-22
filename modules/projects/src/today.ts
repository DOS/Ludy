// SPDX-License-Identifier: AGPL-3.0-only
// What needs the member in Projects today, for Home's "Hôm nay cần bạn" (#2596, docs/plan/projects.md §5.1).
// One read, projects.today: no write, no model call, and only what the caller can open, since every table it
// reads keeps its tenant and legal-entity scope policy in PostgreSQL.
//
// Titles are message keys with numeric params only (today.items.projects.*), never rendered prose and never any
// free text (no task title, project name or person's name), so nothing a user wrote reaches Vy's Home prompt.
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@ludy/db';
import { TODAY_ITEMS_MAX, vietnamToday, zTodayItems, type TodayItem, type TodayTitle } from '@ludy/kernel-contract';
import { defineQuery } from '@ludy/kernel-runtime';

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
  blockedCount?: number;
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
 * Each task emits at most one item for its highest-urgency signal (overdue -> bottleneck blocker -> waiting stuck -> vacant seat -> due today).
 * Viewers cannot manage projects or update task state, so they receive no actionable items.
 */
export function projectsTodayItemsOf(
  rows: readonly ProjectTodayRow[],
  options: { userId: string; role: MemberRole | null; now: Date; totalCount?: number | undefined },
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

    const blockedCount = row.blockedCount ?? 0;
    const isOverdue = dueDate !== null && dueMs !== null && dueMs < nowMs;
    const isBottleneck = blockedCount > 0;
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
    } else if (isBottleneck) {
      prioritized.push({
        priority: 1,
        sortMs: -blockedCount,
        taskId: row.taskId,
        projectId: row.projectId,
        item: {
          kind: 'flag',
          app: 'projects',
          id: `bottleneck:${row.taskId}`,
          title: { key: 'projects.blockingTasks', params: { count: blockedCount } },
          severity: 'warn',
          ...(dueDate && dueMs !== null ? { dueAt: dueDate.toISOString() } : {}),
          href,
        },
      });
    } else if (isWaitingStuck) {
      const waitingDays = Math.floor((nowMs - updatedMs) / DAY_MS);
      prioritized.push({
        priority: 2,
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
        priority: 3,
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
        priority: 4,
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

  const totalCount = Math.max(deduped.length, options.totalCount ?? 0);
  if (totalCount <= TODAY_ITEMS_MAX) {
    return zTodayItems.parse(deduped);
  }

  const headCount = TODAY_ITEMS_MAX - 1;
  const head = deduped.slice(0, headCount);
  const overflow = totalCount - head.length;
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
    const isBottleneckExpr = sql<boolean>`dep.blocked_count > 0 AND ((${isMineExpr}) OR (${isProjectOwnerExpr}))`;
    const isWaitingStuckExpr = sql<boolean>`(${isProjectOwnerExpr}) AND t.status = 'waiting' AND t.updated_at <= ${stuckCutoff}`;
    const isVacantItemExpr = sql<boolean>`(${isProjectOwnerExpr}) AND (${isVacantSeatExpr})`;
    const isDueTodayExpr = sql<boolean>`(${isMineExpr}) AND t.due IS NOT NULL AND t.due >= ${now} AND t.due < ${vnTomorrowStart}`;

    const base = ctx.trx
      .selectFrom('crove_projects.project_task as pt')
      .innerJoin('crove_projects.project as p', (join) =>
        join.onRef('p.org_id', '=', 'pt.org_id').onRef('p.id', '=', 'pt.project_id'),
      )
      // Enforce unique task_pkey (org_id, id) lookup per project_task row under RLS security barriers
      // so stale stats after bulk writes never fall back to a quadratic Nested Loop between pt and task.
      .innerJoinLateral(
        (eb) =>
          eb
            .selectFrom('crove_kernel.task as tk')
            .select([
              'tk.org_id',
              'tk.id',
              'tk.status',
              'tk.due',
              'tk.updated_at',
              'tk.created_at',
              'tk.assignee_position_id',
            ])
            .whereRef('tk.org_id', '=', 'pt.org_id')
            .whereRef('tk.id', '=', 'pt.task_id')
            .where('tk.status', 'not in', ['done', 'cancelled'])
            .orderBy('tk.org_id', 'asc')
            .orderBy('tk.id', 'asc')
            .limit(1)
            .as('t'),
        (join) => join.onTrue(),
      )
      .leftJoin('crove_kernel.position as pos', (join) =>
        join.onRef('pos.org_id', '=', 't.org_id').onRef('pos.id', '=', 't.assignee_position_id'),
      )
      .leftJoin(
        sql<{ blocked_count: number }>`LATERAL (
          SELECT pg_catalog.count(*)::int AS blocked_count
            FROM crove_projects.task_dependency d
            JOIN crove_kernel.task bt
              ON bt.org_id = d.org_id AND bt.id = d.blocked_task_id
           WHERE d.org_id = pt.org_id
             AND d.project_id = pt.project_id
             AND d.blocker_task_id = t.id
             AND bt.status NOT IN ('done', 'cancelled')
        )`.as('dep'),
        (join) => join.onTrue(),
      )
      .where('pt.org_id', '=', ctx.orgId)
      .where('p.org_id', '=', ctx.orgId)
      .where('p.is_template', '=', false)
      .where('p.status', '=', 'active')
      .where(sql<boolean>`((${isOverdueExpr}) OR (${isBottleneckExpr}) OR (${isWaitingStuckExpr}) OR (${isVacantItemExpr}) OR (${isDueTodayExpr}))`);

    const rows = await base
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
        sql<number>`dep.blocked_count`.as('blockedCount'),
      ])
      .orderBy(
        sql`CASE
          WHEN ${isOverdueExpr} THEN 0
          WHEN ${isBottleneckExpr} THEN 1
          WHEN ${isWaitingStuckExpr} THEN 2
          WHEN ${isVacantItemExpr} THEN 3
          ELSE 4
        END ASC`,
      )
      .orderBy(
        sql`CASE
          WHEN NOT (${isOverdueExpr}) AND (${isBottleneckExpr}) THEN -dep.blocked_count
          ELSE 0
        END ASC`,
      )
      .orderBy(
        sql`CASE
          WHEN ${isOverdueExpr} THEN t.due
          WHEN ${isBottleneckExpr} THEN COALESCE(t.due, t.created_at)
          WHEN ${isWaitingStuckExpr} THEN t.updated_at
          WHEN ${isVacantItemExpr} THEN COALESCE(t.due, t.created_at)
          ELSE t.due
        END ASC`,
      )
      .orderBy('t.id', 'asc')
      .orderBy('pt.project_id', 'asc')
      .limit(PROJECT_TODAY_ROW_LIMIT)
      .execute();

    let totalCount: number | undefined;
    if (rows.length === PROJECT_TODAY_ROW_LIMIT) {
      const countRow = await base.select(sql<string>`count(DISTINCT t.id)::text`.as('total')).executeTakeFirst();
      totalCount = Number(countRow?.total ?? rows.length);
    }

    return projectsTodayItemsOf(rows, {
      userId,
      role: ctx.role,
      now,
      ...(totalCount === undefined ? {} : { totalCount }),
    });
  },
});

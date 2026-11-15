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
  item: TodayItem;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function overdueTitle(isMySeat: boolean, overdueDays: number): TodayTitle {
  if (isMySeat) {
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
 * Flags appear in urgency order (overdue -> waiting stuck -> vacant seat), followed by deadlines due today.
 */
export function projectsTodayItemsOf(
  rows: readonly ProjectTodayRow[],
  options: { userId: string; now: Date },
): TodayItem[] {
  const { userId, now } = options;
  const nowMs = now.getTime();
  const todayVn = vietnamToday(now);
  const stuckCutoffMs = nowMs - STUCK_WAITING_DAYS * DAY_MS;

  const prioritized: PrioritizedItem[] = [];

  for (const row of rows) {
    if (row.status === 'done' || row.status === 'cancelled') continue;

    const isMySeat =
      row.assigneePositionId !== null && row.holderUserId === userId && row.positionStatus !== 'archived';
    const isProjectOwner = row.ownerUserId === userId;
    if (!isMySeat && !isProjectOwner) continue;

    const href = `/projects/${row.projectId}`;
    const dueDate = row.due === null ? null : toDate(row.due);
    const dueMs = dueDate !== null && !Number.isNaN(dueDate.getTime()) ? dueDate.getTime() : null;
    const updatedMs = toDate(row.updatedAt).getTime();
    const createdMs = toDate(row.createdAt).getTime();

    if (dueDate !== null && dueMs !== null) {
      if (dueMs < nowMs) {
        const overdueDays = Math.floor((nowMs - dueMs) / DAY_MS);
        prioritized.push({
          priority: 0,
          sortMs: dueMs,
          taskId: row.taskId,
          item: {
            kind: 'flag',
            app: 'projects',
            id: `overdue:${row.taskId}`,
            title: overdueTitle(isMySeat, overdueDays),
            severity: 'warn',
            dueAt: dueDate.toISOString(),
            href,
          },
        });
      } else if (isMySeat && vietnamToday(dueDate) === todayVn) {
        prioritized.push({
          priority: 3,
          sortMs: dueMs,
          taskId: row.taskId,
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

    if (isProjectOwner && row.status === 'waiting' && !Number.isNaN(updatedMs) && updatedMs <= stuckCutoffMs) {
      const waitingDays = Math.floor((nowMs - updatedMs) / DAY_MS);
      prioritized.push({
        priority: 1,
        sortMs: updatedMs,
        taskId: row.taskId,
        item: {
          kind: 'flag',
          app: 'projects',
          id: `waiting:${row.taskId}`,
          title: { key: 'projects.waitingStuck', params: { days: waitingDays } },
          severity: 'warn',
          href,
        },
      });
    }

    // An unassigned root task (assignee_position_id IS NULL) belongs to no seat and is not a vacant seat.
    if (
      isProjectOwner &&
      row.assigneePositionId !== null &&
      row.holderUserId === null &&
      row.holderAgentId === null
    ) {
      prioritized.push({
        priority: 2,
        sortMs: dueMs ?? (Number.isNaN(createdMs) ? 0 : createdMs),
        taskId: row.taskId,
        item: {
          kind: 'flag',
          app: 'projects',
          id: `vacant:${row.taskId}`,
          title: { key: 'projects.vacantSeat', params: {} },
          severity: 'warn',
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
      byText(a.item.id, b.item.id),
  );

  if (prioritized.length <= TODAY_ITEMS_MAX) {
    return zTodayItems.parse(prioritized.map((entry) => entry.item));
  }

  const headCount = TODAY_ITEMS_MAX - 1;
  const overflow = prioritized.length - headCount;
  const head = prioritized.slice(0, headCount).map((entry) => entry.item);
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
  input: z.object({ now: z.iso.datetime().optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<TodayItem[]> => {
    if (ctx.actor.type !== 'user' || ctx.role === null) return [];
    const userId = ctx.actor.userId;
    const now = input.now ? new Date(input.now) : new Date();

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
      .where((eb) =>
        eb.or([
          eb('p.owner_user_id', '=', userId),
          eb.and([eb('pos.holder_user_id', '=', userId), eb('pos.status', '<>', 'archived')]),
        ]),
      )
      .orderBy(sql`t.due ASC NULLS LAST`)
      .orderBy('t.updated_at', 'asc')
      .orderBy('t.created_at', 'asc')
      .orderBy('t.id', 'asc')
      .execute();

    return projectsTodayItemsOf(rows, { userId, now });
  },
});

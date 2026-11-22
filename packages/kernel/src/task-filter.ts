// SPDX-License-Identifier: AGPL-3.0-only
// Saved view filter and sort field mappings for the `kernel.task` scope (#2610) over `ludy_kernel.task` (alias `t`).
import { sql, type Expression } from 'kysely';
import {
  dateCompare,
  flagIs,
  textContains,
  valueIn,
  valueIs,
  withinLastDays,
  type FieldCondition,
} from './saved-view-filter.ts';

const OPEN_TASK = sql<boolean>`t.status NOT IN ('done', 'cancelled')`;

/**
 * Filter AST condition map for the `kernel.task` scope over `ludy_kernel.task` aliased as `t`.
 * Caller RLS (`le_scope`, tenant isolation, and agent scope) still applies underneath.
 */
export function taskFields(options: { isOwner: boolean }): Record<string, FieldCondition> {
  return {
    search: textContains([sql`t.title`, sql`COALESCE(t.description, '')`]),
    status: (op, value, ctx) =>
      op === 'in' ? valueIn(sql`t.status`)(op, value, ctx) : valueIs(sql`t.status`)(op, value, ctx),
    assignee: (op, value, ctx) => {
      if (op === 'is') return sql<boolean>`t.assignee_position_id = ${value as string}::uuid`;
      if (op === 'is_empty') return sql<boolean>`t.assignee_position_id IS NULL`;
      if (ctx.me === null) return sql<boolean>`false`;
      const holdsSeat = sql<boolean>`EXISTS (
        SELECT 1 FROM ludy_kernel.position pos
         WHERE pos.org_id = t.org_id
           AND pos.id = t.assignee_position_id
           AND pos.holder_user_id = ${ctx.me}::uuid
      )`;
      return options.isOwner ? sql<boolean>`(t.assignee_position_id IS NULL OR ${holdsSeat})` : holdsSeat;
    },
    due: (op, value, ctx) =>
      op === 'overdue'
        ? sql<boolean>`(${OPEN_TASK} AND t.due IS NOT NULL AND t.due < ${ctx.now.toISOString()}::timestamptz)`
        : dateCompare(sql`(t.due AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`, OPEN_TASK)(op, value, ctx),
    tainted: flagIs(sql<boolean>`t.tainted`),
    created: withinLastDays(sql`t.created_at`),
  };
}

/** Sortable SQL expressions for the `kernel.task` scope over `ludy_kernel.task` aliased as `t`. */
export function taskSortColumns(): Record<string, Expression<unknown>> {
  return {
    due: sql`t.due`,
    created: sql`t.created_at`,
    updated: sql`t.updated_at`,
    title: sql`t.title`,
  };
}

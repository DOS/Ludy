// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic facts query for Vy's weekly status of one project (projects P6, #2597): reads only
// crove_projects.project, crove_projects.project_task, crove_kernel.task (under caller le_scope RLS), and
// crove_kernel.task_comment. Never reads crove_notes and never writes or persists anything.
import { sql } from 'kysely';
import {
  PROJECT_WEEKLY_STATUS_BUCKET_LIMIT,
  VIETNAM_TIME_ZONE,
  zId,
  type ProjectStatus,
  type ProjectWeeklyStatusCounts,
  type ProjectWeeklyStatusTask,
  type ProjectWeeklyStatusTasks,
} from '@crove/kernel-contract';
import { defineQuery, type QueryContext } from '@crove/kernel-runtime';
import { z } from 'zod';
import { READERS, loadProject, userOf } from './projects.ts';

export interface ProjectWeeklyStatusSource {
  project: {
    id: string;
    name: string;
    status: ProjectStatus;
  };
  window: {
    from: string;
    to: string;
    nextFrom: string;
    nextTo: string;
    timeZone: string;
  };
  counts: ProjectWeeklyStatusCounts;
  tasks: ProjectWeeklyStatusTasks;
  hiddenByEntityCount: number;
  truncated: boolean;
  aiAllowed: boolean;
  aiStopped: boolean;
  aiBudgetSpent: boolean;
}

interface RawBucketTaskRow {
  id: string;
  title: string;
  status: string;
  due: Date | string | null;
}

function shiftCalendarDay(day: string, deltaDays: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(ms + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

function oneLineComment(body: string, max = 160): string | null {
  const cleaned = body.replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  return Array.from(cleaned).slice(0, max).join('');
}

function mapBucket(
  rows: readonly RawBucketTaskRow[],
  commentCounts: Map<string, number>,
  latestComments: Map<string, string>,
): ProjectWeeklyStatusTask[] {
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status as ProjectWeeklyStatusTask['status'],
    due: row.due === null ? null : new Date(row.due).toISOString(),
    commentCount: commentCounts.get(row.id) ?? 0,
    latestComment: latestComments.get(row.id) ?? null,
  }));
}

export const projectWeeklyStatusSource = defineQuery({
  name: 'projects.weekly_status_source',
  input: z.strictObject({ projectId: zId }),
  access: READERS,
  handler: async (ctx: QueryContext, input: { projectId: string }): Promise<ProjectWeeklyStatusSource> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);

    // Inspect caller role, active kill switches (global AI, org or projects module), hard-stop AI budgets, and the
    // Vietnam calendar date anchored at the database transaction clock.
    const { rows: metaRows } = await sql<{
      today_vn: string;
      ai_stopped: boolean;
      budget_spent: boolean;
    }>`
      SELECT
        pg_catalog.to_char((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS today_vn,
        (
          crove_kernel.global_kill_switch_on('ai')
          OR EXISTS (
            SELECT 1 FROM crove_kernel.kill_switch k
             WHERE k.org_id = ${ctx.orgId}::uuid
               AND k.released_at IS NULL
               AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = 'projects'))
          )
        ) AS ai_stopped,
        crove_kernel.ai_budget_exhausted(${ctx.orgId}::uuid, 'projects', NULL::uuid) AS budget_spent`.execute(ctx.trx);

    const meta = metaRows[0];
    const todayVn = meta?.today_vn ?? new Date().toISOString().slice(0, 10);
    const from = shiftCalendarDay(todayVn, -6);
    const to = todayVn;
    const nextFrom = shiftCalendarDay(todayVn, 1);
    const nextTo = shiftCalendarDay(todayVn, 7);
    const fromStartIso = `${from}T00:00:00+07:00`;
    const nextStartIso = `${nextFrom}T00:00:00+07:00`;
    const nextEndExclusiveIso = `${shiftCalendarDay(todayVn, 8)}T00:00:00+07:00`;

    const aiAllowed = ctx.role !== 'viewer';
    const aiStopped = meta?.ai_stopped === true;
    const aiBudgetSpent = meta?.budget_spent === true;

    // Count tasks hidden from this caller by crove_kernel.task le_scope RESTRICTIVE RLS without reading them.
    const { rows: hiddenRows } = await sql<{ count: string }>`
      SELECT pg_catalog.count(*)::text AS count
        FROM crove_projects.project_task pt
       WHERE pt.org_id = ${ctx.orgId}::uuid
         AND pt.project_id = ${project.id}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM crove_kernel.task t
            WHERE t.org_id = pt.org_id AND t.id = pt.task_id
         )`.execute(ctx.trx);
    const hiddenByEntityCount = Number(hiddenRows[0]?.count ?? 0);

    // Exact, uncapped deterministic counts over visible crove_kernel.task rows in this project.
    const { rows: countRows } = await sql<{
      total_visible: string;
      done_this_week: string;
      overdue: string;
      waiting: string;
      due_next_week: string;
    }>`
      SELECT
        pg_catalog.count(*)::text AS total_visible,
        pg_catalog.count(*) FILTER (
          WHERE t.status = 'done'
            AND t.updated_at >= ${fromStartIso}::timestamptz
            AND t.updated_at <= pg_catalog.now()
        )::text AS done_this_week,
        pg_catalog.count(*) FILTER (
          WHERE t.status NOT IN ('done', 'cancelled')
            AND t.due IS NOT NULL
            AND t.due < pg_catalog.now()
        )::text AS overdue,
        pg_catalog.count(*) FILTER (
          WHERE t.status = 'waiting'
        )::text AS waiting,
        pg_catalog.count(*) FILTER (
          WHERE t.status NOT IN ('done', 'cancelled')
            AND t.due IS NOT NULL
            AND t.due >= ${nextStartIso}::timestamptz
            AND t.due < ${nextEndExclusiveIso}::timestamptz
        )::text AS due_next_week
      FROM crove_projects.project_task pt
      JOIN crove_kernel.task t
        ON t.org_id = pt.org_id AND t.id = pt.task_id
      WHERE pt.org_id = ${ctx.orgId}::uuid
        AND pt.project_id = ${project.id}::uuid
        AND t.status <> 'cancelled'`.execute(ctx.trx);

    const c = countRows[0];
    const counts: ProjectWeeklyStatusCounts = {
      totalVisible: Number(c?.total_visible ?? 0),
      doneThisWeek: Number(c?.done_this_week ?? 0),
      overdue: Number(c?.overdue ?? 0),
      waiting: Number(c?.waiting ?? 0),
      dueNextWeek: Number(c?.due_next_week ?? 0),
    };

    const [doneRes, overdueRes, waitingRes, dueNextWeekRes] = await Promise.all([
      sql<RawBucketTaskRow>`
        SELECT t.id, t.title, t.status, t.due
          FROM crove_projects.project_task pt
          JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${project.id}::uuid
           AND t.status = 'done'
           AND t.updated_at >= ${fromStartIso}::timestamptz
           AND t.updated_at <= pg_catalog.now()
         ORDER BY t.updated_at DESC, t.id ASC
         LIMIT ${PROJECT_WEEKLY_STATUS_BUCKET_LIMIT}`.execute(ctx.trx),
      sql<RawBucketTaskRow>`
        SELECT t.id, t.title, t.status, t.due
          FROM crove_projects.project_task pt
          JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${project.id}::uuid
           AND t.status NOT IN ('done', 'cancelled')
           AND t.due IS NOT NULL
           AND t.due < pg_catalog.now()
         ORDER BY t.due ASC, t.created_at ASC, t.id ASC
         LIMIT ${PROJECT_WEEKLY_STATUS_BUCKET_LIMIT}`.execute(ctx.trx),
      sql<RawBucketTaskRow>`
        SELECT t.id, t.title, t.status, t.due
          FROM crove_projects.project_task pt
          JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${project.id}::uuid
           AND t.status = 'waiting'
         ORDER BY t.due ASC NULLS LAST, t.updated_at ASC, t.id ASC
         LIMIT ${PROJECT_WEEKLY_STATUS_BUCKET_LIMIT}`.execute(ctx.trx),
      sql<RawBucketTaskRow>`
        SELECT t.id, t.title, t.status, t.due
          FROM crove_projects.project_task pt
          JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${project.id}::uuid
           AND t.status NOT IN ('done', 'cancelled')
           AND t.due IS NOT NULL
           AND t.due >= ${nextStartIso}::timestamptz
           AND t.due < ${nextEndExclusiveIso}::timestamptz
         ORDER BY t.due ASC, t.created_at ASC, t.id ASC
         LIMIT ${PROJECT_WEEKLY_STATUS_BUCKET_LIMIT}`.execute(ctx.trx),
    ]);

    const visibleIds = [
      ...new Set([
        ...doneRes.rows.map((r) => r.id),
        ...overdueRes.rows.map((r) => r.id),
        ...waitingRes.rows.map((r) => r.id),
        ...dueNextWeekRes.rows.map((r) => r.id),
      ]),
    ];

    const commentCounts = new Map<string, number>();
    const latestComments = new Map<string, string>();
    if (visibleIds.length > 0) {
      const [{ rows: countCommentRows }, { rows: snippetRows }] = await Promise.all([
        sql<{ task_id: string; n: string }>`
          SELECT task_id, pg_catalog.count(*)::text AS n
            FROM crove_kernel.task_comment
           WHERE org_id = ${ctx.orgId}::uuid
             AND task_id = ANY(${visibleIds}::uuid[])
           GROUP BY task_id`.execute(ctx.trx),
        sql<{ task_id: string; body: string }>`
          SELECT DISTINCT ON (task_id) task_id, body
            FROM crove_kernel.task_comment
           WHERE org_id = ${ctx.orgId}::uuid
             AND task_id = ANY(${visibleIds}::uuid[])
             AND NOT tainted
           ORDER BY task_id, created_at DESC, id DESC`.execute(ctx.trx),
      ]);
      for (const r of countCommentRows) commentCounts.set(r.task_id, Number(r.n));
      for (const r of snippetRows) {
        const snippet = oneLineComment(r.body);
        if (snippet !== null) latestComments.set(r.task_id, snippet);
      }
    }

    const tasks: ProjectWeeklyStatusTasks = {
      doneThisWeek: mapBucket(doneRes.rows, commentCounts, latestComments),
      overdue: mapBucket(overdueRes.rows, commentCounts, latestComments),
      waiting: mapBucket(waitingRes.rows, commentCounts, latestComments),
      dueNextWeek: mapBucket(dueNextWeekRes.rows, commentCounts, latestComments),
    };

    const truncated =
      counts.doneThisWeek > tasks.doneThisWeek.length ||
      counts.overdue > tasks.overdue.length ||
      counts.waiting > tasks.waiting.length ||
      counts.dueNextWeek > tasks.dueNextWeek.length;

    return {
      project: { id: project.id, name: project.name, status: project.status },
      window: { from, to, nextFrom, nextTo, timeZone: VIETNAM_TIME_ZONE },
      counts,
      tasks,
      hiddenByEntityCount,
      truncated,
      aiAllowed,
      aiStopped,
      aiBudgetSpent,
    };
  },
});

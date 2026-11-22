// SPDX-License-Identifier: AGPL-3.0-only
// Deterministic facts query for Vy's weekly status of one project (projects P6, #2597): reads only
// crove_projects.project, crove_projects.project_task, crove_kernel.task (under caller le_scope RLS), and
// crove_kernel.task_comment. Never reads crove_notes and never writes or persists anything.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { MemberRole, TaskStatus } from '@ludy/db';
import {
  PROJECT_WEEKLY_STATUS_BUCKET_LIMIT,
  PROJECT_WEEKLY_STATUS_MAIL_SOURCE,
  PROJECT_WEEKLY_STATUS_MAIL_TEMPLATE,
  PROJECT_WEEKLY_STATUS_NOTE_TAG,
  VIETNAM_TIME_ZONE,
  zId,
  zProjectWeeklyStatusMailPayload,
  zProjectWeeklyStatusSendMailInput,
  zProjectWeeklyStatusShareNoteInput,
  type ProjectStatus,
  type ProjectWeeklyStatusBottleneck,
  type ProjectWeeklyStatusColumn,
  type ProjectWeeklyStatusCounts,
  type ProjectWeeklyStatusSendMailResult,
  type ProjectWeeklyStatusTask,
  type ProjectWeeklyStatusTasks,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext, type QueryContext } from '@ludy/kernel-runtime';
import { z } from 'zod';
import { loadProjectColumns, resolveTaskColumnId } from './columns.ts';
import { READERS, loadProject, userOf } from './projects.ts';

const WRITERS: readonly MemberRole[] = ['owner', 'admin', 'member'];
const projectTarget = (input: { projectId: string }) => ({ type: 'projects.project', id: input.projectId });

function canManageProject(role: MemberRole | null, userId: string, ownerUserId: string | null): boolean {
  return role === 'owner' || role === 'admin' || (role !== null && role !== 'viewer' && ownerUserId === userId);
}

function assertCanManage(ctx: CommandContext, ownerUserId: string | null, userId: string): void {
  if (!canManageProject(ctx.role, userId, ownerUserId)) {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ người phụ trách dự án, quản trị viên hoặc chủ sở hữu mới thực hiện được việc này');
  }
}

function assertNotArchived(status: ProjectStatus): void {
  if (status === 'archived') {
    throw new DomainError('PROJECT_ARCHIVED', 409, 'Dự án đã lưu trữ nên không thể chỉnh sửa');
  }
}

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
  columns?: ProjectWeeklyStatusColumn[];
  tasks: ProjectWeeklyStatusTasks;
  bottlenecks?: ProjectWeeklyStatusBottleneck[];
  hiddenByEntityCount: number;
  truncated: boolean;
  aiAllowed: boolean;
  aiStopped: boolean;
  aiBudgetSpent: boolean;
}

interface RawBucketTaskRow {
  id: string;
  title: string;
  tainted: boolean;
  status: string;
  due: Date | string | null;
}

function shiftCalendarDay(day: string, deltaDays: number): string {
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return new Date(ms + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

interface WeeklyWindow {
  from: string;
  to: string;
  nextFrom: string;
  nextTo: string;
  fromStartIso: string;
  nextStartIso: string;
  nextEndExclusiveIso: string;
}

function buildWeeklyWindow(todayVn: string): WeeklyWindow {
  const from = shiftCalendarDay(todayVn, -6);
  const to = todayVn;
  const nextFrom = shiftCalendarDay(todayVn, 1);
  const nextTo = shiftCalendarDay(todayVn, 7);
  return {
    from,
    to,
    nextFrom,
    nextTo,
    fromStartIso: `${from}T00:00:00+07:00`,
    nextStartIso: `${nextFrom}T00:00:00+07:00`,
    nextEndExclusiveIso: `${shiftCalendarDay(todayVn, 8)}T00:00:00+07:00`,
  };
}

async function queryWeeklyCounts(
  trx: QueryContext['trx'],
  orgId: string,
  projectId: string,
  fromStartIso: string,
  nextStartIso: string,
  nextEndExclusiveIso: string,
): Promise<ProjectWeeklyStatusCounts> {
  const { rows: countRows } = await sql<{
    total_visible: string;
    done_this_week: string;
    overdue: string;
    waiting: string;
    due_next_week: string;
  }>`
    WITH done_events AS MATERIALIZED (
      SELECT
        CASE
          WHEN e.command = 'kernel.task.set_status' THEN e.target_id
          ELSE (e.detail ->> 'task')::uuid
        END AS task_id,
        pg_catalog.max(e.occurred_at) AS done_at
      FROM crove_kernel.audit_event e
      WHERE e.org_id = ${orgId}::uuid
        AND e.occurred_at >= ${fromStartIso}::timestamptz
        AND e.occurred_at <= pg_catalog.now()
        AND e.outcome = 'ok'
        AND (
          (e.command = 'kernel.task.set_status' AND e.target_type = 'kernel.task' AND e.target_id IS NOT NULL AND e.detail ->> 'status' = 'done')
          OR (
            e.command = 'kernel.task.approve_proposal'
            AND pg_catalog.jsonb_typeof(e.detail) = 'object'
            AND (e.detail ->> 'task') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          )
        )
      GROUP BY 1
    )
    SELECT
      pg_catalog.count(*)::text AS total_visible,
      pg_catalog.count(*) FILTER (
        WHERE t.status = 'done'
          AND de.done_at IS NOT NULL
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
    LEFT JOIN done_events de
      ON de.task_id = t.id
    WHERE pt.org_id = ${orgId}::uuid
      AND pt.project_id = ${projectId}::uuid
      AND t.status <> 'cancelled'`.execute(trx);

  const c = countRows[0];
  return {
    totalVisible: Number(c?.total_visible ?? 0),
    doneThisWeek: Number(c?.done_this_week ?? 0),
    overdue: Number(c?.overdue ?? 0),
    waiting: Number(c?.waiting ?? 0),
    dueNextWeek: Number(c?.due_next_week ?? 0),
  };
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
    // A title an AI coworker wrote (a person approved the ask): the screen marks the characters a person cannot see (#4421).
    tainted: row.tainted,
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
    const { from, to, nextFrom, nextTo, fromStartIso, nextStartIso, nextEndExclusiveIso } = buildWeeklyWindow(
      meta?.today_vn ?? new Date().toISOString().slice(0, 10),
    );

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
    // `doneThisWeek` counts tasks currently in status = 'done' whose latest transition to 'done' in
    // crove_kernel.audit_event occurred within the 7-day window (using audit_event_time_idx), so editing
    // title/due/assignee on a task finished last month via kernel.task.update does not pull it into this week.
    const counts = await queryWeeklyCounts(ctx.trx, ctx.orgId, project.id, fromStartIso, nextStartIso, nextEndExclusiveIso);
    const rawColumns = await loadProjectColumns(ctx.trx, ctx.orgId, project.id, false);
    let columns: ProjectWeeklyStatusColumn[] | undefined;
    if (rawColumns.length > 0) {
      const { rows: columnTaskRows } = await sql<{ status: TaskStatus; column_id: string | null }>`
        SELECT t.status, pt.column_id
          FROM crove_projects.project_task pt
          INNER JOIN crove_kernel.task t
            ON t.org_id = pt.org_id AND t.id = pt.task_id
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${project.id}::uuid
           AND t.status <> 'cancelled'`.execute(ctx.trx);
      const columnCounts = new Map<string, number>();
      for (const r of columnTaskRows) {
        const colId = resolveTaskColumnId(rawColumns, r.column_id, r.status);
        if (colId) columnCounts.set(colId, (columnCounts.get(colId) ?? 0) + 1);
      }
      columns = rawColumns.map((col) => ({
        id: col.id,
        name: col.name,
        taskStatus: col.taskStatus,
        color: col.color,
        wipLimit: col.wipLimit,
        taskCount: columnCounts.get(col.id) ?? 0,
      }));
    }

    const [doneRes, overdueRes, waitingRes, dueNextWeekRes] = await Promise.all([
      counts.doneThisWeek > 0
        ? sql<RawBucketTaskRow>`
            WITH done_events AS MATERIALIZED (
              SELECT
                CASE
                  WHEN e.command = 'kernel.task.set_status' THEN e.target_id
                  ELSE (e.detail ->> 'task')::uuid
                END AS task_id,
                pg_catalog.max(e.occurred_at) AS done_at
              FROM crove_kernel.audit_event e
              WHERE e.org_id = ${ctx.orgId}::uuid
                AND e.occurred_at >= ${fromStartIso}::timestamptz
                AND e.occurred_at <= pg_catalog.now()
                AND e.outcome = 'ok'
                AND (
                  (e.command = 'kernel.task.set_status' AND e.target_type = 'kernel.task' AND e.target_id IS NOT NULL AND e.detail ->> 'status' = 'done')
                  OR (
                    e.command = 'kernel.task.approve_proposal'
                    AND pg_catalog.jsonb_typeof(e.detail) = 'object'
                    AND (e.detail ->> 'task') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  )
                )
              GROUP BY 1
            )
            SELECT t.id, t.title, t.tainted, t.status, t.due
              FROM crove_projects.project_task pt
              JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
              JOIN done_events de ON de.task_id = t.id
             WHERE pt.org_id = ${ctx.orgId}::uuid
               AND pt.project_id = ${project.id}::uuid
               AND t.status = 'done'
             ORDER BY de.done_at DESC, t.id ASC
             LIMIT ${PROJECT_WEEKLY_STATUS_BUCKET_LIMIT}`.execute(ctx.trx)
        : Promise.resolve({ rows: [] as RawBucketTaskRow[] }),
      sql<RawBucketTaskRow>`
        SELECT t.id, t.title, t.tainted, t.status, t.due
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
        SELECT t.id, t.title, t.tainted, t.status, t.due
          FROM crove_projects.project_task pt
          JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${project.id}::uuid
           AND t.status = 'waiting'
         ORDER BY t.due ASC NULLS LAST, t.updated_at ASC, t.id ASC
         LIMIT ${PROJECT_WEEKLY_STATUS_BUCKET_LIMIT}`.execute(ctx.trx),
      sql<RawBucketTaskRow>`
        SELECT t.id, t.title, t.tainted, t.status, t.due
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

    const { rows: bottleneckRows } = await sql<{
      id: string;
      title: string;
      status: string;
      due: Date | string | null;
      blocked_count: number;
    }>`
      SELECT
        bt.id,
        bt.title,
        bt.status,
        bt.due,
        pg_catalog.count(*)::int AS blocked_count
      FROM crove_projects.task_dependency d
      JOIN crove_kernel.task bt
        ON bt.org_id = d.org_id AND bt.id = d.blocker_task_id
      JOIN crove_kernel.task dt
        ON dt.org_id = d.org_id AND dt.id = d.blocked_task_id
      WHERE d.org_id = ${ctx.orgId}::uuid
        AND d.project_id = ${project.id}::uuid
        AND bt.status NOT IN ('done', 'cancelled')
        AND dt.status NOT IN ('done', 'cancelled')
      GROUP BY bt.id, bt.title, bt.status, bt.due
      ORDER BY blocked_count DESC, bt.due ASC NULLS LAST, bt.id ASC
      LIMIT 5`.execute(ctx.trx);

    const bottlenecks: ProjectWeeklyStatusBottleneck[] = bottleneckRows.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status as TaskStatus,
      due: row.due === null ? null : row.due instanceof Date ? row.due.toISOString() : row.due,
      blockedCount: Number(row.blocked_count),
    }));

    const truncated =
      counts.doneThisWeek > tasks.doneThisWeek.length ||
      counts.overdue > tasks.overdue.length ||
      counts.waiting > tasks.waiting.length ||
      counts.dueNextWeek > tasks.dueNextWeek.length;

    return {
      project: { id: project.id, name: project.name, status: project.status },
      window: { from, to, nextFrom, nextTo, timeZone: VIETNAM_TIME_ZONE },
      counts,
      ...(columns ? { columns } : {}),
      tasks,
      bottlenecks,
      hiddenByEntityCount,
      truncated,
      aiAllowed,
      aiStopped,
      aiBudgetSpent,
    };
  },
});

export const projectWeeklyStatusShareNote = defineCommand({
  name: 'projects.weekly_status.share_note',
  input: zProjectWeeklyStatusShareNoteInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: projectTarget,
  handler: async (ctx, input): Promise<{ noteId: string; revision: number }> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project.owner_user_id, userId);
    assertNotArchived(project.status);
    if (!ctx.installed('notes')) {
      throw new DomainError('MODULE_OFF', 404, 'Ứng dụng notes chưa được bật cho công ty này', { module: 'notes' });
    }
    const note = await ctx.run<{ noteId: string; revision: number }>('notes.note.create', {
      title: input.title,
      body: input.body,
      tags: [PROJECT_WEEKLY_STATUS_NOTE_TAG],
      visibility: project.visibility === 'private' ? 'private' : 'org',
      tainted: Boolean(input.tainted),
      link: { targetType: 'projects.project', targetId: project.id },
    });
    await ctx.emit('projects.weekly_status.shared_note', {
      projectId: project.id,
      noteId: note.noteId,
    });
    await ctx.activity('projects.project', project.id, 'projects.weekly_status.shared_note', 'Chia sẻ báo cáo tuần vào ghi chú dự án');
    // Ids and taint only: notes.note.create already records redacted title via auditValue(NOTE, 'title', ...).
    ctx.audit({
      projectId: project.id,
      noteId: note.noteId,
      revision: note.revision,
      tainted: Boolean(input.tainted),
    });
    return { noteId: note.noteId, revision: note.revision };
  },
});

export const projectWeeklyStatusSendMail = defineCommand({
  name: 'projects.weekly_status.send_mail',
  input: zProjectWeeklyStatusSendMailInput,
  risk: 'R2',
  sideEffect: 'external',
  access: WRITERS,
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectWeeklyStatusSendMailResult> => {
    const userId = userOf(ctx.actor);
    // Hold a shared per-org mail advisory lock before locking the project row so concurrent PDPL erasure
    // either finishes first (before this command reads project.name) or rejects cleanly with PERSONAL_DATA_BUSY.
    await sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(${`projects.weekly_mail:${ctx.orgId}`}, 0))`.execute(ctx.trx);
    // Lock crove_projects.project FOR UPDATE before reading recipients and counts so concurrent
    // projects.task.add/remove or member changes serialize behind this send (#2609).
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project.owner_user_id, userId);
    assertNotArchived(project.status);

    const { rows: metaRows } = await sql<{ today_vn: string }>`
      SELECT pg_catalog.to_char((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS today_vn
    `.execute(ctx.trx);
    const org = await ctx.trx.selectFrom('crove_kernel.tenant').select(['slug', 'name']).where('org_id', '=', ctx.orgId).executeTakeFirstOrThrow();
    // Filter out entity-restricted recipients who cannot read every legal entity represented in this project's visible tasks (#2609).
    // Under role_assignment_scope RLS, an entity-scoped caller cannot read another member's assignments in other entities, so
    // branch 3 conservatively requires '*' = ANY(ctx_le_scope()) when the recipient has zero visible assignments (matching agents.ts:1045).
    const { rows: recipientRows } = await sql<{ user_id: string; eligible: boolean }>`
      SELECT
        pm.user_id,
        COALESCE(
          m.user_id IS NOT NULL
          AND (
            m.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1
              FROM crove_kernel.role_assignment ra
              WHERE ra.org_id = pm.org_id
                AND ra.user_id = pm.user_id
                AND ra.legal_entity_id IS NULL
            )
            OR (
              '*' = ANY ((SELECT crove_kernel.ctx_le_scope())::text[])
              AND NOT EXISTS (
                SELECT 1
                FROM crove_kernel.role_assignment ra
                WHERE ra.org_id = pm.org_id
                  AND ra.user_id = pm.user_id
              )
            )
            OR NOT EXISTS (
              SELECT 1
              FROM crove_projects.project_task pt
              JOIN crove_kernel.task t
                ON t.org_id = pt.org_id
               AND t.id = pt.task_id
              WHERE pt.org_id = pm.org_id
                AND pt.project_id = pm.project_id
                AND t.legal_entity_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1
                  FROM crove_kernel.role_assignment ra
                  WHERE ra.org_id = pm.org_id
                    AND ra.user_id = pm.user_id
                    AND ra.legal_entity_id = t.legal_entity_id
                )
            )
          ),
          false
        ) AS eligible
      FROM crove_projects.project_member pm
      LEFT JOIN crove_kernel.tenant_member m
        ON m.org_id = pm.org_id
       AND m.user_id = pm.user_id
      WHERE pm.org_id = ${ctx.orgId}::uuid
        AND pm.project_id = ${project.id}::uuid
        AND pm.user_id <> ${userId}::uuid
      ORDER BY pm.user_id`.execute(ctx.trx);

    const win = buildWeeklyWindow(metaRows[0]?.today_vn ?? new Date().toISOString().slice(0, 10));
    const counts = await queryWeeklyCounts(ctx.trx, ctx.orgId, project.id, win.fromStartIso, win.nextStartIso, win.nextEndExclusiveIso);
    const memberIds = recipientRows.filter((r) => r.eligible).map((r) => r.user_id);
    const skippedByScope = recipientRows.length - memberIds.length;

    const batchId = randomUUID();
    const payload = zProjectWeeklyStatusMailPayload.parse({
      batchId,
      projectId: project.id,
      projectName: project.name,
      orgName: org.name.trim() || org.slug,
      projectPath: `/o/${org.slug}/projects/${project.id}`,
      from: win.from,
      to: win.to,
      nextFrom: win.nextFrom,
      nextTo: win.nextTo,
      counts,
      summary: input.summary,
      language: input.language,
      aiGenerated: Boolean(input.tainted),
    });

    let sentCount = 0;
    let skippedCount = skippedByScope;
    if (memberIds.length > 0) {
      const queued = await ctx.run<{ sentCount: number; skippedCount: number; mailedUserIds: string[] }>('kernel.mail.members.queue', {
        userIds: memberIds,
        source: PROJECT_WEEKLY_STATUS_MAIL_SOURCE,
        sourceId: project.id,
        templateKey: PROJECT_WEEKLY_STATUS_MAIL_TEMPLATE,
        subject: input.subject,
        payload,
      });
      sentCount = queued.sentCount;
      skippedCount += queued.skippedCount;
      if (queued.mailedUserIds.length > 0) {
        await ctx.emit('projects.weekly_status.sent', {
          projectId: project.id,
          userIds: queued.mailedUserIds,
        });
      }
    }

    await ctx.activity('projects.project', project.id, 'projects.weekly_status.sent_mail', 'Gửi báo cáo tuần qua email cho thành viên dự án');
    // Counts and ids only: no address and no free-text subject or summary in audit rows.
    ctx.audit({
      projectId: project.id,
      batchId,
      memberCount: recipientRows.length,
      eligibleCount: memberIds.length,
      sentCount,
      skippedCount,
      language: input.language,
      tainted: Boolean(input.tainted),
    });
    return { sentCount, skippedCount };
  },
});

// SPDX-License-Identifier: AGPL-3.0-only
// Recurring project tasks (#2607): weekly and monthly schedules on ludy_projects.project_task.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  DEFAULT_TIME_ZONE,
  isTimeZone,
  tableWrite,
  todoDueInstant,
  zId,
  zonedDate,
  zonedInstant,
  zProjectTaskRecurrence,
  zProjectTaskRecurrenceClearInput,
  zProjectTaskRecurrenceGetInput,
  zProjectTaskRecurrenceSetInput,
  type ProjectTaskRecurrence,
  type ProjectTaskRecurrenceClearResult,
  type ProjectTaskRecurrenceView,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery, type CommandContext } from '@ludy/kernel-runtime';
import { projectsManifest } from './manifest.ts';
import { READERS, WRITERS, assertNotArchived, loadProject, taskNotFound, userOf } from './shared.ts';

const DAY_MS = 86_400_000;
const MAX_WAKE_REASONS = 50;
const TABLES = projectsManifest.tables;

export interface ProjectRecurringAdvanceResult {
  createdTaskId: string | null;
  seriesEnded: boolean;
  reason:
    | 'missing'
    | 'assignee_changed'
    | 'project_inactive'
    | 'no_rule'
    | 'not_due'
    | 'source_open'
    | 'open_occurrence'
    | 'limit_reached'
    | 'already_generated'
    | 'advanced';
}

export function parseLocalDateParts(date: string): [number, number, number] {
  const [y, m, d] = date.split('-').map(Number);
  return [y ?? 0, m ?? 1, d ?? 1];
}

export function formatLocalDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addLocalDays(date: string, days: number): string {
  const [y, m, d] = parseLocalDateParts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function daysBetweenLocalDates(later: string, earlier: string): number {
  const [ly, lm, ld] = parseLocalDateParts(later);
  const [ey, em, ed] = parseLocalDateParts(earlier);
  return Math.round((Date.UTC(ly, lm - 1, ld) - Date.UTC(ey, em - 1, ed)) / DAY_MS);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOfSunday0(date: string): number {
  const [y, m, d] = parseLocalDateParts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function resolveMonthlyDate(year: number, month: number, monthDay: number): string {
  const day = monthDay === -1 ? daysInMonth(year, month) : monthDay;
  return formatLocalDate(year, month, day);
}

export function normalizeRecurrence(input: ProjectTaskRecurrence): ProjectTaskRecurrence {
  return {
    cadence: input.cadence,
    interval: input.interval,
    ...(input.cadence === 'weekly' ? { weekday: input.weekday ?? 0 } : { monthDay: input.monthDay ?? 1 }),
    timeZone: input.timeZone ?? DEFAULT_TIME_ZONE,
    ...(input.until ? { until: input.until } : {}),
    ...(input.times !== undefined && input.times !== null ? { times: input.times } : {}),
  };
}

export function parseStoredRecurrence(value: unknown): ProjectTaskRecurrence | null {
  if (value === null || value === undefined) return null;
  const parsed = zProjectTaskRecurrence.safeParse(value);
  return parsed.success ? normalizeRecurrence(parsed.data) : null;
}

/**
 * Compute the next local due date (`YYYY-MM-DD`) strictly after `afterDate` for a validated rule,
 * returning `null` if the date would exceed `rule.until`.
 */
export function nextProjectRecurrenceDate(rule: ProjectTaskRecurrence, afterDate: string): string | null {
  let nextDate: string;
  if (rule.cadence === 'weekly') {
    const weekday = rule.weekday ?? 0;
    const afterWeekday = weekdayOfSunday0(afterDate);
    const sundayOfAfter = addLocalDays(afterDate, -afterWeekday);
    const sameWeekCandidate = addLocalDays(sundayOfAfter, weekday);
    nextDate = sameWeekCandidate > afterDate ? sameWeekCandidate : addLocalDays(sameWeekCandidate, rule.interval * 7);
  } else {
    const monthDay = rule.monthDay ?? 1;
    const [year, month] = parseLocalDateParts(afterDate);
    const sameMonthCandidate = resolveMonthlyDate(year, month, monthDay);
    if (sameMonthCandidate > afterDate) {
      nextDate = sameMonthCandidate;
    } else {
      const totalMonths = year * 12 + (month - 1) + rule.interval;
      const nextYear = Math.floor(totalMonths / 12);
      const nextMonth = (totalMonths % 12) + 1;
      nextDate = resolveMonthlyDate(nextYear, nextMonth, monthDay);
    }
  }
  if (rule.until && nextDate > rule.until) return null;
  return nextDate;
}

function toView(row: {
  project_id: string;
  task_id: string;
  recurrence: unknown;
  recurrence_count: number;
  recurrence_last_due: string | null;
  recurrence_next_at: Date | string | null;
  recurrence_source_task_id: string | null;
}): ProjectTaskRecurrenceView {
  return {
    projectId: row.project_id,
    taskId: row.task_id,
    recurrence: parseStoredRecurrence(row.recurrence),
    recurrenceCount: row.recurrence_count,
    recurrenceLastDue: row.recurrence_last_due,
    recurrenceNextAt: row.recurrence_next_at === null ? null : new Date(row.recurrence_next_at).toISOString(),
    recurrenceSourceTaskId: row.recurrence_source_task_id,
  };
}

async function requestSeatWakeup(
  ctx: CommandContext,
  positionId: string | null,
  taskId: string,
  tainted: boolean,
): Promise<string | null> {
  if (!positionId) return null;
  const holder = await ctx.trx
    .selectFrom('ludy_kernel.position as p')
    .innerJoin('ludy_kernel.agent as a', (j) => j.onRef('a.org_id', '=', 'p.org_id').onRef('a.id', '=', 'p.holder_agent_id'))
    .innerJoin('ludy_kernel.agent_template as t', 't.key', 'a.template_key')
    .select(['a.id', 't.module'])
    .where('p.org_id', '=', ctx.orgId)
    .where('p.id', '=', positionId)
    .where('p.status', '=', 'active')
    .where('a.status', '=', 'active')
    .executeTakeFirst();
  if (!holder) return null;
  const reason = { taskId, why: 'assigned' };
  await sql`
    INSERT INTO ludy_kernel.agent_wakeup AS w (org_id, agent_id, reasons, tainted, request_depth)
    VALUES (${ctx.orgId}::uuid, ${holder.id}::uuid, ${JSON.stringify([reason])}::jsonb, ${tainted}, 0)
    ON CONFLICT (org_id, agent_id) WHERE status = 'pending' DO UPDATE SET
      reasons = CASE
        WHEN pg_catalog.jsonb_array_length(w.reasons) >= ${MAX_WAKE_REASONS} THEN w.reasons
        ELSE w.reasons || EXCLUDED.reasons
      END,
      request_count = w.request_count + 1,
      tainted = w.tainted OR EXCLUDED.tainted,
      updated_at = pg_catalog.now()`.execute(ctx.trx);
  if (!ctx.installed(holder.module)) return null;
  const { rows: appRows } = await sql<{ enabled: boolean }>`
    SELECT ludy_kernel.org_app_on(${ctx.orgId}::uuid, ${holder.module}::text) AS enabled`.execute(ctx.trx);
  return appRows[0]?.enabled ? holder.id : null;
}

export const projectTaskRecurrenceGet = defineQuery({
  name: 'projects.task.recurrence.get',
  input: zProjectTaskRecurrenceGetInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectTaskRecurrenceView | null> => {
    userOf(ctx.actor);
    const row = await ctx.trx
      .selectFrom('ludy_projects.project_task as pt')
      .innerJoin('ludy_projects.project as p', (join) =>
        join.onRef('p.org_id', '=', 'pt.org_id').onRef('p.id', '=', 'pt.project_id'),
      )
      .innerJoin('ludy_kernel.task as t', (join) =>
        join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'),
      )
      .select([
        'pt.project_id',
        'pt.task_id',
        'pt.recurrence',
        'pt.recurrence_count',
        'pt.recurrence_last_due',
        'pt.recurrence_next_at',
        'pt.recurrence_source_task_id',
      ])
      .where('pt.org_id', '=', ctx.orgId)
      .where('pt.task_id', '=', input.taskId)
      .where('p.is_template', '=', false)
      .executeTakeFirst();
    if (!row) return null;
    return toView(row);
  },
});

export const projectTaskRecurrenceSet = defineCommand({
  name: 'projects.task.recurrence.set',
  input: zProjectTaskRecurrenceSetInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'ludy_projects', 'project_task', ['recurrence', 'recurrence_next_at'])],
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<ProjectTaskRecurrenceView> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    const visibleTask = await ctx.trx
      .selectFrom('ludy_kernel.task')
      .select(['id', 'due'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.taskId)
      .executeTakeFirst();
    if (!visibleTask) throw taskNotFound();

    const pt = await ctx.trx
      .selectFrom('ludy_projects.project_task')
      .select([
        'project_id',
        'task_id',
        'recurrence',
        'recurrence_count',
        'recurrence_last_due',
        'recurrence_next_at',
        'recurrence_source_task_id',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', input.taskId)
      .forUpdate()
      .executeTakeFirst();
    if (!pt) throw taskNotFound();

    if (pt.recurrence_source_task_id !== null) {
      throw new DomainError(
        'RECURRENCE_COPY_FORBIDDEN',
        422,
        'Không thể đặt lịch lặp trực tiếp trên công việc được sinh tự động từ một lịch khác',
      );
    }

    const rule = normalizeRecurrence(input.recurrence);
    if (!isTimeZone(rule.timeZone)) {
      throw new DomainError('RECURRENCE_INVALID_TIMEZONE', 422, 'Múi giờ không hợp lệ');
    }

    const today = zonedDate(rule.timeZone, ctx.now.getTime());
    if (rule.until && rule.until < today) {
      throw new DomainError('RECURRENCE_UNTIL_PAST', 422, 'Ngày kết thúc lịch lặp phải từ hôm nay trở đi');
    }
    if (rule.times !== undefined && rule.times !== null && pt.recurrence_count >= rule.times) {
      throw new DomainError('RECURRENCE_LIMIT_REACHED', 422, 'Số lần lặp đã đạt giới hạn đã chọn');
    }

    const anchorDate = pt.recurrence_last_due
      ? pt.recurrence_last_due
      : visibleTask.due !== null
        ? zonedDate(rule.timeZone, new Date(visibleTask.due).getTime())
        : today;

    const nextDueDate = nextProjectRecurrenceDate(rule, anchorDate);
    if (!nextDueDate) {
      throw new DomainError('RECURRENCE_NO_OCCURRENCE', 422, 'Ngày kết thúc nằm trước kỳ lặp tiếp theo');
    }

    const nextAt = new Date(zonedInstant(rule.timeZone, nextDueDate, 0));
    const serialized = JSON.stringify(rule);

    await ctx.trx
      .updateTable('ludy_projects.project_task')
      .set({
        recurrence: serialized,
        recurrence_next_at: nextAt,
      })
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', input.taskId)
      .execute();

    ctx.audit({
      projectId: project.id,
      taskId: input.taskId,
      cadence: rule.cadence,
      interval: rule.interval,
      nextDueDate,
    });
    await ctx.emit('projects.task.recurrence.set', {
      projectId: project.id,
      taskId: input.taskId,
      cadence: rule.cadence,
      interval: rule.interval,
    });
    await ctx.activity('projects.project', project.id, 'projects.task.recurrence.set', 'Đặt lịch lặp cho công việc');

    return {
      projectId: project.id,
      taskId: input.taskId,
      recurrence: rule,
      recurrenceCount: pt.recurrence_count,
      recurrenceLastDue: pt.recurrence_last_due,
      recurrenceNextAt: nextAt.toISOString(),
      recurrenceSourceTaskId: null,
    };
  },
});

export const projectTaskRecurrenceClear = defineCommand({
  name: 'projects.task.recurrence.clear',
  input: zProjectTaskRecurrenceClearInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'ludy_projects', 'project_task', ['recurrence', 'recurrence_next_at'])],
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<ProjectTaskRecurrenceClearResult> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    const visibleTask = await ctx.trx
      .selectFrom('ludy_kernel.task')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.taskId)
      .executeTakeFirst();
    if (!visibleTask) throw taskNotFound();

    const pt = await ctx.trx
      .selectFrom('ludy_projects.project_task')
      .select(['recurrence', 'recurrence_next_at'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', input.taskId)
      .forUpdate()
      .executeTakeFirst();
    if (!pt) throw taskNotFound();

    const cleared = pt.recurrence !== null || pt.recurrence_next_at !== null;
    if (cleared) {
      await ctx.trx
        .updateTable('ludy_projects.project_task')
        .set({
          recurrence: null,
          recurrence_next_at: null,
        })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('task_id', '=', input.taskId)
        .execute();
    }

    ctx.audit({ projectId: project.id, taskId: input.taskId, cleared });
    if (cleared) {
      await ctx.emit('projects.task.recurrence.cleared', { projectId: project.id, taskId: input.taskId });
      await ctx.activity('projects.project', project.id, 'projects.task.recurrence.cleared', 'Tắt lịch lặp công việc');
    }

    return { projectId: project.id, taskId: input.taskId, cleared };
  },
});

const zRecurringAdvanceInput = z.strictObject({
  projectId: zId,
  taskId: zId,
});

export const projectRecurringAdvance = defineCommand({
  name: 'projects.recurring.advance',
  input: zRecurringAdvanceInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  // Writes across ludy_kernel.task, ludy_kernel.agent_wakeup, and ludy_projects.project_task (system-only).
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<ProjectRecurringAdvanceResult> => {
    // 1. Pre-read the source task's seat without locks so we lock ludy_kernel.position BEFORE
    // ludy_projects.project -> ludy_projects.project_task (canonical position -> project -> project_task hierarchy).
    const previewTask = await ctx.trx
      .selectFrom('ludy_kernel.task')
      .select(['assignee_position_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.taskId)
      .executeTakeFirst();
    if (!previewTask) return { createdTaskId: null, seriesEnded: false, reason: 'missing' };
    const preLockedPositionId = previewTask.assignee_position_id;

    if (preLockedPositionId !== null) {
      await ctx.trx
        .selectFrom('ludy_kernel.position')
        .select('id')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', preLockedPositionId)
        .forShare()
        .executeTakeFirst();
    }

    // 2. Lock the project before project_task so concurrent set/clear commands and the project_task_not_on_template trigger share the same lock hierarchy.
    const project = await ctx.trx
      .selectFrom('ludy_projects.project')
      .select(['id', 'status', 'is_template'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.projectId)
      .forShare()
      .executeTakeFirst();
    if (!project || project.is_template || project.status !== 'active') {
      return { createdTaskId: null, seriesEnded: false, reason: 'project_inactive' };
    }

    const pt = await ctx.trx
      .selectFrom('ludy_projects.project_task')
      .select([
        'project_id',
        'task_id',
        'recurrence',
        'recurrence_count',
        'recurrence_last_due',
        'recurrence_next_at',
        'recurrence_source_task_id',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', input.projectId)
      .where('task_id', '=', input.taskId)
      .forUpdate()
      .executeTakeFirst();

    if (!pt) return { createdTaskId: null, seriesEnded: false, reason: 'missing' };

    const rule = parseStoredRecurrence(pt.recurrence);
    if (!rule || pt.recurrence_source_task_id !== null || pt.recurrence_next_at === null) {
      return { createdTaskId: null, seriesEnded: false, reason: 'no_rule' };
    }

    const nextAtMs = new Date(pt.recurrence_next_at).getTime();
    if (nextAtMs > ctx.now.getTime()) {
      return { createdTaskId: null, seriesEnded: false, reason: 'not_due' };
    }

    const srcTask = await ctx.trx
      .selectFrom('ludy_kernel.task')
      .select(['id', 'title', 'description', 'status', 'assignee_position_id', 'legal_entity_id', 'tainted'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.taskId)
      .executeTakeFirst();
    if (!srcTask) return { createdTaskId: null, seriesEnded: false, reason: 'missing' };
    if (srcTask.assignee_position_id !== preLockedPositionId) {
      // Seat changed while waiting for the project/task locks: abort cleanly so the next sweep retries with the new seat.
      return { createdTaskId: null, seriesEnded: false, reason: 'assignee_changed' };
    }
    if (srcTask.status !== 'done' && srcTask.status !== 'cancelled') {
      return { createdTaskId: null, seriesEnded: false, reason: 'source_open' };
    }

    const openCopy = await ctx.trx
      .selectFrom('ludy_projects.project_task as cpt')
      .innerJoin('ludy_kernel.task as ct', (join) =>
        join.onRef('ct.org_id', '=', 'cpt.org_id').onRef('ct.id', '=', 'cpt.task_id'),
      )
      .select('cpt.task_id')
      .where('cpt.org_id', '=', ctx.orgId)
      .where('cpt.recurrence_source_task_id', '=', input.taskId)
      .where('ct.status', 'not in', ['done', 'cancelled'])
      .executeTakeFirst();
    if (openCopy) {
      return { createdTaskId: null, seriesEnded: false, reason: 'open_occurrence' };
    }

    const dueDate = zonedDate(rule.timeZone, nextAtMs);
    if ((rule.times !== undefined && rule.times !== null && pt.recurrence_count >= rule.times) || (rule.until && dueDate > rule.until)) {
      await ctx.trx
        .updateTable('ludy_projects.project_task')
        .set({ recurrence: null, recurrence_next_at: null })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', input.projectId)
        .where('task_id', '=', input.taskId)
        .execute();
      return { createdTaskId: null, seriesEnded: true, reason: 'limit_reached' };
    }

    if (pt.recurrence_last_due === dueDate) {
      const followingDueDate = nextProjectRecurrenceDate(rule, dueDate);
      const nextAt = followingDueDate ? new Date(zonedInstant(rule.timeZone, followingDueDate, 0)) : null;
      await ctx.trx
        .updateTable('ludy_projects.project_task')
        .set({
          recurrence: followingDueDate ? JSON.stringify(rule) : null,
          recurrence_next_at: nextAt,
        })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', input.projectId)
        .where('task_id', '=', input.taskId)
        .execute();
      return { createdTaskId: null, seriesEnded: followingDueDate === null, reason: 'already_generated' };
    }

    let assigneePositionId: string | null = srcTask.assignee_position_id;
    if (assigneePositionId !== null) {
      const seat = await ctx.trx
        .selectFrom('ludy_kernel.position')
        .select(['id', 'status'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', assigneePositionId)
        .executeTakeFirst();
      if (!seat || seat.status === 'archived') {
        assigneePositionId = null;
      } else if (srcTask.legal_entity_id !== null) {
        const { rows } = await sql<{ allowed: boolean }>`
          SELECT ludy_kernel.position_reads_legal_entity(${ctx.orgId}::uuid, ${assigneePositionId}::uuid, ${srcTask.legal_entity_id}::uuid) AS allowed`.execute(ctx.trx);
        if (!rows[0]?.allowed) assigneePositionId = null;
      }
    }

    const dueInstant = new Date(todoDueInstant(dueDate, '23:59', rule.timeZone));
    const insertedTask = await ctx.trx
      .insertInto('ludy_kernel.task')
      .values({
        org_id: ctx.orgId,
        title: srcTask.title,
        description: srcTask.description,
        assignee_position_id: assigneePositionId,
        legal_entity_id: srcTask.legal_entity_id,
        status: 'todo',
        due: dueInstant,
        source: 'schedule',
        source_ref: JSON.stringify({ type: 'projects.recurring', id: input.taskId }),
        created_by_type: 'system',
        tainted: srcTask.tainted,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    await ctx.trx
      .insertInto('ludy_projects.project_task')
      .values({
        org_id: ctx.orgId,
        project_id: input.projectId,
        task_id: insertedTask.id,
        recurrence: null,
        recurrence_count: 0,
        recurrence_last_due: null,
        recurrence_next_at: null,
        recurrence_source_task_id: input.taskId,
        added_by: null,
        created_at: ctx.now,
      })
      .execute();

    const wakeAgentId = await requestSeatWakeup(ctx, assigneePositionId, insertedTask.id, srcTask.tainted);

    const nextCount = pt.recurrence_count + 1;
    const hitCountLimit = rule.times !== undefined && rule.times !== null && nextCount >= rule.times;
    const followingDueDate = hitCountLimit ? null : nextProjectRecurrenceDate(rule, dueDate);
    const seriesEnded = hitCountLimit || followingDueDate === null;
    const followingNextAt =
      !seriesEnded && followingDueDate !== null ? new Date(zonedInstant(rule.timeZone, followingDueDate, 0)) : null;

    await ctx.trx
      .updateTable('ludy_projects.project_task')
      .set({
        recurrence_count: nextCount,
        recurrence_last_due: dueDate,
        recurrence: seriesEnded ? null : JSON.stringify(rule),
        recurrence_next_at: followingNextAt,
      })
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', input.projectId)
      .where('task_id', '=', input.taskId)
      .execute();

    ctx.audit({
      projectId: input.projectId,
      sourceTaskId: input.taskId,
      createdTaskId: insertedTask.id,
      occurrence: nextCount,
      dueDate,
      seriesEnded,
    });
    await ctx.emit('projects.recurring.advanced', {
      projectId: input.projectId,
      sourceTaskId: input.taskId,
      taskId: insertedTask.id,
      positionId: assigneePositionId,
      occurrence: nextCount,
      seriesEnded,
      ...(wakeAgentId ? { wakeAgentId } : {}),
    });
    await ctx.activity('projects.project', input.projectId, 'projects.recurring.advanced', 'Tạo kỳ lặp mới cho công việc');

    return { createdTaskId: insertedTask.id, seriesEnded, reason: 'advanced' };
  },
});

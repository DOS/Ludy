// SPDX-License-Identifier: AGPL-3.0-only
// Opt-in Sprints / Cycles, Story points, deterministic burndown/velocity, and Vy cycle summary facts (#4361, docs/plan/projects-v2.md section 4.1).
import { sql } from 'kysely';
import { z } from 'zod';
import {
  PROJECT_CYCLE_LIST_LIMIT,
  PROJECT_CYCLE_MAX_DAYS,
  PROJECT_CYCLE_VELOCITY_LIMIT,
  PROJECT_WEEKLY_STATUS_BUCKET_LIMIT,
  auditValue,
  tableWrite,
  vietnamToday,
  zId,
  zProjectCycleCompleteInput,
  zProjectCycleCreateInput,
  zProjectCycleDeleteInput,
  zProjectCycleListInput,
  zProjectCycleMetricsInput,
  zProjectCycleStartInput,
  zProjectCycleUpdateInput,
  zProjectTaskSetCycleInput,
  zProjectTaskSetPointsInput,
  type ProjectCycle,
  type ProjectCycleBurndownPoint,
  type ProjectCycleCompleteResult,
  type ProjectCycleDeleteResult,
  type ProjectCycleListResult,
  type ProjectCycleMetrics,
  type ProjectCycleMutateResult,
  type ProjectCycleStatus,
  type ProjectCycleVelocityPoint,
  type ProjectStatus,
  type ProjectTaskSetCycleResult,
  type ProjectTaskSetPointsResult,
  type ProjectWeeklyStatusTask,
} from '@ludy/kernel-contract';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { projectsManifest } from './manifest.ts';
import { addLocalDays, daysBetweenLocalDates } from './recurring.ts';
import {
  READERS,
  WRITERS,
  assertCanManage,
  assertNotArchived,
  descriptionOf,
  loadProject,
  taskNotFound,
  userOf,
  type Trx,
} from './shared.ts';

const TABLES = projectsManifest.tables;
const PROJECT_CYCLE = TABLES.crove_projects.project_cycle;
const projectTarget = (input: { projectId: string }) => ({ type: 'projects.project', id: input.projectId });

const cycleNotFound = () => new DomainError('CYCLE_NOT_FOUND', 404, 'Không tìm thấy chu kỳ này');
const cycleNotUpcoming = () => new DomainError('CYCLE_NOT_UPCOMING', 409, 'Chỉ thao tác được với chu kỳ sắp tới');
const activeCycleExists = () => new DomainError('ACTIVE_CYCLE_EXISTS', 409, 'Dự án đã có một chu kỳ đang chạy');
const cycleNotActive = () => new DomainError('CYCLE_NOT_ACTIVE', 409, 'Chỉ có thể hoàn thành chu kỳ đang chạy');
const cycleCompleted = () => new DomainError('CYCLE_COMPLETED', 409, 'Chu kỳ đã hoàn thành nên không thể chỉnh sửa hoặc gán việc');
const cycleInvalidRange = () =>
  new DomainError('CYCLE_INVALID_RANGE', 400, `Khoảng ngày chu kỳ phải hợp lệ và không vượt quá ${PROJECT_CYCLE_MAX_DAYS} ngày`);
const cycleInvalidCarryover = () => new DomainError('CYCLE_INVALID_CARRYOVER', 400, 'Chu kỳ đích chuyển việc không hợp lệ');
const cycleTargetNotUpcoming = () => new DomainError('CYCLE_TARGET_NOT_UPCOMING', 409, 'Chu kỳ đích phải ở trạng thái sắp tới');
const cycleOpenTasksExist = () =>
  new DomainError('CYCLE_OPEN_TASKS_EXIST', 409, 'Chu kỳ vẫn còn việc chưa hoàn thành, vui lòng chọn nơi chuyển tiếp');

interface RawCycleRow {
  id: string;
  project_id: string;
  number: number;
  name: string;
  goal: string | null;
  status: string;
  starts_on: string;
  ends_on: string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface CycleTaskTotals {
  openTasks: number;
  doneTasks: number;
  cancelledTasks: number;
  totalPoints: number;
  donePoints: number;
}

export interface BurndownTaskSample {
  status: string;
  storyPoints: number | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface ProjectCycleSummarySource {
  project: {
    id: string;
    name: string;
    status: ProjectStatus;
  };
  cycle: ProjectCycle | null;
  metrics: ProjectCycleMetrics;
  tasks: ProjectWeeklyStatusTask[];
  hiddenByEntityCount: number;
  truncated: boolean;
  aiAllowed: boolean;
  aiStopped: boolean;
  aiBudgetSpent: boolean;
}

const ZERO_TOTALS: CycleTaskTotals = {
  openTasks: 0,
  doneTasks: 0,
  cancelledTasks: 0,
  totalPoints: 0,
  donePoints: 0,
};

function roundOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampLocalDate(date: string, min: string, max: string): string {
  if (date < min) return min;
  if (date > max) return max;
  return date;
}

function oneLineSnippet(body: string, max = 140): string | null {
  const clean = body.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function pgErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function formatCycleRow(row: RawCycleRow, totals: CycleTaskTotals = ZERO_TOTALS): ProjectCycle {
  return {
    id: row.id,
    projectId: row.project_id,
    number: row.number,
    name: row.name,
    goal: row.goal,
    status: row.status as ProjectCycleStatus,
    startsOn: String(row.starts_on).slice(0, 10),
    endsOn: String(row.ends_on).slice(0, 10),
    startedAt: row.started_at === null ? null : new Date(row.started_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    totalTasks: totals.openTasks + totals.doneTasks,
    openTasks: totals.openTasks,
    doneTasks: totals.doneTasks,
    cancelledTasks: totals.cancelledTasks,
    totalPoints: totals.totalPoints,
    donePoints: totals.donePoints,
  };
}

function validateCycleDates(startsOn: string, endsOn: string): void {
  const days = daysBetweenLocalDates(endsOn, startsOn) + 1;
  if (days < 1 || days > PROJECT_CYCLE_MAX_DAYS) {
    throw cycleInvalidRange();
  }
}

export async function loadCycle(trx: Trx, orgId: string, projectId: string, cycleId: string, lock: boolean): Promise<RawCycleRow> {
  let q = trx
    .selectFrom('crove_projects.project_cycle')
    .select([
      'id',
      'project_id',
      'number',
      'name',
      'goal',
      'status',
      'starts_on',
      'ends_on',
      'started_at',
      'completed_at',
      'created_at',
      'updated_at',
    ])
    .where('org_id', '=', orgId)
    .where('project_id', '=', projectId)
    .where('id', '=', cycleId);
  if (lock) q = q.forUpdate();
  const row = await q.executeTakeFirst();
  if (!row) throw cycleNotFound();
  return row;
}

async function cycleTaskTotalsMap(
  trx: Trx,
  orgId: string,
  projectId: string,
  cycleIds: readonly string[],
): Promise<Map<string, CycleTaskTotals>> {
  const map = new Map<string, CycleTaskTotals>();
  if (cycleIds.length === 0) return map;
  // Join crove_kernel.task so counts obey caller le_scope RLS automatically.
  const { rows } = await sql<{
    cycle_id: string;
    open_n: string;
    done_n: string;
    cancelled_n: string;
    total_pts: string;
    done_pts: string;
  }>`
    SELECT pt.cycle_id,
           pg_catalog.count(*) FILTER (WHERE t.status IN ('todo', 'in_progress', 'waiting', 'in_review'))::text AS open_n,
           pg_catalog.count(*) FILTER (WHERE t.status = 'done')::text AS done_n,
           pg_catalog.count(*) FILTER (WHERE t.status = 'cancelled')::text AS cancelled_n,
           COALESCE(pg_catalog.sum(COALESCE(pt.story_points, 0)) FILTER (WHERE t.status <> 'cancelled'), 0)::text AS total_pts,
           COALESCE(pg_catalog.sum(COALESCE(pt.story_points, 0)) FILTER (WHERE t.status = 'done'), 0)::text AS done_pts
      FROM crove_projects.project_task pt
      JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
     WHERE pt.org_id = ${orgId}::uuid
       AND pt.project_id = ${projectId}::uuid
       AND pt.cycle_id = ANY(${[...cycleIds]}::uuid[])
     GROUP BY pt.cycle_id`.execute(trx);
  for (const r of rows) {
    map.set(r.cycle_id, {
      openTasks: Number(r.open_n),
      doneTasks: Number(r.done_n),
      cancelledTasks: Number(r.cancelled_n),
      totalPoints: Number(r.total_pts),
      donePoints: Number(r.done_pts),
    });
  }
  return map;
}

export async function loadActiveCycleView(trx: Trx, orgId: string, projectId: string): Promise<ProjectCycle | null> {
  const row = await trx
    .selectFrom('crove_projects.project_cycle')
    .select([
      'id',
      'project_id',
      'number',
      'name',
      'goal',
      'status',
      'starts_on',
      'ends_on',
      'started_at',
      'completed_at',
      'created_at',
      'updated_at',
    ])
    .where('org_id', '=', orgId)
    .where('project_id', '=', projectId)
    .where('status', '=', 'active')
    .executeTakeFirst();
  if (!row) return null;
  const totals = await cycleTaskTotalsMap(trx, orgId, projectId, [row.id]);
  return formatCycleRow(row, totals.get(row.id) ?? ZERO_TOTALS);
}

/**
 * Deterministic daily burndown series across `[startsOn..endsOn]` computed strictly from task
 * `created_at`, `updated_at`, `status`, and `storyPoints` (zero AI involvement).
 */
export function computeCycleBurndown(
  tasks: readonly BurndownTaskSample[],
  startsOn: string,
  endsOn: string,
  status: ProjectCycleStatus,
  completedAt: Date | string | null,
  now: Date | string,
): ProjectCycleBurndownPoint[] {
  const scoped = tasks.filter((t) => t.status !== 'cancelled');
  const totalTasks = scoped.length;
  const totalPoints = scoped.reduce((sum, t) => sum + (t.storyPoints ?? 0), 0);

  const rawDays = daysBetweenLocalDates(endsOn, startsOn) + 1;
  const dayCount = Math.min(Math.max(rawDays, 1), PROJECT_CYCLE_MAX_DAYS);
  const todayVn = vietnamToday(new Date(now));

  let observedUntil: string | null = null;
  if (status === 'completed') {
    const closedOn = completedAt ? vietnamToday(new Date(completedAt)) : endsOn;
    observedUntil = closedOn >= startsOn ? clampLocalDate(closedOn, startsOn, endsOn) : null;
  } else if (status === 'active') {
    observedUntil = todayVn >= startsOn ? clampLocalDate(todayVn, startsOn, endsOn) : null;
  }

  const normalized = scoped.map((t) => {
    const rawCreated = vietnamToday(new Date(t.createdAt));
    // Tasks created before cycle start belong to Day 1 committed scope; tasks created after endsOn
    // keep their actual date so future-created work never fabricates points on earlier days.
    const effectiveCreated = rawCreated < startsOn ? startsOn : rawCreated;
    const rawDone = t.status === 'done' ? vietnamToday(new Date(t.updatedAt)) : null;
    // If a cycle closed over a retroactive past window, reflect tasks finished when the cycle closed.
    const effectiveDone =
      rawDone === null ? null : status === 'completed' && rawDone > endsOn ? endsOn : rawDone;
    return {
      points: t.storyPoints ?? 0,
      effectiveCreated,
      effectiveDone,
    };
  });

  const points: ProjectCycleBurndownPoint[] = [];
  for (let i = 0; i < dayCount; i += 1) {
    const date = addLocalDays(startsOn, i);
    const idealRemainingTasks = dayCount <= 1 ? 0 : roundOneDecimal((totalTasks * (dayCount - 1 - i)) / (dayCount - 1));
    const idealRemainingPoints = dayCount <= 1 ? 0 : roundOneDecimal((totalPoints * (dayCount - 1 - i)) / (dayCount - 1));

    if (observedUntil === null || date > observedUntil) {
      points.push({
        date,
        idealRemainingTasks,
        idealRemainingPoints,
        remainingTasks: null,
        remainingPoints: null,
      });
      continue;
    }

    let remainingTasks = 0;
    let remainingPoints = 0;
    for (const item of normalized) {
      if (item.effectiveCreated > date) continue;
      if (item.effectiveDone !== null && item.effectiveDone <= date) continue;
      remainingTasks += 1;
      remainingPoints += item.points;
    }
    points.push({
      date,
      idealRemainingTasks,
      idealRemainingPoints,
      remainingTasks,
      remainingPoints,
    });
  }
  return points;
}

async function computeMetricsForProject(
  trx: Trx,
  orgId: string,
  projectId: string,
  cycleId: string | undefined,
  now: Date | string,
): Promise<ProjectCycleMetrics> {
  let selectedRaw: RawCycleRow | undefined;
  if (cycleId !== undefined) {
    selectedRaw = await loadCycle(trx, orgId, projectId, cycleId, false);
  } else {
    selectedRaw = await trx
      .selectFrom('crove_projects.project_cycle')
      .select([
        'id',
        'project_id',
        'number',
        'name',
        'goal',
        'status',
        'starts_on',
        'ends_on',
        'started_at',
        'completed_at',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', orgId)
      .where('project_id', '=', projectId)
      .orderBy(sql`CASE status WHEN 'active' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END`, 'asc')
      .orderBy('number', 'desc')
      .limit(1)
      .executeTakeFirst();
  }

  let hiddenByEntityCount = 0;
  if (selectedRaw) {
    const { rows: hiddenRows } = await sql<{ count: string }>`
      SELECT pg_catalog.count(*)::text AS count
        FROM crove_projects.project_task pt
       WHERE pt.org_id = ${orgId}::uuid
         AND pt.project_id = ${projectId}::uuid
         AND pt.cycle_id = ${selectedRaw.id}::uuid
         AND NOT EXISTS (
           SELECT 1 FROM crove_kernel.task t
            WHERE t.org_id = pt.org_id AND t.id = pt.task_id
         )`.execute(trx);
    hiddenByEntityCount = Number(hiddenRows[0]?.count ?? 0);
  }

  const completedRows = await trx
    .selectFrom('crove_projects.project_cycle')
    .select([
      'id',
      'project_id',
      'number',
      'name',
      'goal',
      'status',
      'starts_on',
      'ends_on',
      'started_at',
      'completed_at',
      'created_at',
      'updated_at',
    ])
    .where('org_id', '=', orgId)
    .where('project_id', '=', projectId)
    .where('status', '=', 'completed')
    .orderBy('completed_at', 'desc')
    .orderBy('number', 'desc')
    .limit(PROJECT_CYCLE_VELOCITY_LIMIT)
    .execute();

  const cycleIds = new Set<string>(completedRows.map((c) => c.id));
  if (selectedRaw) cycleIds.add(selectedRaw.id);
  const totalsById = await cycleTaskTotalsMap(trx, orgId, projectId, [...cycleIds]);

  const selectedCycle = selectedRaw ? formatCycleRow(selectedRaw, totalsById.get(selectedRaw.id) ?? ZERO_TOTALS) : null;

  let burndown: ProjectCycleBurndownPoint[] = [];
  if (selectedCycle) {
    const taskRows = await trx
      .selectFrom('crove_projects.project_task as pt')
      .innerJoin('crove_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
      .select(['t.status', 'pt.story_points', 't.created_at', 't.updated_at'])
      .where('pt.org_id', '=', orgId)
      .where('pt.project_id', '=', projectId)
      .where('pt.cycle_id', '=', selectedCycle.id)
      .execute();
    burndown = computeCycleBurndown(
      taskRows.map((t) => ({
        status: t.status,
        storyPoints: t.story_points,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
      selectedCycle.startsOn,
      selectedCycle.endsOn,
      selectedCycle.status,
      selectedCycle.completedAt,
      now,
    );
  }

  const velocity: ProjectCycleVelocityPoint[] = [...completedRows].reverse().map((c) => {
    const formatted = formatCycleRow(c, totalsById.get(c.id) ?? ZERO_TOTALS);
    return {
      cycleId: formatted.id,
      number: formatted.number,
      name: formatted.name,
      startsOn: formatted.startsOn,
      endsOn: formatted.endsOn,
      completedTasks: formatted.doneTasks,
      totalTasks: formatted.totalTasks,
      completedPoints: formatted.donePoints,
      committedPoints: formatted.totalPoints,
    };
  });

  const averageVelocityTasks =
    velocity.length > 0 ? roundOneDecimal(velocity.reduce((s, v) => s + v.completedTasks, 0) / velocity.length) : 0;
  const averageVelocityPoints =
    velocity.length > 0 ? roundOneDecimal(velocity.reduce((s, v) => s + v.completedPoints, 0) / velocity.length) : 0;

  return {
    projectId,
    selectedCycle,
    burndown,
    velocity,
    averageVelocityTasks,
    averageVelocityPoints,
    hiddenByEntityCount,
  };
}

export const projectCycleCreate = defineCommand({
  name: 'projects.cycle.create',
  input: zProjectCycleCreateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project_cycle', [
      'project_id',
      'number',
      'name',
      'goal',
      'status',
      'starts_on',
      'ends_on',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectCycleMutateResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project, userId);
    assertNotArchived(project);

    const { rows: metaRows } = await sql<{ max_number: number; last_ends_on: string | null }>`
      SELECT COALESCE(pg_catalog.max(number), 0)::int AS max_number,
             pg_catalog.max(ends_on)::text AS last_ends_on
        FROM crove_projects.project_cycle
       WHERE org_id = ${ctx.orgId}::uuid
         AND project_id = ${project.id}::uuid`.execute(ctx.trx);

    const meta = metaRows[0];
    const nextNumber = (meta?.max_number ?? 0) + 1;
    const defaultStart = meta?.last_ends_on ? addLocalDays(String(meta.last_ends_on).slice(0, 10), 1) : vietnamToday(ctx.now);
    const startsOn = input.startsOn ?? defaultStart;
    const endsOn = input.endsOn ?? addLocalDays(startsOn, project.cycle_duration_weeks * 7 - 1);
    validateCycleDates(startsOn, endsOn);

    const goal = descriptionOf(input.goal);
    const created = await ctx.trx
      .insertInto('crove_projects.project_cycle')
      .values({
        org_id: ctx.orgId,
        project_id: project.id,
        number: nextNumber,
        name: input.name.trim(),
        goal,
        status: 'upcoming',
        starts_on: startsOn,
        ends_on: endsOn,
        started_at: null,
        completed_at: null,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    ctx.audit({
      projectId: project.id,
      cycleId: created.id,
      number: created.number,
      name: auditValue(PROJECT_CYCLE, 'name', created.name),
      goal: auditValue(PROJECT_CYCLE, 'goal', created.goal),
      startsOn: created.starts_on,
      endsOn: created.ends_on,
    });
    await ctx.emit('projects.cycle.created', { projectId: project.id, cycleId: created.id });
    await ctx.activity('projects.project', project.id, 'projects.cycle.created', 'Tạo chu kỳ mới');
    return { cycle: formatCycleRow(created, ZERO_TOTALS) };
  },
});

export const projectCycleUpdate = defineCommand({
  name: 'projects.cycle.update',
  input: zProjectCycleUpdateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'project_cycle', ['name', 'goal', 'starts_on', 'ends_on', 'updated_at'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectCycleMutateResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project, userId);
    assertNotArchived(project);

    const cycle = await loadCycle(ctx.trx, ctx.orgId, project.id, input.cycleId, true);
    if (cycle.status === 'completed') throw cycleCompleted();

    const nextName = input.name !== undefined ? input.name.trim() : cycle.name;
    const nextGoal = input.goal !== undefined ? descriptionOf(input.goal) : cycle.goal;
    const curStarts = String(cycle.starts_on).slice(0, 10);
    const curEnds = String(cycle.ends_on).slice(0, 10);
    const nextStarts = input.startsOn ?? curStarts;
    const nextEnds = input.endsOn ?? curEnds;
    validateCycleDates(nextStarts, nextEnds);

    const changed = [
      ...(nextName !== cycle.name ? ['name'] : []),
      ...(nextGoal !== cycle.goal ? ['goal'] : []),
      ...(nextStarts !== curStarts ? ['startsOn'] : []),
      ...(nextEnds !== curEnds ? ['endsOn'] : []),
    ];

    let latest = cycle;
    if (changed.length > 0) {
      latest = await ctx.trx
        .updateTable('crove_projects.project_cycle')
        .set({
          name: nextName,
          goal: nextGoal,
          starts_on: nextStarts,
          ends_on: nextEnds,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('id', '=', cycle.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }

    ctx.audit({
      projectId: project.id,
      cycleId: cycle.id,
      changed,
      ...(input.name !== undefined ? { name: auditValue(PROJECT_CYCLE, 'name', nextName) } : {}),
      ...(input.goal !== undefined ? { goal: auditValue(PROJECT_CYCLE, 'goal', nextGoal) } : {}),
    });
    if (changed.length > 0) {
      await ctx.emit('projects.cycle.updated', { projectId: project.id, cycleId: cycle.id });
      await ctx.activity('projects.project', project.id, 'projects.cycle.updated', 'Cập nhật chu kỳ');
    }
    const totals = await cycleTaskTotalsMap(ctx.trx, ctx.orgId, project.id, [latest.id]);
    return { cycle: formatCycleRow(latest, totals.get(latest.id) ?? ZERO_TOTALS) };
  },
});

async function assertCycleTasksAccessibleAndFree(
  trx: Trx,
  orgId: string,
  projectId: string,
  cycleId: string,
  now: Date,
  leaseFilter: 'all' | 'open',
): Promise<{ openCount: number }> {
  const cycleLinks = await trx
    .selectFrom('crove_projects.project_task')
    .select('task_id')
    .where('org_id', '=', orgId)
    .where('project_id', '=', projectId)
    .where('cycle_id', '=', cycleId)
    .orderBy('task_id', 'asc')
    .forUpdate()
    .execute();
  if (cycleLinks.length === 0) return { openCount: 0 };

  const visibleTasks = await trx
    .selectFrom('crove_projects.project_task as pt')
    .innerJoin('crove_kernel.task as t', (join) =>
      join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'),
    )
    .select(['pt.task_id', 't.status', 't.checkout_run_id', 't.lock_expires_at'])
    .where('pt.org_id', '=', orgId)
    .where('pt.project_id', '=', projectId)
    .where('pt.cycle_id', '=', cycleId)
    .orderBy('pt.task_id', 'asc')
    .forUpdate('t')
    .execute();

  if (cycleLinks.length !== visibleTasks.length) {
    throw new DomainError(
      'FORBIDDEN',
      403,
      'Chu kỳ còn công việc thuộc đơn vị bạn chưa có quyền xem',
    );
  }

  let openCount = 0;
  for (const row of visibleTasks) {
    const isTerminal = row.status === 'done' || row.status === 'cancelled';
    if (!isTerminal) openCount += 1;
    if (leaseFilter === 'open' && isTerminal) {
      continue;
    }
    assertTaskLeaseFree(row.checkout_run_id, row.lock_expires_at, now);
  }
  return { openCount };
}

export const projectCycleDelete = defineCommand({
  name: 'projects.cycle.delete',
  input: zProjectCycleDeleteInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project_cycle', ['org_id', 'project_id', 'id']),
    tableWrite(TABLES, 'crove_projects', 'project_task', ['cycle_id']),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectCycleDeleteResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project, userId);
    assertNotArchived(project);

    const cycle = await loadCycle(ctx.trx, ctx.orgId, project.id, input.cycleId, true);
    if (cycle.status !== 'upcoming') throw cycleNotUpcoming();

    await assertCycleTasksAccessibleAndFree(ctx.trx, ctx.orgId, project.id, cycle.id, ctx.now, 'all');

    await ctx.trx
      .deleteFrom('crove_projects.project_cycle')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('id', '=', cycle.id)
      .execute();

    ctx.audit({ projectId: project.id, cycleId: cycle.id, number: cycle.number });
    await ctx.emit('projects.cycle.deleted', { projectId: project.id, cycleId: cycle.id });
    await ctx.activity('projects.project', project.id, 'projects.cycle.deleted', 'Xóa chu kỳ sắp tới');
    return { projectId: project.id, cycleId: cycle.id, deleted: true };
  },
});

export const projectCycleStart = defineCommand({
  name: 'projects.cycle.start',
  input: zProjectCycleStartInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'project_cycle', ['status', 'started_at', 'updated_at'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectCycleMutateResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project, userId);
    assertNotArchived(project);

    const cycle = await loadCycle(ctx.trx, ctx.orgId, project.id, input.cycleId, true);
    if (cycle.status !== 'upcoming') throw cycleNotUpcoming();

    const active = await ctx.trx
      .selectFrom('crove_projects.project_cycle')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (active) throw activeCycleExists();

    let updated: RawCycleRow;
    try {
      updated = await ctx.trx
        .updateTable('crove_projects.project_cycle')
        .set({
          status: 'active',
          started_at: ctx.now,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('project_id', '=', project.id)
        .where('id', '=', cycle.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (pgErrorCode(error) === '23505') throw activeCycleExists();
      throw error;
    }

    ctx.audit({ projectId: project.id, cycleId: updated.id, number: updated.number });
    await ctx.emit('projects.cycle.started', { projectId: project.id, cycleId: updated.id });
    await ctx.activity('projects.project', project.id, 'projects.cycle.started', 'Bắt đầu chu kỳ');
    const totals = await cycleTaskTotalsMap(ctx.trx, ctx.orgId, project.id, [updated.id]);
    return { cycle: formatCycleRow(updated, totals.get(updated.id) ?? ZERO_TOTALS) };
  },
});

export const projectCycleComplete = defineCommand({
  name: 'projects.cycle.complete',
  input: zProjectCycleCompleteInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project_cycle', ['status', 'completed_at', 'updated_at']),
    tableWrite(TABLES, 'crove_projects', 'project_task', ['cycle_id']),
  ],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectCycleCompleteResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertCanManage(ctx, project, userId);
    assertNotArchived(project);

    const cycle = await loadCycle(ctx.trx, ctx.orgId, project.id, input.cycleId, true);
    if (cycle.status !== 'active') throw cycleNotActive();

    let targetCycleId: string | null = null;
    if (input.carryover.mode === 'cycle') {
      if (input.carryover.targetCycleId === cycle.id) throw cycleInvalidCarryover();
      const target = await loadCycle(ctx.trx, ctx.orgId, project.id, input.carryover.targetCycleId, true);
      if (target.status !== 'upcoming') throw cycleTargetNotUpcoming();
      targetCycleId = target.id;
    }

    const { openCount } = await assertCycleTasksAccessibleAndFree(ctx.trx, ctx.orgId, project.id, cycle.id, ctx.now, 'open');
    if (input.carryover.mode === 'none' && openCount > 0) {
      throw cycleOpenTasksExist();
    }

    let carriedOverCount = 0;
    if (input.carryover.mode !== 'none' && openCount > 0) {
      const { rows: movedRows } = await sql<{ task_id: string }>`
        UPDATE crove_projects.project_task pt
           SET cycle_id = ${targetCycleId}::uuid
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${project.id}::uuid
           AND pt.cycle_id = ${cycle.id}::uuid
           AND EXISTS (
             SELECT 1 FROM crove_kernel.task t
              WHERE t.org_id = pt.org_id
                AND t.id = pt.task_id
                AND t.status NOT IN ('done', 'cancelled')
           )
        RETURNING pt.task_id`.execute(ctx.trx);
      carriedOverCount = movedRows.length;
    }

    const completed = await ctx.trx
      .updateTable('crove_projects.project_cycle')
      .set({
        status: 'completed',
        completed_at: ctx.now,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('id', '=', cycle.id)
      .returningAll()
      .executeTakeFirstOrThrow();

    ctx.audit({
      projectId: project.id,
      cycleId: completed.id,
      carryoverMode: input.carryover.mode,
      targetCycleId,
      carriedOverCount,
    });
    await ctx.emit('projects.cycle.completed', {
      projectId: project.id,
      cycleId: completed.id,
      targetCycleId,
    });
    await ctx.activity('projects.project', project.id, 'projects.cycle.completed', 'Hoàn thành chu kỳ');
    const totals = await cycleTaskTotalsMap(ctx.trx, ctx.orgId, project.id, [completed.id]);
    return {
      cycle: formatCycleRow(completed, totals.get(completed.id) ?? ZERO_TOTALS),
      carriedOverCount,
      targetCycleId,
    };
  },
});

export function assertTaskLeaseFree(
  checkoutRunId: string | null,
  lockExpiresAt: Date | string | null,
  now: Date,
): void {
  if (
    checkoutRunId !== null &&
    lockExpiresAt !== null &&
    new Date(lockExpiresAt).getTime() > now.getTime()
  ) {
    throw new DomainError('TASK_CHECKED_OUT', 409, 'Việc này đang được xử lý');
  }
}

async function assertProjectTaskMutable(
  trx: Trx,
  orgId: string,
  projectId: string,
  taskId: string,
  now: Date,
): Promise<void> {
  const link = await trx
    .selectFrom('crove_projects.project_task as pt')
    .innerJoin('crove_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
    .select(['pt.task_id', 't.checkout_run_id', 't.lock_expires_at'])
    .where('pt.org_id', '=', orgId)
    .where('pt.project_id', '=', projectId)
    .where('pt.task_id', '=', taskId)
    .forUpdate()
    .executeTakeFirst();
  if (!link) throw taskNotFound();
  assertTaskLeaseFree(link.checkout_run_id, link.lock_expires_at, now);
}

export const projectTaskSetCycle = defineCommand({
  name: 'projects.task.set_cycle',
  input: zProjectTaskSetCycleInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'project_task', ['cycle_id'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectTaskSetCycleResult> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    await assertProjectTaskMutable(ctx.trx, ctx.orgId, project.id, input.taskId, ctx.now);

    if (input.cycleId !== null) {
      const cycle = await loadCycle(ctx.trx, ctx.orgId, project.id, input.cycleId, false);
      if (cycle.status === 'completed') throw cycleCompleted();
    }

    await ctx.trx
      .updateTable('crove_projects.project_task')
      .set({ cycle_id: input.cycleId })
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', input.taskId)
      .execute();

    ctx.audit({ projectId: project.id, taskId: input.taskId, cycleId: input.cycleId });
    await ctx.emit('projects.task.cycle_updated', {
      projectId: project.id,
      taskId: input.taskId,
      cycleId: input.cycleId,
    });
    return { projectId: project.id, taskId: input.taskId, cycleId: input.cycleId };
  },
});

export const projectTaskSetPoints = defineCommand({
  name: 'projects.task.set_points',
  input: zProjectTaskSetPointsInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'project_task', ['story_points'])],
  target: projectTarget,
  handler: async (ctx, input): Promise<ProjectTaskSetPointsResult> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertNotArchived(project);

    await assertProjectTaskMutable(ctx.trx, ctx.orgId, project.id, input.taskId, ctx.now);

    await ctx.trx
      .updateTable('crove_projects.project_task')
      .set({ story_points: input.storyPoints })
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .where('task_id', '=', input.taskId)
      .execute();

    ctx.audit({ projectId: project.id, taskId: input.taskId, storyPoints: input.storyPoints });
    await ctx.emit('projects.task.points_updated', {
      projectId: project.id,
      taskId: input.taskId,
      storyPoints: input.storyPoints,
    });
    return { projectId: project.id, taskId: input.taskId, storyPoints: input.storyPoints };
  },
});

export const projectCycleList = defineQuery({
  name: 'projects.cycle.list',
  input: zProjectCycleListInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectCycleListResult> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);

    const raw = await ctx.trx
      .selectFrom('crove_projects.project_cycle')
      .select([
        'id',
        'project_id',
        'number',
        'name',
        'goal',
        'status',
        'starts_on',
        'ends_on',
        'started_at',
        'completed_at',
        'created_at',
        'updated_at',
      ])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', project.id)
      .orderBy(sql`CASE status WHEN 'active' THEN 0 WHEN 'upcoming' THEN 1 ELSE 2 END`, 'asc')
      .orderBy('number', 'desc')
      .limit(PROJECT_CYCLE_LIST_LIMIT + 1)
      .execute();

    const truncated = raw.length > PROJECT_CYCLE_LIST_LIMIT;
    const page = truncated ? raw.slice(0, PROJECT_CYCLE_LIST_LIMIT) : raw;
    const totals = await cycleTaskTotalsMap(
      ctx.trx,
      ctx.orgId,
      project.id,
      page.map((c) => c.id),
    );

    const [{ rows: backlogRows }, { rows: hiddenRows }] = await Promise.all([
      sql<{ task_n: string; pts_n: string }>`
        SELECT pg_catalog.count(*)::text AS task_n,
               COALESCE(pg_catalog.sum(COALESCE(pt.story_points, 0)), 0)::text AS pts_n
          FROM crove_projects.project_task pt
          JOIN crove_kernel.task t ON t.org_id = pt.org_id AND t.id = pt.task_id
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${project.id}::uuid
           AND pt.cycle_id IS NULL
           AND t.status <> 'cancelled'`.execute(ctx.trx),
      sql<{ count: string }>`
        SELECT pg_catalog.count(*)::text AS count
          FROM crove_projects.project_task pt
         WHERE pt.org_id = ${ctx.orgId}::uuid
           AND pt.project_id = ${project.id}::uuid
           AND NOT EXISTS (
             SELECT 1 FROM crove_kernel.task t
              WHERE t.org_id = pt.org_id AND t.id = pt.task_id
           )`.execute(ctx.trx),
    ]);

    return {
      cycles: page.map((c) => formatCycleRow(c, totals.get(c.id) ?? ZERO_TOTALS)),
      backlogTaskCount: Number(backlogRows[0]?.task_n ?? 0),
      backlogPoints: Number(backlogRows[0]?.pts_n ?? 0),
      hiddenByEntityCount: Number(hiddenRows[0]?.count ?? 0),
      truncated,
    };
  },
});

export const projectCycleMetrics = defineQuery({
  name: 'projects.cycle.metrics',
  input: zProjectCycleMetricsInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectCycleMetrics> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    const { rows: clockRows } = await sql<{ now_ts: Date | string }>`SELECT pg_catalog.now() AS now_ts`.execute(ctx.trx);
    return computeMetricsForProject(ctx.trx, ctx.orgId, project.id, input.cycleId, clockRows[0]?.now_ts ?? new Date());
  },
});

export const projectCycleSummarySource = defineQuery({
  name: 'projects.cycle_summary_source',
  input: z.strictObject({ projectId: zId, cycleId: zId.optional() }),
  access: READERS,
  handler: async (ctx, input): Promise<ProjectCycleSummarySource> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);

    const { rows: metaRows } = await sql<{
      now_ts: Date | string;
      ai_stopped: boolean;
      budget_spent: boolean;
    }>`
      SELECT
        pg_catalog.now() AS now_ts,
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
    const metrics = await computeMetricsForProject(
      ctx.trx,
      ctx.orgId,
      project.id,
      input.cycleId,
      meta?.now_ts ?? new Date(),
    );

    const selected = metrics.selectedCycle;
    let tasks: ProjectWeeklyStatusTask[] = [];
    let truncated = false;
    if (selected !== null) {
      const taskRows = await ctx.trx
        .selectFrom('crove_projects.project_task as pt')
        .innerJoin('crove_kernel.task as t', (join) => join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'))
        .select(['t.id', 't.title', 't.tainted', 't.status', 't.due'])
        .where('pt.org_id', '=', ctx.orgId)
        .where('pt.project_id', '=', project.id)
        .where('pt.cycle_id', '=', selected.id)
        .where('t.status', '<>', 'cancelled')
        .where('t.tainted', '=', false)
        .orderBy(sql`CASE t.status WHEN 'done' THEN 1 ELSE 0 END`, 'asc')
        .orderBy(sql`t.due ASC NULLS LAST`)
        .orderBy('t.updated_at', 'desc')
        .orderBy('t.id', 'asc')
        .limit(PROJECT_WEEKLY_STATUS_BUCKET_LIMIT + 1)
        .execute();

      truncated = taskRows.length > PROJECT_WEEKLY_STATUS_BUCKET_LIMIT;
      const sample = truncated ? taskRows.slice(0, PROJECT_WEEKLY_STATUS_BUCKET_LIMIT) : taskRows;
      const sampleIds = sample.map((t) => t.id);

      const commentCounts = new Map<string, number>();
      const latestComments = new Map<string, string>();
      if (sampleIds.length > 0) {
        const [{ rows: countCommentRows }, { rows: snippetRows }] = await Promise.all([
          sql<{ task_id: string; n: string }>`
            SELECT task_id, pg_catalog.count(*)::text AS n
              FROM crove_kernel.task_comment
             WHERE org_id = ${ctx.orgId}::uuid
               AND task_id = ANY(${sampleIds}::uuid[])
             GROUP BY task_id`.execute(ctx.trx),
          sql<{ task_id: string; body: string }>`
            SELECT DISTINCT ON (task_id) task_id, body
              FROM crove_kernel.task_comment
             WHERE org_id = ${ctx.orgId}::uuid
               AND task_id = ANY(${sampleIds}::uuid[])
               AND NOT tainted
             ORDER BY task_id, created_at DESC, id DESC`.execute(ctx.trx),
        ]);
        for (const r of countCommentRows) commentCounts.set(r.task_id, Number(r.n));
        for (const r of snippetRows) {
          const snippet = oneLineSnippet(r.body);
          if (snippet !== null) latestComments.set(r.task_id, snippet);
        }
      }

      tasks = sample.map((row) => ({
        id: row.id,
        title: row.title,
        tainted: Boolean(row.tainted),
        status: row.status as ProjectWeeklyStatusTask['status'],
        due: row.due === null ? null : new Date(row.due).toISOString(),
        commentCount: commentCounts.get(row.id) ?? 0,
        latestComment: latestComments.get(row.id) ?? null,
      }));
    }

    return {
      project: { id: project.id, name: project.name, status: project.status },
      cycle: selected,
      metrics,
      tasks,
      hiddenByEntityCount: metrics.hiddenByEntityCount,
      truncated,
      aiAllowed: ctx.role !== 'viewer',
      aiStopped: meta?.ai_stopped === true,
      aiBudgetSpent: meta?.budget_spent === true,
    };
  },
});

export const projectCycleCommands = [
  projectCycleCreate,
  projectCycleUpdate,
  projectCycleDelete,
  projectCycleStart,
  projectCycleComplete,
  projectTaskSetCycle,
  projectTaskSetPoints,
];

export const projectCycleQueries = [
  projectCycleList,
  projectCycleMetrics,
  projectCycleSummarySource,
];

// SPDX-License-Identifier: AGPL-3.0-only
// Lean time tracking and billable hours (#2600, docs/plan/projects-v2.md section 5.2).
// One write path via crove_projects.time_entry; deterministic decimal.js arithmetic; zero auto-posting to Finance or HR.
import { sql } from 'kysely';
import {
  DEFAULT_TIME_ZONE,
  PROJECT_TIME_DURATION_MAX,
  PROJECT_TIME_DURATION_MIN,
  PROJECT_TIME_ENTRIES_PAGE_LIMIT,
  PROJECT_TIME_EXPORT_LIMIT,
  auditValue,
  tableWrite,
  zonedInstant,
  zProjectTimeDeleteInput,
  zProjectTimeExportCsvInput,
  zProjectTimeLogInput,
  zProjectTimeStartInput,
  zProjectTimeStopInput,
  zProjectTimeSummaryInput,
  zProjectTimeUpdateInput,
  type ProjectStatus,
  type ProjectTimeActiveTimer,
  type ProjectTimeDeleteResult,
  type ProjectTimeEntry,
  type ProjectTimeExportCsvResult,
  type ProjectTimeMemberSummary,
  type ProjectTimeMutateResult,
  type ProjectTimeStartResult,
  type ProjectTimeStopResult,
  type ProjectTimeSummaryResult,
  type ProjectTimeTaskSummary,
  type ProjectTimeTotals,
  type ProjectWeeklyStatusTimeSummary,
} from '@ludy/kernel-contract';
import { Decimal, money, sum as sumDecimal } from '@ludy/l10n-vn';
import { DomainError, defineCommand, defineQuery } from '@ludy/kernel-runtime';
import { projectsManifest } from './manifest.ts';
import {
  READERS,
  WRITERS,
  assertNotArchived,
  canManageProject,
  canWriteProject,
  loadProject,
  memberProfilesMap,
  taskNotFound,
  userOf,
  type ProjectRow,
  type Trx,
} from './shared.ts';

const TABLES = projectsManifest.tables;
const TIME_ENTRY = TABLES.crove_projects.time_entry;

const TIME_ENTRY_ALL_COLUMNS = [
  'org_id',
  'id',
  'project_id',
  'task_id',
  'user_id',
  'started_at',
  'ended_at',
  'duration_minutes',
  'billable',
  'hourly_rate',
  'note',
  'created_at',
  'updated_at',
] as const;

export const PROJECT_TIME_CSV_HEADERS = [
  'Ngày',
  'Bắt đầu',
  'Kết thúc',
  'Công việc',
  'Thành viên',
  'Thời lượng (phút)',
  'Giờ',
  'Tính phí',
  'Đơn giá (VND/giờ)',
  'Thành tiền (VND)',
  'Ghi chú',
  'Trạng thái',
] as const;

interface RawTimeEntryRow {
  id: string;
  project_id: string;
  task_id: string | null;
  task_title: string | null;
  task_visible: boolean;
  user_id: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  duration_minutes: number | null;
  billable: boolean;
  hourly_rate: string | null;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function pgErrorConstraint(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'constraint' in err) {
    const c = (err as { constraint?: unknown }).constraint;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

function normalizeNoteInput(note: string | null | undefined): string | null | undefined {
  if (note === undefined) return undefined;
  if (note === null) return null;
  const trimmed = note.trim();
  return trimmed === '' ? null : trimmed;
}

export function normalizeHourlyRateInput(rate: string | null | undefined): string | null | undefined {
  if (rate === undefined) return undefined;
  if (rate === null) return null;
  let parsed: InstanceType<typeof Decimal>;
  try {
    parsed = money(rate);
  } catch {
    throw new DomainError('TIME_ENTRY_INVALID_RATE', 422, 'Đơn giá giờ không hợp lệ');
  }
  if (parsed.isNegative()) {
    throw new DomainError('TIME_ENTRY_INVALID_RATE', 422, 'Đơn giá giờ không được âm');
  }
  return parsed.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function formatHourlyRateOutput(rate: string | null): string | null {
  if (rate === null) return null;
  return money(rate).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function computeTimeBillableAmount(
  durationMinutes: number | null,
  hourlyRate: string | null,
  billable: boolean,
): string | null {
  if (!billable || durationMinutes === null || hourlyRate === null) return null;
  return new Decimal(durationMinutes)
    .mul(money(hourlyRate))
    .div(60)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
}

export function computeTimeHoursString(minutes: number): string {
  return new Decimal(minutes).div(60).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function sumTimeBillableAmounts(amounts: ReadonlyArray<string | null | undefined>): string {
  const valid: string[] = [];
  for (const amt of amounts) {
    if (amt !== null && amt !== undefined) valid.push(amt);
  }
  if (valid.length === 0) return '0.00';
  return sumDecimal(valid).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function projectTimeCsvCell(value: string | null): string {
  if (value === null) return '';
  let s = value;
  if (/^(?:[=+\-@\t\r]|\s+[=+\-@])/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsvSlug(name: string): string {
  const dashed = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-');
  let start = 0;
  let end = dashed.length;
  while (start < end && dashed[start] === '-') start++;
  while (end > start && dashed[end - 1] === '-') end--;
  const normalized = dashed.slice(start, end).slice(0, 40);
  let clippedEnd = normalized.length;
  while (clippedEnd > 0 && normalized[clippedEnd - 1] === '-') clippedEnd--;
  return normalized.slice(0, clippedEnd) || 'project';
}

function formatDateInZone(value: Date | string, timeZone: string): string {
  const date = toDate(value);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function formatDateTimeInZone(value: Date | string, timeZone: string): string {
  const date = toDate(value);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

async function loadTimeProject(
  trx: Trx,
  orgId: string,
  projectId: string,
  lock: boolean,
): Promise<ProjectRow> {
  try {
    return await loadProject(trx, orgId, projectId, lock);
  } catch (err) {
    if (err instanceof DomainError && err.code === 'PROJECT_NOT_FOUND') {
      const tmpl = await trx
        .selectFrom('crove_projects.project')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', '=', projectId)
        .where('is_template', '=', true)
        .executeTakeFirst();
      if (tmpl) {
        throw new DomainError('PROJECT_TEMPLATE_FORBIDDEN', 409, 'Không thể ghi giờ công trên mẫu dự án');
      }
    }
    throw err;
  }
}

function assertTimeProjectWritable(project: ProjectRow): void {
  assertNotArchived(project);
}

async function validateProjectTask(trx: Trx, orgId: string, projectId: string, taskId: string): Promise<{ id: string; title: string }> {
  const { rows } = await sql<{ id: string; title: string }>`
    SELECT t.id, t.title
      FROM crove_projects.project_task pt
      JOIN crove_kernel.task t
        ON t.org_id = pt.org_id
       AND t.id = pt.task_id
     WHERE pt.org_id = ${orgId}::uuid
       AND pt.project_id = ${projectId}::uuid
       AND pt.task_id = ${taskId}::uuid
     LIMIT 1`.execute(trx);
  const row = rows[0];
  if (!row) throw taskNotFound();
  return row;
}

async function fetchTimeEntryById(trx: Trx, orgId: string, entryId: string, lock: boolean): Promise<RawTimeEntryRow | undefined> {
  const { rows } = await sql<RawTimeEntryRow>`
    SELECT
      te.id,
      te.project_id,
      te.task_id,
      t.title AS task_title,
      (te.task_id IS NULL OR t.id IS NOT NULL) AS task_visible,
      te.user_id,
      te.started_at,
      te.ended_at,
      te.duration_minutes,
      te.billable,
      te.hourly_rate::text AS hourly_rate,
      te.note,
      te.created_at,
      te.updated_at
    FROM crove_projects.time_entry te
    LEFT JOIN crove_kernel.task t
      ON t.org_id = te.org_id
     AND t.id = te.task_id
    WHERE te.org_id = ${orgId}::uuid
      AND te.id = ${entryId}::uuid
    ${lock ? sql`FOR UPDATE OF te` : sql``}
    LIMIT 1`.execute(trx);
  return rows[0];
}

async function fetchActiveTimerRow(trx: Trx, orgId: string, userId: string, lock: boolean): Promise<RawTimeEntryRow | undefined> {
  const { rows } = await sql<RawTimeEntryRow>`
    SELECT
      te.id,
      te.project_id,
      te.task_id,
      t.title AS task_title,
      (te.task_id IS NULL OR t.id IS NOT NULL) AS task_visible,
      te.user_id,
      te.started_at,
      te.ended_at,
      te.duration_minutes,
      te.billable,
      te.hourly_rate::text AS hourly_rate,
      te.note,
      te.created_at,
      te.updated_at
    FROM crove_projects.time_entry te
    LEFT JOIN crove_kernel.task t
      ON t.org_id = te.org_id
     AND t.id = te.task_id
    WHERE te.org_id = ${orgId}::uuid
      AND te.user_id = ${userId}::uuid
      AND te.ended_at IS NULL
    ${lock ? sql`FOR UPDATE OF te` : sql``}
    LIMIT 1`.execute(trx);
  return rows[0];
}

function hydrateTimeEntries(
  rows: ReadonlyArray<RawTimeEntryRow>,
  profiles: ReadonlyMap<string, { displayName: string | null; email: string | null }>,
  callerUserId: string,
  role: Parameters<typeof canWriteProject>[0],
  projectStatusById: ReadonlyMap<string, { status: ProjectStatus; ownerUserId: string | null }>,
): ProjectTimeEntry[] {
  return rows.map((row) => {
    const projectMeta = projectStatusById.get(row.project_id);
    const canWrite = projectMeta ? canWriteProject(role, projectMeta.status) : false;
    const isManager = projectMeta ? canManageProject(role, callerUserId, projectMeta.ownerUserId) : false;
    const canManage = canWrite && (row.user_id === callerUserId || isManager);
    const rate = formatHourlyRateOutput(row.hourly_rate);
    const profile = row.user_id ? profiles.get(row.user_id) : undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      taskTitle: row.task_visible ? row.task_title : null,
      userId: row.user_id,
      userDisplayName: profile ? profile.displayName ?? profile.email ?? null : null,
      startedAt: toIso(row.started_at),
      endedAt: row.ended_at === null ? null : toIso(row.ended_at),
      durationMinutes: row.duration_minutes,
      billable: row.billable,
      hourlyRate: rate,
      billableAmount: computeTimeBillableAmount(row.duration_minutes, rate, row.billable),
      note: row.note,
      running: row.ended_at === null,
      canManage,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
    };
  });
}

async function hydrateSingleTimeEntry(
  trx: Trx,
  row: RawTimeEntryRow,
  callerUserId: string,
  role: Parameters<typeof canWriteProject>[0],
  project: ProjectRow,
): Promise<ProjectTimeEntry> {
  const profiles = row.user_id ? await memberProfilesMap(trx, [row.user_id]) : new Map();
  const metaMap = new Map([[project.id, { status: project.status, ownerUserId: project.owner_user_id }]]);
  return hydrateTimeEntries([row], profiles, callerUserId, role, metaMap)[0]!;
}

function computeStoppedDuration(startedAt: Date, now: Date): { endedAt: Date; durationMinutes: number; clampedToMax: boolean } {
  const startedMs = startedAt.getTime();
  const endedAt = now.getTime() < startedMs ? new Date(startedMs) : now;
  const rawMinutes = Math.round((endedAt.getTime() - startedMs) / 60_000);
  const clampedToMax = rawMinutes > PROJECT_TIME_DURATION_MAX;
  const durationMinutes = Math.min(PROJECT_TIME_DURATION_MAX, Math.max(PROJECT_TIME_DURATION_MIN, rawMinutes));
  return { endedAt, durationMinutes, clampedToMax };
}

export function validateEndedAndDuration(startedAt: Date, endedAt: Date, durationMinutesInput?: number): number {
  const rawMinutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000);
  if (rawMinutes > PROJECT_TIME_DURATION_MAX) {
    throw new DomainError(
      'TIME_ENTRY_DURATION_OUT_OF_RANGE',
      422,
      `Thời lượng mỗi lượt phải nằm trong khoảng ${PROJECT_TIME_DURATION_MIN} đến ${PROJECT_TIME_DURATION_MAX} phút`,
    );
  }
  const expectedMinutes = Math.max(PROJECT_TIME_DURATION_MIN, rawMinutes);
  if (durationMinutesInput !== undefined) {
    if (durationMinutesInput < PROJECT_TIME_DURATION_MIN || durationMinutesInput > PROJECT_TIME_DURATION_MAX) {
      throw new DomainError(
        'TIME_ENTRY_DURATION_OUT_OF_RANGE',
        422,
        `Thời lượng mỗi lượt phải nằm trong khoảng ${PROJECT_TIME_DURATION_MIN} đến ${PROJECT_TIME_DURATION_MAX} phút`,
      );
    }
    if (durationMinutesInput !== expectedMinutes) {
      throw new DomainError(
        'TIME_ENTRY_INVALID_RANGE',
        422,
        'Thời lượng phút không khớp với khoảng thời gian bắt đầu và kết thúc',
      );
    }
  }
  return expectedMinutes;
}

export function resolveLogTimestamps(startedAtIso: string, endedAtIso?: string, durationMinutesInput?: number): {
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
} {
  const startedAt = new Date(startedAtIso);
  if (Number.isNaN(startedAt.getTime())) {
    throw new DomainError('TIME_ENTRY_INVALID_RANGE', 422, 'Thời điểm bắt đầu không hợp lệ');
  }
  if (endedAtIso !== undefined) {
    const endedAt = new Date(endedAtIso);
    if (Number.isNaN(endedAt.getTime()) || endedAt.getTime() < startedAt.getTime()) {
      throw new DomainError('TIME_ENTRY_INVALID_RANGE', 422, 'Thời điểm kết thúc phải từ thời điểm bắt đầu trở đi');
    }
    const durationMinutes = validateEndedAndDuration(startedAt, endedAt, durationMinutesInput);
    return { startedAt, endedAt, durationMinutes };
  }
  if (durationMinutesInput === undefined) {
    throw new DomainError('TIME_ENTRY_INVALID_RANGE', 422, 'Hãy nhập thời lượng hoặc thời điểm kết thúc');
  }
  if (durationMinutesInput < PROJECT_TIME_DURATION_MIN || durationMinutesInput > PROJECT_TIME_DURATION_MAX) {
    throw new DomainError(
      'TIME_ENTRY_DURATION_OUT_OF_RANGE',
      422,
      `Thời lượng mỗi lượt phải nằm trong khoảng ${PROJECT_TIME_DURATION_MIN} đến ${PROJECT_TIME_DURATION_MAX} phút`,
    );
  }
  const endedAt = new Date(startedAt.getTime() + durationMinutesInput * 60_000);
  return { startedAt, endedAt, durationMinutes: durationMinutesInput };
}

export function resolveUpdatedCompletedTimestamps(
  existingStartedAt: Date,
  existingEndedAt: Date,
  existingDurationMinutes: number,
  input: {
    startedAt?: string | undefined;
    endedAt?: string | undefined;
    durationMinutes?: number | undefined;
  },
): { startedAt: Date; endedAt: Date; durationMinutes: number } {
  const startedAt = input.startedAt !== undefined ? new Date(input.startedAt) : existingStartedAt;
  if (Number.isNaN(startedAt.getTime())) {
    throw new DomainError('TIME_ENTRY_INVALID_RANGE', 422, 'Thời điểm bắt đầu không hợp lệ');
  }
  if (input.endedAt !== undefined) {
    const endedAt = new Date(input.endedAt);
    if (Number.isNaN(endedAt.getTime()) || endedAt.getTime() < startedAt.getTime()) {
      throw new DomainError('TIME_ENTRY_INVALID_RANGE', 422, 'Thời điểm kết thúc phải từ thời điểm bắt đầu trở đi');
    }
    const durationMinutes = validateEndedAndDuration(startedAt, endedAt, input.durationMinutes);
    return { startedAt, endedAt, durationMinutes };
  }
  if (input.durationMinutes !== undefined) {
    if (input.durationMinutes < PROJECT_TIME_DURATION_MIN || input.durationMinutes > PROJECT_TIME_DURATION_MAX) {
      throw new DomainError(
        'TIME_ENTRY_DURATION_OUT_OF_RANGE',
        422,
        `Thời lượng mỗi lượt phải nằm trong khoảng ${PROJECT_TIME_DURATION_MIN} đến ${PROJECT_TIME_DURATION_MAX} phút`,
      );
    }
    return {
      startedAt,
      endedAt: new Date(startedAt.getTime() + input.durationMinutes * 60_000),
      durationMinutes: input.durationMinutes,
    };
  }
  if (input.startedAt !== undefined) {
    return {
      startedAt,
      endedAt: new Date(startedAt.getTime() + existingDurationMinutes * 60_000),
      durationMinutes: existingDurationMinutes,
    };
  }
  return {
    startedAt,
    endedAt: existingEndedAt,
    durationMinutes: existingDurationMinutes,
  };
}

async function lockProjectsOrdered(
  trx: Trx,
  orgId: string,
  projectIds: ReadonlyArray<string>,
): Promise<Map<string, ProjectRow>> {
  const uniqueSorted = [...new Set(projectIds)].sort();
  const map = new Map<string, ProjectRow>();
  for (const projectId of uniqueSorted) {
    const project = await loadTimeProject(trx, orgId, projectId, true);
    map.set(projectId, project);
  }
  return map;
}

export const projectTimeStart = defineCommand({
  name: 'projects.time.start',
  input: zProjectTimeStartInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'time_entry', [...TIME_ENTRY_ALL_COLUMNS])],
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<ProjectTimeStartResult> => {
    const userId = userOf(ctx.actor);
    const rate = normalizeHourlyRateInput(input.hourlyRate) ?? null;
    const note = normalizeNoteInput(input.note) ?? null;

    const peekRunning = await ctx.trx
      .selectFrom('crove_projects.time_entry')
      .select(['id', 'project_id'])
      .where('org_id', '=', ctx.orgId)
      .where('user_id', '=', userId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();

    const projectIdsToLock = [input.projectId, ...(peekRunning ? [peekRunning.project_id] : [])];
    const lockedProjects = await lockProjectsOrdered(ctx.trx, ctx.orgId, projectIdsToLock);
    const targetProject = lockedProjects.get(input.projectId)!;
    assertTimeProjectWritable(targetProject);

    if (input.taskId !== undefined && input.taskId !== null) {
      await validateProjectTask(ctx.trx, ctx.orgId, targetProject.id, input.taskId);
    }

    const existingRunning = await fetchActiveTimerRow(ctx.trx, ctx.orgId, userId, true);
    let stoppedEntry: ProjectTimeEntry | null = null;

    if (existingRunning) {
      if (!input.stopExisting) {
        const runningProject =
          lockedProjects.get(existingRunning.project_id) ??
          (await loadProject(ctx.trx, ctx.orgId, existingRunning.project_id, false));
        throw new DomainError(
          'TIMER_ALREADY_RUNNING',
          409,
          'Bạn đang có đồng hồ bấm giờ đang chạy; hãy dừng đồng hồ hiện tại trước khi bắt đầu lượt mới',
          {
            entryId: existingRunning.id,
            projectId: existingRunning.project_id,
            projectName: runningProject.name,
            taskId: existingRunning.task_visible ? existingRunning.task_id : null,
            taskTitle: existingRunning.task_visible ? existingRunning.task_title : null,
            startedAt: toIso(existingRunning.started_at),
          },
        );
      }

      let runningProject = lockedProjects.get(existingRunning.project_id);
      if (!runningProject) {
        if (existingRunning.project_id < targetProject.id) {
          throw new DomainError('CONFLICT', 409, 'Trạng thái đồng hồ bấm giờ vừa thay đổi đồng thời; vui lòng thử lại');
        }
        runningProject = await loadTimeProject(ctx.trx, ctx.orgId, existingRunning.project_id, true);
      }

      assertTimeProjectWritable(runningProject);
      const stoppedTiming = computeStoppedDuration(toDate(existingRunning.started_at), ctx.now);
      const updatedOld = await ctx.trx
        .updateTable('crove_projects.time_entry')
        .set({
          ended_at: stoppedTiming.endedAt,
          duration_minutes: stoppedTiming.durationMinutes,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existingRunning.id)
        .returning([
          'id',
          'project_id',
          'task_id',
          'user_id',
          'started_at',
          'ended_at',
          'duration_minutes',
          'billable',
          'hourly_rate',
          'note',
          'created_at',
          'updated_at',
        ])
        .executeTakeFirstOrThrow();

      stoppedEntry = await hydrateSingleTimeEntry(
        ctx.trx,
        {
          ...existingRunning,
          ...updatedOld,
          hourly_rate: updatedOld.hourly_rate === null ? null : String(updatedOld.hourly_rate),
        },
        userId,
        ctx.role,
        runningProject,
      );

      await ctx.emit('projects.time.stopped', {
        projectId: runningProject.id,
        entryId: updatedOld.id,
        taskId: updatedOld.task_id,
        durationMinutes: stoppedTiming.durationMinutes,
        switched: true,
      });
      await ctx.activity('projects.project', runningProject.id, 'projects.time.stopped', 'Dừng bấm giờ công việc');
    }

    let insertedId: string;
    try {
      const inserted = await ctx.trx
        .insertInto('crove_projects.time_entry')
        .values({
          org_id: ctx.orgId,
          project_id: targetProject.id,
          task_id: input.taskId ?? null,
          user_id: userId,
          started_at: ctx.now,
          ended_at: null,
          duration_minutes: null,
          billable: input.billable,
          hourly_rate: rate,
          note,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .returning(['id'])
        .executeTakeFirstOrThrow();
      insertedId = inserted.id;
    } catch (err) {
      if (pgErrorCode(err) === '23505' && pgErrorConstraint(err) === 'time_entry_running_uq') {
        throw new DomainError(
          'TIMER_ALREADY_RUNNING',
          409,
          'Bạn đang có đồng hồ bấm giờ đang chạy; hãy dừng đồng hồ hiện tại trước khi bắt đầu lượt mới',
        );
      }
      throw err;
    }

    const createdRow = await fetchTimeEntryById(ctx.trx, ctx.orgId, insertedId, false);
    const entry = await hydrateSingleTimeEntry(ctx.trx, createdRow!, userId, ctx.role, targetProject);

    await ctx.emit('projects.time.started', {
      projectId: targetProject.id,
      entryId: entry.id,
      taskId: entry.taskId,
      billable: entry.billable,
      stoppedEntryId: stoppedEntry?.id ?? null,
    });
    await ctx.activity('projects.project', targetProject.id, 'projects.time.started', 'Bắt đầu bấm giờ công việc');
    ctx.audit({
      projectId: targetProject.id,
      entryId: entry.id,
      taskId: entry.taskId,
      billable: entry.billable,
      hourlyRate: entry.hourlyRate,
      stoppedEntryId: stoppedEntry?.id ?? null,
      note: auditValue(TIME_ENTRY, 'note', note),
    });

    return { entry, stoppedEntry };
  },
});

export const projectTimeStop = defineCommand({
  name: 'projects.time.stop',
  input: zProjectTimeStopInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'time_entry', ['ended_at', 'duration_minutes', 'note', 'billable', 'hourly_rate', 'updated_at'])],
  target: (input) => (input.projectId ? { type: 'projects.project', id: input.projectId } : null),
  handler: async (ctx, input): Promise<ProjectTimeStopResult> => {
    const userId = userOf(ctx.actor);
    const hintedProject =
      input.projectId !== undefined ? await loadTimeProject(ctx.trx, ctx.orgId, input.projectId, true) : null;
    if (hintedProject) assertTimeProjectWritable(hintedProject);

    let peekProjectId: string | undefined;
    if (input.entryId !== undefined) {
      const candidate = await ctx.trx
        .selectFrom('crove_projects.time_entry')
        .select(['id', 'project_id', 'ended_at'])
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', input.entryId)
        .executeTakeFirst();
      if (!candidate || (input.projectId !== undefined && candidate.project_id !== input.projectId)) {
        throw new DomainError('TIME_ENTRY_NOT_FOUND', 404, 'Không tìm thấy lượt ghi giờ này');
      }
      if (candidate.ended_at !== null) {
        throw new DomainError('TIME_ENTRY_NOT_RUNNING', 409, 'Đồng hồ bấm giờ này đã dừng trước đó');
      }
      peekProjectId = candidate.project_id;
    } else {
      let q = ctx.trx
        .selectFrom('crove_projects.time_entry')
        .select(['id', 'project_id'])
        .where('org_id', '=', ctx.orgId)
        .where('user_id', '=', userId)
        .where('ended_at', 'is', null);
      if (input.projectId !== undefined) q = q.where('project_id', '=', input.projectId);
      const candidate = await q.executeTakeFirst();
      if (!candidate) {
        throw new DomainError('TIME_ENTRY_NOT_RUNNING', 409, 'Hiện không có đồng hồ bấm giờ nào đang chạy');
      }
      peekProjectId = candidate.project_id;
    }

    const project = hintedProject ?? (await loadTimeProject(ctx.trx, ctx.orgId, peekProjectId, true));
    assertTimeProjectWritable(project);

    const existing = input.entryId !== undefined
      ? await fetchTimeEntryById(ctx.trx, ctx.orgId, input.entryId, true)
      : await fetchActiveTimerRow(ctx.trx, ctx.orgId, userId, true);

    if (!existing || existing.project_id !== project.id || (input.projectId !== undefined && existing.project_id !== input.projectId)) {
      throw input.entryId !== undefined
        ? new DomainError('TIME_ENTRY_NOT_FOUND', 404, 'Không tìm thấy lượt ghi giờ này')
        : new DomainError('TIME_ENTRY_NOT_RUNNING', 409, 'Hiện không có đồng hồ bấm giờ nào đang chạy');
    }
    if (existing.ended_at !== null) {
      throw new DomainError('TIME_ENTRY_NOT_RUNNING', 409, 'Đồng hồ bấm giờ này đã dừng trước đó');
    }
    if (existing.task_id !== null && !existing.task_visible) {
      throw taskNotFound();
    }
    if (existing.user_id !== userId && !canManageProject(ctx.role, userId, project.owner_user_id)) {
      throw new DomainError('FORBIDDEN', 403, 'Bạn chỉ có thể dừng đồng hồ của chính mình hoặc khi phụ trách dự án');
    }

    const nextBillable = input.billable ?? existing.billable;
    const nextHourlyRate =
      input.hourlyRate !== undefined ? normalizeHourlyRateInput(input.hourlyRate) ?? null : existing.hourly_rate;
    const nextNote = input.note !== undefined ? normalizeNoteInput(input.note) ?? null : existing.note;

    const timing = computeStoppedDuration(toDate(existing.started_at), ctx.now);

    await ctx.trx
      .updateTable('crove_projects.time_entry')
      .set({
        ended_at: timing.endedAt,
        duration_minutes: timing.durationMinutes,
        billable: nextBillable,
        hourly_rate: nextHourlyRate,
        note: nextNote,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    const updated = await fetchTimeEntryById(ctx.trx, ctx.orgId, existing.id, false);
    const entry = await hydrateSingleTimeEntry(ctx.trx, updated!, userId, ctx.role, project);

    await ctx.emit('projects.time.stopped', {
      projectId: project.id,
      entryId: entry.id,
      taskId: entry.taskId,
      durationMinutes: timing.durationMinutes,
      clampedToMax: timing.clampedToMax,
    });
    await ctx.activity('projects.project', project.id, 'projects.time.stopped', 'Dừng bấm giờ công việc');
    ctx.audit({
      projectId: project.id,
      entryId: entry.id,
      taskId: entry.taskId,
      durationMinutes: timing.durationMinutes,
      billable: entry.billable,
      hourlyRate: entry.hourlyRate,
      clampedToMax: timing.clampedToMax,
      note: auditValue(TIME_ENTRY, 'note', nextNote),
    });

    return { entry, clampedToMax: timing.clampedToMax };
  },
});

export const projectTimeLog = defineCommand({
  name: 'projects.time.log',
  input: zProjectTimeLogInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'time_entry', [...TIME_ENTRY_ALL_COLUMNS])],
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<ProjectTimeMutateResult> => {
    const userId = userOf(ctx.actor);
    const project = await loadTimeProject(ctx.trx, ctx.orgId, input.projectId, true);
    assertTimeProjectWritable(project);

    if (input.taskId !== undefined && input.taskId !== null) {
      await validateProjectTask(ctx.trx, ctx.orgId, project.id, input.taskId);
    }

    const timing = resolveLogTimestamps(input.startedAt, input.endedAt, input.durationMinutes);
    const rate = normalizeHourlyRateInput(input.hourlyRate) ?? null;
    const note = normalizeNoteInput(input.note) ?? null;

    const inserted = await ctx.trx
      .insertInto('crove_projects.time_entry')
      .values({
        org_id: ctx.orgId,
        project_id: project.id,
        task_id: input.taskId ?? null,
        user_id: userId,
        started_at: timing.startedAt,
        ended_at: timing.endedAt,
        duration_minutes: timing.durationMinutes,
        billable: input.billable,
        hourly_rate: rate,
        note,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    const row = await fetchTimeEntryById(ctx.trx, ctx.orgId, inserted.id, false);
    const entry = await hydrateSingleTimeEntry(ctx.trx, row!, userId, ctx.role, project);

    await ctx.emit('projects.time.logged', {
      projectId: project.id,
      entryId: entry.id,
      taskId: entry.taskId,
      durationMinutes: timing.durationMinutes,
      billable: entry.billable,
    });
    await ctx.activity('projects.project', project.id, 'projects.time.logged', 'Ghi nhận giờ làm công việc');
    ctx.audit({
      projectId: project.id,
      entryId: entry.id,
      taskId: entry.taskId,
      durationMinutes: timing.durationMinutes,
      billable: entry.billable,
      hourlyRate: entry.hourlyRate,
      note: auditValue(TIME_ENTRY, 'note', note),
    });

    return { entry };
  },
});

export const projectTimeUpdate = defineCommand({
  name: 'projects.time.update',
  input: zProjectTimeUpdateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'time_entry', ['task_id', 'started_at', 'ended_at', 'duration_minutes', 'billable', 'hourly_rate', 'note', 'updated_at'])],
  target: (input) => (input.projectId ? { type: 'projects.project', id: input.projectId } : null),
  handler: async (ctx, input): Promise<ProjectTimeMutateResult> => {
    const userId = userOf(ctx.actor);
    const hintedProject =
      input.projectId !== undefined ? await loadTimeProject(ctx.trx, ctx.orgId, input.projectId, true) : null;
    if (hintedProject) assertTimeProjectWritable(hintedProject);

    const peek = await ctx.trx
      .selectFrom('crove_projects.time_entry')
      .select(['id', 'project_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.entryId)
      .executeTakeFirst();
    if (!peek || (input.projectId !== undefined && peek.project_id !== input.projectId)) {
      throw new DomainError('TIME_ENTRY_NOT_FOUND', 404, 'Không tìm thấy lượt ghi giờ này');
    }

    const project = hintedProject ?? (await loadTimeProject(ctx.trx, ctx.orgId, peek.project_id, true));
    assertTimeProjectWritable(project);

    const existing = await fetchTimeEntryById(ctx.trx, ctx.orgId, input.entryId, true);
    if (!existing || existing.project_id !== project.id) {
      throw new DomainError('TIME_ENTRY_NOT_FOUND', 404, 'Không tìm thấy lượt ghi giờ này');
    }
    if (existing.task_id !== null && !existing.task_visible) {
      throw taskNotFound();
    }
    if (existing.user_id !== userId && !canManageProject(ctx.role, userId, project.owner_user_id)) {
      throw new DomainError('FORBIDDEN', 403, 'Bạn chỉ có thể sửa lượt ghi giờ của chính mình hoặc khi phụ trách dự án');
    }

    let nextTaskId = existing.task_id;
    if (input.taskId !== undefined) {
      if (input.taskId === null) {
        nextTaskId = null;
      } else {
        await validateProjectTask(ctx.trx, ctx.orgId, project.id, input.taskId);
        nextTaskId = input.taskId;
      }
    }

    const nextBillable = input.billable ?? existing.billable;
    const nextHourlyRate =
      input.hourlyRate !== undefined ? normalizeHourlyRateInput(input.hourlyRate) ?? null : existing.hourly_rate;
    const nextNote = input.note !== undefined ? normalizeNoteInput(input.note) ?? null : existing.note;

    let nextStartedAt = toDate(existing.started_at);
    let nextEndedAt: Date | null = existing.ended_at === null ? null : toDate(existing.ended_at);
    let nextDurationMinutes: number | null = existing.duration_minutes;

    if (existing.ended_at === null) {
      if (input.endedAt !== undefined || input.durationMinutes !== undefined) {
        throw new DomainError(
          'TIME_ENTRY_RUNNING',
          409,
          'Đồng hồ này đang chạy; hãy dừng bấm giờ trước khi chỉnh thời lượng hoặc giờ kết thúc',
        );
      }
      if (input.startedAt !== undefined) {
        const parsedStart = new Date(input.startedAt);
        if (Number.isNaN(parsedStart.getTime()) || parsedStart.getTime() > ctx.now.getTime()) {
          throw new DomainError('TIME_ENTRY_INVALID_RANGE', 422, 'Thời điểm bắt đầu của đồng hồ đang chạy không được ở tương lai');
        }
        nextStartedAt = parsedStart;
      }
    } else {
      const resolved = resolveUpdatedCompletedTimestamps(
        nextStartedAt,
        nextEndedAt!,
        existing.duration_minutes ?? PROJECT_TIME_DURATION_MIN,
        {
          startedAt: input.startedAt,
          endedAt: input.endedAt,
          durationMinutes: input.durationMinutes,
        },
      );
      nextStartedAt = resolved.startedAt;
      nextEndedAt = resolved.endedAt;
      nextDurationMinutes = resolved.durationMinutes;
    }

    await ctx.trx
      .updateTable('crove_projects.time_entry')
      .set({
        task_id: nextTaskId,
        started_at: nextStartedAt,
        ended_at: nextEndedAt,
        duration_minutes: nextDurationMinutes,
        billable: nextBillable,
        hourly_rate: nextHourlyRate,
        note: nextNote,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    const updated = await fetchTimeEntryById(ctx.trx, ctx.orgId, existing.id, false);
    const entry = await hydrateSingleTimeEntry(ctx.trx, updated!, userId, ctx.role, project);

    await ctx.emit('projects.time.updated', {
      projectId: project.id,
      entryId: entry.id,
      taskId: entry.taskId,
      durationMinutes: entry.durationMinutes,
      billable: entry.billable,
    });
    await ctx.activity('projects.project', project.id, 'projects.time.updated', 'Cập nhật lượt ghi giờ công');
    ctx.audit({
      projectId: project.id,
      entryId: entry.id,
      taskId: entry.taskId,
      durationMinutes: entry.durationMinutes,
      billable: entry.billable,
      hourlyRate: entry.hourlyRate,
      note: auditValue(TIME_ENTRY, 'note', nextNote),
    });

    return { entry };
  },
});

export const projectTimeDelete = defineCommand({
  name: 'projects.time.delete',
  input: zProjectTimeDeleteInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [tableWrite(TABLES, 'crove_projects', 'time_entry', ['org_id', 'id'])],
  target: (input) => (input.projectId ? { type: 'projects.project', id: input.projectId } : null),
  handler: async (ctx, input): Promise<ProjectTimeDeleteResult> => {
    const userId = userOf(ctx.actor);
    const hintedProject =
      input.projectId !== undefined ? await loadTimeProject(ctx.trx, ctx.orgId, input.projectId, true) : null;
    if (hintedProject) assertTimeProjectWritable(hintedProject);

    const peek = await ctx.trx
      .selectFrom('crove_projects.time_entry')
      .select(['id', 'project_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.entryId)
      .executeTakeFirst();
    if (!peek || (input.projectId !== undefined && peek.project_id !== input.projectId)) {
      throw new DomainError('TIME_ENTRY_NOT_FOUND', 404, 'Không tìm thấy lượt ghi giờ này');
    }

    const project = hintedProject ?? (await loadTimeProject(ctx.trx, ctx.orgId, peek.project_id, true));
    assertTimeProjectWritable(project);

    const existing = await fetchTimeEntryById(ctx.trx, ctx.orgId, input.entryId, true);
    if (!existing || existing.project_id !== project.id) {
      throw new DomainError('TIME_ENTRY_NOT_FOUND', 404, 'Không tìm thấy lượt ghi giờ này');
    }
    if (existing.task_id !== null && !existing.task_visible) {
      throw taskNotFound();
    }
    if (existing.user_id !== userId && !canManageProject(ctx.role, userId, project.owner_user_id)) {
      throw new DomainError('FORBIDDEN', 403, 'Bạn chỉ có thể xóa lượt ghi giờ của chính mình hoặc khi phụ trách dự án');
    }

    await ctx.trx
      .deleteFrom('crove_projects.time_entry')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    await ctx.emit('projects.time.deleted', {
      projectId: project.id,
      entryId: existing.id,
      taskId: existing.task_id,
    });
    await ctx.activity('projects.project', project.id, 'projects.time.deleted', 'Xóa lượt ghi giờ công');
    ctx.audit({
      projectId: project.id,
      entryId: existing.id,
      taskId: existing.task_id,
      durationMinutes: existing.duration_minutes,
    });

    return {
      deleted: true,
      entryId: existing.id,
      projectId: project.id,
    };
  },
});

function buildSummaryFilterSql(
  orgId: string,
  projectId: string,
  filter: {
    taskId?: string | undefined;
    userId?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    billableOnly?: boolean | undefined;
    timeZone: string;
  },
) {
  const parts = [
    sql`te.org_id = ${orgId}::uuid`,
    sql`te.project_id = ${projectId}::uuid`,
    sql`(te.task_id IS NULL OR EXISTS (SELECT 1 FROM crove_kernel.task t WHERE t.org_id = te.org_id AND t.id = te.task_id))`,
  ];
  if (filter.taskId !== undefined) {
    parts.push(sql`te.task_id = ${filter.taskId}::uuid`);
  }
  if (filter.userId !== undefined) {
    parts.push(sql`te.user_id = ${filter.userId}::uuid`);
  }
  if (filter.from !== undefined) {
    const fromStart = new Date(zonedInstant(filter.timeZone, filter.from, 0));
    parts.push(sql`te.started_at >= ${fromStart}`);
  }
  if (filter.to !== undefined) {
    const [y, m, d] = filter.to.split('-').map(Number) as [number, number, number];
    const nextDate = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
    const toEndExclusive = new Date(zonedInstant(filter.timeZone, nextDate, 0));
    parts.push(sql`te.started_at < ${toEndExclusive}`);
  }
  if (filter.billableOnly) {
    parts.push(sql`te.billable = true`);
  }
  return sql.join(parts, sql` AND `);
}

interface RawAggregateGroupRow {
  task_id: string | null;
  task_title: string | null;
  user_id: string | null;
  entry_count: number;
  total_minutes: number;
  billable_minutes: number;
  billable_amount: string;
}

function makeTotalsFromBuckets(
  buckets: ReadonlyArray<{
    entryCount: number;
    totalMinutes: number;
    billableMinutes: number;
    billableAmount: string;
  }>,
): ProjectTimeTotals {
  let entryCount = 0;
  let totalMinutes = 0;
  let billableMinutes = 0;
  const amounts: string[] = [];
  for (const b of buckets) {
    entryCount += b.entryCount;
    totalMinutes += b.totalMinutes;
    billableMinutes += b.billableMinutes;
    amounts.push(b.billableAmount);
  }
  const nonBillableMinutes = Math.max(0, totalMinutes - billableMinutes);
  return {
    entryCount,
    totalMinutes,
    billableMinutes,
    nonBillableMinutes,
    totalHours: computeTimeHoursString(totalMinutes),
    billableHours: computeTimeHoursString(billableMinutes),
    nonBillableHours: computeTimeHoursString(nonBillableMinutes),
    billableAmount: sumTimeBillableAmounts(amounts),
  };
}

export const projectTimeSummary = defineQuery({
  name: 'projects.time.summary',
  input: zProjectTimeSummaryInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectTimeSummaryResult> => {
    const callerUserId = userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);

    if (input.taskId !== undefined) {
      await validateProjectTask(ctx.trx, ctx.orgId, project.id, input.taskId);
    }

    const whereClause = buildSummaryFilterSql(ctx.orgId, project.id, {
      taskId: input.taskId,
      userId: input.userId,
      from: input.from,
      to: input.to,
      billableOnly: input.billableOnly,
      timeZone: input.timeZone ?? DEFAULT_TIME_ZONE,
    });

    const [{ rows: countRows }, { rows: groupRows }, { rows: entryRows }, activeRow] = await Promise.all([
      sql<{ total_entries: number }>`
        SELECT pg_catalog.count(*)::int AS total_entries
          FROM crove_projects.time_entry te
         WHERE ${whereClause}`.execute(ctx.trx),
      sql<RawAggregateGroupRow>`
        SELECT
          te.task_id,
          t.title AS task_title,
          te.user_id,
          pg_catalog.count(*)::int AS entry_count,
          COALESCE(pg_catalog.sum(te.duration_minutes), 0)::int AS total_minutes,
          COALESCE(pg_catalog.sum(CASE WHEN te.billable THEN te.duration_minutes ELSE 0 END), 0)::int AS billable_minutes,
          COALESCE(
            pg_catalog.sum(
              CASE
                WHEN te.billable AND te.hourly_rate IS NOT NULL
                THEN pg_catalog.round((te.duration_minutes::numeric * te.hourly_rate) / 60, 2)
                ELSE 0
              END
            ),
            0
          )::text AS billable_amount
        FROM crove_projects.time_entry te
        LEFT JOIN crove_kernel.task t
          ON t.org_id = te.org_id
         AND t.id = te.task_id
        WHERE ${whereClause}
          AND te.ended_at IS NOT NULL
          AND te.duration_minutes IS NOT NULL
        GROUP BY te.task_id, t.title, te.user_id`.execute(ctx.trx),
      sql<RawTimeEntryRow>`
        SELECT
          te.id,
          te.project_id,
          te.task_id,
          t.title AS task_title,
          (te.task_id IS NULL OR t.id IS NOT NULL) AS task_visible,
          te.user_id,
          te.started_at,
          te.ended_at,
          te.duration_minutes,
          te.billable,
          te.hourly_rate::text AS hourly_rate,
          te.note,
          te.created_at,
          te.updated_at
        FROM crove_projects.time_entry te
        LEFT JOIN crove_kernel.task t
          ON t.org_id = te.org_id
         AND t.id = te.task_id
        WHERE ${whereClause}
        ORDER BY (te.ended_at IS NULL) DESC, te.started_at DESC, te.id DESC
        LIMIT ${input.limit ?? PROJECT_TIME_ENTRIES_PAGE_LIMIT}
        OFFSET ${input.offset ?? 0}`.execute(ctx.trx),
      fetchActiveTimerRow(ctx.trx, ctx.orgId, callerUserId, false),
    ]);

    let activeTimer: ProjectTimeActiveTimer | null = null;
    const activeProjects = new Map<string, { name: string; status: ProjectStatus; ownerUserId: string | null }>([
      [project.id, { name: project.name, status: project.status, ownerUserId: project.owner_user_id }],
    ]);

    if (activeRow) {
      let runningProjectMeta = activeProjects.get(activeRow.project_id);
      if (!runningProjectMeta) {
        try {
          const otherProject = await loadProject(ctx.trx, ctx.orgId, activeRow.project_id, false);
          runningProjectMeta = {
            name: otherProject.name,
            status: otherProject.status,
            ownerUserId: otherProject.owner_user_id,
          };
          activeProjects.set(activeRow.project_id, runningProjectMeta);
        } catch (err) {
          if (!(err instanceof DomainError && err.code === 'PROJECT_NOT_FOUND')) throw err;
        }
      }
      if (runningProjectMeta) {
        const profilesForActive = await memberProfilesMap(ctx.trx, [callerUserId]);
        const hydratedActive = hydrateTimeEntries(
          [activeRow],
          profilesForActive,
          callerUserId,
          ctx.role,
          activeProjects,
        )[0]!;
        activeTimer = {
          entry: hydratedActive,
          projectName: runningProjectMeta.name,
        };
      }
    }

    const userIdsToLoad: string[] = [];
    for (const row of entryRows) {
      if (row.user_id) userIdsToLoad.push(row.user_id);
    }
    for (const grp of groupRows) {
      if (grp.user_id) userIdsToLoad.push(grp.user_id);
    }
    const profiles = await memberProfilesMap(ctx.trx, userIdsToLoad);

    const groupItems = groupRows.map((g) => ({
      taskId: g.task_id,
      taskTitle: g.task_title,
      userId: g.user_id,
      entryCount: Number(g.entry_count),
      totalMinutes: Number(g.total_minutes),
      billableMinutes: Number(g.billable_minutes),
      billableAmount: g.billable_amount,
    }));

    const totals = makeTotalsFromBuckets(groupItems);

    const byTaskMap = new Map<string, { taskId: string | null; taskTitle: string | null; items: typeof groupItems }>();
    for (const g of groupItems) {
      const key = g.taskId ?? '__project__';
      let bucket = byTaskMap.get(key);
      if (!bucket) {
        bucket = { taskId: g.taskId, taskTitle: g.taskTitle, items: [] };
        byTaskMap.set(key, bucket);
      }
      bucket.items.push(g);
    }
    const byTask: ProjectTimeTaskSummary[] = [...byTaskMap.values()]
      .map((b) => ({
        taskId: b.taskId,
        taskTitle: b.taskTitle,
        totals: makeTotalsFromBuckets(b.items),
      }))
      .sort((a, b) => b.totals.totalMinutes - a.totals.totalMinutes || (a.taskTitle ?? '').localeCompare(b.taskTitle ?? ''));

    const byMemberMap = new Map<string, { userId: string | null; items: typeof groupItems }>();
    for (const g of groupItems) {
      const key = g.userId ?? '__former__';
      let bucket = byMemberMap.get(key);
      if (!bucket) {
        bucket = { userId: g.userId, items: [] };
        byMemberMap.set(key, bucket);
      }
      bucket.items.push(g);
    }
    const byMember: ProjectTimeMemberSummary[] = [...byMemberMap.values()]
      .map((b) => {
        const prof = b.userId ? profiles.get(b.userId) : undefined;
        return {
          userId: b.userId,
          displayName: prof ? prof.displayName ?? prof.email ?? null : null,
          totals: makeTotalsFromBuckets(b.items),
        };
      })
      .sort((a, b) => b.totals.totalMinutes - a.totals.totalMinutes || (a.displayName ?? '').localeCompare(b.displayName ?? ''));

    const entries = hydrateTimeEntries(entryRows, profiles, callerUserId, ctx.role, activeProjects);
    const totalEntries = Number(countRows[0]?.total_entries ?? 0);
    const offset = input.offset ?? 0;

    return {
      projectId: project.id,
      timeZone: input.timeZone ?? DEFAULT_TIME_ZONE,
      canWrite: canWriteProject(ctx.role, project.status),
      canManageProject: canManageProject(ctx.role, callerUserId, project.owner_user_id),
      activeTimer,
      totals,
      byTask,
      byMember,
      entries,
      totalEntries,
      hasMore: offset + entries.length < totalEntries,
    };
  },
});

export const projectTimeExportCsv = defineQuery({
  name: 'projects.time.export_csv',
  input: zProjectTimeExportCsvInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectTimeExportCsvResult> => {
    userOf(ctx.actor);
    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);

    if (input.taskId !== undefined) {
      await validateProjectTask(ctx.trx, ctx.orgId, project.id, input.taskId);
    }

    const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
    const whereClause = buildSummaryFilterSql(ctx.orgId, project.id, {
      taskId: input.taskId,
      userId: input.userId,
      from: input.from,
      to: input.to,
      billableOnly: input.billableOnly,
      timeZone,
    });

    const { rows: rawRows } = await sql<RawTimeEntryRow>`
      SELECT
        te.id,
        te.project_id,
        te.task_id,
        t.title AS task_title,
        (te.task_id IS NULL OR t.id IS NOT NULL) AS task_visible,
        te.user_id,
        te.started_at,
        te.ended_at,
        te.duration_minutes,
        te.billable,
        te.hourly_rate::text AS hourly_rate,
        te.note,
        te.created_at,
        te.updated_at
      FROM crove_projects.time_entry te
      LEFT JOIN crove_kernel.task t
        ON t.org_id = te.org_id
       AND t.id = te.task_id
      WHERE ${whereClause}
      ORDER BY te.started_at DESC, te.id DESC
      LIMIT ${PROJECT_TIME_EXPORT_LIMIT + 1}`.execute(ctx.trx);

    const truncated = rawRows.length > PROJECT_TIME_EXPORT_LIMIT;
    const rows = truncated ? rawRows.slice(0, PROJECT_TIME_EXPORT_LIMIT) : rawRows;

    const userIds = rows.map((r) => r.user_id).filter((id): id is string => id !== null);
    const profiles = await memberProfilesMap(ctx.trx, userIds);

    const csvLines = rows.map((row) => {
      const rate = formatHourlyRateOutput(row.hourly_rate);
      const amount = computeTimeBillableAmount(row.duration_minutes, rate, row.billable);
      const hours = row.duration_minutes === null ? null : computeTimeHoursString(row.duration_minutes);
      const profile = row.user_id ? profiles.get(row.user_id) : undefined;
      const memberLabel =
        row.user_id === null
          ? 'Thành viên đã rời tổ chức'
          : profile?.displayName ?? profile?.email ?? row.user_id;
      const taskLabel = row.task_id === null ? 'Chung dự án' : row.task_visible ? row.task_title : null;
      const statusLabel = row.ended_at === null ? 'Đang bấm giờ' : 'Hoàn tất';

      return [
        formatDateInZone(row.started_at, timeZone),
        formatDateTimeInZone(row.started_at, timeZone),
        row.ended_at === null ? null : formatDateTimeInZone(row.ended_at, timeZone),
        taskLabel,
        memberLabel,
        row.duration_minutes === null ? null : String(row.duration_minutes),
        hours,
        row.billable ? 'Có' : 'Không',
        rate,
        amount,
        row.note,
        statusLabel,
      ]
        .map(projectTimeCsvCell)
        .join(',');
    });

    const todayLabel = formatDateInZone(new Date(), timeZone);
    const filename = `ludy-gio-lam-${buildCsvSlug(project.name)}-${todayLabel}.csv`;
    const csv = `\uFEFF${[PROJECT_TIME_CSV_HEADERS.map(projectTimeCsvCell).join(','), ...csvLines].join('\r\n')}\r\n`;

    return {
      filename,
      csv,
      rowCount: rows.length,
      truncated,
    };
  },
});

export async function queryProjectWeeklyTimeSummary(
  trx: Trx,
  orgId: string,
  projectId: string,
  fromStartIso: string,
  toEndExclusiveIso: string,
): Promise<ProjectWeeklyStatusTimeSummary> {
  const { rows } = await sql<{
    entry_count: number;
    total_minutes: number;
    billable_minutes: number;
    billable_amount: string;
  }>`
    SELECT
      pg_catalog.count(*)::int AS entry_count,
      COALESCE(pg_catalog.sum(te.duration_minutes), 0)::int AS total_minutes,
      COALESCE(pg_catalog.sum(CASE WHEN te.billable THEN te.duration_minutes ELSE 0 END), 0)::int AS billable_minutes,
      COALESCE(
        pg_catalog.sum(
          CASE
            WHEN te.billable AND te.hourly_rate IS NOT NULL
            THEN pg_catalog.round((te.duration_minutes::numeric * te.hourly_rate) / 60, 2)
            ELSE 0
          END
        ),
        0
      )::text AS billable_amount
    FROM crove_projects.time_entry te
    WHERE te.org_id = ${orgId}::uuid
      AND te.project_id = ${projectId}::uuid
      AND te.ended_at IS NOT NULL
      AND te.duration_minutes IS NOT NULL
      AND te.started_at >= ${fromStartIso}::timestamptz
      AND te.started_at < ${toEndExclusiveIso}::timestamptz
      AND (
        te.task_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM crove_kernel.task t
          WHERE t.org_id = te.org_id
            AND t.id = te.task_id
        )
      )`.execute(trx);

  const row = rows[0];
  const entryCount = Number(row?.entry_count ?? 0);
  const totalMinutes = Number(row?.total_minutes ?? 0);
  const billableMinutes = Number(row?.billable_minutes ?? 0);
  const billableAmount = row ? sumTimeBillableAmounts([row.billable_amount]) : '0.00';

  return {
    entryCount,
    totalMinutes,
    billableMinutes,
    totalHours: computeTimeHoursString(totalMinutes),
    billableHours: computeTimeHoursString(billableMinutes),
    billableAmount,
  };
}

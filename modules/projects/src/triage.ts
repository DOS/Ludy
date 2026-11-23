// SPDX-License-Identifier: AGPL-3.0-only
// Projects Triage Inbox (#4493, ADR-0058): collects internal and external signals into crove_projects.project_triage_item
// with canonical lock ordering (triage item FOR UPDATE -> kernel.task.create_from_triage (position) -> project FOR SHARE),
// #2604 private-project isolation, cross-module read verification via ctxQueryFn, and Vy AI assist source assembly.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  PROJECT_TRIAGE_DECLINE_REASON_MAX,
  PROJECT_TRIAGE_DESCRIPTION_MAX,
  PROJECT_TRIAGE_LIST_DEFAULT_LIMIT,
  PROJECT_TRIAGE_OPEN_TASKS_LIMIT,
  PROJECT_TRIAGE_SOURCE_PAIR_ISSUE,
  PROJECT_TRIAGE_TITLE_MAX,
  auditValue,
  tableWrite,
  validProjectTriageSourcePair,
  zId,
  zProjectTriageAcceptInput,
  zProjectTriageCreateInput,
  zProjectTriageDeclineInput,
  zProjectTriageListInput,
  zProjectTriageMergeInput,
  zProjectTriageReopenInput,
  zProjectTriageSnoozeInput,
  type ProjectStatus,
  type ProjectTriageAcceptResult,
  type ProjectTriageCounts,
  type ProjectTriageCycleOption,
  type ProjectTriageItem,
  type ProjectTriageListResult,
  type ProjectTriagePriority,
  type ProjectTriageProjectOption,
  type ProjectTriageSeatOption,
  type ProjectTriageSourceType,
  type ProjectTriageStatus,
  type ProjectTriageTaskOption,
  type ProjectVisibility,
} from '@ludy/kernel-contract';
import {
  DomainError,
  defineCommand,
  defineQuery,
  type CommandContext,
  type QueryContext,
} from '@ludy/kernel-runtime';
import type { MemberRole } from '@ludy/db';
import { projectsManifest } from './manifest.ts';
import { loadColumnsForProjects, loadProjectColumns, resolveTaskColumnId } from './columns.ts';
import { loadCycle } from './cycles.ts';
import { loadProjectsAiMeta } from './roadmap.ts';
import {
  READERS,
  WRITERS,
  assertNotArchived,
  canWriteProject,
  loadProject,
  memberProfilesMap,
  userOf,
} from './shared.ts';
import { assertSeatsAllowed, checkProjectsVyAccess } from './tasks-from-note.ts';
import { ctxQueryFn, readTasksFromSourceData } from './tasks-from-source.ts';

const TABLES = projectsManifest.tables;
const TRIAGE_TABLE = TABLES.crove_projects.project_triage_item;
const TRIAGE_TASKS_FOR_ASSIST_LIMIT = 40;
const ASSIST_TITLE_CHARS = 240;
const ASSIST_DESCRIPTION_CHARS = 1200;

interface RawTriageRow {
  id: string;
  project_id: string;
  project_name: string;
  project_visibility: string;
  source_type: string;
  source_id: string | null;
  status: string;
  priority: string;
  title: string;
  description: string | null;
  tainted: boolean;
  snoozed_until: Date | string | null;
  accepted_task_id: string | null;
  merged_into_task_id: string | null;
  decline_reason: string | null;
  triaged_by: string | null;
  triaged_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface ProjectTriageAssistSource {
  item: {
    id: string;
    projectId: string;
    projectName: string;
    sourceType: ProjectTriageSourceType;
    sourceId: string | null;
    status: ProjectTriageStatus;
    priority: ProjectTriagePriority;
    title: string;
    description: string | null;
    tainted: boolean;
  };
  candidates: {
    seats: Array<{ positionId: string; label: string }>;
    cycles: Array<{ cycleId: string; label: string; status: string }>;
    tasks: Array<{ taskId: string; title: string; status: string; tainted: boolean }>;
  };
  todayVn: string;
  aiStopped: boolean;
  aiBudgetSpent: boolean;
}

function isoOf(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function shortText(value: string, max: number): string {
  return Array.from(value.replace(/\s+/g, ' ').trim()).slice(0, max).join('');
}

function triageNotFound(): DomainError {
  return new DomainError('TRIAGE_ITEM_NOT_FOUND', 404, 'Không tìm thấy mục phân loại này');
}

function triageAlreadyResolved(): DomainError {
  return new DomainError('TRIAGE_ALREADY_RESOLVED', 409, 'Mục phân loại này đã được xử lý trước đó');
}

async function lockTriageItem(trx: CommandContext['trx'], orgId: string, itemId: string) {
  // Lock crove_projects.project_triage_item alone first so canonical `triage_item -> position -> project` lock order stays intact.
  const locked = await trx
    .selectFrom('crove_projects.project_triage_item')
    .select([
      'id',
      'project_id',
      'source_type',
      'source_id',
      'status',
      'priority',
      'title',
      'description',
      'tainted',
      'snoozed_until',
      'accepted_task_id',
      'merged_into_task_id',
      'decline_reason',
      'triaged_by',
      'triaged_at',
      'created_by',
      'created_at',
      'updated_at',
    ])
    .where('org_id', '=', orgId)
    .where('id', '=', itemId)
    .forUpdate()
    .executeTakeFirst();

  if (!locked) throw triageNotFound();

  const proj = await trx
    .selectFrom('crove_projects.project')
    .select(['id'])
    .where('org_id', '=', orgId)
    .where('id', '=', locked.project_id)
    .where('is_template', '=', false)
    .executeTakeFirst();
  if (!proj) throw triageNotFound();

  return locked;
}

async function loadTriageItemView(trx: QueryContext['trx'], orgId: string, itemId: string, now: Date): Promise<ProjectTriageItem> {
  const rows = await hydrateTriageItems(
    trx,
    orgId,
    await trx
      .selectFrom('crove_projects.project_triage_item as pti')
      .innerJoin('crove_projects.project as p', (join) =>
        join.onRef('p.org_id', '=', 'pti.org_id').onRef('p.id', '=', 'pti.project_id'),
      )
      .select([
        'pti.id',
        'pti.project_id',
        'p.name as project_name',
        'p.visibility as project_visibility',
        'pti.source_type',
        'pti.source_id',
        'pti.status',
        'pti.priority',
        'pti.title',
        'pti.description',
        'pti.tainted',
        'pti.snoozed_until',
        'pti.accepted_task_id',
        'pti.merged_into_task_id',
        'pti.decline_reason',
        'pti.triaged_by',
        'pti.triaged_at',
        'pti.created_by',
        'pti.created_at',
        'pti.updated_at',
      ])
      .where('pti.org_id', '=', orgId)
      .where('pti.id', '=', itemId)
      .where('p.is_template', '=', false)
      .execute(),
    now,
  );
  const item = rows[0];
  if (!item) throw triageNotFound();
  return item;
}

async function hydrateTriageItems(
  trx: QueryContext['trx'],
  orgId: string,
  rows: readonly RawTriageRow[],
  now: Date,
): Promise<ProjectTriageItem[]> {
  if (rows.length === 0) return [];

  const userIds = rows
    .flatMap((r) => [r.created_by, r.triaged_by])
    .filter((id): id is string => id !== null);
  const profiles = await memberProfilesMap(trx, userIds);

  const roadmapIds = [
    ...new Set(
      rows
        .filter((r) => r.source_type === 'roadmap.item' && r.source_id !== null)
        .map((r) => r.source_id as string),
    ),
  ];
  const roadmapTitles = new Map<string, string>();
  if (roadmapIds.length > 0) {
    const roadmapRows = await trx
      .selectFrom('crove_projects.roadmap_item')
      .select(['id', 'public_title'])
      .where('org_id', '=', orgId)
      .where('id', 'in', roadmapIds)
      .execute();
    for (const r of roadmapRows) {
      roadmapTitles.set(r.id, r.public_title);
    }
  }

  const nowMs = now.getTime();
  return rows.map((r) => {
    const snoozedUntilIso = isoOf(r.snoozed_until);
    const snoozeElapsed =
      r.status === 'snoozed' &&
      snoozedUntilIso !== null &&
      new Date(snoozedUntilIso).getTime() <= nowMs;

    const sourceLabel =
      r.source_type === 'roadmap.item' && r.source_id ? (roadmapTitles.get(r.source_id) ?? null) : null;

    const triagedProfile = r.triaged_by ? profiles.get(r.triaged_by) : undefined;
    const createdProfile = r.created_by ? profiles.get(r.created_by) : undefined;

    return {
      id: r.id,
      projectId: r.project_id,
      projectName: r.project_name,
      projectVisibility: r.project_visibility as ProjectVisibility,
      sourceType: r.source_type as ProjectTriageSourceType,
      sourceId: r.source_id,
      sourceLabel,
      status: r.status as ProjectTriageStatus,
      priority: r.priority as ProjectTriagePriority,
      title: r.title,
      description: r.description,
      tainted: r.tainted,
      snoozedUntil: snoozedUntilIso,
      snoozeElapsed,
      acceptedTaskId: r.accepted_task_id,
      mergedIntoTaskId: r.merged_into_task_id,
      declineReason: r.decline_reason,
      triagedBy: r.triaged_by,
      triagedByName: triagedProfile?.displayName ?? triagedProfile?.email ?? null,
      triagedAt: isoOf(r.triaged_at),
      createdBy: r.created_by,
      createdByName: createdProfile?.displayName ?? createdProfile?.email ?? null,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  });
}

async function resolveProjectSeatsForProjects(
  trx: QueryContext['trx'],
  orgId: string,
  projectIds: readonly string[],
): Promise<ProjectTriageSeatOption[]> {
  if (projectIds.length === 0) return [];
  const members = await trx
    .selectFrom('crove_projects.project_member')
    .select(['project_id', 'user_id'])
    .where('org_id', '=', orgId)
    .where('project_id', 'in', [...projectIds])
    .execute();

  const userProjectIds = new Map<string, string[]>();
  for (const m of members) {
    const arr = userProjectIds.get(m.user_id) ?? [];
    if (!arr.includes(m.project_id)) arr.push(m.project_id);
    userProjectIds.set(m.user_id, arr);
  }
  const memberUserIds = [...userProjectIds.keys()];
  if (memberUserIds.length === 0) return [];

  const positions = await trx
    .selectFrom('ludy_kernel.position')
    .select(['id', 'title', 'holder_user_id'])
    .where('org_id', '=', orgId)
    .where('status', '=', 'active')
    .where('holder_user_id', 'in', memberUserIds)
    .orderBy('title', 'asc')
    .orderBy('id', 'asc')
    .execute();

  const profiles = await memberProfilesMap(trx, memberUserIds);
  return positions.map((pos) => {
    const uid = pos.holder_user_id!;
    const prof = profiles.get(uid);
    return {
      id: pos.id,
      title: pos.title,
      status: 'active',
      onProject: true,
      holder: {
        type: 'user',
        userId: uid,
        displayName: prof?.displayName ?? null,
        email: prof?.email ?? null,
      },
      projectIds: userProjectIds.get(uid) ?? [],
    };
  });
}

export const projectTriageCreate = defineCommand({
  name: 'projects.triage.create',
  input: zProjectTriageCreateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project_triage_item', [
      'project_id',
      'source_type',
      'source_id',
      'priority',
      'title',
      'description',
      'tainted',
      'created_by',
    ]),
  ],
  target: (input) => ({ type: 'projects.project', id: input.projectId }),
  handler: async (ctx, input): Promise<{ item: ProjectTriageItem }> => {
    const userId = userOf(ctx.actor);
    if (!validProjectTriageSourcePair(input)) {
      throw new DomainError('VALIDATION', 422, PROJECT_TRIAGE_SOURCE_PAIR_ISSUE.message);
    }

    const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, 'share');
    assertNotArchived(project);

    let sourceId: string | null = null;
    let tainted = false;

    if (input.sourceType === 'manual') {
      sourceId = null;
      tainted = input.tainted ?? false;
    } else if (input.sourceType === 'roadmap.item') {
      sourceId = input.sourceId!;
      const roadmapItem = await ctx.trx
        .selectFrom('crove_projects.roadmap_item as i')
        .innerJoin('crove_projects.roadmap_board as b', (join) =>
          join.onRef('b.org_id', '=', 'i.org_id').onRef('b.id', '=', 'i.board_id'),
        )
        .select(['i.id', 'i.source', 'i.tainted'])
        .where('i.org_id', '=', ctx.orgId)
        .where('i.id', '=', sourceId)
        .executeTakeFirst();
      if (!roadmapItem) {
        throw new DomainError('ROADMAP_ITEM_NOT_FOUND', 404, 'Không tìm thấy mục lộ trình này');
      }
      tainted = Boolean(roadmapItem.tainted) || roadmapItem.source === 'public_submission';
    } else {
      sourceId = input.sourceId!;
      await readTasksFromSourceData(ctxQueryFn(ctx), {
        sourceType: input.sourceType,
        sourceId,
        includeContent: false,
      });
      tainted = true;
    }

    const title = input.title.trim().slice(0, PROJECT_TRIAGE_TITLE_MAX).trim();
    const description = normalizeOptionalText(input.description);
    if (description !== null && description.length > PROJECT_TRIAGE_DESCRIPTION_MAX) {
      throw new DomainError('VALIDATION', 422, 'Mô tả vượt quá độ dài cho phép');
    }
    const priority: ProjectTriagePriority = input.priority ?? 'none';

    const inserted = await ctx.trx
      .insertInto('crove_projects.project_triage_item')
      .values({
        org_id: ctx.orgId,
        project_id: project.id,
        source_type: input.sourceType,
        source_id: sourceId,
        status: 'pending',
        priority,
        title,
        description,
        tainted,
        snoozed_until: null,
        accepted_task_id: null,
        merged_into_task_id: null,
        decline_reason: null,
        triaged_by: null,
        triaged_at: null,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const item = await loadTriageItemView(ctx.trx, ctx.orgId, inserted.id, ctx.now);

    ctx.audit({
      triageItemId: item.id,
      projectId: project.id,
      sourceType: input.sourceType,
      sourceId,
      priority,
      tainted,
      title: auditValue(TRIAGE_TABLE, 'title', title),
    });
    await ctx.emit('projects.triage.created', {
      projectId: project.id,
      triageItemId: item.id,
      sourceType: input.sourceType,
      sourceId,
      tainted,
    });
    await ctx.activity('projects.project', project.id, 'projects.triage.created', 'Thêm mục mới vào hộp phân loại dự án');

    return { item };
  },
});

export const projectTriageList = defineQuery({
  name: 'projects.triage.list',
  input: zProjectTriageListInput,
  access: READERS,
  handler: async (ctx, input): Promise<ProjectTriageListResult> => {
    userOf(ctx.actor);
    const role: MemberRole | null = ctx.role;

    if (input.projectId !== undefined) {
      await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
    }

    const projectRows = await ctx.trx
      .selectFrom('crove_projects.project')
      .select(['id', 'name', 'visibility', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('is_template', '=', false)
      .$if(input.projectId !== undefined, (qb) => qb.where('id', '=', input.projectId!))
      .$if(input.projectId === undefined, (qb) => qb.where('status', '<>', 'archived'))
      .orderBy('name', 'asc')
      .orderBy('id', 'asc')
      .execute();

    const projects: ProjectTriageProjectOption[] = projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      visibility: p.visibility as ProjectVisibility,
      status: p.status as ProjectStatus,
      canWrite: canWriteProject(role, p.status as ProjectStatus),
    }));
    const projectIds = projects.map((p) => p.id);

    const limit = input.limit ?? PROJECT_TRIAGE_LIST_DEFAULT_LIMIT;

    let itemQuery = ctx.trx
      .selectFrom('crove_projects.project_triage_item as pti')
      .innerJoin('crove_projects.project as p', (join) =>
        join.onRef('p.org_id', '=', 'pti.org_id').onRef('p.id', '=', 'pti.project_id'),
      )
      .select([
        'pti.id',
        'pti.project_id',
        'p.name as project_name',
        'p.visibility as project_visibility',
        'pti.source_type',
        'pti.source_id',
        'pti.status',
        'pti.priority',
        'pti.title',
        'pti.description',
        'pti.tainted',
        'pti.snoozed_until',
        'pti.accepted_task_id',
        'pti.merged_into_task_id',
        'pti.decline_reason',
        'pti.triaged_by',
        'pti.triaged_at',
        'pti.created_by',
        'pti.created_at',
        'pti.updated_at',
      ])
      .where('pti.org_id', '=', ctx.orgId)
      .where('p.is_template', '=', false);

    if (input.projectId !== undefined) {
      itemQuery = itemQuery.where('pti.project_id', '=', input.projectId);
    } else {
      itemQuery = itemQuery.where('p.status', '<>', 'archived');
    }
    if (input.statuses !== undefined && input.statuses.length > 0) {
      itemQuery = itemQuery.where('pti.status', 'in', [...input.statuses]);
    }
    if (input.cursor !== undefined) {
      const cursorAt = input.cursor.createdAt;
      const cursorId = input.cursor.id;
      itemQuery = itemQuery.where(
        sql<boolean>`(pti.created_at, pti.id) < (${cursorAt}::timestamptz, ${cursorId}::uuid)`,
      );
    }

    const rawRows = await itemQuery
      .orderBy('pti.created_at', 'desc')
      .orderBy('pti.id', 'desc')
      .limit(limit + 1)
      .execute();

    const truncated = rawRows.length > limit;
    const pageRows = truncated ? rawRows.slice(0, limit) : rawRows;
    const now = new Date();
    const nowIso = now.toISOString();
    const items = await hydrateTriageItems(ctx.trx, ctx.orgId, pageRows, now);
    const lastItem = items.at(-1);
    const nextCursor = truncated && lastItem ? { createdAt: lastItem.createdAt, id: lastItem.id } : null;

    const projectFilterClause =
      input.projectId !== undefined
        ? sql<boolean>`pti.project_id = ${input.projectId}::uuid`
        : sql<boolean>`p.status <> 'archived'`;

    const { rows: countRows } = await sql<{
      pending: string;
      snoozed: string;
      accepted: string;
      merged: string;
      declined: string;
      snooze_elapsed: string;
    }>`
      SELECT
        pg_catalog.count(*) FILTER (WHERE pti.status = 'pending')::text AS pending,
        pg_catalog.count(*) FILTER (WHERE pti.status = 'snoozed')::text AS snoozed,
        pg_catalog.count(*) FILTER (WHERE pti.status = 'accepted')::text AS accepted,
        pg_catalog.count(*) FILTER (WHERE pti.status = 'merged')::text AS merged,
        pg_catalog.count(*) FILTER (WHERE pti.status = 'declined')::text AS declined,
        pg_catalog.count(*) FILTER (WHERE pti.status = 'snoozed' AND pti.snoozed_until <= ${nowIso}::timestamptz)::text AS snooze_elapsed
      FROM crove_projects.project_triage_item pti
      JOIN crove_projects.project p
        ON p.org_id = pti.org_id
       AND p.id = pti.project_id
     WHERE pti.org_id = ${ctx.orgId}::uuid
       AND p.is_template = false
       AND ${projectFilterClause}`.execute(ctx.trx);

    const c = countRows[0];
    const counts: ProjectTriageCounts = {
      pending: Number(c?.pending ?? 0),
      snoozed: Number(c?.snoozed ?? 0),
      accepted: Number(c?.accepted ?? 0),
      merged: Number(c?.merged ?? 0),
      declined: Number(c?.declined ?? 0),
      snoozeElapsed: Number(c?.snooze_elapsed ?? 0),
    };

    const seats = await resolveProjectSeatsForProjects(ctx.trx, ctx.orgId, projectIds);

    const columns = await loadColumnsForProjects(ctx.trx, ctx.orgId, projectIds);

    const cycleRows =
      projectIds.length === 0
        ? []
        : await ctx.trx
            .selectFrom('crove_projects.project_cycle')
            .select(['id', 'project_id', 'number', 'name', 'status', 'starts_on', 'ends_on'])
            .where('org_id', '=', ctx.orgId)
            .where('project_id', 'in', projectIds)
            .where('status', 'in', ['active', 'upcoming'])
            .orderBy('number', 'asc')
            .execute();

    const cycles: ProjectTriageCycleOption[] = cycleRows.map((cy) => ({
      id: cy.id,
      projectId: cy.project_id,
      number: cy.number,
      name: cy.name,
      status: cy.status,
      startsOn: cy.starts_on,
      endsOn: cy.ends_on,
    }));

    const taskRows =
      projectIds.length === 0
        ? []
        : await ctx.trx
            .selectFrom('crove_projects.project_task as pt')
            .innerJoin('ludy_kernel.task as t', (join) =>
              join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'),
            )
            .select(['t.id', 'pt.project_id', 't.title', 't.status'])
            .where('pt.org_id', '=', ctx.orgId)
            .where('pt.project_id', 'in', projectIds)
            .where('t.status', 'not in', ['done', 'cancelled'])
            .orderBy('t.created_at', 'desc')
            .orderBy('t.id', 'desc')
            .limit(PROJECT_TRIAGE_OPEN_TASKS_LIMIT)
            .execute();

    const openTasks: ProjectTriageTaskOption[] = taskRows.map((t) => ({
      id: t.id,
      projectId: t.project_id,
      title: t.title,
      status: t.status,
    }));

    const aiStatus = await checkProjectsVyAccess(ctx, { requireNotes: false });

    return {
      items,
      nextCursor,
      counts,
      projects,
      seats,
      columns,
      cycles,
      openTasks,
      aiStatus,
    };
  },
});

export const projectTriageAccept = defineCommand({
  name: 'projects.triage.accept',
  input: zProjectTriageAcceptInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // Intentionally omits `writes`: calls `ctx.run('kernel.task.create_from_triage', ...)` after locking the triage item.
  target: (input) => ({ type: 'projects.project_triage_item', id: input.itemId }),
  handler: async (ctx, input): Promise<ProjectTriageAcceptResult> => {
    const userId = userOf(ctx.actor);

    const item = await lockTriageItem(ctx.trx, ctx.orgId, input.itemId);
    if (item.status !== 'pending' && item.status !== 'snoozed') {
      throw triageAlreadyResolved();
    }

    const previewProject = await loadProject(ctx.trx, ctx.orgId, item.project_id, false);
    assertNotArchived(previewProject);

    const columns = await loadProjectColumns(ctx.trx, ctx.orgId, previewProject.id, false);
    const normalizedColumnId = input.columnId != null ? input.columnId.toLowerCase() : null;
    let chosenColumnId: string | null = null;
    let effectiveStatus: 'todo' | 'in_progress' | 'waiting' | 'in_review' | 'done' = 'todo';

    if (normalizedColumnId !== null) {
      const col = columns.find((c) => c.id.toLowerCase() === normalizedColumnId);
      if (!col) {
        throw new DomainError('COLUMN_NOT_FOUND', 404, 'Không tìm thấy cột trên bảng dự án');
      }
      chosenColumnId = col.id;
      effectiveStatus = col.taskStatus;
    } else {
      chosenColumnId = resolveTaskColumnId(columns, null, 'todo');
    }

    if (input.cycleId !== undefined && input.cycleId !== null) {
      const cycle = await loadCycle(ctx.trx, ctx.orgId, previewProject.id, input.cycleId, false);
      if (cycle.status === 'completed') {
        throw new DomainError('CYCLE_COMPLETED', 409, 'Chu kỳ đã hoàn thành, không thể thêm việc mới');
      }
    }

    const title = (input.title ?? item.title).trim().slice(0, PROJECT_TRIAGE_TITLE_MAX).trim();
    const description =
      input.description !== undefined ? normalizeOptionalText(input.description) : item.description;
    const positionId = input.assigneePositionId ?? null;
    const due = input.due ?? null;
    const priority: ProjectTriagePriority = input.priority ?? (item.priority as ProjectTriagePriority);

    const sourceRefType =
      item.source_type === 'manual'
        ? 'projects.project_triage_item'
        : item.source_type === 'roadmap.item'
          ? 'projects.roadmap_item'
          : (item.source_type as 'kernel.conversation' | 'meetings.meeting');
    const sourceRefId = item.source_id ?? item.id;

    // Canonical lock order: kernel.task.create_from_triage locks ludy_kernel.position BEFORE we lock crove_projects.project.
    const created = await ctx.run<{ taskId: string }>('kernel.task.create_from_triage', {
      sourceType: sourceRefType,
      sourceId: sourceRefId,
      title,
      description,
      positionId,
      due,
      tainted: item.tainted,
    });

    if (effectiveStatus !== 'todo') {
      await ctx.run('kernel.task.set_status', { id: created.taskId, status: effectiveStatus });
    }

    const lockedProject = await loadProject(ctx.trx, ctx.orgId, previewProject.id, 'share');
    assertNotArchived(lockedProject);
    const freshColumns = await loadProjectColumns(ctx.trx, ctx.orgId, lockedProject.id, false);
    if (normalizedColumnId !== null) {
      const freshCol = freshColumns.find((c) => c.id.toLowerCase() === normalizedColumnId);
      if (!freshCol) {
        throw new DomainError('COLUMN_NOT_FOUND', 404, 'Không tìm thấy cột trên bảng dự án');
      }
      chosenColumnId = freshCol.id;
      if (freshCol.taskStatus !== effectiveStatus) {
        await ctx.run('kernel.task.set_status', { id: created.taskId, status: freshCol.taskStatus });
      }
    } else {
      chosenColumnId = resolveTaskColumnId(freshColumns, null, 'todo');
    }
    if (positionId !== null) {
      await assertSeatsAllowed(ctx.trx, ctx.orgId, lockedProject.id, [positionId]);
    }
    if (input.cycleId !== undefined && input.cycleId !== null) {
      const cycle = await loadCycle(ctx.trx, ctx.orgId, lockedProject.id, input.cycleId, false);
      if (cycle.status === 'completed') {
        throw new DomainError('CYCLE_COMPLETED', 409, 'Chu kỳ đã hoàn thành, không thể thêm việc mới');
      }
    }

    await ctx.trx
      .insertInto('crove_projects.project_task')
      .values({
        org_id: ctx.orgId,
        project_id: lockedProject.id,
        task_id: created.taskId,
        column_id: chosenColumnId,
        cycle_id: input.cycleId ?? null,
        added_by: userId,
        created_at: ctx.now,
      })
      .execute();

    await ctx.trx
      .updateTable('crove_projects.project_triage_item')
      .set({
        status: 'accepted',
        priority,
        snoozed_until: null,
        accepted_task_id: created.taskId,
        merged_into_task_id: null,
        decline_reason: null,
        triaged_by: userId,
        triaged_at: ctx.now,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', item.id)
      .execute();

    if (item.source_type === 'roadmap.item' && item.source_id && lockedProject.visibility !== 'private') {
      await ctx.trx
        .updateTable('crove_projects.roadmap_item')
        .set({
          linked_task_id: created.taskId,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', item.source_id)
        .where('linked_task_id', 'is', null)
        .where('moderation_status', 'not in', ['merged', 'archived'])
        .execute();
    }

    const updatedItem = await loadTriageItemView(ctx.trx, ctx.orgId, item.id, ctx.now);

    ctx.audit({
      triageItemId: item.id,
      projectId: lockedProject.id,
      taskId: created.taskId,
      sourceType: item.source_type,
      sourceId: item.source_id,
      tainted: item.tainted,
      priority: auditValue(TRIAGE_TABLE, 'priority', priority),
      title: auditValue(TRIAGE_TABLE, 'title', title),
    });
    await ctx.emit('projects.triage.accepted', {
      projectId: lockedProject.id,
      triageItemId: item.id,
      taskId: created.taskId,
      sourceType: item.source_type,
      sourceId: item.source_id,
    });
    await ctx.emit('projects.task.created', {
      projectId: lockedProject.id,
      taskId: created.taskId,
      via: 'projects.triage',
    });
    await ctx.activity('projects.project', lockedProject.id, 'projects.triage.accepted', 'Duyệt mục phân loại thành công việc dự án');

    return {
      item: updatedItem,
      taskId: created.taskId,
      projectId: lockedProject.id,
    };
  },
});

export const projectTriageMerge = defineCommand({
  name: 'projects.triage.merge',
  input: zProjectTriageMergeInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project_triage_item', [
      'status',
      'snoozed_until',
      'accepted_task_id',
      'merged_into_task_id',
      'decline_reason',
      'triaged_by',
      'triaged_at',
      'updated_at',
    ]),
  ],
  target: (input) => ({ type: 'projects.project_triage_item', id: input.itemId }),
  handler: async (ctx, input): Promise<{ item: ProjectTriageItem }> => {
    const userId = userOf(ctx.actor);
    const item = await lockTriageItem(ctx.trx, ctx.orgId, input.itemId);
    if (item.status !== 'pending' && item.status !== 'snoozed') {
      throw triageAlreadyResolved();
    }

    const project = await loadProject(ctx.trx, ctx.orgId, item.project_id, 'share');
    assertNotArchived(project);

    const targetTask = await ctx.trx
      .selectFrom('crove_projects.project_task as pt')
      .innerJoin('ludy_kernel.task as t', (join) =>
        join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'),
      )
      .select('pt.task_id')
      .where('pt.org_id', '=', ctx.orgId)
      .where('pt.project_id', '=', project.id)
      .where('pt.task_id', '=', input.targetTaskId)
      .executeTakeFirst();
    if (!targetTask) {
      throw new DomainError('TASK_NOT_FOUND', 404, 'Không tìm thấy công việc đích trong dự án này');
    }

    await ctx.trx
      .updateTable('crove_projects.project_triage_item')
      .set({
        status: 'merged',
        snoozed_until: null,
        accepted_task_id: null,
        merged_into_task_id: targetTask.task_id,
        decline_reason: null,
        triaged_by: userId,
        triaged_at: ctx.now,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', item.id)
      .execute();

    const updatedItem = await loadTriageItemView(ctx.trx, ctx.orgId, item.id, ctx.now);

    ctx.audit({
      triageItemId: item.id,
      projectId: project.id,
      mergedIntoTaskId: targetTask.task_id,
      status: auditValue(TRIAGE_TABLE, 'status', 'merged'),
    });
    await ctx.emit('projects.triage.merged', {
      projectId: project.id,
      triageItemId: item.id,
      targetTaskId: targetTask.task_id,
    });
    await ctx.activity('projects.project', project.id, 'projects.triage.merged', 'Gộp mục phân loại vào công việc hiện có');

    return { item: updatedItem };
  },
});

export const projectTriageSnooze = defineCommand({
  name: 'projects.triage.snooze',
  input: zProjectTriageSnoozeInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project_triage_item', [
      'status',
      'snoozed_until',
      'triaged_by',
      'triaged_at',
      'updated_at',
    ]),
  ],
  target: (input) => ({ type: 'projects.project_triage_item', id: input.itemId }),
  handler: async (ctx, input): Promise<{ item: ProjectTriageItem }> => {
    const userId = userOf(ctx.actor);
    const snoozeMs = new Date(input.snoozedUntil).getTime();
    const nowMs = ctx.now.getTime();
    if (Number.isNaN(snoozeMs) || snoozeMs <= nowMs) {
      throw new DomainError('INVALID_SNOOZE_TIME', 422, 'Thời điểm tạm ẩn phải lớn hơn thời điểm hiện tại');
    }

    const item = await lockTriageItem(ctx.trx, ctx.orgId, input.itemId);
    if (item.status !== 'pending' && item.status !== 'snoozed') {
      throw triageAlreadyResolved();
    }

    const project = await loadProject(ctx.trx, ctx.orgId, item.project_id, 'share');
    assertNotArchived(project);

    await ctx.trx
      .updateTable('crove_projects.project_triage_item')
      .set({
        status: 'snoozed',
        snoozed_until: input.snoozedUntil,
        triaged_by: userId,
        triaged_at: ctx.now,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', item.id)
      .execute();

    const updatedItem = await loadTriageItemView(ctx.trx, ctx.orgId, item.id, ctx.now);

    ctx.audit({
      triageItemId: item.id,
      projectId: project.id,
      status: auditValue(TRIAGE_TABLE, 'status', 'snoozed'),
      snoozedUntil: auditValue(TRIAGE_TABLE, 'snoozed_until', updatedItem.snoozedUntil),
    });
    await ctx.emit('projects.triage.snoozed', {
      projectId: project.id,
      triageItemId: item.id,
      snoozedUntil: updatedItem.snoozedUntil,
    });
    await ctx.activity('projects.project', project.id, 'projects.triage.snoozed', 'Tạm ẩn mục phân loại dự án');

    return { item: updatedItem };
  },
});

export const projectTriageDecline = defineCommand({
  name: 'projects.triage.decline',
  input: zProjectTriageDeclineInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project_triage_item', [
      'status',
      'snoozed_until',
      'decline_reason',
      'triaged_by',
      'triaged_at',
      'updated_at',
    ]),
  ],
  target: (input) => ({ type: 'projects.project_triage_item', id: input.itemId }),
  handler: async (ctx, input): Promise<{ item: ProjectTriageItem }> => {
    const userId = userOf(ctx.actor);
    const reason = normalizeOptionalText(input.declineReason);
    if (reason !== null && reason.length > PROJECT_TRIAGE_DECLINE_REASON_MAX) {
      throw new DomainError('VALIDATION', 422, 'Lý do từ chối vượt quá độ dài cho phép');
    }

    const item = await lockTriageItem(ctx.trx, ctx.orgId, input.itemId);
    if (item.status !== 'pending' && item.status !== 'snoozed') {
      throw triageAlreadyResolved();
    }

    const project = await loadProject(ctx.trx, ctx.orgId, item.project_id, 'share');
    assertNotArchived(project);

    await ctx.trx
      .updateTable('crove_projects.project_triage_item')
      .set({
        status: 'declined',
        snoozed_until: null,
        decline_reason: reason,
        triaged_by: userId,
        triaged_at: ctx.now,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', item.id)
      .execute();

    const updatedItem = await loadTriageItemView(ctx.trx, ctx.orgId, item.id, ctx.now);

    ctx.audit({
      triageItemId: item.id,
      projectId: project.id,
      status: auditValue(TRIAGE_TABLE, 'status', 'declined'),
      declineReason: auditValue(TRIAGE_TABLE, 'decline_reason', reason),
    });
    await ctx.emit('projects.triage.declined', {
      projectId: project.id,
      triageItemId: item.id,
    });
    await ctx.activity('projects.project', project.id, 'projects.triage.declined', 'Từ chối mục phân loại dự án');

    return { item: updatedItem };
  },
});

export const projectTriageReopen = defineCommand({
  name: 'projects.triage.reopen',
  input: zProjectTriageReopenInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  writes: [
    tableWrite(TABLES, 'crove_projects', 'project_triage_item', [
      'status',
      'snoozed_until',
      'decline_reason',
      'triaged_by',
      'triaged_at',
      'updated_at',
    ]),
  ],
  target: (input) => ({ type: 'projects.project_triage_item', id: input.itemId }),
  handler: async (ctx, input): Promise<{ item: ProjectTriageItem }> => {
    userOf(ctx.actor);
    const item = await lockTriageItem(ctx.trx, ctx.orgId, input.itemId);
    if (item.status === 'accepted' || item.status === 'merged') {
      throw new DomainError('TRIAGE_TERMINAL_STATE', 409, 'Mục đã chuyển thành hoặc gộp vào công việc, không thể mở lại');
    }

    const project = await loadProject(ctx.trx, ctx.orgId, item.project_id, 'share');
    assertNotArchived(project);

    await ctx.trx
      .updateTable('crove_projects.project_triage_item')
      .set({
        status: 'pending',
        snoozed_until: null,
        decline_reason: null,
        triaged_by: null,
        triaged_at: null,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', item.id)
      .execute();

    const updatedItem = await loadTriageItemView(ctx.trx, ctx.orgId, item.id, ctx.now);

    ctx.audit({
      triageItemId: item.id,
      projectId: project.id,
      status: auditValue(TRIAGE_TABLE, 'status', 'pending'),
    });
    await ctx.emit('projects.triage.reopened', {
      projectId: project.id,
      triageItemId: item.id,
    });
    await ctx.activity('projects.project', project.id, 'projects.triage.reopened', 'Mở lại mục phân loại dự án');

    return { item: updatedItem };
  },
});

export const projectTriageAssistSource = defineQuery({
  name: 'projects.triage_assist_source',
  input: z.strictObject({ itemId: zId }),
  access: WRITERS,
  handler: async (ctx, input): Promise<ProjectTriageAssistSource> => {
    userOf(ctx.actor);

    const row = await ctx.trx
      .selectFrom('crove_projects.project_triage_item as pti')
      .innerJoin('crove_projects.project as p', (join) =>
        join.onRef('p.org_id', '=', 'pti.org_id').onRef('p.id', '=', 'pti.project_id'),
      )
      .select([
        'pti.id',
        'pti.project_id',
        'p.name as project_name',
        'p.status as project_status',
        'pti.source_type',
        'pti.source_id',
        'pti.status',
        'pti.priority',
        'pti.title',
        'pti.description',
        'pti.tainted',
      ])
      .where('pti.org_id', '=', ctx.orgId)
      .where('pti.id', '=', input.itemId)
      .where('p.is_template', '=', false)
      .executeTakeFirst();

    if (!row) throw triageNotFound();
    if (row.project_status === 'archived') {
      throw new DomainError('PROJECT_ARCHIVED', 409, 'Dự án này đã được lưu trữ, không thể phân loại');
    }

    const meta = await loadProjectsAiMeta(ctx.trx, ctx.orgId);

    const seatOptions = await resolveProjectSeatsForProjects(ctx.trx, ctx.orgId, [row.project_id]);
    const seats = seatOptions.map((s) => {
      const holderName = s.holder?.type === 'user' ? s.holder.displayName : null;
      return {
        positionId: s.id,
        label: holderName ? `${s.title} (${holderName})` : s.title,
      };
    });

    const cycleRows = await ctx.trx
      .selectFrom('crove_projects.project_cycle')
      .select(['id', 'number', 'name', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('project_id', '=', row.project_id)
      .where('status', 'in', ['active', 'upcoming'])
      .orderBy('number', 'asc')
      .execute();
    const cycles = cycleRows.map((cy) => ({
      cycleId: cy.id,
      label: `#${cy.number} ${shortText(cy.name, 80)}`,
      status: cy.status,
    }));

    const openTasks = await ctx.trx
      .selectFrom('crove_projects.project_task as pt')
      .innerJoin('ludy_kernel.task as t', (join) =>
        join.onRef('t.org_id', '=', 'pt.org_id').onRef('t.id', '=', 'pt.task_id'),
      )
      .select(['t.id', 't.title', 't.status', 't.tainted'])
      .where('pt.org_id', '=', ctx.orgId)
      .where('pt.project_id', '=', row.project_id)
      .where('t.status', 'not in', ['done', 'cancelled'])
      .orderBy('t.created_at', 'desc')
      .orderBy('t.id', 'desc')
      .limit(TRIAGE_TASKS_FOR_ASSIST_LIMIT)
      .execute();
    const tasks = openTasks.map((t) => ({
      taskId: t.id,
      title: shortText(t.title, ASSIST_TITLE_CHARS),
      status: t.status,
      tainted: t.tainted,
    }));

    return {
      item: {
        id: row.id,
        projectId: row.project_id,
        projectName: shortText(row.project_name, 120),
        sourceType: row.source_type as ProjectTriageSourceType,
        sourceId: row.source_id,
        status: row.status as ProjectTriageStatus,
        priority: row.priority as ProjectTriagePriority,
        title: shortText(row.title, ASSIST_TITLE_CHARS),
        description: row.description ? shortText(row.description, ASSIST_DESCRIPTION_CHARS) : null,
        tainted: row.tainted,
      },
      candidates: { seats, cycles, tasks },
      todayVn: meta.todayVn,
      aiStopped: meta.aiStopped,
      aiBudgetSpent: meta.aiBudgetSpent,
    };
  },
});

export const projectTriageCommands = [
  projectTriageCreate,
  projectTriageAccept,
  projectTriageMerge,
  projectTriageSnooze,
  projectTriageDecline,
  projectTriageReopen,
];

export const projectTriageQueries = [
  projectTriageList,
  projectTriageAssistSource,
];

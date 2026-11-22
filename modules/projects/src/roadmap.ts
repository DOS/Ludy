// SPDX-License-Identifier: AGPL-3.0-only
// Internal Projects Public Roadmap management & moderation commands and queries (#4399, ADR-0057).
// All mutations go through Runtime.execute(); public submissions keep tainted = true; private projects (#2604) are refused.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  ROADMAP_BOARDS_LIMIT,
  ROADMAP_ITEMS_LIMIT,
  ROADMAP_SLUG_PATTERN,
  auditValue,
  tableWrite,
  zId,
  zRoadmapBoardCreateInput,
  zRoadmapBoardDetailInput,
  zRoadmapBoardUpdateInput,
  zRoadmapItemConvertToTaskInput,
  zRoadmapItemCreateInput,
  zRoadmapItemMergeInput,
  zRoadmapItemModerateInput,
  zRoadmapItemSyncStageInput,
  type RoadmapAdminItem,
  type RoadmapBoardDetailResult,
  type RoadmapBoardListResult,
  type RoadmapBoardSummary,
  type RoadmapItemModerationStatus,
  type RoadmapItemSource,
  type RoadmapItemStage,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { projectsManifest } from './manifest.ts';
import { sealEphemeralOtpCode } from './roadmap-mail.ts';
import { READERS, WRITERS, assertNotArchived, memberProfilesMap, userOf, type ProjectRow, type Trx } from './shared.ts';

const TABLES = projectsManifest.tables;
const BOARD_TABLE = TABLES.ludy_projects.roadmap_board;
const ITEM_TABLE = TABLES.ludy_projects.roadmap_item;
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const ROADMAP_OTP_TTL_MS = 10 * 60_000;

function roadmapBoardTarget(input: { boardId: string }) {
  return { type: 'projects.roadmap_board', id: input.boardId };
}

function cleanOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function isoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function slugifyBoardTitle(title: string): string {
  const ascii = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  const candidate = ascii.length >= 2 ? ascii.replace(/-+$/g, '') : 'roadmap';
  return ROADMAP_SLUG_PATTERN.test(candidate) ? candidate : 'roadmap';
}

function mapPgBoardError(error: unknown): never {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: string }).code;
    const constraint = (error as { constraint?: string }).constraint;
    const message = (error as { message?: string }).message ?? '';
    if (code === '23505' && constraint === 'roadmap_board_slug_uq') {
      throw new DomainError('ROADMAP_SLUG_TAKEN', 409, 'Đường dẫn (slug) của bảng lộ trình này đã được sử dụng');
    }
    if (message.includes('ROADMAP_PRIVATE_PROJECT_FORBIDDEN')) {
      throw new DomainError('ROADMAP_PRIVATE_PROJECT_FORBIDDEN', 422, 'Không thể gắn dự án riêng tư vào bảng lộ trình công khai');
    }
    if (message.includes('ROADMAP_TEMPLATE_PROJECT_FORBIDDEN')) {
      throw new DomainError('ROADMAP_TEMPLATE_PROJECT_FORBIDDEN', 422, 'Không thể gắn mẫu dự án vào bảng lộ trình');
    }
    if (message.includes('ROADMAP_INVALID_EMBED_ORIGIN') || message.includes('ROADMAP_TOO_MANY_EMBED_ORIGINS')) {
      throw new DomainError('VALIDATION', 422, 'Nguồn nhúng iframe phải là URL https hợp lệ (không chứa ký tự đại diện)');
    }
  }
  throw error;
}

async function assertPublicProjectAllowed(
  trx: Trx,
  orgId: string,
  projectId: string,
  lock = true,
): Promise<{ id: string; name: string; status: ProjectRow['status'] }> {
  const { rows } = await sql<{
    id: string;
    name: string;
    status: string;
    is_template: boolean;
    visibility: string | null;
  }>`
    SELECT p.id, p.name, p.status, p.is_template, pg_catalog.to_jsonb(p)->>'visibility' AS visibility
      FROM ludy_projects.project p
     WHERE p.org_id = ${orgId}::uuid
       AND p.id = ${projectId}::uuid
     ${lock ? sql`FOR SHARE` : sql``}`.execute(trx);
  const project = rows[0];
  if (!project) {
    throw new DomainError('PROJECT_NOT_FOUND', 404, 'Không tìm thấy dự án này');
  }
  if (project.is_template) {
    throw new DomainError('ROADMAP_TEMPLATE_PROJECT_FORBIDDEN', 422, 'Không thể gắn mẫu dự án vào bảng lộ trình');
  }
  if (project.visibility === 'private') {
    throw new DomainError('ROADMAP_PRIVATE_PROJECT_FORBIDDEN', 422, 'Không thể gắn dự án riêng tư vào bảng lộ trình công khai');
  }
  return { id: project.id, name: project.name, status: project.status as ProjectRow['status'] };
}

async function loadBoardSummary(trx: Trx, orgId: string, boardId: string): Promise<RoadmapBoardSummary> {
  const { rows } = await sql<{
    id: string;
    slug: string;
    title: string;
    description: string | null;
    enabled: boolean;
    project_id: string | null;
    project_name: string | null;
    allow_submissions: boolean;
    allow_voting: boolean;
    require_moderation: boolean;
    embed_allowed_origins: string[];
    pending_count: string;
    published_count: string;
    created_at: Date;
    updated_at: Date;
  }>`
    SELECT
      b.id,
      b.slug,
      b.title,
      b.description,
      b.enabled,
      b.project_id,
      p.name AS project_name,
      b.allow_submissions,
      b.allow_voting,
      b.require_moderation,
      b.embed_allowed_origins,
      (SELECT pg_catalog.count(*)::text FROM ludy_projects.roadmap_item i WHERE i.org_id = b.org_id AND i.board_id = b.id AND i.moderation_status = 'pending') AS pending_count,
      (SELECT pg_catalog.count(*)::text FROM ludy_projects.roadmap_item i WHERE i.org_id = b.org_id AND i.board_id = b.id AND i.moderation_status = 'published') AS published_count,
      b.created_at,
      b.updated_at
    FROM ludy_projects.roadmap_board b
    LEFT JOIN ludy_projects.project p
      ON p.org_id = b.org_id AND p.id = b.project_id
    WHERE b.org_id = ${orgId}::uuid
      AND b.id = ${boardId}::uuid`.execute(trx);
  const b = rows[0];
  if (!b) {
    throw new DomainError('ROADMAP_BOARD_NOT_FOUND', 404, 'Không tìm thấy bảng lộ trình');
  }
  return {
    id: b.id,
    slug: b.slug,
    title: b.title,
    description: b.description,
    enabled: b.enabled,
    projectId: b.project_id,
    projectName: b.project_name,
    allowSubmissions: b.allow_submissions,
    allowVoting: b.allow_voting,
    requireModeration: b.require_moderation,
    embedAllowedOrigins: b.embed_allowed_origins,
    pendingCount: Number(b.pending_count),
    publishedCount: Number(b.published_count),
    createdAt: isoString(b.created_at),
    updatedAt: isoString(b.updated_at),
  };
}

async function loadAdminItem(trx: Trx, orgId: string, itemId: string): Promise<RoadmapAdminItem> {
  const { rows } = await sql<{
    id: string;
    board_id: string;
    linked_task_id: string | null;
    linked_task_status: string | null;
    linked_project_id: string | null;
    linked_project_name: string | null;
    source: string;
    moderation_status: string;
    merged_into_item_id: string | null;
    stage: string;
    category: string | null;
    public_title: string;
    public_summary: string | null;
    vote_count: number;
    tainted: boolean;
    submitter_display_name: string | null;
    created_at: Date;
    updated_at: Date;
  }>`
    SELECT
      i.id,
      i.board_id,
      i.linked_task_id,
      t.status AS linked_task_status,
      pt.project_id AS linked_project_id,
      p.name AS linked_project_name,
      i.source,
      i.moderation_status,
      i.merged_into_item_id,
      i.stage,
      i.category,
      i.public_title,
      i.public_summary,
      i.vote_count,
      i.tainted,
      i.submitter_display_name,
      i.created_at,
      i.updated_at
    FROM ludy_projects.roadmap_item i
    LEFT JOIN ludy_kernel.task t
      ON t.org_id = i.org_id AND t.id = i.linked_task_id
    LEFT JOIN ludy_projects.project_task pt
      ON pt.org_id = i.org_id AND pt.task_id = i.linked_task_id
    LEFT JOIN ludy_projects.project p
      ON p.org_id = i.org_id AND p.id = pt.project_id
    WHERE i.org_id = ${orgId}::uuid
      AND i.id = ${itemId}::uuid`.execute(trx);
  const r = rows[0];
  if (!r) {
    throw new DomainError('ROADMAP_ITEM_NOT_FOUND', 404, 'Không tìm thấy mục lộ trình');
  }
  return {
    id: r.id,
    boardId: r.board_id,
    linkedTaskId: r.linked_task_id,
    linkedTaskStatus: r.linked_task_status,
    linkedProjectId: r.linked_project_id,
    linkedProjectName: r.linked_project_name,
    source: r.source as RoadmapItemSource,
    moderationStatus: r.moderation_status as RoadmapItemModerationStatus,
    mergedIntoItemId: r.merged_into_item_id,
    stage: r.stage as RoadmapItemStage,
    category: r.category,
    publicTitle: r.public_title,
    publicSummary: r.public_summary,
    voteCount: Number(r.vote_count),
    tainted: r.tainted,
    submitterDisplayName: r.submitter_display_name,
    createdAt: isoString(r.created_at),
    updatedAt: isoString(r.updated_at),
  };
}

function assertManager(ctx: { role: MemberRole | null }): void {
  if (ctx.role !== 'owner' && ctx.role !== 'admin') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới cấu hình được bảng lộ trình công khai');
  }
}

function mapTaskStatusToStage(taskStatus: string | null, current: RoadmapItemStage): RoadmapItemStage {
  if (taskStatus === 'todo' || taskStatus === 'waiting') return 'planned';
  if (taskStatus === 'in_progress' || taskStatus === 'in_review') return 'in_progress';
  if (taskStatus === 'done') return 'shipped';
  return current;
}

export const roadmapBoards = defineQuery({
  name: 'projects.roadmap.boards',
  input: z.strictObject({}),
  access: READERS,
  handler: async (ctx: QueryContext): Promise<RoadmapBoardListResult> => {
    userOf(ctx.actor);
    const tenant = await ctx.trx
      .selectFrom('ludy_kernel.tenant')
      .select('slug')
      .where('org_id', '=', ctx.orgId)
      .executeTakeFirstOrThrow();

    const { rows: boardRows } = await sql<{
      id: string;
      slug: string;
      title: string;
      description: string | null;
      enabled: boolean;
      project_id: string | null;
      project_name: string | null;
      allow_submissions: boolean;
      allow_voting: boolean;
      require_moderation: boolean;
      embed_allowed_origins: string[];
      pending_count: string;
      published_count: string;
      created_at: Date;
      updated_at: Date;
    }>`
      SELECT
        b.id,
        b.slug,
        b.title,
        b.description,
        b.enabled,
        b.project_id,
        p.name AS project_name,
        b.allow_submissions,
        b.allow_voting,
        b.require_moderation,
        b.embed_allowed_origins,
        (SELECT pg_catalog.count(*)::text FROM ludy_projects.roadmap_item i WHERE i.org_id = b.org_id AND i.board_id = b.id AND i.moderation_status = 'pending') AS pending_count,
        (SELECT pg_catalog.count(*)::text FROM ludy_projects.roadmap_item i WHERE i.org_id = b.org_id AND i.board_id = b.id AND i.moderation_status = 'published') AS published_count,
        b.created_at,
        b.updated_at
      FROM ludy_projects.roadmap_board b
      LEFT JOIN ludy_projects.project p
        ON p.org_id = b.org_id AND p.id = b.project_id
      WHERE b.org_id = ${ctx.orgId}::uuid
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ${ROADMAP_BOARDS_LIMIT}`.execute(ctx.trx);

    const { rows: projects } = await sql<{ id: string; name: string; status: string }>`
      SELECT p.id, p.name, p.status
        FROM ludy_projects.project p
       WHERE p.org_id = ${ctx.orgId}::uuid
         AND p.is_template = false
         AND p.status <> 'archived'
         AND COALESCE(pg_catalog.to_jsonb(p)->>'visibility', 'public') <> 'private'
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT 200`.execute(ctx.trx);

    const seatsRows = await ctx.trx
      .selectFrom('ludy_kernel.position as p')
      .innerJoin('ludy_kernel.tenant_member as m', (join) =>
        join.onRef('m.org_id', '=', 'p.org_id').onRef('m.user_id', '=', 'p.holder_user_id'),
      )
      .select(['p.id as position_id', 'p.title', 'p.holder_user_id', 'm.role as holder_role'])
      .where('p.org_id', '=', ctx.orgId)
      .where('p.status', '=', 'active')
      .where('p.holder_user_id', 'is not', null)
      .orderBy('p.title', 'asc')
      .orderBy('p.id', 'asc')
      .execute();

    const holderIds = seatsRows.map((s) => s.holder_user_id).filter((id): id is string => id !== null);
    const profiles = await memberProfilesMap(ctx.trx, holderIds);

    return {
      boards: boardRows.map((b) => ({
        id: b.id,
        slug: b.slug,
        title: b.title,
        description: b.description,
        enabled: b.enabled,
        projectId: b.project_id,
        projectName: b.project_name,
        allowSubmissions: b.allow_submissions,
        allowVoting: b.allow_voting,
        requireModeration: b.require_moderation,
        embedAllowedOrigins: b.embed_allowed_origins,
        pendingCount: Number(b.pending_count),
        publishedCount: Number(b.published_count),
        createdAt: isoString(b.created_at),
        updatedAt: isoString(b.updated_at),
      })),
      orgSlug: tenant.slug,
      projects: projects.map((p) => ({ id: p.id, name: p.name, status: p.status })),
      seats: seatsRows.flatMap((s) => {
        if (!s.holder_user_id) return [];
        const profile = profiles.get(s.holder_user_id);
        return [
          {
            positionId: s.position_id,
            title: s.title,
            holderName: profile?.displayName ?? profile?.email ?? 'Thành viên',
            holderRole: s.holder_role,
          },
        ];
      }),
      canWrite: ctx.role !== null && ctx.role !== 'viewer',
      canManageBoard: ctx.role === 'owner' || ctx.role === 'admin',
    };
  },
});

export const roadmapBoardGet = defineQuery({
  name: 'projects.roadmap.board.get',
  input: zRoadmapBoardDetailInput,
  access: READERS,
  handler: async (ctx: QueryContext, input): Promise<RoadmapBoardDetailResult> => {
    userOf(ctx.actor);
    const board = await loadBoardSummary(ctx.trx, ctx.orgId, input.boardId);
    const { rows } = await sql<{
      id: string;
      board_id: string;
      linked_task_id: string | null;
      linked_task_status: string | null;
      linked_project_id: string | null;
      linked_project_name: string | null;
      source: string;
      moderation_status: string;
      merged_into_item_id: string | null;
      stage: string;
      category: string | null;
      public_title: string;
      public_summary: string | null;
      vote_count: number;
      tainted: boolean;
      submitter_display_name: string | null;
      created_at: Date;
      updated_at: Date;
    }>`
      SELECT
        i.id,
        i.board_id,
        i.linked_task_id,
        t.status AS linked_task_status,
        pt.project_id AS linked_project_id,
        p.name AS linked_project_name,
        i.source,
        i.moderation_status,
        i.merged_into_item_id,
        i.stage,
        i.category,
        i.public_title,
        i.public_summary,
        i.vote_count,
        i.tainted,
        i.submitter_display_name,
        i.created_at,
        i.updated_at
      FROM ludy_projects.roadmap_item i
      LEFT JOIN ludy_kernel.task t
        ON t.org_id = i.org_id AND t.id = i.linked_task_id
      LEFT JOIN ludy_projects.project_task pt
        ON pt.org_id = i.org_id AND pt.task_id = i.linked_task_id
      LEFT JOIN ludy_projects.project p
        ON p.org_id = i.org_id AND p.id = pt.project_id
      WHERE i.org_id = ${ctx.orgId}::uuid
        AND i.board_id = ${board.id}::uuid
      ORDER BY
        CASE i.moderation_status
          WHEN 'pending' THEN 0
          WHEN 'published' THEN 1
          WHEN 'merged' THEN 2
          ELSE 3
        END ASC,
        i.vote_count DESC,
        i.created_at DESC,
        i.id DESC
      LIMIT ${ROADMAP_ITEMS_LIMIT}`.execute(ctx.trx);

    return {
      board,
      items: rows.map((r) => ({
        id: r.id,
        boardId: r.board_id,
        linkedTaskId: r.linked_task_id,
        linkedTaskStatus: r.linked_task_status,
        linkedProjectId: r.linked_project_id,
        linkedProjectName: r.linked_project_name,
        source: r.source as RoadmapItemSource,
        moderationStatus: r.moderation_status as RoadmapItemModerationStatus,
        mergedIntoItemId: r.merged_into_item_id,
        stage: r.stage as RoadmapItemStage,
        category: r.category,
        publicTitle: r.public_title,
        publicSummary: r.public_summary,
        voteCount: Number(r.vote_count),
        tainted: r.tainted,
        submitterDisplayName: r.submitter_display_name,
        createdAt: isoString(r.created_at),
        updatedAt: isoString(r.updated_at),
      })),
      canWrite: ctx.role !== null && ctx.role !== 'viewer',
      canManageBoard: ctx.role === 'owner' || ctx.role === 'admin',
    };
  },
});

export const roadmapBoardCreate = defineCommand({
  name: 'projects.roadmap.board.create',
  input: zRoadmapBoardCreateInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'roadmap_board', [
      'org_id',
      'slug',
      'title',
      'description',
      'enabled',
      'project_id',
      'allow_submissions',
      'allow_voting',
      'require_moderation',
      'embed_allowed_origins',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<{ board: RoadmapBoardSummary }> => {
    const userId = userOf(ctx.actor);
    assertManager(ctx);

    const baseSlug = input.slug ?? slugifyBoardTitle(input.title);
    let finalSlug = baseSlug;
    if (!input.slug) {
      const existing = await ctx.trx
        .selectFrom('ludy_projects.roadmap_board')
        .select('slug')
        .where('org_id', '=', ctx.orgId)
        .where('slug', 'like', `${baseSlug}%`)
        .execute();
      const taken = new Set(existing.map((r) => r.slug));
      if (taken.has(finalSlug)) {
        for (let suffix = 2; suffix <= 99; suffix += 1) {
          const candidate = `${baseSlug.slice(0, 58)}-${suffix}`;
          if (!taken.has(candidate)) {
            finalSlug = candidate;
            break;
          }
        }
      }
    }

    const projectId = input.projectId ?? null;
    if (projectId !== null) {
      await assertPublicProjectAllowed(ctx.trx, ctx.orgId, projectId);
    }

    const origins = [...new Set(input.embedAllowedOrigins ?? [])];
    const description = cleanOptional(input.description);
    const enabled = input.enabled ?? false;
    const allowSubmissions = input.allowSubmissions ?? true;
    const allowVoting = input.allowVoting ?? true;
    const requireModeration = input.requireModeration ?? true;

    let insertedId: string;
    try {
      const row = await ctx.trx
        .insertInto('ludy_projects.roadmap_board')
        .values({
          org_id: ctx.orgId,
          slug: finalSlug,
          title: input.title,
          description,
          enabled,
          project_id: projectId,
          allow_submissions: allowSubmissions,
          allow_voting: allowVoting,
          require_moderation: requireModeration,
          embed_allowed_origins: origins,
          created_by: userId,
          created_at: ctx.now,
          updated_at: ctx.now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      insertedId = row.id;
    } catch (error) {
      mapPgBoardError(error);
    }

    ctx.audit({
      boardId: insertedId,
      slug: finalSlug,
      enabled,
      projectId,
      title: auditValue(BOARD_TABLE, 'title', input.title),
      ...(description !== null ? { description: auditValue(BOARD_TABLE, 'description', description) } : {}),
    });
    await ctx.emit('projects.roadmap.board_created', { boardId: insertedId, enabled });
    await ctx.activity('projects.roadmap_board', insertedId, 'projects.roadmap.board_created', 'Tạo bảng lộ trình công khai');
    return { board: await loadBoardSummary(ctx.trx, ctx.orgId, insertedId) };
  },
});

export const roadmapBoardUpdate = defineCommand({
  name: 'projects.roadmap.board.update',
  input: zRoadmapBoardUpdateInput,
  risk: 'R2',
  sideEffect: 'internal',
  access: MANAGERS,
  target: roadmapBoardTarget,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'roadmap_board', [
      'slug',
      'title',
      'description',
      'enabled',
      'project_id',
      'allow_submissions',
      'allow_voting',
      'require_moderation',
      'embed_allowed_origins',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<{ board: RoadmapBoardSummary }> => {
    userOf(ctx.actor);
    assertManager(ctx);

    const existing = await ctx.trx
      .selectFrom('ludy_projects.roadmap_board')
      .selectAll()
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.boardId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      throw new DomainError('ROADMAP_BOARD_NOT_FOUND', 404, 'Không tìm thấy bảng lộ trình');
    }

    const nextProjectId = input.projectId !== undefined ? input.projectId : existing.project_id;
    if (nextProjectId !== null) {
      await assertPublicProjectAllowed(ctx.trx, ctx.orgId, nextProjectId);
    }

    const nextSlug = input.slug ?? existing.slug;
    const nextTitle = input.title ?? existing.title;
    const nextDescription = input.description !== undefined ? cleanOptional(input.description) : existing.description;
    const nextEnabled = input.enabled ?? existing.enabled;
    const nextAllowSubmissions = input.allowSubmissions ?? existing.allow_submissions;
    const nextAllowVoting = input.allowVoting ?? existing.allow_voting;
    const nextRequireModeration = input.requireModeration ?? existing.require_moderation;
    const nextOrigins = input.embedAllowedOrigins !== undefined ? [...new Set(input.embedAllowedOrigins)] : existing.embed_allowed_origins;

    try {
      await ctx.trx
        .updateTable('ludy_projects.roadmap_board')
        .set({
          slug: nextSlug,
          title: nextTitle,
          description: nextDescription,
          enabled: nextEnabled,
          project_id: nextProjectId,
          allow_submissions: nextAllowSubmissions,
          allow_voting: nextAllowVoting,
          require_moderation: nextRequireModeration,
          embed_allowed_origins: nextOrigins,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
    } catch (error) {
      mapPgBoardError(error);
    }

    ctx.audit({
      boardId: existing.id,
      slug: nextSlug,
      enabled: nextEnabled,
      projectId: nextProjectId,
      ...(input.title !== undefined ? { title: auditValue(BOARD_TABLE, 'title', nextTitle) } : {}),
      ...(input.description !== undefined ? { description: auditValue(BOARD_TABLE, 'description', nextDescription) } : {}),
    });
    await ctx.emit('projects.roadmap.board_updated', { boardId: existing.id, enabled: nextEnabled });
    await ctx.activity('projects.roadmap_board', existing.id, 'projects.roadmap.board_updated', 'Cập nhật cấu hình bảng lộ trình');
    return { board: await loadBoardSummary(ctx.trx, ctx.orgId, existing.id) };
  },
});

export const roadmapItemCreate = defineCommand({
  name: 'projects.roadmap.item.create',
  input: zRoadmapItemCreateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: roadmapBoardTarget,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'roadmap_item', [
      'org_id',
      'board_id',
      'source',
      'moderation_status',
      'stage',
      'category',
      'public_title',
      'public_summary',
      'vote_count',
      'tainted',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<{ item: RoadmapAdminItem }> => {
    const userId = userOf(ctx.actor);
    const board = await ctx.trx
      .selectFrom('ludy_projects.roadmap_board')
      .select('id')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.boardId)
      .forShare()
      .executeTakeFirst();
    if (!board) {
      throw new DomainError('ROADMAP_BOARD_NOT_FOUND', 404, 'Không tìm thấy bảng lộ trình');
    }

    const summary = cleanOptional(input.publicSummary);
    const category = cleanOptional(input.category);
    const stage: RoadmapItemStage = input.stage ?? 'planned';
    const moderationStatus = input.moderationStatus ?? 'published';

    const inserted = await ctx.trx
      .insertInto('ludy_projects.roadmap_item')
      .values({
        org_id: ctx.orgId,
        board_id: board.id,
        source: 'internal',
        moderation_status: moderationStatus,
        stage,
        category,
        public_title: input.publicTitle,
        public_summary: summary,
        vote_count: 0,
        tainted: false,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    ctx.audit({
      boardId: board.id,
      itemId: inserted.id,
      stage,
      moderationStatus,
      public_title: auditValue(ITEM_TABLE, 'public_title', input.publicTitle),
      ...(summary !== null ? { public_summary: auditValue(ITEM_TABLE, 'public_summary', summary) } : {}),
    });
    await ctx.emit('projects.roadmap.item_created', { boardId: board.id, itemId: inserted.id, stage });
    await ctx.activity('projects.roadmap_item', inserted.id, 'projects.roadmap.item_created', 'Thêm mục lộ trình mới');
    return { item: await loadAdminItem(ctx.trx, ctx.orgId, inserted.id) };
  },
});

export const roadmapItemModerate = defineCommand({
  name: 'projects.roadmap.item.moderate',
  input: zRoadmapItemModerateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'projects.roadmap_item', id: input.itemId }),
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'roadmap_item', [
      'moderation_status',
      'stage',
      'public_title',
      'public_summary',
      'category',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<{ item: RoadmapAdminItem }> => {
    userOf(ctx.actor);
    const existing = await ctx.trx
      .selectFrom('ludy_projects.roadmap_item')
      .select(['id', 'board_id', 'moderation_status', 'stage', 'public_title', 'public_summary', 'category'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      throw new DomainError('ROADMAP_ITEM_NOT_FOUND', 404, 'Không tìm thấy mục lộ trình');
    }
    if (existing.moderation_status === 'merged') {
      throw new DomainError('ROADMAP_ITEM_MERGED', 409, 'Mục này đã được gộp vào mục khác nên không thể chỉnh sửa');
    }

    const nextModerationStatus = input.moderationStatus ?? (existing.moderation_status as 'pending' | 'published' | 'archived');
    const nextStage = input.stage ?? (existing.stage as RoadmapItemStage);
    const nextTitle = input.publicTitle ?? existing.public_title;
    const nextSummary = input.publicSummary !== undefined ? cleanOptional(input.publicSummary) : existing.public_summary;
    const nextCategory = input.category !== undefined ? cleanOptional(input.category) : existing.category;

    await ctx.trx
      .updateTable('ludy_projects.roadmap_item')
      .set({
        moderation_status: nextModerationStatus,
        stage: nextStage,
        public_title: nextTitle,
        public_summary: nextSummary,
        category: nextCategory,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({
      boardId: existing.board_id,
      itemId: existing.id,
      moderationStatus: nextModerationStatus,
      stage: nextStage,
      ...(input.publicTitle !== undefined ? { public_title: auditValue(ITEM_TABLE, 'public_title', nextTitle) } : {}),
      ...(input.publicSummary !== undefined ? { public_summary: auditValue(ITEM_TABLE, 'public_summary', nextSummary) } : {}),
    });
    await ctx.emit('projects.roadmap.item_moderated', {
      boardId: existing.board_id,
      itemId: existing.id,
      moderationStatus: nextModerationStatus,
      stage: nextStage,
    });
    await ctx.activity('projects.roadmap_item', existing.id, 'projects.roadmap.item_moderated', 'Kiểm duyệt mục lộ trình');
    return { item: await loadAdminItem(ctx.trx, ctx.orgId, existing.id) };
  },
});

export const roadmapItemMerge = defineCommand({
  name: 'projects.roadmap.item.merge',
  input: zRoadmapItemMergeInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'projects.roadmap_item', id: input.targetItemId }),
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'roadmap_vote', ['org_id', 'board_id', 'item_id', 'voter_email_hash', 'notify_on_ship', 'created_at']),
    tableWrite(TABLES, 'ludy_projects', 'roadmap_item', ['vote_count', 'moderation_status', 'merged_into_item_id', 'updated_at']),
  ],
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    if (input.sourceItemId === input.targetItemId) {
      throw new DomainError('VALIDATION', 422, 'Không thể gộp một mục vào chính nó');
    }

    const orderedIds = [input.sourceItemId, input.targetItemId].sort();
    const lockedRows = await ctx.trx
      .selectFrom('ludy_projects.roadmap_item')
      .select(['id', 'board_id', 'moderation_status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', 'in', orderedIds)
      .orderBy('id', 'asc')
      .forUpdate()
      .execute();

    const byId = new Map(lockedRows.map((r) => [r.id, r]));
    const source = byId.get(input.sourceItemId);
    const target = byId.get(input.targetItemId);
    if (!source || !target) {
      throw new DomainError('ROADMAP_ITEM_NOT_FOUND', 404, 'Không tìm thấy mục lộ trình để gộp');
    }
    if (source.board_id !== target.board_id) {
      throw new DomainError('VALIDATION', 422, 'Chỉ gộp được hai mục trên cùng một bảng lộ trình');
    }
    if (source.moderation_status === 'merged') {
      throw new DomainError('ROADMAP_ITEM_MERGED', 409, 'Mục nguồn đã được gộp trước đó');
    }
    if (target.moderation_status === 'merged' || target.moderation_status === 'archived') {
      throw new DomainError('ROADMAP_TARGET_INVALID', 409, 'Mục đích phải đang hoạt động hoặc chờ duyệt');
    }

    // Move distinct votes into the canonical target item without inflating counts.
    await sql`
      INSERT INTO ludy_projects.roadmap_vote (org_id, board_id, item_id, voter_email_hash, notify_on_ship, created_at)
      SELECT v.org_id, v.board_id, ${target.id}::uuid, v.voter_email_hash, v.notify_on_ship, v.created_at
        FROM ludy_projects.roadmap_vote v
       WHERE v.org_id = ${ctx.orgId}::uuid
         AND v.item_id = ${source.id}::uuid
      ON CONFLICT (org_id, item_id, voter_email_hash) DO NOTHING`.execute(ctx.trx);

    await ctx.trx
      .deleteFrom('ludy_projects.roadmap_vote')
      .where('org_id', '=', ctx.orgId)
      .where('item_id', '=', source.id)
      .execute();

    const { rows: countRows } = await sql<{ n: string }>`
      SELECT pg_catalog.count(*)::text AS n
        FROM ludy_projects.roadmap_vote
       WHERE org_id = ${ctx.orgId}::uuid
         AND item_id = ${target.id}::uuid`.execute(ctx.trx);
    const mergedVoteCount = Number(countRows[0]?.n ?? 0);

    await ctx.trx
      .updateTable('ludy_projects.roadmap_item')
      .set({ vote_count: mergedVoteCount, updated_at: ctx.now })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', target.id)
      .execute();

    await ctx.trx
      .updateTable('ludy_projects.roadmap_item')
      .set({
        moderation_status: 'merged',
        merged_into_item_id: target.id,
        vote_count: 0,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', source.id)
      .execute();

    ctx.audit({
      boardId: target.board_id,
      sourceItemId: source.id,
      targetItemId: target.id,
      mergedVoteCount,
    });
    await ctx.emit('projects.roadmap.item_merged', {
      boardId: target.board_id,
      sourceItemId: source.id,
      targetItemId: target.id,
    });
    await ctx.activity('projects.roadmap_item', target.id, 'projects.roadmap.item_merged', 'Gộp ý kiến trùng vào mục chính');
    return {
      sourceItem: await loadAdminItem(ctx.trx, ctx.orgId, source.id),
      targetItem: await loadAdminItem(ctx.trx, ctx.orgId, target.id),
    };
  },
});

export const roadmapItemConvertToTask = defineCommand({
  name: 'projects.roadmap.item.convert_to_task',
  input: zRoadmapItemConvertToTaskInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  // Calls kernel.task.create_from_roadmap via ctx.run (omits writes, matching projects.task.create).
  target: (input) => ({ type: 'projects.roadmap_item', id: input.itemId }),
  handler: async (ctx, input): Promise<{ item: RoadmapAdminItem; projectId: string; taskId: string }> => {
    const userId = userOf(ctx.actor);
    const item = await ctx.trx
      .selectFrom('ludy_projects.roadmap_item')
      .select(['id', 'board_id', 'linked_task_id', 'moderation_status', 'stage', 'public_title', 'public_summary'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .forUpdate()
      .executeTakeFirst();
    if (!item) {
      throw new DomainError('ROADMAP_ITEM_NOT_FOUND', 404, 'Không tìm thấy mục lộ trình');
    }
    if (item.moderation_status === 'merged' || item.moderation_status === 'archived') {
      throw new DomainError('ROADMAP_ITEM_NOT_ACTIVE', 409, 'Không thể chuyển mục đã gộp hoặc đã lưu trữ thành công việc');
    }
    if (item.linked_task_id !== null) {
      throw new DomainError('ROADMAP_ALREADY_LINKED', 409, 'Mục này đã được liên kết với một công việc trong dự án');
    }

    const board = await ctx.trx
      .selectFrom('ludy_projects.roadmap_board')
      .select(['id', 'project_id'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', item.board_id)
      .forShare()
      .executeTakeFirstOrThrow();

    const targetProjectId = input.projectId ?? board.project_id;
    if (!targetProjectId) {
      throw new DomainError('ROADMAP_PROJECT_REQUIRED', 422, 'Hãy chọn một dự án công khai của tổ chức để tạo công việc');
    }

    // Preview project without row lock before kernel.task.create_from_roadmap (which locks ludy_kernel.position),
    // then lock ludy_projects.project FOR SHARE afterwards to maintain canonical position -> project lock order.
    const preview = await assertPublicProjectAllowed(ctx.trx, ctx.orgId, targetProjectId, false);
    assertNotArchived(preview);

    const { taskId } = await ctx.run<{ taskId: string }>('kernel.task.create_from_roadmap', {
      itemId: item.id,
      title: input.title ?? item.public_title,
      description: item.public_summary,
      positionId: input.assigneePositionId ?? null,
      tainted: true,
    });

    const project = await assertPublicProjectAllowed(ctx.trx, ctx.orgId, targetProjectId, true);
    assertNotArchived(project);

    await ctx.trx
      .insertInto('ludy_projects.project_task')
      .values({
        org_id: ctx.orgId,
        project_id: project.id,
        task_id: taskId,
        added_by: userId,
        created_at: ctx.now,
      })
      .execute();

    const nextStage: RoadmapItemStage = item.stage === 'under_review' ? 'planned' : (item.stage as RoadmapItemStage);
    await ctx.trx
      .updateTable('ludy_projects.roadmap_item')
      .set({
        linked_task_id: taskId,
        stage: nextStage,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', item.id)
      .execute();

    ctx.audit({
      boardId: item.board_id,
      itemId: item.id,
      projectId: project.id,
      taskId,
      stage: nextStage,
    });
    await ctx.emit('projects.roadmap.item_converted', {
      boardId: item.board_id,
      itemId: item.id,
      projectId: project.id,
      taskId,
    });
    await ctx.activity('projects.roadmap_item', item.id, 'projects.roadmap.item_converted', 'Chuyển mục lộ trình thành công việc dự án');

    return {
      item: await loadAdminItem(ctx.trx, ctx.orgId, item.id),
      projectId: project.id,
      taskId,
    };
  },
});

export const roadmapItemSyncStage = defineCommand({
  name: 'projects.roadmap.item.sync_stage',
  input: zRoadmapItemSyncStageInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: (input) => ({ type: 'projects.roadmap_item', id: input.itemId }),
  writes: [tableWrite(TABLES, 'ludy_projects', 'roadmap_item', ['stage', 'updated_at'])],
  handler: async (ctx, input): Promise<{ item: RoadmapAdminItem }> => {
    userOf(ctx.actor);
    const existing = await ctx.trx
      .selectFrom('ludy_projects.roadmap_item')
      .select(['id', 'board_id', 'linked_task_id', 'moderation_status', 'stage'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.itemId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      throw new DomainError('ROADMAP_ITEM_NOT_FOUND', 404, 'Không tìm thấy mục lộ trình');
    }
    if (existing.moderation_status === 'merged') {
      throw new DomainError('ROADMAP_ITEM_MERGED', 409, 'Mục đã gộp không thể đồng bộ giai đoạn');
    }

    let nextStage = input.stage;
    if (nextStage === undefined) {
      if (!existing.linked_task_id) {
        throw new DomainError('ROADMAP_NO_LINKED_TASK', 409, 'Mục này chưa liên kết với công việc nội bộ');
      }
      const task = await ctx.trx
        .selectFrom('ludy_kernel.task')
        .select('status')
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.linked_task_id)
        .executeTakeFirst();
      nextStage = mapTaskStatusToStage(task?.status ?? null, existing.stage as RoadmapItemStage);
    }

    if (nextStage !== existing.stage) {
      await ctx.trx
        .updateTable('ludy_projects.roadmap_item')
        .set({ stage: nextStage, updated_at: ctx.now })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
    }

    ctx.audit({ boardId: existing.board_id, itemId: existing.id, from: existing.stage, to: nextStage });
    return { item: await loadAdminItem(ctx.trx, ctx.orgId, existing.id) };
  },
});

export const roadmapOtpMailData = defineCommand({
  name: 'projects.roadmap.otp_mail_data',
  input: z.strictObject({
    otpId: zId,
    wrapKey: z.string().regex(/^[a-p]{64}$/),
  }),
  sealedInput: ['wrapKey'],
  risk: 'R1',
  sideEffect: 'internal',
  access: 'system',
  writes: [tableWrite(TABLES, 'ludy_projects', 'roadmap_otp', ['otp_sha256', 'expires_at'])],
  handler: async (
    ctx,
    input,
  ): Promise<{
    sealedCode: string;
    boardTitle: string;
    expiresAt: string;
  } | null> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ worker hệ thống mới đọc được dữ liệu mã OTP');
    }
    const expiresAt = new Date(Math.max(ctx.now.getTime(), Date.now()) + ROADMAP_OTP_TTL_MS);
    const { rows } = await sql<{
      data: {
        otpId: string;
        boardId: string;
        boardSlug: string;
        boardTitle: string;
        email: string;
        code: string;
        expiresAt: string;
      } | null;
    }>`
      SELECT ludy_projects.public_roadmap_otp_issue(
        ${input.otpId}::uuid,
        ${expiresAt}::timestamptz,
        ${ctx.now}::timestamptz
      ) AS data`.execute(ctx.trx);
    const issued = rows[0]?.data ?? null;
    if (!issued) return null;
    ctx.audit({ otpId: issued.otpId, boardId: issued.boardId });
    return {
      sealedCode: sealEphemeralOtpCode(issued.code, input.wrapKey, `${issued.boardId}:${issued.otpId}`),
      boardTitle: issued.boardTitle,
      expiresAt: issued.expiresAt,
    };
  },
});

export const roadmapCommands = [
  roadmapBoardCreate,
  roadmapBoardUpdate,
  roadmapItemCreate,
  roadmapItemModerate,
  roadmapItemMerge,
  roadmapItemConvertToTask,
  roadmapItemSyncStage,
  roadmapOtpMailData,
];

export const roadmapQueries = [roadmapBoards, roadmapBoardGet];

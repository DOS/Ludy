// SPDX-License-Identifier: AGPL-3.0-only
// Internal Projects Public Roadmap management & moderation commands and queries (#4399, ADR-0057).
// All mutations go through Runtime.execute(); public submissions keep tainted = true; private projects (#2604) are refused.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  ROADMAP_ANNOUNCEMENTS_LIMIT,
  ROADMAP_BOARDS_LIMIT,
  ROADMAP_ITEMS_LIMIT,
  ROADMAP_SLUG_PATTERN,
  auditValue,
  tableWrite,
  zId,
  zRoadmapAnnouncementCreateInput,
  zRoadmapAnnouncementDeleteInput,
  zRoadmapAnnouncementPublishInput,
  zRoadmapAnnouncementSendNotificationsInput,
  zRoadmapAnnouncementUpdateInput,
  zRoadmapBoardCreateInput,
  zRoadmapBoardDetailInput,
  zRoadmapBoardUpdateInput,
  zRoadmapItemConvertToTaskInput,
  zRoadmapItemCreateInput,
  zRoadmapItemMergeInput,
  zRoadmapItemModerateInput,
  zRoadmapItemSyncStageInput,
  type RoadmapAdminItem,
  type RoadmapAnnouncement,
  type RoadmapAnnouncementLinkedItem,
  type RoadmapAnnouncementStatus,
  type RoadmapBoardDetailResult,
  type RoadmapBoardListResult,
  type RoadmapBoardSummary,
  type RoadmapItemModerationStatus,
  type RoadmapItemSource,
  type RoadmapItemStage,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { kernelManifest } from '@ludy/kernel';
import { DomainError, defineCommand, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { projectsManifest } from './manifest.ts';
import { sealEphemeralOtpCode } from './roadmap-mail.ts';
import { scrubRoadmapSignalIdempotencyResponses } from './roadmap-signals.ts';
import { READERS, WRITERS, assertNotArchived, memberProfilesMap, userOf, type ProjectRow, type Trx } from './shared.ts';

const TABLES = projectsManifest.tables;
const BOARD_TABLE = TABLES.ludy_projects.roadmap_board;
const ITEM_TABLE = TABLES.ludy_projects.roadmap_item;
const ANNOUNCEMENT_TABLE = TABLES.ludy_projects.roadmap_announcement;
const MANAGERS: readonly MemberRole[] = ['owner', 'admin'];
const ROADMAP_OTP_TTL_MS = 10 * 60_000;

function announcementTarget(input: { announcementId: string }) {
  return { type: 'projects.roadmap_announcement', id: input.announcementId };
}

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
    visibility: string;
  }>`
    SELECT p.id, p.name, p.status, p.is_template, p.visibility AS visibility
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
  if (project.visibility !== 'org') {
    throw new DomainError('ROADMAP_PRIVATE_PROJECT_FORBIDDEN', 422, 'Không thể gắn dự án riêng tư vào bảng lộ trình công khai');
  }
  return { id: project.id, name: project.name, status: project.status as ProjectRow['status'] };
}

export async function loadBoardSummary(trx: Trx, orgId: string, boardId: string): Promise<RoadmapBoardSummary> {
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
         AND p.visibility = 'org'
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
      announcements: await loadBoardAnnouncements(ctx.trx, ctx.orgId, board.id),
      activeSubscriberCount: await loadActiveSubscriberCount(ctx.trx, board.id),
      canWrite: ctx.role !== null && ctx.role !== 'viewer',
      canManageBoard: ctx.role === 'owner' || ctx.role === 'admin',
    };
  },
});

async function loadActiveSubscriberCount(trx: Trx, boardId: string): Promise<number> {
  const { rows } = await sql<{ count: number }>`
    SELECT ludy_projects.roadmap_announcement_recipient_count(${boardId}::uuid) AS count`.execute(trx);
  return Math.max(0, Number(rows[0]?.count ?? 0));
}

async function resolveLinkedItemsMap(
  trx: Trx,
  orgId: string,
  boardId: string,
  allIds: readonly string[],
): Promise<Map<string, RoadmapAnnouncementLinkedItem>> {
  const uniqueIds = [...new Set(allIds)];
  const map = new Map<string, RoadmapAnnouncementLinkedItem>();
  if (uniqueIds.length === 0) return map;
  const { rows } = await sql<{
    id: string;
    public_title: string;
    stage: string;
    moderation_status: string;
    vote_count: number;
  }>`
    SELECT i.id, i.public_title, i.stage, i.moderation_status, i.vote_count
    FROM ludy_projects.roadmap_item i
    WHERE i.org_id = ${orgId}::uuid
      AND i.board_id = ${boardId}::uuid
      AND i.id = ANY(${uniqueIds}::uuid[])`.execute(trx);
  for (const r of rows) {
    map.set(r.id, {
      id: r.id,
      publicTitle: r.public_title,
      stage: r.stage as RoadmapItemStage,
      moderationStatus: r.moderation_status as RoadmapItemModerationStatus,
      voteCount: Number(r.vote_count),
    });
  }
  return map;
}

async function loadBoardAnnouncements(trx: Trx, orgId: string, boardId: string): Promise<RoadmapAnnouncement[]> {
  const { rows } = await sql<{
    id: string;
    board_id: string;
    title: string;
    body_md: string;
    status: string;
    published_at: Date | null;
    linked_item_ids: string[];
    notifications_sent_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>`
    SELECT id, board_id, title, body_md, status, published_at, linked_item_ids, notifications_sent_at, created_at, updated_at
    FROM ludy_projects.roadmap_announcement
    WHERE org_id = ${orgId}::uuid
      AND board_id = ${boardId}::uuid
    ORDER BY
      CASE WHEN status = 'draft' THEN 0 ELSE 1 END ASC,
      published_at DESC NULLS FIRST,
      created_at DESC,
      id DESC
    LIMIT ${ROADMAP_ANNOUNCEMENTS_LIMIT}`.execute(trx);

  const allLinkedIds = rows.flatMap((r) => r.linked_item_ids ?? []);
  const linkedMap = await resolveLinkedItemsMap(trx, orgId, boardId, allLinkedIds);

  return rows.map((r) => {
    const linkedIds = r.linked_item_ids ?? [];
    return {
      id: r.id,
      boardId: r.board_id,
      title: r.title,
      bodyMd: r.body_md,
      status: r.status as RoadmapAnnouncementStatus,
      publishedAt: r.published_at ? isoString(r.published_at) : null,
      linkedItemIds: linkedIds,
      linkedItems: linkedIds.map((id) => linkedMap.get(id)).filter((item): item is RoadmapAnnouncementLinkedItem => item !== undefined),
      notificationsSentAt: r.notifications_sent_at ? isoString(r.notifications_sent_at) : null,
      createdAt: isoString(r.created_at),
      updatedAt: isoString(r.updated_at),
    };
  });
}

async function loadAnnouncementById(trx: Trx, orgId: string, announcementId: string): Promise<RoadmapAnnouncement> {
  const { rows } = await sql<{
    id: string;
    board_id: string;
    title: string;
    body_md: string;
    status: string;
    published_at: Date | null;
    linked_item_ids: string[];
    notifications_sent_at: Date | null;
    created_at: Date;
    updated_at: Date;
  }>`
    SELECT id, board_id, title, body_md, status, published_at, linked_item_ids, notifications_sent_at, created_at, updated_at
    FROM ludy_projects.roadmap_announcement
    WHERE org_id = ${orgId}::uuid
      AND id = ${announcementId}::uuid`.execute(trx);
  const r = rows[0];
  if (!r) {
    throw new DomainError('ROADMAP_ANNOUNCEMENT_NOT_FOUND', 404, 'Không tìm thấy bản cập nhật lộ trình');
  }
  const linkedIds = r.linked_item_ids ?? [];
  const linkedMap = await resolveLinkedItemsMap(trx, orgId, r.board_id, linkedIds);
  return {
    id: r.id,
    boardId: r.board_id,
    title: r.title,
    bodyMd: r.body_md,
    status: r.status as RoadmapAnnouncementStatus,
    publishedAt: r.published_at ? isoString(r.published_at) : null,
    linkedItemIds: linkedIds,
    linkedItems: linkedIds.map((id) => linkedMap.get(id)).filter((item): item is RoadmapAnnouncementLinkedItem => item !== undefined),
    notificationsSentAt: r.notifications_sent_at ? isoString(r.notifications_sent_at) : null,
    createdAt: isoString(r.created_at),
    updatedAt: isoString(r.updated_at),
  };
}

async function validateShippedLinkedItems(
  trx: Trx,
  orgId: string,
  boardId: string,
  rawItemIds: readonly string[] | undefined,
): Promise<string[]> {
  if (!rawItemIds || rawItemIds.length === 0) return [];
  const uniqueIds = [...new Set(rawItemIds)];
  const { rows } = await sql<{ id: string; stage: string; moderation_status: string }>`
    SELECT id, stage, moderation_status
    FROM ludy_projects.roadmap_item
    WHERE org_id = ${orgId}::uuid
      AND board_id = ${boardId}::uuid
      AND id = ANY(${uniqueIds}::uuid[])`.execute(trx);
  const found = new Map(rows.map((r) => [r.id, r]));
  for (const id of uniqueIds) {
    const item = found.get(id);
    if (!item) {
      throw new DomainError('ROADMAP_ITEM_NOT_FOUND', 422, 'Ý tưởng liên kết không thuộc bảng lộ trình này');
    }
    if (item.moderation_status !== 'published' || item.stage !== 'shipped') {
      throw new DomainError(
        'ROADMAP_ANNOUNCEMENT_ITEM_NOT_SHIPPED',
        422,
        'Chỉ có thể gắn các ý tưởng đã công khai ở giai đoạn Đã phát hành vào thông báo cập nhật',
      );
    }
  }
  return uniqueIds;
}

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
    tableWrite(TABLES, 'ludy_projects', 'roadmap_signal', ['org_id', 'roadmap_item_id', 'updated_at']),
    tableWrite(TABLES, 'ludy_projects', 'roadmap_item', ['vote_count', 'moderation_status', 'merged_into_item_id', 'updated_at']),
    tableWrite(kernelManifest.tables, 'ludy_kernel', 'idempotency_key', ['response']),
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

    // Deduplicate overlapping (source_type, source_id) signals before transferring remaining signals to targetItemId.
    const { rows: dedupedSignals } = await sql<{ id: string }>`
      DELETE FROM ludy_projects.roadmap_signal s
       WHERE s.org_id = ${ctx.orgId}::uuid
         AND s.roadmap_item_id = ${source.id}::uuid
         AND EXISTS (
           SELECT 1
             FROM ludy_projects.roadmap_signal t
            WHERE t.org_id = s.org_id
              AND t.roadmap_item_id = ${target.id}::uuid
              AND t.source_type = s.source_type
              AND t.source_id = s.source_id
         )
       RETURNING s.id`.execute(ctx.trx);

    await scrubRoadmapSignalIdempotencyResponses(
      ctx.trx,
      ctx.orgId,
      dedupedSignals.map((r) => r.id),
    );

    await ctx.trx
      .updateTable('ludy_projects.roadmap_signal')
      .set({
        roadmap_item_id: target.id,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('roadmap_item_id', '=', source.id)
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

export const roadmapAnnouncementCreate = defineCommand({
  name: 'projects.roadmap.announcement.create',
  input: zRoadmapAnnouncementCreateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: roadmapBoardTarget,
  writes: [
    tableWrite(TABLES, 'ludy_projects', 'roadmap_announcement', [
      'org_id',
      'board_id',
      'title',
      'body_md',
      'status',
      'linked_item_ids',
      'created_by',
      'created_at',
      'updated_at',
    ]),
  ],
  handler: async (ctx, input): Promise<{ announcement: RoadmapAnnouncement }> => {
    const userId = userOf(ctx.actor);
    const board = await loadBoardSummary(ctx.trx, ctx.orgId, input.boardId);
    if (board.projectId) {
      await assertPublicProjectAllowed(ctx.trx, ctx.orgId, board.projectId, true);
    }
    const linkedItemIds = await validateShippedLinkedItems(ctx.trx, ctx.orgId, board.id, input.linkedItemIds);

    const inserted = await ctx.trx
      .insertInto('ludy_projects.roadmap_announcement')
      .values({
        org_id: ctx.orgId,
        board_id: board.id,
        title: input.title,
        body_md: input.bodyMd,
        status: 'draft',
        published_at: null,
        linked_item_ids: linkedItemIds,
        notifications_sent_at: null,
        created_by: userId,
        created_at: ctx.now,
        updated_at: ctx.now,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    ctx.audit({
      boardId: board.id,
      announcementId: inserted.id,
      linkedCount: linkedItemIds.length,
      title: auditValue(ANNOUNCEMENT_TABLE, 'title', input.title),
      body_md: auditValue(ANNOUNCEMENT_TABLE, 'body_md', input.bodyMd),
    });
    return { announcement: await loadAnnouncementById(ctx.trx, ctx.orgId, inserted.id) };
  },
});

export const roadmapAnnouncementUpdate = defineCommand({
  name: 'projects.roadmap.announcement.update',
  input: zRoadmapAnnouncementUpdateInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: announcementTarget,
  writes: [tableWrite(TABLES, 'ludy_projects', 'roadmap_announcement', ['title', 'body_md', 'linked_item_ids', 'updated_at'])],
  handler: async (ctx, input): Promise<{ announcement: RoadmapAnnouncement }> => {
    userOf(ctx.actor);
    const existing = await ctx.trx
      .selectFrom('ludy_projects.roadmap_announcement')
      .select(['id', 'board_id', 'status', 'title', 'body_md', 'linked_item_ids'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.announcementId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      throw new DomainError('ROADMAP_ANNOUNCEMENT_NOT_FOUND', 404, 'Không tìm thấy bản cập nhật lộ trình');
    }
    if (existing.status !== 'draft') {
      throw new DomainError('ROADMAP_ANNOUNCEMENT_ALREADY_PUBLISHED', 409, 'Không thể chỉnh sửa bản cập nhật đã công bố');
    }

    const nextTitle = input.title ?? existing.title;
    const nextBodyMd = input.bodyMd ?? existing.body_md;
    const nextLinkedIds =
      input.linkedItemIds !== undefined
        ? await validateShippedLinkedItems(ctx.trx, ctx.orgId, existing.board_id, input.linkedItemIds)
        : existing.linked_item_ids;

    await ctx.trx
      .updateTable('ludy_projects.roadmap_announcement')
      .set({
        title: nextTitle,
        body_md: nextBodyMd,
        linked_item_ids: nextLinkedIds,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({
      boardId: existing.board_id,
      announcementId: existing.id,
      linkedCount: nextLinkedIds.length,
      title: auditValue(ANNOUNCEMENT_TABLE, 'title', nextTitle),
      body_md: auditValue(ANNOUNCEMENT_TABLE, 'body_md', nextBodyMd),
    });
    return { announcement: await loadAnnouncementById(ctx.trx, ctx.orgId, existing.id) };
  },
});

export const roadmapAnnouncementPublish = defineCommand({
  name: 'projects.roadmap.announcement.publish',
  input: zRoadmapAnnouncementPublishInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: MANAGERS,
  target: announcementTarget,
  writes: [tableWrite(TABLES, 'ludy_projects', 'roadmap_announcement', ['status', 'published_at', 'updated_at'])],
  handler: async (ctx, input): Promise<{ announcement: RoadmapAnnouncement }> => {
    userOf(ctx.actor);
    assertManager(ctx);
    const existing = await ctx.trx
      .selectFrom('ludy_projects.roadmap_announcement')
      .select(['id', 'board_id', 'status', 'published_at', 'linked_item_ids'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.announcementId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      throw new DomainError('ROADMAP_ANNOUNCEMENT_NOT_FOUND', 404, 'Không tìm thấy bản cập nhật lộ trình');
    }
    const board = await loadBoardSummary(ctx.trx, ctx.orgId, existing.board_id);
    if (board.projectId) {
      await assertPublicProjectAllowed(ctx.trx, ctx.orgId, board.projectId, true);
    }
    if (existing.linked_item_ids.length > 0) {
      await validateShippedLinkedItems(ctx.trx, ctx.orgId, existing.board_id, existing.linked_item_ids);
    }

    if (existing.status !== 'published') {
      await ctx.trx
        .updateTable('ludy_projects.roadmap_announcement')
        .set({
          status: 'published',
          published_at: existing.published_at ?? ctx.now,
          updated_at: ctx.now,
        })
        .where('org_id', '=', ctx.orgId)
        .where('id', '=', existing.id)
        .execute();
      await ctx.emit('projects.roadmap.announcement_published', {
        boardId: existing.board_id,
        announcementId: existing.id,
      });
      await ctx.activity('projects.roadmap_announcement', existing.id, 'projects.roadmap.announcement.published', 'Công bố bản cập nhật trên bảng lộ trình');
    }

    ctx.audit({ boardId: existing.board_id, announcementId: existing.id, status: 'published' });
    return { announcement: await loadAnnouncementById(ctx.trx, ctx.orgId, existing.id) };
  },
});

export const roadmapAnnouncementDelete = defineCommand({
  name: 'projects.roadmap.announcement.delete',
  input: zRoadmapAnnouncementDeleteInput,
  risk: 'R1',
  sideEffect: 'internal',
  access: WRITERS,
  target: announcementTarget,
  writes: [tableWrite(TABLES, 'ludy_projects', 'roadmap_announcement', ['org_id', 'id'])],
  handler: async (ctx, input): Promise<{ deleted: boolean }> => {
    userOf(ctx.actor);
    const existing = await ctx.trx
      .selectFrom('ludy_projects.roadmap_announcement')
      .select(['id', 'board_id', 'status'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.announcementId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      throw new DomainError('ROADMAP_ANNOUNCEMENT_NOT_FOUND', 404, 'Không tìm thấy bản cập nhật lộ trình');
    }
    if (existing.status !== 'draft') {
      throw new DomainError('ROADMAP_ANNOUNCEMENT_ALREADY_PUBLISHED', 409, 'Không thể xóa bản cập nhật đã công bố');
    }
    await ctx.trx
      .deleteFrom('ludy_projects.roadmap_announcement')
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    ctx.audit({ boardId: existing.board_id, announcementId: existing.id, deleted: true });
    return { deleted: true };
  },
});

export const roadmapAnnouncementSendNotifications = defineCommand({
  name: 'projects.roadmap.announcement.send_notifications',
  input: zRoadmapAnnouncementSendNotificationsInput,
  risk: 'R2',
  sideEffect: 'external',
  access: MANAGERS,
  target: announcementTarget,
  writes: [tableWrite(TABLES, 'ludy_projects', 'roadmap_announcement', ['notifications_sent_at', 'updated_at'])],
  handler: async (ctx, input) => {
    userOf(ctx.actor);
    assertManager(ctx);

    const existing = await ctx.trx
      .selectFrom('ludy_projects.roadmap_announcement')
      .select(['id', 'board_id', 'status', 'notifications_sent_at'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.announcementId)
      .forUpdate()
      .executeTakeFirst();
    if (!existing) {
      throw new DomainError('ROADMAP_ANNOUNCEMENT_NOT_FOUND', 404, 'Không tìm thấy bản cập nhật lộ trình');
    }
    if (existing.status !== 'published') {
      throw new DomainError('ROADMAP_ANNOUNCEMENT_NOT_PUBLISHED', 409, 'Cần công bố bản cập nhật trước khi gửi thông báo cho người đăng ký');
    }

    const board = await loadBoardSummary(ctx.trx, ctx.orgId, existing.board_id);
    if (!board.enabled) {
      throw new DomainError('ROADMAP_BOARD_DISABLED', 409, 'Bảng lộ trình đang tắt công khai nên chưa thể gửi thông báo');
    }
    if (board.projectId) {
      await assertPublicProjectAllowed(ctx.trx, ctx.orgId, board.projectId, true);
    }

    // Idempotent guard: once notifications_sent_at is stamped, never enqueue a duplicate notification batch.
    if (existing.notifications_sent_at !== null) {
      const current = await loadAnnouncementById(ctx.trx, ctx.orgId, existing.id);
      ctx.audit({ boardId: existing.board_id, announcementId: existing.id, alreadySent: true, eligibleCount: 0 });
      return { announcement: current, eligibleCount: 0, queuedDispatch: false };
    }

    const eligibleCount = await loadActiveSubscriberCount(ctx.trx, existing.board_id);
    await ctx.trx
      .updateTable('ludy_projects.roadmap_announcement')
      .set({
        notifications_sent_at: ctx.now,
        updated_at: ctx.now,
      })
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', existing.id)
      .execute();

    const queuedDispatch = eligibleCount > 0;
    if (queuedDispatch) {
      await ctx.emit('projects.roadmap.announcement_notify', {
        boardId: existing.board_id,
        announcementId: existing.id,
      });
      await ctx.activity(
        'projects.roadmap_announcement',
        existing.id,
        'projects.roadmap.announcement.send_notifications',
        `Gửi thông báo tính năng mới cho ${eligibleCount} người đăng ký`,
      );
    }

    // Counts and ids only: never expose subscriber emails or announcement free text in audit metadata.
    ctx.audit({
      boardId: existing.board_id,
      announcementId: existing.id,
      eligibleCount,
      queuedDispatch,
    });
    return {
      announcement: await loadAnnouncementById(ctx.trx, ctx.orgId, existing.id),
      eligibleCount,
      queuedDispatch,
    };
  },
});

export const roadmapShippedMailData = defineQuery({
  name: 'projects.roadmap.shipped_mail_data',
  input: z.strictObject({
    announcementId: zId,
    subscriberId: zId,
  }),
  access: 'system',
  handler: async (
    ctx,
    input,
  ): Promise<{
    title: string;
    bodyMd: string;
    linkedItems: Array<{ id: string; publicTitle: string }>;
    voterEmailHash: string;
    unsubTokenSealed: string;
  } | null> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ worker hệ thống mới đọc được dữ liệu email cập nhật');
    }
    const { rows: annRows } = await sql<{
      board_id: string;
      title: string;
      body_md: string;
      status: string;
      linked_item_ids: string[];
      board_enabled: boolean;
      project_id: string | null;
      project_visibility: string | null;
    }>`
      SELECT
        a.board_id,
        a.title,
        a.body_md,
        a.status,
        a.linked_item_ids,
        b.enabled AS board_enabled,
        b.project_id,
        p.visibility AS project_visibility
      FROM ludy_projects.roadmap_announcement a
      JOIN ludy_projects.roadmap_board b
        ON b.org_id = a.org_id AND b.id = a.board_id
      LEFT JOIN ludy_projects.project p
        ON p.org_id = b.org_id AND p.id = b.project_id
      WHERE a.org_id = ${ctx.orgId}::uuid
        AND a.id = ${input.announcementId}::uuid`.execute(ctx.trx);

    const ann = annRows[0];
    if (!ann || ann.status !== 'published' || !ann.board_enabled || (ann.project_id !== null && ann.project_visibility !== 'org')) {
      return null;
    }

    const { rows: subRows } = await sql<{ data: { voterEmailHash: string; unsubTokenSealed: string } | null }>`
      SELECT ludy_projects.roadmap_subscriber_unsub_sealed(${ann.board_id}::uuid, ${input.subscriberId}::uuid) AS data`.execute(ctx.trx);
    const sub = subRows[0]?.data;
    if (!sub?.voterEmailHash || !sub?.unsubTokenSealed) {
      return null;
    }

    const linkedMap = await resolveLinkedItemsMap(ctx.trx, ctx.orgId, ann.board_id, ann.linked_item_ids ?? []);
    const linkedItems = (ann.linked_item_ids ?? [])
      .map((id) => linkedMap.get(id))
      .filter((item): item is RoadmapAnnouncementLinkedItem => item !== undefined && item.moderationStatus === 'published' && item.stage === 'shipped')
      .map((item) => ({ id: item.id, publicTitle: item.publicTitle }));

    return {
      title: ann.title,
      bodyMd: ann.body_md,
      linkedItems,
      voterEmailHash: sub.voterEmailHash,
      unsubTokenSealed: sub.unsubTokenSealed,
    };
  },
});

export interface RoadmapAiDedupeSource {
  boardTitle: string;
  todayVn: string;
  aiStopped: boolean;
  aiBudgetSpent: boolean;
  items: Array<{
    id: string;
    publicTitle: string;
    publicSummary: string | null;
    stage: RoadmapItemStage;
    moderationStatus: 'pending' | 'published';
    voteCount: number;
    tainted: boolean;
    category: string | null;
  }>;
  truncated: boolean;
}

export interface RoadmapAiChangelogSource {
  boardTitle: string;
  todayVn: string;
  aiStopped: boolean;
  aiBudgetSpent: boolean;
  items: Array<{
    id: string;
    publicTitle: string;
    publicSummary: string | null;
    category: string | null;
    tainted: boolean;
  }>;
}

export async function loadProjectsAiMeta(trx: Trx, orgId: string): Promise<{ todayVn: string; aiStopped: boolean; aiBudgetSpent: boolean }> {
  const { rows } = await sql<{
    today_vn: string;
    ai_stopped: boolean;
    budget_spent: boolean;
  }>`
    SELECT
      pg_catalog.to_char((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS today_vn,
      (
        ludy_kernel.global_kill_switch_on('ai')
        OR EXISTS (
          SELECT 1 FROM ludy_kernel.kill_switch k
           WHERE k.org_id = ${orgId}::uuid
             AND k.released_at IS NULL
             AND (k.scope = 'org' OR (k.scope = 'module' AND k.target = 'projects'))
        )
      ) AS ai_stopped,
      ludy_kernel.ai_budget_exhausted(${orgId}::uuid, 'projects', NULL::uuid) AS budget_spent`.execute(trx);
  const meta = rows[0];
  return {
    todayVn: meta?.today_vn ?? new Date().toISOString().slice(0, 10),
    aiStopped: meta?.ai_stopped === true,
    aiBudgetSpent: meta?.budget_spent === true,
  };
}

export const roadmapAiDedupeSource = defineQuery({
  name: 'projects.roadmap.ai_dedupe_source',
  input: z.strictObject({ boardId: zId }),
  access: WRITERS,
  handler: async (ctx, input): Promise<RoadmapAiDedupeSource> => {
    userOf(ctx.actor);
    const board = await loadBoardSummary(ctx.trx, ctx.orgId, input.boardId);
    const meta = await loadProjectsAiMeta(ctx.trx, ctx.orgId);
    const { rows } = await sql<{
      id: string;
      public_title: string;
      public_summary: string | null;
      stage: string;
      moderation_status: string;
      vote_count: number;
      tainted: boolean;
      category: string | null;
    }>`
      SELECT id, public_title, public_summary, stage, moderation_status, vote_count, tainted, category
      FROM ludy_projects.roadmap_item
      WHERE org_id = ${ctx.orgId}::uuid
        AND board_id = ${board.id}::uuid
        AND moderation_status IN ('pending', 'published')
      ORDER BY
        CASE WHEN moderation_status = 'pending' THEN 0 ELSE 1 END ASC,
        vote_count DESC,
        created_at DESC,
        id DESC
      LIMIT 61`.execute(ctx.trx);

    const truncated = rows.length > 60;
    const bounded = rows.slice(0, 60);
    return {
      boardTitle: board.title,
      todayVn: meta.todayVn,
      aiStopped: meta.aiStopped,
      aiBudgetSpent: meta.aiBudgetSpent,
      items: bounded.map((r) => ({
        id: r.id,
        publicTitle: r.public_title,
        publicSummary: r.public_summary,
        stage: r.stage as RoadmapItemStage,
        moderationStatus: r.moderation_status as 'pending' | 'published',
        voteCount: Number(r.vote_count),
        tainted: Boolean(r.tainted),
        category: r.category,
      })),
      truncated,
    };
  },
});

export const roadmapAiChangelogSource = defineQuery({
  name: 'projects.roadmap.ai_changelog_source',
  input: z.strictObject({
    boardId: zId,
    itemIds: z.array(zId).min(1).max(20),
  }),
  access: WRITERS,
  handler: async (ctx, input): Promise<RoadmapAiChangelogSource> => {
    userOf(ctx.actor);
    const board = await loadBoardSummary(ctx.trx, ctx.orgId, input.boardId);
    const meta = await loadProjectsAiMeta(ctx.trx, ctx.orgId);
    const validIds = await validateShippedLinkedItems(ctx.trx, ctx.orgId, board.id, input.itemIds);
    const { rows } = await sql<{
      id: string;
      public_title: string;
      public_summary: string | null;
      category: string | null;
      tainted: boolean;
    }>`
      SELECT id, public_title, public_summary, category, tainted
      FROM ludy_projects.roadmap_item
      WHERE org_id = ${ctx.orgId}::uuid
        AND board_id = ${board.id}::uuid
        AND id = ANY(${validIds}::uuid[])
        AND moderation_status = 'published'
        AND stage = 'shipped'`.execute(ctx.trx);

    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      boardTitle: board.title,
      todayVn: meta.todayVn,
      aiStopped: meta.aiStopped,
      aiBudgetSpent: meta.aiBudgetSpent,
      items: validIds
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .map((r) => ({
          id: r.id,
          publicTitle: r.public_title,
          publicSummary: r.public_summary,
          category: r.category,
          tainted: Boolean(r.tainted),
        })),
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
  roadmapAnnouncementCreate,
  roadmapAnnouncementUpdate,
  roadmapAnnouncementPublish,
  roadmapAnnouncementDelete,
  roadmapAnnouncementSendNotifications,
  roadmapOtpMailData,
];

export const roadmapAnnouncementFromEvent = defineQuery({
  name: 'projects.roadmap.announcement_from_event',
  input: z.strictObject({ eventId: zId }),
  access: 'system',
  handler: async (ctx, input): Promise<{ announcementId: string } | null> => {
    if (ctx.actor.type !== 'system') {
      throw new DomainError('FORBIDDEN', 403, 'Chỉ worker hệ thống mới đọc được sự kiện gửi thông báo');
    }
    const row = await ctx.trx
      .selectFrom('ludy_kernel.outbox_event')
      .select(['payload'])
      .where('org_id', '=', ctx.orgId)
      .where('id', '=', input.eventId)
      .where('type', '=', 'projects.roadmap.announcement_notify')
      .executeTakeFirst();
    const payload = row?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const announcementId = (payload as Record<string, unknown>).announcementId;
    return typeof announcementId === 'string' && zId.safeParse(announcementId).success ? { announcementId } : null;
  },
});

export const roadmapQueries = [
  roadmapBoards,
  roadmapBoardGet,
  roadmapShippedMailData,
  roadmapAiDedupeSource,
  roadmapAiChangelogSource,
  roadmapAnnouncementFromEvent,
];

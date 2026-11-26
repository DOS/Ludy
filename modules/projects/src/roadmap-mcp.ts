// SPDX-License-Identifier: AGPL-3.0-only
// Read-only MCP queries for Projects Public Roadmap (Slice 2 #4400, ADR-0051, ADR-0057).
// Strictly restricted to owner/admin company grants (`ludy.read`), excludes voter_email_hash, roadmap_otp,
// roadmap_subscriber, and private projects (#2604), passes user text through plainLine(), and tags external ideas.
import { sql } from 'kysely';
import { z } from 'zod';
import {
  PROJECT_TRIAGE_STATUSES,
  ROADMAP_ITEM_MODERATION_STATUSES,
  ROADMAP_ITEM_STAGES,
  plainLine,
  zId,
  type ProjectTriagePriority,
  type ProjectTriageSourceType,
  type ProjectTriageStatus,
} from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { loadProject } from './shared.ts';
import { ctxQueryFn } from './tasks-from-source.ts';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
export const MCP_ROADMAP_DEFAULT = 25;
export const MCP_ROADMAP_MAX = 50;
const TITLE_MAX = 200;
const SUMMARY_MAX = 400;
const CATEGORY_MAX = 60;
const NAME_MAX = 80;

const zLimit = z
  .number()
  .int()
  .min(1)
  .max(MCP_ROADMAP_MAX)
  .default(MCP_ROADMAP_DEFAULT)
  .describe(`How many roadmap ideas to return (1 to ${MCP_ROADMAP_MAX}, default ${MCP_ROADMAP_DEFAULT}).`);

const zIdeasCursor = z
  .strictObject({
    voteCount: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
    id: zId,
  })
  .describe('The `next` cursor from the previous answer to read the following page.');

export const zMcpRoadmapIdeasInput = z.strictObject({
  boardId: zId.optional().describe('Only ideas on this public roadmap board.'),
  stage: z.enum(ROADMAP_ITEM_STAGES).optional().describe('Only ideas in this stage: under_review, planned, in_progress, or shipped.'),
  moderationStatus: z
    .enum(ROADMAP_ITEM_MODERATION_STATUSES)
    .optional()
    .describe('Only ideas with this moderation status: pending, published, merged, or archived.'),
  taintedOnly: z.boolean().optional().describe('When true, return only visitor submissions (source: public_submission).'),
  limit: zLimit,
  cursor: zIdeasCursor.optional(),
});
export type McpRoadmapIdeasInput = z.infer<typeof zMcpRoadmapIdeasInput>;

export const zMcpRoadmapDemandSummaryInput = z.strictObject({
  boardId: zId.optional().describe('Summarize demand for one public roadmap board. Leave out to summarize all non-private boards.'),
  topLimit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(10)
    .describe('Maximum number of top-voted published ideas to include (1 to 20, default 10).'),
});
export type McpRoadmapDemandSummaryInput = z.infer<typeof zMcpRoadmapDemandSummaryInput>;

export const MCP_TRIAGE_DEFAULT = 25;
export const MCP_TRIAGE_MAX = 100;

export const zMcpTriageSummaryInput = z.strictObject({
  projectId: zId.optional().describe('Optional non-private project ID to scope the triage summary.'),
  status: z.enum(PROJECT_TRIAGE_STATUSES).optional().describe('Filter items by status: pending, snoozed, accepted, merged, or declined.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_TRIAGE_MAX)
    .optional()
    .describe(`Maximum number of triage items to include (1 to ${MCP_TRIAGE_MAX}, default ${MCP_TRIAGE_DEFAULT}).`),
});
export type McpTriageSummaryInput = z.infer<typeof zMcpTriageSummaryInput>;

function requireCompanyGrantor(ctx: QueryContext): void {
  if (!ctx.role || !GRANTORS.includes(ctx.role)) {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ chủ sở hữu hoặc quản trị viên mới đọc được dữ liệu lộ trình qua MCP');
  }
  if (ctx.actor.type === 'user' && ctx.actor.mcp?.kind === 'member') {
    throw new DomainError('FORBIDDEN', 403, 'Chỉ kết nối cấp công ty mới đọc được dữ liệu lộ trình qua MCP');
  }
}

export const mcpRoadmapIdeas = defineQuery({
  name: 'projects.mcp.roadmap_ideas',
  input: zMcpRoadmapIdeasInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input) => {
    requireCompanyGrantor(ctx);

    const { rows } = await sql<{
      id: string;
      board_id: string;
      board_slug: string;
      board_title: string;
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
        b.slug AS board_slug,
        b.title AS board_title,
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
      JOIN ludy_projects.roadmap_board b
        ON b.org_id = i.org_id
       AND b.id = i.board_id
      LEFT JOIN ludy_projects.project p
        ON p.org_id = b.org_id
       AND p.id = b.project_id
      WHERE i.org_id = ${ctx.orgId}::uuid
        AND (b.project_id IS NULL OR p.visibility = 'org')
        ${input.boardId ? sql`AND i.board_id = ${input.boardId}::uuid` : sql``}
        ${input.stage ? sql`AND i.stage = ${input.stage}` : sql``}
        ${input.moderationStatus ? sql`AND i.moderation_status = ${input.moderationStatus}` : sql``}
        ${input.taintedOnly === true ? sql`AND i.tainted = true` : sql``}
        ${
          input.cursor
            ? sql`AND (i.vote_count, i.created_at, i.id) < (${input.cursor.voteCount}::int, ${input.cursor.createdAt}::timestamptz, ${input.cursor.id}::uuid)`
            : sql``
        }
      ORDER BY i.vote_count DESC, i.created_at DESC, i.id DESC
      LIMIT ${input.limit + 1}`.execute(ctx.trx);

    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];

    return {
      ideas: page.map((r) => ({
        id: r.id,
        boardId: r.board_id,
        boardSlug: r.board_slug,
        boardTitle: plainLine(r.board_title, 120),
        source: r.source,
        moderationStatus: r.moderation_status,
        mergedIntoItemId: r.merged_into_item_id,
        stage: r.stage,
        category: r.category ? plainLine(r.category, CATEGORY_MAX) : null,
        publicTitle: plainLine(r.public_title, TITLE_MAX),
        publicSummary: r.public_summary ? plainLine(r.public_summary, SUMMARY_MAX) : null,
        voteCount: r.vote_count,
        tainted: Boolean(r.tainted),
        sourceTrust: r.tainted ? ('external' as const) : ('internal' as const),
        submitterDisplayName: r.submitter_display_name ? plainLine(r.submitter_display_name, NAME_MAX) : null,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
      })),
      next:
        hasMore && last
          ? {
              voteCount: last.vote_count,
              createdAt: last.created_at.toISOString(),
              id: last.id,
            }
          : null,
    };
  },
});

export const mcpRoadmapDemandSummary = defineQuery({
  name: 'projects.mcp.roadmap_demand_summary',
  input: zMcpRoadmapDemandSummaryInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input) => {
    requireCompanyGrantor(ctx);

    const { rows: boards } = await sql<{ id: string; slug: string; title: string; enabled: boolean }>`
      SELECT b.id, b.slug, b.title, b.enabled
      FROM ludy_projects.roadmap_board b
      LEFT JOIN ludy_projects.project p
        ON p.org_id = b.org_id
       AND p.id = b.project_id
      WHERE b.org_id = ${ctx.orgId}::uuid
        AND (b.project_id IS NULL OR p.visibility = 'org')
        ${input.boardId ? sql`AND b.id = ${input.boardId}::uuid` : sql``}
      ORDER BY b.created_at ASC, b.id ASC`.execute(ctx.trx);

    if (input.boardId && boards.length === 0) {
      throw new DomainError('ROADMAP_BOARD_NOT_FOUND', 404, 'Không tìm thấy bảng lộ trình công khai');
    }

    const { rows: counts } = await sql<{
      pending_count: string;
      published_count: string;
      merged_count: string;
      archived_count: string;
      under_review_count: string;
      planned_count: string;
      in_progress_count: string;
      shipped_count: string;
      total_published_votes: string;
      tainted_items_count: string;
    }>`
      SELECT
        pg_catalog.count(*) FILTER (WHERE i.moderation_status = 'pending')::text AS pending_count,
        pg_catalog.count(*) FILTER (WHERE i.moderation_status = 'published')::text AS published_count,
        pg_catalog.count(*) FILTER (WHERE i.moderation_status = 'merged')::text AS merged_count,
        pg_catalog.count(*) FILTER (WHERE i.moderation_status = 'archived')::text AS archived_count,
        pg_catalog.count(*) FILTER (WHERE i.moderation_status = 'published' AND i.stage = 'under_review')::text AS under_review_count,
        pg_catalog.count(*) FILTER (WHERE i.moderation_status = 'published' AND i.stage = 'planned')::text AS planned_count,
        pg_catalog.count(*) FILTER (WHERE i.moderation_status = 'published' AND i.stage = 'in_progress')::text AS in_progress_count,
        pg_catalog.count(*) FILTER (WHERE i.moderation_status = 'published' AND i.stage = 'shipped')::text AS shipped_count,
        COALESCE(pg_catalog.sum(i.vote_count) FILTER (WHERE i.moderation_status = 'published'), 0)::text AS total_published_votes,
        pg_catalog.count(*) FILTER (WHERE i.tainted = true)::text AS tainted_items_count
      FROM ludy_projects.roadmap_item i
      JOIN ludy_projects.roadmap_board b
        ON b.org_id = i.org_id
       AND b.id = i.board_id
      LEFT JOIN ludy_projects.project p
        ON p.org_id = b.org_id
       AND p.id = b.project_id
      WHERE i.org_id = ${ctx.orgId}::uuid
        AND (b.project_id IS NULL OR p.visibility = 'org')
        ${input.boardId ? sql`AND i.board_id = ${input.boardId}::uuid` : sql``}`.execute(ctx.trx);

    const { rows: topRows } = await sql<{
      id: string;
      board_id: string;
      board_title: string;
      stage: string;
      category: string | null;
      public_title: string;
      vote_count: number;
      tainted: boolean;
    }>`
      SELECT i.id, i.board_id, b.title AS board_title, i.stage, i.category, i.public_title, i.vote_count, i.tainted
      FROM ludy_projects.roadmap_item i
      JOIN ludy_projects.roadmap_board b
        ON b.org_id = i.org_id
       AND b.id = i.board_id
      LEFT JOIN ludy_projects.project p
        ON p.org_id = b.org_id
       AND p.id = b.project_id
      WHERE i.org_id = ${ctx.orgId}::uuid
        AND i.moderation_status = 'published'
        AND (b.project_id IS NULL OR p.visibility = 'org')
        ${input.boardId ? sql`AND i.board_id = ${input.boardId}::uuid` : sql``}
      ORDER BY i.vote_count DESC, i.created_at DESC, i.id DESC
      LIMIT ${input.topLimit}`.execute(ctx.trx);

    const { rows: annRows } = await sql<{
      id: string;
      board_id: string;
      title: string;
      published_at: Date;
    }>`
      SELECT a.id, a.board_id, a.title, a.published_at
      FROM ludy_projects.roadmap_announcement a
      JOIN ludy_projects.roadmap_board b
        ON b.org_id = a.org_id
       AND b.id = a.board_id
      LEFT JOIN ludy_projects.project p
        ON p.org_id = b.org_id
       AND p.id = b.project_id
      WHERE a.org_id = ${ctx.orgId}::uuid
        AND a.status = 'published'
        AND (b.project_id IS NULL OR p.visibility = 'org')
        ${input.boardId ? sql`AND a.board_id = ${input.boardId}::uuid` : sql``}
      ORDER BY a.published_at DESC, a.id DESC
      LIMIT 10`.execute(ctx.trx);

    const c = counts[0];
    return {
      boards: boards.map((b) => ({
        id: b.id,
        slug: b.slug,
        title: plainLine(b.title, 120),
        enabled: b.enabled,
      })),
      moderationCounts: {
        pending: Number(c?.pending_count ?? 0),
        published: Number(c?.published_count ?? 0),
        merged: Number(c?.merged_count ?? 0),
        archived: Number(c?.archived_count ?? 0),
      },
      stageCounts: {
        underReview: Number(c?.under_review_count ?? 0),
        planned: Number(c?.planned_count ?? 0),
        inProgress: Number(c?.in_progress_count ?? 0),
        shipped: Number(c?.shipped_count ?? 0),
      },
      totalPublishedVotes: Number(c?.total_published_votes ?? 0),
      taintedItemsCount: Number(c?.tainted_items_count ?? 0),
      topIdeas: topRows.map((r) => ({
        id: r.id,
        boardId: r.board_id,
        boardTitle: plainLine(r.board_title, 120),
        stage: r.stage,
        category: r.category ? plainLine(r.category, CATEGORY_MAX) : null,
        publicTitle: plainLine(r.public_title, TITLE_MAX),
        voteCount: r.vote_count,
        tainted: Boolean(r.tainted),
        sourceTrust: r.tainted ? ('external' as const) : ('internal' as const),
      })),
      recentPublishedAnnouncements: annRows.map((a) => ({
        id: a.id,
        boardId: a.board_id,
        title: plainLine(a.title, TITLE_MAX),
        publishedAt: a.published_at.toISOString(),
      })),
    };
  },
});

export const mcpTriageSummary = defineQuery({
  name: 'projects.mcp.triage_summary',
  input: zMcpTriageSummaryInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input) => {
    requireCompanyGrantor(ctx);

    if (input.projectId !== undefined) {
      const project = await loadProject(ctx.trx, ctx.orgId, input.projectId, false);
      if (project.visibility !== 'org' || project.status === 'archived') {
        throw new DomainError('PROJECT_NOT_FOUND', 404, 'Không tìm thấy dự án này');
      }
    }

    const limit = input.limit ?? MCP_TRIAGE_DEFAULT;

    const now = new Date();
    const nowIso = now.toISOString();
    const nowMs = now.getTime();
    // Resolve org-visible published in-retention meetings strictly through meetings.mcp.visible_ids via ctx.query
    // (never query the Meetings module tables directly). Fails closed when Meetings is uninstalled or refuses the caller.
    let visibleMeetingQuery = ctx.trx
      .selectFrom('ludy_projects.project_triage_item as pti')
      .innerJoin('ludy_projects.project as p', (join) =>
        join.onRef('p.org_id', '=', 'pti.org_id').onRef('p.id', '=', 'pti.project_id'),
      )
      .select('pti.source_id')
      .distinct()
      .where('pti.org_id', '=', ctx.orgId)
      .where('p.is_template', '=', false)
      .where('p.status', '<>', 'archived')
      .where('p.visibility', '=', 'org')
      .where('pti.source_type', '=', 'meetings.meeting')
      .where('pti.source_id', 'is not', null);
    if (input.projectId !== undefined) {
      visibleMeetingQuery = visibleMeetingQuery.where('pti.project_id', '=', input.projectId);
    }
    const candidateMeetingRows = await visibleMeetingQuery.execute();
    const candidateMeetingIds = candidateMeetingRows
      .map((r) => r.source_id)
      .filter((id): id is string => typeof id === 'string');

    const visibleMeetingIds = new Set<string>();
    if (candidateMeetingIds.length > 0 && ctx.installed('meetings')) {
      const query = ctxQueryFn(ctx);
      for (let offset = 0; offset < candidateMeetingIds.length; offset += 200) {
        const batch = candidateMeetingIds.slice(offset, offset + 200);
        try {
          const res = await query<{ visibleIds: string[] }>('meetings.mcp.visible_ids', { meetingIds: batch });
          if (res.status === 'not_installed') {
            visibleMeetingIds.clear();
            break;
          }
          for (const id of res.value.visibleIds) {
            visibleMeetingIds.add(id);
          }
        } catch (err) {
          if (!(err instanceof DomainError && (err.status === 403 || err.status === 404))) {
            throw err;
          }
          visibleMeetingIds.clear();
          break;
        }
      }
    }

    const visibleMeetingIdList = [...visibleMeetingIds];
    const meetingVisibilityGuard =
      visibleMeetingIdList.length > 0
        ? sql<boolean>`(pti.source_type <> 'meetings.meeting' OR (pti.source_id IS NOT NULL AND pti.source_id = ANY(${visibleMeetingIdList}::uuid[])))`
        : sql<boolean>`pti.source_type <> 'meetings.meeting'`;

    const { rows: countRows } = await sql<{
      pending: string;
      snoozed: string;
      accepted: string;
      merged: string;
      declined: string;
      snooze_elapsed: string;
      tainted_count: string;
    }>`
      SELECT
        pg_catalog.count(*) FILTER (WHERE pti.status = 'pending')::text AS pending,
        pg_catalog.count(*) FILTER (WHERE pti.status = 'snoozed')::text AS snoozed,
        pg_catalog.count(*) FILTER (WHERE pti.status = 'accepted')::text AS accepted,
        pg_catalog.count(*) FILTER (WHERE pti.status = 'merged')::text AS merged,
        pg_catalog.count(*) FILTER (WHERE pti.status = 'declined')::text AS declined,
        pg_catalog.count(*) FILTER (WHERE pti.status = 'snoozed' AND pti.snoozed_until <= ${nowIso}::timestamptz)::text AS snooze_elapsed,
        pg_catalog.count(*) FILTER (WHERE pti.tainted)::text AS tainted_count
      FROM ludy_projects.project_triage_item pti
      JOIN ludy_projects.project p
        ON p.org_id = pti.org_id
       AND p.id = pti.project_id
     WHERE pti.org_id = ${ctx.orgId}::uuid
       AND p.is_template = false
       AND p.status <> 'archived'
       AND p.visibility = 'org'
       AND ${meetingVisibilityGuard}
       ${input.projectId !== undefined ? sql`AND p.id = ${input.projectId}::uuid` : sql``}`.execute(ctx.trx);

    const rowQuery = ctx.trx
      .selectFrom('ludy_projects.project_triage_item as pti')
      .innerJoin('ludy_projects.project as p', (join) =>
        join.onRef('p.org_id', '=', 'pti.org_id').onRef('p.id', '=', 'pti.project_id'),
      )
      .select([
        'pti.id',
        'pti.project_id',
        'p.name as project_name',
        'pti.source_type',
        'pti.source_id',
        'pti.status',
        'pti.priority',
        'pti.title',
        'pti.tainted',
        'pti.snoozed_until',
        'pti.accepted_task_id',
        'pti.merged_into_task_id',
        'pti.created_at',
      ])
      .where('pti.org_id', '=', ctx.orgId)
      .where('p.is_template', '=', false)
      .where('p.status', '<>', 'archived')
      .where('p.visibility', '=', 'org')
      .where(meetingVisibilityGuard)
      .$if(input.projectId !== undefined, (qb) => qb.where('pti.project_id', '=', input.projectId!))
      .$if(input.status !== undefined, (qb) => qb.where('pti.status', '=', input.status!))
      .orderBy('pti.created_at', 'desc')
      .orderBy('pti.id', 'desc')
      .limit(limit);

    const rows = await rowQuery.execute();
    const c = countRows[0];

    return {
      counts: {
        pending: Number(c?.pending ?? 0),
        snoozed: Number(c?.snoozed ?? 0),
        accepted: Number(c?.accepted ?? 0),
        merged: Number(c?.merged ?? 0),
        declined: Number(c?.declined ?? 0),
        snoozeElapsed: Number(c?.snooze_elapsed ?? 0),
        tainted: Number(c?.tainted_count ?? 0),
      },
      items: rows.map((r) => {
        const snoozedUntilIso = r.snoozed_until ? new Date(r.snoozed_until).toISOString() : null;
        return {
          id: r.id,
          projectId: r.project_id,
          projectName: plainLine(r.project_name, NAME_MAX),
          sourceType: r.source_type as ProjectTriageSourceType,
          sourceId: r.source_id,
          status: r.status as ProjectTriageStatus,
          priority: r.priority as ProjectTriagePriority,
          title: plainLine(r.title, TITLE_MAX),
          tainted: r.tainted,
          sourceTrust: r.tainted ? ('external' as const) : ('internal' as const),
          snoozedUntil: snoozedUntilIso,
          snoozeElapsed:
            r.status === 'snoozed' && snoozedUntilIso !== null && new Date(snoozedUntilIso).getTime() <= nowMs,
          acceptedTaskId: r.accepted_task_id,
          mergedIntoTaskId: r.merged_into_task_id,
          createdAt: new Date(r.created_at).toISOString(),
        };
      }),
    };
  },
});

export const roadmapMcpQueries = [mcpRoadmapIdeas, mcpRoadmapDemandSummary, mcpTriageSummary];

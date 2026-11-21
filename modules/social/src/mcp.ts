// SPDX-License-Identifier: AGPL-3.0-only
// The Social reads an MCP grant may run (ADR-0051 decision 2, issue #3227, plan section 3.8): `ludy_social_posts_list` (social.mcp.posts) and
// `ludy_social_review_queue` (social.mcp.review_queue). Both are R0 reads for the grant's consenting owner or admin; the grant's scope is `ludy.read`.
//
// The projection below is these tools' privacy review, by the finance tools' rule: an AI app the owner connected sees what the consenting owner or admin sees in Social,
// the fields below and no others. Per post: its id, title, text (one plain line of at most MCP_TEXT_MAX characters, with `textTruncated`), link, status, who wrote it
// (`origin`: a person or an AI; `actorOrigin`: the app, the API, MCP or an agent; `tainted`), its planned time and zone, revision and the day it was made and last changed.
// Per channel of it: the variant's id, the channel connection's id, the provider, the channel's name, the variant's status, the text, title and link it goes out with, the time it goes out, when it was published and its public link, whether it was taken down, and the error code of a failure. A channel in review also
// carries the time it went to review. Never returned: internal comments and mentions, assignees, labels, the author's id, approvals' comments and decider ids, the review
// checklist, media files and their storage keys, channel tokens, settings (but the channel's signature, which is part of the text it goes out with) and the platform's own ids, evergreen and recurrence rules, text variations, metrics, content hashes,
// archived posts, and anything of a query that is `sensitive`. Every text value is one plain line (see plainLine): a post's text can come from a visitor's form, a forwarded
// mail, a web page or a model, and it reaches the client as data, never as an instruction. The channel limits of #1081 apply to members only and a grant's person is an owner
// or admin, so the scope below is always every channel; it is still asked, so the answer can never be wider than the screen's. Row-level security and the `org_id` filters keep
// other orgs' rows out.
import { sql } from 'kysely';
import { z } from 'zod';
import { plainLine, zId } from '@ludy/kernel-contract';
import type { MemberRole } from '@ludy/db';
import { DomainError, defineQuery, type QueryContext } from '@ludy/kernel-runtime';
import { channelScope, connectionInScope, postInScope, type ChannelScope } from './channel-access.ts';
import { withSignature } from './domain/signature.ts';
import { postFilterQuery } from './post-filter.ts';
import { currentAndPrevious, latestMetrics, spanTotals, type WindowTotals } from './metrics.ts';

const GRANTORS: readonly MemberRole[] = ['owner', 'admin'];
export const MCP_POSTS_DEFAULT = 25;
export const MCP_POSTS_MAX = 50;
// The most characters of a post's or a channel's text a client gets; `textTruncated` says when more was left out.
export const MCP_TEXT_MAX = 2000;

const POST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'partially_published', 'failed', 'cancelled'] as const;
const zLimit = z.number().int().min(1).max(MCP_POSTS_MAX).default(MCP_POSTS_DEFAULT).describe(`How many posts to return (1 to ${MCP_POSTS_MAX}, default ${MCP_POSTS_DEFAULT}).`);

export const zMcpPostsInput = z.strictObject({
  status: z.enum(POST_STATUSES).optional().describe('Only posts in this state: draft (not all channels approved yet), scheduled, publishing, published, partially_published, failed or cancelled. Leave out for all.'),
  connectionId: zId.optional().describe('Only posts with a channel on this channel connection (an id from the posts you listed).'),
  from: z.iso.datetime({ offset: true }).optional().describe('Only posts with a channel going out at or after this time (ISO 8601 with an offset).'),
  to: z.iso.datetime({ offset: true }).optional().describe('Only posts with a channel going out before this time (ISO 8601 with an offset).'),
  limit: zLimit,
});

export const zMcpReviewQueueInput = z.strictObject({ limit: zLimit });

export interface McpChannelRow {
  variantId: string;
  connectionId: string;
  provider: string;
  channelName: string;
  status: string;
  // What the channel goes out with: its own text, title and link, else the post's (a title or link may be none).
  text: string;
  textTruncated: boolean;
  title: string | null;
  linkUrl: string | null;
  // The time the `from` and `to` filter reads: its queue slot, else its own time, else the post's planned time, or when it went out once published.
  at: string | null;
  // When it went to review (a channel in review only).
  submittedAt: string | null;
  publishedAt: string | null;
  publishedUrl: string | null;
  takenDown: boolean;
  errorCode: string | null;
}
export interface McpPostRow {
  id: string;
  title: string | null;
  text: string;
  textTruncated: boolean;
  linkUrl: string | null;
  status: string;
  origin: 'human' | 'ai';
  actorOrigin: 'ui' | 'api' | 'mcp' | 'agent' | 'system';
  tainted: boolean;
  timeZone: string;
  plannedAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
  channels: McpChannelRow[];
}
export interface McpPosts {
  posts: McpPostRow[];
  total: number;
  truncated: boolean;
}
export interface McpReviewQueue {
  // Posts with a channel waiting for a person's decision, the longest waiting first (what the Review tab lists).
  inReview: McpPostRow[];
  inReviewTotal: number;
  inReviewTruncated: boolean;
  // Drafts an AI wrote with a channel not yet sent to review and none waiting in review, newest first.
  aiDrafts: McpPostRow[];
  aiDraftsTotal: number;
  aiDraftsTruncated: boolean;
}

// An optional text field as one plain line cut at `max`, or null when nothing is left of it.
const optionalLine = (value: string | null, max: number): string | null => {
  if (value === null) return null;
  const line = plainLine(value, max);
  return line === '' ? null : line;
};
// A text of a post or channel as one plain line, and whether more than MCP_TEXT_MAX characters were left out.
const textOf = (value: string): { text: string; truncated: boolean } => {
  const whole = plainLine(value, Number.MAX_SAFE_INTEGER);
  const text = [...whole].slice(0, MCP_TEXT_MAX).join('').trim();
  return { text, truncated: [...whole].length > [...text].length };
};

function requireGrant(ctx: Pick<QueryContext, 'actor'>): void {
  if (ctx.actor.type !== 'user' || !ctx.actor.mcp) throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP mới dùng được truy vấn này');
}

// The posts with the given ids as an MCP client sees them, in the order of `ids`: the post columns the projection names and its channels (cancelled ones are history a client
// has no use for, so they are left out), each channel with the display name of its connection.
async function viewPosts(ctx: Pick<QueryContext, 'trx' | 'orgId'>, scope: ChannelScope, ids: readonly string[]): Promise<McpPostRow[]> {
  if (ids.length === 0) return [];
  const posts = await ctx.trx
    .selectFrom('crove_social.post as p')
    .select(['p.id', 'p.title', 'p.body', 'p.link_url', 'p.status', 'p.origin', 'p.actor_origin', 'p.tainted', 'p.time_zone', 'p.scheduled_at', 'p.revision', 'p.created_at', 'p.updated_at'])
    .where('p.org_id', '=', ctx.orgId)
    .where('p.id', 'in', ids as string[])
    .where('p.archived_at', 'is', null)
    .where(postInScope(scope))
    .execute();
  const variants = await ctx.trx
    .selectFrom('crove_social.post_variant as v')
    .innerJoin('crove_kernel.channel_connection as c', (j) => j.onRef('c.org_id', '=', 'v.org_id').onRef('c.id', '=', 'v.channel_connection_id'))
    .select([
      'v.id',
      'v.post_id',
      'v.channel_connection_id',
      'v.provider',
      'v.position',
      'v.status',
      'v.content_frozen',
      'v.body',
      'v.title',
      'v.link_url',
      'v.scheduled_at',
      'v.queue_slot_at',
      'v.review_since',
      'v.published_at',
      'v.external_url',
      'v.removed_at',
      'v.error_code',
      'c.display_name',
      // Only the signature of the variant's settings (a text, false or absent), never the settings themselves.
      sql<unknown>`v.settings -> 'signature'`.as('signature'),
    ])
    .where('v.org_id', '=', ctx.orgId)
    .where('v.post_id', 'in', ids as string[])
    .where('v.status', '<>', 'cancelled')
    .where(connectionInScope(scope, 'v.channel_connection_id'))
    .orderBy('v.position')
    .orderBy('v.id')
    .execute();
  const byPost = new Map<string, typeof variants>();
  for (const v of variants) byPost.set(v.post_id, [...(byPost.get(v.post_id) ?? []), v]);
  const rows = new Map(posts.map((p) => [p.id, p]));
  const out: McpPostRow[] = [];
  for (const id of ids) {
    const p = rows.get(id);
    if (!p) continue;
    const text = textOf(p.body ?? '');
    const channels = (byPost.get(id) ?? []).map((v): McpChannelRow => {
      // What the channel goes out with, as the screens show it: its own text, title and link, else the post's. A frozen channel (it went out before the post was edited) kept its
      // own copy, where an empty title or link means none, not the post's.
      const inherits = !v.content_frozen;
      // The channel's signature ends its text as it ends what goes out (effectiveContent), before the text is made one plain line and cut.
      const own = textOf(withSignature(v.body ?? (inherits ? (p.body ?? '') : ''), { signature: v.signature }));
      // The time the `from` and `to` filter reads (post-filter.ts), so a window that finds a post shows the time it matched: when it was published once it has been, else its queue slot, else its own
      // time, else the post's. A retry time after a rate limit is not part of it, as in the Social lists' own filter.
      const at = v.status === 'published' || v.status === 'removed' ? v.published_at : (v.queue_slot_at ?? v.scheduled_at ?? p.scheduled_at);
      const since = v.status === 'in_review' ? v.review_since : null;
      return {
        variantId: v.id,
        connectionId: v.channel_connection_id,
        provider: plainLine(v.provider, 40),
        channelName: plainLine(v.display_name, 200),
        status: v.status,
        text: own.text,
        textTruncated: own.truncated,
        title: optionalLine(v.title ?? (inherits ? p.title : null), 500),
        linkUrl: optionalLine(v.link_url ?? (inherits ? p.link_url : null), 2048),
        at: at ? at.toISOString() : null,
        submittedAt: since ? since.toISOString() : null,
        publishedAt: v.published_at ? v.published_at.toISOString() : null,
        publishedUrl: optionalLine(v.external_url, 2048),
        takenDown: v.removed_at !== null,
        errorCode: optionalLine(v.error_code, 100),
      };
    });
    out.push({
      id: p.id,
      title: optionalLine(p.title, 500),
      text: text.text,
      textTruncated: text.truncated,
      linkUrl: optionalLine(p.link_url, 2048),
      status: p.status,
      origin: p.origin,
      actorOrigin: p.actor_origin,
      tainted: p.tainted,
      timeZone: plainLine(p.time_zone, 64),
      plannedAt: p.scheduled_at ? p.scheduled_at.toISOString() : null,
      revision: p.revision,
      createdAt: p.created_at.toISOString(),
      updatedAt: p.updated_at.toISOString(),
      channels,
    });
  }
  return out;
}

// `ludy_social_posts_list`: the org's posts, newest change first, at most MCP_POSTS_MAX, filtered as the Social lists are (the same filter query the screens use, so the answer
// is what the owner sees there).
export const mcpPosts = defineQuery({
  name: 'social.mcp.posts',
  input: zMcpPostsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpPosts> => {
    requireGrant(ctx);
    const scope = await channelScope(ctx);
    const filter = { status: input.status, connectionId: input.connectionId, from: input.from, to: input.to };
    const ids = await postFilterQuery(ctx, scope, filter)
      .orderBy('p.updated_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(input.limit)
      .execute();
    const counted = await postFilterQuery(ctx, scope, filter)
      .clearSelect()
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirst();
    const total = Number(counted?.n ?? 0);
    const posts = await viewPosts(
      ctx,
      scope,
      ids.map((r) => r.id),
    );
    return { posts, total, truncated: total > posts.length };
  },
});

// `ludy_social_review_queue`: what waits for a person. `inReview`: the posts with a channel in review, the one waiting longest first. `aiDrafts`: the drafts an AI wrote with a
// channel nobody has sent to review yet and none waiting in review (a draft an MCP client creates lands here until a person submits it, then moves to `inReview`).
export const mcpReviewQueue = defineQuery({
  name: 'social.mcp.review_queue',
  input: zMcpReviewQueueInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpReviewQueue> => {
    requireGrant(ctx);
    const scope = await channelScope(ctx);
    // The posts with a channel in review, ordered by how long their longest-waiting channel has waited. The filter query is the Review tab's.
    const waiting = await postFilterQuery(ctx, scope, { stage: 'review' })
      .select((eb) =>
        eb
          .selectFrom('crove_social.post_variant as v')
          .select((e) => e.fn.min('v.review_since').as('since'))
          .whereRef('v.org_id', '=', 'p.org_id')
          .whereRef('v.post_id', '=', 'p.id')
          .where('v.status', '=', 'in_review')
          .where(connectionInScope(scope, 'v.channel_connection_id'))
          .as('since'),
      )
      .execute();
    const sorted = [...waiting].sort((a, b) => (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0) || (a.id < b.id ? -1 : 1));
    const inReviewIds = sorted.slice(0, input.limit).map((r) => r.id);
    // A draft with a channel nobody has sent to review yet (status draft) and none waiting in review: an approved, rejected or changes-requested channel alone does not count.
    const aiFilter = () =>
      postFilterQuery(ctx, scope, { stage: 'drafts' })
        .where('p.origin', '=', 'ai')
        .where(
          sql<boolean>`EXISTS (SELECT 1 FROM crove_social.post_variant v WHERE v.org_id = p.org_id AND v.post_id = p.id AND v.status = 'draft' AND ${connectionInScope(scope, 'v.channel_connection_id')})`,
        );
    const aiIds = await aiFilter()
      .orderBy('p.updated_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(input.limit)
      .execute();
    const aiCounted = await aiFilter()
      .clearSelect()
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirst();
    const aiTotal = Number(aiCounted?.n ?? 0);
    const inReview = await viewPosts(ctx, scope, inReviewIds);
    const aiDrafts = await viewPosts(
      ctx,
      scope,
      aiIds.map((r) => r.id),
    );
    return {
      inReview,
      inReviewTotal: sorted.length,
      inReviewTruncated: sorted.length > inReview.length,
      aiDrafts,
      aiDraftsTotal: aiTotal,
      aiDraftsTruncated: aiTotal > aiDrafts.length,
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The results of Social (epic #3857, E1, issue #3860): `ludy_social_metrics_summary` (social.mcp.metrics_summary) and `ludy_social_metrics_totals` (social.mcp.metrics_totals).
// Privacy review: both are R0 reads of the numbers the Metrics tab shows an owner or admin, for a company grant's consenting owner or admin only (a member-bound grant is not offered them: the channel
// limits of a member (#1081) are read from the person, and a sealed member context has none, so nothing here could narrow the answer to a member's channels).
// What leaves, per published channel copy: its id, its post's id, the provider, the channel connection's id, an excerpt of the text it went out with (one plain line of at most MCP_EXCERPT_MAX
// characters; text a person, an AI or a visitor wrote, so data and never an instruction), when it went out, its public link, the latest real counts the platform answered (normalized counts, a count
// the platform does not report is absent), when they were captured and the clicks on its short link. The totals carry only counts per window and per channel (the channel connection's id and provider).
// Never returned: the full text, comments, labels, assignees, the author, channel names, tokens or settings, media, a post that is not published, a post archived after it went out (the summary leaves it out; the totals count it, as the Metrics tab does, because they are counts of what went out), a cancelled copy, or any money (the counts are
// not money). Row-level security and the `org_id` filters keep other orgs out; the channel scope is asked as for the screens (an owner or admin's is every channel).
// ---------------------------------------------------------------------------------------------------------------------------------------------
export const MCP_METRICS_DEFAULT = 25;
export const MCP_METRICS_MAX = 50;
export const MCP_EXCERPT_MAX = 160;
const zMetricsLimit = z.number().int().min(1).max(MCP_METRICS_MAX).default(MCP_METRICS_DEFAULT).describe(`How many published posts to return (1 to ${MCP_METRICS_MAX}, default ${MCP_METRICS_DEFAULT}).`);
const zDays = z.number().int().min(1).max(365).default(30).describe('How many days back (1 to 365, default 30).');

export const zMcpMetricsSummaryInput = z.strictObject({
  days: zDays,
  postId: zId.optional().describe('Only this post (an id from ludy_social_posts_list); its published channels are listed whenever they went out, whatever days says.'),
  limit: zMetricsLimit,
});
export const zMcpMetricsTotalsInput = z.strictObject({
  days: zDays,
  includeExternal: z.boolean().default(false).describe('Also count the posts the channels published outside Ludy (their latest counts, no clicks). Default false: Ludy\'s own posts only.'),
});

export interface McpMetricsRow {
  variantId: string;
  postId: string;
  provider: string;
  connectionId: string;
  excerpt: string;
  publishedAt: string | null;
  externalUrl: string | null;
  metrics: Record<string, number>;
  capturedAt: string | null;
  clicks: number | null;
}
export interface McpMetricsSummary {
  rows: McpMetricsRow[];
  truncated: boolean;
}
export interface McpTotalsWindow {
  posts: number;
  metrics: Record<string, number>;
  clicks: number | null;
  rateBases: WindowTotals['rateBases'];
  channelsTruncated: boolean;
  channels: Array<{ connectionId: string; provider: string; posts: number; metrics: Record<string, number>; clicks: number | null; rateBases: WindowTotals['rateBases'] }>;
}
export interface McpMetricsTotals extends McpTotalsWindow {
  days: number;
  previous: McpTotalsWindow;
}

// The most channels a window lists: the totals stay the whole organization's, the per-channel list is cut (the most posts first) and `channelsTruncated` says so, so one answer never charges more rows than the
// budget's single call allows.
export const MCP_TOTALS_CHANNELS_MAX = 50;
const windowOf = (w: WindowTotals): McpTotalsWindow => ({
  posts: w.posts,
  metrics: w.metrics,
  clicks: w.clicks,
  rateBases: w.rateBases,
  channelsTruncated: w.channels.length > MCP_TOTALS_CHANNELS_MAX,
  channels: w.channels.slice(0, MCP_TOTALS_CHANNELS_MAX).map((c) => ({ connectionId: c.connectionId, provider: plainLine(c.provider, 40), posts: c.posts, metrics: c.metrics, clicks: c.clicks, rateBases: c.rateBases })),
});

// The results are a company grant's alone: the tool list does not offer them to a member-bound grant, and the query refuses one too.
function requireCompanyGrant(ctx: Pick<QueryContext, 'actor'>): void {
  if (ctx.actor.type !== 'user' || !ctx.actor.mcp || ctx.actor.mcp.kind === 'member') throw new DomainError('FORBIDDEN', 403, 'Chỉ khách MCP của công ty mới dùng được truy vấn này');
}

// `ludy_social_metrics_summary`: the latest counts of the posts published in the last `days` days (or of one post), newest first, at most `limit`.
export const mcpMetricsSummary = defineQuery({
  name: 'social.mcp.metrics_summary',
  input: zMcpMetricsSummaryInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpMetricsSummary> => {
    requireCompanyGrant(ctx);
    const scope = await channelScope(ctx);
    // One more than asked, so `truncated` is known without a count.
    const found = await latestMetrics(ctx.trx, ctx.orgId, { days: input.days, liveOnly: true, ...(input.postId ? { postId: input.postId } : {}) }, input.limit + 1, scope);
    const rows = found.slice(0, input.limit).map(
      (r): McpMetricsRow => ({
        variantId: r.variantId,
        postId: r.postId,
        provider: plainLine(r.provider, 40),
        connectionId: r.connectionId,
        excerpt: plainLine(r.text, MCP_EXCERPT_MAX),
        publishedAt: r.publishedAt,
        externalUrl: optionalLine(r.externalUrl, 2048),
        metrics: r.metrics,
        capturedAt: r.capturedAt,
        clicks: r.clicks,
      }),
    );
    return { rows, truncated: found.length > rows.length };
  },
});

// `ludy_social_metrics_totals`: the totals of the window of `days` days and of the window of the same length just before it, with each channel's share of both.
export const mcpMetricsTotals = defineQuery({
  name: 'social.mcp.metrics_totals',
  input: zMcpMetricsTotalsInput,
  access: GRANTORS,
  mcp: { scope: 'ludy.read' },
  handler: async (ctx, input): Promise<McpMetricsTotals> => {
    requireCompanyGrant(ctx);
    const filter = { external: input.includeExternal, scope: await channelScope(ctx) };
    const both = currentAndPrevious(await spanTotals(ctx.trx, ctx.orgId, { days: input.days, before: 0 }, filter), await spanTotals(ctx.trx, ctx.orgId, { days: input.days, before: input.days }, filter));
    const { previous, ...current } = both;
    return { days: input.days, ...windowOf(current), previous: windowOf(previous) };
  },
});

export const mcpSocialQueries = [mcpPosts, mcpReviewQueue, mcpMetricsSummary, mcpMetricsTotals];

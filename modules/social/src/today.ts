// SPDX-License-Identifier: AGPL-3.0-only
// What needs the member in Social today, for Home's "Hôm nay cần bạn" (#2387, shape agreed on #2383). One read, social.today: no write, no model
// call, and only what the caller could open on the Social screens, since it asks the same helpers the screens do: the channel scope of a member
// limited to some channels (#1081), the filter of the Attention list (post-filter.ts, so that count equals the list it opens) and the review
// inbox's own rule for who may decide a post now (review-inbox.ts: the posts waiting for this person, which leaves out the ones they already
// approved in the round and their own on a four-eyes channel, so it can be fewer than the posts in review the Review tab lists).
//
// Who sees what. Owners and admins decide and fix, so they get everything: the posts waiting for their approval (a proposal), the channels whose
// sign-in expired or broke (a warning, as the multi-client home counts them, #1261), the posts that failed or are paused on a channel (a block)
// and the posts scheduled in the next 24 hours, or up to 7 days ago, that still wait for approval (a deadline per post; an overdue one says so). A member gets the last two on the channels
// they may use (a failed post and a post still in review are theirs to chase), never a decision and never a channel to reconnect (they cannot).
// A viewer can act on nothing and gets nothing.
//
// Titles are message keys with params (catalogs in apps/app: today.items.social.*), never rendered text; no post text leaves the read but the
// short title a post may carry, which the org's own members typed. A href is a path inside the org (Home puts the org in front).
import { sql } from 'kysely';
import { z } from 'zod';
import type { MemberRole } from '@crove/db';
import type { TodayItem } from '@crove/kernel-contract';
import { defineQuery } from '@crove/kernel-runtime';
import { ATTENTION_CHANNEL_STATUSES } from './attention-inbox.ts';
import { channelScope, connectionInScope } from './channel-access.ts';
import { SOCIAL_FIGURE_MAX } from './client-overview.ts';
import { postFilterQuery } from './post-filter.ts';
import { reviewWaiting } from './review-inbox.ts';

const ALL: readonly MemberRole[] = ['owner', 'admin', 'member', 'viewer'];

const DAY = 24 * 60 * 60 * 1000;
// How long a post whose time has passed while it still waits for approval stays on Home: the owner decided 7 days (#2387).
export const TODAY_SOCIAL_OVERDUE_DAYS = 7;
// The most posts listed one by one for the next 24 hours, the soonest first; the rest are one item with their count.
export const TODAY_SOCIAL_DUE = 20;
const TITLE_MAX = 80;

// A post's title as one short line: whitespace flattened, and no control or invisible character (a right-to-left override in a title could
// reorder the sentence it sits in).
const shortTitle = (title: string | null): string | null => {
  const flat = (title ?? '').replace(/\s+/g, ' ').replace(/\p{C}/gu, '').trim();
  if (flat === '') return null;
  const chars = [...flat];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join('')}…` : flat;
};

export const socialToday = defineQuery({
  name: 'social.today',
  // `now` is for the tests that fix the clock: Home never passes it.
  input: z.object({ now: z.iso.datetime().optional() }),
  access: ALL,
  handler: async (ctx, input): Promise<TodayItem[]> => {
    if (ctx.actor.type !== 'user' || ctx.role === null || ctx.role === 'viewer') return [];
    const manager = ctx.role === 'owner' || ctx.role === 'admin';
    const from = input.now ? new Date(input.now) : new Date();
    const to = new Date(from.getTime() + DAY);
    const since = new Date(from.getTime() - TODAY_SOCIAL_OVERDUE_DAYS * DAY);
    const scope = await channelScope(ctx);
    const items: TodayItem[] = [];

    // The posts waiting for this person's approval: the review inbox's own answer (nothing for a member).
    const review = await reviewWaiting(ctx);
    if (review.total > 0) {
      const only = review.total === 1 ? review.items[0] : undefined;
      items.push({
        kind: 'proposal',
        app: 'social',
        id: 'review',
        title: { key: 'social.review', params: { count: review.total } },
        count: review.total,
        href: only ? `/social/${only.postId}` : '/social?tab=review',
      });
    }

    // Channels whose sign-in expired or broke: an owner or admin reconnects them, so only they are told.
    if (manager) {
      const channels = await ctx.trx
        .selectFrom('crove_kernel.channel_connection')
        .select(sql<string>`count(*)`.as('n'))
        .where('org_id', '=', ctx.orgId)
        .where('status', 'in', [...ATTENTION_CHANNEL_STATUSES])
        // Social and messaging channels only: an ad account's or a bank feed's connection is another module's.
        .where('provider', 'not like', 'bank\\_%')
        .where('provider', 'not like', '%\\_ads')
        .where('provider', 'not like', 'einvoice\\_%')
        .executeTakeFirstOrThrow();
      const n = Number(channels.n);
      if (n > 0) items.push({ kind: 'flag', app: 'social', id: 'channels', title: { key: 'social.channels', params: { count: n } }, count: n, severity: 'warn', href: '/social/channels' });
    }

    // Posts that failed or are paused on a channel the caller may use: the Attention list, with the same filter.
    const attention = await ctx.trx
      .selectFrom(postFilterQuery(ctx, scope, { stage: 'attention' }).limit(SOCIAL_FIGURE_MAX).as('x'))
      .select(sql<string>`count(*)`.as('n'))
      .executeTakeFirstOrThrow();
    const failed = Number(attention.n);
    if (failed > 0) items.push({ kind: 'flag', app: 'social', id: 'attention', title: { key: 'social.attention', params: { count: failed } }, count: failed, severity: 'block', href: '/social?tab=attention' });

    // Posts meant to go out in the next 24 hours, or up to 7 days ago, that are still waiting for approval, one item per post: the earliest time of the post's variants in
    // review within the window, by the calendar's own time of a variant (queue slot, else its own time, else the post's). At most SOCIAL_FIGURE_MAX
    // posts are looked at, so "N more" is exact below that.
    const at = sql<Date>`coalesce(v.queue_slot_at, v.scheduled_at, p.scheduled_at)`;
    const rows = await ctx.trx
      .selectFrom('crove_social.post_variant as v')
      .innerJoin('crove_social.post as p', (j) => j.onRef('p.org_id', '=', 'v.org_id').onRef('p.id', '=', 'v.post_id'))
      .select(['p.id as post_id', 'p.title', sql<Date>`min(${at})`.as('at')])
      .where('v.org_id', '=', ctx.orgId)
      .where('v.status', '=', 'in_review')
      .where('p.archived_at', 'is', null)
      .where(connectionInScope(scope, 'v.channel_connection_id'))
      .where(sql<boolean>`${at} >= ${since.toISOString()}::timestamptz AND ${at} < ${to.toISOString()}::timestamptz`)
      .groupBy(['p.id', 'p.title'])
      .orderBy(sql`min(${at})`)
      .orderBy('p.id')
      .limit(SOCIAL_FIGURE_MAX)
      .execute();
    const posts = rows.map((r) => ({ postId: r.post_id, title: r.title, at: r.at }));
    for (const p of posts.slice(0, TODAY_SOCIAL_DUE)) {
      const title = shortTitle(p.title);
      items.push({
        kind: 'deadline',
        app: 'social',
        id: `due:${p.postId}`,
        // A time that has passed is said as such: "in the next 24 hours" would not be true of it.
        title: p.at < from ? (title === null ? { key: 'social.dueOverdue' } : { key: 'social.dueOverdueTitled', params: { title } }) : title === null ? { key: 'social.due' } : { key: 'social.dueTitled', params: { title } },
        dueAt: p.at.toISOString(),
        href: `/social/${p.postId}`,
      });
    }
    const rest = posts.slice(TODAY_SOCIAL_DUE);
    const next = rest[0];
    if (next) items.push({ kind: 'deadline', app: 'social', id: 'due:more', title: { key: 'social.dueMore', params: { count: rest.length } }, count: rest.length, dueAt: next.at.toISOString(), href: '/social?tab=review' });
    return items;
  },
});

export const socialTodayQueries = [socialToday];

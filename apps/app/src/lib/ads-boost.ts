// SPDX-License-Identifier: AGPL-3.0-only
// Boost a published Social post (ads W3, issue #3834): the small rules the post screen and the panel share. Which posts can be boosted, what the post gives the ad (its
// words, its link, the Facebook Page it went out on), the defaults of the panel, the words for where a boost stands, and the posts the AI coworker suggests. The
// server decides every rule (the switches, the caps, the plan); these only choose what to offer and what to send. Ads reads no Social table: the post is read here,
// through Social's own query, and its words are copied into the request. Money is a decimal string, never a number.
import { ADS_BOOST_AUDIENCES, ADS_BOOST_GOALS, ADS_PLAN_LIMITS, type AdsBoostAudience, type AdsBoostGoal, type AdsBoostState, type AdsObjective } from '@ludy/kernel-contract';
import type { Translate } from '../i18n/runtime.ts';
import { cutAt } from './ads-campaigns.ts';

// What of a Social post the boost reads: its words, its link, and the channels it went out on.
export interface BoostPost {
  id: string;
  title: string | null;
  body: string;
  linkUrl: string | null;
  archivedAt: string | null;
  variants: ReadonlyArray<{ provider: string; connectionId: string; status: string; externalUrl: string | null; removedAt: string | null; publishedAt: string | null }>;
}

// The channels an ad can be made from a post of: Meta's own, a Facebook Page or an Instagram account (owner Q4 and the plan: Meta first), and the offline sandbox
// channel, which exists only where the test channel is switched on and lets a boost be tried end to end on the sandbox ad platform.
export const BOOST_PROVIDERS = ['facebook_page', 'instagram', 'sandbox'] as const;

// The published channels of the post that Meta can boost: out, not taken down.
export const boostableVariants = (post: BoostPost): BoostPost['variants'][number][] =>
  post.variants.filter((v) => v.status === 'published' && v.removedAt === null && (BOOST_PROVIDERS as readonly string[]).includes(v.provider));

const https = (url: string | null): string | null => {
  if (url === null) return null;
  const text = url.trim();
  if (text.length === 0 || text.length > 2000) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
};

// The link the ad opens: the post's own link when it has one, else its page on the platform (the permalink of a published channel).
export function boostLink(post: BoostPost): string | null {
  return https(post.linkUrl) ?? boostableVariants(post).map((v) => https(v.externalUrl)).find((u) => u !== null) ?? null;
}

// The words of the ad, from the post: a headline from its title or first line and a first text from its body, within the platforms' soft limits. Empty
// when the post has no words (an image alone): the person writes them, since an ad needs both.
export function boostCopy(post: BoostPost): { headline: string; primaryText: string } {
  const title = (post.title ?? '').trim();
  const body = post.body.trim();
  const firstLine = body.split('\n').find((line) => line.trim() !== '') ?? '';
  const headline = cutAt(title || firstLine, ADS_PLAN_LIMITS.headlineSoft);
  const primaryText = cutAt(body || title, ADS_PLAN_LIMITS.primaryTextSoft);
  return { headline, primaryText };
}

// Why a post cannot be boosted, or null when it can: it is not out on a channel Meta can boost, or it is archived.
export function boostBlock(post: BoostPost): 'archived' | 'not_published' | null {
  if (post.archivedAt !== null) return 'archived';
  return boostableVariants(post).length === 0 ? 'not_published' : null;
}

// The Facebook Page the ad runs as: the Page the post went out on when it is one of the org's active Pages, else null and the person picks one.
export function boostPage(post: BoostPost, pages: ReadonlyArray<{ id: string }>): string | null {
  return boostableVariants(post).find((v) => v.provider === 'facebook_page' && pages.some((p) => p.id === v.connectionId))?.connectionId ?? null;
}

// The goals the post can serve: Traffic and Engagement send people to a page, so they need the link; Messages opens a conversation with the Page.
export const boostGoals = (post: BoostPost): readonly AdsBoostGoal[] => (boostLink(post) === null ? ['messages'] : ADS_BOOST_GOALS);

export interface BoostDefaults {
  goal: AdsBoostGoal;
  budget: string;
  days: number;
  audience: AdsBoostAudience;
}

// What the panel starts with: boosting a post is Engagement by habit (Traffic when the post has a link of its own), three days, everyone in Vietnam, and a small
// budget in the currency's own unit (the caps are the owner's to judge, shown after the draft is saved).
export function boostDefaults(post: BoostPost, currency: string): BoostDefaults {
  const goals = boostGoals(post);
  const goal: AdsBoostGoal = https(post.linkUrl) !== null && goals.includes('traffic') ? 'traffic' : goals.includes('engagement') ? 'engagement' : 'messages';
  // The dong and the won have no cents: a round amount of thousands. Others start at a round ten.
  const budget = ['VND', 'KRW', 'JPY'].includes(currency) ? '100000' : '10';
  return { goal, budget, days: 3, audience: 'vn_all' };
}

export const BOOST_DAYS = [1, 2, 3, 5, 7, 14, 30] as const;

const GOAL_OF_OBJECTIVE: Readonly<Record<AdsObjective, AdsBoostGoal>> = { traffic: 'traffic', engagement: 'engagement', messenger: 'messages' };

// What the panel starts with when it continues a draft of this post: its account, its goal, the most it can spend (the daily budget was rounded down from the
// person's budget, so this is never above it) and its days when the panel offers them. The audience is not kept in a form the panel can read back, so it starts as the default.
export function continueDraft(state: { adAccountId: string; objective: AdsObjective; maxSpend: string | null; days: number | null }): { accountId: string; prefill: Partial<BoostDefaults> } {
  const prefill: Partial<BoostDefaults> = { goal: GOAL_OF_OBJECTIVE[state.objective] };
  if (state.maxSpend !== null) prefill.budget = state.maxSpend;
  if (state.days !== null && (BOOST_DAYS as readonly number[]).includes(state.days)) prefill.days = state.days;
  return { accountId: state.adAccountId, prefill };
}
export const BOOST_AUDIENCES = ADS_BOOST_AUDIENCES;

// ---- What the AI coworker suggests ----

// A post counts as recent for the suggestion when it went out in the last this many days.
export const SUGGEST_DAYS = 14;
export const SUGGEST_MAX = 3;
// The counts a platform reports that mean a person did something with the post (the same four Social's own "outperforming" notice counts).
const ENGAGEMENT = ['reactions', 'comments', 'shares', 'saves'] as const;
export const engagementOf = (metrics: Readonly<Record<string, number>>): number => ENGAGEMENT.reduce((sum, name) => sum + (Number.isFinite(metrics[name]) ? (metrics[name] as number) : 0), 0);

export interface Suggested<P extends BoostPost = BoostPost> {
  post: P;
  engagement: number;
}

// The recent published posts worth boosting: the ones that did best with the people who already see them, from the counts Ludy already reads (Social's metrics),
// leaving out posts that are already boosted or cannot be. A suggestion only: the person opens the panel, changes what they like and sends it; an approver
// approves the spend. No model call: the ranking is the counts, so it costs nothing and works with the AI off.
export function suggestBoosts<P extends BoostPost>(
  posts: readonly P[],
  metrics: ReadonlyArray<{ postId: string; metrics: Readonly<Record<string, number>> }>,
  boosted: ReadonlySet<string>,
  now: number,
): Suggested<P>[] {
  const best = new Map<string, number>();
  for (const row of metrics) best.set(row.postId, Math.max(best.get(row.postId) ?? 0, engagementOf(row.metrics)));
  const since = now - SUGGEST_DAYS * 86_400_000;
  return posts
    .filter((post) => boostBlock(post) === null && !boosted.has(post.id))
    .filter((post) => boostableVariants(post).some((v) => v.publishedAt !== null && Date.parse(v.publishedAt) >= since && Date.parse(v.publishedAt) <= now))
    .map((post) => ({ post, engagement: best.get(post.id) ?? 0 }))
    .filter((s) => s.engagement > 0)
    .sort((a, b) => b.engagement - a.engagement || (a.post.id < b.post.id ? -1 : 1))
    .slice(0, SUGGEST_MAX);
}

// ---- Words ----

// Where a boost stands, in one word or two.
export function boostStateText(state: AdsBoostState, step: string | null, t: Translate): string {
  switch (state) {
    case 'draft':
      return t('ads.boost.state.draft');
    case 'waiting_approval':
      return t('ads.boost.state.waiting_approval');
    case 'queued':
      return t('ads.boost.state.queued');
    case 'launching':
      return step === 'paused' ? t('ads.boost.state.created') : t('ads.boost.state.launching');
    case 'live':
      return t('ads.boost.state.live');
    case 'needs_attention':
      return t('ads.boost.state.needs_attention');
    case 'stopped':
      return t('ads.boost.state.stopped');
    case 'failed':
      return t('ads.boost.state.failed');
    case 'cancelled':
      return t('ads.boost.state.cancelled');
    case 'ended':
      return t('ads.boost.state.ended');
  }
}

export const boostStateTone = (state: AdsBoostState): 'success' | 'warning' | 'destructive' | 'outline' =>
  state === 'live' ? 'success' : state === 'needs_attention' || state === 'waiting_approval' ? 'warning' : state === 'failed' ? 'destructive' : 'outline';

// A boost in one of these states is over: the post may be boosted again.
export const boostOver = (state: AdsBoostState): boolean => state === 'stopped' || state === 'failed' || state === 'cancelled' || state === 'ended';

export const goalText = (goal: AdsBoostGoal, t: Translate): string => {
  switch (goal) {
    case 'traffic':
      return t('ads.boost.goalOption.traffic');
    case 'engagement':
      return t('ads.boost.goalOption.engagement');
    case 'messages':
      return t('ads.boost.goalOption.messages');
  }
};

export const goalHintText = (goal: AdsBoostGoal, t: Translate): string => {
  switch (goal) {
    case 'traffic':
      return t('ads.boost.goalHint.traffic');
    case 'engagement':
      return t('ads.boost.goalHint.engagement');
    case 'messages':
      return t('ads.boost.goalHint.messages');
  }
};

export const audienceText = (audience: AdsBoostAudience, t: Translate): string => {
  switch (audience) {
    case 'vn_all':
      return t('ads.boost.audienceOption.vn_all');
    case 'vn_young':
      return t('ads.boost.audienceOption.vn_young');
    case 'vn_women':
      return t('ads.boost.audienceOption.vn_women');
    case 'hcm_hn':
      return t('ads.boost.audienceOption.hcm_hn');
  }
};

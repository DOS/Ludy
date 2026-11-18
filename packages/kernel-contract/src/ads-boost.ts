// SPDX-License-Identifier: AGPL-3.0-only
// Boost a published Social post (ads W3, issue #3834, plan docs/plan/ads-write.md sections 2 and 10, ADR-0043). A person picks a published post, a goal, a budget,
// a number of days and an audience preset; the server turns that into the same draft W1 builds (one campaign, one ad set, one ad) and the same approval, caps,
// kill switch and launch job as any other plan follow. There is no second launch path: a boost is a draft whose creative came from a post, so it ends in the
// proposal `ads.campaign.launch` and the launch ledger of W2. Money is a decimal string in the account's currency, never a number.
import { z } from 'zod';
import { ADS_LAUNCH_STATES, zAdsAdVariant, zAdsBudget, ADS_PLAN_LIMITS, zAdsCampaignDraftView } from './ads-campaign.ts';
import { zId } from './schemas.ts';

// What the person wants from the boost, in the words of a small business. Each goal is one of the objectives of the first slice (owner Q4).
export const ADS_BOOST_GOALS = ['traffic', 'engagement', 'messages'] as const;
export type AdsBoostGoal = (typeof ADS_BOOST_GOALS)[number];

// Who sees it, as a preset (no custom audience, no customer list: plan section 6). Each preset is parameters of an audience, not people.
export const ADS_BOOST_AUDIENCES = ['vn_all', 'vn_young', 'vn_women', 'hcm_hn'] as const;
export type AdsBoostAudience = (typeof ADS_BOOST_AUDIENCES)[number];

// A boost runs a few days: the longest the panel offers (the plan's own longest flight is ADS_PLAN_LIMITS.daysMax).
export const ADS_BOOST_DAYS_MAX = 30;

// The creative copied from the post by the app (Ads reads no Social table, plan section 7): a headline and a text within the plan's limits, and the link the
// ad opens (the post's own link, else its page on the platform).
export const zAdsBoostCreative = zAdsAdVariant.pick({ headline: true, primaryText: true });

export const zAdsBoostDraft = z.strictObject({
  adAccountId: zId,
  // The published Social post the ad is made from. Its id is kept as an opaque reference, never its text.
  postId: zId,
  goal: z.enum(ADS_BOOST_GOALS),
  // The most the person wants to spend in all, in the account's currency. The server spreads it over the days and rounds the daily budget down, so the largest
  // amount the plan can spend is never more than this.
  budget: zAdsBudget,
  days: z.number().int().min(1).max(ADS_BOOST_DAYS_MAX),
  audience: z.enum(ADS_BOOST_AUDIENCES),
  creative: zAdsBoostCreative,
  // Traffic and Engagement send people to this page; Messages opens a conversation with the Facebook Page instead.
  linkUrl: z.url({ protocol: /^https$/ }).max(2000).nullable(),
  // The Facebook Page the ad runs as: every ad needs one (the launch stops without it), whatever the goal. Usually the Page the post went out on.
  pageConnectionId: zId,
});
export type AdsBoostDraft = z.infer<typeof zAdsBoostDraft>;
export const zAdsBoostDraftCall = zAdsBoostDraft.extend({ idempotencyKey: zId });
export const ADS_BOOST_LIMITS = { headlineMax: ADS_PLAN_LIMITS.headlineMax, primaryTextMax: ADS_PLAN_LIMITS.primaryTextMax } as const;

// Where a boost stands, the state the post shows: a draft (not asked for yet), waiting for approval in the Inbox, or the state of its launch.
export const ADS_BOOST_STATES = ['draft', 'waiting_approval', ...ADS_LAUNCH_STATES] as const;
export type AdsBoostState = (typeof ADS_BOOST_STATES)[number];

// Whether boosting is possible at all for the caller, and with which ad accounts: the button is shown only when it is, so with ad writing off there is none.
// Members read it (they draft); the caps and the switches themselves stay the owners' and admins' to read.
export const zAdsBoostAccount = z.object({
  id: zId,
  name: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  provider: z.string(),
});
// A Facebook Page of the org that an ad can run as (an active channel connection).
export const zAdsBoostPage = z.object({ id: zId, name: z.string() });
export const zAdsBoostOptions = z.object({
  // The org's switch is on and launches are not blocked, and at least one account that has read its currency is enabled for running ads.
  enabled: z.boolean(),
  // Why not, for the screen to say: the org's switch is off, launches are blocked, or no account can run ads yet.
  reason: z.enum(['writing_off', 'launches_blocked', 'no_account']).nullable(),
  accounts: z.array(zAdsBoostAccount),
  // The Pages an ad can run as, for a post that did not go out on one (an Instagram post); empty while boosting is not possible.
  pages: z.array(zAdsBoostPage),
});
export type AdsBoostOptions = z.infer<typeof zAdsBoostOptions>;

export const zAdsBoostStatesInput = z.strictObject({ postIds: z.array(zId).min(1).max(50) });
// The newest boost of each post that has one. A post with none is left out.
export const zAdsBoostStateView = z.object({
  postId: zId,
  draftId: zId,
  adAccountId: zId,
  adAccountName: z.string(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  state: z.enum(ADS_BOOST_STATES),
  // The Inbox item of the request for approval, while it waits.
  proposalId: zId.nullable(),
  launchId: zId.nullable(),
  // Where a started launch is, a code, and why it stopped or needs attention.
  step: z.string().nullable(),
  stopReason: z.string().nullable(),
  // The largest amount it can spend, its days and its flight; null while the draft cannot tell.
  maxSpend: z.string().nullable(),
  days: z.number().int().nullable(),
  startOn: z.string().nullable(),
  endOn: z.string().nullable(),
  updatedAt: z.string(),
});
export type AdsBoostStateView = z.infer<typeof zAdsBoostStateView>;

// What drafting a boost answers: the draft as the builder shows it (its findings, its largest amount), whether it was made or an open one edited.
export const zAdsBoostDrafted = z.object({ draft: zAdsCampaignDraftView, edited: z.boolean() });
export type AdsBoostDrafted = z.infer<typeof zAdsBoostDrafted>;

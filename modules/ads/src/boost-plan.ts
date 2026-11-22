// SPDX-License-Identifier: AGPL-3.0-only
// The pure rules of boosting a published post (ads W3, issue #3834, plan docs/plan/ads-write.md section 10): how a goal, a budget, a number of days and an
// audience preset become the plan of a draft. No database and no model: the same answers always give the same plan, and the same local validation
// (campaign-plan.ts) judges it as any other draft. Money is a decimal string and every division goes through decimal.js (AGENTS.md "Money").
import { Decimal } from 'decimal.js';
import { ADS_PLAN_LIMITS, type AdsBoostAudience, type AdsBoostDraft, type AdsBoostGoal, type AdsCallToAction, type AdsCampaignPlanDraft, type AdsObjective, type AdsTargeting } from '@ludy/kernel-contract';
import { addDays, currencyDecimals } from './domain.ts';

// A goal is one of the objectives of the first slice: Traffic, Engagement, Messenger.
export const OBJECTIVE_OF_GOAL: Readonly<Record<AdsBoostGoal, AdsObjective>> = { traffic: 'traffic', engagement: 'engagement', messages: 'messenger' };
export const CALL_TO_ACTION_OF_GOAL: Readonly<Record<AdsBoostGoal, AdsCallToAction>> = { traffic: 'learn_more', engagement: 'no_button', messages: 'send_message' };

// The audience presets: parameters of an audience, never people (plan section 6). The region names are the ones the platform's targeting search resolves; a name
// that does not resolve stops the launch with nothing spent (W2-3, `targeting_unknown`), and the live check confirms them [U].
export const AUDIENCE_PRESETS: Readonly<Record<AdsBoostAudience, AdsTargeting>> = {
  vn_all: { locations: [{ country: 'VN' }], ageMin: ADS_PLAN_LIMITS.ageLowest, ageMax: ADS_PLAN_LIMITS.ageHighest, gender: 'all', interests: [] },
  vn_young: { locations: [{ country: 'VN' }], ageMin: 18, ageMax: 34, gender: 'all', interests: [] },
  vn_women: { locations: [{ country: 'VN' }], ageMin: 18, ageMax: 45, gender: 'female', interests: [] },
  hcm_hn: { locations: [{ country: 'VN', region: 'Ho Chi Minh City' }, { country: 'VN', region: 'Hanoi' }], ageMin: 18, ageMax: ADS_PLAN_LIMITS.ageHighest, gender: 'all', interests: [] },
};

// What stops a boost before it is a draft: the plan cannot be made from what was given. The command words each in Vietnamese.
export type BoostRefusal = 'budget_too_small' | 'link_needed' | 'page_needed';
// (page_needed is the command's: the Page must be an active Facebook Page of the org, which only the database can say.)

// The daily budget of a boost: the total spread over the days and rounded DOWN to the currency's own unit, so the largest amount the plan can spend (the daily
// budget times the days) is never more than the person's budget. Null when the daily budget would be zero (a budget too small for the days).
export function dailyBudgetOf(budget: string, days: number, currency: string): string | null {
  // A budget has two decimals at most as it is entered (the contract's), whatever the currency's own number of decimals.
  const daily = new Decimal(budget).div(days).toDecimalPlaces(Math.min(currencyDecimals(currency), 2), Decimal.ROUND_DOWN);
  return daily.gt(0) ? daily.toFixed() : null;
}

// The name of the campaign: a short label of the post, so the person finds it in the list and on the platform.
const NAME_PREFIX = 'Đẩy bài: ';
export const boostName = (headline: string): string => [...`${NAME_PREFIX}${headline.trim()}`].slice(0, ADS_PLAN_LIMITS.nameMax).join('');

// The plan a boost stands for. The flight starts tomorrow in the account's own time zone (the first full day: nothing starts mid-day on an approval that may
// come tomorrow), runs the days asked for and ends on the last of them. `today` is the account's own date, never the server's.
export function boostPlan(input: AdsBoostDraft, context: { today: string; currency: string }): { plan: AdsCampaignPlanDraft } | { refusal: BoostRefusal } {
  const objective = OBJECTIVE_OF_GOAL[input.goal];
  if (objective !== 'messenger' && input.linkUrl === null) return { refusal: 'link_needed' };
  const dailyBudget = dailyBudgetOf(input.budget, input.days, context.currency);
  if (dailyBudget === null) return { refusal: 'budget_too_small' };
  const startOn = addDays(context.today, 1);
  return {
    plan: {
      name: boostName(input.creative.headline),
      objective,
      dailyBudget,
      startOn,
      endOn: addDays(startOn, input.days - 1),
      targeting: structuredClone(AUDIENCE_PRESETS[input.audience]) as AdsTargeting,
      linkUrl: objective === 'messenger' ? null : input.linkUrl,
      // Every ad runs as a Page, whatever the goal (the launch job stops a plan without one).
      pageConnectionId: input.pageConnectionId,
      sourcePostId: input.postId,
      mediaFileId: null,
      variants: [{ headline: input.creative.headline.trim(), primaryText: input.creative.primaryText.trim(), callToAction: CALL_TO_ACTION_OF_GOAL[input.goal] }],
    },
  };
}

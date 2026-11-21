// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ADS_BOOST_AUDIENCES, ADS_BOOST_GOALS, zAdsBoostDraft, zAdsCampaignPlan, type AdsBoostDraft } from '@ludy/kernel-contract';
import { AUDIENCE_PRESETS, boostName, boostPlan, dailyBudgetOf } from '../src/boost-plan.ts';
import { flightDays, maxSpendOf, validatePlan } from '../src/campaign-plan.ts';

// What a boost makes of a post, a goal, a budget, some days and an audience (W3, #3834): pure rules, so the same answers always give the same plan and the same
// local validation judges it as any other draft.
const ids = { adAccountId: '11111111-1111-4111-8111-111111111111', postId: '22222222-2222-4222-8222-222222222222', pageConnectionId: '33333333-3333-4333-8333-333333333333' };
const input = (over: Partial<AdsBoostDraft> = {}): AdsBoostDraft => ({
  adAccountId: ids.adAccountId,
  postId: ids.postId,
  goal: 'traffic',
  budget: '300000',
  days: 3,
  audience: 'vn_all',
  creative: { headline: 'Giảm 20% cuối tuần', primaryText: 'Ghé quán hôm nay để nhận ưu đãi.' },
  linkUrl: 'https://example.com/khuyen-mai',
  pageConnectionId: ids.pageConnectionId,
  ...over,
});
const context = { today: '2026-12-30', currency: 'VND' };

describe('dailyBudgetOf', () => {
  it('spreads the budget over the days and rounds the daily budget DOWN to the currency’s unit', () => {
    expect(dailyBudgetOf('300000', 3, 'VND')).toBe('100000');
    expect(dailyBudgetOf('100000', 3, 'VND')).toBe('33333');
    expect(dailyBudgetOf('10', 3, 'USD')).toBe('3.33');
    expect(dailyBudgetOf('0.5', 1, 'USD')).toBe('0.5');
    // A currency of three decimals still gives the two the contract's budget takes.
    expect(dailyBudgetOf('10', 3, 'KWD')).toBe('3.33');
  });

  it('is empty when the daily budget would be zero', () => {
    expect(dailyBudgetOf('2', 3, 'VND')).toBeNull();
    expect(dailyBudgetOf('0.01', 2, 'USD')).toBeNull();
  });

  it('never lets the largest amount a plan can spend pass the person’s budget (a property over many budgets and days)', () => {
    for (let budget = 1; budget <= 400; budget += 7) {
      for (let days = 1; days <= 30; days += 1) {
        const daily = dailyBudgetOf(String(budget), days, 'VND');
        if (daily === null) continue;
        expect(Number(maxSpendOf(daily, days))).toBeLessThanOrEqual(budget);
        // And the loss is under one unit a day.
        expect(budget - Number(maxSpendOf(daily, days))).toBeLessThan(days);
      }
    }
  });
});

describe('boostPlan', () => {
  it('starts tomorrow in the account’s own day and runs the days asked for, ending on the last of them', () => {
    const made = boostPlan(input({ days: 5 }), context);
    if (!('plan' in made)) throw new Error('expected a plan');
    expect(made.plan).toMatchObject({ startOn: '2026-12-31', endOn: '2027-01-04', dailyBudget: '60000', sourcePostId: ids.postId, mediaFileId: null });
    expect(flightDays(made.plan.startOn, made.plan.endOn)).toBe(5);
  });

  it('makes a complete plan the contract accepts for every goal and every audience, judged by the same local validation as any draft', () => {
    for (const goal of ADS_BOOST_GOALS) {
      for (const audience of ADS_BOOST_AUDIENCES) {
        const made = boostPlan(input({ goal, audience, linkUrl: goal === 'messages' ? null : 'https://example.com/a' }), context);
        if (!('plan' in made)) throw new Error(`no plan for ${goal} ${audience}`);
        expect(zAdsCampaignPlan.safeParse(made.plan).success, `${goal} ${audience}`).toBe(true);
        const checked = validatePlan(made.plan, {
          today: context.today,
          currency: 'VND',
          caps: [{ scope: 'org', adAccountId: null, period: 'daily', amount: '200000', currency: 'VND' }],
          adAccountId: ids.adAccountId,
          writeEnabled: true,
          accountWriteEnabled: true,
          launchesBlocked: false,
          pageOk: true,
        });
        expect(checked.issues.filter((i) => i.severity === 'error'), `${goal} ${audience}`).toEqual([]);
        expect(checked.maxSpend).toBe('300000');
      }
    }
  });

  it('maps each goal to its objective and button, a Messenger ad has no link, and every ad runs as the Page', () => {
    const traffic = boostPlan(input({ goal: 'traffic' }), context);
    const engagement = boostPlan(input({ goal: 'engagement' }), context);
    const messages = boostPlan(input({ goal: 'messages', linkUrl: 'https://example.com/ignored' }), context);
    if (!('plan' in traffic) || !('plan' in engagement) || !('plan' in messages)) throw new Error('expected plans');
    expect(traffic.plan).toMatchObject({ objective: 'traffic', linkUrl: 'https://example.com/khuyen-mai', pageConnectionId: ids.pageConnectionId, variants: [{ callToAction: 'learn_more' }] });
    expect(engagement.plan).toMatchObject({ objective: 'engagement', pageConnectionId: ids.pageConnectionId, variants: [{ callToAction: 'no_button' }] });
    expect(messages.plan).toMatchObject({ objective: 'messenger', linkUrl: null, pageConnectionId: ids.pageConnectionId, variants: [{ callToAction: 'send_message' }] });
  });

  it('refuses what a plan cannot be made from: no link for Traffic or Engagement, a budget too small for the days', () => {
    expect(boostPlan(input({ goal: 'traffic', linkUrl: null }), context)).toEqual({ refusal: 'link_needed' });
    expect(boostPlan(input({ goal: 'engagement', linkUrl: null }), context)).toEqual({ refusal: 'link_needed' });
    // Messages needs no link.
    expect('plan' in boostPlan(input({ goal: 'messages', linkUrl: null }), context)).toBe(true);
    expect(boostPlan(input({ budget: '2', days: 3 }), context)).toEqual({ refusal: 'budget_too_small' });
  });

  it('uses a preset’s targeting as a copy, so a plan never shares the preset’s arrays', () => {
    const made = boostPlan(input({ audience: 'hcm_hn' }), context);
    if (!('plan' in made)) throw new Error('expected a plan');
    expect(made.plan.targeting).toEqual(AUDIENCE_PRESETS.hcm_hn);
    expect(made.plan.targeting?.locations).not.toBe(AUDIENCE_PRESETS.hcm_hn.locations);
  });

  it('names the campaign after the post and keeps the name within the plan’s limit', () => {
    expect(boostName('Giảm 20%')).toBe('Đẩy bài: Giảm 20%');
    expect([...boostName('a'.repeat(500))].length).toBe(200);
  });
});

describe('zAdsBoostDraft', () => {
  it('takes a budget with at most two decimals, whole days up to thirty and only the presets, and nothing it does not name', () => {
    expect(zAdsBoostDraft.safeParse(input()).success).toBe(true);
    expect(zAdsBoostDraft.safeParse(input({ budget: '10.123' })).success).toBe(false);
    expect(zAdsBoostDraft.safeParse(input({ budget: '0' })).success).toBe(false);
    expect(zAdsBoostDraft.safeParse(input({ days: 0 })).success).toBe(false);
    expect(zAdsBoostDraft.safeParse(input({ days: 31 })).success).toBe(false);
    expect(zAdsBoostDraft.safeParse(input({ days: 1.5 })).success).toBe(false);
    expect(zAdsBoostDraft.safeParse({ ...input(), audience: 'custom' }).success).toBe(false);
    expect(zAdsBoostDraft.safeParse({ ...input(), extra: 1 }).success).toBe(false);
    // Every ad runs as a Page, whatever the goal.
    expect(zAdsBoostDraft.safeParse(input({ pageConnectionId: null as unknown as string })).success).toBe(false);
    expect(zAdsBoostDraft.safeParse(input({ linkUrl: 'http://example.com' })).success).toBe(false);
  });
});

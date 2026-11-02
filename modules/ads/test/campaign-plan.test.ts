// SPDX-License-Identifier: AGPL-3.0-only
// The pure rules of a campaign plan (W1, #2295): the days of a flight, the largest amount it can spend (decimal), what local validation says against
// the caps in force and the switches, and the hash that binds a submitted plan.
import { describe, expect, it } from 'vitest';
import { zAdsCampaignPlan, type AdsCampaignPlanDraft } from '@crove/kernel-contract';
import { canonicalJson, completePlan, daysByMonth, flightDays, maxSpendOf, planHash, validatePlan, type PlanContext } from '../src/campaign-plan.ts';

const account = '0190c4a1-0000-7000-8000-000000000001';
const plan: AdsCampaignPlanDraft = {
  name: 'Khuyến mãi cuối tuần',
  objective: 'traffic',
  dailyBudget: '100000',
  startOn: '2026-11-12',
  endOn: '2026-11-18',
  targeting: { locations: [{ country: 'VN' }], ageMin: 22, ageMax: 45, gender: 'all', interests: ['Cà phê'] },
  linkUrl: 'https://example.com/khuyen-mai',
  pageConnectionId: null,
  sourcePostId: null,
  mediaFileId: null,
  variants: [{ headline: 'Giảm 20% cuối tuần', primaryText: 'Ghé quán hôm nay để nhận ưu đãi.', callToAction: 'learn_more' }],
};
const context: PlanContext = {
  today: '2026-11-10',
  currency: 'VND',
  caps: [
    { scope: 'account', adAccountId: account, period: 'daily', amount: '200000', currency: 'VND' },
    { scope: 'org', adAccountId: null, period: 'monthly', amount: '5000000', currency: 'VND' },
  ],
  adAccountId: account,
  writeEnabled: true,
  accountWriteEnabled: true,
  launchesBlocked: false,
  pageOk: null,
};
const codes = (draft: AdsCampaignPlanDraft, over: Partial<PlanContext> = {}) => validatePlan(draft, { ...context, ...over }).issues.map((i) => `${i.severity}:${i.code}`);

describe('the flight of a plan', () => {
  it('counts the start and the end day, and nothing for a missing or reversed flight', () => {
    expect(flightDays('2026-11-12', '2026-11-12')).toBe(1);
    expect(flightDays('2026-11-12', '2026-11-18')).toBe(7);
    expect(flightDays('2026-02-27', '2026-03-02')).toBe(4);
    expect(flightDays('2028-02-27', '2028-03-02')).toBe(5);
    expect(flightDays('2026-11-18', '2026-11-12')).toBeNull();
    expect(flightDays(null, '2026-11-12')).toBeNull();
    expect(flightDays('2026-11-12', undefined)).toBeNull();
  });

  it('splits a flight by calendar month', () => {
    expect([...daysByMonth('2026-11-28', '2026-12-02')]).toEqual([['2026-11', 3], ['2026-12', 2]]);
    expect([...daysByMonth('2026-12-30', '2027-01-01')]).toEqual([['2026-12', 2], ['2027-01', 1]]);
  });

  it('works out the largest amount in decimal, never as a float', () => {
    expect(maxSpendOf('100000', 7)).toBe('700000');
    expect(maxSpendOf('10.10', 3)).toBe('30.3');
    expect(maxSpendOf('0.10', 3)).toBe('0.3');
    expect(maxSpendOf('33.33', 90)).toBe('2999.7');
  });
});

describe('local validation of a plan', () => {
  it('has nothing to say about a complete plan inside its caps, and says its largest amount', () => {
    const result = validatePlan(plan, context);
    expect(result).toEqual({ issues: [], maxSpend: '700000', days: 7 });
  });

  it('lists what is still missing, in the order the builder asks for it, and a Messenger ad wants its Page', () => {
    const bare: AdsCampaignPlanDraft = { name: 'Mới', objective: 'traffic' };
    expect(validatePlan(bare, context).issues.filter((i) => i.code === 'missing_field').map((i) => i.field)).toEqual(['dailyBudget', 'startOn', 'endOn', 'targeting', 'variants', 'linkUrl']);
    expect(validatePlan({ ...bare, objective: 'messenger' }, context).issues.filter((i) => i.code === 'missing_field').map((i) => i.field)).toEqual(['dailyBudget', 'startOn', 'endOn', 'targeting', 'variants', 'pageConnectionId']);
    expect(validatePlan(bare, context).maxSpend).toBeNull();
  });

  it('refuses a flight that starts in the past, ends before it starts or is too long, and allows the account’s today', () => {
    expect(codes({ ...plan, startOn: '2026-11-10', endOn: '2026-11-12' })).toEqual([]);
    expect(codes({ ...plan, startOn: '2026-11-09' })).toContain('error:start_in_past');
    expect(codes({ ...plan, startOn: '2026-11-20', endOn: '2026-11-12' })).toContain('error:end_before_start');
    expect(codes({ ...plan, startOn: '2026-11-12', endOn: '2027-03-01' })).toContain('error:flight_too_long');
    // The account's own today decides, not the server's: a plan starting the 10th is late where it is already the 11th.
    expect(codes({ ...plan, startOn: '2026-11-10' }, { today: '2026-11-11' })).toContain('error:start_in_past');
  });

  it('keeps a whole-unit currency to whole units and a cent currency to cents', () => {
    expect(codes({ ...plan, dailyBudget: '100000.50' })).toContain('error:budget_decimals');
    expect(codes({ ...plan, dailyBudget: '10.50' }, { currency: 'USD', caps: [{ scope: 'org', adAccountId: null, period: 'daily', amount: '20.00', currency: 'USD' }, { scope: 'org', adAccountId: null, period: 'monthly', amount: '1000.00', currency: 'USD' }] })).toEqual([]);
    expect(codes({ ...plan, dailyBudget: '1000.5' }, { currency: 'JPY', caps: [{ scope: 'org', adAccountId: null, period: 'daily', amount: '5000', currency: 'JPY' }, { scope: 'org', adAccountId: null, period: 'monthly', amount: '100000', currency: 'JPY' }] })).toContain('error:budget_decimals');
  });

  it('refuses a plan with no cap in force, a cap in another currency, or an unknown currency', () => {
    expect(codes(plan, { caps: [] })).toEqual(['error:no_cap']);
    // One cap is enough, a daily one or a monthly one, the account's or the org's; the plan is judged against every cap that exists.
    expect(codes(plan, { caps: [{ scope: 'org', adAccountId: null, period: 'daily', amount: '200000', currency: 'VND' }] })).toEqual([]);
    expect(codes(plan, { caps: [{ scope: 'account', adAccountId: account, period: 'monthly', amount: '5000000', currency: 'VND' }] })).toEqual([]);
    expect(codes(plan, { caps: [{ scope: 'org', adAccountId: null, period: 'daily', amount: '50000', currency: 'VND' }] })).toEqual(['error:daily_cap_exceeded']);
    expect(codes(plan, { caps: [{ scope: 'org', adAccountId: null, period: 'daily', amount: '20.00', currency: 'USD' }] })).toEqual(['error:cap_currency']);
    // The cap of another account does not apply.
    expect(codes(plan, { caps: [{ scope: 'account', adAccountId: '0190c4a1-0000-7000-8000-000000000002', period: 'daily', amount: '200000', currency: 'VND' }] })).toEqual(['error:no_cap']);
    expect(codes(plan, { currency: null })).toContain('error:account_currency_unknown');
  });

  it('compares the daily budget with the daily caps of the account and the org, and each month of the flight with the monthly caps, in decimal', () => {
    const caps: PlanContext['caps'] = [
      { scope: 'account', adAccountId: account, period: 'daily', amount: '100000', currency: 'VND' },
      { scope: 'org', adAccountId: null, period: 'monthly', amount: '1000000', currency: 'VND' },
    ];
    // Exactly at the daily cap and at the monthly cap: allowed (a cap is a ceiling).
    expect(codes({ ...plan, dailyBudget: '100000', startOn: '2026-11-12', endOn: '2026-11-21' }, { caps })).toEqual([]);
    expect(codes({ ...plan, dailyBudget: '100001', startOn: '2026-11-12', endOn: '2026-11-12' }, { caps })).toEqual(['error:daily_cap_exceeded']);
    // 11 days at 100 000 in November is over the 1 000 000 monthly cap.
    expect(codes({ ...plan, dailyBudget: '100000', startOn: '2026-11-12', endOn: '2026-11-22' }, { caps })).toEqual(['error:monthly_cap_exceeded']);
    // A flight over two months is judged month by month: 5 days in November and 5 in December are each inside.
    expect(codes({ ...plan, dailyBudget: '100000', startOn: '2026-11-26', endOn: '2026-12-05' }, { caps })).toEqual([]);
  });

  it('refuses to submit while running ads is off for the org or the account or launches are blocked', () => {
    expect(codes(plan, { writeEnabled: false })).toEqual(['error:writing_off']);
    expect(codes(plan, { accountWriteEnabled: false })).toEqual(['error:account_not_enabled']);
    expect(codes(plan, { launchesBlocked: true })).toEqual(['error:launches_blocked']);
  });

  it('only warns about long texts, repeated interests and a Messenger ad with another button', () => {
    const long = { headline: 'H'.repeat(41), primaryText: 'P'.repeat(126), callToAction: 'learn_more' as const };
    expect(codes({ ...plan, variants: [long] })).toEqual(['warning:headline_long', 'warning:primary_text_long']);
    expect(codes({ ...plan, targeting: { ...(plan.targeting as NonNullable<typeof plan.targeting>), interests: ['Cà phê', 'cà phê'] } })).toEqual(['warning:interests_repeated']);
    expect(codes({ ...plan, objective: 'messenger', linkUrl: null, pageConnectionId: '0190c4a1-0000-7000-8000-0000000000aa' }, { pageOk: true })).toEqual(['warning:messenger_call_to_action']);
    expect(codes({ ...plan, objective: 'messenger', linkUrl: null, pageConnectionId: '0190c4a1-0000-7000-8000-0000000000aa' }, { pageOk: false })).toContain('error:page_not_found');
  });
});

describe('the complete plan and its hash', () => {
  it('is the draft once it has everything, and nothing before', () => {
    const complete = completePlan(plan);
    expect(complete).not.toBeNull();
    expect(zAdsCampaignPlan.safeParse(complete).success).toBe(true);
    expect(completePlan({ ...plan, dailyBudget: null })).toBeNull();
    expect(completePlan({ ...plan, variants: [] })).toBeNull();
    expect(completePlan({ name: 'Mới', objective: 'traffic' })).toBeNull();
  });

  it('does not depend on how the object was built, and changes with any field, the account or the currency', () => {
    const complete = completePlan(plan);
    if (!complete) throw new Error('the plan is complete');
    // The same plan with every object's keys in the reverse order.
    const reversed = (value: unknown): unknown =>
      Array.isArray(value) ? value.map(reversed) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)])) : value;
    const rebuilt = reversed(complete) as typeof complete;
    const hash = planHash(complete, account, 'VND');
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(planHash(rebuilt, account.toUpperCase(), 'VND')).toBe(hash);
    expect(planHash({ ...complete, dailyBudget: '100001' }, account, 'VND')).not.toBe(hash);
    expect(planHash({ ...complete, endOn: '2026-11-19' }, account, 'VND')).not.toBe(hash);
    expect(planHash({ ...complete, variants: [{ ...complete.variants[0]!, headline: 'Khác' }] }, account, 'VND')).not.toBe(hash);
    expect(planHash(complete, '0190c4a1-0000-7000-8000-000000000002', 'VND')).not.toBe(hash);
    expect(planHash(complete, account, 'USD')).not.toBe(hash);
  });

  it('writes the same canonical text for the same value in any key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe(canonicalJson({ a: [{ c: 2, d: 1 }], b: 1 }));
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

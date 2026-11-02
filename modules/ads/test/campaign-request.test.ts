// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { assembleDraft, defaultDailyBudget } from '../src/campaign-request.ts';

// The dates and the budget of a draft the AI coworker wrote are the rules' (W1b, #2295): the model never sets money, so these are pure functions of the
// caps in force and the account's own today.
describe('defaultDailyBudget', () => {
  it('is below every daily cap and every monthly cap spread over 31 days, rounded down to the currency’s smallest unit', () => {
    expect(defaultDailyBudget('VND', ['200000'], ['5000000'])).toBe('161290');
    expect(defaultDailyBudget('VND', ['100000'], ['5000000'])).toBe('100000');
    expect(defaultDailyBudget('VND', ['200000', '150000'], [])).toBe('150000');
    expect(defaultDailyBudget('VND', [], ['3100000', '6200000'])).toBe('100000');
    // A currency with cents keeps two decimals, rounded down.
    expect(defaultDailyBudget('USD', ['10.999'], [])).toBe('10.99');
    expect(defaultDailyBudget('USD', [], ['100'])).toBe('3.22');
    // Never above the largest budget the contract takes (13 digits), however large the cap.
    expect(defaultDailyBudget('USD', ['99999999999999'], [])).toBe('9999999999999.99');
    expect(defaultDailyBudget('VND', ['99999999999999'], [])).toBe('9999999999999');
    // A budget has two decimals at most (as it is entered), whatever the currency's own: three-decimal dinars are cut to two.
    expect(defaultDailyBudget('KWD', ['10.9999'], [])).toBe('10.99');
  });

  it('is empty when no cap is in force, when the currency is not read yet, or when the result would be zero', () => {
    expect(defaultDailyBudget('VND', [], [])).toBeNull();
    expect(defaultDailyBudget(null, ['200000'], ['5000000'])).toBeNull();
    expect(defaultDailyBudget('VND', [], ['30'])).toBeNull();
    expect(defaultDailyBudget('VND', ['0'], [])).toBeNull();
  });
});

describe('assembleDraft', () => {
  const source = { objective: 'traffic' as const, sourcePostId: null, currency: 'VND', today: '2026-12-30', dailyCaps: ['200000'], monthlyCaps: ['5000000'] };
  const ai = {
    name: 'Cà phê Mộc',
    durationDays: 7,
    targeting: { locations: [{ country: 'VN', region: 'Hồ Chí Minh' }, { country: 'VN', region: null }], ageMin: 20, ageMax: 45, gender: 'all' as const, interests: ['Cà phê'] },
    linkUrl: null,
    variants: [{ headline: 'Cà phê Mộc', primaryText: 'Ghé quán sáng nay.', callToAction: 'learn_more' as const }],
  };

  it('starts tomorrow in the account’s own day, runs the days the model asked for across a year end, and sets the budget by the rules', () => {
    const { plan, aiFields } = assembleDraft(source, ai);
    expect(plan).toMatchObject({ name: 'Cà phê Mộc', objective: 'traffic', dailyBudget: '161290', startOn: '2026-12-31', endOn: '2027-01-06', sourcePostId: null, linkUrl: null });
    // A location with no region has none (the contract has no null region).
    expect(plan.targeting?.locations).toEqual([{ country: 'VN', region: 'Hồ Chí Minh' }, { country: 'VN' }]);
    expect(aiFields.sort()).toEqual(['dailyBudget', 'endOn', 'linkUrl', 'name', 'startOn', 'targeting', 'variants']);
  });

  it('keeps the flight inside what the contract takes and names no budget when no cap is in force', () => {
    const { plan, aiFields } = assembleDraft({ ...source, dailyCaps: [], monthlyCaps: [] }, { ...ai, durationDays: 500 });
    expect(plan.dailyBudget).toBeUndefined();
    expect(aiFields).not.toContain('dailyBudget');
    // 90 days at most: the day after tomorrow plus 89.
    expect(plan.endOn).toBe('2027-03-30');
    expect(assembleDraft(source, { ...ai, durationDays: 0 }).plan.endOn).toBe('2026-12-31');
  });
});

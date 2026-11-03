// SPDX-License-Identifier: AGPL-3.0-only
// The caps judged against what is already committed (W2, #2296): a plan that fits a cap alone can pass it together with a launch already live, a daily cap
// is checked day by day and a monthly cap month by month, an org cap counts every account and an account cap its own, money is decimal, and, the
// property the plan names, launches admitted one after the other by this check never pass a cap.
import { describe, expect, it } from 'vitest';
import { daysByMonth } from '../src/campaign-plan.ts';
import { addDays } from '../src/domain.ts';
import { committedProblems, type Commitment, type CommittedCap, type CommittedPlan } from '../src/launch-caps.ts';

const A = '0190c4a1-0000-7000-8000-000000000001';
const B = '0190c4a1-0000-7000-8000-000000000002';

const plan = (over: Partial<CommittedPlan> = {}): CommittedPlan => ({ adAccountId: A, currency: 'VND', dailyBudget: '100000', startOn: '2026-11-10', endOn: '2026-11-16', ...over });
const live = (over: Partial<Commitment> = {}): Commitment => ({ adAccountId: A, currency: 'VND', dailyBudget: '100000', startOn: '2026-11-10', endOn: '2026-11-16', ...over });
const daily = (amount: string, over: Partial<CommittedCap> = {}): CommittedCap => ({ scope: 'org', adAccountId: null, period: 'daily', amount, currency: 'VND', ...over });
const monthly = (amount: string, over: Partial<CommittedCap> = {}): CommittedCap => ({ scope: 'org', adAccountId: null, period: 'monthly', amount, currency: 'VND', ...over });

describe('a plan against the caps alone', () => {
  it('passes a cap it fits, to the unit, and fails one it passes', () => {
    expect(committedProblems(plan(), [], [daily('100000')])).toEqual([]);
    expect(committedProblems(plan(), [], [daily('99999')])).toEqual([{ code: 'daily_cap_exceeded', scope: 'org', period: 'daily', cap: '99999', committed: '0', plan: '100000', day: '2026-11-10' }]);
    expect(committedProblems(plan(), [], [monthly('700000')])).toEqual([]);
    expect(committedProblems(plan(), [], [monthly('699999')])).toEqual([{ code: 'monthly_cap_exceeded', scope: 'org', period: 'monthly', cap: '699999', committed: '0', plan: '700000', month: '2026-11' }]);
  });
});

describe('a plan against what is committed', () => {
  it('fails a daily cap when another launch is live on the same days, though each fits it alone', () => {
    const caps = [daily('150000')];
    expect(committedProblems(plan(), [], caps)).toEqual([]);
    expect(committedProblems(plan(), [live()], caps)).toEqual([{ code: 'daily_cap_exceeded', scope: 'org', period: 'daily', cap: '150000', committed: '100000', plan: '100000', day: '2026-11-10' }]);
  });

  it('names the first day that passes, and ignores a launch that does not touch the plan\'s days', () => {
    const caps = [daily('150000')];
    expect(committedProblems(plan(), [live({ startOn: '2026-11-01', endOn: '2026-11-09' }), live({ startOn: '2026-11-17', endOn: '2026-11-30' })], caps)).toEqual([]);
    expect(committedProblems(plan(), [live({ startOn: '2026-11-14', endOn: '2026-11-20' })], caps)).toMatchObject([{ day: '2026-11-14', committed: '100000' }]);
  });

  it('sums every launch live on a day, with decimals that float arithmetic would get wrong', () => {
    const caps = [daily('0.30', { currency: 'USD' })];
    const p = plan({ currency: 'USD', dailyBudget: '0.10' });
    const others = [live({ currency: 'USD', dailyBudget: '0.10' }), live({ currency: 'USD', dailyBudget: '0.10' })];
    // 0.1 + 0.1 + 0.1 is exactly the cap, which is allowed.
    expect(committedProblems(p, others, caps)).toEqual([]);
    expect(committedProblems(p, [...others, live({ currency: 'USD', dailyBudget: '0.01' })], caps)).toMatchObject([{ committed: '0.21', plan: '0.1' }]);
  });

  it('fails a monthly cap by the days each launch has in the month, across a month boundary', () => {
    const p = plan({ startOn: '2026-11-28', endOn: '2026-12-03' });
    // Three days in November and three in December, 100,000 a day.
    expect(committedProblems(p, [], [monthly('300000')])).toEqual([]);
    // The other launch has two days in November and one in December. November: 200,000 and the plan's 300,000 are exactly 500,000, which fits.
    const others = [live({ startOn: '2026-11-29', endOn: '2026-12-01' })];
    expect(committedProblems(p, others, [monthly('500000')])).toEqual([]);
    expect(committedProblems(p, others, [monthly('499999')])).toEqual([{ code: 'monthly_cap_exceeded', scope: 'org', period: 'monthly', cap: '499999', committed: '200000', plan: '300000', month: '2026-11' }]);
    // December: the other launch has one day there, the plan three: 400,000, which fits 400,000 and not 399,999.
    expect(committedProblems(plan({ startOn: '2026-12-01', endOn: '2026-12-03' }), others, [monthly('399999')])).toMatchObject([{ month: '2026-12', committed: '100000', plan: '300000' }]);
    expect(committedProblems(plan({ startOn: '2026-12-01', endOn: '2026-12-03' }), others, [monthly('400000')])).toEqual([]);
  });

  it('counts a window shortened to the day a launch was paused, and nothing for the days it did not run', () => {
    const paused = live({ startOn: '2026-11-10', endOn: '2026-11-11' });
    expect(committedProblems(plan(), [paused], [daily('150000')])).toMatchObject([{ day: '2026-11-10' }]);
    expect(committedProblems(plan({ startOn: '2026-11-12', endOn: '2026-11-16' }), [paused], [daily('150000')])).toEqual([]);
    expect(committedProblems(plan({ startOn: '2026-11-12', endOn: '2026-11-16' }), [paused], [monthly('700000')])).toEqual([]);
    expect(committedProblems(plan({ startOn: '2026-11-12', endOn: '2026-11-16' }), [paused], [monthly('699999')])).toHaveLength(1);
  });
});

describe('which launches count towards which cap', () => {
  it('counts every account of the org for an org cap, and only the plan\'s own account for an account cap', () => {
    const other = live({ adAccountId: B });
    expect(committedProblems(plan(), [other], [daily('150000')])).toHaveLength(1);
    expect(committedProblems(plan(), [other], [daily('150000', { scope: 'account', adAccountId: A })])).toEqual([]);
    expect(committedProblems(plan(), [live()], [daily('150000', { scope: 'account', adAccountId: A })])).toHaveLength(1);
  });

  it('leaves out the cap of another account, and a cap or a launch in another currency', () => {
    expect(committedProblems(plan(), [], [daily('1', { scope: 'account', adAccountId: B })])).toEqual([]);
    expect(committedProblems(plan(), [], [daily('1', { currency: 'USD' })])).toEqual([]);
    expect(committedProblems(plan(), [live({ currency: 'USD' })], [daily('150000')])).toEqual([]);
  });

  it('reports each cap it passes, and an account cap and an org cap apart', () => {
    const problems = committedProblems(plan(), [live()], [daily('150000'), daily('150000', { scope: 'account', adAccountId: A }), monthly('1000000')]);
    expect(problems.map((p) => [p.scope, p.period])).toEqual([
      ['org', 'daily'],
      ['account', 'daily'],
      ['org', 'monthly'],
    ]);
  });
});

// A small deterministic generator, so the property below is the same on every run.
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('launches admitted one after the other by this check', () => {
  it('never pass a daily or a monthly cap, whatever the order, the accounts and the flights', () => {
    for (const seed of [1, 7, 42, 2026, 31337]) {
      const random = lcg(seed);
      const caps: CommittedCap[] = [daily('250000'), daily('120000', { scope: 'account', adAccountId: A }), monthly('3000000'), monthly('1500000', { scope: 'account', adAccountId: B })];
      const admitted: Commitment[] = [];
      for (let i = 0; i < 60; i++) {
        const startOn = addDays('2026-11-01', Math.floor(random() * 50));
        const candidate: CommittedPlan = {
          adAccountId: random() < 0.5 ? A : B,
          currency: 'VND',
          dailyBudget: String(10000 + Math.floor(random() * 12) * 10000),
          startOn,
          endOn: addDays(startOn, Math.floor(random() * 30)),
        };
        if (committedProblems(candidate, admitted, caps).length === 0) admitted.push({ ...candidate });
      }
      expect(admitted.length).toBeGreaterThan(3);
      // Brute force, apart from the check: the sum on every day and in every month, per account and for the org.
      const spans = admitted.flatMap((c) => [c.startOn, c.endOn]).sort();
      const first = spans[0] ?? '2026-11-01';
      const last = spans.at(-1) ?? first;
      for (let day = first; day <= last; day = addDays(day, 1)) {
        const on = admitted.filter((c) => c.startOn <= day && day <= c.endOn);
        expect(on.reduce((n, c) => n + Number(c.dailyBudget), 0), `org ${day}`).toBeLessThanOrEqual(250000);
        expect(on.filter((c) => c.adAccountId === A).reduce((n, c) => n + Number(c.dailyBudget), 0), `account A ${day}`).toBeLessThanOrEqual(120000);
      }
      const months = new Map<string, { org: number; b: number }>();
      for (const c of admitted) {
        for (const [month, days] of daysByMonth(c.startOn, c.endOn)) {
          const m = months.get(month) ?? { org: 0, b: 0 };
          m.org += Number(c.dailyBudget) * days;
          if (c.adAccountId === B) m.b += Number(c.dailyBudget) * days;
          months.set(month, m);
        }
      }
      for (const [month, m] of months) {
        expect(m.org, `org ${month}`).toBeLessThanOrEqual(3000000);
        expect(m.b, `account B ${month}`).toBeLessThanOrEqual(1500000);
      }
    }
  });
});

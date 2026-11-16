// SPDX-License-Identifier: AGPL-3.0-only
// The committed spend the Ads screen reads (#3297) against the lock's own calculation: the figure of a month, per account and per org, is the `committed` the
// monthly cap check reports for the same launches, so what the screen shows and what the next approval is judged against cannot drift. Also the cap and the room
// left, caps of another currency or another account that do not count, no cap at all, and money in decimal.
import { describe, expect, it } from 'vitest';
import { addDays } from '../src/domain.ts';
import { committedSpend } from '../src/committed-spend.ts';
import { committedProblems, type Commitment, type CommittedCap } from '../src/launch-caps.ts';

const A = '0190c4a1-0000-7000-8000-000000000001';
const B = '0190c4a1-0000-7000-8000-000000000002';

const live = (over: Partial<Commitment> = {}): Commitment => ({ adAccountId: A, currency: 'VND', dailyBudget: '100000', startOn: '2026-11-10', endOn: '2026-11-16', ...over });
const monthly = (amount: string, over: Partial<CommittedCap> = {}): CommittedCap => ({ scope: 'org', adAccountId: null, period: 'monthly', amount, currency: 'VND', ...over });
const daily = (amount: string, over: Partial<CommittedCap> = {}): CommittedCap => ({ scope: 'org', adAccountId: null, period: 'daily', amount, currency: 'VND', ...over });
const spend = (commitments: Commitment[], caps: CommittedCap[], over: { month?: string; adAccountId?: string; currency?: string } = {}) =>
  committedSpend({ month: '2026-11', adAccountId: A, currency: 'VND', commitments, caps, ...over });

describe('the committed spend of a month', () => {
  it('is the budget times the days inside the month, the cap and what is left', () => {
    const view = spend([live()], [monthly('1000000')]);
    expect(view).toEqual({
      adAccountId: A,
      month: '2026-11',
      currency: 'VND',
      hasCap: true,
      capCurrencyMismatch: false,
      account: { committed: '700000', cap: null, left: null },
      org: { committed: '700000', cap: '1000000', left: '300000' },
    });
  });

  it('counts only the days of the month for a flight that crosses its end, and nothing for a flight outside it', () => {
    const crossing = live({ startOn: '2026-10-29', endOn: '2026-11-02', dailyBudget: '50000' });
    expect(spend([crossing], [monthly('1000000')]).org.committed).toBe('100000');
    expect(spend([crossing], [monthly('1000000')], { month: '2026-10' }).org.committed).toBe('150000');
    expect(spend([crossing], [monthly('1000000')], { month: '2026-12' }).org.committed).toBe('0');
  });

  it('keeps the account apart from the org: an account cap counts its own launches, an org cap every launch of the currency', () => {
    const view = spend([live(), live({ adAccountId: B, dailyBudget: '30000' })], [monthly('900000', { scope: 'account', adAccountId: A }), monthly('2000000')]);
    expect(view.account).toEqual({ committed: '700000', cap: '900000', left: '200000' });
    expect(view.org).toEqual({ committed: '910000', cap: '2000000', left: '1090000' });
  });

  it('leaves a cap of another account or another currency out, and a launch of another currency uncounted', () => {
    const view = spend([live({ currency: 'USD' })], [monthly('900000', { scope: 'account', adAccountId: B }), monthly('50', { currency: 'USD' })]);
    expect(view.hasCap).toBe(false);
    // The USD cap and the account's USD launches are not this account's VND ones; the org's USD cap would make a VND plan refuse (`cap_currency`).
    expect(view.capCurrencyMismatch).toBe(true);
    expect(view.account).toEqual({ committed: '0', cap: null, left: null });
    expect(view.org).toEqual({ committed: '0', cap: null, left: null });
  });

  it('flags a cap in another currency beside a usable one, since the plan check refuses every launch against it', () => {
    const view = spend([live()], [monthly('1000000'), daily('5000', { currency: 'USD' })]);
    expect(view).toMatchObject({ hasCap: true, capCurrencyMismatch: true });
    // A cap of another account is not this account's mismatch.
    expect(spend([], [monthly('50', { scope: 'account', adAccountId: B, currency: 'USD' })]).capCurrencyMismatch).toBe(false);
  });

  it('has no cap at all until one is set, and a daily cap alone is a cap (one is enough) with no monthly line', () => {
    expect(spend([], []).hasCap).toBe(false);
    const view = spend([live()], [daily('150000')]);
    expect(view.hasCap).toBe(true);
    expect(view.org).toEqual({ committed: '700000', cap: null, left: null });
  });

  it('shows the room below zero when a cap was lowered under what is committed', () => {
    expect(spend([live()], [monthly('500000')]).org.left).toBe('-200000');
  });

  it('stays exact where float arithmetic would not', () => {
    const view = spend([live({ dailyBudget: '0.1', startOn: '2026-11-01', endOn: '2026-11-03' }), live({ dailyBudget: '0.2', startOn: '2026-11-01', endOn: '2026-11-03' })], [monthly('1')], { currency: 'VND' });
    expect(view.org).toEqual({ committed: '0.9', cap: '1', left: '0.1' });
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

describe('against the lock', () => {
  it('shows the figure the monthly cap check is made with, for the account and for the org, whatever the flights', () => {
    for (const seed of [3, 11, 99, 2026, 4242]) {
      const random = lcg(seed);
      const commitments: Commitment[] = Array.from({ length: 25 }, () => {
        const startOn = addDays('2026-10-15', Math.floor(random() * 60));
        return { adAccountId: random() < 0.5 ? A : B, currency: random() < 0.85 ? 'VND' : 'USD', dailyBudget: String(1000 + Math.floor(random() * 90) * 500), startOn, endOn: addDays(startOn, Math.floor(random() * 40)) };
      });
      for (const month of ['2026-10', '2026-11', '2026-12']) {
        const view = spend(commitments, [], { month });
        // A cap of one unit is passed by any plan, so the check reports what it holds against the cap: the same sum, taken by the lock's own code.
        const plan = { adAccountId: A, currency: 'VND', dailyBudget: '1', startOn: `${month}-01`, endOn: `${month}-01` };
        for (const scope of ['org', 'account'] as const) {
          const cap = monthly('0.5', { scope, adAccountId: scope === 'org' ? null : A });
          const [problem] = committedProblems(plan, commitments, [cap]);
          expect(problem?.code).toBe('monthly_cap_exceeded');
          expect(view[scope].committed, `${seed} ${month} ${scope}`).toBe(problem?.committed);
        }
      }
    }
  });

  it('agrees on the edge: room left of exactly a plan\'s month is admitted, one unit less is refused', () => {
    const others = [live({ dailyBudget: '100000', startOn: '2026-11-01', endOn: '2026-11-30' })];
    const plan = { adAccountId: A, currency: 'VND', dailyBudget: '10000', startOn: '2026-11-01', endOn: '2026-11-03' };
    const left = spend(others, [monthly('3030000')]).org.left;
    expect(left).toBe('30000');
    expect(committedProblems(plan, others, [monthly('3030000')])).toEqual([]);
    expect(committedProblems(plan, others, [monthly('3029999')])).toMatchObject([{ code: 'monthly_cap_exceeded', committed: '3000000' }]);
  });
});

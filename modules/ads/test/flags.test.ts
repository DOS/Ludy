// SPDX-License-Identifier: AGPL-3.0-only
// The ads module's deterministic flags (issue #2378): the pace of the month against a cap, a day over its share of a cap, and the jump of a
// campaign's cost per result against its trailing median. Pure and in decimal.
import { describe, expect, it } from 'vitest';
import { CPR_HISTORY_DAYS, accountDaysFrom, DEFAULT_FLAG_THRESHOLDS, cprJump, dailyShare, dayOfMonth, dayOverShare, daysInMonthOf, evaluateFlags, flagAmount, monthPace, monthStartOf, paceAboveCap, thresholdsFrom, type DayFigure, type FlagInput } from '../src/flags.ts';
import { addDays } from '../src/domain.ts';

describe('the days of a month', () => {
  it('knows its start, its length and the day of the month, leap years included', () => {
    expect(monthStartOf('2026-11-20')).toBe('2026-11-01');
    expect(dayOfMonth('2026-11-20')).toBe(20);
    expect([daysInMonthOf('2026-11-05'), daysInMonthOf('2026-12-31'), daysInMonthOf('2027-02-10'), daysInMonthOf('2028-02-10')]).toEqual([30, 31, 28, 29]);
  });
});

describe('the days the flags read', () => {
  it('start at the beginning of the month of yesterday, so the last day of a month is read on the 1st', () => {
    expect(accountDaysFrom('2026-12-01')).toBe('2026-11-01');
    expect(accountDaysFrom('2027-01-01')).toBe('2026-12-01');
    expect(accountDaysFrom('2026-11-10')).toBe('2026-11-01');
    expect(accountDaysFrom('2026-03-01')).toBe('2026-02-01');
  });
});

describe('the pace of the month', () => {
  const thresholds = DEFAULT_FLAG_THRESHOLDS;
  it('projects linearly: what was spent over the days over, times the days of the month, today not counted', () => {
    // 9 days over on the 10th, 90 000 spent: 10 000 a day, 300 000 in a 30-day month.
    const pace = monthPace({ today: '2026-11-10', spentBeforeToday: '90000', minDays: thresholds.paceMinDays });
    expect(pace).toMatchObject({ elapsedDays: 9, daysInMonth: 30 });
    expect(pace?.projected.toFixed()).toBe('300000');
    expect(flagAmount(pace?.projected ?? 0, 'VND')).toBe('300000');
  });

  it('flags only above the cap, never at it', () => {
    const pace = monthPace({ today: '2026-11-10', spentBeforeToday: '90000', minDays: 3 });
    expect(pace && paceAboveCap(pace, '250000')).toBe(true);
    expect(pace && paceAboveCap(pace, '300000')).toBe(false);
    expect(pace && paceAboveCap(pace, '350000')).toBe(false);
  });

  it('waits for enough days: none over on the 1st, fewer than the minimum, and the first day it can judge', () => {
    expect(monthPace({ today: '2026-11-01', spentBeforeToday: '0', minDays: 1 })).toBeNull();
    expect(monthPace({ today: '2026-11-03', spentBeforeToday: '50000', minDays: 3 })).toBeNull();
    expect(monthPace({ today: '2026-11-04', spentBeforeToday: '50000', minDays: 3 })).toMatchObject({ elapsedDays: 3 });
    expect(monthPace({ today: '2026-11-02', spentBeforeToday: '50000', minDays: 1 })).toMatchObject({ elapsedDays: 1, daysInMonth: 30 });
  });

  it('follows the length of the month, at its boundaries and in a leap year', () => {
    // The same 10 000 a day: 28, 29, 30 and 31 days.
    const projected = (today: string) => monthPace({ today, spentBeforeToday: '90000', minDays: 3 })?.projected.toFixed();
    expect(projected('2027-02-10')).toBe('280000');
    expect(projected('2028-02-10')).toBe('290000');
    expect(projected('2026-11-10')).toBe('300000');
    expect(projected('2026-12-10')).toBe('310000');
    // The last day of a month: 30 days over of 31.
    expect(monthPace({ today: '2026-12-31', spentBeforeToday: '300000', minDays: 3 })?.projected.toFixed()).toBe('310000');
  });

  it('keeps decimals: a dollar account rounds to cents and a yen account to whole yen, never through a float', () => {
    const usd = monthPace({ today: '2026-11-10', spentBeforeToday: '123.45', minDays: 3 });
    expect(usd?.projected.toFixed()).toBe('411.5');
    expect(flagAmount('411.505', 'USD')).toBe('411.51');
    expect(flagAmount('411.5', 'JPY')).toBe('412');
    const odd = monthPace({ today: '2026-11-08', spentBeforeToday: '0.1', minDays: 3 });
    expect(flagAmount(odd?.projected ?? 0, 'USD')).toBe('0.43');
    expect(flagAmount(odd?.projected ?? 0, 'VND')).toBe('0');
  });
});

describe('a day over its share of a cap', () => {
  it('takes a daily cap as its own share and spreads a monthly cap over the days of the month', () => {
    expect(dailyShare({ period: 'daily', amount: '1000000' }, 30).toFixed()).toBe('1000000');
    expect(dailyShare({ period: 'monthly', amount: '30000000' }, 30).toFixed()).toBe('1000000');
    expect(dailyShare({ period: 'monthly', amount: '31000000' }, 31).toFixed()).toBe('1000000');
    expect(dailyShare({ period: 'monthly', amount: '29000000' }, 29).toFixed()).toBe('1000000');
  });

  it('flags above the factor, never at it, and gives the ratio rounded up', () => {
    const daily = (spend: string) => dayOverShare({ spend, cap: { period: 'daily', amount: '1000000' }, daysInMonth: 30, factor: '1.5' });
    expect(daily('1600000')).toBe('1.60');
    expect(daily('1500000')).toBeNull();
    // 1.500001 times its share: above the factor, and the ratio never reads as the threshold it is above.
    expect(daily('1500001')).toBe('1.51');
    expect(daily('900000')).toBeNull();
    expect(dayOverShare({ spend: '5', cap: { period: 'daily', amount: '0' }, daysInMonth: 30, factor: '1.5' })).toBeNull();
  });

  it('does not round a monthly cap that does not divide evenly before it compares', () => {
    // 100 over 30 days is 3.333... a day: 5 is exactly 1.5 times it, so no flag; 5.01 is above.
    const monthly = (spend: string) => dayOverShare({ spend, cap: { period: 'monthly', amount: '100' }, daysInMonth: 30, factor: '1.5' });
    expect(monthly('5')).toBeNull();
    expect(monthly('5.01')).toBe('1.51');
  });
});

describe('the cost per result against its trailing median', () => {
  const thresholds = DEFAULT_FLAG_THRESHOLDS;
  const lastDay = '2026-11-20';
  // `days` days of history before the last 3, each spending `spend` for `results`.
  const history = (days: number, spend: string, results: string | null): DayFigure[] =>
    Array.from({ length: days }, (_, i) => ({ day: addDays(lastDay, -(3 + i)), spend, results }));
  const recent = (spend: string, results: string): DayFigure[] => [0, 1, 2].map((i) => ({ day: addDays(lastDay, -i), spend, results }));

  it('flags a jump above the factor: the last 3 days at 2 000 a result against a median of 1 000', () => {
    // 3 days x (600 000 / 300 results) is 2 000 a result; the history is 1 000 a result.
    const jump = cprJump({ figures: [...history(10, '100000', '100'), ...recent('600000', '300')], lastDay, currency: 'VND', thresholds });
    expect(jump).toEqual({ recentCost: '2000', medianCost: '1000', ratio: '2.00', recentResults: '900', historyDays: 10 });
  });

  it('flags only above the factor, never at it', () => {
    expect(cprJump({ figures: [...history(10, '100000', '100'), ...recent('150000', '100')], lastDay, currency: 'VND', thresholds })).toBeNull();
    // 1.501 times the median: flagged, and the ratio is rounded up so it does not read as the threshold.
    expect(cprJump({ figures: [...history(10, '100000', '100'), ...recent('150100', '100')], lastDay, currency: 'VND', thresholds })?.ratio).toBe('1.51');
  });

  it('takes the median of the daily costs, so one odd day does not move it', () => {
    const odd: DayFigure[] = [...history(9, '100000', '100'), { day: addDays(lastDay, -12), spend: '9000000', results: '1' }];
    const jump = cprJump({ figures: [...odd, ...recent('300000', '200')], lastDay, currency: 'VND', thresholds });
    // The median stays at 1 000 whatever the one odd day costs; 3 x 300 000 over 600 results is 1 500, not above 1.5 times 1 000.
    expect(jump).toBeNull();
    expect(cprJump({ figures: [...odd, ...recent('330000', '200')], lastDay, currency: 'VND', thresholds })?.medianCost).toBe('1000');
  });

  it('compares exactly: a cost at 1.5 times a median that is not a finite decimal is not above it', () => {
    // The median is 1003 over 9 results a day, 111.44...; the last 3 days cost 1003 over 6 results, which is exactly 1.5 times it.
    const odd: DayFigure[] = Array.from({ length: 5 }, (_, i) => ({ day: addDays(lastDay, -(3 + i)), spend: '1003', results: '9' }));
    const last = (spend: string): DayFigure[] => [{ day: lastDay, spend, results: '6' }];
    expect(cprJump({ figures: [...odd, ...last('1003')], lastDay, currency: 'VND', thresholds })).toBeNull();
    expect(cprJump({ figures: [...odd, ...last('1003.01')], lastDay, currency: 'VND', thresholds })).not.toBeNull();
  });

  it('averages the two middle days of an even number of days', () => {
    const figures: DayFigure[] = [
      ...[800, 800, 800, 1200, 1200, 1200].map((cost, i) => ({ day: addDays(lastDay, -(3 + i)), spend: String(cost * 10), results: '10' })),
      ...recent('300000', '100'),
    ];
    // Medians: sorted 800 800 800 1200 1200 1200, the two middle days average 1 000; the last days cost 3 000.
    expect(cprJump({ figures, lastDay, currency: 'VND', thresholds })).toMatchObject({ medianCost: '1000', recentCost: '3000', historyDays: 6 });
  });

  it('does not judge on too few results, too few days of history, or a history of zero-result days', () => {
    // 3 results in the last 3 days (one a day), under the minimum of 5; 6 results (two a day) is enough.
    expect(cprJump({ figures: [...history(10, '100000', '100'), ...recent('900000', '1')], lastDay, currency: 'VND', thresholds })).toBeNull();
    expect(cprJump({ figures: [...history(10, '100000', '100'), ...recent('900000', '2')], lastDay, currency: 'VND', thresholds })).not.toBeNull();
    // 4 days of history, under the minimum of 5.
    expect(cprJump({ figures: [...history(4, '100000', '100'), ...recent('900000', '300')], lastDay, currency: 'VND', thresholds })).toBeNull();
    // Days with no result (zero or none recorded) are not days with results.
    expect(cprJump({ figures: [...history(10, '100000', '0'), ...recent('900000', '300')], lastDay, currency: 'VND', thresholds })).toBeNull();
    expect(cprJump({ figures: [...history(10, '100000', null), ...recent('900000', '300')], lastDay, currency: 'VND', thresholds })).toBeNull();
    // Only the 14 days before the last 3 count: older days are out, and so are the last days themselves.
    const old: DayFigure[] = Array.from({ length: 10 }, (_, i) => ({ day: addDays(lastDay, -(3 + CPR_HISTORY_DAYS + i)), spend: '100000', results: '100' }));
    expect(cprJump({ figures: [...old, ...recent('900000', '300')], lastDay, currency: 'VND', thresholds })).toBeNull();
  });

  it('works in the currency of the figures: a dollar account to the cent, a yen account in whole yen, zero-result days among the last 3', () => {
    const usd = cprJump({
      figures: [...history(8, '10.00', '4'), { day: lastDay, spend: '20.00', results: '3' }, { day: addDays(lastDay, -1), spend: '20.00', results: '3' }, { day: addDays(lastDay, -2), spend: '5.00', results: null }],
      lastDay,
      currency: 'USD',
      thresholds,
    });
    // 45.00 over 6 results is 7.50 a result against a median of 2.50.
    expect(usd).toEqual({ recentCost: '7.50', medianCost: '2.50', ratio: '3.00', recentResults: '6', historyDays: 8 });
    const jpy = cprJump({ figures: [...history(8, '1000', '3'), ...recent('2000', '3')], lastDay, currency: 'JPY', thresholds });
    expect(jpy).toMatchObject({ recentCost: '667', medianCost: '333', ratio: '2.00' });
  });

  it('honours the thresholds an org sets', () => {
    const figures = [...history(10, '100000', '100'), ...recent('150100', '100')];
    expect(cprJump({ figures, lastDay, currency: 'VND', thresholds: { ...thresholds, cprFactor: '1.6' } })).toBeNull();
    expect(cprJump({ figures, lastDay, currency: 'VND', thresholds: { ...thresholds, cprMinResults: 400 } })).toBeNull();
    expect(cprJump({ figures: [...history(4, '100000', '100'), ...recent('900000', '300')], lastDay, currency: 'VND', thresholds: { ...thresholds, cprMinHistoryDays: 4 } })).not.toBeNull();
  });
});

describe('the flags of an org at an instant', () => {
  // 2026-11-10 12:00 in Ho Chi Minh City (05:00 UTC), still the 9th at 21:00 in Los Angeles.
  const now = new Date('2026-11-10T05:00:00Z');
  const vn = { id: 'a-vn', name: 'Cửa hàng', currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh', resultKind: null as string | null, syncedThrough: '2026-11-09' };
  const month = (account: string, from: number, to: number, spend: string) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({ adAccountId: account, day: `2026-11-${String(from + i).padStart(2, '0')}`, spend }));
  const input = (over: Partial<FlagInput>): FlagInput => ({ accounts: [vn], caps: [], accountDays: month('a-vn', 1, 9, '10000'), campaignDays: [], ...over });

  it('raises no pace flag and no day flag when no cap is set', () => {
    expect(evaluateFlags(input({}), now)).toEqual([]);
  });

  it('flags the pace of an account and of the org against their monthly caps, in decimal, the org first', () => {
    const flags = evaluateFlags(
      input({
        caps: [
          { scope: 'account', adAccountId: 'a-vn', period: 'monthly', amount: '250000', currency: 'VND' },
          { scope: 'org', adAccountId: null, period: 'monthly', amount: '280000', currency: 'VND' },
        ],
      }),
      now,
    );
    expect(flags).toEqual([
      { kind: 'pace', scope: 'org', adAccountId: null, accountName: null, currency: 'VND', skippedAccounts: 0, cap: '280000', spent: '90000', projected: '300000', elapsedDays: 9, daysInMonth: 30 },
      { kind: 'pace', scope: 'account', adAccountId: 'a-vn', accountName: 'Cửa hàng', currency: 'VND', skippedAccounts: 0, cap: '250000', spent: '90000', projected: '300000', elapsedDays: 9, daysInMonth: 30 },
    ]);
    // Exactly at the cap, or under it, raises none.
    expect(evaluateFlags(input({ caps: [{ scope: 'org', adAccountId: null, period: 'monthly', amount: '300000', currency: 'VND' }] }), now)).toEqual([]);
  });

  it('flags a day over its share: a daily cap is its own share, a monthly cap is spread over the month', () => {
    const daily = evaluateFlags(input({ caps: [{ scope: 'account', adAccountId: 'a-vn', period: 'daily', amount: '5000', currency: 'VND' }] }), now);
    expect(daily).toEqual([{ kind: 'day', scope: 'account', adAccountId: 'a-vn', accountName: 'Cửa hàng', currency: 'VND', skippedAccounts: 0, period: 'daily', cap: '5000', share: '5000', day: '2026-11-09', spend: '10000', ratio: '2.00' }]);
    // A monthly cap of 240 000 over 30 days is 8 000 a day: 10 000 is 1.25 times it, under the factor of 1.5.
    expect(evaluateFlags(input({ caps: [{ scope: 'org', adAccountId: null, period: 'monthly', amount: '240000', currency: 'VND' }] }), now).filter((f) => f.kind === 'day')).toEqual([]);
    expect(evaluateFlags(input({ caps: [{ scope: 'org', adAccountId: null, period: 'monthly', amount: '150000', currency: 'VND' }] }), now).filter((f) => f.kind === 'day')).toHaveLength(1);
  });

  it('judges each account on its own calendar: Los Angeles is still on the 9th, so its yesterday is the 8th', () => {
    const la = { id: 'a-la', name: 'Store', currency: 'USD', timeZone: 'America/Los_Angeles', resultKind: null, syncedThrough: '2026-11-08' };
    const flags = evaluateFlags(
      {
        accounts: [la],
        caps: [{ scope: 'account', adAccountId: 'a-la', period: 'daily', amount: '100.00', currency: 'USD' }],
        accountDays: [...month('a-la', 1, 7, '50.00'), { adAccountId: 'a-la', day: '2026-11-08', spend: '160.00' }, { adAccountId: 'a-la', day: '2026-11-09', spend: '999.00' }],
        campaignDays: [],
      },
      now,
    );
    // 160.00 on the 8th against a 100.00 day is 1.60 times it; the 9th (today there) is not counted.
    expect(flags).toEqual([{ kind: 'day', scope: 'account', adAccountId: 'a-la', accountName: 'Store', currency: 'USD', skippedAccounts: 0, period: 'daily', cap: '100.00', share: '100.00', day: '2026-11-08', spend: '160.00', ratio: '1.60' }]);
  });

  it('never compares or adds amounts of different currencies, and skips an account that has not read yesterday', () => {
    const usd = { id: 'a-us', name: 'USD account', currency: 'USD', timeZone: 'Asia/Ho_Chi_Minh', resultKind: null, syncedThrough: '2026-11-09' };
    const behind = { id: 'a-late', name: 'Behind', currency: 'VND', timeZone: 'Asia/Ho_Chi_Minh', resultKind: null, syncedThrough: '2026-11-08' };
    const flags = evaluateFlags(
      {
        accounts: [vn, usd, behind],
        caps: [{ scope: 'org', adAccountId: null, period: 'monthly', amount: '280000', currency: 'VND' }],
        accountDays: [...month('a-vn', 1, 9, '10000'), ...month('a-us', 1, 9, '5000'), ...month('a-late', 1, 8, '99999')],
        campaignDays: [],
      },
      now,
    );
    // Only the VND account that has read yesterday counts: 300 000 projected, not more.
    // One account of the cap's currency was not judged (it has not read yesterday): the flag says so.
    expect(flags).toEqual([{ kind: 'pace', scope: 'org', adAccountId: null, accountName: null, currency: 'VND', skippedAccounts: 1, cap: '280000', spent: '90000', projected: '300000', elapsedDays: 9, daysInMonth: 30 }]);
    // A cap in another currency than the account's is not compared.
    expect(evaluateFlags(input({ caps: [{ scope: 'account', adAccountId: 'a-vn', period: 'monthly', amount: '10', currency: 'USD' }] }), now)).toEqual([]);
  });

  it('judges the pace only once enough days of the month are over, and not on the 1st', () => {
    const cap = [{ scope: 'org' as const, adAccountId: null, period: 'monthly' as const, amount: '1', currency: 'VND' }];
    const paceFlags = (today: string, lastDay: number) =>
      evaluateFlags(input({ caps: cap, accountDays: month('a-vn', 1, lastDay, '10000'), accounts: [{ ...vn, syncedThrough: lastDay === 0 ? '2026-10-31' : `2026-11-${String(lastDay).padStart(2, '0')}` }] }), new Date(`${today}T05:00:00Z`)).filter(
        (f) => f.kind === 'pace',
      );
    // On the 3rd two days are over, under the minimum of 3: no pace flag; on the 4th three are. On the 1st nothing is over yet.
    expect(paceFlags('2026-11-03', 2)).toEqual([]);
    expect(paceFlags('2026-11-04', 3)).toHaveLength(1);
    expect(paceFlags('2026-11-01', 0)).toEqual([]);
  });

  it('flags a campaign whose cost per result jumped, from its own days, for an account that chose a result', () => {
    const account = { ...vn, resultKind: 'purchase' };
    const days = (campaign: string, name: string, from: number, to: number, spend: string, results: string | null) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({ adAccountId: 'a-vn', campaignId: campaign, campaignName: name, day: `2026-11-${String(from + i).padStart(2, '0')}`, spend, results }));
    const flags = evaluateFlags(
      input({
        accounts: [account],
        // History: the 1st to the 6th at 1 000 a result (6 days); the last 3 days (the 7th to the 9th) at 3 000 a result.
        campaignDays: [...days('c1', 'Chiến dịch A', 1, 6, '100000', '100'), ...days('c1', 'Chiến dịch A', 7, 9, '300000', '100'), ...days('c2', 'Chiến dịch B', 1, 9, '100000', '100')],
      }),
      now,
    );
    expect(flags).toEqual([
      { kind: 'cpr', adAccountId: 'a-vn', accountName: 'Cửa hàng', campaignId: 'c1', campaignName: 'Chiến dịch A', currency: 'VND', day: '2026-11-09', recentCost: '3000', medianCost: '1000', ratio: '3.00', recentResults: '300', historyDays: 6 },
    ]);
    // An account that chose no result has no cost per result to judge.
    expect(evaluateFlags(input({ accounts: [vn], campaignDays: days('c1', 'A', 7, 9, '300000', '100') }), now)).toEqual([]);
  });

  it('names a campaign by the latest name it carried, whatever the order the rows come in', () => {
    const account = { ...vn, resultKind: 'purchase' };
    const row = (name: string, day: number, spend: string) => ({ adAccountId: 'a-vn', campaignId: 'c1', campaignName: name, day: `2026-11-${String(day).padStart(2, '0')}`, spend, results: '100' });
    const rows = [...[1, 2, 3, 4, 5, 6].map((d) => row('Old name', d, '100000')), ...[7, 8, 9].map((d) => row('New name', d, '300000'))];
    const named = (campaignDays: typeof rows) => evaluateFlags(input({ accounts: [account], campaignDays }), now).map((f) => (f.kind === 'cpr' ? f.campaignName : null));
    expect(named(rows)).toEqual(['New name']);
    expect(named([...rows].reverse())).toEqual(['New name']);
  });

  it('gives the same flags for the same figures, whatever the order they come in', () => {
    const rows = month('a-vn', 1, 9, '10000');
    const caps = [{ scope: 'org' as const, adAccountId: null, period: 'monthly' as const, amount: '280000', currency: 'VND' }];
    expect(evaluateFlags(input({ caps, accountDays: [...rows].reverse() }), now)).toEqual(evaluateFlags(input({ caps, accountDays: rows }), now));
  });

  it('applies the org’s thresholds: a later start holds back the pace, a higher factor holds back a day, and an equal one does not flag', () => {
    const monthly = [{ scope: 'account' as const, adAccountId: 'a-vn', period: 'monthly' as const, amount: '250000', currency: 'VND' }];
    const daily = [{ scope: 'account' as const, adAccountId: 'a-vn', period: 'daily' as const, amount: '5000', currency: 'VND' }];
    const kinds = (caps: FlagInput['caps'], set: Parameters<typeof thresholdsFrom>[0]) => evaluateFlags(input({ caps }), now, thresholdsFrom(set)).map((f) => f.kind);
    expect(kinds(monthly, null)).toEqual(['pace']);
    // 9 days are over: a minimum of 9 still judges, a minimum of 10 does not.
    expect(kinds(monthly, { paceMinDays: 9 })).toEqual(['pace']);
    expect(kinds(monthly, { paceMinDays: 10 })).toEqual([]);
    // Yesterday spent 10 000 against a 5 000 share, exactly 2 times it: a factor of 2 does not flag it, 1.99 does.
    expect(kinds(daily, null)).toEqual(['day']);
    expect(kinds(daily, { dayFactor: '2' })).toEqual([]);
    expect(kinds(daily, { dayFactor: '1.99' })).toEqual(['day']);
    // A threshold that was never set is the default, and a set one touches no other.
    expect(kinds(daily, { dayFactor: null, paceMinDays: 10 })).toEqual(['day']);
  });
});

describe('the thresholds of an org', () => {
  it('is every default until the org sets one, and a set threshold replaces only its own default', () => {
    expect(thresholdsFrom(null)).toEqual(DEFAULT_FLAG_THRESHOLDS);
    expect(thresholdsFrom(undefined)).toEqual(DEFAULT_FLAG_THRESHOLDS);
    expect(thresholdsFrom({ paceMinDays: null, dayFactor: null, cprFactor: null, cprMinResults: null, cprMinHistoryDays: null })).toEqual(DEFAULT_FLAG_THRESHOLDS);
    expect(thresholdsFrom({ cprMinResults: 20, cprFactor: '2.5' })).toEqual({ ...DEFAULT_FLAG_THRESHOLDS, cprMinResults: 20, cprFactor: '2.5' });
  });
});

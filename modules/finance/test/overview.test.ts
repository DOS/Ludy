// SPDX-License-Identifier: AGPL-3.0-only
// The Tổng quan's rules (#2631) as pure functions: the periods the picker stands for and the one compared with each, the six months, a card's change, the
// expense mix and the overview built from entries. The books themselves are checked in apps/kernel/test/finance-overview.db.test.ts.
import { describe, expect, it } from 'vitest';
import { buildOverview, expenseMix, overviewFigure, overviewMonth, overviewMonths, overviewPeriods } from '../src/domain/overview.ts';
import type { ReportEntry } from '../src/domain/tt133-reports.ts';

const ENTITY = 'le-1';
const entry = (entryDate: string, lines: Array<[string, string, string]>, reversal = false): ReportEntry => ({
  legalEntityId: ENTITY,
  entryDate,
  currency: 'VND',
  reversal,
  lines: lines.map(([accountCode, debit, credit]) => ({ accountCode, partyId: null, debit, credit })),
});

describe('overviewPeriods', () => {
  const periods = (range: Parameters<typeof overviewPeriods>[0], today: string) => {
    const p = overviewPeriods(range, today);
    return [p.from, p.to, p.previousFrom, p.previousTo, p.comparison];
  };

  it('compares the last 30 days with the 30 days right before', () => {
    expect(periods('last_30_days', '2026-11-04')).toEqual(['2026-10-06', '2026-11-04', '2026-09-06', '2026-10-05', 'days']);
    expect(periods('last_30_days', '2028-03-01')).toEqual(['2028-02-01', '2028-03-01', '2028-01-02', '2028-01-31', 'days']);
  });

  it('compares this month so far with last month up to the same day number, kept inside last month', () => {
    expect(periods('this_month', '2026-11-04')).toEqual(['2026-11-01', '2026-11-04', '2026-10-01', '2026-10-04', 'month']);
    expect(periods('this_month', '2026-03-31')).toEqual(['2026-03-01', '2026-03-31', '2026-02-01', '2026-02-28', 'month']);
    expect(periods('this_month', '2028-03-31')).toEqual(['2028-03-01', '2028-03-31', '2028-02-01', '2028-02-29', 'month']);
    expect(periods('this_month', '2028-03-29')).toEqual(['2028-03-01', '2028-03-29', '2028-02-01', '2028-02-29', 'month']);
    expect(periods('this_month', '2026-05-31')).toEqual(['2026-05-01', '2026-05-31', '2026-04-01', '2026-04-30', 'month']);
    expect(periods('this_month', '2027-01-15')).toEqual(['2027-01-01', '2027-01-15', '2026-12-01', '2026-12-15', 'month']);
    expect(periods('this_month', '2026-03-01')).toEqual(['2026-03-01', '2026-03-01', '2026-02-01', '2026-02-01', 'month']);
  });

  it('takes last month whole, against the month before it, across a year end and in a leap year', () => {
    expect(periods('last_month', '2026-11-04')).toEqual(['2026-10-01', '2026-10-31', '2026-09-01', '2026-09-30', 'month']);
    expect(periods('last_month', '2027-01-15')).toEqual(['2026-12-01', '2026-12-31', '2026-11-01', '2026-11-30', 'month']);
    expect(periods('last_month', '2026-02-10')).toEqual(['2026-01-01', '2026-01-31', '2025-12-01', '2025-12-31', 'month']);
    expect(periods('last_month', '2028-03-02')).toEqual(['2028-02-01', '2028-02-29', '2028-01-01', '2028-01-31', 'month']);
    expect(periods('last_month', '2028-04-02')).toEqual(['2028-03-01', '2028-03-31', '2028-02-01', '2028-02-29', 'month']);
  });

  it('compares this quarter so far with the previous quarter for the same number of days, kept inside it', () => {
    expect(periods('this_quarter', '2026-11-04')).toEqual(['2026-10-01', '2026-11-04', '2026-07-01', '2026-08-04', 'quarter']);
    expect(periods('this_quarter', '2026-10-01')).toEqual(['2026-10-01', '2026-10-01', '2026-07-01', '2026-07-01', 'quarter']);
    expect(periods('this_quarter', '2026-02-15')).toEqual(['2026-01-01', '2026-02-15', '2025-10-01', '2025-11-15', 'quarter']);
    // The last day of Q2 is day 91, and Q1 has 90 days (91 in a leap year): the comparison stops at the end of Q1.
    expect(periods('this_quarter', '2026-06-30')).toEqual(['2026-04-01', '2026-06-30', '2026-01-01', '2026-03-31', 'quarter']);
    expect(periods('this_quarter', '2028-06-30')).toEqual(['2028-04-01', '2028-06-30', '2028-01-01', '2028-03-31', 'quarter']);
    expect(periods('this_quarter', '2026-12-31')).toEqual(['2026-10-01', '2026-12-31', '2026-07-01', '2026-09-30', 'quarter']);
  });

  it('compares this year so far with the same dates of last year, 29 February included', () => {
    expect(periods('this_year', '2026-11-04')).toEqual(['2026-01-01', '2026-11-04', '2025-01-01', '2025-11-04', 'year']);
    expect(periods('this_year', '2028-02-29')).toEqual(['2028-01-01', '2028-02-29', '2027-01-01', '2027-02-28', 'year']);
    expect(periods('this_year', '2029-02-28')).toEqual(['2029-01-01', '2029-02-28', '2028-01-01', '2028-02-28', 'year']);
    expect(periods('this_year', '2026-01-01')).toEqual(['2026-01-01', '2026-01-01', '2025-01-01', '2025-01-01', 'year']);
  });
});

describe('overviewMonths', () => {
  it('lists the six months ending with the month of the date, across a year end', () => {
    expect(overviewMonths('2026-11-04').map((m) => m.month)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    expect(overviewMonths('2027-02-10').map((m) => m.month)).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02']);
    expect(overviewMonths('2028-02-10').at(-1)).toEqual({ month: '2028-02', from: '2028-02-01', to: '2028-02-29' });
  });
});

describe('overviewFigure', () => {
  it('gives the change and its percent of the earlier size, to one decimal', () => {
    expect(overviewFigure('150', '100')).toEqual({ amount: '150', previous: '100', change: '50', changePercent: '50.0' });
    expect(overviewFigure('1', '3')).toEqual({ amount: '1', previous: '3', change: '-2', changePercent: '-66.7' });
  });

  it('measures a change against the size of a negative earlier figure, and has no percent against 0', () => {
    expect(overviewFigure('-50', '-100')).toEqual({ amount: '-50', previous: '-100', change: '50', changePercent: '50.0' });
    expect(overviewFigure('10', '0')).toEqual({ amount: '10', previous: '0', change: '10', changePercent: null });
    expect(overviewFigure('0', '0')).toEqual({ amount: '0', previous: '0', change: '0', changePercent: null });
  });

  it('shows a change too small for one decimal as 0.0, never -0.0', () => {
    expect(overviewFigure('999999', '1000000').changePercent).toBe('0.0');
    expect(overviewFigure('1000000.1', '1000000').changePercent).toBe('0.0');
  });

  it('does no arithmetic on JS numbers: a 16-digit amount keeps every digit', () => {
    expect(overviewFigure('9007199254740993', '9007199254740991')).toMatchObject({ change: '2' });
  });
});

describe('expenseMix', () => {
  const now = [
    entry('2026-10-10', [['632', '300', '0'], ['331', '0', '300']]),
    entry('2026-10-11', [['642', '100', '0'], ['331', '0', '100']]),
    entry('2026-10-12', [['641', '600', '0'], ['331', '0', '600']]),
  ];
  const before = [entry('2026-09-10', [['811', '50', '0'], ['331', '0', '50']]), entry('2026-09-11', [['642', '80', '0'], ['331', '0', '80']])];

  it('lists the groups with an amount in either period, largest first, with their share of the period', () => {
    expect(expenseMix(now, before)).toEqual([
      { group: '641', amount: '600', previous: '0', percent: '60.0' },
      { group: '632', amount: '300', previous: '0', percent: '30.0' },
      { group: '642', amount: '100', previous: '80', percent: '10.0' },
      { group: '811', amount: '0', previous: '50', percent: '0.0' },
    ]);
  });

  it('counts a reversed cost as lowered, and leaves a group with nothing out', () => {
    const reversed = [...now, entry('2026-10-13', [['331', '600', '0'], ['641', '0', '600']], true)];
    expect(expenseMix(reversed, []).map((e) => [e.group, e.amount])).toEqual([
      ['632', '300'],
      ['642', '100'],
    ]);
    expect(expenseMix([], [])).toEqual([]);
  });
});

describe('buildOverview', () => {
  const periods = overviewPeriods('last_30_days', '2026-11-04');
  const months = overviewMonths(periods.to).map((m) => ({ ...m, entries: [] as ReportEntry[] }));
  const base = { range: 'last_30_days' as const, periods, legalEntityId: ENTITY, balancesNow: [], balancesBefore: [], resultsNow: [], resultsBefore: [], monthly: months, empty: false };

  it('reads cash on 111 and 112, receivables on 131 and payables on 331 at the period end, and the profit before tax for the period', () => {
    const balancesNow = [
      entry('2026-10-20', [['111', '100', '0'], ['112', '400', '0'], ['4111', '0', '500']]),
      entry('2026-10-21', [['131', '700', '0'], ['5111', '0', '700']]),
      entry('2026-10-22', [['6422', '200', '0'], ['331', '0', '200']]),
    ];
    const resultsNow = [entry('2026-10-21', [['5111', '0', '700']]), entry('2026-10-22', [['6422', '200', '0']]), entry('2026-10-23', [['811', '30', '0'], ['711', '0', '10']])];
    const view = buildOverview({ ...base, balancesNow, resultsNow });
    expect(view.cash).toMatchObject({ amount: '500', previous: '0', change: '500', changePercent: null });
    expect(view.receivables.amount).toBe('700');
    expect(view.payables.amount).toBe('200');
    // 700 revenue + 10 other income - 200 administrative - 30 other expenses.
    expect(view.profit.amount).toBe('480');
    expect(view.expenses.map((e) => e.group)).toEqual(['642', '811']);
  });

  it('keeps a customer who paid in advance out of the receivables and a vendor we overpaid out of the payables, as the statements do', () => {
    const line = (accountCode: string, partyId: string, debit: string, credit: string) => ({ accountCode, partyId, debit, credit });
    const balancesNow: ReportEntry[] = [
      { legalEntityId: ENTITY, entryDate: '2026-10-20', currency: 'VND', reversal: false, lines: [line('131', 'a', '100', '0'), line('131', 'b', '0', '40'), line('331', 'c', '0', '90'), line('331', 'd', '25', '0')] },
    ];
    const view = buildOverview({ ...base, balancesNow });
    expect(view.receivables.amount).toBe('100');
    expect(view.payables.amount).toBe('90');
  });

  it('gives each month its B02: revenue is net sales, financial and other income, and the costs are what the profit leaves of it', () => {
    const report = buildOverview({
      ...base,
      monthly: months.map((m, i) => (i === 4 ? { ...m, entries: [entry('2026-10-05', [['5111', '0', '1000'], ['515', '0', '50'], ['632', '600', '0'], ['6422', '100', '0']])] } : m)),
    });
    expect(report.months[4]).toEqual({ month: '2026-10', revenue: '1050', costs: '700', profit: '350' });
    expect(report.months[5]).toEqual({ month: '2026-11', revenue: '0', costs: '0', profit: '0' });
    expect(overviewMonth('2026-10', { lines: [], unmapped: [] })).toEqual({ month: '2026-10', revenue: '0', costs: '0', profit: '0' });
  });

  it('counts the balances of the period that no B02 line reads', () => {
    expect(buildOverview({ ...base, resultsNow: [entry('2026-10-21', [['8888', '5', '0']])] }).unmapped).toBe(1);
  });
});

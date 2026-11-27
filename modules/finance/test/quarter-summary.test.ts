// SPDX-License-Identifier: AGPL-3.0-only
// The quarter in plain words (#5183) as pure functions: the quarter maths, how a figure moved against a basis (exact decimals, the steady edge, first time, none), where the balances the income statement does not
// read belong (a TT99 entity's 521 and 641), the figure rows of the card, the period lock against the quarter and the overdue summary. The query that reads the books is tested on PostgreSQL in
// apps/kernel/test/finance-quarter-summary.db.test.ts.
import { describe, expect, it } from 'vitest';
import { money } from '@ludy/l10n-vn';
import {
  balanceColumn,
  basisThere,
  buildFigures,
  lastEndedQuarter,
  lockStateOf,
  overdueSummary,
  previousQuarterOf,
  quarterEnded,
  quarterOfDate,
  resultColumn,
  splitUnmapped,
  trendOf,
  type BalanceColumn,
  type ResultColumn,
} from '../src/domain/quarter-summary.ts';

const result = (revenue: string, otherIncome: string, costs: string, profit: string): ResultColumn => ({ revenue, otherIncome, costs, profit, includesUnmapped: false });
const balance = (cash: string, receivables: string, payables: string): BalanceColumn => ({ cash, receivables, payables });

describe('quarters', () => {
  it('finds the quarter of a day and the one before it, across the year', () => {
    expect(quarterOfDate('2026-03-31')).toBe('2026-Q1');
    expect(quarterOfDate('2026-04-01')).toBe('2026-Q2');
    expect(quarterOfDate('2026-11-27')).toBe('2026-Q4');
    expect(previousQuarterOf('2026-Q3')).toBe('2026-Q2');
    expect(previousQuarterOf('2026-Q1')).toBe('2025-Q4');
  });

  it('opens on the last quarter that has ended', () => {
    expect(lastEndedQuarter('2026-11-27')).toBe('2026-Q3');
    expect(lastEndedQuarter('2026-01-05')).toBe('2025-Q4');
  });

  it('has ended only the day after its last day', () => {
    expect(quarterEnded('2026-09-30', '2026-09-30')).toBe(false);
    expect(quarterEnded('2026-09-30', '2026-10-01')).toBe(true);
  });
});

describe('a basis that is there', () => {
  it('is there when the books begin on or before its last day, never when they have no entry or begin later', () => {
    expect(basisThere(null, '2026-06-30')).toBe(false);
    expect(basisThere('2026-05-10', '2026-06-30')).toBe(true);
    expect(basisThere('2026-05-10', '2026-05-10')).toBe(true);
    expect(basisThere('2026-05-10', '2026-05-09')).toBe(false);
  });
});

describe('how a figure moved', () => {
  it('says none without a basis, and when both are 0', () => {
    expect(trendOf('100', null)).toBe('none');
    expect(trendOf('0', '0')).toBe('none');
  });

  it('says first time when the basis is 0 and the figure is not', () => {
    expect(trendOf('5', '0')).toBe('first_time');
  });

  it('says fell, never first time, for a loss or an overdraft that comes from nothing', () => {
    expect(trendOf('-5', '0')).toBe('fell');
    expect(trendOf('-0.01', '0')).toBe('fell');
  });

  it('says steady inside the steady percent of the basis and rose or fell from it (exact decimals)', () => {
    expect(trendOf('104', '100')).toBe('steady');
    expect(trendOf('96', '100')).toBe('steady');
    expect(trendOf('105', '100')).toBe('rose');
    expect(trendOf('95', '100')).toBe('fell');
    expect(trendOf('104.99', '100')).toBe('steady');
    expect(trendOf('105.01', '100')).toBe('rose');
    expect(trendOf('0', '10')).toBe('fell');
  });

  it('reads a loss against the size of the earlier loss', () => {
    expect(trendOf('-50', '-100')).toBe('rose');
    expect(trendOf('-150', '-100')).toBe('fell');
    expect(trendOf('-98', '-100')).toBe('steady');
  });

  it('takes the steady percent as an argument', () => {
    expect(trendOf('108', '100', '10')).toBe('steady');
    expect(trendOf('110', '100', '10')).toBe('rose');
  });
});

describe('the balances the income statement does not read', () => {
  it('puts 521 against revenue, other class 6 and 8 balances in costs and other class 5 and 7 credits in other income', () => {
    const split = splitUnmapped([
      { accountCode: '521', amount: '5000000' },
      { accountCode: '6417', amount: '12000000' },
      { accountCode: '6271', amount: '-2000000' },
      { accountCode: '5121', amount: '-3000000' },
      { accountCode: '7121', amount: '-1000000' },
      { accountCode: '5199', amount: '0' },
    ]);
    expect(split.deductions.toFixed()).toBe('5000000');
    expect(split.costs.toFixed()).toBe('10000000');
    expect(split.income.toFixed()).toBe('4000000');
    expect(split.any).toBe(true);
  });

  it('says nothing is unmapped when the list is empty or every balance is 0', () => {
    expect(splitUnmapped([]).any).toBe(false);
    expect(splitUnmapped([{ accountCode: '641', amount: '0' }]).any).toBe(false);
  });
});

describe('the result figures of one period', () => {
  const lines = [
    ['10', '100'],
    ['11', '10'],
    ['21', '1'],
    ['22', '2'],
    ['24', '30'],
    ['31', '3'],
    ['32', '4'],
    ['50', '58'],
  ].map(([code, amount]) => ({ code: code as string, amount: amount as string }));

  it('is the income statement\'s own lines when nothing is unmapped: revenue + other income - costs = profit', () => {
    expect(resultColumn(lines, [])).toEqual({ revenue: '100', otherIncome: '4', costs: '46', profit: '58', includesUnmapped: false });
  });

  it('adds what the statement does not read where it belongs, and keeps revenue + other income - costs = profit', () => {
    const column = resultColumn(lines, [
      { accountCode: '521', amount: '5' },
      { accountCode: '6417', amount: '12' },
      { accountCode: '5121', amount: '-7' },
    ]);
    expect(column).toEqual({ revenue: '95', otherIncome: '11', costs: '58', profit: '48', includesUnmapped: true });
    expect(money(column.revenue).plus(column.otherIncome).minus(column.costs).toFixed()).toBe(column.profit);
  });

  it('counts nothing twice when production costs were closed to 154 and 632: a class 6 account that nets to 0 is not a cost of its own', () => {
    // 621, 622, 623 and 627 each had a debit and a closing credit of the same size (the unmapped list holds them with a net of 0), and 632 carries the cost through line 11.
    const column = resultColumn(
      [{ code: '10', amount: '100' }, { code: '11', amount: '32' }, { code: '50', amount: '68' }],
      [
        { accountCode: '621', amount: '0' },
        { accountCode: '622', amount: '0' },
        { accountCode: '6231', amount: '0' },
        { accountCode: '627', amount: '0' },
      ],
    );
    expect(column).toEqual({ revenue: '100', otherIncome: '0', costs: '32', profit: '68', includesUnmapped: false });
    // Only the part not yet closed is added: 5 still on 627 on top of the 32 already in 632.
    expect(resultColumn([{ code: '10', amount: '100' }, { code: '11', amount: '32' }, { code: '50', amount: '68' }], [{ accountCode: '621', amount: '0' }, { accountCode: '627', amount: '5' }])).toEqual({
      revenue: '100',
      otherIncome: '0',
      costs: '37',
      profit: '63',
      includesUnmapped: true,
    });
  });

  it('reads a period with no line as 0', () => {
    expect(resultColumn([], [])).toEqual({ revenue: '0', otherIncome: '0', costs: '0', profit: '0', includesUnmapped: false });
  });

  it('reads cash, receivables and payables from B01 lines 110, 131 and 311 only', () => {
    expect(balanceColumn([{ code: '110', amount: '5' }, { code: '131', amount: '6' }, { code: '311', amount: '7' }, { code: '200', amount: '99' }])).toEqual(balance('5', '6', '7'));
    expect(balanceColumn([])).toEqual(balance('0', '0', '0'));
  });
});

describe('the figure rows of the card', () => {
  it('gives the rows in the card\'s order with both comparisons, and the stock row only where stock is kept', () => {
    const figures = buildFigures({
      household: false,
      results: { now: result('100', '0', '40', '60'), previous: result('50', '0', '20', '30'), lastYear: null },
      balances: { now: balance('40', '210', '60'), previous: balance('0', '150', '20'), lastYear: null },
      stock: { now: '5', previous: null },
    });
    expect(figures.map((f) => f.key)).toEqual(['revenue', 'other_income', 'costs', 'profit', 'cash', 'receivables', 'payables', 'stock']);
    expect(figures[0]).toEqual({ key: 'revenue', amount: '100', previous: '50', lastYear: null, vsPrevious: 'rose', vsLastYear: 'none' });
    expect(figures[4]).toEqual({ key: 'cash', amount: '40', previous: '0', lastYear: null, vsPrevious: 'first_time', vsLastYear: 'none' });
    // The stock has no last-year basis and a previous quarter that is not there.
    expect(figures[7]).toEqual({ key: 'stock', amount: '5', previous: null, lastYear: null, vsPrevious: 'none', vsLastYear: 'none' });
    expect(buildFigures({ household: false, results: { now: result('1', '0', '0', '1'), previous: null, lastYear: null }, balances: { now: balance('0', '0', '0'), previous: null, lastYear: null }, stock: null }).some((f) => f.key === 'stock')).toBe(false);
  });

  it('leaves out the costs, other income and profit rows of a household that booked none, and keeps them once it books one', () => {
    const none = buildFigures({ household: true, results: { now: result('10', '0', '0', '10'), previous: result('6', '0', '0', '6'), lastYear: null }, balances: { now: balance('1', '0', '0'), previous: null, lastYear: null }, stock: null });
    expect(none.map((f) => f.key)).toEqual(['revenue', 'cash', 'receivables', 'payables']);
    const some = buildFigures({ household: true, results: { now: result('10', '0', '3', '7'), previous: null, lastYear: null }, balances: { now: balance('1', '0', '0'), previous: null, lastYear: null }, stock: null });
    expect(some.map((f) => f.key)).toEqual(['revenue', 'other_income', 'costs', 'profit', 'cash', 'receivables', 'payables']);
    // A company shows them whatever they are.
    const company = buildFigures({ household: false, results: { now: result('10', '0', '0', '10'), previous: null, lastYear: null }, balances: { now: balance('1', '0', '0'), previous: null, lastYear: null }, stock: null });
    expect(company.map((f) => f.key)).toContain('profit');
  });
});

describe('the period lock against the quarter', () => {
  it('is open before the quarter or with no lock, partly inside it, locked from its last day on', () => {
    expect(lockStateOf(null, '2026-07-01', '2026-09-30')).toBe('open');
    expect(lockStateOf('2026-06-30', '2026-07-01', '2026-09-30')).toBe('open');
    expect(lockStateOf('2026-07-31', '2026-07-01', '2026-09-30')).toBe('partly');
    expect(lockStateOf('2026-09-30', '2026-07-01', '2026-09-30')).toBe('locked');
    expect(lockStateOf('2026-12-31', '2026-07-01', '2026-09-30')).toBe('locked');
  });
});

describe('the overdue summary', () => {
  it('is empty with no overdue invoice, else the oldest due date, the total and the count', () => {
    expect(overdueSummary([])).toEqual({ oldestDueOn: null, amount: '0', count: 0 });
    expect(overdueSummary([{ dueDate: '2026-08-09', amountDue: '100' }, { dueDate: '2026-07-01', amountDue: '50.5' }])).toEqual({ oldestDueOn: '2026-07-01', amount: '150.5', count: 2 });
  });
});

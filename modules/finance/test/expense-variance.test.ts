// SPDX-License-Identifier: AGPL-3.0-only
// The expense variance rules (#4392) as pure functions: which accounts are expense lines under each regime, the line level, the thresholds at their edges, the basis rules when the books change chart, and the
// order and limit of the flagged lines. The books themselves are checked in apps/kernel/test/finance-expense-variance.db.test.ts (CI only).
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  averageOf,
  basisMonths,
  booksOnDate,
  buildExpenseVariance,
  compareTo,
  isExpenseAccount,
  monthBounds,
  sourceKindOf,
  varianceLineCode,
  type BooksRow,
  type MonthAmounts,
} from '../src/domain/expense-variance.ts';
import { Decimal } from '@ludy/l10n-vn';

const D = (v: string) => new Decimal(v);
const TT99_FROM_2026: BooksRow = { regime: 'tt99', chartVersion: '2026.1', effectiveFrom: '2026-01-01' };

// The month of the report is 2026-11: the month before is 2026-10, the average reads 2026-08, 2026-09 and 2026-10.
const month = (m: string, rows: Array<[string, string]>): MonthAmounts => ({ month: m, rows: rows.map(([accountCode, net]) => ({ accountCode, net })) });
const flat = (code: string, a: string, b: string, c: string, now: string): MonthAmounts[] => [month('2026-08', [[code, a]]), month('2026-09', [[code, b]]), month('2026-10', [[code, c]]), month('2026-11', [[code, now]])];

describe('which accounts are expense lines', () => {
  it('reads class 6 and the class 8 expense accounts only', () => {
    for (const code of ['632', '641', '6411', '6421', '64211', '635', '627', '811', '821', '8211']) expect(isExpenseAccount(code), code).toBe(true);
    for (const code of ['511', '5111', '515', '711', '911', '131', '331', '1561', '421', '8']) expect(isExpenseAccount(code), code).toBe(false);
  });

  it('keeps 4 digits for 64xx under TT133 (6421 selling, 6422 administration) and 3 digits under TT99', () => {
    expect(varianceLineCode('6411', 'tt133')).toBe('6411');
    expect(varianceLineCode('6421', 'tt133')).toBe('6421');
    expect(varianceLineCode('64211', 'tt133')).toBe('6421');
    expect(varianceLineCode('641', 'tt133')).toBe('641');
    expect(varianceLineCode('6411', 'tt99')).toBe('641');
    expect(varianceLineCode('6421', 'tt99')).toBe('642');
    expect(varianceLineCode('632', 'tt133')).toBe('632');
    expect(varianceLineCode('6321', 'tt99')).toBe('632');
    expect(varianceLineCode('811', 'tt99')).toBe('811');
    expect(varianceLineCode('8211', 'tt133')).toBe('821');
  });

  it('names what a voucher is from a closed list', () => {
    expect(sourceKindOf('finance.purchase_document')).toBe('invoice');
    expect(sourceKindOf('finance.cash_voucher')).toBe('cash_bank');
    expect(sourceKindOf('hr.payroll_run')).toBe('payroll');
    expect(sourceKindOf('hr.payroll_leave_entry')).toBe('payroll');
    expect(sourceKindOf('finance.journal_voucher')).toBe('manual');
    expect(sourceKindOf('anything.else')).toBe('other');
    expect(sourceKindOf('')).toBe('other');
  });
});

describe('months', () => {
  it('goes back across a year end and reads the bounds of a month', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-03', -3)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(basisMonths('2026-01')).toEqual({ previous: '2025-12', average: ['2025-10', '2025-11', '2025-12'] });
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthBounds('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('reads the books in force on a date, TT133 2026.1 when there is no row', () => {
    expect(booksOnDate([], '2026-11-30')).toEqual({ regime: 'tt133', version: '2026.1' });
    expect(booksOnDate([TT99_FROM_2026], '2025-12-31')).toEqual({ regime: 'tt133', version: '2026.1' });
    expect(booksOnDate([TT99_FROM_2026], '2026-01-01')).toEqual({ regime: 'tt99', version: '2026.1' });
    const later: BooksRow = { regime: 'tt133', chartVersion: '2027.1', effectiveFrom: '2027-01-01' };
    expect(booksOnDate([later, TT99_FROM_2026], '2027-06-30')).toEqual({ regime: 'tt133', version: '2027.1' });
  });
});

describe('thresholds', () => {
  it('flags only when both the amount and the percent are crossed, exactly at the edge', () => {
    // 5,000,000 more on a basis of 16,666,667 is 29.99999...%: not flagged; on 16,666,666 it is 30.00000...%: flagged.
    expect(compareTo(D('21666667'), D('16666667')).flagged).toBe(false);
    expect(compareTo(D('21666666'), D('16666666')).flagged).toBe(true);
    // Exactly 30% (and over the amount): flagged.
    expect(compareTo(D('26000000'), D('20000000')).flagged).toBe(true);
    expect(compareTo(D('25999999'), D('20000000')).flagged).toBe(false);
    // 1 dong under the amount, however large the percent.
    expect(compareTo(D('4999999'), D('0')).flagged).toBe(false);
    expect(compareTo(D('5000000'), D('0')).flagged).toBe(true);
    // A big amount that is under 30% of a big basis.
    expect(compareTo(D('110000000'), D('100000000')).flagged).toBe(false);
    expect(compareTo(D('130000000'), D('100000000')).flagged).toBe(true);
  });

  it('flags a fall as well and keeps the sign of the change', () => {
    const c = compareTo(D('10000000'), D('20000000'));
    expect(c).toEqual({ basis: '20000000', change: '-10000000', percent: '50.0', flagged: true });
  });

  it('has no percent against a basis of 0', () => {
    expect(compareTo(D('8000000'), D('0'))).toEqual({ basis: '0', change: '8000000', percent: null, flagged: true });
    expect(compareTo(D('0'), D('0'))).toEqual({ basis: '0', change: '0', percent: null, flagged: false });
  });

  it('judges the exact figures, not the percent that is shown', () => {
    // 29.995% shows as 30.0 but is under the threshold, though the amount (29,995,000) is far over 5,000,000.
    const c = compareTo(D('129995000'), D('100000000'));
    expect(c.percent).toBe('30.0');
    expect(c.flagged).toBe(false);
    expect(compareTo(D('130000000'), D('100000000')).flagged).toBe(true);
  });

  it('rounds the average half up to whole dong', () => {
    expect(averageOf([D('1'), D('1'), D('2')]).toFixed()).toBe('1');
    expect(averageOf([D('1'), D('2'), D('2')]).toFixed()).toBe('2');
    expect(averageOf([D('10'), D('10'), D('11')]).toFixed()).toBe('10');
    expect(averageOf([D('10'), D('11'), D('12.5')]).toFixed()).toBe('11');
    expect(averageOf([D('0'), D('0'), D('0')]).toFixed()).toBe('0');
  });
});

describe('buildExpenseVariance', () => {
  it('flags a line against the month before and shows both comparisons, on TT133', () => {
    const result = buildExpenseVariance('2026-11', flat('6421', '20000000', '20000000', '20000000', '30000000'), []);
    expect(result.regime).toBe('tt133');
    expect(result.missing).toEqual({ previous: false, average: false });
    expect(result.lines).toHaveLength(1);
    const [line] = result.lines;
    expect(line).toMatchObject({ code: '6421', amount: '30000000', direction: 'up', against: 'previous', isNew: false });
    expect(line?.previous).toEqual({ basis: '20000000', change: '10000000', percent: '50.0', flagged: true });
    expect(line?.average).toEqual({ basis: '20000000', change: '10000000', percent: '50.0', flagged: true });
  });

  it('flags against the average alone when the month before was itself high', () => {
    // 10M, 10M, 40M: the average is 20M; 28M is +8M (+40%) on the average but -12M (-30%) on the month before, which crosses both too; use 30M to make only the average cross.
    const result = buildExpenseVariance('2026-11', flat('632', '10000000', '10000000', '40000000', '30000000'), []);
    const [line] = result.lines;
    expect(line?.previous.flagged).toBe(false);
    expect(line?.average).toEqual({ basis: '20000000', change: '10000000', percent: '50.0', flagged: true });
    expect(line?.against).toBe('average');
    expect(line?.direction).toBe('up');
  });

  it('picks the basis with the larger change and keeps the previous month on a tie', () => {
    const tie = buildExpenseVariance('2026-11', flat('632', '20000000', '20000000', '20000000', '40000000'), []);
    expect(tie.lines[0]?.against).toBe('previous');
    const wider = buildExpenseVariance('2026-11', flat('632', '0', '0', '30000000', '60000000'), []);
    // the previous month: +30M (100%); the average: +50M (500%): the average has the larger change.
    expect(wider.lines[0]?.against).toBe('average');
    expect(wider.lines[0]?.average.change).toBe('50000000');
  });

  it('marks a cost that was not there before as new, and a cost that stopped as a fall', () => {
    const fresh = buildExpenseVariance('2026-11', [month('2026-08', []), month('2026-09', []), month('2026-10', []), month('2026-11', [['627', '9000000']])], []);
    expect(fresh.lines[0]).toMatchObject({ code: '627', direction: 'up', isNew: true });
    expect(fresh.lines[0]?.previous.percent).toBeNull();
    const stopped = buildExpenseVariance('2026-11', flat('641', '9000000', '9000000', '9000000', '0'), []);
    expect(stopped.lines[0]).toMatchObject({ code: '641', amount: '0', direction: 'down', isNew: false });
  });

  it('does not flag small or steady lines and ignores accounts that are not expenses', () => {
    const steady = buildExpenseVariance('2026-11', flat('632', '100000000', '100000000', '100000000', '104000000'), []);
    expect(steady.lines).toEqual([]);
    const revenue = buildExpenseVariance('2026-11', [month('2026-10', [['511', '50000000'], ['911', '90000000'], ['131', '70000000']]), month('2026-11', [['511', '900000000'], ['911', '0'], ['131', '0']])], []);
    expect(revenue.lines).toEqual([]);
  });

  it('sums the accounts that roll up to one line, and sets a credit against the line', () => {
    const rows = flat('64211', '10000000', '10000000', '10000000', '10000000');
    rows[3] = month('2026-11', [['6421', '30000000'], ['64211', '-3000000'], ['6422', '2000000']]);
    const result = buildExpenseVariance('2026-11', rows, []);
    // TT133: 6421 = 30M - 3M = 27M against... the earlier months booked on 64211, which rolls up to 6421 too: 10M each. 6422 is another line.
    const six421 = result.lines.find((l) => l.code === '6421');
    expect(six421?.amount).toBe('27000000');
    expect(six421?.previous.change).toBe('17000000');
    expect(result.lines.find((l) => l.code === '6422')).toBeUndefined();
  });

  it('on TT99 treats 641 and 642 as one line each', () => {
    const books = [TT99_FROM_2026];
    // The same postings under both regimes: selling expenses 6421 steady, administration 6422 up (TT133 accounts), and on TT99 the accounts 6417 (a 641 account) and 6421 (a 642 account).
    const rows = [
      month('2026-08', [['6421', '5000000'], ['6422', '5000000']]),
      month('2026-09', [['6421', '5000000'], ['6422', '5000000']]),
      month('2026-10', [['6421', '5000000'], ['6422', '5000000']]),
      month('2026-11', [['6421', '5000000'], ['6422', '14000000']]),
    ];
    // TT133: two lines, 6421 steady and 6422 up by 9M against 5M.
    const tt133 = buildExpenseVariance('2026-11', rows, []);
    expect(tt133.regime).toBe('tt133');
    expect(tt133.lines.map((l) => l.code)).toEqual(['6422']);
    expect(tt133.lines[0]).toMatchObject({ amount: '14000000', direction: 'up' });
    // TT99: both accounts are 642 (level-2 accounts of the administration line), one line of 19M against 10M.
    const tt99 = buildExpenseVariance('2026-11', rows, books);
    expect(tt99.regime).toBe('tt99');
    expect(tt99.lines.map((l) => l.code)).toEqual(['642']);
    expect(tt99.lines[0]).toMatchObject({ amount: '19000000', direction: 'up' });
    expect(tt99.lines[0]?.previous).toEqual({ basis: '10000000', change: '9000000', percent: '90.0', flagged: true });
    // 641 accounts of TT99 are their own line.
    const selling = buildExpenseVariance(
      '2026-11',
      [month('2026-08', [['6411', '5000000'], ['6417', '5000000']]), month('2026-09', [['6411', '5000000'], ['6417', '5000000']]), month('2026-10', [['6411', '5000000'], ['6417', '5000000']]), month('2026-11', [['6411', '5000000'], ['6417', '14000000']])],
      books,
    );
    expect(selling.lines.map((l) => l.code)).toEqual(['641']);
  });

  it('does not compare with months that are in another chart', () => {
    // TT99 from 2026-11-01: the month before and the average are TT133 months.
    const books: BooksRow[] = [{ regime: 'tt99', chartVersion: '2026.1', effectiveFrom: '2026-11-01' }];
    const result = buildExpenseVariance('2026-11', flat('641', '1000000', '1000000', '1000000', '90000000'), books);
    expect(result.regime).toBe('tt99');
    expect(result.missing).toEqual({ previous: true, average: true });
    expect(result.lines).toEqual([]);
  });

  it('compares with the months it can when only the average reaches into another chart', () => {
    // TT99 from 2026-10-01: the month before (2026-10) is in the chart, 2026-08 and 2026-09 are not, so only the average is missing.
    const books: BooksRow[] = [{ regime: 'tt99', chartVersion: '2026.1', effectiveFrom: '2026-10-01' }];
    const result = buildExpenseVariance('2026-11', flat('641', '1000000', '1000000', '10000000', '40000000'), books);
    expect(result.missing).toEqual({ previous: false, average: true });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]?.average).toEqual({ basis: null, change: null, percent: null, flagged: false });
    expect(result.lines[0]?.previous.flagged).toBe(true);
  });

  it('does not count a month before the first entry as 0: the comparison that needs it is not made', () => {
    // Books begin on 2026-09-10: 2026-08 ends before it, so the average (08, 09, 10) is missing, while the month before (10) is there.
    const rows = [month('2026-08', []), month('2026-09', [['632', '1000000']]), month('2026-10', [['632', '1000000']]), month('2026-11', [['632', '40000000']])];
    const young = buildExpenseVariance('2026-11', rows, [], '2026-09-10');
    expect(young.missing).toEqual({ previous: false, average: true });
    expect(young.lines).toHaveLength(1);
    expect(young.lines[0]?.average).toEqual({ basis: null, change: null, percent: null, flagged: false });
    expect(young.lines[0]?.previous.flagged).toBe(true);
    // The same months with the books beginning earlier: both comparisons are made, and the average flags too.
    const old = buildExpenseVariance('2026-11', rows, [], '2026-08-01');
    expect(old.missing).toEqual({ previous: false, average: false });
    expect(old.lines[0]?.average.flagged).toBe(true);
    // Books that begin in the month itself: nothing to compare with.
    const first = buildExpenseVariance('2026-11', rows, [], '2026-11-03');
    expect(first.missing).toEqual({ previous: true, average: true });
    expect(first.lines).toEqual([]);
    // A basis month that ENDS on the first entry's day is there; no entry at all changes nothing here.
    expect(buildExpenseVariance('2026-11', rows, [], '2026-10-31').missing).toEqual({ previous: false, average: true });
    expect(buildExpenseVariance('2026-11', rows, [], null).missing).toEqual({ previous: false, average: false });
  });

  it('orders by the larger change, then by code, and limits the lines', () => {
    const codes = ['621', '622', '623', '627', '631', '632', '635', '641', '642', '811', '821', '611'];
    const rows = [month('2026-08', []), month('2026-09', []), month('2026-10', []), month('2026-11', codes.map((c, i): [string, string] => [c, String(6000000 + i * 1000000)]))];
    const result = buildExpenseVariance('2026-11', rows, []);
    expect(result.lines).toHaveLength(10);
    expect(result.moreFlagged).toBe(2);
    expect(result.lines[0]?.code).toBe('611');
    const amounts = result.lines.map((l) => D(l.amount).toNumber());
    expect(amounts).toEqual(amounts.toSorted((a, b) => b - a));
    // Equal changes keep the order of the codes.
    const equal = buildExpenseVariance('2026-11', [month('2026-10', []), month('2026-11', [['635', '9000000'], ['632', '9000000']])], []);
    expect(equal.lines.map((l) => l.code)).toEqual(['632', '635']);
  });

  it('is exact on large amounts (decimal strings, no JS numbers)', () => {
    const big = '9007199254740993';
    const result = buildExpenseVariance('2026-11', flat('632', big, big, big, '18014398509481986'), []);
    expect(result.lines[0]?.previous.change).toBe(big);
    expect(result.lines[0]?.amount).toBe('18014398509481986');
  });
});

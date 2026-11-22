// SPDX-License-Identifier: AGPL-3.0-only
// Expense variance of the Kế toán overview (#4392) as pure functions: which accounts are expense lines under the entity's books, how a month's net amounts compare with the month before and with the
// average of the three months before it, and which lines are flagged. Money is decimal strings and decimal.js throughout, never JS numbers. The query (../expense-variance.ts) reads the amounts;
// nothing here reads or writes.
// - Expense accounts, both regimes: class 6 and the expense accounts of class 8 (811, 821). Revenue, income and the closing entries are the query's to leave out.
// - Line level, the key a line is compared under (an org's sub-account extends its parent's code, so it rolls up by prefix): TT133 keeps 4 digits for 64xx (its chart has 6421, selling expenses, and 6422,
//   administration, under 642) and 3 for every other account; TT99 keeps 3 everywhere (641 and 642 are one line each, whatever their level-2 accounts 6411 to 6418 and 6421 to 6428).
// - Flagged: the change against the month before, or against the average, is at least the amount AND the percent threshold (exact decimals, never the rounded percent). A basis of 0 has no percent: the
//   line is flagged on the amount alone and is `new` when it rose. A comparison whose months are not all in the chart of the month is not made at all (no translation between charts).
import { Decimal, type DecimalValue } from '@ludy/l10n-vn';
import {
  EXPENSE_VARIANCE_AVERAGE_MONTHS,
  EXPENSE_VARIANCE_MAX_LINES,
  EXPENSE_VARIANCE_MIN_AMOUNT,
  EXPENSE_VARIANCE_MIN_PERCENT,
  type ExpenseVarianceCompare,
  type ExpenseVarianceRegime,
  type ExpenseVarianceSourceKind,
} from '@ludy/kernel-contract';

/** An account the variance reads: class 6, and the class 8 expense accounts 811 (other expenses) and 821 (corporate income tax expense). */
export function isExpenseAccount(code: string): boolean {
  return /^6\d/.test(code) || /^(811|821)/.test(code);
}

/** The line an account code is compared under for the regime. */
export function varianceLineCode(code: string, regime: ExpenseVarianceRegime): string {
  if (regime === 'tt133' && /^64\d\d/.test(code)) return code.slice(0, 4);
  return code.slice(0, 3);
}

/** What a voucher is, from the source type the posting recorded: a closed list, never the typed memo. */
export function sourceKindOf(sourceType: string): ExpenseVarianceSourceKind {
  if (sourceType === 'finance.purchase_document') return 'invoice';
  if (sourceType === 'finance.cash_voucher') return 'cash_bank';
  if (sourceType.startsWith('hr.payroll')) return 'payroll';
  if (sourceType === 'finance.journal_voucher') return 'manual';
  return 'other';
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The month `delta` months from `month` ('YYYY-MM'; negative goes back). */
export function addMonths(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const index = year * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

/** First and last day of a month. */
export function monthBounds(month: string): { from: string; to: string } {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return { from: `${month}-01`, to: `${month}-${pad(new Date(Date.UTC(year, m, 0)).getUTCDate())}` };
}

/** The month before and the months of the average (oldest first), all before `month`. */
export function basisMonths(month: string): { previous: string; average: string[] } {
  const average = Array.from({ length: EXPENSE_VARIANCE_AVERAGE_MONTHS }, (_, i) => addMonths(month, i - EXPENSE_VARIANCE_AVERAGE_MONTHS));
  return { previous: addMonths(month, -1), average };
}

export interface BooksRow {
  regime: string;
  chartVersion: string;
  effectiveFrom: string;
}

/** The chart an entity keeps its books under on a date: the newest row that starts on or before it, TT133 2026.1 when there is none (the rule of the database's own check of a journal line). */
export function booksOnDate(rows: readonly BooksRow[], date: string): { regime: ExpenseVarianceRegime; version: string } {
  let best: BooksRow | null = null;
  for (const row of rows) if (row.effectiveFrom <= date && (best === null || row.effectiveFrom > best.effectiveFrom)) best = row;
  if (!best) return { regime: 'tt133', version: '2026.1' };
  return { regime: best.regime === 'tt99' ? 'tt99' : 'tt133', version: best.chartVersion };
}

const chartKey = (books: { regime: string; version: string }) => `${books.regime}@${books.version}`;

export interface MonthAmounts {
  month: string;
  // Net debit minus credit per account code of the month, as decimal strings (the query's rows; any account, the rule above picks the expense ones).
  rows: ReadonlyArray<{ accountCode: string; net: string }>;
}

export interface VarianceLine {
  code: string;
  amount: string;
  previous: ExpenseVarianceCompare;
  average: ExpenseVarianceCompare;
  direction: 'up' | 'down';
  against: 'previous' | 'average';
  isNew: boolean;
}

export interface VarianceResult {
  regime: ExpenseVarianceRegime;
  chartVersion: string;
  missing: { previous: boolean; average: boolean };
  lines: VarianceLine[];
  moreFlagged: number;
}

const ZERO = new Decimal(0);
// Whole dong text of an amount: canonical, no exponent, no negative zero.
const text = (value: DecimalValue): string => (value.isZero() ? '0' : value.toFixed());

/** The thresholds as decimals (one place, so the tests and the query read the same). */
export const THRESHOLD_AMOUNT = new Decimal(EXPENSE_VARIANCE_MIN_AMOUNT);
export const THRESHOLD_PERCENT = new Decimal(EXPENSE_VARIANCE_MIN_PERCENT);

/** The change of `amount` against `basis` and whether it crosses both thresholds. The test is exact: |change| * 100 >= percent * |basis|; the percent shown has one decimal. */
export function compareTo(amount: DecimalValue, basis: DecimalValue): ExpenseVarianceCompare & { change: string; basis: string } {
  const diff = amount.minus(basis);
  const size = diff.abs();
  const baseSize = basis.abs();
  const crossesAmount = size.greaterThanOrEqualTo(THRESHOLD_AMOUNT);
  const crossesPercent = baseSize.isZero() ? !size.isZero() : size.times(100).greaterThanOrEqualTo(THRESHOLD_PERCENT.times(baseSize));
  return {
    basis: text(basis),
    change: text(diff),
    percent: baseSize.isZero() ? null : size.dividedBy(baseSize).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1),
    flagged: crossesAmount && crossesPercent,
  };
}

const NONE: ExpenseVarianceCompare = { basis: null, change: null, percent: null, flagged: false };

/** The average of the months' amounts, rounded half up to whole dong. */
export function averageOf(amounts: readonly DecimalValue[]): DecimalValue {
  return amounts.reduce((sum, a) => sum.plus(a), ZERO).dividedBy(amounts.length).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}

/**
 * The flagged lines of `month` from the amounts of the month and of the months before it, and the entity's books rows.
 * `months` holds the month itself and every basis month the caller read (a missing month counts as having no rows).
 */
export function buildExpenseVariance(month: string, months: readonly MonthAmounts[], books: readonly BooksRow[]): VarianceResult {
  const basis = basisMonths(month);
  const here = booksOnDate(books, monthBounds(month).to);
  const hereKey = chartKey(here);
  const sameChart = (m: string) => chartKey(booksOnDate(books, monthBounds(m).to)) === hereKey;
  const missing = { previous: !sameChart(basis.previous), average: !basis.average.every(sameChart) };

  // Net amount per line and month.
  const perMonth = new Map<string, Map<string, DecimalValue>>();
  for (const m of months) {
    const lines = new Map<string, DecimalValue>();
    for (const row of m.rows) {
      if (!isExpenseAccount(row.accountCode)) continue;
      const line = varianceLineCode(row.accountCode, here.regime);
      lines.set(line, (lines.get(line) ?? ZERO).plus(row.net));
    }
    perMonth.set(m.month, lines);
  }
  const amountOf = (m: string, line: string): DecimalValue => perMonth.get(m)?.get(line) ?? ZERO;
  const codes = new Set<string>();
  for (const m of [month, ...(missing.previous ? [] : [basis.previous]), ...(missing.average ? [] : basis.average)]) for (const code of perMonth.get(m)?.keys() ?? []) codes.add(code);

  const flagged: Array<VarianceLine & { size: DecimalValue }> = [];
  for (const code of codes) {
    const amount = amountOf(month, code);
    const previous = missing.previous ? NONE : compareTo(amount, amountOf(basis.previous, code));
    const average = missing.average ? NONE : compareTo(amount, averageOf(basis.average.map((m) => amountOf(m, code))));
    if (!previous.flagged && !average.flagged) continue;
    // The basis whose change is larger decides the direction and what the contributors are measured against; the previous month wins a tie.
    const sizeOf = (c: ExpenseVarianceCompare) => (c.flagged && c.change !== null ? new Decimal(c.change).abs() : new Decimal(-1));
    const against = sizeOf(average).greaterThan(sizeOf(previous)) ? 'average' : 'previous';
    const chosen = against === 'average' ? average : previous;
    const change = new Decimal(chosen.change ?? '0');
    flagged.push({
      code,
      amount: text(amount),
      previous,
      average,
      direction: change.isNegative() ? 'down' : 'up',
      against,
      isNew: chosen.basis !== null && new Decimal(chosen.basis).isZero() && change.isPositive(),
      size: change.abs(),
    });
  }
  flagged.sort((a, b) => b.size.comparedTo(a.size) || a.code.localeCompare(b.code));
  return {
    regime: here.regime,
    chartVersion: here.version,
    missing,
    lines: flagged.slice(0, EXPENSE_VARIANCE_MAX_LINES).map(({ size: _size, ...line }) => line),
    moreFlagged: Math.max(0, flagged.length - EXPENSE_VARIANCE_MAX_LINES),
  };
}

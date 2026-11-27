// SPDX-License-Identifier: AGPL-3.0-only
// The quarter in plain words (#5183) as pure functions: how a figure moved against a basis, which balances the income statement (B02) does not read and where they belong, and the figure rows of the card. Money is
// decimal strings and decimal.js throughout, never JS numbers. The query (../quarter-summary.ts) reads the books; nothing here reads or writes.
// - Revenue, costs and profit are the income statement's own lines (B02: line 10, 11 + 22 + 24 + 32, 21 + 31, 50), read the way finance.statements.period and finance.overview read them. B02 is the TT133 map and reads
//   only 511, 632, 515, 635, 642, 711, 811 and 821 (#5187), so a TT99 entity's 641 (and 621, 622, 623, 627) and its 521 revenue deduction land in `unmapped`. The card does not drop them: a deduction on 521 lowers
//   revenue, any other class 6 or 8 balance is a cost, any other class 5 or 7 credit is other income, so revenue + other income - costs = profit holds and equals B02 line 50 whenever nothing is unmapped.
// - A comparison is made only against a basis that is there: a basis that ends before the entity's first entry is not 0, it is not there (`none`).
import { money, type DecimalValue } from '@ludy/l10n-vn';
import {
  QUARTER_SUMMARY_STEADY_PERCENT,
  type QuarterSummaryFigure,
  type QuarterSummaryRow,
  type QuarterTrend,
} from '@ludy/kernel-contract';
import { canonical } from './money.ts';
import type { ReportLine, UnmappedBalance } from './tt133-reports.ts';

/** The quarter ('YYYY-Qn') a day ('YYYY-MM-DD') is in. */
export function quarterOfDate(date: string): string {
  const month = Number(date.slice(5, 7));
  return `${date.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
}

/** The quarter right before `quarter`. */
export function previousQuarterOf(quarter: string): string {
  const year = Number(quarter.slice(0, 4));
  const n = Number(quarter.slice(6));
  return n > 1 ? `${year}-Q${n - 1}` : `${year - 1}-Q4`;
}

/** The last quarter that has ended on `today` (Vietnam day): the one before the quarter today is in. */
export const lastEndedQuarter = (today: string): string => previousQuarterOf(quarterOfDate(today));

/** Whether the quarter has ended on `today`: its last day is before today. */
export const quarterEnded = (to: string, today: string): boolean => to < today;

/** Whether a basis ending on `basisTo` is there: the entity's books begin on or before its last day. A basis that ends before the first entry is not 0, it is not there. */
export const basisThere = (booksStart: string | null, basisTo: string): boolean => booksStart !== null && booksStart <= basisTo;

/** How `current` moved against `basis`: none (no basis, or both 0), first_time (basis 0, figure not), steady (inside the steady percent of the basis), else rose or fell. Exact decimals, never the rounded percent. */
export function trendOf(current: string, basis: string | null, steadyPercent: string = QUARTER_SUMMARY_STEADY_PERCENT): QuarterTrend {
  if (basis === null) return 'none';
  const now = money(current);
  const before = money(basis);
  if (now.isZero() && before.isZero()) return 'none';
  if (before.isZero()) return 'first_time';
  const change = now.minus(before);
  if (change.abs().times(100).lessThan(before.abs().times(steadyPercent))) return 'steady';
  return change.greaterThan(0) ? 'rose' : 'fell';
}

export interface UnmappedSplit {
  // The net debit on 521 (revenue deductions): it lowers revenue.
  deductions: DecimalValue;
  // The net debit on any other class 6 or 8 account no B02 line reads: costs.
  costs: DecimalValue;
  // The net credit on any other class 5 or 7 account no B02 line reads: other income.
  income: DecimalValue;
  // Whether any balance was not read by a B02 line.
  any: boolean;
}

/** Where the balances B02 does not read belong. `amount` is debit minus credit, as buildB02 reports it. */
export function splitUnmapped(unmapped: ReadonlyArray<Pick<UnmappedBalance, 'accountCode' | 'amount'>>): UnmappedSplit {
  let deductions = money(0);
  let costs = money(0);
  let income = money(0);
  let any = false;
  for (const row of unmapped) {
    const net = money(row.amount);
    if (net.isZero()) continue;
    any = true;
    if (row.accountCode.startsWith('521')) deductions = deductions.plus(net);
    else if (/^[68]/.test(row.accountCode)) costs = costs.plus(net);
    else income = income.minus(net);
  }
  return { deductions, costs, income, any };
}

export interface ResultColumn {
  revenue: string;
  otherIncome: string;
  costs: string;
  profit: string;
  // Whether a balance outside B02's lines is in this column.
  includesUnmapped: boolean;
}

const lineOf = (lines: ReadonlyArray<Pick<ReportLine, 'code' | 'amount'>>, code: string): DecimalValue => money(lines.find((l) => l.code === code)?.amount ?? '0');

/** One period's result figures from its B02 lines and what B02 does not read. */
export function resultColumn(lines: ReadonlyArray<Pick<ReportLine, 'code' | 'amount'>>, unmapped: ReadonlyArray<Pick<UnmappedBalance, 'accountCode' | 'amount'>>): ResultColumn {
  const split = splitUnmapped(unmapped);
  const revenue = lineOf(lines, '10').minus(split.deductions);
  const otherIncome = lineOf(lines, '21').plus(lineOf(lines, '31')).plus(split.income);
  const costs = lineOf(lines, '11').plus(lineOf(lines, '22')).plus(lineOf(lines, '24')).plus(lineOf(lines, '32')).plus(split.costs);
  const profit = lineOf(lines, '50').minus(split.deductions).minus(split.costs).plus(split.income);
  return { revenue: canonical(revenue), otherIncome: canonical(otherIncome), costs: canonical(costs), profit: canonical(profit), includesUnmapped: split.any };
}

export interface BalanceColumn {
  cash: string;
  receivables: string;
  payables: string;
}

/** The balances of B01 lines 110, 131 and 311 at one day. */
export function balanceColumn(lines: ReadonlyArray<Pick<ReportLine, 'code' | 'amount'>>): BalanceColumn {
  return { cash: canonical(lineOf(lines, '110')), receivables: canonical(lineOf(lines, '131')), payables: canonical(lineOf(lines, '311')) };
}

export interface FigureInputs {
  household: boolean;
  results: { now: ResultColumn; previous: ResultColumn | null; lastYear: ResultColumn | null };
  balances: { now: BalanceColumn; previous: BalanceColumn | null; lastYear: BalanceColumn | null };
  // The stock value at the quarter's last month and at the previous quarter's; null when the entity keeps no stock. A previous of null means that basis is not there.
  stock: { now: string; previous: string | null } | null;
}

function figure(key: QuarterSummaryRow, amount: string, previous: string | null, lastYear: string | null): QuarterSummaryFigure {
  return { key, amount, previous, lastYear, vsPrevious: trendOf(amount, previous), vsLastYear: trendOf(amount, lastYear) };
}

const allZero = (values: ReadonlyArray<string | null>): boolean => values.every((v) => v === null || money(v).isZero());

/** The figure rows of the card, in the card's order. A household that booked no cost and no other income in the three periods has no costs, other income or profit row: its profit would only repeat its revenue. */
export function buildFigures(input: FigureInputs): QuarterSummaryFigure[] {
  const { results: r, balances: b } = input;
  const row = (key: QuarterSummaryRow, pick: (c: ResultColumn) => string) => figure(key, pick(r.now), r.previous ? pick(r.previous) : null, r.lastYear ? pick(r.lastYear) : null);
  const bal = (key: QuarterSummaryRow, pick: (c: BalanceColumn) => string) => figure(key, pick(b.now), b.previous ? pick(b.previous) : null, b.lastYear ? pick(b.lastYear) : null);
  const costs = row('costs', (c) => c.costs);
  const otherIncome = row('other_income', (c) => c.otherIncome);
  const quiet = input.household && allZero([costs.amount, costs.previous, costs.lastYear, otherIncome.amount, otherIncome.previous, otherIncome.lastYear]);
  const out: QuarterSummaryFigure[] = [row('revenue', (c) => c.revenue)];
  if (!quiet) out.push(otherIncome, costs, row('profit', (c) => c.profit));
  out.push(bal('cash', (c) => c.cash), bal('receivables', (c) => c.receivables), bal('payables', (c) => c.payables));
  if (input.stock) out.push({ ...figure('stock', input.stock.now, input.stock.previous, null), vsLastYear: 'none' });
  return out;
}

/** The period lock against the quarter: locked (through its last day), partly (inside it), open (before it or none). */
export function lockStateOf(lockedThrough: string | null, from: string, to: string): 'open' | 'partly' | 'locked' {
  if (lockedThrough === null || lockedThrough < from) return 'open';
  return lockedThrough >= to ? 'locked' : 'partly';
}

/** The oldest due date among overdue invoices and their total, from the rows the reminders loader gave. */
export function overdueSummary(rows: ReadonlyArray<{ dueDate: string; amountDue: string | DecimalValue }>): { oldestDueOn: string | null; amount: string; count: number } {
  let oldest: string | null = null;
  let total = money(0);
  for (const r of rows) {
    if (oldest === null || r.dueDate < oldest) oldest = r.dueDate;
    total = total.plus(typeof r.amountDue === 'string' ? money(r.amountDue) : r.amountDue);
  }
  return { oldestDueOn: oldest, amount: canonical(total), count: rows.length };
}

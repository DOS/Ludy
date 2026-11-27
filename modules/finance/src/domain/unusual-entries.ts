// SPDX-License-Identifier: AGPL-3.0-only
// The pure parts of the monthly review of unusual posted entries (#5182): the windows each rule reads, the holiday dates of the month, the account patterns the rules share with the SQL, and how a row of the
// query becomes a hit. Money is decimal strings and decimal.js throughout, never JS numbers. The rules themselves run in SQL (../unusual-entries.ts), ranked and capped there; nothing here reads or writes.
//
// How this differs from the expense variance (#4392) on purpose: a hit asks "is this entry worth a second look", and a cancelled pair is not. So an entry that has a reversal and a reversal entry itself are
// both left out of the candidates AND of every history, whatever their dates, while #4392 only drops a pair when both sides fall inside its window (a reversal of an older entry still moved that month's
// balance, which is what a variance measures). Entries with a line on the closing account 911 are left out of both, as there.
import { vietnamHolidays, UNUSUAL_HISTORY_MONTHS, UNUSUAL_NEW_ACCOUNT_MONTHS, type UnusualControlGroup } from '@ludy/kernel-contract';
import { Decimal } from '@ludy/l10n-vn';
import { addMonths, monthBounds, type BooksRow } from './expense-variance.ts';

// The control accounts (receivables 131, payables 331, input VAT 133, taxes payable 333, employee payables 334; the same numbers in TT133 and TT99), as a database pattern and as the group a prefix names.
export const CONTROL_ACCOUNT_PATTERN = '^(131|331|133|333|334)';
// The accounts the amount and new-account rules leave out: the control accounts (a payable leg would repeat the cost leg), cash and bank (111, 112: every entry touches them) and the closing account.
export const NOT_GROUPED_PATTERN = '^(131|331|133|333|334|111|112|911)';
const CONTROL_GROUPS: Readonly<Record<string, UnusualControlGroup>> = { '131': 'receivable', '331': 'payable', '133': 'input_vat', '333': 'tax', '334': 'employee' };

/** The control group of an account code, or null for any other account. */
export function controlGroupOf(code: string): UnusualControlGroup | null {
  return CONTROL_GROUPS[code.slice(0, 3)] ?? null;
}

const laterOf = (a: string, b: string): string => (a >= b ? a : b);

/** The day the entity's current chart began (the newest books row that starts on or before the date), or the earliest day when it has no row (TT133 from the start). TT133 and TT99 codes do not translate, so no history before it is read. */
export function chartStart(rows: readonly BooksRow[], date: string): string {
  let best: string | null = null;
  for (const row of rows) if (row.effectiveFrom <= date && (best === null || row.effectiveFrom > best)) best = row.effectiveFrom;
  return best ?? '1900-01-01';
}

export interface ReviewWindow {
  /** First and last day of the reviewed month. */
  from: string;
  to: string;
  /** First day the amount history is read from: the start of the 6 months before the month, or the chart's start when later. */
  historyFrom: string;
  /** First day the new-account history is read from: the start of the 24 months before the month, or the chart's start when later (it is also the first day the query reads at all). */
  newAccountFrom: string;
}

/** The days each part of the query reads, from the month and the day its chart began. */
export function reviewWindow(month: string, chartFrom: string): ReviewWindow {
  const bounds = monthBounds(month);
  return {
    from: bounds.from,
    to: bounds.to,
    historyFrom: laterOf(monthBounds(addMonths(month, -UNUSUAL_HISTORY_MONTHS)).from, chartFrom),
    newAccountFrom: laterOf(monthBounds(addMonths(month, -UNUSUAL_NEW_ACCOUNT_MONTHS)).from, chartFrom),
  };
}

/** The public holidays of the shared calendar (#4387) that fall in the month, as ISO dates. Moved days off are not in the calendar and years past its lunar table carry only the fixed holidays. */
export function holidaysIn(month: string): string[] {
  const year = Number(month.slice(0, 4));
  return vietnamHolidays(year)
    .map((h) => h.date)
    .filter((date) => date.startsWith(`${month}-`));
}

/** How many times `usual` an amount is, one decimal (half up). Null when there is no usual amount above 0. */
export function ratioText(amount: string, usual: string): string | null {
  const base = new Decimal(usual);
  if (!base.isFinite() || base.lessThanOrEqualTo(0)) return null;
  return new Decimal(amount).dividedBy(base).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);
}

/** Whole dong text of an amount from the database: canonical, no exponent, no negative zero. */
export function moneyText(value: string | null): string | null {
  if (value === null) return null;
  const d = new Decimal(value);
  return d.isZero() ? '0' : d.toFixed();
}

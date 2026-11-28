// SPDX-License-Identifier: AGPL-3.0-only
// The year-end checklist (finance.year_end) as pure functions: the bounds of the year, the due date of each return from the tax calendar's own rules, and the checklist built from what the
// reads gave. The reads are in ../year-end.ts; nothing here touches the database, so every rule below has a plain unit test. No money is read anywhere in the checklist: every item is a state
// or a count, and no date reaches the coworker (the card shows each due date, from here).
import {
  YEAR_END_ITEMS,
  onOrAfterWorkingDay,
  taxDues,
  type TaxObligation,
  type YearEnd,
  type YearEndItem,
  type YearEndKey,
} from '@ludy/kernel-contract';
import { money } from '@ludy/l10n-vn';
import { monthAmount, type ScheduledAsset } from './depreciation.ts';

export const yearStart = (year: number): string => `${year}-01-01`;
export const yearLast = (year: number): string => `${year}-12-31`;

/** True when the year has ended on `today` (the database's day, in Vietnam). */
export const yearOver = (year: number, today: string): boolean => today > yearLast(year);

// The company returns of the year and the tax calendar obligation each one is marked done under (the Overview's due list marks it).
export const RETURN_OBLIGATION = { statements: 'financial_statements', cit: 'cit_finalization', pit: 'pit_finalization' } as const satisfies Partial<Record<YearEndKey, TaxObligation>>;

// The due date and the last day of the period of a return of the year, from TAX_RULES (Decree 252/2026/NĐ-CP Art. 10(5), Law 88/2015/QH13 Art. 29(3) and the circulars it names there), after the day-off rule
// (Art. 3(7)). A fiscal year is named by the calendar year it ends in, so `year` names the fiscal year that ends in it. null when the rules have no such period.
export function returnDue(obligation: TaxObligation, year: number, fiscalYearEndMonth: number): { due: string; periodEnd: string } | null {
  const dues = taxDues({ obligations: [obligation], vatFilingPeriod: null, pitFilingPeriod: null, fiscalYearEndMonth }, yearStart(year - 1), yearLast(year + 2));
  const found = dues.find((d) => d.obligation === obligation && d.period === String(year));
  return found ? { due: found.dueDate, periodEnd: found.periodEnd } : null;
}

// The 01/CNKD of the fourth quarter is due on the last day of January after the year (Decree 68/2026/NĐ-CP Art. 8(3)(a), the quarter's first month after it), after the day-off rule.
export const householdFourthQuarterDue = (year: number): string => onOrAfterWorkingDay(`${year + 1}-01-31`);

// The asset months of the year, through the last month that has ended on `today`, that the schedule says to post (a month amount above zero, as the depreciation voucher itself reads it) and that
// have no depreciation line. `posted` holds "<asset id>|<YYYY-MM-01>" for every line of the year. A month that has not ended is not asked for yet.
export function openAssetMonths(assets: ReadonlyArray<ScheduledAsset & { id: string }>, posted: ReadonlySet<string>, year: number, today: string): number {
  let open = 0;
  for (let m = 1; m <= 12; m += 1) {
    const month = `${year}-${String(m).padStart(2, '0')}-01`;
    const next = m === 12 ? `${year + 1}-01-01` : `${year}-${String(m + 1).padStart(2, '0')}-01`;
    if (next > today) break;
    for (const asset of assets) {
      if (money(monthAmount(asset, month)).isZero() || posted.has(`${asset.id}|${month}`)) continue;
      open += 1;
    }
  }
  return open;
}

// What the reads found.
export interface YearEndReads {
  // The entity is a household business (its books are the household's, with no closing to 911, no company return).
  household: boolean;
  // The 131 and 331 parties on the side that is not the account's own, and the 3387 and 141 accounts with a balance, at the year's last day.
  balances: number;
  // Asset months of the year (through the last month that has ended) with no depreciation line, or null when the entity keeps no fixed asset or prepaid cost.
  assetMonthsOpen: number | null;
  // The entity keeps stock, and a confirmed count dated in December of the year exists.
  stockKept: boolean;
  stockCounted: boolean;
  // A closing entry of the year is in force.
  closed: boolean;
  lockedThrough: string | null;
  // The org's tax calendar: the obligations it turned on, the last month of its fiscal year, and which of them are marked done for the year.
  tax: { obligations: readonly TaxObligation[]; fiscalYearEndMonth: number; marked: ReadonlySet<TaxObligation> };
  // A household whose profile on the year's last day files the 01/CNKD by percentage, and whether the fourth quarter was prepared (an export of it was recorded).
  householdReturn: { required: boolean; prepared: boolean };
  // The entity has an e-invoice connection, and a series whose symbol carries the next year.
  einvoice: { connected: boolean; nextYearSeries: boolean };
}

const item = (key: YearEndKey, state: YearEndItem['state'], waiting: boolean, count: number, due: string | null = null): YearEndItem => ({ key, state, waiting, count, due });
const na = (key: YearEndKey) => item(key, 'na', false, 0);
// An item that is one thing: done, or open (and waiting when the year has not ended).
const one = (key: YearEndKey, done: boolean, waiting: boolean, due: string | null = null): YearEndItem => (done ? item(key, 'done', false, 0, due) : item(key, 'open', waiting, 1, due));

export function buildYearEnd(legalEntityId: string, year: number, today: string, reads: YearEndReads): YearEnd {
  const over = yearOver(year, today);
  const rows: Record<YearEndKey, YearEndItem> = {
    balances: reads.balances > 0 ? item('balances', 'open', false, reads.balances) : item('balances', 'done', false, 0),
    depreciation:
      reads.assetMonthsOpen === null
        ? na('depreciation')
        : reads.assetMonthsOpen > 0
          ? item('depreciation', 'open', false, reads.assetMonthsOpen)
          : // Every month that has ended is posted; December is still to come while the year runs.
            over
            ? item('depreciation', 'done', false, 0)
            : item('depreciation', 'open', true, 0),
    stock_count: reads.stockKept ? one('stock_count', reads.stockCounted, !over) : na('stock_count'),
    closing_entry: reads.household ? na('closing_entry') : one('closing_entry', reads.closed, !over),
    months_locked: one('months_locked', reads.lockedThrough !== null && reads.lockedThrough >= yearLast(year), !over),
    statements: na('statements'),
    cit: na('cit'),
    pit: na('pit'),
    household_return: na('household_return'),
    einvoice_series: reads.einvoice.connected ? one('einvoice_series', reads.einvoice.nextYearSeries, false) : na('einvoice_series'),
  };
  if (!reads.household) {
    for (const key of ['statements', 'cit', 'pit'] as const) {
      const obligation = RETURN_OBLIGATION[key];
      if (!reads.tax.obligations.includes(obligation)) continue;
      const when = returnDue(obligation, year, reads.tax.fiscalYearEndMonth);
      // A return cannot be filed before its period has ended.
      rows[key] = one(key, reads.tax.marked.has(obligation), when === null ? !over : today <= when.periodEnd, when?.due ?? null);
    }
  } else if (reads.householdReturn.required) {
    rows.household_return = one('household_return', reads.householdReturn.prepared, !over, householdFourthQuarterDue(year));
  }
  return { year, legalEntityId, over, items: YEAR_END_ITEMS.map((key) => rows[key]) };
}

/** The keys of the open items that are not waiting (the ones a person can do now), in the fixed order. */
export const readyKeys = (checklist: Pick<YearEnd, 'items'>): YearEndKey[] => checklist.items.filter((i) => i.state === 'open' && !i.waiting).map((i) => i.key);

// SPDX-License-Identifier: AGPL-3.0-only
// What an entity's books switch to Circular 99 looks like today (issue #1403, slice B1): the books in force, a choice for a year to come, why a switch is not offered, and the first 1 January it can start
// from. Pure, so it is tested without a database; books-regime.ts reads the facts and ludy_finance.set_books_regime() enforces the same rules, and is the one that cannot be skipped.
import type { BooksBlocker, BooksRegimeEntity } from '@ludy/kernel-contract';

// Circular 99 applies to fiscal years starting on or after this date (Art. 31(1)).
export const TT99_FIRST_YEAR_START = '2026-01-01';

export interface BooksRow {
  regime: string;
  chartVersion: string;
  effectiveFrom: string;
}

export interface OpeningEntry {
  id: string;
  entryDate: string;
  // Whether a reversal of it exists. Reversing it does not free the next 1 January: the reversal is dated on the opening's own date and counts under the same books row.
  reversed: boolean;
}

export interface SwitchFacts {
  today: string;
  fiscalYearEndMonth: number;
  rows: readonly BooksRow[];
  // The latest date of an entry that is not an opening entry (an opening entry's reversal included), or null.
  lastOrdinaryDate: string | null;
  openingEntries: readonly OpeningEntry[];
}

export type SwitchState = Pick<BooksRegimeEntity, 'regime' | 'chartVersion' | 'since' | 'scheduled' | 'nextSwitchDate' | 'blockers'>;

// The calendar day after a local date.
const dayAfter = (date: string) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)) + 1)).toISOString().slice(0, 10);
const isJanuaryFirst = (date: string) => date.slice(5) === '01-01';

// The date that picks the chart of an entry: an opening entry is under the chart of the day after it.
export const openingChartDate = (entry: OpeningEntry) => dayAfter(entry.entryDate);

// The first 1 January, not before 2026, after a date (the guard refuses an entry on or after the start of a row).
function firstJanuaryAfter(date: string | null): string {
  const year = date === null ? 0 : Number(date.slice(0, 4)) + 1;
  return `${Math.max(2026, year)}-01-01`;
}

export function switchState(facts: SwitchFacts): SwitchState {
  const rows = [...facts.rows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const inForce = [...rows].reverse().find((r) => r.effectiveFrom <= facts.today);
  const regime = inForce?.regime ?? 'tt133';
  const chartVersion = inForce?.chartVersion ?? '2026.1';
  const since = inForce?.effectiveFrom ?? null;
  const tt99 = rows.find((r) => r.regime === 'tt99');
  // Every entry counts under a date: its own, except an opening entry, which counts a day later.
  const openingDates = facts.openingEntries.map(openingChartDate);
  const lastCounted = [facts.lastOrdinaryDate, ...openingDates].filter((d): d is string => d !== null).sort().at(-1) ?? null;
  const scheduledRow = rows.find((r) => r.regime === 'tt99' && r.effectiveFrom > facts.today);
  const scheduled = scheduledRow ? { effectiveFrom: scheduledRow.effectiveFrom, cancellable: lastCounted === null || lastCounted < scheduledRow.effectiveFrom } : null;
  const blockers: BooksBlocker[] = [];
  if (facts.fiscalYearEndMonth !== 12) blockers.push({ code: 'FISCAL_YEAR_UNSUPPORTED', fiscalYearEndMonth: facts.fiscalYearEndMonth });
  if (tt99) blockers.push({ code: 'ALREADY_TT99', effectiveFrom: tt99.effectiveFrom });
  if (blockers.length > 0) return { regime, chartVersion, since, scheduled, nextSwitchDate: null, blockers };
  const nextSwitchDate = firstJanuaryAfter(lastCounted);
  if (lastCounted !== null && lastCounted >= TT99_FIRST_YEAR_START) {
    blockers.push({ code: 'ENTRIES_ON_OR_AFTER', lastEntryDate: lastCounted, nextSwitchDate });
  }
  // An opening entry dated the day before a 1 January that no other entry reaches: the one thing that keeps that year from being chosen.
  const blocking = facts.openingEntries
    .filter((o) => isJanuaryFirst(openingChartDate(o)) && openingChartDate(o) >= TT99_FIRST_YEAR_START && (facts.lastOrdinaryDate === null || facts.lastOrdinaryDate < openingChartDate(o)))
    .sort((a, b) => a.entryDate.localeCompare(b.entryDate))[0];
  if (blocking) {
    blockers.push({ code: 'OPENING_ENTRY_BLOCKS', entryId: blocking.id, entryDate: blocking.entryDate, reversed: blocking.reversed, nextSwitchDate });
  }
  return { regime, chartVersion, since, scheduled, nextSwitchDate, blockers };
}

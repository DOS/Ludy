// SPDX-License-Identifier: AGPL-3.0-only
// The VAT rate card of marketplace sales in Settings (#4303 S3a): what the screen works out from the rows the API returns. The server decides every rule (order, locked periods, all-or-none rows); these only
// choose what to offer. A rate is data the person confirms, so the suggested schedule is applied only by one explicit click and never on its own.
import type { MarketplaceVatRateRow } from '@ludy/kernel-contract';

// The schedule the law sets today, offered once for an entity with no row yet (Resolution 204/2025/QH15: 8% for goods and services in 2026, back to 10% from 2027). It is a suggestion shown to a person, not a
// rule the posting reads: the posting reads only rows a person saved.
export const SUGGESTED_SCHEDULE: readonly MarketplaceVatRateRow[] = [
  { effectiveFrom: '2026-01-01', method: 'deduction', vatPercent: '8' },
  { effectiveFrom: '2027-01-01', method: 'deduction', vatPercent: '10' },
];

// The suggestion is offered only while the entity has no row, and writes nothing until the person has picked the method: `deduction` takes the schedule above, `none` takes one row with no rate from the
// first date (an entity off the deduction method has no output VAT line at any date). Without a method there is nothing to write.
export type SuggestMethod = MarketplaceVatRateRow['method'];
export const suggestedRows = (rows: readonly MarketplaceVatRateRow[], method: SuggestMethod | ''): readonly MarketplaceVatRateRow[] => {
  if (rows.length > 0 || method === '') return [];
  return method === 'deduction' ? SUGGESTED_SCHEDULE : [{ effectiveFrom: '2026-01-01', method: 'none', vatPercent: null }];
};
export const suggestionOffered = (rows: readonly MarketplaceVatRateRow[]): boolean => rows.length === 0;

// The schedule a person sees: of the entries the API returns (by date, then in the order entered), the latest entry of each date. An earlier entry of the same date was corrected and stays only as history.
export const currentSchedule = (entries: readonly MarketplaceVatRateRow[]): MarketplaceVatRateRow[] => {
  const byDate = new Map<string, MarketplaceVatRateRow>();
  for (const entry of entries) byDate.set(entry.effectiveFrom, entry);
  return [...byDate.values()].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
};

// The row in force on a date ("today" as YYYY-MM-DD): the greatest date that has begun and, among the entries of that date, the latest entered (the API's order), or null before the first.
export const rowInForce = (rows: readonly MarketplaceVatRateRow[], today: string): MarketplaceVatRateRow | null => {
  let found: MarketplaceVatRateRow | null = null;
  for (const row of rows) if (row.effectiveFrom <= today) found = row;
  return found;
};

export type DraftRow = { effectiveFrom: string; method: 'deduction' | 'none'; vatPercent: string };
export type DraftProblem = 'date' | 'rate';

const RATE = /^(100(\.0{1,2})?|[0-9]{1,2}(\.[0-9]{1,2})?)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// What is wrong with a row before it is sent, so the form says it in words first; the server checks the same again.
export const draftProblem = (draft: DraftRow): DraftProblem | null => {
  if (!DATE.test(draft.effectiveFrom) || draft.effectiveFrom < '2000-01-01') return 'date';
  if (draft.method === 'deduction' && !RATE.test(draft.vatPercent.trim())) return 'rate';
  return null;
};

export const draftToRow = (draft: DraftRow): MarketplaceVatRateRow => ({
  effectiveFrom: draft.effectiveFrom,
  method: draft.method,
  vatPercent: draft.method === 'deduction' ? draft.vatPercent.trim() : null,
});

// A rate as shown ("8.00" from the database reads as "8"): trailing zeros after the point are dropped.
export const showPercent = (percent: string): string => (percent.includes('.') ? percent.replace(/0+$/, '').replace(/\.$/, '') : percent);

// SPDX-License-Identifier: AGPL-3.0-only
// The year-end checklist on the Kế toán screen (#5283), the month-close checklist (finance-month-close.ts) extended to the year: for one legal entity and one calendar year, what a
// person still has to do before the year can be closed and its returns filed. Code computes every item's state by a read of the books (modules/finance/src/year-end.ts) and every
// due date from the tax calendar's rules (tax-calendar.ts, deadline-day.ts); the screen gives each item its fixed text and its link. The finance coworker may order the open items
// and say why in one short note, written from which items are open and nothing else (no count, no date, no name), so a figure it states can never be wrong: the note is refused when it
// holds a digit, a date, a link, a promise, a claim that something was done, advice to move money or a certainty. The checklist works with AI off, and a refused or missing note
// changes nothing in it. Read only.
import { z } from 'zod';
import { zId } from './schemas.ts';

// The items, in the fixed order the screen shows them when there is no ordering from the coworker: what a later step reads comes first, the lock after the closing entry (a locked
// December refuses it), then the returns, then the e-invoice series of the new year.
export const YEAR_END_ITEMS = ['balances', 'depreciation', 'stock_count', 'closing_entry', 'months_locked', 'statements', 'cit', 'pit', 'household_return', 'einvoice_series'] as const;
export const zYearEndKey = z.enum(YEAR_END_ITEMS);
export type YearEndKey = z.infer<typeof zYearEndKey>;

export const YEAR_END_STATES = ['done', 'open', 'na'] as const;
export const zYearEndState = z.enum(YEAR_END_STATES);
export type YearEndState = z.infer<typeof zYearEndState>;

// A calendar year, 2026.
export const zCloseYear = z.number().int().min(2000).max(2100);

export const zFinanceYearEndInput = z.object({ year: zCloseYear, legalEntityId: zId.optional() });
export type FinanceYearEndInput = z.infer<typeof zFinanceYearEndInput>;

// One item. state: done, open or na (does not apply to this entity or year). waiting: true while the year (the fiscal year, for a return) has not ended, so the item is open but cannot be
// finished yet; the card says "not yet" and the coworker is not told about it. count: how many things are open (parties and accounts to look at, asset months not posted); 1 for an open item that
// is one thing, 0 otherwise. due: the day the filing is due, by the tax calendar's rule (after the day-off rule), only on the items that have a legal date, else null; never given to the model.
export const zYearEndItem = z.object({
  key: zYearEndKey,
  state: zYearEndState,
  waiting: z.boolean(),
  count: z.number().int().nonnegative(),
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export type YearEndItem = z.infer<typeof zYearEndItem>;

// Every item once, in the fixed order. over: the year has ended on the database's day (Vietnam time).
export const zYearEnd = z.object({
  year: zCloseYear,
  legalEntityId: zId,
  over: z.boolean(),
  items: z.array(zYearEndItem).max(YEAR_END_ITEMS.length),
});
export type YearEnd = z.infer<typeof zYearEnd>;

// The coworker's note. ai: used (a note came back), off (the deployment has no model), busy (too many asks at once), budget (the org's AI budget of the month is spent), failed (the call
// failed or its answer was refused), quiet (no item is open and ready, so the model was not asked). Without text the screen shows the checklist in its fixed order. order: the keys of the open
// items that are not waiting, in the order to do them, an exact permutation of those, empty unless ai is used.
export const zFinanceYearEndExplainAsk = zFinanceYearEndInput.extend({ lang: z.enum(['vi', 'en']).optional() });
export type FinanceYearEndExplainAsk = z.infer<typeof zFinanceYearEndExplainAsk>;
export const zYearEndNote = z.object({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'quiet']),
  text: z.string().max(400).nullable(),
  order: z.array(zYearEndKey).max(YEAR_END_ITEMS.length),
});
export type YearEndNote = z.infer<typeof zYearEndNote>;

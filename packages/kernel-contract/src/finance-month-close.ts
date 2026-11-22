// SPDX-License-Identifier: AGPL-3.0-only
// The month-close checklist on the Kế toán screen: for one legal entity and one month, what a person still has to do before the books of the month can be
// locked. Code computes every item and its count by a read of the books (modules/finance/src/month-close.ts); the screen gives each item its fixed text and its
// link. The finance coworker may order the items and say why in one short note, written from which items are open and nothing else (no count, no date, no
// name), so a figure it states can never be wrong: the note is refused when it holds a digit, a date, a link, a promise or a claim that something was done.
// The checklist works with AI off, and a refused or missing note changes nothing in it. Read only.
import { z } from 'zod';
import { zId, zVatPeriod } from './schemas.ts';

// The items, in the fixed order the screen shows them when there is no ordering from the coworker (what the later steps read comes first, the lock last).
export const MONTH_CLOSE_ITEMS = ['proposals', 'invoices', 'bank', 'marketplace', 'stock', 'vat', 'lock'] as const;
export const zMonthCloseKey = z.enum(MONTH_CLOSE_ITEMS);
export type MonthCloseKey = z.infer<typeof zMonthCloseKey>;

// A calendar month, "2026-10".
export const zCloseMonth = z.string().regex(/^(20\d\d|2100)-(0[1-9]|1[0-2])$/);

export const zFinanceMonthCloseInput = z.object({ month: zCloseMonth, legalEntityId: zId.optional() });
export type FinanceMonthCloseInput = z.infer<typeof zFinanceMonthCloseInput>;

// One item: how many things are open (0 means done; the stock close, the VAT mark and the lock are 1 while open), and for the two items that read a VAT period the period
// the link opens (the tax-portal reconciliation's and the VAT working's), else null.
export const zMonthCloseItem = z.object({
  key: zMonthCloseKey,
  count: z.number().int().nonnegative(),
  period: zVatPeriod.nullable(),
});
export type MonthCloseItem = z.infer<typeof zMonthCloseItem>;

// The items that apply to this entity and month: the portal reconciliation only when a list was imported for it, the stock close only when the entity has stock moves
// up to the month and the month is over, the VAT mark only for the last month of the entity's filing period. At most one row per key.
export const zMonthClose = z.object({
  month: zCloseMonth,
  legalEntityId: zId,
  items: z.array(zMonthCloseItem).max(MONTH_CLOSE_ITEMS.length),
});
export type MonthClose = z.infer<typeof zMonthClose>;

// The coworker's note. ai: used (a note came back), off (the deployment has no model), busy (too many asks at once), budget (the org's AI budget of the month is
// spent), failed (the call failed or its answer was refused), quiet (every item is done, so the model was not asked). Without text the screen shows the checklist
// in its fixed order. order: the keys of the open items in the order to do them, an exact permutation of the open ones, empty unless ai is used.
export const zFinanceMonthCloseExplainAsk = zFinanceMonthCloseInput.extend({ lang: z.enum(['vi', 'en']).optional() });
export type FinanceMonthCloseExplainAsk = z.infer<typeof zFinanceMonthCloseExplainAsk>;
export const zMonthCloseNote = z.object({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'quiet']),
  text: z.string().max(400).nullable(),
  order: z.array(zMonthCloseKey).max(MONTH_CLOSE_ITEMS.length),
});
export type MonthCloseNote = z.infer<typeof zMonthCloseNote>;

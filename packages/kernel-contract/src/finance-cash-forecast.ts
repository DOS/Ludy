// SPDX-License-Identifier: AGPL-3.0-only
// The 30/60/90-day cash-flow forecast of the Kế toán app (#4391): where the booked cash of ONE legal entity is heading over the next 90 days, read only. The finance module decides every
// figure (modules/finance/src/domain/cash-forecast.ts); the screen shows them and the accounting coworker may phrase the low point. Amounts are decimal strings in the book currency (VND).
//
// What it counts, and how (the design is on #4391):
// - opening cash: 111 + 112 in the ledger on the as-of day (booked cash, so a bank line not yet booked is not in it);
// - receipts: the open sales invoices, each on its due date (the invoice date plus the payment terms, an estimate). Overdue invoices are NOT counted, they are shown apart;
// - payments: the open purchase invoices (the 331 balance laid over them), each on the invoice date plus PAYABLE_TERMS_DAYS (an estimate: a received invoice has no due date), an
//   overdue one on day 0, and the approved supplier payments on the first day the bank file may go;
// - NOT counted: payroll, social insurance, tax payments, rent, loans and any other recurring cost (CASH_FORECAST_NOT_INCLUDED); the tax due dates are markers with no amount.
import { z } from 'zod';
import { zId, zLocalDate, zMoney } from './schemas.ts';

export const CASH_FORECAST_DAYS = 90;
export const CASH_FORECAST_CHECKPOINTS = [30, 60, 90] as const;
// A received invoice carries no due date, so its payment is dated this many days after the invoice date, and the screen says it is an estimate.
export const PAYABLE_TERMS_DAYS = 30;
// The most customers and suppliers with a balance, and the most invoices, one forecast reads; past that the forecast is partial and says so (truncated).
export const CASH_FORECAST_PARTIES_MAX = 500;
export const CASH_FORECAST_DOCUMENTS_MAX = 10_000;
export const CASH_FORECAST_PAYMENTS_MAX = 1_000;
export const CASH_FORECAST_TOP_ITEMS = 5;

// What the forecast leaves out, always shown: the money these would move is not in the figures.
export const CASH_FORECAST_NOT_INCLUDED = ['payroll', 'insurance', 'tax', 'rent', 'loans', 'recurring'] as const;
export const zCashForecastNotIncluded = z.enum(CASH_FORECAST_NOT_INCLUDED);

// receipt: an open sales invoice on its due date. payable: an open purchase invoice on its estimated date (an overdue one on day 0). approved_payment: an approved supplier payment on the first
// day its bank file may go. unlinked_payable: the part of 331 no purchase invoice covers, on day 0.
export const CASH_FORECAST_ITEM_KINDS = ['receipt', 'payable', 'approved_payment', 'unlinked_payable'] as const;
export const zCashForecastItemKind = z.enum(CASH_FORECAST_ITEM_KINDS);
export type CashForecastItemKind = z.infer<typeof zCashForecastItemKind>;

// amount is positive; the kind says which way the money goes. Every date is derived (terms, the first day a file may go), none is stated by a document.
export const zCashForecastItem = z.object({
  kind: zCashForecastItemKind,
  date: zLocalDate,
  amount: zMoney,
  // For kind === 'payable': false when a purchase document carries a concrete due_date, true when falling back to +30 days (#4395).
  estimated: z.boolean().optional(),
});
export type CashForecastItem = z.infer<typeof zCashForecastItem>;

export const zCashForecastDay = z.object({ date: zLocalDate, balance: zMoney });
export type CashForecastDay = z.infer<typeof zCashForecastDay>;

// The balance at the end of day `days` (30, 60 or 90) and what came in and went out from day 0 up to it, both inclusive.
export const zCashForecastCheckpoint = z.object({ days: z.union([z.literal(30), z.literal(60), z.literal(90)]), date: zLocalDate, balance: zMoney, receipts: zMoney, payments: zMoney });
export type CashForecastCheckpoint = z.infer<typeof zCashForecastCheckpoint>;

// A tax due date of the horizon, with no amount (no tax amount is computed anywhere yet).
export const zCashForecastTaxMarker = z.object({ obligation: z.string().min(1).max(64), period: z.string().min(1).max(32), dueDate: zLocalDate });
export type CashForecastTaxMarker = z.infer<typeof zCashForecastTaxMarker>;

// asOf is day 0 (the database's today, in Vietnam, when left out); the screen leaves it out.
export const zFinanceCashForecastInput = z.object({ asOf: zLocalDate.optional(), legalEntityId: zId.optional() });
export type FinanceCashForecastInput = z.infer<typeof zFinanceCashForecastInput>;

export const zCashForecast = z.object({
  legalEntityId: zId,
  // Day 0 and the day the opening cash is booked up to.
  asOf: zLocalDate,
  openingCash: zMoney,
  // True while the entity's books hold no entry at all: the card is then not drawn (the overview points at the first steps instead).
  empty: z.boolean(),
  // Day 0 to day 90, one balance each, in date order (91 entries).
  series: z.array(zCashForecastDay).length(CASH_FORECAST_DAYS + 1),
  checkpoints: z.array(zCashForecastCheckpoint).length(CASH_FORECAST_CHECKPOINTS.length),
  // The lowest balance of the series and its day (the earliest day on a tie). Always shown, with or without the coworker's sentence.
  low: zCashForecastDay,
  // The largest items on or before the low day, largest first (at most CASH_FORECAST_TOP_ITEMS): what drives the low point. No party names.
  topItems: z.array(zCashForecastItem).max(CASH_FORECAST_TOP_ITEMS),
  // Sales invoices already past their due date (their amount left) and the part of 131 no invoice covers: neither is in the figures.
  overdueReceiptsNotCounted: zMoney,
  unlinkedReceivablesNotCounted: zMoney,
  payableTermsDays: z.literal(PAYABLE_TERMS_DAYS),
  // True when at least one counted payable fell back to invoice date + payableTermsDays; false when all counted payables carry a real due date (#4395).
  estimatedPayables: z.boolean().optional(),
  notIncluded: z.array(zCashForecastNotIncluded),
  taxMarkers: z.array(zCashForecastTaxMarker),
  // True when the entity has more customers, suppliers, invoices or approved payments than one forecast reads: the figures are then partial.
  truncated: z.boolean(),
});
export type CashForecast = z.infer<typeof zCashForecast>;

// The coworker's sentences on the low point. ai: used (text came back), off (the deployment has no model), busy (too many asks at once), budget (the org's AI budget of the month is spent),
// failed (the call failed or its text was refused), quiet (nothing in the 90 days to say). Without text the screen shows the figures alone.
export const zFinanceCashForecastExplainAsk = zFinanceCashForecastInput.extend({ lang: z.enum(['vi', 'en']).optional() });
export type FinanceCashForecastExplainAsk = z.infer<typeof zFinanceCashForecastExplainAsk>;
export const zCashForecastExplanation = z.object({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'quiet']),
  text: z.string().nullable(),
});
export type CashForecastExplanation = z.infer<typeof zCashForecastExplanation>;

// The items the owner enters into the forecast (#5326): the costs and receipts it cannot read from the books (rent, a loan, payroll, a one-off). One row per item of ONE legal entity, written by owners and admins
// (finance.cash_forecast.item_set and item_remove), read by every member with the forecast. The label is the owner's own words: it is shown to the owner, never written to an audit row and never sent to the model.
// category is what the forecast's "left out" line drops once an item of it is entered (loan drops "loans"; other drops "recurring costs" only when it repeats). direction says which way the money goes
// (the amount is above zero). recurrence: once (on the first date), monthly (the day of the first date each month, a short month on its last day) or quarterly (the same every third month); endDate, inclusive,
// only for a repeating item.
export const CASH_FORECAST_ENTERED_CATEGORIES = ['payroll', 'insurance', 'tax', 'rent', 'loan', 'other'] as const;
export const zCashForecastEnteredCategory = z.enum(CASH_FORECAST_ENTERED_CATEGORIES);
export type CashForecastEnteredCategory = z.infer<typeof zCashForecastEnteredCategory>;
export const CASH_FORECAST_ENTERED_DIRECTIONS = ['out', 'in'] as const;
export const zCashForecastEnteredDirection = z.enum(CASH_FORECAST_ENTERED_DIRECTIONS);
export type CashForecastEnteredDirection = z.infer<typeof zCashForecastEnteredDirection>;
export const CASH_FORECAST_ENTERED_RECURRENCES = ['once', 'monthly', 'quarterly'] as const;
export const zCashForecastEnteredRecurrence = z.enum(CASH_FORECAST_ENTERED_RECURRENCES);
export type CashForecastEnteredRecurrence = z.infer<typeof zCashForecastEnteredRecurrence>;
// At most this many items an entity (a bound on the work of every forecast read; the 101st is refused CASH_FORECAST_ITEM_LIMIT).
export const CASH_FORECAST_ITEMS_MAX = 100;
export const CASH_FORECAST_ITEM_LABEL_MAX = 80;
// The first and the end date of an item lie between these days (the table's own check).
export const CASH_FORECAST_ITEM_FIRST_DAY = '2000-01-01';
export const CASH_FORECAST_ITEM_LAST_DAY = '2100-12-31';

// Whole dong, above zero, at most 15 digits (the table allows up to 10^15).
const zItemAmount = z.string().regex(/^[1-9]\d{0,14}$/, 'whole dong above zero');
const zItemDate = zLocalDate.refine((d) => d >= CASH_FORECAST_ITEM_FIRST_DAY && d <= CASH_FORECAST_ITEM_LAST_DAY, 'between 2000-01-01 and 2100-12-31');
const zItemLabel = z
  .string()
  .trim()
  .min(1)
  .max(CASH_FORECAST_ITEM_LABEL_MAX)
  .refine((label) => !/\p{Cc}/u.test(label), 'no control characters');

// Creates an item (no id) or edits one (id); the entity is the org's default or the one the caller sees when left out, as for the forecast read. An edit keeps the item's entity.
export const zCashForecastItemSet = z
  .object({
    id: zId.optional(),
    legalEntityId: zId.optional(),
    label: zItemLabel,
    category: zCashForecastEnteredCategory,
    direction: zCashForecastEnteredDirection,
    amount: zItemAmount,
    firstDate: zItemDate,
    recurrence: zCashForecastEnteredRecurrence,
    endDate: zItemDate.nullable().optional(),
  })
  .superRefine((item, ctx) => {
    const end = item.endDate ?? null;
    if (end === null) return;
    if (item.recurrence === 'once') ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'a one-off item has no end date' });
    else if (end < item.firstDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'the end date is before the first date' });
  });
export type CashForecastItemSet = z.infer<typeof zCashForecastItemSet>;

export const zCashForecastItemRemove = z.object({ id: zId });
export type CashForecastItemRemove = z.infer<typeof zCashForecastItemRemove>;

// An item as the owner sees it: what they entered and its next occurrence on or after day 0 within the 91 days of the forecast (null when none falls in it: finished, or later than day 90).
export const zCashForecastItemView = z.object({
  id: zId,
  legalEntityId: zId,
  label: z.string(),
  category: zCashForecastEnteredCategory,
  direction: zCashForecastEnteredDirection,
  amount: zItemAmount,
  firstDate: zLocalDate,
  recurrence: zCashForecastEnteredRecurrence,
  endDate: zLocalDate.nullable(),
  nextDate: zLocalDate.nullable(),
});
export type CashForecastItemView = z.infer<typeof zCashForecastItemView>;

export const zCashForecastItems = z.object({
  legalEntityId: zId,
  // Day 0 the next dates are counted from.
  asOf: zLocalDate,
  // The items of the entity, the next occurrence first (those with none last), at most CASH_FORECAST_ITEMS_MAX.
  items: z.array(zCashForecastItemView).max(CASH_FORECAST_ITEMS_MAX),
  limit: z.literal(CASH_FORECAST_ITEMS_MAX),
});
export type CashForecastItems = z.infer<typeof zCashForecastItems>;

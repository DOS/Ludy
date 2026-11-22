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
export const zCashForecastItem = z.object({ kind: zCashForecastItemKind, date: zLocalDate, amount: zMoney });
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
  // True while the entity's books hold no entry at all: the screen then points at the first steps instead of a flat line.
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

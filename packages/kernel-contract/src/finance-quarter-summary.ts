// SPDX-License-Identifier: AGPL-3.0-only
// The quarter in plain words, on the Kế toán Tổng quan (#5183): for one legal entity and one quarter that has ended, the figures a small business owner asks for after a quarter (revenue, costs and profit
// against the previous quarter and the same quarter last year, cash at the start and the end, receivables and payables at the end and the oldest overdue, VAT or the household's tax, stock value where stock is kept).
// Code computes and shows every figure; the finance coworker only phrases three to five sentences from fixed labels (rose, fell, steady, first time, none), each tied to one figure row. Amounts are decimal
// strings in the book currency.
import { z } from 'zod';
import { zId, zLocalDate, zMoney } from './schemas.ts';

// A quarter of this century only, as the ledger writes it ('2026-Q3').
export const zQuarterSummaryQuarter = z.string().regex(/^20\d{2}-Q[1-4]$/, 'YYYY-Qn quarter');
export type QuarterSummaryQuarter = z.infer<typeof zQuarterSummaryQuarter>;

// A figure counts as steady when it moved by less than this many percent of its basis. One constant for every org (not a setting); the card states it.
export const QUARTER_SUMMARY_STEADY_PERCENT = '5';
// The quarters the picker offers, the last one that has ended first.
export const QUARTER_SUMMARY_PICKER_QUARTERS = 8;
// The sentences the coworker is asked for: at most this many (one per figure row), and a set is shown only when at least min(QUARTER_SUMMARY_MIN_NOTES, asked) of them stand.
export const QUARTER_SUMMARY_MAX_NOTES = 5;
export const QUARTER_SUMMARY_MIN_NOTES = 3;
// The overdue read is bounded like the cash forecast's: the largest balances first.
export const QUARTER_SUMMARY_PARTIES_MAX = 200;
export const QUARTER_SUMMARY_DOCUMENTS_MAX = 2000;

// The figure rows with an amount and a comparison, in the order the card shows them (and the order that breaks a tie when the coworker's rows are picked).
export const QUARTER_SUMMARY_ROWS = ['revenue', 'other_income', 'costs', 'profit', 'cash', 'receivables', 'payables', 'stock'] as const;
export const zQuarterSummaryRow = z.enum(QUARTER_SUMMARY_ROWS);
export type QuarterSummaryRow = z.infer<typeof zQuarterSummaryRow>;

// How a figure moved against a basis, decided by code from the exact amounts: rose, fell, steady (inside the steady percent), first_time (the basis is 0 and the figure is not), none (nothing to say: both are 0,
// or the basis is not there because the entity's books begin after it).
export const QUARTER_TRENDS = ['rose', 'fell', 'steady', 'first_time', 'none'] as const;
export const zQuarterTrend = z.enum(QUARTER_TRENDS);
export type QuarterTrend = z.infer<typeof zQuarterTrend>;

export const zFinanceQuarterSummaryInput = z.object({ quarter: zQuarterSummaryQuarter, legalEntityId: zId.optional() });
export type FinanceQuarterSummaryInput = z.infer<typeof zFinanceQuarterSummaryInput>;

// One figure row. amount: the quarter's own figure. previous and lastYear: the same figure for the previous quarter and for the same quarter last year (null: that basis is not there, see `trend`). For cash,
// receivables and payables `amount` is the balance at the quarter's last day, `previous` the balance at the previous quarter's last day (so for cash, `previous` is also the cash at the start of the quarter) and
// `lastYear` the balance at the last day of the same quarter last year. Stock has no last-year basis.
export const zQuarterSummaryFigure = z.object({
  key: zQuarterSummaryRow,
  amount: zMoney,
  previous: zMoney.nullable(),
  lastYear: zMoney.nullable(),
  vsPrevious: zQuarterTrend,
  vsLastYear: zQuarterTrend,
});
export type QuarterSummaryFigure = z.infer<typeof zQuarterSummaryFigure>;

export const zQuarterSummaryOverdue = z.object({
  // The oldest due date among the overdue sales invoices as at the quarter's last day (null: none overdue), their total, their count, and whether the read hit its bound (the figures are then partial).
  oldestDueOn: zLocalDate.nullable(),
  amount: zMoney,
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type QuarterSummaryOverdue = z.infer<typeof zQuarterSummaryOverdue>;

// A company's VAT working for the quarter, from the VAT screen's own read: the VAT on sales [35], the VAT on purchases [24] and their difference before any carry-forward (the accountant's), and whether the
// return of the quarter is marked as filed.
export const zQuarterSummaryVat = z.object({ output: zMoney, input: zMoney, difference: zMoney, filed: z.boolean() });
export type QuarterSummaryVat = z.infer<typeof zQuarterSummaryVat>;

// A household's tax for the quarter, from its 01/CNKD worksheet. ready: the worksheet has totals; held: revenue is not yet split by trade, so the tax waits; not_required: the household files no quarterly
// return for this quarter (a group that does not, the income method, a profile that changes inside the quarter). `commentary` is true while a row behind the figures is not confirmed by the accountant.
export const zQuarterSummaryHouseholdTax = z.object({
  state: z.enum(['ready', 'held', 'not_required']),
  tax: zMoney.nullable(),
  due: zMoney.nullable(),
  overpaid: zMoney.nullable(),
  commentary: z.boolean(),
});
export type QuarterSummaryHouseholdTax = z.infer<typeof zQuarterSummaryHouseholdTax>;

export const QUARTER_SUMMARY_LOCKS = ['open', 'partly', 'locked'] as const;

export const zFinanceQuarterSummary = z.object({
  quarter: zQuarterSummaryQuarter,
  from: zLocalDate,
  to: zLocalDate,
  legalEntityId: zId,
  kind: z.enum(['household', 'company']),
  // The books the entity keeps on the quarter's last day (TT133 when it has no books row).
  regime: z.enum(['tt133', 'tt99']),
  // The first day the entity's books hold an entry (null when none): a basis that ends before it is not 0, it is not there.
  booksStart: zLocalDate.nullable(),
  previousQuarter: zQuarterSummaryQuarter.nullable(),
  lastYearQuarter: zQuarterSummaryQuarter.nullable(),
  steadyPercent: z.string(),
  // True while the entity's books hold no entry at all up to the quarter's last day.
  empty: z.boolean(),
  // True when costs, deductions or income of the quarter or its bases come from accounts no line of the income statement (B02) reads, so profit here can differ from that report. The card says so in fixed words.
  includesUnmapped: z.boolean(),
  figures: z.array(zQuarterSummaryFigure),
  overdue: zQuarterSummaryOverdue,
  vat: zQuarterSummaryVat.nullable(),
  householdTax: zQuarterSummaryHouseholdTax.nullable(),
  // The stock value is provisional until the last month of the quarter is closed (the stock report's own rule); null when the entity keeps no stock.
  stockProvisional: z.boolean().nullable(),
  // The period lock: open (it does not reach the quarter), partly (it ends inside the quarter), locked (it reaches the quarter's last day).
  lock: z.object({ state: z.enum(QUARTER_SUMMARY_LOCKS), lockedThrough: zLocalDate.nullable() }),
});
export type FinanceQuarterSummary = z.infer<typeof zFinanceQuarterSummary>;

// The coworker's sentences. ai: used (enough sentences stand), off (no model), busy (too many calls), budget (the AI budget is spent), failed (the call failed or too few sentences were accepted), quiet (nothing to
// phrase). notes: by the figure row the sentence is about; a row with no sentence stands alone. The answer holds no figure.
export const zFinanceQuarterSummaryExplainAsk = zFinanceQuarterSummaryInput.extend({ lang: z.enum(['vi', 'en']).optional() });
export type FinanceQuarterSummaryExplainAsk = z.infer<typeof zFinanceQuarterSummaryExplainAsk>;
export const zQuarterSummaryExplanation = z.object({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'quiet']),
  notes: z.array(z.object({ row: zQuarterSummaryRow, text: z.string() })),
});
export type QuarterSummaryExplanation = z.infer<typeof zQuarterSummaryExplanation>;

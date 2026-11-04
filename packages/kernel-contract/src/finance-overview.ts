// SPDX-License-Identifier: AGPL-3.0-only
// The Tổng quan of the Kế toán app (#2631): the money picture of one legal entity for a period, against the period before. The finance module decides every
// figure (the four cards read the same B01 and B02 lines the statements do); the screen shows them. Amounts are decimal strings in the book currency.
import { z } from 'zod';
import { zId, zLocalDate, zMoney } from './schemas.ts';

// The period picker: the last 30 days (the default), this month, last month, this quarter and this year (the calendar year).
export const OVERVIEW_RANGES = ['last_30_days', 'this_month', 'last_month', 'this_quarter', 'this_year'] as const;
export const zOverviewRange = z.enum(OVERVIEW_RANGES);
export type OverviewRange = z.infer<typeof zOverviewRange>;

// The account groups the expense mix reads (B02's cost of goods sold, selling, administration, financial and other expenses), largest first on the screen.
export const OVERVIEW_EXPENSE_GROUPS = ['632', '641', '642', '635', '811'] as const;
export const zOverviewExpenseGroup = z.enum(OVERVIEW_EXPENSE_GROUPS);

// The months the results chart shows, ending with the month of the period's last day.
export const OVERVIEW_MONTHS = 6;

// asOf is the day the period is counted from (the database's today, in Vietnam, when left out); the screen leaves it out.
export const zFinanceOverviewInput = z.object({ range: zOverviewRange, asOf: zLocalDate.optional(), legalEntityId: zId.optional() });
export type FinanceOverviewInput = z.infer<typeof zFinanceOverviewInput>;

// One card: the figure now, the same figure for the period before, their difference and the difference in percent of the earlier figure's size (one
// decimal, null when the earlier figure is 0).
export const zOverviewFigure = z.object({ amount: zMoney, previous: zMoney, change: zMoney, changePercent: z.string().nullable() });
export type OverviewFigure = z.infer<typeof zOverviewFigure>;

export const zOverviewMonth = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), revenue: zMoney, costs: zMoney, profit: zMoney });
export type OverviewMonth = z.infer<typeof zOverviewMonth>;

// One group's cost in the period, in the period before and as a percent (one decimal) of the period's costs of the five groups; the mix shows the groups
// with an amount, and the coworker reads the ones that moved.
export const zOverviewExpense = z.object({ group: zOverviewExpenseGroup, amount: zMoney, previous: zMoney, percent: z.string() });
export type OverviewExpense = z.infer<typeof zOverviewExpense>;

export const zFinanceOverview = z.object({
  range: zOverviewRange,
  // The period and the one it is compared with, both inclusive.
  from: zLocalDate,
  to: zLocalDate,
  previousFrom: zLocalDate,
  previousTo: zLocalDate,
  // True while the entity's books hold no entry at all: the screen then points at the first steps instead of empty charts.
  empty: z.boolean(),
  // Cash 111 + 112 at the period's end (B01 line 110), profit before tax for the period (B02 line 50), receivables from customers (B01 line 131) and
  // payables to suppliers (B01 line 311).
  cash: zOverviewFigure,
  profit: zOverviewFigure,
  receivables: zOverviewFigure,
  payables: zOverviewFigure,
  months: z.array(zOverviewMonth).length(OVERVIEW_MONTHS),
  expenses: z.array(zOverviewExpense),
  // B02 balances of the period no line reads: the profit may then be incomplete (the statements screen lists them).
  unmapped: z.number().int().nonnegative(),
});
export type FinanceOverview = z.infer<typeof zFinanceOverview>;

// The coworker's sentence on the biggest change. ai: used (a sentence came back), off (the deployment has no model), busy (too many asks at once), budget (the
// org's AI budget of the month is spent), failed (the call failed or its text was refused), quiet (nothing changed enough to say). Without text the screen shows
// the figures alone.
// lang: the language of the sentence (the screen's own); Vietnamese when left out.
export const zFinanceOverviewExplainAsk = zFinanceOverviewInput.extend({ lang: z.enum(['vi', 'en']).optional() });
export type FinanceOverviewExplainAsk = z.infer<typeof zFinanceOverviewExplainAsk>;
export const zOverviewExplanation = z.object({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'quiet']),
  text: z.string().nullable(),
});
export type OverviewExplanation = z.infer<typeof zOverviewExplanation>;

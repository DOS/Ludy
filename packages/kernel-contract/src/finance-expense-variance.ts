// SPDX-License-Identifier: AGPL-3.0-only
// Expense variance of the Kế toán overview (#4392): for one legal entity and one ended month, each expense line against the month before and against the
// average of the three months before that month. Code finds the lines that moved (both the amount and the percent threshold below), the suppliers or vouchers
// behind them; the finance coworker only adds a possible reason per flagged line (a possibility, never a finding). Amounts are decimal strings in the book currency.
import { z } from 'zod';
import { zId, zLocalDate, zMoney } from './schemas.ts';

// The defaults, one pair for every org (a per-org setting is a later, separate change). A line is flagged when its change against the month before, or against
// the average, is at least BOTH: this many dong and this many percent of the basis.
export const EXPENSE_VARIANCE_MIN_AMOUNT = '5000000';
export const EXPENSE_VARIANCE_MIN_PERCENT = '30';
// The months before the month that make the average.
export const EXPENSE_VARIANCE_AVERAGE_MONTHS = 3;
// The flagged lines shown (largest change first), and the ones the coworker is given.
export const EXPENSE_VARIANCE_MAX_LINES = 10;
export const EXPENSE_VARIANCE_NOTE_LINES = 8;
// The suppliers or vouchers shown behind a flagged line.
export const EXPENSE_VARIANCE_CONTRIBUTORS = 3;
// The months the picker offers, the last one that has ended first.
export const EXPENSE_VARIANCE_PICKER_MONTHS = 12;

// A month of this century only (the database date range and the arithmetic stay far inside it).
export const zExpenseVarianceMonth = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/, 'YYYY-MM month');
export type ExpenseVarianceMonth = z.infer<typeof zExpenseVarianceMonth>;

// The books an entity keeps on the last day of the month (TT133 when it has no books row).
export const EXPENSE_VARIANCE_REGIMES = ['tt133', 'tt99'] as const;
export const zExpenseVarianceRegime = z.enum(EXPENSE_VARIANCE_REGIMES);
export type ExpenseVarianceRegime = z.infer<typeof zExpenseVarianceRegime>;

export const zFinanceExpenseVarianceInput = z.object({ month: zExpenseVarianceMonth, legalEntityId: zId.optional() });
export type FinanceExpenseVarianceInput = z.infer<typeof zFinanceExpenseVarianceInput>;

// What a voucher is, as a closed list (never its typed memo): a purchase or sales invoice, a cash or bank voucher, payroll, a manual journal voucher, or other.
export const EXPENSE_VARIANCE_SOURCE_KINDS = ['invoice', 'cash_bank', 'payroll', 'manual', 'other'] as const;
export const zExpenseVarianceSourceKind = z.enum(EXPENSE_VARIANCE_SOURCE_KINDS);
export type ExpenseVarianceSourceKind = z.infer<typeof zExpenseVarianceSourceKind>;

// One supplier (party) or, for postings with no party, one voucher behind a flagged line. `amount` is its net amount on the line in the month, `basis` the same
// for the basis that flagged the line (the month before, or the average of the three), `change` their difference; `vouchers` counts the vouchers in the month.
// A voucher's `description` is the member's own ledger text; it is shown, never sent to the model.
export const zExpenseVarianceContributor = z.object({
  kind: z.enum(['supplier', 'voucher']),
  partyId: zId.nullable(),
  name: z.string().nullable(),
  entryId: zId.nullable(),
  entryDate: zLocalDate.nullable(),
  description: z.string().nullable(),
  sourceKind: zExpenseVarianceSourceKind,
  vouchers: z.number().int().nonnegative(),
  amount: zMoney,
  basis: zMoney,
  change: zMoney,
});
export type ExpenseVarianceContributor = z.infer<typeof zExpenseVarianceContributor>;

// The change of a line against one basis. basis: the earlier figure (null when that comparison could not be made, see `missing`); percent: one decimal, the size of the
// change in percent of the basis, null when the basis is 0 (the line is then `new` when it is flagged) or there is no basis.
export const zExpenseVarianceCompare = z.object({
  basis: zMoney.nullable(),
  change: zMoney.nullable(),
  percent: z.string().nullable(),
  flagged: z.boolean(),
});
export type ExpenseVarianceCompare = z.infer<typeof zExpenseVarianceCompare>;

export const zExpenseVarianceLine = z.object({
  // The line's account code at the regime's level (4 digits for 64xx under TT133, 3 digits otherwise) and its name in the regime's chart.
  code: z.string(),
  name: z.string().nullable(),
  amount: zMoney,
  previous: zExpenseVarianceCompare,
  average: zExpenseVarianceCompare,
  direction: z.enum(['up', 'down']),
  // The basis whose change is larger (the one the contributors are measured against).
  against: z.enum(['previous', 'average']),
  // Basis 0 and flagged: a cost that was not there before.
  isNew: z.boolean(),
  vouchers: z.number().int().nonnegative(),
  contributors: z.array(zExpenseVarianceContributor).max(EXPENSE_VARIANCE_CONTRIBUTORS),
});
export type ExpenseVarianceLine = z.infer<typeof zExpenseVarianceLine>;

export const zFinanceExpenseVariance = z.object({
  month: zExpenseVarianceMonth,
  legalEntityId: zId,
  regime: zExpenseVarianceRegime,
  chartVersion: z.string(),
  thresholds: z.object({ amount: zMoney, percent: z.string() }),
  // The first day the entity's books hold an entry (null when none): a basis month that ends before it is not 0 but not there, so a comparison that needs it is not made (`missing`).
  booksStart: zLocalDate.nullable(),
  // The month before and the months of the average, as they were read; a comparison whose months are not all in the same chart, or not all after the books begin, is not made (`missing`).
  previousMonth: zExpenseVarianceMonth,
  averageMonths: z.array(zExpenseVarianceMonth).length(EXPENSE_VARIANCE_AVERAGE_MONTHS),
  missing: z.object({ previous: z.boolean(), average: z.boolean() }),
  // True while the entity's books hold no entry at all in the four months.
  empty: z.boolean(),
  // The flagged lines, largest change first, at most EXPENSE_VARIANCE_MAX_LINES; `moreFlagged` counts the ones past the limit.
  lines: z.array(zExpenseVarianceLine).max(EXPENSE_VARIANCE_MAX_LINES),
  moreFlagged: z.number().int().nonnegative(),
});
export type FinanceExpenseVariance = z.infer<typeof zFinanceExpenseVariance>;

// The coworker's possible reason per flagged line. ai: used (at least one note stands), off (no model), busy, budget, failed (the call failed or every note was refused),
// quiet (no line is flagged). notes: by the line's code; a line with no note stands alone. A note is a possibility, never a finding; the screen says so.
export const zFinanceExpenseVarianceExplainAsk = zFinanceExpenseVarianceInput.extend({ lang: z.enum(['vi', 'en']).optional() });
export type FinanceExpenseVarianceExplainAsk = z.infer<typeof zFinanceExpenseVarianceExplainAsk>;
export const zExpenseVarianceExplanation = z.object({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'quiet']),
  notes: z.array(z.object({ code: z.string(), text: z.string() })),
});
export type ExpenseVarianceExplanation = z.infer<typeof zExpenseVarianceExplanation>;

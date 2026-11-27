// SPDX-License-Identifier: AGPL-3.0-only
// "Ask the books in plain words" (#5181) on the Kế toán screen: the owner asks a question, the accounting coworker only chooses ONE entry of the closed catalogue below and a kind of period, and code does the rest. Every
// entry is backed by a read the Kế toán screens already use, run as the asking member (so that read's own role list, RLS and legal-entity scope answer, and its own refusal is the refusal); the card shows the figures the
// read gave, as decimal strings, with the period code resolved. Read only: nothing here writes.
//
// The catalogue (the same as @ludy/agent's ASK_BOOKS_ENTRIES, which the kernel checks it matches):
// - profit_loss      finance.statements.period, B02 lines 10, 11, 50 and 60, for a month, quarter or year
// - cash_balance     finance.statements.period, B01 line 110 (111 + 112) at the period's end
// - receivables_top  finance.ledger.period, the per-party closing balance of 131 at the period's end: the largest debit balances (what is owed), and the credit balances (prepaid by customers) as their own figure, never netted
// - payables_top     finance.ledger.period, the per-party closing balance of 331 at the period's end: the largest credit balances (what is owed), and the debit balances (advanced to suppliers) as their own figure, never netted
// - vat_position     finance.vat.period, the output and input VAT of a month or quarter
// - stock_value      finance.stock.report, the closing value of a month summed over the items
import { z } from 'zod';
import { zId, zLedgerPeriod, zLocalDate, zMoney } from './schemas.ts';

export const ASK_BOOKS_ENTRIES = ['profit_loss', 'cash_balance', 'receivables_top', 'payables_top', 'vat_position', 'stock_value'] as const;
export const zAskBooksEntry = z.enum(ASK_BOOKS_ENTRIES);
export type AskBooksEntry = z.infer<typeof zAskBooksEntry>;

export const ASK_BOOKS_PERIOD_KINDS = ['month', 'quarter', 'year'] as const;
export const zAskBooksPeriodKind = z.enum(ASK_BOOKS_PERIOD_KINDS);
export type AskBooksPeriodKind = z.infer<typeof zAskBooksPeriodKind>;

// The kinds of period each entry's read takes: VAT is filed by month or quarter, the stock report is a month's.
export const ASK_BOOKS_ALLOWED_KINDS: Record<AskBooksEntry, readonly AskBooksPeriodKind[]> = {
  profit_loss: ['month', 'quarter', 'year'],
  cash_balance: ['month', 'quarter', 'year'],
  receivables_top: ['month', 'quarter', 'year'],
  payables_top: ['month', 'quarter', 'year'],
  vat_position: ['month', 'quarter'],
  stock_value: ['month'],
};

// The most debtors or creditors the card lists.
export const ASK_BOOKS_TOP = 5;
export const ASK_BOOKS_QUESTION_MAX = 200;
// How far back the picker goes.
export const ASK_BOOKS_PICK_MONTHS = 12;
export const ASK_BOOKS_PICK_QUARTERS = 8;
export const ASK_BOOKS_PICK_YEARS = 3;

// The period words the coworker may name (and a chip may carry): never a date. 'as_of_today' is the month so far.
export const ASK_BOOKS_RELATIVE_TOKENS = ['this_month', 'last_month', 'this_quarter', 'last_quarter', 'this_year', 'last_year', 'as_of_today'] as const;
export const zAskBooksRelativeToken = z.enum(ASK_BOOKS_RELATIVE_TOKENS);
export type AskBooksRelativeToken = z.infer<typeof zAskBooksRelativeToken>;

// A report and period the owner chose on the card (a chip, or the picker): no model is asked.
export const zAskBooksPick = z.object({
  entry: zAskBooksEntry,
  period: z.union([z.object({ kind: z.literal('relative'), token: zAskBooksRelativeToken }), z.object({ kind: z.literal('period'), value: zLedgerPeriod })]),
});
export type AskBooksPick = z.infer<typeof zAskBooksPick>;

// Either a question typed in words, or a pick; never both. legalEntityId is the screen's entity, never the model's; lang the language of the sentence.
export const zFinanceAskBooksInput = z
  .object({
    question: z.string().min(1).max(ASK_BOOKS_QUESTION_MAX).optional(),
    pick: zAskBooksPick.optional(),
    legalEntityId: zId.optional(),
    lang: z.enum(['vi', 'en']).optional(),
  })
  .refine((v) => (v.question !== undefined) !== (v.pick !== undefined), 'ask a question or pick a report, not both');
export type FinanceAskBooksInput = z.infer<typeof zFinanceAskBooksInput>;

export const ASK_BOOKS_FIGURES = ['revenue', 'cost_of_goods', 'profit_before_tax', 'profit_after_tax', 'cash', 'total', 'vat_output', 'vat_input', 'vat_difference', 'vat_carry_forward', 'stock_value', 'advances'] as const;
export const zAskBooksFigureKey = z.enum(ASK_BOOKS_FIGURES);
export type AskBooksFigureKey = z.infer<typeof zAskBooksFigureKey>;

// provisional: the stock month is not closed for every item. sales_side_unavailable: Ludy has no source for the output VAT yet, so the difference is not the return's.
export const ASK_BOOKS_NOTES = ['provisional', 'sales_side_unavailable'] as const;

export const zAskBooksResolvedPeriod = z.object({
  kind: zAskBooksPeriodKind,
  // YYYY-MM, YYYY-Qn or YYYY, as the report takes it.
  value: zLedgerPeriod,
  from: zLocalDate,
  to: zLocalDate,
  // True when the period's end is after today: the figures are the books to date.
  partial: z.boolean(),
});
export type AskBooksResolvedPeriod = z.infer<typeof zAskBooksResolvedPeriod>;

export const zAskBooksCard = z.object({
  entry: zAskBooksEntry,
  period: zAskBooksResolvedPeriod,
  figures: z.array(z.object({ key: zAskBooksFigureKey, amount: zMoney })).max(6),
  // The largest balances of receivables_top and payables_top, largest first (a null name is a balance no party is named on); empty for the other entries.
  top: z.array(z.object({ name: z.string().max(300).nullable(), amount: zMoney })).max(ASK_BOOKS_TOP),
  // How many parties hold a balance in that direction (so the card can say "and N more").
  partyCount: z.number().int().nonnegative(),
  notes: z.array(z.enum(ASK_BOOKS_NOTES)),
});
export type AskBooksCard = z.infer<typeof zAskBooksCard>;

// The picker the card shows when the period is not known: the periods code lists for the entry, newest first.
export const zAskBooksPickPeriod = z.object({
  entry: zAskBooksEntry,
  options: z.array(z.object({ kind: zAskBooksPeriodKind, value: zLedgerPeriod })).max(40),
});
export type AskBooksPickPeriod = z.infer<typeof zAskBooksPickPeriod>;

// ai: used (the coworker chose), picked (the owner chose on the card), off (the deployment has no model), busy (too many asks at once), budget (the org's AI budget of the month is spent), failed (the call failed or its
// choice was refused). state: card (a report is shown), pick_period (the report is known, the period is not: pick one), none (the question fits no entry, or the coworker could not be asked: the screen lists what can be
// asked, in fixed text). lead: the coworker's one sentence, only when it passed every check; null with AI off and on a cached choice.
export const zAskBooksAnswer = z.object({
  ai: z.enum(['used', 'picked', 'off', 'busy', 'budget', 'failed']),
  state: z.enum(['card', 'pick_period', 'none']),
  lead: z.string().max(200).nullable(),
  card: zAskBooksCard.nullable(),
  pick: zAskBooksPickPeriod.nullable(),
});
export type AskBooksAnswer = z.infer<typeof zAskBooksAnswer>;

// ---- The period, resolved by code -------------------------------------------------------------------------------------------------------------------------------------------------------------

// What the question named, as @ludy/agent's parser found it (never the model's reading).
export type AskBooksNamedInput =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'named'; named: { kind: 'month'; year: number | null; month: number } | { kind: 'quarter'; year: number | null; quarter: number } | { kind: 'year'; year: number } };

export type AskBooksPeriodOutcome = { kind: 'period'; period: AskBooksResolvedPeriod } | { kind: 'pick' };

const pad = (n: number): string => String(n).padStart(2, '0');
const daysIn = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
const yearOf = (day: string): number => Number(day.slice(0, 4));
const monthOf = (day: string): number => Number(day.slice(5, 7));
const quarterOfMonth = (month: number): number => Math.ceil(month / 3);

function monthPeriod(year: number, month: number, today: string): AskBooksResolvedPeriod {
  const from = `${year}-${pad(month)}-01`;
  const to = `${year}-${pad(month)}-${pad(daysIn(year, month))}`;
  return { kind: 'month', value: `${year}-${pad(month)}`, from, to, partial: to > today };
}
function quarterPeriod(year: number, quarter: number, today: string): AskBooksResolvedPeriod {
  const first = (quarter - 1) * 3 + 1;
  const last = first + 2;
  const to = `${year}-${pad(last)}-${pad(daysIn(year, last))}`;
  return { kind: 'quarter', value: `${year}-Q${quarter}`, from: `${year}-${pad(first)}-01`, to, partial: to > today };
}
function yearPeriod(year: number, today: string): AskBooksResolvedPeriod {
  const to = `${year}-12-31`;
  return { kind: 'year', value: String(year), from: `${year}-01-01`, to, partial: to > today };
}

// A month or quarter before this one, going back across years.
function monthsBack(year: number, month: number, back: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) - back;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}
function quartersBack(year: number, quarter: number, back: number): { year: number; quarter: number } {
  const index = year * 4 + (quarter - 1) - back;
  return { year: Math.floor(index / 4), quarter: (index % 4) + 1 };
}

/** True when the entry's read takes this kind of period. */
export const askBooksAllows = (entry: AskBooksEntry, kind: AskBooksPeriodKind): boolean => ASK_BOOKS_ALLOWED_KINDS[entry].includes(kind);

/** The period of a relative word, from the database day `today` (YYYY-MM-DD): 'as_of_today' is the month so far. Pure. */
export function resolveRelativePeriod(token: AskBooksRelativeToken, today: string): AskBooksResolvedPeriod {
  const year = yearOf(today);
  const month = monthOf(today);
  const quarter = quarterOfMonth(month);
  switch (token) {
    case 'this_month':
    case 'as_of_today':
      return monthPeriod(year, month, today);
    case 'last_month': {
      const before = monthsBack(year, month, 1);
      return monthPeriod(before.year, before.month, today);
    }
    case 'this_quarter':
      return quarterPeriod(year, quarter, today);
    case 'last_quarter': {
      const before = quartersBack(year, quarter, 1);
      return quarterPeriod(before.year, before.quarter, today);
    }
    case 'this_year':
      return yearPeriod(year, today);
    case 'last_year':
      return yearPeriod(year - 1, today);
  }
}

/** The period a picked value names (YYYY-MM, YYYY-Qn or YYYY), or null when it is not a period that has begun. Pure. */
export function resolvePickedPeriod(value: string, today: string): AskBooksResolvedPeriod | null {
  const parsed = zLedgerPeriod.safeParse(value);
  if (!parsed.success) return null;
  const year = Number(value.slice(0, 4));
  const rest = value.slice(5);
  const period = rest === '' ? yearPeriod(year, today) : rest.startsWith('Q') ? quarterPeriod(year, Number(rest.slice(1)), today) : monthPeriod(year, Number(rest), today);
  // A period that has not begun has no books yet.
  return period.from > today ? null : period;
}

/**
 * The period of the coworker's choice, resolved by code: a relative word from the database day, or the month, quarter or year code found in the question. A period the entry's read does not take (a year for VAT), a question
 * that named none or more than one, or one that has not begun gives `pick`, and the owner chooses from a list: nothing is guessed. Pure.
 */
export function resolveAskPeriod(entry: AskBooksEntry, token: AskBooksRelativeToken | 'named', named: AskBooksNamedInput, today: string): AskBooksPeriodOutcome {
  let period: AskBooksResolvedPeriod | null;
  if (token !== 'named') period = resolveRelativePeriod(token, today);
  else if (named.kind !== 'named') period = null;
  else {
    const found = named.named;
    const year = yearOf(today);
    const month = monthOf(today);
    if (found.kind === 'year') period = found.year >= 2000 && found.year <= 2099 ? yearPeriod(found.year, today) : null;
    else if (found.kind === 'month') {
      // No year typed: the most recent such month up to this one.
      const useYear = found.year ?? (found.month > month ? year - 1 : year);
      period = found.month >= 1 && found.month <= 12 && useYear >= 2000 && useYear <= 2099 ? monthPeriod(useYear, found.month, today) : null;
    } else {
      const useYear = found.year ?? (found.quarter > quarterOfMonth(month) ? year - 1 : year);
      period = found.quarter >= 1 && found.quarter <= 4 && useYear >= 2000 && useYear <= 2099 ? quarterPeriod(useYear, found.quarter, today) : null;
    }
  }
  if (period === null || period.from > today || !askBooksAllows(entry, period.kind)) return { kind: 'pick' };
  return { kind: 'period', period };
}

/** The periods the picker lists for an entry, newest first: the last months, quarters and years its read takes, up to the one that has begun. Pure. */
export function askBooksPickOptions(entry: AskBooksEntry, today: string): AskBooksPickPeriod['options'] {
  const year = yearOf(today);
  const month = monthOf(today);
  const quarter = quarterOfMonth(month);
  const options: AskBooksPickPeriod['options'] = [];
  if (askBooksAllows(entry, 'month')) {
    for (let back = 0; back < ASK_BOOKS_PICK_MONTHS; back += 1) {
      const m = monthsBack(year, month, back);
      options.push({ kind: 'month', value: `${m.year}-${pad(m.month)}` });
    }
  }
  if (askBooksAllows(entry, 'quarter')) {
    for (let back = 0; back < ASK_BOOKS_PICK_QUARTERS; back += 1) {
      const q = quartersBack(year, quarter, back);
      options.push({ kind: 'quarter', value: `${q.year}-Q${q.quarter}` });
    }
  }
  if (askBooksAllows(entry, 'year')) {
    for (let back = 0; back < ASK_BOOKS_PICK_YEARS; back += 1) options.push({ kind: 'year', value: String(year - back) });
  }
  return options;
}

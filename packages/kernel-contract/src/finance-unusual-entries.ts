// SPDX-License-Identifier: AGPL-3.0-only
// The monthly review of posted entries that look unusual (#5182): for one legal entity and one ended month, the entries of the books that deserve a second look, found by five deterministic rules,
// ranked and capped in SQL. It differs from the flags of #2380, which fire before a payment is approved; the thresholds that fit are reused from it and from the expense variance (#4392). Code finds the
// entries and computes every figure; the finance coworker only phrases one possible thing to look at per hit (a possibility, never a finding), and a person may mark a hit as reviewed. Nothing here
// changes the books. Amounts are decimal strings in the book currency.
import { z } from 'zod';
import { EXPENSE_VARIANCE_MIN_AMOUNT, zExpenseVarianceMonth, zExpenseVarianceRegime, zExpenseVarianceSourceKind } from './finance-expense-variance.ts';
import { zId, zLocalDate, zMoney } from './schemas.ts';

// The rule codes, in the order hits are ranked: a second copy of an invoice first, a day off last.
export const UNUSUAL_ENTRY_RULES = ['duplicate_invoice', 'control_manual', 'amount_outlier', 'new_account', 'off_day'] as const;
export const zUnusualEntryRule = z.enum(UNUSUAL_ENTRY_RULES);
export type UnusualEntryRule = z.infer<typeof zUnusualEntryRule>;
// The key a hit is known by (the notes and the screen's rows): the rule and the entry.
export const unusualEntryHitKey = (rule: UnusualEntryRule | string, entryId: string): string => `${rule}:${entryId}`;

// The thresholds, one pair for every org (a per-org setting is a later, separate change).
// amount_outlier: the amount of an entry on a group (a party and an account line) is at least FACTOR times, or at most a FACTOR-th of, the median of the group's earlier entries of the last
// HISTORY months, AND differs from it by at least MIN_DIFF dong, AND by at least MAD_FACTOR times the median absolute deviation of those entries (the spread; a spread of 0 passes). Judged only with
// at least MIN_HISTORY earlier entries in the group.
export const UNUSUAL_HISTORY_MONTHS = 6;
export const UNUSUAL_AMOUNT_MIN_HISTORY = 6;
export const UNUSUAL_AMOUNT_FACTOR = 3;
export const UNUSUAL_AMOUNT_MIN_DIFF = EXPENSE_VARIANCE_MIN_AMOUNT;
export const UNUSUAL_MAD_FACTOR = 5;
// new_account: the account line is one this party (at least PARTY_MIN earlier entries of it) or, for a line with no party, this kind of voucher (at least KIND_MIN earlier entries of the kind) has not used in
// the last NEW_ACCOUNT_MONTHS months. The window is bounded so the history read stays bounded on a long-lived entity.
export const UNUSUAL_NEW_ACCOUNT_MONTHS = 24;
export const UNUSUAL_NEW_ACCOUNT_PARTY_MIN = 3;
export const UNUSUAL_NEW_ACCOUNT_KIND_MIN = 10;
// off_day: only entries a person keyed (a manual voucher, a cash or bank voucher) of at least this amount.
export const UNUSUAL_OFF_DAY_MIN_AMOUNT = '5000000';
// At most this many hits per rule and in all (ranked in SQL), and the ones the coworker is given.
export const UNUSUAL_MAX_PER_RULE = 6;
export const UNUSUAL_MAX_HITS = 30;
export const UNUSUAL_NOTE_HITS = 12;

export const zFinanceUnusualEntriesInput = z.object({ month: zExpenseVarianceMonth, legalEntityId: zId.optional() });
export type FinanceUnusualEntriesInput = z.infer<typeof zFinanceUnusualEntriesInput>;

// The control accounts a manual voucher must not touch unnoticed, as a fixed group: 131 receivables, 331 payables, 133 input VAT, 333 taxes payable, 334 employee payables.
export const UNUSUAL_CONTROL_GROUPS = ['receivable', 'payable', 'input_vat', 'tax', 'employee'] as const;
export const zUnusualControlGroup = z.enum(UNUSUAL_CONTROL_GROUPS);
export type UnusualControlGroup = z.infer<typeof zUnusualControlGroup>;

// One hit: one entry and the rule that found it. Fields that belong to one rule are null for the others. `description` is the member's own ledger text and the names are the books' own: they are shown,
// never sent to the model.
export const zUnusualEntryHit = z.object({
  rule: zUnusualEntryRule,
  entryId: zId,
  entryDate: zLocalDate,
  sourceKind: zExpenseVarianceSourceKind,
  description: z.string().nullable(),
  // The entry's total (its debits).
  amount: zMoney,
  partyId: zId.nullable(),
  partyName: z.string().nullable(),
  // The account line (4 digits for 64xx under TT133, 3 otherwise) the rule looked at, and its name in the regime's chart.
  accountCode: z.string().nullable(),
  accountName: z.string().nullable(),
  // amount_outlier: the entry's amount on the group, the median of the earlier ones, how many there were, how many times the median it is (one decimal), and whether it is above or below.
  groupAmount: zMoney.nullable(),
  usual: zMoney.nullable(),
  historyCount: z.number().int().nonnegative().nullable(),
  ratio: z.string().nullable(),
  direction: z.enum(['high', 'low']).nullable(),
  // new_account: what the account is new for, the supplier or the kind of voucher.
  basis: z.enum(['party', 'kind']).nullable(),
  // off_day: a weekend day or a public holiday of the shared calendar.
  day: z.enum(['weekend', 'holiday']).nullable(),
  // control_manual: which control account the manual voucher touches.
  control: zUnusualControlGroup.nullable(),
  // duplicate_invoice: the invoice number as booked and the entry of the earlier copy.
  invoiceNumber: z.string().nullable(),
  otherEntryId: zId.nullable(),
  otherEntryDate: zLocalDate.nullable(),
});
export type UnusualEntryHit = z.infer<typeof zUnusualEntryHit>;

export const zFinanceUnusualEntries = z.object({
  month: zExpenseVarianceMonth,
  legalEntityId: zId,
  regime: zExpenseVarianceRegime,
  chartVersion: z.string(),
  thresholds: z.object({
    amountFactor: z.number().int(),
    amountMinDiff: zMoney,
    madFactor: z.number().int(),
    historyMonths: z.number().int(),
    minHistory: z.number().int(),
    offDayMinAmount: zMoney,
  }),
  // The first day the history of the rules was read from: the later of the window's start and the day the entity's current chart began.
  historyFrom: zLocalDate,
  // True while the entity's books hold no entry at all in the month.
  empty: z.boolean(),
  // The hits not yet marked reviewed, ranked (rule order, then amount, newest first), at most UNUSUAL_MAX_PER_RULE per rule and UNUSUAL_MAX_HITS in all; `moreHits` counts the open ones past the limits and
  // `reviewed` the hits already marked reviewed.
  hits: z.array(zUnusualEntryHit).max(UNUSUAL_MAX_HITS),
  moreHits: z.number().int().nonnegative(),
  reviewed: z.number().int().nonnegative(),
});
export type FinanceUnusualEntries = z.infer<typeof zFinanceUnusualEntries>;

// The coworker's possible thing to look at per hit. ai: used (at least one note stands), off (no model), busy, budget, failed (the call failed or every note was refused), quiet (no hit). notes: by the hit's
// key `<rule>:<entryId>`; a hit with no note stands alone. A note is a possibility, never a finding; the screen says so.
export const zFinanceUnusualEntriesExplainAsk = zFinanceUnusualEntriesInput.extend({ lang: z.enum(['vi', 'en']).optional() });
export type FinanceUnusualEntriesExplainAsk = z.infer<typeof zFinanceUnusualEntriesExplainAsk>;
export const zUnusualEntriesExplanation = z.object({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'quiet']),
  notes: z.array(z.object({ key: z.string(), text: z.string() })),
});
export type UnusualEntriesExplanation = z.infer<typeof zUnusualEntriesExplanation>;

// finance.unusual_entries.review: a person marks one hit (an entry and the rule that found it) as reviewed. Idempotent: marking again changes nothing and says so. It touches no ledger table.
export const UNUSUAL_ENTRY_REVIEW_COMMAND = 'finance.unusual_entries.review';
export const zFinanceUnusualEntryReviewInput = z.object({ legalEntityId: zId.optional(), entryId: zId, rule: zUnusualEntryRule });
export type FinanceUnusualEntryReviewInput = z.infer<typeof zFinanceUnusualEntryReviewInput>;
export const zFinanceUnusualEntryReviewOutput = z.object({ entryId: zId, rule: zUnusualEntryRule, alreadyReviewed: z.boolean() });
export type FinanceUnusualEntryReviewOutput = z.infer<typeof zFinanceUnusualEntryReviewOutput>;

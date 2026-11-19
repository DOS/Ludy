// SPDX-License-Identifier: AGPL-3.0-only
// The household business kind (#2517, ADR-0045, plan stock-and-marketplaces.md section 8.5): the profile of a legal entity of kind household and the law as dated data.
// A household keeps TT133 books underneath and the books of Circular 152/2025/TT-BTC are views over them; what it chose (its tax group, PIT method, trades, e-invoice
// registration, the representative's name for the signatures) is a row of finance's household_profile from a date, and what the law sets (thresholds, percentages by trade,
// the expense groups of S2c, the forms) is read from seed tables with an effective date, a source and a status. A row with the status `commentary` is not yet checked by the
// accountant (#2520): the answers say so and nothing that files or computes a tax may rely on one.
import { z } from 'zod';
import { zId, zLedgerPeriod, zLocalDate, zMoney } from './schemas.ts';
import { STOCK_MOVE_SOURCES, STOCK_TRADES, zStockMonth } from './stock.ts';

// The fixed sets the database keeps as CHECK constraints (packages/db/src/schema.ts holds the same lists for its test).
export const HOUSEHOLD_TRADES = STOCK_TRADES;
export const HOUSEHOLD_PIT_METHODS = ['percentage', 'income'] as const;
// The household's own answer on the Decree 174 VAT cut (#3710): yes, no, or not answered (null). The cut is never applied to all revenue by default.
export const HOUSEHOLD_VAT_CUT_ANSWERS = ['yes', 'no'] as const;
export const HOUSEHOLD_RULE_STATUSES = ['commentary', 'confirmed'] as const;
export const HOUSEHOLD_EXPENSE_GROUPS = ['materials_goods', 'wages_insurance', 'depreciation', 'outside_services', 'interest', 'other'] as const;
export const HOUSEHOLD_BOOKS = ['S1a', 'S2a', 'S2b', 'S2c', 'S2d', 'S2e', 'S3a'] as const;

// The tax groups the profile can hold today: 1 (no VAT, no PIT), 2 (a percentage of revenue, or income by choice) and 3 (on income). Group 4 (other taxes, in addition to one of those)
// has no place in a single number and comes with its own book (S3a).
export const HOUSEHOLD_TAX_GROUPS = [1, 2, 3] as const;

export const zHouseholdTrade = z.enum(HOUSEHOLD_TRADES);
export type HouseholdTrade = z.infer<typeof zHouseholdTrade>;
export const zHouseholdBook = z.enum(HOUSEHOLD_BOOKS);
export const zHouseholdVatCutAnswer = z.enum(HOUSEHOLD_VAT_CUT_ANSWERS);
export type HouseholdVatCutAnswer = z.infer<typeof zHouseholdVatCutAnswer>;
export const zHouseholdRuleStatus = z.enum(HOUSEHOLD_RULE_STATUSES);

// A new row from `effectiveFrom`. The pair of group and method is checked by the command: group 1 keeps no method, group 2 names `percentage` or `income`, group 3 names `income`.
export const zHouseholdProfileSet = z.strictObject({
  legalEntityId: zId,
  effectiveFrom: zLocalDate,
  taxGroup: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  pitMethod: z.enum(HOUSEHOLD_PIT_METHODS).nullable(),
  trades: z.array(zHouseholdTrade).min(1).max(HOUSEHOLD_TRADES.length).refine((list) => new Set(list).size === list.length, 'each trade once'),
  einvoiceRegistered: z.boolean(),
  representativeName: z.string().trim().min(1).max(200).nullable(),
  // Whether the household's goods and services get the Decree 174 VAT cut: yes applies it, no applies none, absent or null is not answered (#3710).
  vatCutEligible: zHouseholdVatCutAnswer.nullable().optional(),
});
export type HouseholdProfileSet = z.infer<typeof zHouseholdProfileSet>;

export const zHouseholdProfileGet = z.strictObject({ legalEntityId: zId, date: zLocalDate.optional() });
export type HouseholdProfileGet = z.infer<typeof zHouseholdProfileGet>;

export const zHouseholdProfile = z.strictObject({
  effectiveFrom: zLocalDate,
  taxGroup: z.number().int().min(1).max(4),
  pitMethod: z.enum(HOUSEHOLD_PIT_METHODS).nullable(),
  trades: z.array(zHouseholdTrade),
  einvoiceRegistered: z.boolean(),
  representativeName: z.string().nullable(),
  vatCutEligible: zHouseholdVatCutAnswer.nullable(),
});
export type HouseholdProfile = z.infer<typeof zHouseholdProfile>;

// A book the household keeps on a date: the layout in force (its version), its title, and whether the accountant has checked the row.
export const zHouseholdBookRule = z.strictObject({ book: zHouseholdBook, version: z.string(), name: z.string(), status: zHouseholdRuleStatus });
export type HouseholdBookRule = z.infer<typeof zHouseholdBookRule>;

// The profile in force on `date` (today in Vietnam when the ask names none) and the books it requires: S1a alone for a household with no method, S2a for the percentage method, S2b to S2e for
// income. `profile` is null for an entity with no profile yet (or none yet at that date), and then no book is listed: a household is never asked to pick one.
// `commentary` is true while any row behind the answer is not yet confirmed by the accountant.
export const zHouseholdProfileView = z.strictObject({ date: zLocalDate, profile: zHouseholdProfile.nullable(), books: z.array(zHouseholdBookRule), commentary: z.boolean() });
export type HouseholdProfileView = z.infer<typeof zHouseholdProfileView>;

// The law in force on a date, as data (money as decimal strings): the yearly revenue thresholds, the VAT and PIT percentages by trade, the account-to-group map of the expense detail and the forms.
export const zHouseholdRulesGet = z.strictObject({ date: zLocalDate.optional() });
export type HouseholdRulesGet = z.infer<typeof zHouseholdRulesGet>;
const zRuleBase = { effectiveFrom: zLocalDate, source: z.string(), status: zHouseholdRuleStatus };
export const zHouseholdRules = z.strictObject({
  date: zLocalDate,
  thresholds: z.array(z.strictObject({ code: z.string(), amount: z.string(), ...zRuleBase })),
  tradeRates: z.array(z.strictObject({ trade: zHouseholdTrade, vatPercent: z.string(), pitPercent: z.string(), ...zRuleBase })),
  // The 2026 tax reductions in force on the date: the share of the tax that is cut and, for the PIT cut, the yearly revenue up to which it applies (null: no ceiling). A cut that has ended is a row of 0.
  reductions: z.array(z.strictObject({ kind: z.enum(['vat', 'pit']), cutPercent: z.string(), revenueCeiling: z.string().nullable(), ...zRuleBase })),
  expenseGroups: z.array(z.strictObject({ expenseGroup: z.enum(HOUSEHOLD_EXPENSE_GROUPS), accountPrefix: z.string(), ...zRuleBase })),
  forms: z.array(z.strictObject({ book: zHouseholdBook, version: z.string(), name: z.string(), pitMethods: z.array(z.enum(['none', ...HOUSEHOLD_PIT_METHODS])), ...zRuleBase })),
  commentary: z.boolean(),
});
export type HouseholdRules = z.infer<typeof zHouseholdRules>;

// S1a-HKD, the sales listing of a household of group 1 (Circular 152/2025/TT-BTC Art. 6; plan 8.5), laid out from the ledger: one row per entry that touched account 511 in the period, so the total
// ties to the ledger by construction (it is the credit less the debit of 511 and its sub-accounts over the period). `amount` is that net of the row (a sale is positive, a reversal or a
// return negative). The household's name and tax code are the entity's; `openedOn` is the day its first profile took effect, the date the books were opened; days before it are outside the book (`period.from` is then that day, and only entries from it are listed). The answer is refused for an entity
// whose profile does not require S1a on any day of the book (the first day, and each day a later profile takes effect inside the period): a household is shown only the books of its method.
export const zHouseholdS1aGet = z.strictObject({ legalEntityId: zId, period: zLedgerPeriod });
export type HouseholdS1aGet = z.infer<typeof zHouseholdS1aGet>;
export const zHouseholdS1aRow = z.strictObject({ entryId: zId, date: zLocalDate, reference: z.string().nullable(), description: z.string(), amount: zMoney, reversal: z.boolean() });
export type HouseholdS1aRow = z.infer<typeof zHouseholdS1aRow>;
export const zHouseholdS1a = z.strictObject({
  period: z.strictObject({ period: zLedgerPeriod, from: zLocalDate, to: zLocalDate }),
  household: z.strictObject({ name: z.string(), taxCode: z.string().nullable(), representativeName: z.string().nullable(), openedOn: zLocalDate }),
  form: zHouseholdBookRule,
  rows: z.array(zHouseholdS1aRow),
  total: zMoney,
});
export type HouseholdS1a = z.infer<typeof zHouseholdS1a>;

// The Decree 174 VAT cut as a book shows it (#3710 slice 2). `answer` is the household's own answer in its profile; `percent` is the cut in force on the period's last day (household_tax_reduction, a dated row; 0 when
// none). The cut is `applied` only when the answer is yes and a cut is in force: then each line's VAT payable is its VAT less `cut` (the cut of the line's rounded VAT, to a whole dong). With the answer no, or not answered,
// nothing is cut and `vatPayable` is the VAT; when the answer is missing and a cut is in force, `ifEligible` carries the totals the books would show if the household were eligible, so the household sees what the
// answer is worth. `total` and `ifEligible` wait for every part to have a trade, like `totals` (null while any part is unassigned).
export const zHouseholdVatCutLine = z.strictObject({ trade: zHouseholdTrade, cut: zMoney, vatPayable: zMoney });
export type HouseholdVatCutLine = z.infer<typeof zHouseholdVatCutLine>;
export const zHouseholdVatCut = z.strictObject({
  answer: zHouseholdVatCutAnswer.nullable(),
  percent: z.string(),
  applied: z.boolean(),
  lines: z.array(zHouseholdVatCutLine),
  total: z.strictObject({ cut: zMoney, vatPayable: zMoney }).nullable(),
  ifEligible: z.strictObject({ cut: zMoney, vatPayable: zMoney }).nullable(),
});
export type HouseholdVatCut = z.infer<typeof zHouseholdVatCut>;

// The yearly rule of a household's tax as a book shows it (#3710 slice 3, research 2026-11-18 B1 and B2). Tax is worked out on the year-to-date revenue (1 January to the period's last day, from the ledger's account
// 511, entries before the household's first profile included: the threshold is the household's yearly figure, not the book's). Up to the threshold in force that day (1 billion VND from 2026, a dated row)
// nothing is owed; above it VAT is owed on all the revenue and PIT only on the part above the threshold, the household picking the trade the deduction applies to when it has several (`deductionNeeded`: asked, never
// defaulted; the PIT is held back until it is given). The PIT cut (Decree 398) is a percentage of the PIT payable, only while the year's revenue is at most the ceiling of its dated row. `payable` is this period's tax: the
// year-to-date tax at its last day less the year-to-date tax before its first day, so the periods of a year add up to the year. It is null while the PIT is held back or a part of the revenue has no trade. The `vat`
// and `pit` columns of the book stay revenue times the percentage, as a fixed reference; `payable` is what is owed.
export const zHouseholdYearToDate = z.strictObject({
  year: z.number().int(),
  revenueToDate: zMoney,
  revenueBefore: zMoney,
  threshold: z.strictObject({ amount: zMoney, effectiveFrom: zLocalDate, status: zHouseholdRuleStatus }).nullable(),
  crossed: z.boolean(),
  deductionTrade: zHouseholdTrade.nullable(),
  deductionNeeded: z.boolean(),
  // No trade reaches the threshold (or the side before the period could not be worked out): the research gives no rule for the deduction there, so the PIT is held back for the accountant (#2520), not asked again.
  deductionShort: z.boolean(),
  payable: z.strictObject({ vatBefore: zMoney, vatCut: zMoney, vat: zMoney, pitBefore: zMoney, pitCut: zMoney, pit: zMoney }).nullable(),
  pitCut: z.strictObject({ percent: z.string(), ceiling: zMoney.nullable(), applied: z.boolean() }).nullable(),
});
export type HouseholdYearToDate = z.infer<typeof zHouseholdYearToDate>;

// The quarterly return worksheet 01/CNKD of a household that pays by a percentage of revenue (#2518, plan 8.5 and 12 row 7). A WORKSHEET: Ludy never files and never calls the tax authority; the household
// or its accountant files through the tax portal or eTax Mobile. Revenue is the ledger's own movement of account 511 over the quarter (so it ties to S1a and to the settlements of #2516), split by
// the trades of the profile: a household with one trade has it all on that trade; with several, the household enters the split (`split`, per ask, nothing stored) and what is not yet given a trade is
// `unassigned`, which holds the totals back (`totals` is null) rather than guess. VAT and PIT are revenue times the percentage in force on the quarter's last day, each rounded to a whole dong; the
// exempt band of the year is NOT deducted because the rule is unconfirmed (#2520). The tax the platforms already withheld comes from the stored settlements whose period ends in the quarter (it is not
// posted to the ledger yet), reversed ones left out. `commentary` is true while any row behind the figures (the form, a percentage) is not confirmed by the accountant: the figures, the screen and the
// Excel file then carry HOUSEHOLD_PROVISIONAL_LABEL on every figure that depends on those rows, and Ludy still files nothing. The label goes away on its own when the rows are confirmed (data, not code).
export const HOUSEHOLD_PROVISIONAL_LABEL = 'Số liệu tạm, kế toán chưa xác nhận tỷ lệ';
export const HOUSEHOLD_RETURN_FORMS = ['01/CNKD'] as const;
export const zHouseholdReturnForm = z.enum(HOUSEHOLD_RETURN_FORMS);
export const zHouseholdCnkdGet = z.strictObject({
  legalEntityId: zId,
  year: z.number().int().min(2026).max(2100),
  quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  split: z.array(z.strictObject({ trade: zHouseholdTrade, revenue: zMoney })).max(HOUSEHOLD_TRADES.length).optional(),
  // With several trades: the split of the year's revenue before the quarter (per ask, nothing stored), and the trade that takes the threshold deduction (#3710 slice 3).
  splitBefore: z.array(z.strictObject({ trade: zHouseholdTrade, revenue: zMoney })).max(HOUSEHOLD_TRADES.length).optional(),
  deductionTrade: zHouseholdTrade.optional(),
  forExport: z.boolean().optional(),
});
export type HouseholdCnkdGet = z.infer<typeof zHouseholdCnkdGet>;
export const zHouseholdCnkdLine = z.strictObject({ trade: zHouseholdTrade, revenue: zMoney, vatPercent: z.string(), pitPercent: z.string(), vat: zMoney, pit: zMoney });
export type HouseholdCnkdLine = z.infer<typeof zHouseholdCnkdLine>;
export const zHouseholdCnkd = z.strictObject({
  period: z.strictObject({ year: z.number().int(), quarter: z.number().int().min(1).max(4), from: zLocalDate, to: zLocalDate }),
  household: z.strictObject({ name: z.string(), taxCode: z.string().nullable(), representativeName: z.string().nullable() }),
  form: z.strictObject({ form: zHouseholdReturnForm, version: z.string(), name: z.string(), status: zHouseholdRuleStatus }),
  revenue: zMoney,
  lines: z.array(zHouseholdCnkdLine),
  unassigned: zMoney,
  totals: z.strictObject({ revenue: zMoney, vat: zMoney, pit: zMoney, tax: zMoney }).nullable(),
  vatCut: zHouseholdVatCut,
  yearToDate: zHouseholdYearToDate,
  withheld: z.strictObject({
    total: zMoney,
    settlements: z.array(z.strictObject({ id: zId, platform: z.string(), periodStart: zLocalDate, periodEnd: zLocalDate, taxWithheld: zMoney })),
  }),
  due: zMoney.nullable(),
  overpaid: zMoney.nullable(),
  unconfirmed: z.array(z.strictObject({ kind: z.enum(['form', 'rate', 'reduction', 'threshold']), key: z.string(), effectiveFrom: zLocalDate })),
  commentary: z.boolean(),
});
export type HouseholdCnkd = z.infer<typeof zHouseholdCnkd>;

// S2a-HKD, the revenue book of a household that pays a percentage of revenue (Circular 152/2025/TT-BTC; plan 8.5 and 12 row 6, #2517 slice 2a): S1a with the revenue split by business line, and the VAT and PIT
// of each line by the percentages in force on the period's last day, each rounded to a whole dong. It is a view of the ledger like S1a: one row per entry that touched account 511, so `total` is the
// ledger's own movement of 511 and the parts of every row add up to its amount. The ledger has no trade on a 511 line, so the trade of a row comes from what the entry is built from, never from a
// guess: a household with one trade has every row on it; with several, a row built from a sale document's lines takes the trade of each line's stock item (by the lines' amounts), and a row built
// from anything else (a marketplace settlement, a manual voucher), or from an item whose trade the profile does not list, is `unassigned`. Any `unassigned` part holds the totals back (`totals` is null)
// rather than guess. `commentary` is true while any row behind the figures (the book's form, a percentage) is not confirmed by the accountant (#2520): the screen and the Excel file then carry
// HOUSEHOLD_PROVISIONAL_LABEL, which goes on its own when later dated `confirmed` rows exist. Ludy files nothing.
export const zHouseholdS2aGet = z.strictObject({ legalEntityId: zId, period: zLedgerPeriod, deductionTrade: zHouseholdTrade.optional() });
export type HouseholdS2aGet = z.infer<typeof zHouseholdS2aGet>;
export const HOUSEHOLD_UNASSIGNED = 'unassigned' as const;
export const zHouseholdS2aPart = z.strictObject({ trade: z.union([zHouseholdTrade, z.literal(HOUSEHOLD_UNASSIGNED)]), amount: zMoney });
export type HouseholdS2aPart = z.infer<typeof zHouseholdS2aPart>;
export const zHouseholdS2aRow = z.strictObject({
  entryId: zId,
  date: zLocalDate,
  reference: z.string().nullable(),
  description: z.string(),
  amount: zMoney,
  reversal: z.boolean(),
  parts: z.array(zHouseholdS2aPart),
});
export type HouseholdS2aRow = z.infer<typeof zHouseholdS2aRow>;
export const zHouseholdS2a = z.strictObject({
  period: z.strictObject({ period: zLedgerPeriod, from: zLocalDate, to: zLocalDate }),
  household: z.strictObject({ name: z.string(), taxCode: z.string().nullable(), representativeName: z.string().nullable(), openedOn: zLocalDate }),
  form: zHouseholdBookRule,
  rows: z.array(zHouseholdS2aRow),
  // The ledger's movement of 511 over the book's days: the sum of the rows, and of the lines plus `unassigned`.
  total: zMoney,
  lines: z.array(zHouseholdCnkdLine),
  // The net of the parts with no business line (a sale and its void both unassigned net to zero), and the sum of their absolute amounts. Any part with an amount holds `totals` back, so two
  // unrelated unassigned entries that happen to cancel never hide their tax; the screen names the gross.
  unassigned: zMoney,
  unassignedGross: zMoney,
  totals: z.strictObject({ revenue: zMoney, vat: zMoney, pit: zMoney, tax: zMoney }).nullable(),
  vatCut: zHouseholdVatCut,
  yearToDate: zHouseholdYearToDate,
  unconfirmed: z.array(z.strictObject({ kind: z.enum(['form', 'rate', 'reduction', 'threshold']), key: z.string(), effectiveFrom: zLocalDate })),
  commentary: z.boolean(),
});
export type HouseholdS2a = z.infer<typeof zHouseholdS2a>;

// S2b-HKD, the revenue book of a household that pays PIT on income (Circular 152/2025/TT-BTC; plan 8.5 and 12 row 6, #2517 slice 2c): the same rows and the same split by business line as S2a (one row per entry that
// touched account 511, so `total` is the ledger's own movement of 511), with the VAT of each line by the percentage in force on the period's last day, rounded to a whole dong. There is no PIT column: on the income
// method the PIT comes from income (S2c), not from a percentage of revenue. Any `unassigned` part holds `totals` back (null) rather than guess a line. `commentary` is true while the book's form or a percentage in
// use is not confirmed by the accountant (#2520): the screen and the Excel file then carry HOUSEHOLD_PROVISIONAL_LABEL, which goes on its own when later dated `confirmed` rows exist. Ludy files nothing.
export const zHouseholdS2bGet = z.strictObject({ legalEntityId: zId, period: zLedgerPeriod });
export type HouseholdS2bGet = z.infer<typeof zHouseholdS2bGet>;
export const zHouseholdS2bLine = z.strictObject({ trade: zHouseholdTrade, revenue: zMoney, vatPercent: z.string(), vat: zMoney });
export type HouseholdS2bLine = z.infer<typeof zHouseholdS2bLine>;
export const zHouseholdS2b = z.strictObject({
  period: z.strictObject({ period: zLedgerPeriod, from: zLocalDate, to: zLocalDate }),
  household: z.strictObject({ name: z.string(), taxCode: z.string().nullable(), representativeName: z.string().nullable(), openedOn: zLocalDate }),
  form: zHouseholdBookRule,
  rows: z.array(zHouseholdS2aRow),
  // The ledger's movement of 511 over the book's days: the sum of the rows, and of the lines plus `unassigned`.
  total: zMoney,
  lines: z.array(zHouseholdS2bLine),
  unassigned: zMoney,
  unassignedGross: zMoney,
  totals: z.strictObject({ revenue: zMoney, vat: zMoney }).nullable(),
  vatCut: zHouseholdVatCut,
  yearToDate: zHouseholdYearToDate,
  unconfirmed: z.array(z.strictObject({ kind: z.enum(['form', 'rate', 'reduction', 'threshold']), key: z.string(), effectiveFrom: zLocalDate })),
  commentary: z.boolean(),
});
export type HouseholdS2b = z.infer<typeof zHouseholdS2b>;

// S2c-HKD, the revenue and expense detail of a household that pays PIT on income (Circular 152/2025/TT-BTC; plan 8.5 and 12 row 6, #2517 slice 2b), a view of the ledger like S1a and S2a. A BOOK: Ludy never files
// anything. Revenue is the same rows as S1a (one per entry that touched account 511, so `revenue` is the ledger's own movement of 511). Expenses are one row per journal line on an expense account (TT133 classes 6
// and 8), with its document reference (the invoice number of the purchase document the entry was posted from; null for a voucher), its account, and its group read from the dated rows of
// household_expense_group_map by the account's prefix. An expense account no row covers has `group` null: it is shown apart (`unmapped`) and never put in a guessed group, and it holds `income` back (null).
// `amount` is debit less credit (a return or a reversal lowers it). The PIT itself is not computed: no income-method rate is in the data and which expenses are deductible is unconfirmed (#2520), so the book stops at
// the income figure. `commentary` is true while the S2c layout row or a map row in use is not confirmed by the accountant: the screen and the Excel file then carry HOUSEHOLD_PROVISIONAL_LABEL on the expense and
// income figures, which goes on its own when later dated `confirmed` rows exist.
export const zHouseholdS2cGet = z.strictObject({ legalEntityId: zId, period: zLedgerPeriod });
export type HouseholdS2cGet = z.infer<typeof zHouseholdS2cGet>;
export const zHouseholdS2cExpenseRow = z.strictObject({
  entryId: zId,
  lineNo: z.number().int(),
  date: zLocalDate,
  reference: z.string().nullable(),
  description: z.string(),
  accountCode: z.string(),
  group: z.enum(HOUSEHOLD_EXPENSE_GROUPS).nullable(),
  amount: zMoney,
  reversal: z.boolean(),
});
export type HouseholdS2cExpenseRow = z.infer<typeof zHouseholdS2cExpenseRow>;
export const zHouseholdS2c = z.strictObject({
  period: z.strictObject({ period: zLedgerPeriod, from: zLocalDate, to: zLocalDate }),
  household: z.strictObject({ name: z.string(), taxCode: z.string().nullable(), representativeName: z.string().nullable(), openedOn: zLocalDate }),
  form: zHouseholdBookRule,
  revenueRows: z.array(zHouseholdS1aRow),
  revenue: zMoney,
  expenseRows: z.array(zHouseholdS2cExpenseRow),
  // One total per group in the fixed order of HOUSEHOLD_EXPENSE_GROUPS (a group with no line has 0), then the expense no row covers and its gross (the sum of the absolute amounts of those lines).
  groups: z.array(z.strictObject({ group: z.enum(HOUSEHOLD_EXPENSE_GROUPS), amount: zMoney })),
  unmapped: zMoney,
  unmappedGross: zMoney,
  expenseTotal: zMoney,
  income: zMoney.nullable(),
  unconfirmed: z.array(z.strictObject({ kind: z.enum(['form', 'group']), key: z.string(), effectiveFrom: zLocalDate })),
  commentary: z.boolean(),
});
export type HouseholdS2c = z.infer<typeof zHouseholdS2c>;

// S2e-HKD, the cash and bank book of a household that pays PIT on income (Circular 152/2025/TT-BTC; plan 8.5 and 12 row 6, #2517 slice 2e), a view of the ledger like S2c. A BOOK: Ludy never files anything.
// One section per account that is 111 or 112 or a sub-account of them with an opening balance or a line in the book's days (`period.from` is the day the books opened when that is inside the period). A section holds the
// opening balance (debit less credit before the book's first day), one row per journal line on that account alone (cash in is the debit, cash out the credit, the accounts on the other side of the entry, the running
// balance) and the closing balance, so the sections add up without double counting and `totals.closing` ties to the ledger's balance of 111 and 112. A negative balance is shown as it is and flagged (`negative`), never hidden.
// `commentary` is true while the S2e layout row is not confirmed by the accountant: the screen and the Excel file then carry HOUSEHOLD_PROVISIONAL_LABEL, which goes on its own when a later dated `confirmed` row exists.
export const zHouseholdS2eGet = z.strictObject({ legalEntityId: zId, period: zLedgerPeriod });
export type HouseholdS2eGet = z.infer<typeof zHouseholdS2eGet>;
export const zHouseholdS2eRow = z.strictObject({
  entryId: zId,
  lineNo: z.number().int(),
  date: zLocalDate,
  reference: z.string().nullable(),
  description: z.string(),
  counterAccounts: z.array(z.string()),
  cashIn: zMoney,
  cashOut: zMoney,
  balance: zMoney,
  reversal: z.boolean(),
});
export type HouseholdS2eRow = z.infer<typeof zHouseholdS2eRow>;
export const zHouseholdS2eAccount = z.strictObject({
  accountCode: z.string(),
  accountName: z.string(),
  opening: zMoney,
  rows: z.array(zHouseholdS2eRow),
  totalIn: zMoney,
  totalOut: zMoney,
  closing: zMoney,
  negative: z.boolean(),
});
export type HouseholdS2eAccount = z.infer<typeof zHouseholdS2eAccount>;
export const zHouseholdS2e = z.strictObject({
  period: z.strictObject({ period: zLedgerPeriod, from: zLocalDate, to: zLocalDate }),
  household: z.strictObject({ name: z.string(), taxCode: z.string().nullable(), representativeName: z.string().nullable(), openedOn: zLocalDate }),
  form: zHouseholdBookRule,
  accounts: z.array(zHouseholdS2eAccount),
  totals: z.strictObject({ opening: zMoney, in: zMoney, out: zMoney, closing: zMoney }),
  unconfirmed: z.array(z.strictObject({ kind: z.enum(['form']), key: z.string(), effectiveFrom: zLocalDate })),
  commentary: z.boolean(),
});
export type HouseholdS2e = z.infer<typeof zHouseholdS2e>;

// S2d-HKD, the goods book of a household that pays PIT on income (Circular 152/2025/TT-BTC; plan 8.5 and 12 row 5, #2517 slice 2d): per item the quantity and value in, out and on hand for ONE month, read from #2513's stock
// data (the same moves, the same weighted average per month and the same stored close as finance.stock.report and the stock card), so the book cannot disagree with them. A BOOK: Ludy never files anything.
// Per item: the opening quantity and value, one row per stock move of the month (the quantity in or out, the value a purchase line brought in, the document reference, the balance in quantity) and the month's
// totals (in, out, closing, and the unit cost). What leaves is valued on the totals line only (quantity out x the month's unit cost), never per move: the cost is a month average, so per-move values would not add up
// to the total after rounding. `monthClosed` is false until a person closes the month (the cost is then provisional); `commentary` is true while the S2d layout row is not confirmed by the accountant.
// A quarter or a year is not offered: whether to chain the months or take a whole-period average is the accountant's question (#2520, B5).
// `month` takes any ledger period so that a quarter or a year is refused with a named error (HOUSEHOLD_S2D_MONTH_ONLY) that says why, not a bare validation failure.
export const zHouseholdS2dGet = z.strictObject({ legalEntityId: zId, month: zLedgerPeriod });
export type HouseholdS2dGet = z.infer<typeof zHouseholdS2dGet>;
export const zHouseholdS2dRow = z.strictObject({
  moveId: zId,
  date: zLocalDate,
  source: z.enum(STOCK_MOVE_SOURCES),
  reference: z.string().nullable(),
  quantityIn: z.string(),
  quantityOut: z.string(),
  valueIn: z.string().nullable(),
  balanceQuantity: z.string(),
});
export type HouseholdS2dRow = z.infer<typeof zHouseholdS2dRow>;
export const zHouseholdS2dItem = z.strictObject({
  itemId: zId,
  code: z.string(),
  name: z.string(),
  unit: z.string(),
  openingQuantity: z.string(),
  openingValue: z.string(),
  rows: z.array(zHouseholdS2dRow),
  inQuantity: z.string(),
  inValue: z.string(),
  outQuantity: z.string(),
  outValue: z.string(),
  closingQuantity: z.string(),
  closingValue: z.string(),
  unitCost: z.string().nullable(),
});
export type HouseholdS2dItem = z.infer<typeof zHouseholdS2dItem>;
export const zHouseholdS2d = z.strictObject({
  period: z.strictObject({ month: zStockMonth, from: zLocalDate, to: zLocalDate }),
  household: z.strictObject({ name: z.string(), taxCode: z.string().nullable(), representativeName: z.string().nullable(), openedOn: zLocalDate }),
  form: zHouseholdBookRule,
  items: z.array(zHouseholdS2dItem),
  totals: z.strictObject({ openingValue: zMoney, inValue: zMoney, outValue: zMoney, closingValue: zMoney }),
  monthClosed: z.boolean(),
  unconfirmed: z.array(z.strictObject({ kind: z.enum(['form']), key: z.string(), effectiveFrom: zLocalDate })),
  commentary: z.boolean(),
});
export type HouseholdS2d = z.infer<typeof zHouseholdS2d>;

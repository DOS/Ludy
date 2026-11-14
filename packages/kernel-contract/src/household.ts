// SPDX-License-Identifier: AGPL-3.0-only
// The household business kind (#2517, ADR-0045, plan stock-and-marketplaces.md section 8.5): the profile of a legal entity of kind household and the law as dated data.
// A household keeps TT133 books underneath and the books of Circular 152/2025/TT-BTC are views over them; what it chose (its tax group, PIT method, trades, e-invoice
// registration, the representative's name for the signatures) is a row of finance's household_profile from a date, and what the law sets (thresholds, percentages by trade,
// the expense groups of S2c, the forms) is read from seed tables with an effective date, a source and a status. A row with the status `commentary` is not yet checked by the
// accountant (#2520): the answers say so and nothing that files or computes a tax may rely on one.
import { z } from 'zod';
import { zId, zLedgerPeriod, zLocalDate, zMoney } from './schemas.ts';
import { STOCK_TRADES } from './stock.ts';

// The fixed sets the database keeps as CHECK constraints (packages/db/src/schema.ts holds the same lists for its test).
export const HOUSEHOLD_TRADES = STOCK_TRADES;
export const HOUSEHOLD_PIT_METHODS = ['percentage', 'income'] as const;
export const HOUSEHOLD_RULE_STATUSES = ['commentary', 'confirmed'] as const;
export const HOUSEHOLD_EXPENSE_GROUPS = ['materials_goods', 'wages_insurance', 'depreciation', 'outside_services', 'interest', 'other'] as const;
export const HOUSEHOLD_BOOKS = ['S1a', 'S2a', 'S2b', 'S2c', 'S2d', 'S2e', 'S3a'] as const;

// The tax groups the profile can hold today: 1 (no VAT, no PIT), 2 (a percentage of revenue, or income by choice) and 3 (on income). Group 4 (other taxes, in addition to one of those)
// has no place in a single number and comes with its own book (S3a).
export const HOUSEHOLD_TAX_GROUPS = [1, 2, 3] as const;

export const zHouseholdTrade = z.enum(HOUSEHOLD_TRADES);
export const zHouseholdBook = z.enum(HOUSEHOLD_BOOKS);
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

// The quarterly return worksheet 01/CNKD of a household that pays by a percentage of revenue (#2518, plan 8.5 and 12 row 7). A WORKSHEET: Ludy never files and never calls the tax authority; the household
// or its accountant files through the tax portal or eTax Mobile. Revenue is the ledger's own movement of account 511 over the quarter (so it ties to S1a and to the settlements of #2516), split by
// the trades of the profile: a household with one trade has it all on that trade; with several, the household enters the split (`split`, per ask, nothing stored) and what is not yet given a trade is
// `unassigned`, which holds the totals back (`totals` is null) rather than guess. VAT and PIT are revenue times the percentage in force on the quarter's last day, each rounded to a whole dong; the
// exempt band of the year is NOT deducted because the rule is unconfirmed (#2520). The tax the platforms already withheld comes from the stored settlements whose period ends in the quarter (it is not
// posted to the ledger yet), reversed ones left out. `commentary` is true while any row behind the figures (the form, a percentage) is not confirmed by the accountant; the Excel file is refused then
// (`forExport`), the screen shows the figures as a draft.
export const HOUSEHOLD_RETURN_FORMS = ['01/CNKD'] as const;
export const zHouseholdReturnForm = z.enum(HOUSEHOLD_RETURN_FORMS);
export const zHouseholdCnkdGet = z.strictObject({
  legalEntityId: zId,
  year: z.number().int().min(2026).max(2100),
  quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  split: z.array(z.strictObject({ trade: zHouseholdTrade, revenue: zMoney })).max(HOUSEHOLD_TRADES.length).optional(),
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
  withheld: z.strictObject({
    total: zMoney,
    settlements: z.array(z.strictObject({ id: zId, platform: z.string(), periodStart: zLocalDate, periodEnd: zLocalDate, taxWithheld: zMoney })),
  }),
  due: zMoney.nullable(),
  overpaid: zMoney.nullable(),
  unconfirmed: z.array(z.strictObject({ kind: z.enum(['form', 'rate']), key: z.string(), effectiveFrom: zLocalDate })),
  commentary: z.boolean(),
});
export type HouseholdCnkd = z.infer<typeof zHouseholdCnkd>;

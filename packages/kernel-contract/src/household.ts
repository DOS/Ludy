// SPDX-License-Identifier: AGPL-3.0-only
// The household business kind (#2517, ADR-0045, plan stock-and-marketplaces.md section 8.5): the profile of a legal entity of kind household and the law as dated data.
// A household keeps TT133 books underneath and the books of Circular 152/2025/TT-BTC are views over them; what it chose (its tax group, PIT method, trades, e-invoice
// registration, the representative's name for the signatures) is a row of finance's household_profile from a date, and what the law sets (thresholds, percentages by trade,
// the expense groups of S2c, the forms) is read from seed tables with an effective date, a source and a status. A row with the status `commentary` is not yet checked by the
// accountant (#2520): the answers say so and nothing that files or computes a tax may rely on one.
import { z } from 'zod';
import { zId, zLocalDate } from './schemas.ts';
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

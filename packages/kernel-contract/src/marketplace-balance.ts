// SPDX-License-Identifier: AGPL-3.0-only
// The Sàn screen's read (#2516 slice D, plan docs/plan/stock-and-marketplaces.md section 8.4, "The payout"): for each platform an entity sells on, where the platform's money stands in the books,
// read from the ledger by account and by the platform's party (crove_finance.marketplace_party). Facts only: no model call, nothing stored, no buyer or order data. Amounts are decimal strings.
import { z } from 'zod';
import { zMonth } from './journal-voucher.ts';
import { zId, zLocalDate, zMoney } from './schemas.ts';

export const zMarketplaceBalanceInput = z.strictObject({ legalEntityId: zId.optional() });
export type MarketplaceBalanceInput = z.infer<typeof zMarketplaceBalanceInput>;

// One platform of one legal entity. `salesPosted` is what settlement entries debited to 131 for the platform (a reversed entry takes its amount back), `paidOut` what the platform's payouts
// cleared on 131, the whole credit (which also covers the fees and the tax the platform kept, so it is not the cash received; a reversed payout takes its amount back), `awaitingPayout` the difference, which is the platform's balance on 131: what the platform still owes the seller. `feesAwaitingInvoice`
// is the platform's debit balance on 331: fees the platform kept at a payout whose invoice has not come yet (the invoice credits 331 and nets them). All four are zero until the entries that post them exist (the settlement and the payout
// slices of #2516), so a platform with a link and no entries shows zeros, never an error.
export const zMarketplaceBalanceRow = z.object({
  legalEntityId: zId,
  platform: z.string(),
  // The platform's name as the party is called in the books.
  platformName: z.string(),
  salesPosted: zMoney,
  paidOut: zMoney,
  awaitingPayout: zMoney,
  feesAwaitingInvoice: zMoney,
});
export type MarketplaceBalanceRow = z.infer<typeof zMarketplaceBalanceRow>;

export const zMarketplaceBalance = z.object({ rows: z.array(zMarketplaceBalanceRow) });
export type MarketplaceBalance = z.infer<typeof zMarketplaceBalance>;

// The facts behind the finance coworker's one line on the Sàn screen (#2516 slice E), read by code from the books and nothing else: `settlementsToPost` is the stored settlements of the entity (or
// of every entity the caller may see) that stand (not reversed, not a reversal) and have no posting voucher yet; `awaitingPayout` and `feesAwaitingInvoice` the sums of the balance rows (slice D)
// of the platforms that owe (a platform whose balance is negative, overpaid or a payout reversed, is not waiting, and is not netted against another's debt). No platform name, order, buyer or bank
// data is in it, so there is nothing in it for a model to follow.
export const zMarketplaceFacts = z.strictObject({
  settlementsToPost: z.number().int().min(0),
  // The stored settlements that are posted and standing and have no payout voucher yet (the platform's transfer is not recorded). Shown by code beside the other facts; the coworker's sentence is
  // not told it (see packages/agent marketplace-line.ts: a fourth count needs its own cue words in the sentence checks).
  payoutsToMatch: z.number().int().min(0),
  // The stored settlements that are half reversed (#3329): some month vouchers reversed and some still standing. Shown by code beside the other facts; the coworker's sentence is not told it.
  settlementsHalfReversed: z.number().int().min(0),
  awaitingPayout: zMoney,
  feesAwaitingInvoice: zMoney,
});
export type MarketplaceFacts = z.infer<typeof zMarketplaceFacts>;

// The line the screen shows: the facts always (the core works with AI off), and the coworker's sentence when there is one. `ai` says why there is no sentence: `off` (no model), `busy` (too
// frequent), `budget` (the AI budget is spent), `failed` (the call failed or its text was refused; the reason is logged as a code, never the words) or `none` (there is nothing to say).
export const zMarketplaceLineAsk = z.strictObject({ legalEntityId: zId.optional(), lang: z.enum(['vi', 'en']).optional() });
export type MarketplaceLineAsk = z.infer<typeof zMarketplaceLineAsk>;
export const zMarketplaceLine = z.strictObject({
  facts: zMarketplaceFacts,
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'none']),
  text: z.string().nullable(),
});
export type MarketplaceLine = z.infer<typeof zMarketplaceLine>;

// What the Sàn screen lets a person act on (#2516 slice F, plan docs/plan/stock-and-marketplaces.md section 8.4): three short lists, read by code from the books and the stored settlements, no model
// call and no buyer data. Each item is one proposal a person can ask for (finance.marketplace_settlement.record, finance.marketplace_payout.record, finance.marketplace_fee_clearing.record); nothing
// is posted by reading them. `postingConfirmed` is the gate: false while the accountant has not confirmed the account map of an entity in view (#2520), when every request would be refused.
// A settlement to post: a stored settlement that stands and has no posting voucher. It posts as one voucher per month of delivery (#2516 rework slice C1), all by one proposal; `months` are those months and
// `net` the sum of what their entries post (sales less seller discounts less refunds). A settlement with a sale that has no delivery day yet waits (`waitingLines` of them, no month), nothing to ask for.
export const zMarketplaceSettlementToPost = z.object({
  id: zId,
  legalEntityId: zId,
  platform: z.string(),
  platformName: z.string(),
  periodFrom: zLocalDate,
  periodTo: zLocalDate,
  // The months of delivery (YYYY-MM) the entries are for; none while the settlement waits for the delivery day of some of its sales.
  months: z.array(zMonth),
  net: zMoney,
  waitingLines: z.number().int().min(0),
  // A proposal for it already waits in the Inbox: the screen links to it instead of offering a second request.
  proposalId: zId.nullable(),
});
export type MarketplaceSettlementToPost = z.infer<typeof zMarketplaceSettlementToPost>;
// A bank line the platform's transfer may be: the entity's, money in, equal to the net, not before the period, and free. Shown by its date, amount and statement reference.
export const zMarketplacePayoutCandidate = z.object({ id: zId, date: zLocalDate, amount: zMoney, reference: z.string().nullable() });
export type MarketplacePayoutCandidate = z.infer<typeof zMarketplacePayoutCandidate>;
// A posted settlement that waits for its payout: `received` is the net the platform paid (the amount the bank line must equal), with the candidate lines (none yet when the statement has not come).
export const zMarketplacePayoutToMatch = z.object({
  settlementId: zId,
  legalEntityId: zId,
  platform: z.string(),
  platformName: z.string(),
  periodFrom: zLocalDate,
  periodTo: zLocalDate,
  received: zMoney,
  candidates: z.array(zMarketplacePayoutCandidate),
  proposalId: zId.nullable(),
});
export type MarketplacePayoutToMatch = z.infer<typeof zMarketplacePayoutToMatch>;
// A platform's fee invoice that can clear fees waiting on 1388: `clearable` is what a clearing would take now (the smaller of what the invoice still has to clear and the platform's 1388 balance).
export const zMarketplaceInvoiceToClear = z.object({
  documentId: zId,
  legalEntityId: zId,
  platform: z.string(),
  platformName: z.string(),
  invoice: z.string(),
  date: zLocalDate,
  clearable: zMoney,
  proposalId: zId.nullable(),
});
export type MarketplaceInvoiceToClear = z.infer<typeof zMarketplaceInvoiceToClear>;
// A settlement that is half reversed (#3329): some of its month vouchers are reversed and some still stand. `standingMonths` is how many are left to reverse ("đảo dở: còn N tháng chưa đảo"), which the
// accountant does one by one (the payout, if any, first); the settlement's payout stays refused meanwhile.
export const zMarketplaceHalfReversed = z.object({
  settlementId: zId,
  legalEntityId: zId,
  platform: z.string(),
  platformName: z.string(),
  periodFrom: zLocalDate,
  periodTo: zLocalDate,
  standingMonths: z.number().int().min(1),
  reversedMonths: z.number().int().min(1),
});
export type MarketplaceHalfReversed = z.infer<typeof zMarketplaceHalfReversed>;
// The month-end accrual of the fees a platform kept whose invoice has not come (#2516 slice F, option 2): `amount` is the platform's debit balance on 331 at the end of `month`, read from the ledger when the
// list is read; `description` is the voucher's text with its stable key (the title says "Trích trước phí sàn tháng MM/YYYY, ước tính"). The screen asks for an ordinary general journal voucher Dr
// `expenseAccount` / Cr `accruedAccount` of that amount dated `date`; a person approves the lines.
export const zMarketplaceFeeAccrual = z.object({
  legalEntityId: zId,
  platform: z.string(),
  platformName: z.string(),
  month: zMonth,
  date: zLocalDate,
  amount: zMoney,
  expenseAccount: z.string(),
  accruedAccount: z.string(),
  description: z.string(),
  proposalId: zId.nullable(),
});
export type MarketplaceFeeAccrual = z.infer<typeof zMarketplaceFeeAccrual>;
// The reversal of a standing accrual, offered from the first day of the month after it (`reverseOn`): the screen asks for the generic `finance.journal.reverse` of `entryId`.
export const zMarketplaceFeeAccrualReversal = z.object({
  legalEntityId: zId,
  platform: z.string(),
  platformName: z.string(),
  month: zMonth,
  entryId: zId,
  amount: zMoney,
  reverseOn: zLocalDate,
  proposalId: zId.nullable(),
});
export type MarketplaceFeeAccrualReversal = z.infer<typeof zMarketplaceFeeAccrualReversal>;
export const zMarketplaceWorklist = z.object({
  postingConfirmed: z.boolean(),
  settlements: z.array(zMarketplaceSettlementToPost),
  payouts: z.array(zMarketplacePayoutToMatch),
  invoices: z.array(zMarketplaceInvoiceToClear),
  halfReversed: z.array(zMarketplaceHalfReversed),
  accruals: z.array(zMarketplaceFeeAccrual),
  accrualReversals: z.array(zMarketplaceFeeAccrualReversal),
});
export type MarketplaceWorklist = z.infer<typeof zMarketplaceWorklist>;

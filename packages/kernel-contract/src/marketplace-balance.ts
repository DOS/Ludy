// SPDX-License-Identifier: AGPL-3.0-only
// The Sàn screen's read (#2516 slice D, plan docs/plan/stock-and-marketplaces.md section 8.4, "The payout"): for each platform an entity sells on, where the platform's money stands in the books,
// read from the ledger by account and by the platform's party (ludy_finance.marketplace_party). Facts only: no model call, nothing stored, no buyer or order data. Amounts are decimal strings.
import { z } from 'zod';
import { zMonth } from './journal-voucher.ts';
import { MARKETPLACE_PAYOUT_ADJUSTMENTS_MAX } from './marketplace.ts';
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
  // How old the fees waiting on 331 are (#3711 slice 2, research A3): the date of the oldest fee debit no invoice has cleared (invoices clear the oldest first), the days from it to today, and whether that is
  // more than one settlement cycle (45 days, MARKETPLACE_FEE_CYCLE_DAYS), so the screen can flag a balance that should have been invoiced or paid. Null and false when no fee is waiting.
  oldestFeeDate: zLocalDate.nullable(),
  feesAgeDays: z.number().int().min(0).nullable(),
  feesOverdue: z.boolean(),
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
// `net` the sum of what their entries post (sales less seller discounts less refunds). A settlement with a sale that has no delivery day yet waits (`waitingLines` of them, no month), nothing to ask for; one whose sales lack a VAT rate for their delivery day waits too (`waitingVatMonths`).
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
  // The months (YYYY-MM) of a settlement that has its delivery days but whose sales have no VAT rate row for the day they were delivered (#4303 S3b): it waits, with nothing to ask for, until the rate is
  // entered in Settings (Kế toán). Empty when every day has a row (or the entity is not on the deduction method).
  waitingVatMonths: z.array(zMonth),
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
  // The lines a person must classify before asking for the payout (#4303 S4): a line with money the report does not explain (`other`, above zero) or tax withheld from a seller that is no household
  // (`withheld`). Empty when nothing needs it. The payout command refuses the request until every one of them is classified (finance.marketplace_payout.record, `adjustments`).
  adjustable: z.array(z.strictObject({ lineId: zId, source: z.enum(['other', 'withheld']), amount: zMoney })).max(MARKETPLACE_PAYOUT_ADJUSTMENTS_MAX),
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
// A marketplace line that came back and waits for a person to say whether its goods did (#4355): the platform's status only offers the question. `quantity` is the shipment's, in the item's unit; the
// order number is the platform's own, no buyer data is held anywhere. Answered with `marketplace.returns.decide`.
export const zMarketplaceReturnToConfirm = z.object({
  orderLineId: zId,
  legalEntityId: zId,
  platform: z.string(),
  platformName: z.string(),
  orderNo: z.string(),
  sku: z.string().nullable(),
  itemCode: z.string(),
  itemName: z.string(),
  unit: z.string(),
  quantity: z.string(),
  stage: z.enum(['returned', 'cancelled']),
  shippedAt: zLocalDate.nullable(),
});
export type MarketplaceReturnToConfirm = z.infer<typeof zMarketplaceReturnToConfirm>;
export const zMarketplaceWorklist = z.object({
  postingConfirmed: z.boolean(),
  // The same gate for the sales path alone: the settlement rows follow it (a settlement entry needs no payout or fee path, #4303 S3b).
  salesPostingConfirmed: z.boolean(),
  settlements: z.array(zMarketplaceSettlementToPost),
  payouts: z.array(zMarketplacePayoutToMatch),
  invoices: z.array(zMarketplaceInvoiceToClear),
  halfReversed: z.array(zMarketplaceHalfReversed),
  accruals: z.array(zMarketplaceFeeAccrual),
  accrualReversals: z.array(zMarketplaceFeeAccrualReversal),
  // The lines that came back and wait for "are the goods back?" (#4355): a stock question, not an account one, so it is not held by the account map's gate.
  returns: z.array(zMarketplaceReturnToConfirm),
});
export type MarketplaceWorklist = z.infer<typeof zMarketplaceWorklist>;

// The finance coworker's notes under the Sàn table (#3711 slice 7): a second read that loads the balance again on the server (so the model is told what the books say, never what the caller says) and, for each
// platform with fees waiting on its 331, answers one plain note on what they mean and what to do, or why there are none: `off` (no model), `busy` (too frequent), `budget` (the AI budget is spent), `failed`
// (the call failed or every note was dropped by the checks; the reason is logged as a code, never the words) or `none` (no platform has fees waiting). A note is keyed by the platform's row (its entity and
// platform); the model is told neither. The notes never change a figure or a flag and post nothing.
export const zMarketplaceFeeNotesAsk = z.strictObject({ legalEntityId: zId.optional(), lang: z.enum(['vi', 'en']).optional() });
export type MarketplaceFeeNotesAsk = z.infer<typeof zMarketplaceFeeNotesAsk>;
export const zMarketplaceFeeNotes = z.strictObject({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed', 'none']),
  notes: z.array(z.strictObject({ legalEntityId: zId, platform: z.string().max(40), text: z.string().max(480) })).max(200),
});
export type MarketplaceFeeNotes = z.infer<typeof zMarketplaceFeeNotes>;

// The finance coworker's note on a pending marketplace settlement or payout proposal (#4389, plan 8.6). `marketplace.proposalNote` loads the stored proposal in the caller's own context (the Inbox's visibility:
// another org or an entity outside the caller's scope is a 404; a visible proposal that is neither a settlement nor a payout, or is no longer pending, answers null) and computes every figure in code. `figures` is the fixed text of the proposal's figures, built in code. `note` is the model's wording, with no figure in it, when `ai` is `used`, else empty (`off` no model, `busy` too frequent, `budget` the AI budget is spent, `failed` the call failed or the checks refused the text; the reason is a code in the log, never the words).
// `uncertain` holds the Uncertain (#2520) points of the posting-map rows this proposal uses, chosen by code from a closed table whatever `ai` says. The note never changes the payload and has no action.
export const zMarketplaceProposalNoteAsk = z.strictObject({ proposalId: zId, lang: z.enum(['vi', 'en']).optional() });
export type MarketplaceProposalNoteAsk = z.infer<typeof zMarketplaceProposalNoteAsk>;
export const zMarketplaceProposalNote = z.strictObject({
  ai: z.enum(['used', 'off', 'busy', 'budget', 'failed']),
  kind: z.enum(['settlement', 'payout']),
  // The figures of the proposal in fixed wording, built in code from the stored proposal and always present (empty only when no figure is above zero).
  figures: z.string().max(600),
  // The model's wording of what drives the proposal, in at most three sentences with no digit; empty unless `ai` is `used`.
  note: z.string().max(480),
  uncertain: z.array(z.strictObject({ key: z.string().max(60), text: z.string().max(400) })).max(20),
});
export type MarketplaceProposalNote = z.infer<typeof zMarketplaceProposalNote>;

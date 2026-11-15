// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order reports (#2515, ADR-0045 points 5 and 7): what the Inbox shows of a report read from a file (the platform, the period, the orders and lines, how far they have got,
// what could not be read), the live check against the stock items before a member confirms, and the confirmed orders. No buyer data of any kind appears anywhere here: the importer
// never reads the report's buyer columns.
import { z } from 'zod';
import { zId, zJournalAmount, zJournalVoucherProposal, zLocalDate } from './schemas.ts';
import { zStockFactor } from './stock.ts';

export const MARKETPLACE_PLATFORM_KEYS = ['shopee', 'tiktok_shop', 'lazada'] as const;
export const MARKETPLACE_STAGE_KEYS = ['placed', 'shipped', 'completed', 'cancelled', 'returned', 'unknown'] as const;
export const zMarketplacePlatform = z.enum(MARKETPLACE_PLATFORM_KEYS);
export const zMarketplaceStage = z.enum(MARKETPLACE_STAGE_KEYS);

// What a staged read keeps next to its lines: the platform the headers say, the profile that read it (never confirmed against a real file until #2521), the period of the orders, how
// many of each stage, the status labels the profile did not know, and the rows that were no line of an order (a totals row), which the confirm step ignores.
// After the decision the same summary says what was stored: newLines (lines new to the org), updatedLines (a stage moved forward) and duplicateLines (already known, unchanged).
export const zMarketplaceSummary = z.object({
  state: z.enum(['staged', 'imported', 'rejected']),
  platform: zMarketplacePlatform,
  profileVersion: z.string(),
  profileConfirmed: z.boolean(),
  filename: z.string(),
  orders: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  from: zLocalDate.nullable(),
  to: zLocalDate.nullable(),
  stages: z.object({ placed: z.number().int(), shipped: z.number().int(), completed: z.number().int(), cancelled: z.number().int(), returned: z.number().int(), unknown: z.number().int() }),
  unknownStatuses: z.array(z.string().max(100)).max(20),
  ignoredRows: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative().optional(),
  updatedLines: z.number().int().nonnegative().optional(),
  duplicateLines: z.number().int().nonnegative().optional(),
  stockMoves: z.number().int().nonnegative().optional(),
});
export type MarketplaceSummary = z.infer<typeof zMarketplaceSummary>;

// A report waiting for a member, in the Inbox.
export const zMarketplaceStaged = z.object({
  fileId: zId,
  filename: z.string(),
  createdAt: z.string(),
  summary: zMarketplaceSummary,
  // The legal entity the orders would go to: the one the file was uploaded for (or the default), with its name as it is now.
  entity: z.object({ id: zId, name: z.string() }).nullable(),
});
export type MarketplaceStaged = z.infer<typeof zMarketplaceStaged>;

export const zMarketplacePreview = z.object({
  // Lines new to the org, lines already known (unchanged), and lines already known whose stage the report moves forward.
  newLines: z.number().int().nonnegative(),
  knownLines: z.number().int().nonnegative(),
  advancedLines: z.number().int().nonnegative(),
  // Of the lines that would move stock (shipped, completed or returned), how many name an item and how many none yet: the others wait in "Chưa gán hàng".
  matchedLines: z.number().int().nonnegative(),
  unmatchedLines: z.number().int().nonnegative(),
});
export type MarketplacePreview = z.infer<typeof zMarketplacePreview>;

export const zMarketplaceConfirmResult = z.object({ newLines: z.number().int(), updatedLines: z.number().int(), duplicateLines: z.number().int(), stockMoves: z.number().int() });
export type MarketplaceConfirmResult = z.infer<typeof zMarketplaceConfirmResult>;

export const zMarketplaceOrdersInput = z.strictObject({
  legalEntityId: zId.optional(),
  platform: zMarketplacePlatform.optional(),
  stage: zMarketplaceStage.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export const zMarketplaceOrder = z.object({
  id: zId,
  legalEntityId: zId,
  platform: zMarketplacePlatform,
  orderNo: z.string(),
  orderedAt: zLocalDate.nullable(),
  // How far the order has got: the furthest stage of its lines.
  stage: zMarketplaceStage,
  lines: z.array(
    z.object({
      id: zId,
      lineKey: z.string(),
      sku: z.string().nullable(),
      itemName: z.string().nullable(),
      quantity: z.string(),
      unitPrice: z.string().nullable(),
      amount: z.string().nullable(),
      stage: zMarketplaceStage,
      shippedAt: zLocalDate.nullable(),
      // The stock item the line moved, by its code, or null while it moved nothing.
      itemCode: z.string().nullable(),
    }),
  ),
});
export type MarketplaceOrder = z.infer<typeof zMarketplaceOrder>;

// The order lines that move stock (shipped, completed or returned) and name no item yet: they wait in "Chưa gán hàng" for a person to assign them (finance.marketplace.assign), which also
// teaches the SKU for the platform so the next report moves it by itself.
export const zMarketplaceUnassignedInput = z.strictObject({ legalEntityId: zId.optional(), limit: z.number().int().min(1).max(500).optional() });
export const zMarketplaceUnassignedLine = z.object({
  lineId: zId,
  legalEntityId: zId,
  platform: zMarketplacePlatform,
  orderNo: z.string(),
  orderedAt: zLocalDate.nullable(),
  sku: z.string().nullable(),
  itemName: z.string().nullable(),
  quantity: z.string(),
  stage: zMarketplaceStage,
});
export type MarketplaceUnassignedLine = z.infer<typeof zMarketplaceUnassignedLine>;

// factor: how many of the item's units one unit of the report's is (a carton of 12). teach: remember the SKU for this platform and item, which makes every later report with it move that
// item by itself at that factor. Off unless asked: a wrong item or factor cannot be undone yet (#2633), and a taught one would repeat on every report.
export const zMarketplaceAssign = z.strictObject({ lineId: zId, itemId: zId, factor: zStockFactor.default('1'), teach: z.boolean().default(false) });
export type MarketplaceAssign = z.infer<typeof zMarketplaceAssign>;

// Takes a line back from the item it was given (#2633): its stock comes back and it waits to be assigned again, by a person (a taught name no longer moves it). forget: also drop the name
// taught for its SKU when it is the one that put the line on this item, at this factor.
export const zMarketplaceUnassign = z.strictObject({ lineId: zId, forget: z.boolean().default(false) });
export type MarketplaceUnassign = z.infer<typeof zMarketplaceUnassign>;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// Income reports (#2516, ADR-0045 points 5 and 7): what a platform paid for the orders of a period, read from the platform's income file and staged until a member confirms. Like the
// order report, no buyer data of any kind appears here: the reader has no field for it.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// The platforms whose income files are read (Lazada has no profile until a real file decides its layout, #2521).
export const MARKETPLACE_INCOME_PLATFORM_KEYS = ['shopee', 'tiktok_shop'] as const;
export const zMarketplaceIncomePlatform = z.enum(MARKETPLACE_INCOME_PLATFORM_KEYS);
const zDecimal = z.string().regex(/^-?\d{1,16}(\.\d{1,4})?$/, 'decimal string');

// What a staged income read keeps next to its lines: the platform the headers say, the profile that read it (never confirmed against a real file until #2521), the period of the payments,
// the totals of every amount column of the lines, the net the file states for the whole report (null when it states none), and the rows that were no order's income (a totals row).
// After the decision the same summary says what was stored.
export const zMarketplaceIncomeSummary = z.object({
  state: z.enum(['staged', 'imported', 'rejected']),
  platform: zMarketplaceIncomePlatform,
  profileVersion: z.string(),
  profileConfirmed: z.boolean(),
  filename: z.string(),
  sheet: z.string().nullable(),
  orders: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative(),
  // The first and last payment date of the lines; null when a line has no payment date (the report cannot be confirmed then).
  periodStart: zLocalDate.nullable(),
  periodEnd: zLocalDate.nullable(),
  totals: z.object({
    sales: zDecimal,
    sellerDiscount: zDecimal,
    commission: zDecimal,
    serviceFee: zDecimal,
    paymentFee: zDecimal,
    shipping: zDecimal,
    taxWithheld: zDecimal,
    refund: zDecimal,
    // What no named column explains (the net the file states less what the columns say): shown so a person sees it.
    other: zDecimal,
    net: zDecimal,
  }),
  // The net the file states for the whole report, when it has exactly one totals row.
  statedNet: zDecimal.nullable(),
  ignoredRows: z.number().int().nonnegative(),
  // After the decision: the settlement that was stored (the kernel's statement_state keeps it as importId).
  importId: zId.optional(),
});
export type MarketplaceIncomeSummary = z.infer<typeof zMarketplaceIncomeSummary>;

export const zMarketplaceIncomeStaged = z.object({
  fileId: zId,
  filename: z.string(),
  createdAt: z.string(),
  summary: zMarketplaceIncomeSummary,
  // The legal entity the settlement would go to: the one the file was uploaded for (or the default), with its name as it is now.
  entity: z.object({ id: zId, name: z.string() }).nullable(),
});
export type MarketplaceIncomeStaged = z.infer<typeof zMarketplaceIncomeStaged>;

// Why a staged income report cannot be confirmed now, each a stable code the screen words:
// PERIOD_UNKNOWN (a line has no payment date), TOTAL_MISMATCH (the lines do not add up to the net the file states), UNKNOWN_ORDERS (an order the report names is not known: import the order
// report first), OVERLAP (a settlement of this platform already covers part of the period), REPEATED_LINES (a sale line is already stored in another settlement that stands).
export const MARKETPLACE_INCOME_BLOCKERS = ['PERIOD_UNKNOWN', 'TOTAL_MISMATCH', 'UNKNOWN_ORDERS', 'OVERLAP', 'REPEATED_LINES'] as const;
export const zMarketplaceIncomePreview = z.object({
  // The net the settlement would state: the file's own figure, or the sum of the lines when the file states none (then fileStatesNet is false, and the screen says so).
  reportNet: zDecimal,
  fileStatesNet: z.boolean(),
  linesNet: zDecimal,
  // Orders the report names that the org does not know yet (the first ten), and how many in all.
  unknownOrders: z.number().int().nonnegative(),
  unknownOrderNos: z.array(z.string()).max(10),
  // The standing settlement of this platform that overlaps the period, when there is one.
  overlap: z.object({ periodStart: zLocalDate, periodEnd: zLocalDate }).nullable(),
  repeatedLines: z.number().int().nonnegative(),
  blockers: z.array(z.enum(MARKETPLACE_INCOME_BLOCKERS)),
});
export type MarketplaceIncomePreview = z.infer<typeof zMarketplaceIncomePreview>;

export const zMarketplaceIncomeConfirmResult = z.object({ settlementId: zId, lines: z.number().int().nonnegative(), reportNet: zDecimal, other: zDecimal });
export type MarketplaceIncomeConfirmResult = z.infer<typeof zMarketplaceIncomeConfirmResult>;

// Days after a member's decision (import or skip) when the original file and the per-order amounts of a marketplace report are deleted (ADR-0045 point 8, #2516). The database
// (crove_finance.marketplace_retention_*) refuses anything shorter than 90, so a bug in the job can never delete early.
export const MARKETPLACE_ORIGINAL_RETENTION_DAYS = 90;

// The posting of a stored settlement (#2516, ADR-0045 point 6): ONE general journal voucher per settlement, Dr 131 (the platform) / Cr 511, or the reverse when the refunds and the seller discounts
// exceed the sales. A person asks for it with the settlement alone (kernel.proposal.request with command `finance.marketplace_settlement.record`); the server builds the entry from the stored
// lines, and builds it again when the proposal is approved, so the request carries nothing else. Nothing is requested or posted until the accountant has confirmed the account map (#2520).
// MARKETPLACE_POSTING_MAP_UNCONFIRMED (409), MARKETPLACE_POSTING_REGIME_UNKNOWN, MARKETPLACE_SETTLEMENT_NOT_POSTABLE, MARKETPLACE_SETTLEMENT_MISMATCH, PERIOD_LOCKED (409),
// MARKETPLACE_SETTLEMENT_POSTED (409), MARKETPLACE_SETTLEMENT_NOT_FOUND (404).
export const MARKETPLACE_SETTLEMENT_COMMAND = 'finance.marketplace_settlement.record';
export const zMarketplaceSettlementRequest = z.strictObject({ settlementId: zId });
export type MarketplaceSettlementRequest = z.infer<typeof zMarketplaceSettlementRequest>;
// The proposal (kind finance.journal_voucher, shown as one) with the settlement it posts, the platform and the period, and the settlement's sales, seller discounts and refunds in whole dong,
// so the refund stays visible beside the net. The platform's party on the 131 line is null until the platform's first posting creates it.
export const zMarketplaceSettlementProposal = zJournalVoucherProposal.extend({
  settlementId: zId,
  platform: zMarketplacePlatform,
  periodFrom: zLocalDate,
  periodTo: zLocalDate,
  sales: zJournalAmount,
  sellerDiscount: zJournalAmount,
  refund: zJournalAmount,
});
export type MarketplaceSettlementProposal = z.infer<typeof zMarketplaceSettlementProposal>;

// The posting of a platform's payout (#2516, ADR-0045 point 6, plan 8.4 "The payout"): ONE general journal voucher per settlement: Dr 112 for the money received, Dr 1388 for the platform's fees,
// Dr 333 for the tax the platform withheld, Cr 131 (the platform) for what the settlement posted there. A person asks for it with the settlement and the bank line of the platform's transfer
// (kernel.proposal.request with command `finance.marketplace_payout.record`); every amount comes from the stored settlement's lines, the bank line only has to be money in, equal to the net the
// settlement paid, and free. The server builds the entry again when the proposal is approved. Nothing is requested or posted until the accountant has confirmed the account map (#2520), and a
// payout whose settlement is not posted yet is refused: MARKETPLACE_PAYOUT_SETTLEMENT_NOT_POSTED (409). Other codes: MARKETPLACE_POSTING_MAP_UNCONFIRMED (409), MARKETPLACE_PAYOUT_NOT_POSTABLE (422),
// MARKETPLACE_PAYOUT_BANK_LINE (409 or 422), MARKETPLACE_PAYOUT_POSTED (409), MARKETPLACE_PAYOUT_MISMATCH (422), PERIOD_LOCKED (409), MARKETPLACE_SETTLEMENT_NOT_FOUND (404).
export const MARKETPLACE_PAYOUT_COMMAND = 'finance.marketplace_payout.record';
export const zMarketplacePayoutRequest = z.strictObject({ settlementId: zId, bankLineId: zId });
export type MarketplacePayoutRequest = z.infer<typeof zMarketplacePayoutRequest>;
// The proposal (kind finance.journal_voucher, shown as one) with the settlement it pays, the bank line, the platform and the period, and the split in whole dong: the money received, the fees and
// the withheld tax, so a person sees what the platform kept. The platform's party on the 131 and 1388 lines is the one the settlement's posting created.
export const zMarketplacePayoutProposal = zJournalVoucherProposal.extend({
  settlementId: zId,
  bankLineId: zId,
  platform: zMarketplacePlatform,
  periodFrom: zLocalDate,
  periodTo: zLocalDate,
  received: zJournalAmount,
  fees: zJournalAmount,
  taxWithheld: zJournalAmount,
});
export type MarketplacePayoutProposal = z.infer<typeof zMarketplacePayoutProposal>;

// The clearing of the fees a payout put on 1388 (#2516, plan 8.4 "The payout" and section 11): ONE general journal voucher, Dr 331 / Cr 1388 with the platform's party on both lines, built from the
// platform's fee e-invoice, a purchase document already posted (Dr expense, Dr 1331, Cr 331). A person asks for it with the document alone (kernel.proposal.request with command
// `finance.marketplace_fee_clearing.record`); the server builds the entry and builds it again when the proposal is approved. The amount is the smaller of what the invoice still has to clear (its
// credit to 331 less its standing clearings) and the platform's 1388 balance, in whole dong; an invoice may be cleared more than once, and the sum of its standing clearings never exceeds its
// credit to 331. Nothing is requested or posted until the accountant has confirmed the account map (#2520). MARKETPLACE_POSTING_MAP_UNCONFIRMED (409), MARKETPLACE_FEE_DOCUMENT (422),
// MARKETPLACE_FEE_NOTHING_TO_CLEAR (409), MARKETPLACE_FEE_MISMATCH (422), PERIOD_LOCKED (409).
export const MARKETPLACE_FEE_CLEARING_COMMAND = 'finance.marketplace_fee_clearing.record';
export const zMarketplaceFeeClearingRequest = z.strictObject({ purchaseDocumentId: zId });
export type MarketplaceFeeClearingRequest = z.infer<typeof zMarketplaceFeeClearingRequest>;
// The proposal (kind finance.journal_voucher, shown as one) with the invoice it clears, the platform, and the split in whole dong: the invoice's credit to 331, what its standing clearings took
// already, the platform's 1388 balance, and the amount cleared now.
export const zMarketplaceFeeClearingProposal = zJournalVoucherProposal.extend({
  purchaseDocumentId: zId,
  platform: zMarketplacePlatform,
  invoiceTotal: zJournalAmount,
  alreadyCleared: zJournalAmount,
  waiting: zJournalAmount,
  amount: zJournalAmount,
});
export type MarketplaceFeeClearingProposal = z.infer<typeof zMarketplaceFeeClearingProposal>;

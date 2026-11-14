// SPDX-License-Identifier: AGPL-3.0-only
// The Sàn screen's read (#2516 slice D, plan docs/plan/stock-and-marketplaces.md section 8.4, "The payout"): for each platform an entity sells on, where the platform's money stands in the books,
// read from the ledger by account and by the platform's party (crove_finance.marketplace_party). Facts only: no model call, nothing stored, no buyer or order data. Amounts are decimal strings.
import { z } from 'zod';
import { zId, zMoney } from './schemas.ts';

export const zMarketplaceBalanceInput = z.strictObject({ legalEntityId: zId.optional() });
export type MarketplaceBalanceInput = z.infer<typeof zMarketplaceBalanceInput>;

// One platform of one legal entity. `salesPosted` is what settlement entries debited to 131 for the platform (a reversed entry takes its amount back), `paidOut` what the platform's payouts
// cleared on 131, the whole credit (which also covers the fees and the tax the platform kept, so it is not the cash received; a reversed payout takes its amount back), `awaitingPayout` the difference, which is the platform's balance on 131: what the platform still owes the seller. `feesAwaitingInvoice`
// is the platform's balance on 1388: fees the platform kept at a payout whose invoice has not come yet. All four are zero until the entries that post them exist (the settlement and the payout
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
// of every entity the caller may see) that stand (not reversed, not a reversal) and have no posting voucher yet; `platforms` the platforms with a party link; `awaitingPayout` and
// `feesAwaitingInvoice` the sums of the balance rows (slice D). No platform name, order, buyer or bank data is in it, so there is nothing in it for a model to follow.
export const zMarketplaceFacts = z.strictObject({
  settlementsToPost: z.number().int().min(0),
  platforms: z.number().int().min(0),
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

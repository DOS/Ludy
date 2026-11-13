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

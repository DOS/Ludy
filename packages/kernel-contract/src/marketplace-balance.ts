// SPDX-License-Identifier: AGPL-3.0-only
// What each marketplace owes the business (#2516 slice D, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4), read from the ledger: the settlement entries debit account 131 with the platform's
// organization party (crove_finance.marketplace_party), the payout matches credit it, and the fees whose invoice has not come wait in account 1388 under the same party. So a platform's balance is a
// sum of journal lines by account and party, never a second record: `sales` is the debit of 131, `payouts` its credit (what the transfers, the fees and the tax the platform withheld settled), `owed`
// the difference, what the platform still owes the business, and `feesAwaitingInvoice` the balance of 1388, fees paid or netted whose own invoice has not arrived. Amounts are decimal strings. The
// list holds every platform the entity has orders, settlements or a party for, so it shows zeros until the first settlement is posted. Facts only: no model is asked.
import { z } from 'zod';
import { zId, zLocalDate, zMoney } from './schemas.ts';

export const zMarketplaceBalanceGet = z.strictObject({ legalEntityId: zId.optional(), asOf: zLocalDate.optional() });
export type MarketplaceBalanceGet = z.infer<typeof zMarketplaceBalanceGet>;

const zFigures = { sales: zMoney, payouts: zMoney, owed: zMoney, feesAwaitingInvoice: zMoney };
export const zMarketplacePlatformBalance = z.strictObject({
  // The platform's id as the reports name it (shopee, tiktok_shop, lazada, or a later one).
  platform: z.string(),
  // The organization party that stands for the platform (marketplace_party), once the platform has one; null before.
  partyId: zId.nullable(),
  partyName: z.string().nullable(),
  ...zFigures,
});
export type MarketplacePlatformBalance = z.infer<typeof zMarketplacePlatformBalance>;
export const zMarketplaceBalance = z.strictObject({
  legalEntityId: zId,
  // The day the balances are as of: entries dated on or before it.
  asOf: zLocalDate,
  platforms: z.array(zMarketplacePlatformBalance),
  totals: z.strictObject(zFigures),
});
export type MarketplaceBalance = z.infer<typeof zMarketplaceBalance>;

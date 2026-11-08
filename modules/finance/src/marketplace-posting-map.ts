// SPDX-License-Identifier: AGPL-3.0-only
// The account map of a marketplace's money (#2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4), keyed by the books regime like PAYROLL_POSTING_MAPS.
// Every row is `commentary`: from the plan's text, not yet confirmed by the accountant (#2520). Until a person flips a map to `confirmed` (a reviewed change of this file), nothing is
// posted from it: requireConfirmedMarketplaceMap refuses with MARKETPLACE_POSTING_MAP_UNCONFIRMED, as hr and finance do for the pay accounts (HR_POSTING_MAP_UNCONFIRMED).
import { DomainError } from '@crove/kernel-runtime';

export type MarketplaceMapStatus = 'commentary' | 'confirmed';

export interface MarketplaceAccount {
  code: string;
  status: MarketplaceMapStatus;
  comment: string;
}

export interface MarketplacePostingMap {
  regime: string;
  status: MarketplaceMapStatus;
  // The platform's balance, a party of kind marketplace: sales awaiting payout (section 8.4, "Income reports").
  receivable: MarketplaceAccount;
  // The sales the platform paid for, net of the seller's own discounts.
  revenue: MarketplaceAccount;
  // The money received at the payout (a later slice).
  cash: MarketplaceAccount;
  // The platform's fees already invoiced (a later slice).
  feePayable: MarketplaceAccount;
  // The platform's fees whose invoice has not arrived (a later slice).
  feeAwaitingInvoice: MarketplaceAccount;
  // Tax the platform withheld and settled for the seller (a later slice).
  taxWithheld: MarketplaceAccount;
}

const row = (code: string, comment: string): MarketplaceAccount => ({ code, status: 'commentary', comment });

export const MARKETPLACE_POSTING_MAPS: Readonly<Record<string, MarketplacePostingMap>> = {
  tt133: {
    regime: 'tt133',
    status: 'commentary',
    receivable: row('131', 'Plan 8.4 Income reports: Dr 131, the platform as a party of kind marketplace.'),
    revenue: row('511', 'Plan 8.4 Income reports: Cr 511 for the sales it paid for net of the seller discounts; the recognition point is for the accountant (section 11).'),
    cash: row('112', 'Plan 8.4 The payout: Dr 112 for the money received.'),
    feePayable: row('331', 'Plan 8.4 The payout: Dr 331 (the platform) for fees already invoiced.'),
    feeAwaitingInvoice: row('1388', 'Plan 8.4 The payout: Dr 1388 for fees whose invoice has not come; the platform fee e-invoice clears it.'),
    taxWithheld: row('333', 'Plan 8.4 The payout: Dr 333 for tax the platform withheld and settled for the seller.'),
  },
};

// The gate: a regime with no map is refused as unknown, one whose map is not `confirmed` as waiting for the accountant. Returns the map so the caller builds from what it checked.
export function requireConfirmedMarketplaceMap(regime: string, maps: Readonly<Record<string, MarketplacePostingMap>> = MARKETPLACE_POSTING_MAPS): MarketplacePostingMap {
  const map = Object.hasOwn(maps, regime) ? maps[regime] : undefined;
  if (!map) throw new DomainError('MARKETPLACE_POSTING_REGIME_UNKNOWN', 422, 'Chế độ kế toán này chưa có bảng tài khoản hạch toán tiền của sàn', { regime });
  if (map.status !== 'confirmed') {
    throw new DomainError('MARKETPLACE_POSTING_MAP_UNCONFIRMED', 409, 'Bảng tài khoản hạch toán tiền của sàn chưa được kế toán xác nhận: chờ kế toán xác nhận', { regime });
  }
  return map;
}

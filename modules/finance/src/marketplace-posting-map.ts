// SPDX-License-Identifier: AGPL-3.0-only
// The account map of a marketplace's money (#2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4), keyed by the books regime like PAYROLL_POSTING_MAPS.
// Every row is `commentary`: from the plan's text, not yet confirmed by the accountant (#2520). Until a person flips a map to `confirmed` (a reviewed change of this file), nothing is
// posted from it: requireConfirmedMarketplaceMap refuses with MARKETPLACE_POSTING_MAP_UNCONFIRMED, as hr and finance do for the pay accounts (HR_POSTING_MAP_UNCONFIRMED).
// The gate is per path (#3711 slice 1): each posting asks only for the rows it uses, so a path opens when ITS rows are confirmed and the household tax path (whose debit account is still the
// accountant's choice) stays closed without holding the rest.
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
  // The platform's balance, an organization party linked through marketplace_party: sales awaiting payout (section 8.4, "Income reports").
  receivable: MarketplaceAccount;
  // The sales the platform paid for, net of the seller's own discounts.
  revenue: MarketplaceAccount;
  // A sale the platform refunded within the settlement: under TT133 there is no 521, so the return reduces 511 directly (rule for the accountant, #2520).
  salesReturn: MarketplaceAccount;
  // The money received at the payout (a later slice).
  cash: MarketplaceAccount;
  // The platform's fees already invoiced (a later slice).
  feePayable: MarketplaceAccount;
  // The platform's fees whose invoice has not arrived (a later slice).
  feeAwaitingInvoice: MarketplaceAccount;
  // Tax the platform withheld and settled for the seller (a later slice).
  taxWithheld: MarketplaceAccount;
  // The VAT the platform withheld for a household seller, credited at the settlement posting (#2516 slice C2; the payout debits it, so it nets to zero): Dr 511 / Cr 3331.
  vatPayable: MarketplaceAccount;
  // The PIT the platform withheld for a household seller, credited at the settlement posting: Dr pitOwnerEquity / Cr 3335.
  pitPayable: MarketplaceAccount;
  // The debit side of that PIT. The PIT of a household is NEVER an expense of the business: the owner's equity in the internal ledger bears it (research A4 and D2, docs/plan/accounting-rules-research-2026-11-18.md).
  // Which account is the accountant's call (#2520); the row is a proposal and stays `commentary`, so the household tax path stays closed until it is named.
  pitOwnerEquity: MarketplaceAccount;
  // The platform fees accrued at month end for an invoice that has not come (#2516 slice F), a general journal voucher a person approves: Dr feeExpense / Cr accruedExpense. 6421 under TT133 (641 under
  // TT99, for which no marketplace map exists yet).
  feeExpense: MarketplaceAccount;
  accruedExpense: MarketplaceAccount;
}

// Frozen at runtime too, so no caller flips a status in place: a map is confirmed only by a reviewed change of this file.
function deepFreeze<T extends object>(value: T): T {
  for (const v of Object.values(value)) if (v !== null && typeof v === 'object') deepFreeze(v);
  return Object.freeze(value);
}

const row = (code: string, comment: string): MarketplaceAccount => ({ code, status: 'commentary', comment });

export const MARKETPLACE_POSTING_MAPS: Readonly<Record<string, MarketplacePostingMap>> = deepFreeze({
  tt133: {
    regime: 'tt133',
    status: 'commentary',
    receivable: row('131', 'Plan 8.4 Income reports: Dr 131, the platform as an organization party linked through crove_finance.marketplace_party (plan line 149).'),
    revenue: row('511', 'Plan 8.4 Income reports: Cr 511 for the sales it paid for net of the seller discounts; the recognition point is for the accountant (section 11).'),
    salesReturn: row('511', 'PO rule: an order the platform refunded was not paid for, so Cr 511 is reduced by the refund (no 521 under TT133); a refund of an earlier period sale reduces 511 in the period the refund occurs (usual practice; only a material prior-year error is restated); refunds and discounts above the sales post the other way, Dr 511 / Cr 131. For the accountant to confirm (#2520).'),
    cash: row('112', 'Plan 8.4 The payout: Dr 112 for the money received.'),
    feePayable: row('331', 'Plan 8.4 The payout: Dr 331 (the platform) for fees already invoiced.'),
    feeAwaitingInvoice: row('1388', 'Plan 8.4 The payout: Dr 1388 for fees whose invoice has not come; the platform fee e-invoice clears it.'),
    taxWithheld: row('333', 'Plan 8.4 The payout: Dr 333 for tax the platform withheld and settled for the seller.'),
    vatPayable: row('3331', 'AI consensus 2026-11-15 (A4): a household seller credits 3331 for the VAT the platform withheld at the settlement posting (Dr 511), so the payout debit nets it to zero.'),
    pitPayable: row('3335', 'AI consensus 2026-11-15 (A4): a household seller credits 3335 for the PIT the platform withheld at the settlement posting, so the payout debit nets it to zero.'),
    feeExpense: row('6421', 'AI consensus 2026-11-15 (A1, A2): the platform fees accrued at month end for an invoice that has not come are expensed Dr 6421 under TT133 (641 under TT99), the invoice later nets itself against 331.'),
    accruedExpense: row('335', 'AI consensus 2026-11-15 (A1): Cr 335 for that accrual; it is reversed on the first day of the next month so the invoice\'s own expense is not counted twice.'),
    pitOwnerEquity: row('4212', 'Research 2026-11-18 (A4, D2): the PIT a platform withheld on a household\'s revenue is never an expense; it is booked against the owner\'s equity in the internal ledger, Dr this account / Cr 3335. 4212 is a proposal: the accountant names the account (#2520, #3711), and until then this row stays commentary and the household tax path is closed. It replaces the earlier proposal of 6422 (an expense), which no posting ever used because the gate was closed.'),
  },
  // Circular 99/2025/TT-BTC (#3711 slice 4). The same shape as tt133, from the same research (docs/plan/accounting-rules-research-2026-11-18.md, A1, A5, C3): the platform's fees are a selling expense (641, sub-account 6417
  // "Chi phí dịch vụ mua ngoài", not 6421, which is staff cost in this chart), accrued to 335 at month end; a sale the platform refunded is a deduction from revenue on 521, not 511. Every row is `commentary`, so no path
  // opens from this map until the accountant confirms it (#2520); every code below is in the TT99 2026.1 chart (pinned by finance-marketplace-map-chart.db.test.ts). The settlement posting nets a refund into the revenue line
  // today (the TT133 rule), so a TT99 settlement that carries a refund is refused (MARKETPLACE_SETTLEMENT_NOT_POSTABLE, REFUND_ACCOUNT) until the 521 split is built.
  tt99: {
    regime: 'tt99',
    status: 'commentary',
    receivable: row('131', 'Same as tt133 (plan 8.4 Income reports): Dr 131, the platform as an organization party linked through crove_finance.marketplace_party.'),
    revenue: row('511', 'Same as tt133: Cr 511 for the sales the platform paid for net of the seller discounts; the recognition point is the successful delivery (research A5).'),
    salesReturn: row('521', 'Research C3: under Circular 99 a refunded sale is a deduction from revenue on 521, where TT133 has none and reduces 511. Not posted yet: the settlement posting refuses a refund under this map until the split exists.'),
    cash: row('112', 'Same as tt133: Dr 112 for the money received at the payout.'),
    feePayable: row('331', 'Research A1: the payout debits 331 of the platform for the fees it kept; the platform\'s fee invoice credits it (Dr 641 / Dr 1331 / Cr 331).'),
    feeAwaitingInvoice: row('1388', 'Retired with the fee clearing path (#3315): the fees wait on 331, never on 1388 (research A1). The row stays only while the retired code reads it.'),
    taxWithheld: row('333', 'Same as tt133: unused, the withheld tax goes through 3331 and 3335 at the settlement posting.'),
    vatPayable: row('3331', 'Same as tt133 (research A4): a household seller credits 3331 for the VAT the platform withheld at the settlement posting.'),
    pitPayable: row('3335', 'Same as tt133 (research A4): a household seller credits 3335 for the PIT the platform withheld at the settlement posting.'),
    feeExpense: row('6417', 'Research A1: the fees accrued at month end for an invoice that has not come are Dr 641 (sub-account 6417, Chi phí dịch vụ mua ngoài) under Circular 99; 6421 is staff cost in the TT99 chart, so it is not used here.'),
    accruedExpense: row('335', 'Research A1: Cr 335 for that accrual, reversed on the first day of the next month so the invoice\'s own expense is not counted twice.'),
    pitOwnerEquity: row('4212', 'Research A4, D2: the PIT a platform withheld on a household\'s revenue is never an expense; booked against the owner\'s equity. 4212 is a proposal: the accountant names the account (#2520, #3711), and the household tax path stays closed until then.'),
  },
});

// The postings a map gates, each with the rows it posts to (#3711 slice 1). `sales`: the settlement voucher without household tax (131 against 511, a refund reducing 511). `payout`: the money received
// (cash, fees against the platform's 331, 131 cleared). `fee_accrual`: the month-end accrual of fees not yet invoiced (expense against 335). `household_tax`: the VAT and PIT a platform withheld for a
// household seller, in the settlement voucher and again in the payout; its debit side is the owner's equity (pitOwnerEquity), not an expense. 333 and the retired 1388 row belong to no path.
export type MarketplacePath = 'sales' | 'payout' | 'fee_accrual' | 'household_tax';
type MarketplaceRow = 'receivable' | 'revenue' | 'salesReturn' | 'cash' | 'feePayable' | 'feeAwaitingInvoice' | 'taxWithheld' | 'vatPayable' | 'pitPayable' | 'pitOwnerEquity' | 'feeExpense' | 'accruedExpense';

export const MARKETPLACE_PATH_ROWS: Readonly<Record<MarketplacePath, readonly MarketplaceRow[]>> = Object.freeze({
  sales: Object.freeze<MarketplaceRow[]>(['receivable', 'revenue', 'salesReturn']),
  payout: Object.freeze<MarketplaceRow[]>(['receivable', 'cash', 'feePayable']),
  fee_accrual: Object.freeze<MarketplaceRow[]>(['feeExpense', 'accruedExpense']),
  household_tax: Object.freeze<MarketplaceRow[]>(['vatPayable', 'pitPayable', 'pitOwnerEquity']),
});

const ALL_ROWS: readonly MarketplaceRow[] = ['receivable', 'revenue', 'salesReturn', 'cash', 'feePayable', 'feeAwaitingInvoice', 'taxWithheld', 'vatPayable', 'pitPayable', 'pitOwnerEquity', 'feeExpense', 'accruedExpense'];

// The gate: a regime with no map is refused as unknown, one whose map or the rows of the asked paths are not `confirmed` as waiting for the accountant. Returns the map so the caller builds from what it
// checked. Without `paths` every row is asked (the retired fee clearing still does); a path asks only for its own rows, and the map's own status must be confirmed for any of them.
export function requireConfirmedMarketplaceMap(
  regime: string,
  maps: Readonly<Record<string, MarketplacePostingMap>> = MARKETPLACE_POSTING_MAPS,
  paths?: readonly MarketplacePath[],
): MarketplacePostingMap {
  const map = Object.hasOwn(maps, regime) ? maps[regime] : undefined;
  if (!map) throw new DomainError('MARKETPLACE_POSTING_REGIME_UNKNOWN', 422, 'Chế độ kế toán này chưa có bảng tài khoản hạch toán tiền của sàn', { regime });
  // The map and the accounts a proposal posts to must all be confirmed, so flipping only the top flag does not open the gate.
  const names = paths ? [...new Set(paths.flatMap((path) => MARKETPLACE_PATH_ROWS[path]))] : ALL_ROWS;
  if (map.status !== 'confirmed' || names.some((name) => map[name].status !== 'confirmed')) {
    throw new DomainError('MARKETPLACE_POSTING_MAP_UNCONFIRMED', 409, 'Bảng tài khoản hạch toán tiền của sàn chưa được kế toán xác nhận: chờ kế toán xác nhận', { regime });
  }
  return map;
}

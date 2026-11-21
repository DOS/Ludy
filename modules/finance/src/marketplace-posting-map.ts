// SPDX-License-Identifier: AGPL-3.0-only
// The account map of a marketplace's money (#2516, ADR-0045 point 6, plan docs/plan/stock-and-marketplaces.md section 8.4), keyed by the books regime like PAYROLL_POSTING_MAPS.
// The accounts are the researched rules of docs/research/marketplace-accounting-2026-11-21.md (owner decision 2026-11-21: do not wait for the accountant, apply the public law and mark what is uncertain;
// #2520, #4303). A path flips to `confirmed` only in the change whose postings match the rules it names: the SALES path (receivable, revenue, salesReturn, outputVat) flipped in #4303 S3b, the output VAT split of
// the settlement entry; every other row stays `commentary` (payout, fee accrual, household tax; S4 for lost goods and incentives), so those paths are refused with MARKETPLACE_POSTING_MAP_UNCONFIRMED, as hr and finance
// do for the pay accounts (HR_POSTING_MAP_UNCONFIRMED), until their own change. The map's own `confirmed` flag only lets a path whose rows are all confirmed open. A comment that
// starts `Uncertain (#2520)` names a point the research itself leaves open (L: a legal reading, F: what a platform field means in a real export); the research file lists them all.
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
  // Rule 1 (research file): the output VAT inside a sale's price net of the seller's voucher, Cr 33311 beside Cr revenue; the sales path splits it from #4303 S3.
  outputVat: MarketplaceAccount;
  // Rule 3: the input VAT of a platform fee on a VAT invoice, Dr 1331 beside the fee expense, Cr 331. The fee invoice is an ordinary purchase invoice; the row names the account the rule uses.
  feeInputVat: MarketplaceAccount;
  // Rule 2 and rule 4: what the platform or carrier owes the seller that is not a sale. Goods lost or damaged by the carrier: Dr this account for the compensation, Cr costOfGoods up to the cost already booked at shipment, the excess to otherIncome;
  // tax the platform withheld from a company by mistake (a company is never withheld): Dr this account / Cr receivable. Not a prepayment of tax. #4303 S4 posts it.
  otherReceivable: MarketplaceAccount;
  // Rule 2: goods missing until the claim is decided (Dr this account / Cr 632 at the loss, then the compensation clears it).
  assetAwaitingHandling: MarketplaceAccount;
  // Rule 2: the cost already in the cost of goods sold at shipment, reduced by the compensation for lost goods (no output VAT, no invoice, input VAT stays deductible).
  costOfGoods: MarketplaceAccount;
  // Rules 2 and 3: the compensation above cost, and a seller incentive not tied to a sale (a platform price subsidy tied to an order is revenue, rule 1).
  otherIncome: MarketplaceAccount;
  // Rule 7: a 1-dong difference between the invoice and the settlement, in whole dong (the books are in whole dong; no general VAT rounding rule exists).
  otherExpense: MarketplaceAccount;
}

// Frozen at runtime too, so no caller flips a status in place: a map is confirmed only by a reviewed change of this file.
function deepFreeze<T extends object>(value: T): T {
  for (const v of Object.values(value)) if (v !== null && typeof v === 'object') deepFreeze(v);
  return Object.freeze(value);
}

const row = (code: string, comment: string): MarketplaceAccount => ({ code, status: 'commentary', comment });
// A row the owner decided to apply without waiting for the accountant (#4303, 2026-11-21): `confirmed` for the path whose postings match its researched rule; its comment keeps every `Uncertain (#2520)` point.
const confirmedRow = (code: string, comment: string): MarketplaceAccount => ({ code, status: 'confirmed', comment });

const R = 'docs/research/marketplace-accounting-2026-11-21.md';

export const MARKETPLACE_POSTING_MAPS: Readonly<Record<string, MarketplacePostingMap>> = deepFreeze({
  // Circular 133/2016/TT-BTC (the SME books), the researched rules of the research file (#4303).
  tt133: {
    regime: 'tt133',
    status: 'confirmed',
    receivable: confirmedRow('131', `Rule 6 (${R}): a delivered order not yet paid out is a receivable on 131, one party per platform (crove_finance.marketplace_party); the paid flag changes nothing until the money arrives (Dr 112, Dr 331 / Cr 131). Uncertain (#2520, L): 1388 also looks defensible as the clearing account (research B, medium); 131 is the default.`),
    revenue: confirmedRow('5111', `Rule 1: Cr 5111 (Doanh thu bán hàng hóa) for the item price minus the SELLER's voucher, VAT included in the price; the PLATFORM's voucher stays in revenue and in the VAT base and is owed by the platform (Dr 131). Rule 5: on the delivery date, the TT133 default too (Art. 57.1.2.a points to the end of the return window; the same default as TT99 keeps the reports comparable). Uncertain (#2520): L no ruling found on a platform voucher; F only Shopee's invoice base is first-party, Lazada and TikTok Shop split and coin semantics are unverified; L the end-of-return-window reading of Art. 57.`),
    salesReturn: confirmedRow('5111', `Rule 8: TT133 has no 521, so a return or refund reduces 5111 in the period it happens, with an adjusting invoice declared when issued (Dr 5111, Dr 33311 / Cr 131; and Dr 156 / Cr 632 for the goods back, a stock effect this map does not post). No written buyer agreement is needed on a platform. Uncertain (#2520): L the corporate income tax effect of a return after the year closed; F who funds a refund (a goodwill refund funded by the platform is not the seller's deduction).`),
    cash: row('112', `Rule 6: Dr 112 for the money received at the payout, with Dr 331 for the fees the platform kept, clearing 131.`),
    feePayable: row('331', `Rule 3: the platform's fees are payable on 331 (Dr 6421 and 1331 / Cr 331 on its fee invoice) and are netted at the payout. Uncertain (#2520): L whether netting at the payout counts as a non-cash payment for the 1331 deduction (Decree 181 Art. 26.2.a, research B medium); F who issues TikTok Shop fee invoices (neither pass confirmed it) and Lazada's issuer.`),
    feeAwaitingInvoice: row('1388', `Retired with the fee clearing path (#3315): fees wait on 331 and the month-end accrual on 335, never on 1388 (research A1). The row stays only while the retired code reads it; it is NOT the 1388 of otherReceivable.`),
    taxWithheld: row('333', `Unused: the withheld tax of a household goes through 3331 and 3335 (vatPayable, pitPayable); a company is never withheld (rule 4).`),
    vatPayable: row('3331', `Rule 4: only a household, individual or foreign seller is withheld; the VAT the platform withheld is tax already paid: Dr 3331 / Cr 131 (Cr 3331 at the settlement posting so the payout debit nets it to zero). A Vietnamese company is never withheld. Uncertain (#2520): L research A and B differ on whether Decree 252 repeats Decree 117 Art. 11.4 ("no second declaration"); L Circular 89/2026 and Decree 174/2025 not opened; F every platform withholding field is low confidence (Lazada VAT_in_amount is probably VAT inside a fee; TikTok Shop local_vat_amount may be VAT on fees).`),
    pitPayable: row('3335', `Rule 4: the PIT the platform withheld for a household, tax already paid: Dr 3335 / Cr 131 at the payout, credited at the settlement posting so it nets to zero. Uncertain (#2520): same as vatPayable; L the household PIT cut of Decree 398/2026.`),
    feeExpense: row('6421', `Rule 3: the platform's fees are expensed Dr 6421 (TT133) with input VAT 1331, through 331; the month-end accrual for an invoice that has not come is Dr 6421 / Cr 335, reversed on the first day of the next month so the invoice's own expense is not counted twice. Uncertain (#2520): L the VAT rate per fee type (8% or 10%, Resolution 204/2025 keeps 8% for most goods until 2026-12-31).`),
    accruedExpense: row('335', `Rule 3: Cr 335 for the month-end fee accrual; reversed on the first day of the next month.`),
    pitOwnerEquity: row('4212', `Rule 4 (research A4, D2): the PIT a platform withheld on a household's revenue is never an expense of the business; it is booked against the owner's equity in the internal ledger, Dr this account / Cr 3335. Uncertain (#2520, L): 4212 is a proposal, the accountant names the account; this row keeps the household tax path closed until then.`),
    outputVat: confirmedRow('33311', `Rule 1: the output VAT inside the item price net of the seller's voucher, Cr 33311 beside Cr 5111, at the item's VAT rate (never a hard-coded 8% or 10%); the sales path splits it from #4303 S3. A line with no known rate is held back, never guessed.`),
    feeInputVat: row('1331', `Rule 3: the input VAT of a platform fee on a VAT invoice, Dr 1331 beside the fee expense / Cr 331; a fee rebate with an adjusting invoice reduces the expense and 1331. Uncertain (#2520): the VAT rate per fee type on all three platforms.`),
    otherReceivable: row('1388', `Rule 2: goods lost or damaged by the carrier, cost already in 632 at shipment: Dr 1388 (the platform) for the compensation / Cr 632, any excess Cr 711. Rule 4: tax withheld from a company by mistake: Dr 1388 / Cr 131 (not a prepayment). No output VAT, no invoice; input VAT stays deductible. Uncertain (#2520): L net into 632 against gross into 711 (research A: the accountant's choice, B: net); F whether the compensation is paid at the selling price for a buyer who received the goods; L household VAT on a compensation; CIT deduction of a carrier loss.`),
    assetAwaitingHandling: row('1381', `Rule 2, the optional first step while a claim is not yet decided: the loss waits on 1381 (Tài sản thiếu chờ xử lý), Dr 1381 / Cr 632 at the loss; when the claim is decided the compensation clears it (Dr 1388 / Cr 1381 up to the loss) and any excess over the cost is other income (Cr 711), the same entries as the direct route of otherReceivable. Uncertain (#2520): the table gives only the direct route (Dr 1388 / Cr 632, excess 711); the 1381 step is the research's wording for an undecided claim, and S4 posts one route, not both.`),
    costOfGoods: row('632', `Rule 2: the compensation for lost goods reduces 632 up to the cost already booked at shipment (Cr 632).`),
    otherIncome: row('711', `Rules 2 and 3: the compensation above cost, and a seller incentive not tied to a sale, are other income (Cr 711); a platform price subsidy tied to an order is revenue instead (rule 1). Uncertain (#2520): L whether an incentive is 711 or a taxed service; L/F whether a fee rebate arrives as an adjusting invoice or as a bonus.`),
    otherExpense: row('811', `Rule 7: the books are in whole dong; a 1-dong difference between an invoice and the settlement goes to 811 (or 711 the other way). Uncertain (#2520): L no general VAT rounding rule exists; research A and B differ on where the dong goes (A: half up, remainder on the last line; B: into the net amount, not the VAT); F the tax XML schema may limit decimals.`),
  },
  // Circular 99/2025/TT-BTC (#3711 slice 4). The same rules, with the TT99 accounts (research file): the platform's fees are a selling expense (641, sub-account 6417 "Chi phí dịch vụ mua ngoài", not 6421, which is
  // staff cost in this chart), accrued to 335 at month end; a sale the platform refunded is a deduction from revenue on 521 (closed to 511), not a reduction of 511. Every row is `commentary`, so no path opens from
  // this map until the change whose postings match its rules; every code below is in the TT99 2026.1 chart (pinned by finance-marketplace-map-chart.db.test.ts). The settlement posting books a refund as its own
  // debit line on the map's salesReturn account when that differs from the revenue account (#4017): Dr 131 + Dr 521 / Cr 511; under TT133 it still nets the refund into 5111.
  tt99: {
    regime: 'tt99',
    status: 'confirmed',
    receivable: confirmedRow('131', `Same as tt133 (rule 6): Dr 131, the platform as an organization party linked through crove_finance.marketplace_party, one per platform.`),
    revenue: confirmedRow('511', `Same as tt133 (rule 1) on 511: item price minus the seller's voucher, VAT included; the platform's voucher stays in revenue; recognized on the delivery date (rule 5, research A5; TT99 dropped the TT133 Art. 57 return-window clause). Uncertain (#2520): the same voucher points as tt133; F whether the platform's "completed" or the carrier's "delivered" status is the better proxy for delivery.`),
    salesReturn: confirmedRow('521', `Rule 8 (research C3): under Circular 99 a refunded sale is a deduction from revenue on 521, closed to 511 (Dr 521, Dr 33311 / Cr 131; Dr 156 / Cr 632 for the goods back, a stock effect this map does not post). The settlement posting books a refund as its own debit line here (#4017): Dr 131 (net) + Dr 521 / Cr 511. Uncertain (#2520): L Circular 91 Art. 10.5.c was read by research A only through summaries.`),
    cash: row('112', `Same as tt133 (rule 6): Dr 112 for the money received at the payout.`),
    feePayable: row('331', `Same as tt133 (rule 3, research A1): the payout debits 331 of the platform for the fees it kept; the platform's fee invoice credits it (Dr 641 / Dr 1331 / Cr 331). Uncertain (#2520): the same fee points as tt133.`),
    feeAwaitingInvoice: row('1388', `Retired with the fee clearing path (#3315): the fees wait on 331, never on 1388 (research A1). The row stays only while the retired code reads it; it is NOT the 1388 of otherReceivable.`),
    taxWithheld: row('333', `Same as tt133: unused, the withheld tax goes through 3331 and 3335 at the settlement posting; a company is never withheld (rule 4).`),
    vatPayable: row('3331', `Same as tt133 (rule 4): a household seller credits 3331 for the VAT the platform withheld, tax already paid (Dr 3331 / Cr 131 at the payout). Uncertain (#2520): the same as tt133.`),
    pitPayable: row('3335', `Same as tt133 (rule 4): a household seller credits 3335 for the PIT the platform withheld, tax already paid. Uncertain (#2520): the same as tt133.`),
    feeExpense: row('6417', `Rule 3 (research A1): the platform's fees are Dr 641 (sub-account 6417, Chi phí dịch vụ mua ngoài; ads 6418) with input VAT 1331, through 331; 6421 is staff cost in the TT99 chart, so it is not used. The month-end accrual for an invoice that has not come is Dr 6417 / Cr 335. Uncertain (#2520): the VAT rate per fee type; F who issues TikTok Shop fee invoices.`),
    accruedExpense: row('335', `Same as tt133 (rule 3, research A1): Cr 335 for the month-end fee accrual, reversed on the first day of the next month.`),
    pitOwnerEquity: row('4212', `Same as tt133 (rule 4, research A4, D2): the PIT a platform withheld on a household's revenue is booked against the owner's equity, never as an expense. Uncertain (#2520, L): 4212 is a proposal, the accountant names the account; the household tax path stays closed until then.`),
    outputVat: confirmedRow('33311', `Same as tt133 (rule 1): Cr 33311 for the output VAT inside the item price net of the seller's voucher, at the item's VAT rate; the sales path splits it from #4303 S3.`),
    feeInputVat: row('1331', `Same as tt133 (rule 3): Dr 1331 for the input VAT of a platform fee on a VAT invoice, beside Dr 6417.`),
    otherReceivable: row('1388', `Same as tt133 (rules 2 and 4): the compensation for goods lost by the carrier, Dr 1388 / Cr 632, the excess Cr 711; tax withheld from a company by mistake, Dr 1388 / Cr 131. Uncertain (#2520): the same as tt133.`),
    assetAwaitingHandling: row('1381', `Same as tt133 (rule 2): the optional first step for a claim not yet decided. Uncertain (#2520): the same as tt133 (one route is posted, not both).`),
    costOfGoods: row('632', `Same as tt133 (rule 2): the compensation for lost goods reduces 632 up to the cost already booked.`),
    otherIncome: row('711', `Same as tt133 (rules 2 and 3): the compensation above cost, and a seller incentive not tied to a sale. Uncertain (#2520): the same as tt133.`),
    otherExpense: row('811', `Same as tt133 (rule 7): a 1-dong difference goes to 811 (or 711 the other way). Uncertain (#2520): the same as tt133.`),
  },
});

// The postings a map gates, each with the rows it posts to (#3711 slice 1). `sales`: the settlement voucher without household tax (131 against 511 and the output VAT on 33311, #4303 S3b; a refund reducing 511). `payout`: the money received
// (cash, fees against the platform's 331, 131 cleared). `fee_accrual`: the month-end accrual of fees not yet invoiced (expense against 335). `household_tax`: the VAT and PIT a platform withheld for a
// household seller, in the settlement voucher and again in the payout; its debit side is the owner's equity (pitOwnerEquity), not an expense. 333 and the retired 1388 row belong to no path.
export type MarketplacePath = 'sales' | 'payout' | 'fee_accrual' | 'household_tax';
type MarketplaceRow = 'receivable' | 'revenue' | 'salesReturn' | 'cash' | 'feePayable' | 'feeAwaitingInvoice' | 'taxWithheld' | 'vatPayable' | 'pitPayable' | 'pitOwnerEquity' | 'feeExpense' | 'accruedExpense' | 'outputVat' | 'feeInputVat' | 'otherReceivable' | 'assetAwaitingHandling' | 'costOfGoods' | 'otherIncome' | 'otherExpense';

export const MARKETPLACE_PATH_ROWS: Readonly<Record<MarketplacePath, readonly MarketplaceRow[]>> = Object.freeze({
  sales: Object.freeze<MarketplaceRow[]>(['receivable', 'revenue', 'salesReturn', 'outputVat']),
  payout: Object.freeze<MarketplaceRow[]>(['receivable', 'cash', 'feePayable']),
  fee_accrual: Object.freeze<MarketplaceRow[]>(['feeExpense', 'accruedExpense']),
  household_tax: Object.freeze<MarketplaceRow[]>(['vatPayable', 'pitPayable', 'pitOwnerEquity']),
});

// The rows the retired fee clearing asks for when no path is named. The rows added for the researched rules (outputVat, feeInputVat, otherReceivable, assetAwaitingHandling, costOfGoods, otherIncome, otherExpense) are
// gated by the path that posts them (#4303 S3 and S4), so they are not asked here: this list only decides what the retired code needs.
const ALL_ROWS: readonly MarketplaceRow[] = ['receivable', 'revenue', 'salesReturn', 'cash', 'feePayable', 'feeAwaitingInvoice', 'taxWithheld', 'vatPayable', 'pitPayable', 'pitOwnerEquity', 'feeExpense', 'accruedExpense'];

// The gate: a regime with no map is refused as unknown, one whose map or the rows of the asked paths are not `confirmed` as waiting for the accountant. Returns the map so the caller builds from what it
// checked. Without `paths` every row of the original twelve is asked (the retired fee clearing still does); a path asks only for its own rows, and the map's own status must be confirmed for any of them.
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

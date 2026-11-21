// SPDX-License-Identifier: AGPL-3.0-only
// What Shopee paid and kept, read from its payment API (#2524, S3 = #4290; the same shape as Lazada's S5a, marketplace-lazada-finance.ts, and TikTok's T3, marketplace-tiktok-finance.ts), DORMANT: nothing calls it yet,
// and it writes nothing. It returns plain data, the income of each paid-out order as the income path's lines hold it (sales, seller discount, commission, service fee, payment fee, shipping, tax withheld, refund,
// `other`, net), which a later step writes as a file the income path stages for a member to confirm. Built from the OFFICIAL pages read on 2026-11-21 (open.shopee.com: v2.payment.get_escrow_list and
// v2.payment.get_escrow_detail). Nothing was checked against a real seller's answer (the live check, #2522, does that). The ERP System, Seller In-house System and Accounting and Finance app types can call both paths.
//
// READ ONLY, two paths, both GET (a test reads this source to keep it so), through the signed caller of the orders adapter, so one partner and shop is paced across the orders poll and this reader.
//
// THE WINDOW selects orders by the day their escrow was RELEASED to the seller (`escrow_release_time`, a Vietnam day), which is the payout day of the line: an order that shipped, completed or was returned in another month
// is paid on its own day. A later step reads overlapping windows and dedupes by (order, payout day). Only released orders are in the list, so `escrow_amount` here is the settled one, not the estimate the detail gives
// for an order that is not completed yet.
//
// THE MONEY. Every amount is a decimal STRING read from the exact JSON text (every number of these answers is parsed as its source text, never a JS float), at most four decimals; sums go through decimal.js; an exponent
// or more than four decimals refuses the page. The answer states no currency of its own except `pri_currency` and `aff_currency` of a cross-border affiliate shop: the orders adapter already refused any order that is not
// VND, and a currency word here other than VND, or an `exchange_rate` other than 1, refuses the page. `net` is the payout the LIST states (`payout_amount`), the identity of the income path then holds exactly:
//   net = sales - sellerDiscount - commission - serviceFee - paymentFee - shipping - taxWithheld - refund + other.
// A deduction is stored as the positive amount taken, and a bucket whose field is written with the other sign is not hidden: it stays in `other`, named.
//
// WHAT IS NOT GUESSED. Only six fields have a bucket (the PO's rule, as on Lazada and TikTok; all are named in the page's own formula of `escrow_amount`): `original_cost_of_goods_sold` sales, `voucher_from_seller` seller discount,
// `commission_fee` commission, `service_fee` service fee, `seller_transaction_fee` payment fee, `actual_shipping_fee` shipping. EVERYTHING ELSE is in `other` with its field name (`otherByField`), until the accountant
// (#61) says how it posts: the rest of the formula's fields carry their sign as the formula writes it (credit or deduction), a field the formula does not name is returned as written and FLAGGED (`unknownField`), never
// refused, and `unitemised` is what the named fields do not explain (a person sees it, never a silent gap). `refund` and `taxWithheld` stay 0. **The Vietnam withholding fields `withholding_vat_tax`, `withholding_pit_tax`
// and `withholding_cit_tax` (and `tax_registration_code`) ARE in the escrow answer**: they are CARRIED as fields of their own and never booked here, as TikTok's tax fields are. Adjustments of an order (`order_adjustment`) and
// the buyer's side (`buyer_*`, the user name, payment info) are never read: every record is read through an allow-list.
import { Decimal } from '@crove/l10n-vn';
import { MarketplaceProviderError } from '@crove/mod-finance';
import { isoDay, marketplaceIdentifier, notRecognized, pickAllowed } from './marketplace-adapter-kit.ts';
import { ShopeeNumber, parseShopeeSourceAnswer, parseShopeeSecret, shopeeCaller, type ShopeeCaller, type ShopeeCredential, type ShopeeOptions } from './marketplace-shopee.ts';

const ESCROW_LIST_PATH = '/api/v2/payment/get_escrow_list';
const ESCROW_DETAIL_PATH = '/api/v2/payment/get_escrow_detail';

export const SHOPEE_FINANCE_PAGE = 100;
// A window is at most this many days (the platform states no limit for the escrow list; the 15 days of its other lists is used), and reads at most this many orders: past that it is refused, never cut.
export const SHOPEE_FINANCE_MAX_DAYS = 15;
export const SHOPEE_FINANCE_MAX_ORDERS = 100;
const MAX_LIST_PAGES = 2;
const MAX_FIELDS = 300;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
export const SHOPEE_CURRENCY = 'VND';

type Dec = InstanceType<typeof Decimal>;
const ZERO = new Decimal(0);
const toMoney = (value: Dec): string => {
  const text = value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (text.abs().gte(new Decimal(10).pow(16))) throw notRecognized();
  return text.toFixed();
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// The exact text of a number as Shopee wrote it, and nothing else: a plain decimal of at most four decimals. A string, a boolean or an exponent is not an amount.
const MONEY = /^-?\d{1,16}(\.\d{1,4})?$/;
function moneyOf(value: unknown): string | null {
  return value instanceof ShopeeNumber && MONEY.test(value.text) ? value.text : null;
}
function requiredMoney(value: unknown): string {
  const text = moneyOf(value);
  if (text === null) throw notRecognized();
  return text;
}

// Unix seconds as a day in Vietnam, and the instants a window of days starts and ends at (Vietnam's midnight).
const vietnamDay = (sec: number): string => new Date(sec * 1000 + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
const dayStartSec = (day: string): number => (Date.parse(day) - VIETNAM_OFFSET_MS) / 1000;
function secondsOf(value: unknown): number {
  const n = value instanceof ShopeeNumber && /^\d{10,11}$/.test(value.text) ? Number(value.text) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < 1_000_000_000 || n > 99_999_999_999) throw notRecognized();
  return n;
}

// The formula of `escrow_amount` as the official page writes it: the sign each field has in the seller's payout (+1 credit, -1 deduction). The page's formula is cut off after `delivery_seller_protection_fee_premium_amount`
// ("..."), so a field it did not show is NOT in this table and is returned flagged.
const FORMULA_SIGN: Readonly<Record<string, 1 | -1>> = {
  original_cost_of_goods_sold: 1,
  original_shopee_discount: -1,
  seller_return_refund: 1,
  shopee_discount: 1,
  voucher_from_seller: -1,
  seller_coin_cash_back: -1,
  buyer_paid_shipping_fee: 1,
  actual_shipping_fee: -1,
  shopee_shipping_rebate: 1,
  shipping_fee_discount_from_3pl: 1,
  reverse_shipping_fee: -1,
  rsf_seller_protection_fee_claim_amount: 1,
  final_return_to_seller_shipping_fee: -1,
  seller_transaction_fee: -1,
  service_fee: -1,
  commission_fee: -1,
  campaign_fee: -1,
  shipping_seller_protection_fee_amount: -1,
  delivery_seller_protection_fee_premium_amount: -1,
};
// The six fields with a bucket of their own.
const BUCKET_FIELDS: ReadonlySet<string> = new Set(['original_cost_of_goods_sold', 'voucher_from_seller', 'commission_fee', 'service_fee', 'seller_transaction_fee', 'actual_shipping_fee']);
// The Vietnam withholding fields: carried, never booked here.
const CARRIED = { vat: 'withholding_vat_tax', pit: 'withholding_pit_tax', cit: 'withholding_cit_tax' } as const;
// Fields of the answer that are descriptions of the order, not part of the payout (the estimate, the buyer's side and the price lists): never itemised. `escrow_amount` is the order's own settlement, kept apart.
const NOT_PAYOUT: ReadonlySet<string> = new Set([
  'escrow_amount',
  'escrow_amount_after_adjustment',
  'total_adjustment_amount',
  'buyer_total_amount',
  'order_original_price',
  'original_price',
  'order_discounted_price',
  'order_selling_price',
  'order_seller_discount',
  'seller_discount',
  'cost_of_goods_sold',
  'estimated_shipping_fee',
  'final_shipping_fee',
  'coins',
  'voucher_from_shopee',
  'voucher_from_external_party',
  'payment_promotion',
  'buyer_transaction_fee',
  'order_chargeable_weight',
  'exchange_rate',
  CARRIED.vat,
  CARRIED.pit,
  CARRIED.cit,
]);

export interface ShopeePayout {
  orderNo: string;
  // The payout the list states for the order, a decimal string in dong.
  payout: string;
  // YYYY-MM-DD in Vietnam, the day the escrow was released.
  paidAt: string;
}

export interface ShopeeIncomeLine {
  orderNo: string;
  // YYYY-MM-DD, the day the escrow was released (Vietnam).
  paidAt: string;
  // Decimal strings, every deduction a positive amount taken from the seller, `other` and `net` signed: net = sales - sellerDiscount - commission - serviceFee - paymentFee - shipping - taxWithheld - refund + other.
  sales: string;
  sellerDiscount: string;
  commission: string;
  serviceFee: string;
  paymentFee: string;
  shipping: string;
  taxWithheld: string;
  refund: string;
  other: string;
  net: string;
  // Carried and NOT booked until the accountant says how they post (as written): the Vietnam withholding of VAT, personal income tax and corporate income tax, and the tax registration code of the seller they were withheld from.
  carried: { withholdingVat: string; withholdingPit: string; withholdingCit: string; taxRegistrationCode: string | null };
  // The non-zero fields with no bucket of their own, by name: credit-signed (positive adds to the payout) where the official formula gives the field's sign, as written where it does not (`signed` false).
  otherByField: Array<{ field: string; amount: string; signed: boolean }>;
  // What `other` holds that no signed field accounts for: `other` less the sum of the signed `otherByField`, '0' when everything is named. A person sees it, never a silent gap.
  unitemised: string;
  // True when the line has a non-zero field the official formula does not sign: the review screen shows the line to a person.
  unknownField: boolean;
  // True when the detail's own settlement (`escrow_amount_after_adjustment`, else `escrow_amount`) is not the payout the list states: the difference is in `other`, and a person sees the line.
  payoutDiffersFromDetail: boolean;
}

export interface ShopeeIncome {
  currency: typeof SHOPEE_CURRENCY;
  payouts: ShopeePayout[];
  lines: ShopeeIncomeLine[];
}

export interface ShopeeFinanceWindow {
  // YYYY-MM-DD in Vietnam, both days included, at most SHOPEE_FINANCE_MAX_DAYS days.
  startDay: string;
  endDay: string;
  // Optional: read only the part of those days between two instants (Unix seconds, both included, inside the days named). A window of orders over the list limit is refused as `too_large` (not as an
  // unreadable answer), so a caller can split it and read the halves (marketplace-income-leg.ts).
  fromSec?: number;
  toSec?: number;
}

export interface ShopeeFinance {
  // The orders whose escrow was released in a window, with the payout the list states.
  payouts(secret: string, window: ShopeeFinanceWindow): Promise<ShopeePayout[]>;
  // The same orders as the income of each order by payout day.
  income(secret: string, window: ShopeeFinanceWindow): Promise<ShopeeIncome>;
}

function checkWindow(window: ShopeeFinanceWindow): { fromSec: number; toSec: number } {
  const span = isoDay(window.startDay) && isoDay(window.endDay) ? (Date.parse(window.endDay) - Date.parse(window.startDay)) / DAY_MS : Number.NaN;
  if (!(span >= 0 && span < SHOPEE_FINANCE_MAX_DAYS)) throw new RangeError('finance window');
  const dayFrom = dayStartSec(window.startDay);
  const dayTo = dayStartSec(window.endDay) + DAY_MS / 1000 - 1;
  const fromSec = window.fromSec ?? dayFrom;
  const toSec = window.toSec ?? dayTo;
  if (!Number.isInteger(fromSec) || !Number.isInteger(toSec) || fromSec < dayFrom || toSec > dayTo || fromSec > toSec) throw new RangeError('finance window');
  return { fromSec, toSec };
}

export function shopeeFinance(options: ShopeeOptions, caller: ShopeeCaller = shopeeCaller(options)): ShopeeFinance {
  const get = (credential: ShopeeCredential, path: string, query: Record<string, string>) => caller(credential, { method: 'GET', path, query, parse: parseShopeeSourceAnswer });

  async function readPayouts(credential: ShopeeCredential, window: ShopeeFinanceWindow): Promise<ShopeePayout[]> {
    const { fromSec, toSec } = checkWindow(window);
    const out: ShopeePayout[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
      const data = await get(credential, ESCROW_LIST_PATH, { release_time_from: String(fromSec), release_time_to: String(toSec), page_size: String(SHOPEE_FINANCE_PAGE), page_no: String(page) });
      if (!isRecord(data) || typeof data.more !== 'boolean') throw notRecognized();
      const list = data.escrow_list;
      // A page that says there is more and carries no list is contradictory, not an empty window.
      if (list === undefined) {
        if (data.more) throw notRecognized();
        return out;
      }
      if (!Array.isArray(list) || list.length > SHOPEE_FINANCE_PAGE) throw notRecognized();
      for (const entry of list) {
        const e = pickAllowed(entry, ['order_sn', 'payout_amount', 'escrow_release_time'] as const);
        const orderNo = marketplaceIdentifier(e?.order_sn, 40);
        if (!e || orderNo === null || !/^[A-Za-z0-9]+$/.test(orderNo)) throw notRecognized();
        // An order twice in the pages is not Shopee's: it would be paid out (and booked) twice.
        if (seen.has(orderNo)) throw notRecognized();
        seen.add(orderNo);
        const released = secondsOf(e.escrow_release_time);
        // A row released outside the window asked for is not what the list was asked for.
        if (released < fromSec || released > toSec) throw notRecognized();
        out.push({ orderNo, payout: requiredMoney(e.payout_amount), paidAt: vietnamDay(released) });
      }
      // More orders than one window may hold: refused whole (never cut), as its own kind so the caller can ask for a shorter window.
      if (out.length > SHOPEE_FINANCE_MAX_ORDERS) throw new MarketplaceProviderError('too_large');
      if (!data.more) return out;
    }
    // More than the pages read: refused, never cut (the caller asks for a shorter window).
    throw new MarketplaceProviderError('too_large');
  }

  // The income of one order from its escrow detail, as only the fields the reader keeps; anything malformed or unknown refuses the page.
  async function readLine(credential: ShopeeCredential, payout: ShopeePayout): Promise<ShopeeIncomeLine> {
    const data = await get(credential, ESCROW_DETAIL_PATH, { order_sn: payout.orderNo });
    const d = pickAllowed(data, ['order_sn', 'order_income'] as const);
    if (!d || d.order_sn !== payout.orderNo || !isRecord(d.order_income)) throw notRecognized();
    const entries = Object.entries(d.order_income);
    if (entries.length > MAX_FIELDS) throw notRecognized();
    // The money of the answer by field name: only a top-level number is an amount; a nested list or object (items, adjustments, fee rules, the buyer's payment) and every text is not read.
    const amounts = new Map<string, string>();
    let taxRegistrationCode: string | null = null;
    for (const [field, value] of entries) {
      if (!/^[a-z0-9_]{1,80}$/.test(field)) throw notRecognized();
      if (value instanceof ShopeeNumber) {
        const text = moneyOf(value);
        // A number the payout does not depend on (a weight, a price list) that is not a plain decimal is left out; any other must be one, or the page is refused. The exchange rate is checked below.
        if (text === null && NOT_PAYOUT.has(field) && field !== 'exchange_rate' && field !== 'escrow_amount' && field !== 'escrow_amount_after_adjustment') continue;
        if (text === null) throw notRecognized();
        amounts.set(field, text);
      } else if (field === 'tax_registration_code' && typeof value === 'string' && /^[0-9A-Za-z-]{1,40}$/.test(value)) {
        taxRegistrationCode = value;
      } else if (field === 'pri_currency' || field === 'aff_currency') {
        // A currency word other than dong anywhere refuses the page: a figure of another currency would be booked as dong.
        if (value !== SHOPEE_CURRENCY) throw notRecognized();
      }
    }
    const settled = amounts.get('escrow_amount_after_adjustment') ?? amounts.get('escrow_amount') ?? null;
    const rate = amounts.get('exchange_rate');
    if (rate !== undefined && !new Decimal(rate).eq(1)) throw notRecognized();
    const written = (field: string): Dec => new Decimal(amounts.get(field) ?? '0');

    // Credits are positive and deductions are written positive in Shopee's escrow (the formula subtracts them); a deduction is the positive amount taken, and a bucket of the other sign is not hidden: it stays in `other`.
    const sales = Decimal.max(ZERO, written('original_cost_of_goods_sold'));
    const sellerDiscount = Decimal.max(ZERO, written('voucher_from_seller'));
    const commission = Decimal.max(ZERO, written('commission_fee'));
    const serviceFee = Decimal.max(ZERO, written('service_fee'));
    const paymentFee = Decimal.max(ZERO, written('seller_transaction_fee'));
    const shipping = Decimal.max(ZERO, written('actual_shipping_fee'));
    const net = new Decimal(payout.payout);
    const other = net.minus(sales.minus(sellerDiscount).minus(commission).minus(serviceFee).minus(paymentFee).minus(shipping));

    const byField = new Map<string, { amount: Dec; signed: boolean }>();
    // A bucket field written with the other sign: what the bucket did not take, credit-signed, named.
    const remainders: Array<[string, Dec]> = [
      ['original_cost_of_goods_sold', written('original_cost_of_goods_sold').minus(sales)],
      ['voucher_from_seller', sellerDiscount.minus(written('voucher_from_seller'))],
      ['commission_fee', commission.minus(written('commission_fee'))],
      ['service_fee', serviceFee.minus(written('service_fee'))],
      ['seller_transaction_fee', paymentFee.minus(written('seller_transaction_fee'))],
      ['actual_shipping_fee', shipping.minus(written('actual_shipping_fee'))],
    ];
    for (const [field, left] of remainders) if (!left.isZero()) byField.set(field, { amount: left, signed: true });
    for (const [field, amount] of amounts) {
      if (BUCKET_FIELDS.has(field) || NOT_PAYOUT.has(field)) continue;
      const value = new Decimal(amount);
      if (value.isZero()) continue;
      const sign = Object.hasOwn(FORMULA_SIGN, field) ? FORMULA_SIGN[field] : undefined;
      byField.set(field, sign === undefined ? { amount: value, signed: false } : { amount: value.times(sign), signed: true });
    }
    // The carried fields are named too, as written, never summed into what is explained.
    for (const field of Object.values(CARRIED)) {
      const value = written(field);
      if (!value.isZero()) byField.set(field, { amount: value, signed: false });
    }
    const detail = [...byField].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const itemised = detail.filter(([, v]) => v.signed).reduce((total, [, v]) => total.plus(v.amount), ZERO);
    // The carried fields are never a "flagged unknown": the official page names them.
    const carriedNames = new Set<string>(Object.values(CARRIED));
    return {
      orderNo: payout.orderNo,
      paidAt: payout.paidAt,
      sales: toMoney(sales),
      sellerDiscount: toMoney(sellerDiscount),
      commission: toMoney(commission),
      serviceFee: toMoney(serviceFee),
      paymentFee: toMoney(paymentFee),
      shipping: toMoney(shipping),
      taxWithheld: '0',
      refund: '0',
      other: toMoney(other),
      net: toMoney(net),
      carried: { withholdingVat: toMoney(written(CARRIED.vat)), withholdingPit: toMoney(written(CARRIED.pit)), withholdingCit: toMoney(written(CARRIED.cit)), taxRegistrationCode },
      otherByField: detail.map(([field, v]) => ({ field, amount: toMoney(v.amount), signed: v.signed })),
      unitemised: toMoney(other.minus(itemised)),
      unknownField: detail.some(([field, v]) => !v.signed && !carriedNames.has(field)),
      payoutDiffersFromDetail: settled !== null && !new Decimal(settled).eq(net),
    };
  }

  return {
    payouts: (secret, window) => readPayouts(parseShopeeSecret(secret), window),

    async income(secret, window) {
      checkWindow(window);
      const credential = parseShopeeSecret(secret);
      const payouts = await readPayouts(credential, window);
      const lines: ShopeeIncomeLine[] = [];
      for (const payout of payouts) lines.push(await readLine(credential, payout));
      lines.sort((a, b) => (a.paidAt < b.paidAt ? -1 : a.paidAt > b.paidAt ? 1 : a.orderNo < b.orderNo ? -1 : a.orderNo > b.orderNo ? 1 : 0));
      return { currency: SHOPEE_CURRENCY, payouts, lines };
    },
  };
}

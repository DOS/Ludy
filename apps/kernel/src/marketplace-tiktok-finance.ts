// SPDX-License-Identifier: AGPL-3.0-only
// What TikTok Shop paid and kept, read from its finance API (#2524, T3 = #4266; the same shape as Lazada's S5a, marketplace-lazada-finance.ts), DORMANT: nothing calls it yet, and it writes nothing. It returns plain
// data, the income of each order by payout day as the income path's lines hold it (sales, seller discount, commission, payment fee, shipping, refund, `other`, net), which a later step writes as a file the income
// path stages for a member to confirm. Built from the OFFICIAL Partner Center pages read on 2026-11-21 (get-statements-202309, get-transactions-by-statement-202501, get-payments-202605: the Payments 202309 version
// was sunset on 2026-08-15, so only 202605 is read). Nothing was checked against a real seller's answer (the live check, #2522, does that).
//
// READ ONLY, three paths, all GET (a test reads this source to keep it so), through T1's signed caller, so one app and shop is paced across the orders poll and this reader.
//
// THE WINDOW selects statements by the day they were GENERATED (statement_time, 00:00 UTC for the day before), while a line is keyed by its PAYOUT day: a statement generated before the window and paid inside it is not
// returned, and a line's `paidAt` can fall after the window's end. A later step reads overlapping windows and dedupes by (order, payout day).
//
// PAYMENTS (202605) are for reconciliation only and the official page says the API is "currently unavailable to SEA markets" (Vietnam is one): `income()` reads them best-effort and returns `payments: null` when the
// read fails, so the lines never depend on them (the payout day of a line is the statement's own `payment_time`). `payments()` is the strict read for a market where it works (the live check, #2522, says which).
//
// THE MONEY. Every amount is a decimal STRING (at most four decimals; sums go through decimal.js, never a JS number); a number, an exponent, a thousands separator or a currency sign refuses the page. TikTok states a
// currency on a statement, on the page of a statement's transactions and on a payment: each must be VND, and a payment that was exchanged (another currency, or a rate other than 1) refuses the page. A line whose
// amounts are not what the identity needs is never forced: `net` is the order's own `settlement_amount` and `other` is whatever the named buckets do not explain, so the identity of the income path holds exactly:
//   net = sales - sellerDiscount - commission - serviceFee - paymentFee - shipping - taxWithheld - refund + other.
// Credits are positive and fees negative in TikTok's lines; a deduction is stored as the positive amount taken, and a bucket of the other sign is not hidden: it stays in `other`.
//
// WHAT IS NOT GUESSED. Only seven fields have a bucket (the PO's rule, as with five fee ids on Lazada): `subtotal_before_discount_amount` sales, `refund_subtotal_before_discount_amount` refund,
// `seller_discount_amount` seller discount, `platform_commission_amount` commission, `transaction_fee_amount` payment fee, `shipping_cost_amount` shipping. EVERYTHING ELSE (the other fees, the taxes, the other
// parts of the revenue) is in `other` with its field name (`otherByField`), until the accountant (#61) says how it posts. A field the official table does not hold (the list grows) is in `other` and FLAGGED, never
// refused. `serviceFee` and `taxWithheld` stay 0. `vn_fix_infrastructure_fee`, `pit_amount` and `local_vat_amount` are CARRIED as fields of their own and never booked. Adjustments (penalties, charge backs, stamp
// duty, ...) and reserves are a separate list, never mixed into an order's line. Only a statement whose payment status is PAID is income (its day is the payment day in Vietnam); the others are counted and left out.
// Seller, bank and buyer fields (the masked bank account, names) are never read: every record is read through an allow-list.
import { Decimal } from '@ludy/l10n-vn';
import { cleanLabel, isoDay, marketplaceDigits, marketplaceMoney, notRecognized, pickAllowed } from './marketplace-adapter-kit.ts';
import { parseTiktokSecret, tiktokCaller, type TiktokCaller, type TiktokCredential, type TiktokOptions } from './marketplace-tiktok.ts';
import { MarketplaceProviderError } from '@ludy/mod-finance';

// The paths this reader calls, all GET: the statements of a window, the transactions of one statement, and the payments of a window.
const STATEMENTS_PATH = '/finance/202309/statements';
const statementTransactionsPath = (id: string): string => `/finance/202501/statements/${id}/statement_transactions`;
const PAYMENTS_PATH = '/finance/202605/payments';

// The answers' fields that hold an id (TikTok's are 18 digits, past 2^53, and strings in the documentation; one that arrives as a number is kept as the digits written).
const ID_KEYS = ['id', 'payment_id', 'order_id', 'adjustment_id', 'adjustment_order_id'] as const;
export const TIKTOK_FINANCE_PAGE = 100;
const PAYMENT_PAGE = 50;
// A window is at most this many days, so at most this many statements (one is generated a day).
export const TIKTOK_FINANCE_MAX_DAYS = 31;
const MAX_STATEMENT_PAGES = 3;
const MAX_TRANSACTION_PAGES = 30;
const MAX_PAYMENT_PAGES = 3;
export const TIKTOK_FINANCE_MAX_STATEMENTS = 100;
const MAX_STATEMENTS = TIKTOK_FINANCE_MAX_STATEMENTS;
const MAX_FIELDS = 200;
const VIETNAM_OFFSET_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
export const TIKTOK_CURRENCY = 'VND';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// `Decimal` of @ludy/l10n-vn is the configured constructor (a value); its instances are typed through it.
type Dec = InstanceType<typeof Decimal>;
const ZERO = new Decimal(0);
const toMoney = (value: Dec): string => {
  const text = value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (text.abs().gte(new Decimal(10).pow(16))) throw notRecognized();
  return text.toFixed();
};

// The fields of the official pages, by place in a transaction. A field not here is `known: false` on the line.
const REVENUE_FIELDS: ReadonlySet<string> = new Set([
  'subtotal_before_discount_amount',
  'refund_subtotal_before_discount_amount',
  'seller_discount_amount',
  'seller_discount_refund_amount',
  'cod_service_fee_amount',
  'refund_cod_service_fee_amount',
  'distant_item_fee_amount',
]);
const FEE_FIELDS: ReadonlySet<string> = new Set([
  'platform_commission_amount', 'referral_fee_amount', 'refund_administration_fee_amount', 'transaction_fee_amount', 'credit_card_handling_fee_amount', 'affiliate_commission_amount',
  'affiliate_commission_amount_before_pit', 'affiliate_partner_commission_amount', 'affiliate_ads_commission_amount', 'sfp_service_fee_amount', 'live_specials_fee_amount', 'bonus_cashback_service_fee_amount',
  'mall_service_fee_amount', 'voucher_xtra_service_fee_amount', 'flash_sales_service_fee_amount', 'cofunded_promotion_service_fee_amount', 'pre_order_service_fee_amount', 'tsp_commission_amount',
  'dt_handling_fee_amount', 'epr_pob_service_fee_amount', 'seller_paylater_handling_fee_amount', 'fee_per_item_sold_amount', 'cofunded_creator_bonus_amount', 'dynamic_commission_amount',
  'external_affiliate_marketing_fee_amount', 'vn_fix_infrastructure_fee', 'affiliate_commission_deposit', 'affiliate_commission_release', 'tap_shop_ads_commission', 'shipping_fee_guarantee_service_fee',
  'installation_service_fee', 'campaign_resource_fee', 'platform_special_service_fee_amount', 'smart_promotion_fee_amount', 'gmv_max_ad_fee_amount', 'platform_semi_managed_commission_fee',
  'platform_semi_managed_commission_fee_tax', 'campaign_period_fee_cfp_amount', 'campaign_period_fee_sp_amount', 'campaign_period_fee_sp_tax_amount', 'campaign_period_fee_cfp_tax_amount',
  'seller_growth_fee_amount', 'category_led_campaign_fee_amount', 'category_led_campaign_fee_tax_amount', 'brand_amplification_program_commission', 'brand_amplification_program_fee_tax', 'brand_campaign_fee',
  'brand_campaign_fee_tax', 'failed_delivery_shipping_fee', 'buyer_fault_return_shipping_fee', 'insurance_fee', 'gmv_max_coupon_fee', 'cps_shop_ads_commission_tax_amount',
  'shipping_insurance_fee_tax_amount', 'new_customer_growth_package_fee', 'target_product_gmv_growth_package_fee', 'store_gmv_growth_package_fee', 'auto_post_shoppable_video_commission_fee',
  'seller_funded_user_spoint_service_fee', 'smart_shipping_fee_amount',
]);
const TAX_FIELDS: ReadonlySet<string> = new Set([
  'vat_amount', 'import_vat_amount', 'customs_duty_amount', 'customs_clearance_amount', 'sst_amount', 'gst_amount', 'iva_amount', 'isr_amount', 'anti_dumping_duty_amount', 'local_vat_amount', 'pit_amount',
  'sales_tax_referral_fee_amount', 'smart_promotion_fee_tax_amount', 'cedular_tax', 'new_customer_growth_package_fee_tax', 'store_gmv_growth_package_fee_sales_tax', 'target_product_gmv_growth_package_tax',
  'auto_post_shoppable_video_sales_tax', 'article_22_income_tax_withheld',
]);
// The adjustment types of the official page; a type not here is returned and flagged.
const ADJUSTMENT_TYPES: ReadonlySet<string> = new Set([
  'CHARGE_BACK', 'CUSTOMER_SERVICE_COMPENSATION', 'DEDUCTIONS_INCURRED_BY_SELLER', 'GMV_PAYMENT_FOR_ADS', 'PLATFORM_COMMISSION_ADJUSTMENT', 'PLATFORM_COMMISSION_COMPENSATION', 'PLATFORM_PENALTY',
  'PROMOTION_ADJUSTMENT', 'REBATE', 'PLATFORM_COMPENSATION', 'PLATFORM_REIMBURSEMENT', 'COFUNDED_CREATOR_REWARDS', 'STAMP_DUTY', 'FBT_WAREHOUSE_SERVICE_FEE', 'LOGISTICS_REIMBURSEMENT',
  'SHIPPING_FEE_ADJUSTMENT', 'SHIPPING_FEE_COMPENSATION', 'SHIPPING_FEE_REBATE', 'SAMPLE_SHIPPING_FEE', 'SELLER_MISSION_REWARD', 'OTHER_ADJUSTMENT',
]);

const STATEMENT_PAYMENT_STATUS: ReadonlySet<string> = new Set(['PAID', 'FAILED', 'PROCESSING', 'SETTLED']);
const PAYMENT_STATUS: ReadonlySet<string> = new Set(['PAID', 'FAILED', 'PROCESSING']);

// Unix seconds as a day in Vietnam, and the instants a window of days starts and ends at (Vietnam's midnight).
const vietnamDay = (sec: number): string => new Date(sec * 1000 + VIETNAM_OFFSET_MS).toISOString().slice(0, 10);
const dayStartSec = (day: string): number => (Date.parse(day) - VIETNAM_OFFSET_MS) / 1000;

function secondsOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1_000_000_000 || value > 99_999_999_999) throw notRecognized();
  return value;
}
// A money field that may be absent (or the empty string the deprecated fields answer with): zero then.
function optionalMoney(value: unknown): string {
  if (value === undefined || value === null || value === '') return '0';
  const text = marketplaceMoney(value);
  if (text === null) throw notRecognized();
  return text;
}
function requiredMoney(value: unknown): string {
  const text = marketplaceMoney(value);
  if (text === null) throw notRecognized();
  return text;
}
// The list's own count, when it states one (a whole number), to compare with what was read.
const totalOf = (data: Record<string, unknown>): number | null => (typeof data.total_count === 'number' && Number.isSafeInteger(data.total_count) && data.total_count >= 0 ? data.total_count : null);
const nextToken = (data: Record<string, unknown>): string | null => {
  const token = data.next_page_token;
  if (token === undefined || token === null || token === '') return null;
  if (typeof token !== 'string' || token.length > 2000 || !/^[\x21-\x7e]+$/.test(token)) throw notRecognized();
  return token;
};

export interface TiktokStatement {
  id: string;
  // YYYY-MM-DD in Vietnam, the day the statement was generated.
  day: string;
  // What it settled to the seller, a decimal string in dong.
  payout: string;
  status: string;
  paymentId: string | null;
  // The day the payout was paid (Vietnam), only for a PAID statement (the day it was generated when TikTok gives no payment time).
  paidDay: string | null;
}

export interface TiktokPayment {
  id: string;
  status: string;
  createdDay: string;
  paidDay: string | null;
  amount: string;
}

export interface TiktokAdjustment {
  id: string;
  type: string;
  // The order it relates to, when it names one.
  orderNo: string | null;
  // The payout day of its statement.
  paidAt: string;
  // Signed, as TikTok writes it.
  amount: string;
  // False for a type the official page does not list.
  known: boolean;
}

export interface TiktokIncomeLine {
  orderNo: string;
  // YYYY-MM-DD, the payout day of the statement the line is in (Vietnam).
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
  // Carried and NOT booked until the accountant says what they mean (signed, as TikTok writes them).
  carried: { vnFixInfrastructureFee: string; pitAmount: string; localVatAmount: string };
  // The non-zero fields with no bucket of their own, by name, with their summed amount (signed): what `other` is made of besides the sign of a named bucket. `known` is false for a name the official page does not hold.
  otherByField: Array<{ field: string; amount: string; known: boolean }>;
  // What `other` holds that no field accounts for (the order's own settlement is not the sum of the parts the answer lists): `other` less the sum of `otherByField`, '0' when everything is named. A person sees it, never a silent gap.
  unitemised: string;
  // True when any field of the line is one the official table does not hold: the review screen shows the line to a person.
  unknownField: boolean;
}

export interface TiktokIncome {
  currency: typeof TIKTOK_CURRENCY;
  statements: TiktokStatement[];
  // The payouts of the window, or null when the payments API could not be read (it is unavailable to SEA markets, which Vietnam is): the lines do not depend on it.
  payments: TiktokPayment[] | null;
  lines: TiktokIncomeLine[];
  adjustments: TiktokAdjustment[];
  // The statements read that were not PAID yet, left out (a count only).
  pendingStatements: number;
}

export interface TiktokFinanceWindow {
  // YYYY-MM-DD in Vietnam, both days included, at most TIKTOK_FINANCE_MAX_DAYS days.
  startDay: string;
  endDay: string;
}

export interface TiktokIncomeOptions {
  // Only read transactions for PAID statements whose payout day equals this YYYY-MM-DD (other days' statements are ignored, so a busy statement on another day never bricks this one).
  paidDay?: string;
  // Pre-fetched statements covering the window, so a multi-day catch-up run shares one statements read across days.
  statements?: readonly TiktokStatement[];
  // Skip the best-effort payments API call when the caller only needs lines and adjustments.
  includePayments?: boolean;
}

export interface TiktokFinance {
  // The statements generated in a window.
  statements(secret: string, window: TiktokFinanceWindow): Promise<TiktokStatement[]>;
  // The payments initiated in a window.
  payments(secret: string, window: TiktokFinanceWindow): Promise<TiktokPayment[]>;
  // The PAID statements of a window as the income of each order by payout day, the adjustments, and the statements and payments that settle the currency.
  income(secret: string, window: TiktokFinanceWindow, options?: TiktokIncomeOptions): Promise<TiktokIncome>;
}

function checkWindow(window: TiktokFinanceWindow): { geSec: number; ltSec: number } {
  const span = isoDay(window.startDay) && isoDay(window.endDay) ? (Date.parse(window.endDay) - Date.parse(window.startDay)) / DAY_MS : Number.NaN;
  if (!(span >= 0 && span < TIKTOK_FINANCE_MAX_DAYS)) throw new RangeError('finance window');
  return { geSec: dayStartSec(window.startDay), ltSec: dayStartSec(window.endDay) + DAY_MS / 1000 };
}

export function tiktokFinance(options: TiktokOptions, caller: TiktokCaller = tiktokCaller(options)): TiktokFinance {
  const shopOf = (credential: TiktokCredential): string => {
    if (credential.shopCipher === null) throw new MarketplaceProviderError('credentials');
    return credential.shopCipher;
  };
  const get = (credential: TiktokCredential, path: string, query: Record<string, string>) => caller(credential, { method: 'GET', path, query: { ...query, shop_cipher: shopOf(credential) } }, ID_KEYS);

  // One list read by page token, at most `maxPages`; a window with more than the pages read is refused, never cut, and a list whose own `total_count` is not the number of records read (a short page, a dropped
  // record) is refused too.
  async function readPages<T>(maxPages: number, fetchPage: (token: string | null) => Promise<{ records: T[]; next: string | null; total: number | null }>): Promise<T[]> {
    const out: T[] = [];
    let token: string | null = null;
    let total: number | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const got = await fetchPage(token);
      out.push(...got.records);
      total = got.total ?? total;
      if (got.next === null) {
        if (total !== null && total !== out.length) throw notRecognized();
        return out;
      }
      token = got.next;
    }
    throw notRecognized();
  }

  async function readStatements(credential: TiktokCredential, window: TiktokFinanceWindow): Promise<TiktokStatement[]> {
    const { geSec, ltSec } = checkWindow(window);
    const all = await readPages(MAX_STATEMENT_PAGES, async (token) => {
      const data = await get(credential, STATEMENTS_PATH, {
        statement_time_ge: String(geSec),
        statement_time_lt: String(ltSec),
        sort_field: 'statement_time',
        sort_order: 'ASC',
        page_size: String(TIKTOK_FINANCE_PAGE),
        ...(token === null ? {} : { page_token: token }),
      });
      if (!isRecord(data)) throw notRecognized();
      const list = data.statements;
      if (list === undefined) {
        // A reply that counts statements but carries no list cannot be an empty page.
        if (Number(data.total_count) > 0) throw notRecognized();
        return { records: [] as TiktokStatement[], next: null, total: 0 };
      }
      if (!Array.isArray(list) || list.length > TIKTOK_FINANCE_PAGE) throw notRecognized();
      return { records: list.map(statementOf), next: nextToken(data), total: totalOf(data) };
    });
    const seen = new Set<string>();
    for (const s of all) {
      // A statement id twice is not TikTok's: it would be read (and paid out) twice.
      if (seen.has(s.id)) throw notRecognized();
      seen.add(s.id);
    }
    if (all.length > MAX_STATEMENTS) throw notRecognized();
    return all;
  }

  async function readPayments(credential: TiktokCredential, window: TiktokFinanceWindow): Promise<TiktokPayment[]> {
    const { geSec, ltSec } = checkWindow(window);
    const all = await readPages(MAX_PAYMENT_PAGES, async (token) => {
      const data = await get(credential, PAYMENTS_PATH, {
        create_time_ge: String(geSec),
        create_time_lt: String(ltSec),
        sort_field: 'create_time',
        sort_order: 'ASC',
        page_size: String(PAYMENT_PAGE),
        ...(token === null ? {} : { page_token: token }),
      });
      if (!isRecord(data)) throw notRecognized();
      const list = data.payments;
      if (list === undefined) {
        if (Number(data.total_count) > 0) throw notRecognized();
        return { records: [] as TiktokPayment[], next: null, total: 0 };
      }
      if (!Array.isArray(list) || list.length > PAYMENT_PAGE) throw notRecognized();
      return { records: list.map(paymentOf), next: nextToken(data), total: totalOf(data) };
    });
    const seen = new Set<string>();
    for (const p of all) {
      if (seen.has(p.id)) throw notRecognized();
      seen.add(p.id);
    }
    return all;
  }

  // The transactions of one statement, each as only the fields the reader keeps; anything malformed or unknown refuses the page.
  async function readTransactions(credential: TiktokCredential, statement: TiktokStatement): Promise<Transaction[]> {
    const all = await readPages(MAX_TRANSACTION_PAGES, async (token) => {
      const data = await get(credential, statementTransactionsPath(statement.id), {
        sort_field: 'order_create_time',
        sort_order: 'ASC',
        page_size: String(TIKTOK_FINANCE_PAGE),
        ...(token === null ? {} : { page_token: token }),
      });
      if (!isRecord(data)) throw notRecognized();
      // The page states the statement it belongs to and its currency: both are checked, on every page.
      if (data.currency !== TIKTOK_CURRENCY) throw notRecognized();
      if (data.id !== undefined && marketplaceDigits(data.id, 40) !== statement.id) throw notRecognized();
      const list = data.transactions;
      if (list === undefined) {
        if (Number(data.total_count) > 0) throw notRecognized();
        return { records: [] as Transaction[], next: null, total: 0 };
      }
      if (!Array.isArray(list) || list.length > TIKTOK_FINANCE_PAGE) throw notRecognized();
      return { records: list.map((raw) => transactionOf(raw, statement)), next: nextToken(data), total: totalOf(data) };
    });
    const seen = new Set<string>();
    for (const t of all) {
      if (seen.has(t.id)) throw notRecognized();
      seen.add(t.id);
    }
    return all;
  }

  return {
    statements: (secret, window) => readStatements(parseTiktokSecret(secret), window),
    payments: (secret, window) => readPayments(parseTiktokSecret(secret), window),

    async income(secret, window, options) {
      checkWindow(window);
      const credential = parseTiktokSecret(secret);
      const statements = options?.statements ? [...options.statements] : await readStatements(credential, window);
      const paid = statements.filter((s) => s.status === 'PAID' && (options?.paidDay === undefined || s.paidDay === options.paidDay));
      const transactions: Transaction[] = [];
      for (const statement of paid) transactions.push(...(await readTransactions(credential, statement)));
      // Best-effort: the official page says the payments API is unavailable to SEA markets, and no line depends on it. A failed read is `null`, never a failed income.
      const payments =
        options?.includePayments === false
          ? null
          : await readPayments(credential, window).catch((error: unknown) => {
              if (error instanceof MarketplaceProviderError) return null;
              throw error;
            });
      const orders = transactions.filter((t): t is OrderTransaction => t.kind === 'order');
      const adjustments = transactions.filter((t): t is AdjustmentTransaction => t.kind === 'adjustment');
      return {
        currency: TIKTOK_CURRENCY,
        statements,
        payments,
        lines: aggregate(orders),
        adjustments: adjustments.map((a) => ({ id: a.adjustmentId, type: a.type, orderNo: a.orderNo, paidAt: a.paidAt, amount: a.amount, known: a.known })).sort((a, b) => (a.paidAt < b.paidAt ? -1 : a.paidAt > b.paidAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        pendingStatements: statements.filter((s) => s.status !== 'PAID').length,
      };
    },
  };
}

// One statement of the answer as only the fields the reader keeps; a currency other than dong anywhere refuses the page.
function statementOf(raw: unknown): TiktokStatement {
  const s = pickAllowed(raw, ['id', 'statement_time', 'settlement_amount', 'currency', 'revenue_amount', 'fee_amount', 'adjustment_amount', 'net_sales_amount', 'shipping_cost_amount', 'payment_status', 'payment_id', 'payment_time'] as const);
  const id = marketplaceDigits(s?.id, 40);
  const status = typeof s?.payment_status === 'string' ? s.payment_status : '';
  if (!s || id === null || s.currency !== TIKTOK_CURRENCY || !STATEMENT_PAYMENT_STATUS.has(status)) throw notRecognized();
  const day = vietnamDay(secondsOf(s.statement_time));
  const payout = requiredMoney(s.settlement_amount);
  // Every money field the statement carries is checked; only the payout is kept.
  for (const key of ['revenue_amount', 'fee_amount', 'adjustment_amount', 'net_sales_amount', 'shipping_cost_amount'] as const) optionalMoney(s[key]);
  const paymentId = s.payment_id === undefined || s.payment_id === null || s.payment_id === '' ? null : marketplaceDigits(s.payment_id, 40);
  if (paymentId === null && s.payment_id !== undefined && s.payment_id !== null && s.payment_id !== '') throw notRecognized();
  // A PAID statement says when it was paid; when TikTok gives no payment time (0 or none) the day it was generated stands in. Any other status carries no day.
  const paidDay = status === 'PAID' ? vietnamDay(s.payment_time === undefined || s.payment_time === null || s.payment_time === 0 ? secondsOf(s.statement_time) : secondsOf(s.payment_time)) : null;
  return { id, day, payout, status, paymentId, paidDay };
}

// A payment as only the fields the reader keeps: the three amounts are `{ value, currency }`, all in dong, and an exchange refuses the page. The bank account (masked) and everything else is never read.
function paymentOf(raw: unknown): TiktokPayment {
  const p = pickAllowed(raw, ['id', 'status', 'create_time', 'paid_time', 'amount', 'settlement_amount', 'payment_amount_before_exchange', 'exchange_rate'] as const);
  const id = marketplaceDigits(p?.id, 40);
  const status = typeof p?.status === 'string' ? p.status : '';
  if (!p || id === null || !PAYMENT_STATUS.has(status)) throw notRecognized();
  const money = (value: unknown, required: boolean): string => {
    if (value === undefined && !required) return '0';
    const a = pickAllowed(value, ['value', 'currency'] as const);
    if (!a || a.currency !== TIKTOK_CURRENCY) throw notRecognized();
    return requiredMoney(a.value);
  };
  const amount = money(p.amount, true);
  money(p.settlement_amount, false);
  money(p.payment_amount_before_exchange, false);
  // An exchange rate other than 1 is a payout in another currency than the amounts claim.
  if (p.exchange_rate !== undefined && p.exchange_rate !== '' && !(typeof p.exchange_rate === 'string' && /^\d{1,3}(\.\d{1,6})?$/.test(p.exchange_rate) && new Decimal(p.exchange_rate).eq(1))) throw notRecognized();
  const createdDay = vietnamDay(secondsOf(p.create_time));
  // The page returns 0 when no finish time is available: no day then, never a refusal.
  const paidDay = status === 'PAID' && p.paid_time !== undefined && p.paid_time !== null && p.paid_time !== 0 ? vietnamDay(secondsOf(p.paid_time)) : null;
  return { id, status, createdDay, paidDay, amount };
}

interface OrderTransaction {
  kind: 'order';
  id: string;
  orderNo: string;
  paidAt: string;
  net: string;
  breakdown: { revenue: Map<string, string>; fee: Map<string, string>; tax: Map<string, string>; shipping: string };
}
interface AdjustmentTransaction {
  kind: 'adjustment';
  id: string;
  adjustmentId: string;
  type: string;
  orderNo: string | null;
  paidAt: string;
  amount: string;
  known: boolean;
}
type Transaction = OrderTransaction | AdjustmentTransaction;

// The amounts of one breakdown object, by field name: each must be a decimal string (an empty string, the deprecated fields' answer, is nothing); a nested object or any other value is a shape this reader does not know.
function breakdownOf(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (value === undefined || value === null) return out;
  if (!isRecord(value)) throw notRecognized();
  const entries = Object.entries(value);
  if (entries.length > MAX_FIELDS) throw notRecognized();
  for (const [field, amount] of entries) {
    if (!/^[a-z0-9_]{1,80}$/.test(field)) throw notRecognized();
    if (amount === '' || amount === null) continue;
    const text = marketplaceMoney(amount);
    if (text === null) throw notRecognized();
    out.set(field, text);
  }
  return out;
}

function transactionOf(raw: unknown, statement: TiktokStatement): Transaction {
  const t = pickAllowed(raw, ['id', 'type', 'order_id', 'adjustment_id', 'adjustment_order_id', 'adjustment_amount', 'reserve_amount', 'settlement_amount', 'revenue_breakdown', 'shipping_cost_amount', 'fee_tax_breakdown'] as const);
  const id = marketplaceDigits(t?.id, 40);
  const type = typeof t?.type === 'string' ? cleanLabel(t.type, 80) : '';
  if (!t || id === null || type === '' || statement.paidDay === null) throw notRecognized();
  if (type === 'ORDER') {
    const orderNo = marketplaceDigits(t.order_id, 40);
    if (orderNo === null) throw notRecognized();
    const feeTax = t.fee_tax_breakdown;
    if (feeTax !== undefined && !isRecord(feeTax)) throw notRecognized();
    return {
      kind: 'order',
      id,
      orderNo,
      paidAt: statement.paidDay,
      net: requiredMoney(t.settlement_amount),
      breakdown: { revenue: breakdownOf(t.revenue_breakdown), fee: breakdownOf(isRecord(feeTax) ? feeTax.fee : undefined), tax: breakdownOf(isRecord(feeTax) ? feeTax.tax : undefined), shipping: optionalMoney(t.shipping_cost_amount) },
    };
  }
  // A reserve or an adjustment: never a line of an order. Its amount is the adjustment's (or, for a reserve, `reserve_amount`: positive is released, negative withheld).
  const adjustmentId = marketplaceDigits(t.adjustment_id ?? t.id, 40);
  const related = t.adjustment_order_id === undefined || t.adjustment_order_id === null || t.adjustment_order_id === '' ? null : marketplaceDigits(t.adjustment_order_id, 40);
  if (adjustmentId === null || (related === null && t.adjustment_order_id !== undefined && t.adjustment_order_id !== null && t.adjustment_order_id !== '')) throw notRecognized();
  const amount = type === 'RESERVE' ? requiredMoney(t.reserve_amount) : requiredMoney(t.adjustment_amount);
  return { kind: 'adjustment', id, adjustmentId, type, orderNo: related, paidAt: statement.paidDay, amount, known: type === 'RESERVE' || ADJUSTMENT_TYPES.has(type) };
}

// The three fields carried and never booked (the PO's rule, #4266): named in the official page, signed as written.
const CARRIED = { fee: 'vn_fix_infrastructure_fee', pit: 'pit_amount', localVat: 'local_vat_amount' } as const;
// The fields with a bucket of their own.
const BUCKET_FIELDS: ReadonlySet<string> = new Set(['subtotal_before_discount_amount', 'refund_subtotal_before_discount_amount', 'seller_discount_amount', 'platform_commission_amount', 'transaction_fee_amount']);

// The order lines of each order and payout day as one income line: the named buckets, `other` as what they do not explain, `net` as the order's own settlement (the income path's identity).
function aggregate(lines: readonly OrderTransaction[]): TiktokIncomeLine[] {
  const groups = new Map<string, OrderTransaction[]>();
  for (const line of lines) {
    const key = `${line.orderNo}\u0000${line.paidAt}`;
    const group = groups.get(key);
    if (group) group.push(line);
    else groups.set(key, [line]);
  }
  const out: TiktokIncomeLine[] = [];
  for (const group of groups.values()) {
    const first = group[0] as OrderTransaction;
    let net = ZERO;
    const sum = { sales: ZERO, refund: ZERO, sellerDiscount: ZERO, commission: ZERO, paymentFee: ZERO, shipping: ZERO };
    const carried = { fee: ZERO, pit: ZERO, localVat: ZERO };
    const byField = new Map<string, { amount: Dec; known: boolean }>();
    const add = (field: string, amount: string, known: boolean) => {
      const have = byField.get(field);
      byField.set(field, { amount: (have?.amount ?? ZERO).plus(amount), known });
    };
    for (const line of group) {
      const b = line.breakdown;
      net = net.plus(line.net);
      sum.sales = sum.sales.plus(b.revenue.get('subtotal_before_discount_amount') ?? '0');
      sum.refund = sum.refund.plus(b.revenue.get('refund_subtotal_before_discount_amount') ?? '0');
      sum.sellerDiscount = sum.sellerDiscount.plus(b.revenue.get('seller_discount_amount') ?? '0');
      sum.commission = sum.commission.plus(b.fee.get('platform_commission_amount') ?? '0');
      sum.paymentFee = sum.paymentFee.plus(b.fee.get('transaction_fee_amount') ?? '0');
      sum.shipping = sum.shipping.plus(b.shipping);
      carried.fee = carried.fee.plus(b.fee.get(CARRIED.fee) ?? '0');
      carried.pit = carried.pit.plus(b.tax.get(CARRIED.pit) ?? '0');
      carried.localVat = carried.localVat.plus(b.tax.get(CARRIED.localVat) ?? '0');
      for (const [field, amount] of b.revenue) if (!BUCKET_FIELDS.has(field)) add(`revenue.${field}`, amount, REVENUE_FIELDS.has(field));
      for (const [field, amount] of b.fee) if (!BUCKET_FIELDS.has(field)) add(`fee.${field}`, amount, FEE_FIELDS.has(field));
      for (const [field, amount] of b.tax) add(`tax.${field}`, amount, TAX_FIELDS.has(field));
    }
    // Credits are positive and deductions negative in TikTok's lines; a deduction is the positive amount taken, and a bucket of the other sign is not hidden: it stays in `other`.
    const sales = Decimal.max(ZERO, sum.sales);
    const refund = Decimal.max(ZERO, sum.refund.negated());
    const sellerDiscount = Decimal.max(ZERO, sum.sellerDiscount.negated());
    const commission = Decimal.max(ZERO, sum.commission.negated());
    const paymentFee = Decimal.max(ZERO, sum.paymentFee.negated());
    const shipping = Decimal.max(ZERO, sum.shipping.negated());
    const other = net.minus(sales.minus(sellerDiscount).minus(commission).minus(paymentFee).minus(shipping).minus(refund));
    // What a named bucket did not take (its field written with the other sign) is in `other` and is NAMED there, never hidden: the signed amount as written less what the bucket holds.
    const remainders: Array<[string, Dec, Dec]> = [
      ['revenue.subtotal_before_discount_amount', sum.sales, sales],
      ['revenue.refund_subtotal_before_discount_amount', sum.refund, refund.negated()],
      ['revenue.seller_discount_amount', sum.sellerDiscount, sellerDiscount.negated()],
      ['fee.platform_commission_amount', sum.commission, commission.negated()],
      ['fee.transaction_fee_amount', sum.paymentFee, paymentFee.negated()],
      ['shipping_cost_amount', sum.shipping, shipping.negated()],
    ];
    for (const [field, written, placed] of remainders) {
      const left = written.minus(placed);
      if (!left.isZero()) byField.set(field, { amount: left, known: true });
    }
    const detail = [...byField].filter(([, v]) => !v.amount.isZero()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const itemised = detail.reduce((total, [, v]) => total.plus(v.amount), ZERO);
    out.push({
      orderNo: first.orderNo,
      paidAt: first.paidAt,
      sales: toMoney(sales),
      sellerDiscount: toMoney(sellerDiscount),
      commission: toMoney(commission),
      serviceFee: '0',
      paymentFee: toMoney(paymentFee),
      shipping: toMoney(shipping),
      taxWithheld: '0',
      refund: toMoney(refund),
      other: toMoney(other),
      net: toMoney(net),
      carried: { vnFixInfrastructureFee: toMoney(carried.fee), pitAmount: toMoney(carried.pit), localVatAmount: toMoney(carried.localVat) },
      otherByField: detail.map(([field, v]) => ({ field, amount: toMoney(v.amount), known: v.known })),
      unitemised: toMoney(other.minus(itemised)),
      unknownField: detail.some(([, v]) => !v.known),
    });
  }
  return out.sort((a, b) => (a.paidAt < b.paidAt ? -1 : a.paidAt > b.paidAt ? 1 : a.orderNo < b.orderNo ? -1 : a.orderNo > b.orderNo ? 1 : 0));
}

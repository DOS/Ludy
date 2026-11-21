// SPDX-License-Identifier: AGPL-3.0-only
// What Lazada paid and kept, read from its finance API (#2524, S5a = #4242; plan https://github.com/DOS/Ludy/issues/4242#issuecomment-7058928952), DORMANT: nothing calls it yet, and it writes nothing. It
// returns plain data, the income of each order by day as the income path's lines hold it (sales, commission, payment fee, refund, `other`, net), which a later step writes as a file the income path stages
// for a member to confirm. Built from the OFFICIAL pages of open.lazada.com read 2026-11-21 in a headless browser (GetPayoutStatus, QueryTransactionDetails, docs 120956 and 120249; the table of what was
// confirmed is https://github.com/DOS/Ludy/issues/2522#issuecomment-7058540099). Nothing was checked against a real seller's answer (the live check, #2522, and the golden file of #2521 do that).
//
// READ ONLY, two paths, both GET (a test reads this source to keep it so), through the same signed caller as the orders adapter, so one app's calls are spaced whatever they ask for.
//
// THE MONEY. Every amount is a decimal STRING (at most four decimals; sums go through decimal.js, never a JS number); a number, an exponent, a thousands separator or a currency sign is refused. A
// payout statement writes its payout with the currency after it ("3962.41 EUR"): the numeric part is kept, the currency must be the market's (VND: the adapter's one host is the Vietnam market's, so
// the currency is fixed by the connection, never taken from the answer), and a different or malformed one refuses the whole page. A transaction line carries NO currency, so lines are accepted only for
// a window in which at least one statement was read and its currency checked, and only lines already PAID (a pending line is not income yet).
//
// WHAT IS NOT GUESSED. The fee of a line is its `fee_type` id looked up in the official table (marketplace-lazada-fees.ts), never the answer's `fee_name`; an id the table does not hold, a `paid_status`
// that is neither paid nor not paid, a date that is not "17 May 2016", an order number that is not digits, a window that does not fit the pages read: `not_recognized`, nothing returned. Only five fee
// types have a bucket of their own; every other goes to `other` with its id kept (`otherByFee`), until the accountant (#61) says how they post. Free text of the answer (details, comment, reference,
// SKUs, shipping provider) is dropped at the edge by an allow-list of fields.
import { Decimal } from '@crove/l10n-vn';
import { isoDay, marketplaceDigits, marketplaceMoney, notRecognized } from './marketplace-adapter-kit.ts';
import { LAZADA_FEE_BUCKET, LAZADA_FEE_TYPES } from './marketplace-lazada-fees.ts';
import { lazadaCaller, parseLazadaSecret, type LazadaCredential, type LazadaOptions } from './marketplace-lazada.ts';

// The only two paths this reader calls, both GET: the payout statements created after a day, and the transaction lines of a date range.
const STATEMENTS_PATH = '/finance/payout/status/get';
const TRANSACTIONS_PATH = '/finance/transaction/details/get';

// The answers' fields that hold an id which may pass 2^53 (kept as digits).
const FINANCE_ID_KEYS = ['order_no', 'orderItem_no'] as const;
// The official limits: at most 500 lines a call, and a window under 180 days (error 1000012). A window is read in at most this many days and this many full pages; one that needs more is refused, never cut.
export const LAZADA_FINANCE_PAGE = 500;
export const LAZADA_FINANCE_MAX_DAYS = 31;
const MAX_PAGES = 10;
const MAX_STATEMENTS = 200;
// The currency of the Vietnam market, whose host the adapter's fetch is bound to.
export const LAZADA_CURRENCY = 'VND';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// "3962.41 EUR" or "3962.41": the amount as a decimal string and the currency it names, or null for a form that is neither.
const AMOUNT_WITH_CURRENCY = /^(-?\d{1,16}(?:\.\d{1,4})?)(?: ([A-Z]{3}))?$/;
function statementAmount(value: unknown): string {
  const m = typeof value === 'string' ? AMOUNT_WITH_CURRENCY.exec(value.trim()) : null;
  // A currency other than the market's is a page of another market's money: refused whole.
  if (!m || (m[2] !== undefined && m[2] !== LAZADA_CURRENCY)) throw notRecognized();
  return m[1] as string;
}

export interface LazadaStatement {
  // The statement's number, as Lazada writes it.
  number: string;
  // What it paid out, a decimal string in the market's currency.
  payout: string;
}

interface Transaction {
  orderNo: string;
  day: string;
  amount: string;
  feeType: number;
  paid: boolean;
  vatInAmount: string;
  whtAmount: string;
}

export interface LazadaIncomeLine {
  orderNo: string;
  // YYYY-MM-DD, the transaction date of the lines it sums.
  paidAt: string;
  // Decimal strings, every deduction a positive amount taken from the seller, `other` and `net` signed: net = sales - commission - paymentFee - refund + other, exactly (the income path's identity).
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
  // What the lines say about VAT and withholding (VAT_in_amount, WHT_amount), carried and NOT read as tax withheld until the accountant says what they mean.
  vatInAmount: string;
  whtAmount: string;
  // The fee types with no bucket of their own, by id, with their summed amount (signed): what `other` is made of besides the signs of the five named buckets.
  otherByFee: Array<{ feeType: number; amount: string }>;
}

export interface LazadaIncome {
  currency: typeof LAZADA_CURRENCY;
  statements: LazadaStatement[];
  lines: LazadaIncomeLine[];
  // The lines read that were not paid yet, left out (a count only).
  pendingLines: number;
}

export interface LazadaWindow {
  // YYYY-MM-DD, both days included, at most LAZADA_FINANCE_MAX_DAYS days.
  startDay: string;
  endDay: string;
}

const MONTHS: Readonly<Record<string, number>> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// A transaction date as the official sample writes it, "17 May 2016", as YYYY-MM-DD; null when it is anything else.
function dayOf(value: unknown): string | null {
  const m = typeof value === 'string' ? /^(\d{1,2}) ([A-Za-z]{3,9}) (\d{4})$/.exec(value.trim()) : null;
  const month = m ? MONTHS[(m[2] as string).slice(0, 3).toLowerCase()] : undefined;
  if (!m || month === undefined) return null;
  const day = `${m[3]}-${String(month).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  return isoDay(day) ? day : null;
}

const toMoney = (value: Decimal): string => {
  const text = value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (text.abs().gte(new Decimal(10).pow(16))) throw notRecognized();
  return text.toFixed();
};

export interface LazadaFinance {
  // The payout statements created after a day (one call).
  statements(secret: string, createdAfter: string): Promise<LazadaStatement[]>;
  // The paid lines of a window as the income of each order by day, and the statements that settle the currency.
  income(secret: string, window: LazadaWindow): Promise<LazadaIncome>;
}

export function lazadaFinance(options: LazadaOptions, caller = lazadaCaller(options)): LazadaFinance {
  const call = (credential: LazadaCredential, path: string, params: Record<string, string>) => caller(credential, path, params, FINANCE_ID_KEYS);

  async function readStatements(credential: LazadaCredential, createdAfter: string): Promise<LazadaStatement[]> {
    if (!isoDay(createdAfter)) throw new RangeError('finance day');
    const data = await call(credential, STATEMENTS_PATH, { created_after: createdAfter });
    if (!Array.isArray(data) || data.length > MAX_STATEMENTS) throw notRecognized();
    const seen = new Set<string>();
    return data.map((raw): LazadaStatement => {
      if (!isRecord(raw)) throw notRecognized();
      const number = typeof raw.statement_number === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(raw.statement_number) ? raw.statement_number : null;
      if (number === null || seen.has(number)) throw notRecognized();
      seen.add(number);
      // Every money field the statement carries is checked (a suffix of another currency anywhere refuses the page); only the number and the payout are kept.
      for (const key of ['item_revenue', 'other_revenue_total', 'fees_total', 'refunds', 'fees_on_refunds_total', 'shipment_fee', 'subtotal1', 'subtotal2', 'paid']) {
        if (raw[key] !== undefined) statementAmount(raw[key]);
      }
      return { number, payout: statementAmount(raw.payout) };
    });
  }

  async function readTransactions(credential: LazadaCredential, window: LazadaWindow): Promise<Transaction[]> {
    const out: Transaction[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await call(credential, TRANSACTIONS_PATH, { start_time: window.startDay, end_time: window.endDay, limit: String(LAZADA_FINANCE_PAGE), offset: String(page * LAZADA_FINANCE_PAGE) });
      if (!Array.isArray(data) || data.length > LAZADA_FINANCE_PAGE) throw notRecognized();
      for (const raw of data) out.push(transactionOf(raw));
      if (data.length < LAZADA_FINANCE_PAGE) return out;
    }
    // A window with more lines than the pages read is not cut: the caller reads a shorter one.
    throw notRecognized();
  }

  return {
    statements: (secret, createdAfter) => readStatements(parseLazadaSecret(secret), createdAfter),

    async income(secret, window) {
      const span = isoDay(window.startDay) && isoDay(window.endDay) ? (Date.parse(window.endDay) - Date.parse(window.startDay)) / 86_400_000 : Number.NaN;
      if (!(span >= 0 && span < LAZADA_FINANCE_MAX_DAYS)) throw new RangeError('finance window');
      const credential = parseLazadaSecret(secret);
      const statements = await readStatements(credential, window.startDay);
      const lines = await readTransactions(credential, window);
      const paid = lines.filter((l) => l.paid);
      // No statement, no currency: paid lines with nothing to say what money they are in are not taken.
      if (paid.length > 0 && statements.length === 0) throw notRecognized();
      return { currency: LAZADA_CURRENCY, statements, lines: aggregate(paid), pendingLines: lines.length - paid.length };
    },
  };
}

// One line of the answer as only the fields the reader keeps; anything malformed or unknown refuses the page.
function transactionOf(raw: unknown): Transaction {
  if (!isRecord(raw)) throw notRecognized();
  const orderNo = marketplaceDigits(raw.order_no, 32);
  const day = dayOf(raw.transaction_date);
  const amount = marketplaceMoney(raw.amount);
  const feeId = typeof raw.fee_type === 'number' ? raw.fee_type : typeof raw.fee_type === 'string' && /^\d{1,6}$/.test(raw.fee_type) ? Number(raw.fee_type) : Number.NaN;
  const status = typeof raw.paid_status === 'string' ? raw.paid_status.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  // The VAT and withholding fields are optional; when present they are decimal strings like any amount.
  const vat = raw.VAT_in_amount === undefined ? '0' : marketplaceMoney(raw.VAT_in_amount);
  const wht = raw.WHT_amount === undefined ? '0' : marketplaceMoney(raw.WHT_amount);
  if (orderNo === null || day === null || amount === null || vat === null || wht === null || !LAZADA_FEE_TYPES.has(feeId) || (status !== 'paid' && status !== 'not paid')) throw notRecognized();
  return { orderNo, day, amount, feeType: feeId, paid: status === 'paid', vatInAmount: vat, whtAmount: wht };
}

// The paid lines of each order and day as one income line: the five named buckets, `other` as what they do not explain, `net` as the sum of every amount (the income path's identity).
function aggregate(lines: readonly Transaction[]): LazadaIncomeLine[] {
  const groups = new Map<string, Transaction[]>();
  for (const line of lines) {
    const key = `${line.orderNo}\u0000${line.day}`;
    const group = groups.get(key);
    if (group) group.push(line);
    else groups.set(key, [line]);
  }
  const ZERO = new Decimal(0);
  const out: LazadaIncomeLine[] = [];
  for (const group of groups.values()) {
    const first = group[0] as Transaction;
    const bucket = { sales: ZERO, refund: ZERO, commission: ZERO, paymentFee: ZERO };
    const byFee = new Map<number, Decimal>();
    let net = ZERO;
    let vat = ZERO;
    let wht = ZERO;
    for (const line of group) {
      const amount = new Decimal(line.amount);
      net = net.plus(amount);
      vat = vat.plus(line.vatInAmount);
      wht = wht.plus(line.whtAmount);
      const named = LAZADA_FEE_BUCKET.get(line.feeType);
      if (named) bucket[named] = bucket[named].plus(amount);
      else byFee.set(line.feeType, (byFee.get(line.feeType) ?? ZERO).plus(amount));
    }
    // Credits are positive and fees negative in Lazada's lines; a deduction is stored as the positive amount taken, and a bucket of the other sign is not hidden: it stays in `other`.
    const sales = Decimal.max(ZERO, bucket.sales);
    const refund = Decimal.max(ZERO, bucket.refund.negated());
    const commission = Decimal.max(ZERO, bucket.commission.negated());
    const paymentFee = Decimal.max(ZERO, bucket.paymentFee.negated());
    const other = net.minus(sales.minus(commission).minus(paymentFee).minus(refund));
    out.push({
      orderNo: first.orderNo,
      paidAt: first.day,
      sales: toMoney(sales),
      sellerDiscount: '0',
      commission: toMoney(commission),
      serviceFee: '0',
      paymentFee: toMoney(paymentFee),
      shipping: '0',
      taxWithheld: '0',
      refund: toMoney(refund),
      other: toMoney(other),
      net: toMoney(net),
      vatInAmount: toMoney(vat),
      whtAmount: toMoney(wht),
      otherByFee: [...byFee].sort((a, b) => a[0] - b[0]).map(([feeType, amount]) => ({ feeType, amount: toMoney(amount) })),
    });
  }
  return out.sort((a, b) => (a.paidAt < b.paidAt ? -1 : a.paidAt > b.paidAt ? 1 : a.orderNo < b.orderNo ? -1 : a.orderNo > b.orderNo ? 1 : 0));
}

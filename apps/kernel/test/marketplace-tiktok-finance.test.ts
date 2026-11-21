// SPDX-License-Identifier: AGPL-3.0-only
// The TikTok Shop finance reader (#2524, T3 = #4266) against a made-up TikTok (fake-tiktok.ts): the income lines hold the income path's identity exactly, the named buckets and `other` with its field names, the three
// carried fields never booked, adjustments apart from the lines, only PAID statements as income, every currency checked against dong, and hostile pages ending as `not_recognized`. No call to TikTok: the fetch is the fake.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Decimal } from '@crove/l10n-vn';
import { MarketplaceProviderError } from '@crove/mod-finance';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { TIKTOK_HOSTS } from '../src/marketplace-tiktok.ts';
import { TIKTOK_FINANCE_MAX_DAYS, tiktokFinance, type TiktokIncomeLine } from '../src/marketplace-tiktok-finance.ts';
import { fakeFinanceOrder, fakePayment, fakeShop, fakeStatement, fakeTiktok, type FakeTiktokOptions } from './fake-tiktok.ts';

const KEY = { appKey: '123abc', appSecret: 'helloworld', accessToken: 'TTP_access_token_1' };
const CIPHER = 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3';
const SECRET = JSON.stringify({ ...KEY, shopCipher: CIPHER, shopId: '7000714532876273420' });
const NOW = Date.parse('2026-11-21T08:00:00Z');
const WINDOW = { startDay: '2026-11-15', endDay: '2026-11-21' };
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
// A statement generated and paid on 2026-11-19 (Vietnam).
const STATEMENT_TIME = sec('2026-11-19T01:00:00Z');
const PAID_TIME = sec('2026-11-19T10:00:00Z');

function setup(over: Partial<FakeTiktokOptions> = {}) {
  const fake = fakeTiktok({ ...KEY, shops: [fakeShop()], now: () => NOW, ...over });
  const finance = tiktokFinance({ fetch: hostBoundFetch(TIKTOK_HOSTS, fake.fetch), now: () => new Date(NOW), sleep: async () => undefined });
  return { finance, fake };
}

// One PAID statement of the given transactions.
function withStatement(transactions: Array<Record<string, unknown>>, over: Partial<FakeTiktokOptions> = {}, statement: Record<string, unknown> = {}) {
  const s = fakeStatement({ statement_time: STATEMENT_TIME, payment_time: PAID_TIME, ...statement });
  return setup({ statements: [s], statementTransactions: { [String(s.id)]: { transactions } }, payments: [], ...over });
}

const kindOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'no error';
  } catch (error) {
    if (error instanceof RangeError) return 'range';
    return error instanceof MarketplaceProviderError ? error.kind : `other: ${String(error)}`;
  }
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The income path's identity, with every figure a decimal string.
const identityHolds = (l: TiktokIncomeLine): boolean => {
  const d = (v: string) => new Decimal(v);
  const explained = d(l.sales).minus(l.sellerDiscount).minus(l.commission).minus(l.serviceFee).minus(l.paymentFee).minus(l.shipping).minus(l.taxWithheld).minus(l.refund).plus(l.other);
  return explained.eq(d(l.net));
};

describe('the income lines', () => {
  it('puts the named fields in their buckets, everything else in `other` with its field name, and keeps the identity exactly', async () => {
    const order = fakeFinanceOrder();
    const { finance } = withStatement([order]);
    const income = await finance.income(SECRET, WINDOW);
    expect(income.currency).toBe('VND');
    expect(income.lines).toHaveLength(1);
    const line = income.lines[0]!;
    expect(line).toMatchObject({ orderNo: order.order_id, paidAt: '2026-11-19', sales: '120000', sellerDiscount: '10000', commission: '9000', paymentFee: '3000', shipping: '8000', refund: '0', serviceFee: '0', taxWithheld: '0', net: '82000', other: '-8000' });
    expect(line.otherByField).toEqual([
      { field: 'fee.referral_fee_amount', amount: '-2000', known: true },
      { field: 'fee.vn_fix_infrastructure_fee', amount: '-1000', known: true },
      { field: 'tax.local_vat_amount', amount: '-3500', known: true },
      { field: 'tax.pit_amount', amount: '-1500', known: true },
    ]);
    // What `other` is made of is exactly what is named beside it.
    expect(line.otherByField.reduce((sum, f) => sum.plus(f.amount), new Decimal(0)).eq(line.other)).toBe(true);
    expect(line.unitemised).toBe('0');
    expect(line.unknownField).toBe(false);
    expect(identityHolds(line)).toBe(true);
  });

  it('carries vn_fix_infrastructure_fee, pit_amount and local_vat_amount as fields of their own and books none of them', async () => {
    const { finance } = withStatement([fakeFinanceOrder()]);
    const line = (await finance.income(SECRET, WINDOW)).lines[0]!;
    expect(line.carried).toEqual({ vnFixInfrastructureFee: '-1000', pitAmount: '-1500', localVatAmount: '-3500' });
    // Not tax withheld, not a fee bucket: the tax bucket is 0 and the fee buckets are only commission and the transaction fee.
    expect(line.taxWithheld).toBe('0');
    expect(line.commission).toBe('9000');
    expect(line.paymentFee).toBe('3000');
    expect(line.serviceFee).toBe('0');
  });

  it('holds the identity for lines of every sign and size, with refunds and a bucket written the other way', async () => {
    const mixes: Array<Record<string, unknown>> = [
      fakeFinanceOrder({ settlement_amount: '-5000', revenue_breakdown: { subtotal_before_discount_amount: '0', refund_subtotal_before_discount_amount: '-20000', seller_discount_amount: '10000', seller_discount_refund_amount: '12000' }, shipping_cost_amount: '-7000', fee_tax_breakdown: { fee: { platform_commission_amount: '3000', transaction_fee_amount: '-0.5', referral_fee_amount: '1' }, tax: { pit_amount: '4' } } }),
      fakeFinanceOrder({ settlement_amount: '1234.5678', revenue_breakdown: { subtotal_before_discount_amount: '99999.9999' }, shipping_cost_amount: '', fee_tax_breakdown: { fee: {}, tax: {} } }),
      fakeFinanceOrder({ settlement_amount: '0', revenue_breakdown: {}, fee_tax_breakdown: undefined, shipping_cost_amount: undefined }),
      fakeFinanceOrder({ settlement_amount: '-99', revenue_breakdown: { subtotal_before_discount_amount: '-5' }, fee_tax_breakdown: { fee: { platform_commission_amount: '-0.0001' } } }),
    ];
    const { finance } = withStatement(mixes);
    const income = await finance.income(SECRET, WINDOW);
    expect(income.lines).toHaveLength(4);
    for (const line of income.lines) {
      expect(identityHolds(line)).toBe(true);
      // What is named plus what is not named is `other`, to the last decimal.
      expect(line.otherByField.reduce((sum, f) => sum.plus(f.amount), new Decimal(line.unitemised)).eq(line.other)).toBe(true);
    }
    // A settlement that is not the sum of the parts the answer lists shows its gap, never hides it.
    const gap = income.lines.filter((l) => l.unitemised !== '0');
    expect(gap.length).toBeGreaterThan(0);
  });

  it('names a bucket written with the other sign in `other`, never hiding it', async () => {
    const order = fakeFinanceOrder({ settlement_amount: '100000', revenue_breakdown: { subtotal_before_discount_amount: '120000', seller_discount_amount: '10000' }, shipping_cost_amount: '-8000', fee_tax_breakdown: { fee: { platform_commission_amount: '-2000' }, tax: {} } });
    const line = (await withStatement([order]).finance.income(SECRET, WINDOW)).lines[0]!;
    // A positive seller discount is not a deduction: the bucket stays 0 and the amount is in `other` under its name.
    expect(line.sellerDiscount).toBe('0');
    expect(line.otherByField).toContainEqual({ field: 'revenue.seller_discount_amount', amount: '10000', known: true });
    expect(identityHolds(line)).toBe(true);
  });

  it('reads a refund as the positive amount taken', async () => {
    const order = fakeFinanceOrder({ settlement_amount: '-15000', revenue_breakdown: { subtotal_before_discount_amount: '0', refund_subtotal_before_discount_amount: '-20000', seller_discount_amount: '0' }, shipping_cost_amount: '0', fee_tax_breakdown: { fee: { platform_commission_amount: '5000' }, tax: {} } });
    const line = (await withStatement([order]).finance.income(SECRET, WINDOW)).lines[0]!;
    expect(line.refund).toBe('20000');
    expect(line.sales).toBe('0');
    expect(identityHolds(line)).toBe(true);
  });

  it('stages a field the official table does not hold in `other` and flags it, and does not refuse the page', async () => {
    const order = fakeFinanceOrder({ fee_tax_breakdown: { fee: { platform_commission_amount: '-9000', transaction_fee_amount: '-3000', brand_new_fee_amount: '-500', zero_new_fee: '0' }, tax: { new_tax_amount: '-100' } }, revenue_breakdown: { subtotal_before_discount_amount: '120000', seller_discount_amount: '-10000', new_revenue_part: '70' }, settlement_amount: '90000' });
    const line = (await withStatement([order]).finance.income(SECRET, WINDOW)).lines[0]!;
    expect(line.unknownField).toBe(true);
    expect(line.otherByField).toContainEqual({ field: 'fee.brand_new_fee_amount', amount: '-500', known: false });
    expect(line.otherByField).toContainEqual({ field: 'tax.new_tax_amount', amount: '-100', known: false });
    expect(line.otherByField).toContainEqual({ field: 'revenue.new_revenue_part', amount: '70', known: false });
    // A new field with a zero amount is nothing to show.
    expect(line.otherByField.some((f) => f.field === 'fee.zero_new_fee')).toBe(false);
    expect(identityHolds(line)).toBe(true);
  });

  it('sums the lines of one order in one statement into one line, and writes one line for each payout day', async () => {
    const first = fakeFinanceOrder({ settlement_amount: '82000' });
    const second = fakeFinanceOrder({ order_id: first.order_id, settlement_amount: '-5000', revenue_breakdown: { subtotal_before_discount_amount: '0', refund_subtotal_before_discount_amount: '-6000' }, shipping_cost_amount: '0', fee_tax_breakdown: { fee: {}, tax: {} } });
    const sameDay = (await withStatement([first, second]).finance.income(SECRET, WINDOW)).lines;
    expect(sameDay).toHaveLength(1);
    expect(sameDay[0]).toMatchObject({ net: '77000', refund: '6000' });
    expect(identityHolds(sameDay[0]!)).toBe(true);
    // The same order paid out again on another day is its own line.
    const a = fakeStatement({ statement_time: STATEMENT_TIME, payment_time: PAID_TIME });
    const b = fakeStatement({ statement_time: STATEMENT_TIME + 86_400, payment_time: PAID_TIME + 86_400 });
    const { finance } = setup({ statements: [a, b], statementTransactions: { [String(a.id)]: { transactions: [first] }, [String(b.id)]: { transactions: [fakeFinanceOrder({ order_id: first.order_id })] } } });
    const lines = (await finance.income(SECRET, WINDOW)).lines;
    expect(lines.map((l) => l.paidAt)).toEqual(['2026-11-19', '2026-11-20']);
  });

  it('keeps adjustments and reserves apart from the lines of an order', async () => {
    const order = fakeFinanceOrder();
    const penalty = { id: '1636700041413500001', type: 'PLATFORM_PENALTY', adjustment_id: '7238804564097517001', adjustment_amount: '-50000', settlement_amount: '-50000' };
    const strange = { id: '1636700041413500002', type: 'SOMETHING_NEW', adjustment_id: '7238804564097517002', adjustment_order_id: String(order.order_id), adjustment_amount: '700' };
    const reserve = { id: '1636700041413500003', type: 'RESERVE', settlement_amount: '-300' };
    const income = await withStatement([order, penalty, strange, reserve]).finance.income(SECRET, WINDOW);
    expect(income.lines).toHaveLength(1);
    expect(income.lines[0]!.net).toBe('82000');
    expect(income.adjustments.map((a) => ({ type: a.type, amount: a.amount, orderNo: a.orderNo, known: a.known, paidAt: a.paidAt }))).toEqual(
      expect.arrayContaining([
        { type: 'PLATFORM_PENALTY', amount: '-50000', orderNo: null, known: true, paidAt: '2026-11-19' },
        { type: 'SOMETHING_NEW', amount: '700', orderNo: String(order.order_id), known: false, paidAt: '2026-11-19' },
        { type: 'RESERVE', amount: '-300', orderNo: null, known: true, paidAt: '2026-11-19' },
      ]),
    );
    expect(income.adjustments).toHaveLength(3);
  });

  it('counts a statement that is not PAID and reads no transaction of it', async () => {
    const paid = fakeStatement({ statement_time: STATEMENT_TIME, payment_time: PAID_TIME });
    const others = ['PROCESSING', 'SETTLED', 'FAILED'].map((payment_status, i) => fakeStatement({ statement_time: STATEMENT_TIME + 60 * (i + 1), payment_status, payment_time: 0 }));
    const { finance, fake } = setup({ statements: [paid, ...others], statementTransactions: { [String(paid.id)]: { transactions: [fakeFinanceOrder()] } } });
    const income = await finance.income(SECRET, WINDOW);
    expect(income.pendingStatements).toBe(3);
    expect(income.statements).toHaveLength(4);
    expect(income.lines).toHaveLength(1);
    const asked = fake.calls.filter((c) => c.path.includes('/statement_transactions')).map((c) => c.path);
    expect(asked).toEqual([`/finance/202501/statements/${String(paid.id)}/statement_transactions`]);
  });

  it('returns the payouts of a window, in dong, and keeps no bank account', async () => {
    const paid = fakePayment({ create_time: PAID_TIME - 100, paid_time: PAID_TIME });
    const failed = fakePayment({ create_time: PAID_TIME, status: 'FAILED', paid_time: 0 });
    const { finance } = setup({ payments: [failed, paid] });
    const payments = await finance.payments(SECRET, WINDOW);
    expect(payments).toEqual([
      { id: paid.id, status: 'PAID', createdDay: '2026-11-19', paidDay: '2026-11-19', amount: '1000000' },
      { id: failed.id, status: 'FAILED', createdDay: '2026-11-19', paidDay: null, amount: '1000000' },
    ]);
    expect(JSON.stringify(payments)).not.toContain('1234');
  });

  it('reads many pages of one statement and refuses a statement that needs more pages than are read', async () => {
    const many = Array.from({ length: 250 }, () => fakeFinanceOrder());
    const { finance, fake } = withStatement(many);
    const income = await finance.income(SECRET, WINDOW);
    expect(income.lines).toHaveLength(250);
    expect(fake.calls.filter((c) => c.path.includes('/statement_transactions'))).toHaveLength(3);
    const tooMany = Array.from({ length: 1001 }, () => fakeFinanceOrder());
    expect(await kindOf(() => withStatement(tooMany).finance.income(SECRET, WINDOW))).toBe('not_recognized');
  });
});

describe('the currency and the money', () => {
  const income = (over: Partial<FakeTiktokOptions>) => setup(over).finance.income(SECRET, WINDOW);

  it('refuses a statement, a page of transactions and a payment that is not in dong, or was exchanged', async () => {
    const order = fakeFinanceOrder();
    const usd = fakeStatement({ statement_time: STATEMENT_TIME, payment_time: PAID_TIME, currency: 'USD' });
    expect(await kindOf(() => income({ statements: [usd], statementTransactions: {} }))).toBe('not_recognized');
    const s = fakeStatement({ statement_time: STATEMENT_TIME, payment_time: PAID_TIME });
    expect(await kindOf(() => income({ statements: [s], statementTransactions: { [String(s.id)]: { currency: 'USD', transactions: [order] } } }))).toBe('not_recognized');
    for (const payment of [
      fakePayment({ create_time: PAID_TIME, amount: { value: '1000000', currency: 'USD' } }),
      fakePayment({ create_time: PAID_TIME, settlement_amount: { value: '1', currency: 'USD' } }),
      fakePayment({ create_time: PAID_TIME, payment_amount_before_exchange: { value: '1', currency: 'EUR' } }),
      fakePayment({ create_time: PAID_TIME, exchange_rate: '24500.000000' }),
      fakePayment({ create_time: PAID_TIME, amount: undefined }),
      fakePayment({ create_time: PAID_TIME, amount: { value: 1000000, currency: 'VND' } }),
    ]) {
      expect(await kindOf(() => income({ payments: [payment], statements: [] }))).toBe('not_recognized');
    }
  });

  it('refuses a number, an exponent, a separator or a currency sign as an amount, and an unknown shape', async () => {
    const bads: Array<Record<string, unknown>> = [
      fakeFinanceOrder({ settlement_amount: 82000 }),
      fakeFinanceOrder({ settlement_amount: '8.2e4' }),
      fakeFinanceOrder({ settlement_amount: '82,000' }),
      fakeFinanceOrder({ settlement_amount: '82000 VND' }),
      fakeFinanceOrder({ settlement_amount: undefined }),
      fakeFinanceOrder({ revenue_breakdown: { subtotal_before_discount_amount: 120000 } }),
      fakeFinanceOrder({ revenue_breakdown: { subtotal_before_discount_amount: '1.00001' } }),
      fakeFinanceOrder({ fee_tax_breakdown: { fee: { platform_commission_amount: { value: '-9000' } }, tax: {} } }),
      fakeFinanceOrder({ fee_tax_breakdown: { fee: { 'bad field name!': '1' }, tax: {} } }),
      fakeFinanceOrder({ fee_tax_breakdown: 'none' }),
      fakeFinanceOrder({ shipping_cost_amount: '-8000.5.5' }),
      fakeFinanceOrder({ order_id: 'order-1' }),
      fakeFinanceOrder({ id: 'tx' }),
      { ...fakeFinanceOrder(), type: '' },
    ];
    for (const bad of bads) expect(await kindOf(() => withStatement([bad]).finance.income(SECRET, WINDOW))).toBe('not_recognized');
    const amounts = [fakeStatement({ statement_time: STATEMENT_TIME, payment_time: PAID_TIME, settlement_amount: 1000000 }), fakeStatement({ statement_time: STATEMENT_TIME, payment_time: PAID_TIME, fee_amount: '1,0' })];
    for (const s of amounts) expect(await kindOf(() => income({ statements: [s], statementTransactions: {} }))).toBe('not_recognized');
  });

  it('refuses an unknown status, a PAID statement without a payment time, a duplicate id and a page with no list', async () => {
    const t = { statement_time: STATEMENT_TIME, payment_time: PAID_TIME };
    for (const s of [fakeStatement({ ...t, payment_status: 'DONE' }), fakeStatement({ ...t, payment_time: 0 }), fakeStatement({ ...t, id: 'abc' }), fakeStatement({ ...t, statement_time: 'yesterday' })]) {
      expect(await kindOf(() => income({ statements: [s], statementTransactions: {} }))).toBe('not_recognized');
    }
    const a = fakeStatement(t);
    expect(await kindOf(() => income({ statements: [a, a], statementTransactions: { [String(a.id)]: { transactions: [] } } }))).toBe('not_recognized');
    const tx = fakeFinanceOrder();
    expect(await kindOf(() => withStatement([tx, tx]).finance.income(SECRET, WINDOW))).toBe('not_recognized');
    const p = fakePayment({ create_time: PAID_TIME });
    expect(await kindOf(() => income({ payments: [p, p], statements: [] }))).toBe('not_recognized');
    expect(await kindOf(() => income({ payments: [fakePayment({ create_time: PAID_TIME, status: 'DONE' })], statements: [] }))).toBe('not_recognized');
    const counts = setup({ intercept: (_h, path) => (path === '/finance/202309/statements' ? json({ code: 0, data: { total_count: 3, next_page_token: '' } }) : undefined) });
    expect(await kindOf(() => counts.finance.income(SECRET, WINDOW))).toBe('not_recognized');
    const wrongStatement = (() => {
      const s = fakeStatement(t);
      return setup({ statements: [s], statementTransactions: { [String(s.id)]: { transactions: [] } }, intercept: (_h, path) => (path.endsWith('/statement_transactions') ? json({ code: 0, data: { id: '1', currency: 'VND', transactions: [], next_page_token: '' } }) : undefined) });
    })();
    expect(await kindOf(() => wrongStatement.finance.income(SECRET, WINDOW))).toBe('not_recognized');
  });

  it('refuses more statements than a window of days can hold, and an empty window answers empty', async () => {
    const statements = Array.from({ length: 101 }, (_, i) => fakeStatement({ statement_time: STATEMENT_TIME + i, payment_status: 'PROCESSING', payment_time: 0 }));
    expect(await kindOf(() => income({ statements }))).toBe('not_recognized');
    const empty = await setup().finance.income(SECRET, WINDOW);
    expect(empty).toMatchObject({ currency: 'VND', statements: [], payments: [], lines: [], adjustments: [], pendingStatements: 0 });
  });
});

describe('the request', () => {
  it('asks for a window in Vietnam days by GET, sorted as the pages require, with the shop and the token in a header only', async () => {
    const { finance, fake } = withStatement([fakeFinanceOrder()], { payments: [fakePayment({ create_time: PAID_TIME })] });
    await finance.income(SECRET, WINDOW);
    const byPath = (suffix: string) => fake.calls.find((c) => c.path.endsWith(suffix))!;
    const startSec = Date.parse('2026-11-15T00:00:00+07:00') / 1000;
    const endSec = Date.parse('2026-11-22T00:00:00+07:00') / 1000;
    expect(byPath('/finance/202309/statements').query).toMatchObject({ statement_time_ge: String(startSec), statement_time_lt: String(endSec), sort_field: 'statement_time', sort_order: 'ASC', page_size: '100', shop_cipher: CIPHER });
    expect(byPath('/statement_transactions').query).toMatchObject({ sort_field: 'order_create_time', page_size: '100', shop_cipher: CIPHER });
    expect(byPath('/finance/202605/payments').query).toMatchObject({ create_time_ge: String(startSec), create_time_lt: String(endSec), sort_field: 'create_time', shop_cipher: CIPHER });
    for (const call of fake.calls) {
      expect(call.method).toBe('GET');
      expect(call.body).toBeNull();
      expect(call.headers['x-tts-access-token']).toBe(KEY.accessToken);
      expect(call.url).not.toContain(KEY.accessToken);
      expect(call.url).not.toContain(KEY.appSecret);
      expect(call.host).toBe('open-api.tiktokglobalshop.com');
    }
  });

  it('refuses a window that is not days or is longer than the limit, and a connection with no shop, before any call', async () => {
    const { finance, fake } = setup();
    expect(await kindOf(() => finance.income(SECRET, { startDay: '2026-11-21', endDay: '2026-11-15' }))).toBe('range');
    expect(await kindOf(() => finance.income(SECRET, { startDay: '2026-11-15', endDay: '2026-11-31' }))).toBe('range');
    expect(await kindOf(() => finance.income(SECRET, { startDay: '2026-10-01', endDay: `2026-11-0${1}` }))).toBe('range');
    expect(TIKTOK_FINANCE_MAX_DAYS).toBe(31);
    expect(await kindOf(() => finance.income(JSON.stringify(KEY), WINDOW))).toBe('credentials');
    expect(fake.calls).toHaveLength(0);
    // The longest window is read.
    expect(await kindOf(() => finance.income(SECRET, { startDay: '2026-10-22', endDay: '2026-11-20' }))).toBe('no error');
  });

  it('maps a refused token, a wrong secret and a throttle to the port kinds', async () => {
    const wrong = setup().finance;
    expect(await kindOf(() => wrong.income(JSON.stringify({ ...KEY, appSecret: 'other', shopCipher: CIPHER }), WINDOW))).toBe('credentials');
    const throttled = setup({ intercept: (_h, path) => (path === '/finance/202309/statements' ? json({ code: 36009002, message: 'slow' }, 429) : undefined) });
    expect(await kindOf(() => throttled.finance.income(SECRET, WINDOW))).toBe('rate_limited');
  });
});

describe('what is kept', () => {
  it('keeps no seller, bank or buyer field: a masked bank account, an invoice name and every field beyond the allow-list are in no output', async () => {
    const { finance } = withStatement([fakeFinanceOrder()], { payments: [fakePayment({ create_time: PAID_TIME })] });
    const income = await finance.income(SECRET, WINDOW);
    const text = JSON.stringify(income);
    for (const planted of ['***********1234', 'Nguyễn Văn Thử', 'customer_payment_amount', 'supplementary_component']) expect(text).not.toContain(planted);
  });
});

describe('the source', () => {
  const source = readFileSync(new URL('../src/marketplace-tiktok-finance.ts', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');

  it('calls three finance paths by GET, and no other path or method, and makes no request of its own', () => {
    expect(code).toContain("method: 'GET'");
    expect(code).not.toMatch(/method: '(POST|PUT|PATCH|DELETE)'/);
    const paths = [...code.matchAll(/'(\/finance\/\d{6}\/[^']*)'|`(\/finance\/\d{6}\/[^`]*)`/g)].map((m) => m[1] ?? m[2]);
    expect(paths.sort()).toEqual(['/finance/202309/statements', '/finance/202501/statements/${id}/statement_transactions', '/finance/202605/payments']);
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|node:http|node:net/);
    expect(code).not.toMatch(/https?:\/\//);
    // The sunset version of the payments page is not called.
    expect(code).not.toContain('202309/payments');
    expect(code).not.toMatch(/withdraw|unsettled/i);
  });

  it('never reads a bank account or a person by name', () => {
    for (const name of ['bank_account', 'payee', 'buyer', 'recipient', 'user_id', 'email']) expect(code).not.toContain(`'${name}'`);
  });
});

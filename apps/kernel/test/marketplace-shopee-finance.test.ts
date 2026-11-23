// SPDX-License-Identifier: AGPL-3.0-only
// The Shopee finance reader (#2524, S3 = #4290) against a made-up Shopee: what Shopee paid and kept, the income of each paid-out order as the income path's lines hold it. What is pinned: the identity of the income path holds
// exactly for every order; every amount is the exact text Shopee wrote (a float would round it) and an exponent or more than four decimals refuses the page; only six fields have a bucket and everything else is in `other` by name
// (a field the official formula does not sign is flagged, never refused); the Vietnam withholding fields are carried and never booked; no buyer, payment or adjustment field is read; and the reader is GET only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Decimal } from '@ludy/l10n-vn';
import { MarketplaceProviderError } from '@ludy/mod-finance';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { SHOPEE_HOSTS, shopeeCaller } from '../src/marketplace-shopee.ts';
import { shopeeFinance, type ShopeeIncomeLine } from '../src/marketplace-shopee-finance.ts';
import { fakeShopee, type FakeShopeeEscrow } from './fake-shopee.ts';

const NOW = Date.parse('2026-11-21T08:00:00Z');
const DAY = 86_400_000;
const CRED = { partnerId: '1000012', partnerKey: 'test-only-partner-key', shopId: '77777', accessToken: 'SHP_access' };
const SECRET = JSON.stringify(CRED);
const WINDOW = { startDay: '2026-11-10', endDay: '2026-11-20' };
// Noon in Vietnam on the 15th.
const RELEASE = Date.parse('2026-11-15T05:00:00Z');

const escrow = (orderSn: string, income: Record<string, string>, over: Partial<FakeShopeeEscrow> = {}): FakeShopeeEscrow => ({ orderSn, releaseMs: RELEASE, payout: '88000', income, ...over });
// A plain order: sales 100000, seller voucher 5000, commission 4000, service 3000, transaction fee 2000, shipping 8000 taken; the payout of the list is 78000.
const plain = (orderSn = 'A1', over: Partial<FakeShopeeEscrow> = {}, income: Record<string, string> = {}): FakeShopeeEscrow =>
  escrow(orderSn, { escrow_amount: '78000.0', original_cost_of_goods_sold: '100000.0', voucher_from_seller: '5000.0', commission_fee: '4000.0', service_fee: '3000.0', seller_transaction_fee: '2000.0', actual_shipping_fee: '8000.0', ...income }, { payout: '78000.0', ...over });

function setup(escrows: FakeShopeeEscrow[], intercept?: (path: string, query: Record<string, string>) => Response | undefined) {
  const fake = fakeShopee({ ...CRED, escrows, now: () => NOW, ...(intercept ? { intercept } : {}) });
  const options = { fetch: hostBoundFetch(SHOPEE_HOSTS, fake.fetch), now: () => new Date(NOW), spacingMs: 0 };
  return { fake, finance: shopeeFinance(options, shopeeCaller(options)) };
}
const kindOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'no error';
  } catch (error) {
    return error instanceof MarketplaceProviderError ? error.kind : error instanceof RangeError ? 'RangeError' : `other: ${String(error)}`;
  }
};
const D = (v: string) => new Decimal(v);
// The identity of the income path.
const identity = (l: ShopeeIncomeLine): boolean =>
  D(l.sales).minus(l.sellerDiscount).minus(l.commission).minus(l.serviceFee).minus(l.paymentFee).minus(l.shipping).minus(l.taxWithheld).minus(l.refund).plus(l.other).eq(l.net);

describe('the income of an order', () => {
  it('puts the six named fields in their buckets and keeps the identity exactly', async () => {
    const { finance } = setup([plain()]);
    const income = await finance.income(SECRET, WINDOW);
    expect(income.currency).toBe('VND');
    expect(income.payouts).toEqual([{ orderNo: 'A1', payout: '78000.0', paidAt: '2026-11-15' }]);
    const [line] = income.lines;
    expect(line).toMatchObject({ orderNo: 'A1', paidAt: '2026-11-15', sales: '100000', sellerDiscount: '5000', commission: '4000', serviceFee: '3000', paymentFee: '2000', shipping: '8000', taxWithheld: '0', refund: '0', net: '78000', other: '0' });
    expect(identity(line!)).toBe(true);
    // 100000 - 5000 - 4000 - 3000 - 2000 - 8000 = 78000: the named fields explain the payout and nothing is left over.
    expect(line!.unitemised).toBe('0');
    expect(line!.otherByField).toEqual([]);
  });

  it('keeps every amount as the exact text and does not let a float round it', async () => {
    const { finance } = setup([escrow('A1', { original_cost_of_goods_sold: '0.3', commission_fee: '0.1', service_fee: '0.2' }, { payout: '0.0' })]);
    const [line] = (await finance.income(SECRET, WINDOW)).lines;
    // A JS float gives 0.3 - 0.1 - 0.2 = -2.7e-17: the decimal strings are exact.
    expect(line).toMatchObject({ sales: '0.3', commission: '0.1', serviceFee: '0.2', other: '0', net: '0', unitemised: '0' });
    const big = setup([escrow('A1', { original_cost_of_goods_sold: '4503599627370497.5' }, { payout: '4503599627370497.5' })]);
    expect((await big.finance.income(SECRET, WINDOW)).lines[0]).toMatchObject({ sales: '4503599627370497.5', net: '4503599627370497.5', other: '0' });
  });

  it('carries the Vietnam withholding fields and the seller\'s tax code, books none of them, and does not flag them', async () => {
    const { finance } = setup([plain('A1', { extraIncome: ['"tax_registration_code":"8881234567-888"'] }, { withholding_vat_tax: '1000.0', withholding_pit_tax: '500.0', withholding_cit_tax: '0.0' })]);
    const [line] = (await finance.income(SECRET, WINDOW)).lines;
    expect(line!.carried).toEqual({ withholdingVat: '1000', withholdingPit: '500', withholdingCit: '0', taxRegistrationCode: '8881234567-888' });
    expect(line!.taxWithheld).toBe('0');
    expect(line!.otherByField).toEqual(expect.arrayContaining([{ field: 'withholding_pit_tax', amount: '500', signed: false }, { field: 'withholding_vat_tax', amount: '1000', signed: false }]));
    expect(line!.unknownField).toBe(false);
    expect(identity(line!)).toBe(true);
  });

  it('reads a tax code made only of digits as text, never as money', async () => {
    const { finance } = setup([plain('A1', { extraIncome: ['"tax_registration_code":"8881234567"'] })]);
    expect((await finance.income(SECRET, WINDOW)).lines[0]!.carried.taxRegistrationCode).toBe('8881234567');
  });

  it('signs the rest of the official formula, so the identity is explained, and names them by field', async () => {
    const { finance } = setup([plain('A1', {}, { buyer_paid_shipping_fee: '5000.0', shopee_shipping_rebate: '1000.0', reverse_shipping_fee: '3000.0', seller_coin_cash_back: '500.0', campaign_fee: '700.0' })]);
    const [line] = (await finance.income(SECRET, WINDOW)).lines;
    const by = new Map(line!.otherByField.map((f) => [f.field, f]));
    expect(by.get('buyer_paid_shipping_fee')).toEqual({ field: 'buyer_paid_shipping_fee', amount: '5000', signed: true });
    expect(by.get('shopee_shipping_rebate')?.amount).toBe('1000');
    expect(by.get('reverse_shipping_fee')?.amount).toBe('-3000');
    expect(by.get('seller_coin_cash_back')?.amount).toBe('-500');
    expect(by.get('campaign_fee')?.amount).toBe('-700');
    // The sum of the signed parts is what `other` has that a field explains; the rest is shown, not hidden.
    const signedSum = line!.otherByField.filter((f) => f.signed).reduce((t, f) => t.plus(f.amount), D('0'));
    expect(D(line!.other).minus(signedSum).toFixed()).toBe(line!.unitemised);
    expect(line!.unknownField).toBe(false);
  });

  it('returns a field the formula does not sign as written, flags the line, and never refuses it', async () => {
    const { finance } = setup([plain('A1', {}, { some_new_fee: '1234.0' })]);
    const [line] = (await finance.income(SECRET, WINDOW)).lines;
    expect(line!.otherByField).toContainEqual({ field: 'some_new_fee', amount: '1234', signed: false });
    expect(line!.unknownField).toBe(true);
    expect(identity(line!)).toBe(true);
  });

  it('does not hide a bucket field written with the other sign: it stays in other, named', async () => {
    const { finance } = setup([plain('A1', {}, { commission_fee: '-500.0' })]);
    const [line] = (await finance.income(SECRET, WINDOW)).lines;
    expect(line!.commission).toBe('0');
    expect(line!.otherByField).toContainEqual({ field: 'commission_fee', amount: '500', signed: true });
    expect(identity(line!)).toBe(true);
  });

  it('flags a detail whose own settlement is not the payout of the list, and a weight that is not a plain decimal does not refuse the order', async () => {
    const { finance } = setup([plain('A1', {}, { escrow_amount: '77000.0', order_chargeable_weight: '1.23456789' }), plain('B2', {}, { escrow_amount: '99000.0', escrow_amount_after_adjustment: '78000.0' })]);
    const lines = (await finance.income(SECRET, WINDOW)).lines;
    expect(lines.map((l) => [l.orderNo, l.payoutDiffersFromDetail])).toEqual([['A1', true], ['B2', false]]);
  });

  it('does not take a field named like an object member for a signed one', async () => {
    // Object.fromEntries makes `__proto__` an own member (an object literal would set the prototype instead).
    const { finance } = setup([plain('A1', {}, Object.fromEntries([['constructor', '5.0'], ['__proto__', '7.0']]))]);
    const [line] = (await finance.income(SECRET, WINDOW)).lines;
    expect(line!.otherByField).toEqual(expect.arrayContaining([{ field: 'constructor', amount: '5', signed: false }, { field: '__proto__', amount: '7', signed: false }]));
    expect(line!.unknownField).toBe(true);
  });

  it('reads no buyer, payment or adjustment field, and nothing of the answer outside the allow-list', async () => {
    const { finance } = setup([plain()]);
    const income = await finance.income(SECRET, WINDOW);
    expect(JSON.stringify(income)).not.toMatch(/nguyenvanthu|buyer_payment|Bank|adjustment|item_name|buyer_total/);
  });

  it('puts the payout day in Vietnam time and the window in Vietnam days', async () => {
    // 17:30 UTC on the 14th is 00:30 on the 15th in Vietnam.
    const late = plain('A1', { releaseMs: Date.parse('2026-11-14T17:30:00Z') });
    const { finance, fake } = setup([late]);
    expect((await finance.income(SECRET, WINDOW)).lines[0]!.paidAt).toBe('2026-11-15');
    const list = fake.calls.find((c) => c.path === '/api/v2/payment/get_escrow_list')!;
    expect(list.query).toMatchObject({ release_time_from: String(Date.parse('2026-11-09T17:00:00Z') / 1000), release_time_to: String(Date.parse('2026-11-20T17:00:00Z') / 1000 - 1), page_size: '100', page_no: '1' });
  });

  it('is empty for a window with no release, and sorts the lines by payout day then order number', async () => {
    expect((await setup([]).finance.income(SECRET, WINDOW)).lines).toEqual([]);
    const { finance } = setup([plain('B2', { releaseMs: RELEASE + DAY }), plain('C3'), plain('A1', { releaseMs: RELEASE + DAY })]);
    expect((await finance.income(SECRET, WINDOW)).lines.map((l) => `${l.paidAt}:${l.orderNo}`)).toEqual(['2026-11-15:C3', '2026-11-16:A1', '2026-11-16:B2']);
  });

  it('gives the payouts alone, without the detail calls', async () => {
    const { finance, fake } = setup([plain('A1'), plain('B2')]);
    expect((await finance.payouts(SECRET, WINDOW)).map((p) => p.orderNo)).toEqual(['A1', 'B2']);
    expect(fake.calls.filter((c) => c.path === '/api/v2/payment/get_escrow_detail')).toHaveLength(0);
  });
});

describe('a page that is not what the platform sends', () => {
  const refused = (escrows: FakeShopeeEscrow[], intercept?: Parameters<typeof setup>[1]) => kindOf(() => setup(escrows, intercept).finance.income(SECRET, WINDOW));
  const onDetail = (body: string) => (path: string): Response | undefined => (path === '/api/v2/payment/get_escrow_detail' ? new Response(body) : undefined);
  const onList = (body: string) => (path: string): Response | undefined => (path === '/api/v2/payment/get_escrow_list' ? new Response(body) : undefined);

  it('refuses an exponent, more than four decimals and a payout that is not a plain decimal', async () => {
    expect(await refused([plain('A1', {}, { commission_fee: '1E3' })])).toBe('not_recognized');
    expect(await refused([plain('A1', {}, { commission_fee: '1.23456' })])).toBe('not_recognized');
    expect(await refused([plain('A1', { payout: '1e5' })])).toBe('not_recognized');
    expect(await refused([plain('A1', { payout: '12345678901234567' })])).toBe('not_recognized');
  });

  it('refuses a list row released outside the window asked for', async () => {
    const wide = (path: string): Response | undefined => (path === '/api/v2/payment/get_escrow_list' ? new Response('{"error":"","message":"","response":{"more":false,"escrow_list":[{"order_sn":"A1","payout_amount":1.0,"escrow_release_time":1700000000}]}}') : undefined);
    expect(await refused([], wide)).toBe('not_recognized');
  });

  it('refuses a currency that is not dong and an exchange rate that is not one', async () => {
    expect(await refused([plain('A1', { extraIncome: ['"pri_currency":"USD"'] })])).toBe('not_recognized');
    expect(await refused([plain('A1', { extraIncome: ['"aff_currency":"SGD"'] })])).toBe('not_recognized');
    expect(await refused([plain('A1', {}, { exchange_rate: '2.0' })])).toBe('not_recognized');
    // A rate of one and dong are fine.
    const ok = setup([plain('A1', { extraIncome: ['"pri_currency":"VND"'] }, { exchange_rate: '1.0' })]);
    expect((await ok.finance.income(SECRET, WINDOW)).lines).toHaveLength(1);
  });

  it('refuses a detail that is another order, has no income or is not an object', async () => {
    expect(await refused([plain('A1')], onDetail('{"error":"","message":"","response":{"order_sn":"ZZZ","order_income":{"escrow_amount":1.0}}}'))).toBe('not_recognized');
    expect(await refused([plain('A1')], onDetail('{"error":"","message":"","response":{"order_sn":"A1"}}'))).toBe('not_recognized');
    expect(await refused([plain('A1')], onDetail('{"error":"","message":"","response":{"order_sn":"A1","order_income":[1]}}'))).toBe('not_recognized');
  });

  it('refuses a list with a bad time, a bad order number, an order twice, or a missing list that says more', async () => {
    expect(await refused([], onList('{"error":"","message":"","response":{"more":false,"escrow_list":[{"order_sn":"A1","payout_amount":1.0,"escrow_release_time":12}]}}'))).toBe('not_recognized');
    expect(await refused([], onList('{"error":"","message":"","response":{"more":false,"escrow_list":[{"order_sn":"A*1","payout_amount":1.0,"escrow_release_time":1763000000}]}}'))).toBe('not_recognized');
    expect(await refused([], onList('{"error":"","message":"","response":{"more":false,"escrow_list":[{"order_sn":"A1","payout_amount":1.0,"escrow_release_time":1763000000},{"order_sn":"A1","payout_amount":1.0,"escrow_release_time":1763000000}]}}'))).toBe('not_recognized');
    expect(await refused([], onList('{"error":"","message":"","response":{"more":true}}'))).toBe('not_recognized');
    expect(await refused([], onList('{"error":"","message":"","response":{"more":"no","escrow_list":[]}}'))).toBe('not_recognized');
    expect(await refused([], onList('{"error":"","message":"","response":{"more":false,"escrow_list":{}}}'))).toBe('not_recognized');
  });

  it('refuses, never cuts, a window of more orders than one read may take', async () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => plain(`O${String(i).padStart(4, '0')}`, { releaseMs: RELEASE + i * 1000 }));
    // 100 orders are read (two list calls would be needed past 100 per page; one page of 100 with no more).
    const exact = setup(many(100));
    expect((await exact.finance.income(SECRET, WINDOW)).lines).toHaveLength(100);
    expect(exact.fake.calls.filter((c) => c.path === '/api/v2/payment/get_escrow_detail')).toHaveLength(100);
    // 101 need a second page and are over the limit; 250 need three pages.
    // Refused as its own kind, so a caller can split the window (marketplace-income-leg.ts).
    expect(await refused(many(101))).toBe('too_large');
    expect(await refused(many(250))).toBe('too_large');
  });

  it('refuses a window that is not days, is backwards or is longer than 15 days, with no call made', async () => {
    const { finance, fake } = setup([plain()]);
    for (const window of [{ startDay: '2026-11-20', endDay: '2026-11-10' }, { startDay: '2026-11-01', endDay: '2026-11-16' }, { startDay: '2026-13-01', endDay: '2026-13-02' }, { startDay: 'x', endDay: 'y' }]) {
      expect(await kindOf(() => finance.income(SECRET, window)), JSON.stringify(window)).toBe('RangeError');
    }
    expect(fake.calls).toHaveLength(0);
    // 15 days inclusive (14 days apart) is allowed.
    expect((await finance.income(SECRET, { startDay: '2026-11-07', endDay: '2026-11-21' })).lines).toHaveLength(1);
  });

  it('maps Shopee\'s own refusals to the port\'s kinds', async () => {
    expect(await refused([plain()], () => new Response(JSON.stringify({ error: 'error_auth', message: 'x' })))).toBe('credentials');
    expect(await refused([plain()], () => new Response('', { status: 429 }))).toBe('rate_limited');
    expect(await refused([plain()], () => new Response('down', { status: 503 }))).toBe('unreachable');
    expect(await kindOf(() => setup([plain()]).finance.income('not json', WINDOW))).toBe('credentials');
  });
});

describe('what the reader is', () => {
  it('is GET only, with one request site: it never changes anything at Shopee', () => {
    const source = readFileSync(new URL('../src/marketplace-shopee-finance.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/method:\s*'POST'/);
    expect(source.match(/method:\s*'GET'/g)).toHaveLength(1);
    expect(source).not.toMatch(/fetch\(/);
  });
});

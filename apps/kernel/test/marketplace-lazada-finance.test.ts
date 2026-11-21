// SPDX-License-Identifier: AGPL-3.0-only
// The Lazada finance reader (#2524, S5a = #4242) against a made-up Lazada (fake-lazada.ts): payout amounts with a currency suffix (only the market's is accepted), transaction lines folded into the
// income path's lines with the identity net = sales - commission - payment fee - refund + other, an unknown fee id or status refusing the page, pending lines left out, the window and paging limits, free
// text dropped at the edge, and a source scan that keeps the reader to two GET paths. No call to Lazada: the fetch is the fake.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Decimal } from '@crove/l10n-vn';
import { MarketplaceProviderError } from '@crove/mod-finance';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { LAZADA_FEE_BUCKET, LAZADA_FEE_TYPES } from '../src/marketplace-lazada-fees.ts';
import { LAZADA_FINANCE_MAX_DAYS, LAZADA_FINANCE_PAGE, lazadaFinance } from '../src/marketplace-lazada-finance.ts';
import { LAZADA_HOSTS, lazadaCaller, lazadaMarketplace } from '../src/marketplace-lazada.ts';
import { fakeLazada, fakeOrder, type FakeStatement, type FakeTransaction } from './fake-lazada.ts';

const KEY = { appKey: '123456', appSecret: 'helloworld', accessToken: '50000000001abcDEF' };
const SECRET = JSON.stringify(KEY);
const NOW = Date.parse('2026-11-10T03:00:00Z');
const WINDOW = { startDay: '2026-11-01', endDay: '2026-11-07' };

const statement = (over: Partial<FakeStatement> = {}): FakeStatement => ({ number: 'VN-0001', payout: '850000 VND', ...over });
const line = (over: Partial<FakeTransaction> & { feeType: number | string; amount: string }): FakeTransaction => ({ orderNo: '8000001', date: '5 Nov 2026', paidStatus: 'Paid', ...over });

function setup(over: { statements?: FakeStatement[]; transactions?: FakeTransaction[]; intercept?: Parameters<typeof fakeLazada>[0]['intercept'] } = {}) {
  const fake = fakeLazada({ ...KEY, orders: [], statements: over.statements ?? [statement()], transactions: over.transactions ?? [], ...(over.intercept ? { intercept: over.intercept } : {}) });
  const waits: number[] = [];
  const finance = lazadaFinance({ fetch: hostBoundFetch(LAZADA_HOSTS, fake.fetch), now: () => new Date(NOW), sleep: async (ms) => void waits.push(ms) });
  return { finance, fake, waits };
}

const kind = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'no error';
  } catch (error) {
    return error instanceof MarketplaceProviderError ? error.kind : `other: ${String(error)}`;
  }
};

// One order paid in full: the price credit, the commission, the payment fee and a shipping fee that has no bucket of its own.
const ORDER_LINES: FakeTransaction[] = [
  line({ feeType: 13, amount: '1000000' }),
  line({ feeType: 16, amount: '-100000.50' }),
  line({ feeType: 3, amount: '-20000' }),
  line({ feeType: 7, amount: '-30000' }),
];

describe('the income of an order', () => {
  it('folds the paid lines into the income path\'s line, `other` holds what no named bucket explains, and the identity holds exactly', async () => {
    const { finance } = setup({ transactions: ORDER_LINES });
    const income = await finance.income(SECRET, WINDOW);
    expect(income.currency).toBe('VND');
    expect(income.pendingLines).toBe(0);
    expect(income.lines).toHaveLength(1);
    const l = income.lines[0]!;
    expect(l).toMatchObject({ orderNo: '8000001', paidAt: '2026-11-05', sales: '1000000', commission: '100000.5', paymentFee: '20000', refund: '0', sellerDiscount: '0', serviceFee: '0', shipping: '0', taxWithheld: '0', net: '849999.5', other: '-30000' });
    expect(l.otherByFee).toEqual([{ feeType: 7, amount: '-30000', known: true }]);
    const identity = new Decimal(l.sales).minus(l.commission).minus(l.paymentFee).minus(l.refund).plus(l.other);
    expect(identity.toFixed()).toBe(l.net);
  });

  it('puts a reversal in `refund`, keeps a credit of the other sign in `other`, and never hides a bucket that came out the wrong way round', async () => {
    const { finance } = setup({
      transactions: [
        line({ feeType: 13, amount: '500000' }),
        line({ feeType: 14, amount: '-200000' }),
        // A payment fee credit (id 4) is a credit: it goes to `other`, it is not a negative payment fee.
        line({ feeType: 4, amount: '1000' }),
        // A price credit that nets to a loss (a reversal booked under the credit id) is not a sale of a negative amount.
        line({ orderNo: '8000002', feeType: 13, amount: '-5000' }),
      ],
    });
    const { lines } = await finance.income(SECRET, WINDOW);
    expect(lines.map((x) => x.orderNo)).toEqual(['8000001', '8000002']);
    expect(lines[0]).toMatchObject({ sales: '500000', refund: '200000', paymentFee: '0', other: '1000', net: '301000' });
    expect(lines[1]).toMatchObject({ sales: '0', other: '-5000', net: '-5000' });
    for (const l of lines) expect(new Decimal(l.sales).minus(l.commission).minus(l.paymentFee).minus(l.refund).plus(l.other).toFixed()).toBe(l.net);
  });

  it('writes one line per order and day, sorted by day then order, and takes a fee id written as text', async () => {
    const { finance } = setup({
      transactions: [
        line({ orderNo: '8000002', feeType: '13', amount: '2000', date: '6 Nov 2026' }),
        line({ orderNo: '8000002', feeType: 13, amount: '3000', date: '5 Nov 2026' }),
        line({ orderNo: '8000001', feeType: 13, amount: '1000', date: '06 Nov 2026' }),
      ],
    });
    const { lines } = await finance.income(SECRET, WINDOW);
    expect(lines.map((x) => `${x.paidAt} ${x.orderNo} ${x.sales}`)).toEqual(['2026-11-05 8000002 3000', '2026-11-06 8000001 1000', '2026-11-06 8000002 2000']);
  });

  it('keeps an order number past 2^53 as digits', async () => {
    const { finance } = setup({ transactions: [line({ orderNo: '9007199254740993123', feeType: 13, amount: '1000' })] });
    expect((await finance.income(SECRET, WINDOW)).lines[0]!.orderNo).toBe('9007199254740993123');
  });

  it('leaves a line that is not paid yet out of the income and only counts it', async () => {
    const { finance } = setup({ transactions: [...ORDER_LINES, line({ orderNo: '8000009', feeType: 13, amount: '777000', paidStatus: 'Not paid' }), line({ orderNo: '8000009', feeType: 16, amount: '-7000', paidStatus: 'not  PAID' })] });
    const income = await finance.income(SECRET, WINDOW);
    expect(income.lines.map((x) => x.orderNo)).toEqual(['8000001']);
    expect(income.pendingLines).toBe(2);
  });

  it('carries VAT and withholding fields as numbers of their own, not as tax withheld', async () => {
    const { finance } = setup({ transactions: [line({ feeType: 13, amount: '1000', vat: '10', wht: '5' }), line({ feeType: 16, amount: '-100', vat: '1.5' })] });
    const l = (await finance.income(SECRET, WINDOW)).lines[0]!;
    expect(l).toMatchObject({ vatInAmount: '11.5', whtAmount: '5', taxWithheld: '0' });
  });
});

describe('a fee id the official table does not hold', () => {
  it('is staged in `other` with its sign from the answer and flagged for a person, and the page is not refused', async () => {
    expect(LAZADA_FEE_TYPES.has(999999)).toBe(false);
    const { finance } = setup({ transactions: [...ORDER_LINES, line({ feeType: 999999, amount: '-1234.5' }), line({ orderNo: '8000002', feeType: 888888, amount: '700' })] });
    const { lines } = await finance.income(SECRET, WINDOW);
    expect(lines).toHaveLength(2);
    const [a, b] = lines as [(typeof lines)[number], (typeof lines)[number]];
    expect(a.unknownFeeType).toBe(true);
    expect(a.otherByFee).toEqual([
      { feeType: 7, amount: '-30000', known: true },
      { feeType: 999999, amount: '-1234.5', known: false },
    ]);
    expect(a.other).toBe('-31234.5');
    expect(b).toMatchObject({ orderNo: '8000002', unknownFeeType: true, other: '700', net: '700', sales: '0' });
    for (const l of lines) expect(new Decimal(l.sales).minus(l.commission).minus(l.paymentFee).minus(l.refund).plus(l.other).toFixed()).toBe(l.net);
  });

  it('does not flag a line whose ids are all in the table', async () => {
    const { finance } = setup({ transactions: ORDER_LINES });
    expect((await finance.income(SECRET, WINDOW)).lines[0]!.unknownFeeType).toBe(false);
  });
});

describe('what refuses the page', () => {
  const refused = async (transactions: FakeTransaction[], extra: Partial<Parameters<typeof setup>[0]> = {}) => kind(() => setup({ transactions, ...extra }).finance.income(SECRET, WINDOW));

  it('a fee id that is not a whole number from 1 to 999999, however it is written', async () => {
    for (const feeType of ['Commission', -1, 0, 1.5, 1_000_000, '0', '1000000', '1e3', '', '1 3']) expect(await refused([line({ feeType, amount: '1000' })])).toBe('not_recognized');
  });

  it('a paid status that is neither paid nor not paid', async () => {
    expect(await refused([line({ feeType: 13, amount: '1000', paidStatus: 'Settled' })])).toBe('not_recognized');
    expect(await refused([line({ feeType: 13, amount: '1000', paidStatus: '' })])).toBe('not_recognized');
  });

  it('an amount that is not a plain decimal string', async () => {
    for (const amount of ['1e3', '1,000', '1000 VND', '$5', '', '1.23456', '--5']) expect(await refused([line({ feeType: 13, amount })])).toBe('not_recognized');
    expect(await refused([line({ feeType: 13, amount: '1000', extra: { amount: 1000 } })])).toBe('not_recognized');
  });

  it('a date that is not "17 May 2016", an order number that is not digits, a VAT field that is not an amount', async () => {
    for (const date of ['2026-11-05', '31 Feb 2026', '5 Nov', '5 Foo 2026', '5 Novice 2026', '5 November 2026', '']) expect(await refused([line({ feeType: 13, amount: '1000', date })])).toBe('not_recognized');
    for (const orderNo of ['AB1', '12 34', '12,34']) expect(await refused([line({ orderNo, feeType: 13, amount: '1000' })])).toBe('not_recognized');
    expect(await refused([line({ feeType: 13, amount: '1000', vat: '10%' })])).toBe('not_recognized');
  });

  it('one bad line refuses the whole page: nothing partial is returned', async () => {
    expect(await refused([...ORDER_LINES, line({ feeType: 13, amount: '1.23456' })])).toBe('not_recognized');
  });

  it('paid lines with no statement to settle the currency; pending lines alone are only counted', async () => {
    expect(await refused(ORDER_LINES, { statements: [] })).toBe('not_recognized');
    const { finance } = setup({ statements: [], transactions: [line({ feeType: 13, amount: '1000', paidStatus: 'Not paid' })] });
    expect(await finance.income(SECRET, WINDOW)).toMatchObject({ lines: [], pendingLines: 1, statements: [] });
  });
});

describe('the payout statements and their currency', () => {
  it('keeps the number and the payout without the suffix, and accepts the market\'s currency or none', async () => {
    const { finance } = setup({ statements: [statement(), statement({ number: 'VN-0002', payout: '1250000.25' })] });
    expect(await finance.statements(SECRET, '2026-11-01')).toEqual([
      { number: 'VN-0001', payout: '850000' },
      { number: 'VN-0002', payout: '1250000.25' },
    ]);
  });

  it('refuses a payout in another currency, however the suffix is written, without returning the number', async () => {
    for (const payout of ['3962.41 EUR', '850000 vnd', '850000 VND ', '850,000 VND', '850000VND', '850000 VNDX', '1e5 VND', 'free', '']) {
      const { finance } = setup({ statements: [statement({ payout })] });
      expect(await kind(() => finance.statements(SECRET, '2026-11-01'))).toBe(payout === '850000 VND ' ? 'no error' : 'not_recognized');
    }
  });

  it('refuses a page when ANY money field of a statement names another currency, or the payout is not a string', async () => {
    expect(await kind(() => setup({ statements: [statement({ extra: { fees_total: '-100.00 THB' } })] }).finance.statements(SECRET, '2026-11-01'))).toBe('not_recognized');
    expect(await kind(() => setup({ statements: [statement({ extra: { payout: 850000 } })] }).finance.statements(SECRET, '2026-11-01'))).toBe('not_recognized');
  });

  it('refuses a repeated statement number and one that is not a plain code', async () => {
    expect(await kind(() => setup({ statements: [statement(), statement()] }).finance.statements(SECRET, '2026-11-01'))).toBe('not_recognized');
    expect(await kind(() => setup({ statements: [statement({ number: 'VN 1; drop' })] }).finance.statements(SECRET, '2026-11-01'))).toBe('not_recognized');
  });

  it('a statement in another currency refuses the income page too, so no line is taken without its currency settled', async () => {
    const { finance } = setup({ statements: [statement({ payout: '10 EUR' })], transactions: ORDER_LINES });
    expect(await kind(() => finance.income(SECRET, WINDOW))).toBe('not_recognized');
  });
});

describe('the window and the pages', () => {
  it('refuses a window that is reversed, too long or not a day before any call is made', async () => {
    const { finance, fake } = setup({ transactions: ORDER_LINES });
    for (const w of [
      { startDay: '2026-11-07', endDay: '2026-11-01' },
      { startDay: '2026-10-01', endDay: '2026-11-01' },
      { startDay: '2026-11-01', endDay: '2026-11-32' },
      { startDay: 'last week', endDay: '2026-11-01' },
    ]) {
      expect(await kind(() => finance.income(SECRET, w))).toMatch(/^other: RangeError/);
    }
    expect(await kind(() => finance.statements(SECRET, 'yesterday'))).toMatch(/^other: RangeError/);
    expect(fake.calls).toHaveLength(0);
  });

  it(`accepts a window of ${LAZADA_FINANCE_MAX_DAYS} days (the day before the limit) and sends the days as written`, async () => {
    const { finance, fake } = setup({ transactions: ORDER_LINES });
    await finance.income(SECRET, { startDay: '2026-10-08', endDay: '2026-11-07' });
    const sent = fake.calls.filter((c) => c.path === '/finance/transaction/details/get');
    expect(sent[0]!.params).toMatchObject({ start_time: '2026-10-08', end_time: '2026-11-07', limit: '500', offset: '0' });
  });

  it('reads page after page until a short one, and stops at once after a page of exactly the limit that is followed by none', async () => {
    const many = Array.from({ length: LAZADA_FINANCE_PAGE * 2 + 3 }, (_, i) => line({ orderNo: String(8100000 + i), feeType: 13, amount: '1' }));
    const a = setup({ transactions: many });
    expect((await a.finance.income(SECRET, WINDOW)).lines).toHaveLength(many.length);
    expect(a.fake.calls.filter((c) => c.path === '/finance/transaction/details/get').map((c) => c.params.offset)).toEqual(['0', '500', '1000']);

    const exact = Array.from({ length: LAZADA_FINANCE_PAGE }, (_, i) => line({ orderNo: String(8200000 + i), feeType: 13, amount: '1' }));
    const b = setup({ transactions: exact });
    expect((await b.finance.income(SECRET, WINDOW)).lines).toHaveLength(LAZADA_FINANCE_PAGE);
    expect(b.fake.calls.filter((c) => c.path === '/finance/transaction/details/get').map((c) => c.params.offset)).toEqual(['0', '500']);
  });

  it('refuses a window with more lines than ten pages instead of cutting it', async () => {
    const huge = Array.from({ length: LAZADA_FINANCE_PAGE * 10 + 1 }, (_, i) => line({ orderNo: String(8300000 + i), feeType: 13, amount: '1' }));
    const { finance, fake } = setup({ transactions: huge });
    expect(await kind(() => finance.income(SECRET, WINDOW))).toBe('not_recognized');
    expect(fake.calls.filter((c) => c.path === '/finance/transaction/details/get')).toHaveLength(10);
  });

  it('spaces its calls: every call after the first waits its turn', async () => {
    const { finance, fake, waits } = setup({ transactions: ORDER_LINES });
    await finance.income(SECRET, WINDOW);
    expect(fake.calls).toHaveLength(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it('shares one turn-taking with the orders adapter when both are given the same caller: an orders call and a finance call of one app are spaced', async () => {
    const fake = fakeLazada({ ...KEY, orders: [fakeOrder({ id: '5000001', number: '5000001' })], statements: [statement()], transactions: ORDER_LINES });
    const waits: number[] = [];
    const options = { fetch: hostBoundFetch(LAZADA_HOSTS, fake.fetch), now: () => new Date(NOW), sleep: async (ms: number) => void waits.push(ms) };
    const caller = lazadaCaller(options);
    const orders = lazadaMarketplace(options, caller);
    const finance = lazadaFinance(options, caller);
    await Promise.all([orders.listOrders(SECRET, 'lazada', null), finance.statements(SECRET, '2026-11-01')]);
    expect(fake.calls.length).toBeGreaterThanOrEqual(2);
    // The first call goes at once; each later one waited, even though the two adapters were asked at the same moment.
    expect(waits).toHaveLength(fake.calls.length - 1);
  });
});

describe('what the answer carries and what the reader keeps', () => {
  it('drops free text, SKUs, a provider name and a buyer\'s details at the edge', async () => {
    const { finance } = setup({ statements: [statement({ extra: { account_holder: 'VN-0001-secret' } })], transactions: ORDER_LINES });
    const text = JSON.stringify(await finance.income(SECRET, WINDOW));
    for (const planted of ['Nguyễn', '0912345678', 'giao giờ', 'ref-planted', 'Giao hàng thử', 'Item Price Credit', 'VN-0001-secret']) expect(text).not.toContain(planted);
  });

  it('turns a failure of the port into its kind and never repeats Lazada\'s text', async () => {
    const answer = (code: string) => (path: string) => (path.startsWith('/finance/') ? new Response(JSON.stringify({ code, message: 'sk-live-planted-sentence', request_id: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } }) : undefined);
    expect(await kind(() => setup({ intercept: answer('IllegalAccessToken') }).finance.income(SECRET, WINDOW))).toBe('credentials');
    expect(await kind(() => setup({ intercept: answer('ApiCallLimit') }).finance.income(SECRET, WINDOW))).toBe('rate_limited');
    expect(await kind(() => setup({ intercept: answer('1000012') }).finance.income(SECRET, WINDOW))).toBe('unreachable');
    try {
      await setup({ intercept: answer('1000012') }).finance.income(SECRET, WINDOW);
    } catch (error) {
      expect(String(error)).not.toContain('sk-live-planted-sentence');
    }
  });

  it('refuses an answer whose data is not a list', async () => {
    const odd = (data: unknown) => (path: string) => (path.startsWith('/finance/') ? new Response(JSON.stringify({ code: '0', data }), { status: 200, headers: { 'content-type': 'application/json' } }) : undefined);
    for (const data of [{ rows: [] }, 'none', 7, null]) expect(await kind(() => setup({ intercept: odd(data) }).finance.income(SECRET, WINDOW))).toBe('not_recognized');
  });

  it('refuses a statement page of more than 200 and a transaction page longer than asked', async () => {
    const many = Array.from({ length: 201 }, (_, i) => statement({ number: `VN-${String(i).padStart(4, '0')}` }));
    expect(await kind(() => setup({ statements: many }).finance.statements(SECRET, '2026-11-01'))).toBe('not_recognized');
    const longer = (path: string) => (path === '/finance/transaction/details/get' ? new Response(JSON.stringify({ code: '0', data: Array.from({ length: LAZADA_FINANCE_PAGE + 1 }, () => ({})) }), { status: 200 }) : undefined);
    expect(await kind(() => setup({ intercept: longer }).finance.income(SECRET, WINDOW))).toBe('not_recognized');
  });

  it('sends the statements call with the day the window starts and nothing but the signed parameters', async () => {
    const { finance, fake } = setup({ transactions: ORDER_LINES });
    await finance.income(SECRET, WINDOW);
    const first = fake.calls[0]!;
    expect(first).toMatchObject({ method: 'GET', host: 'api.lazada.vn', path: '/finance/payout/status/get' });
    expect(Object.keys(first.params).sort()).toEqual(['access_token', 'app_key', 'created_after', 'sign', 'sign_method', 'timestamp']);
    expect(first.params.created_after).toBe('2026-11-01');
    expect(new Set(fake.calls.map((c) => c.method))).toEqual(new Set(['GET']));
  });
});

describe('the fee table', () => {
  it('holds the 316 official rows, and every bucket names a row with the official name', () => {
    expect(LAZADA_FEE_TYPES.size).toBe(316);
    const names = { 13: 'Item Price Credit', 14: 'Reversal Item Price', 505: 'Reversal Item Price', 16: 'Commission', 3: 'Payment Fee' } as const;
    expect([...LAZADA_FEE_BUCKET.keys()].sort((a, b) => a - b)).toEqual([3, 13, 14, 16, 505]);
    for (const [id, name] of Object.entries(names)) expect(LAZADA_FEE_TYPES.get(Number(id))?.name).toBe(name);
  });
});

describe('the source', () => {
  const source = readFileSync(new URL('../src/marketplace-lazada-finance.ts', import.meta.url), 'utf8');
  const code = source.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

  it('calls only the two read paths, builds no request of its own and uses no verb but the caller\'s GET', () => {
    expect([...code.matchAll(/'(\/[a-z/]+)'/g)].map((m) => m[1]).sort()).toEqual(['/finance/payout/status/get', '/finance/transaction/details/get']);
    expect(code).not.toMatch(/\bfetch\b/);
    expect(code).not.toMatch(/\b(POST|PUT|PATCH|DELETE)\b/);
    expect(code).not.toMatch(/https?:/);
  });

  it('does money through decimal.js and never a JS number', () => {
    expect(code).toContain("from '@crove/l10n-vn'");
    expect(code).not.toMatch(/parseFloat/);
  });
});

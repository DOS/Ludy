// SPDX-License-Identifier: AGPL-3.0-only
// The Shopee returns reader (#2524, S2 = #4282) through the orders poll, against a made-up Shopee. What is pinned is THE STOCK RULE: a line is `returned` (stock back) only when the return is a return and refund in an
// accepted status, validated by the seller, whose reverse logistics status is LOGISTICS_DELIVERY_DONE and which names the whole line; LOGISTICS_LOST never brings stock back; a refund only, a warehouse validation, a
// partial quantity and every open or contested status move nothing; and a page that holds a word the tables do not know is refused with nothing stored. No buyer field is read or kept.
import { describe, expect, it } from 'vitest';
import { MarketplaceProviderError, parseMarketplaceOrderPage } from '@ludy/mod-finance';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { SHOPEE_HOSTS, shopeeCaller } from '../src/marketplace-shopee.ts';
import { shopeeMarketplace } from '../src/marketplace-shopee-orders.ts';
import { SHOPEE_MAX_RETURN_DETAILS, SHOPEE_RETURN_STATUS } from '../src/marketplace-shopee-returns.ts';
import { fakeShopee, fakeShopeeOrder, type FakeShopeeItem, type FakeShopeeOrderSpec, type FakeShopeeRaw, type FakeShopeeReturn } from './fake-shopee.ts';

const NOW = Date.parse('2026-11-21T08:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const CRED = { partnerId: '1000012', partnerKey: 'test-only-partner-key', shopId: '77777', accessToken: 'SHP_access' };
const SECRET = JSON.stringify(CRED);

const item = (over: Partial<FakeShopeeItem> = {}): FakeShopeeItem => ({ itemId: 2600144043, modelId: 5074620257, name: 'Áo thun mẫu', modelName: 'Đen, L', itemSku: 'AT-MAU', modelSku: 'AT-MAU-DL', quantity: 2, original: '150000', discounted: '120000', ...over });
const itemB = (over: Partial<FakeShopeeItem> = {}): FakeShopeeItem => item({ itemId: 2600144044, modelId: 5074620258, name: 'Mũ mẫu', modelName: '', modelSku: 'MU-MAU', quantity: 1, original: '90000', discounted: '90000', ...over });
const order = (sn: string, over: Partial<FakeShopeeOrderSpec> = {}): FakeShopeeRaw =>
  fakeShopeeOrder({ sn, status: 'COMPLETED', createdMs: NOW - 5 * DAY, updatedMs: NOW - 2 * HOUR, pickupDoneMs: NOW - 4 * DAY, items: [item(), itemB()], ...over });
const ret = (sn: string, orderSn: string, over: Partial<FakeShopeeReturn> = {}): FakeShopeeReturn => ({
  returnSn: sn,
  orderSn,
  status: 'CLOSED',
  updatedMs: NOW - HOUR,
  solution: 0,
  items: [{ itemId: 2600144043, modelId: 5074620257, amount: 2 }],
  reverseStatus: 'LOGISTICS_DELIVERY_DONE',
  validation: 'seller_validation',
  ...over,
});

function setup(raws: FakeShopeeRaw[], returns: FakeShopeeReturn[], intercept?: (path: string, query: Record<string, string>) => Response | undefined) {
  const fake = fakeShopee({ ...CRED, raws, returns, now: () => NOW, ...(intercept ? { intercept } : {}) });
  const options = { fetch: hostBoundFetch(SHOPEE_HOSTS, fake.fetch), now: () => new Date(NOW), spacingMs: 0 };
  return { fake, provider: shopeeMarketplace(options, shopeeCaller(options)) };
}
const poll = (raws: FakeShopeeRaw[], returns: FakeShopeeReturn[], intercept?: Parameters<typeof setup>[2]) => {
  const s = setup(raws, returns, intercept);
  return s.provider.listOrders(SECRET, 'shopee', null).then((page) => ({ page, fake: s.fake }));
};
const kindOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'no error';
  } catch (error) {
    return error instanceof MarketplaceProviderError ? error.kind : `other: ${String(error)}`;
  }
};
const stagesOf = (page: { orders: ReadonlyArray<{ orderNo: string; stage: string; lines: ReadonlyArray<{ sku: string | null }> }> }, sn: string) => page.orders.filter((o) => o.orderNo === sn).map((o) => `${o.stage}:${o.lines.map((l) => l.sku).join('+')}`);
const detailCalls = (fake: ReturnType<typeof fakeShopee>) => fake.calls.filter((c) => c.path === '/api/v2/returns/get_return_detail');

describe('the stock rule for returns', () => {
  it('brings back the lines of a return and refund the seller has: the returned lines first, the rest in the order\'s own stage', async () => {
    const { page } = await poll([order('A1')], [ret('R1', 'A1')]);
    expect(stagesOf(page, 'A1')).toEqual(['returned:AT-MAU-DL', 'completed:MU-MAU']);
    const [back, rest] = page.orders;
    expect(back).toMatchObject({ stage: 'returned', shippedAt: '2026-11-17', deliveredAt: '2026-11-21', lines: [{ lineKey: '2600144043-5074620257', quantity: '2', amount: '240000' }] });
    expect(rest).toMatchObject({ stage: 'completed', lines: [{ lineKey: '2600144044-5074620258' }] });
    expect(parseMarketplaceOrderPage(page)).not.toBeNull();
  });

  it('counts an accepted or processing return as well as a closed one, and none of the open or contested ones, whose detail is never even asked for', async () => {
    for (const status of ['ACCEPTED', 'PROCESSING', 'CLOSED']) {
      expect(stagesOf((await poll([order('A1')], [ret('R1', 'A1', { status })])).page, 'A1'), status).toEqual(['returned:AT-MAU-DL', 'completed:MU-MAU']);
    }
    for (const status of ['REQUESTED', 'CANCELLED', 'JUDGING', 'SELLER_DISPUTE']) {
      const { page, fake } = await poll([order('A1')], [ret('R1', 'A1', { status })]);
      expect(stagesOf(page, 'A1'), status).toEqual(['completed:AT-MAU-DL+MU-MAU']);
      expect(detailCalls(fake), status).toHaveLength(0);
    }
    expect(Object.keys(SHOPEE_RETURN_STATUS).sort()).toEqual(['ACCEPTED', 'CANCELLED', 'CLOSED', 'JUDGING', 'PROCESSING', 'REQUESTED', 'SELLER_DISPUTE']);
  });

  it('NEVER brings stock back for a return the carrier lost, and not for any reverse status short of delivery to the seller', async () => {
    for (const reverseStatus of ['LOGISTICS_LOST', 'LOGISTICS_PICKUP_DONE', 'LOGISTICS_PICKUP_FAILED', 'LOGISTICS_PICKUP_RETRY', 'LOGISTICS_DELIVERY_FAILED', 'LOGISTICS_REQUEST_CREATED', 'LOGISTICS_PENDING_ARRANGE', 'LOGISTICS_READY']) {
      const { page } = await poll([order('A1')], [ret('R1', 'A1', { reverseStatus })]);
      expect(stagesOf(page, 'A1'), reverseStatus).toEqual(['completed:AT-MAU-DL+MU-MAU']);
    }
  });

  it('does not bring back a return validated in Shopee\'s warehouse, nor a refund that sends nothing back (which asks for no detail at all)', async () => {
    expect(stagesOf((await poll([order('A1')], [ret('R1', 'A1', { validation: 'warehouse_validation' })])).page, 'A1')).toEqual(['completed:AT-MAU-DL+MU-MAU']);
    const refundOnly = await poll([order('A1')], [ret('R1', 'A1', { solution: 1 })]);
    expect(stagesOf(refundOnly.page, 'A1')).toEqual(['completed:AT-MAU-DL+MU-MAU']);
    expect(detailCalls(refundOnly.fake)).toHaveLength(0);
  });

  it('leaves a line alone when the return names fewer units than the line holds, and brings back a line of one unit', async () => {
    expect(stagesOf((await poll([order('A1')], [ret('R1', 'A1', { items: [{ itemId: 2600144043, modelId: 5074620257, amount: 1 }] })])).page, 'A1')).toEqual(['completed:AT-MAU-DL+MU-MAU']);
    expect(stagesOf((await poll([order('A1')], [ret('R1', 'A1', { items: [{ itemId: 2600144044, modelId: 5074620258, amount: 1 }] })])).page, 'A1')).toEqual(['returned:MU-MAU', 'completed:AT-MAU-DL']);
  });

  it('puts every line of an order whose lines came back in one returned order, whether by one return or by two', async () => {
    const both = [
      ret('R1', 'A1'),
      ret('R2', 'A1', { items: [{ itemId: 2600144044, modelId: 5074620258, amount: 1 }] }),
    ];
    const { page } = await poll([order('A1')], both);
    expect(stagesOf(page, 'A1')).toEqual(['returned:AT-MAU-DL+MU-MAU']);
  });

  it('reads the order of a return by number when the order is not among those changed in the window', async () => {
    // The order was last updated 16 days ago (outside the 15 day window the first poll reads); the return is recent.
    const old = order('A1', { createdMs: NOW - 18 * DAY, updatedMs: NOW - 16 * DAY });
    const { page, fake } = await poll([old], [ret('R1', 'A1', { updatedMs: NOW - HOUR })]);
    expect(stagesOf(page, 'A1')).toEqual(['returned:AT-MAU-DL', 'completed:MU-MAU']);
    expect(fake.calls.some((c) => c.path === '/api/v2/order/get_order_detail' && c.query.order_sn_list === 'A1')).toBe(true);
  });

  it('judges the five conditions again on the detail: a return that is no longer accepted, or no longer a return and refund, brings nothing back', async () => {
    const drift = (extra: Record<string, unknown>) => (path: string): Response | undefined =>
      path === '/api/v2/returns/get_return_detail'
        ? new Response(JSON.stringify({ error: '', message: '', response: { return_sn: 'R1', order_sn: 'A1', status: 'CLOSED', return_solution: 0, reverse_logistics_status: 'LOGISTICS_DELIVERY_DONE', validation_type: 'seller_validation', item: [{ item_id: 2600144043, model_id: 5074620257, amount: 2 }], ...extra } }))
        : undefined;
    expect(stagesOf((await poll([order('A1')], [ret('R1', 'A1', { status: 'ACCEPTED' })], drift({}))).page, 'A1')).toEqual(['returned:AT-MAU-DL', 'completed:MU-MAU']);
    for (const extra of [{ status: 'JUDGING' }, { status: 'SELLER_DISPUTE' }, { return_solution: 1 }]) {
      expect(stagesOf((await poll([order('A1')], [ret('R1', 'A1', { status: 'ACCEPTED' })], drift(extra))).page, 'A1'), JSON.stringify(extra)).toEqual(['completed:AT-MAU-DL+MU-MAU']);
    }
  });

  it('ignores goods coming back on an order that never shipped or was cancelled, and asks no detail for it', async () => {
    const { page, fake } = await poll([order('P1', { status: 'READY_TO_SHIP', pickupDoneMs: undefined as unknown as number }), order('C1', { status: 'CANCELLED', cancelBy: 'buyer', pickupDoneMs: undefined as unknown as number })], [ret('R1', 'P1'), ret('R2', 'C1')]);
    expect(stagesOf(page, 'P1')).toEqual(['placed:AT-MAU-DL+MU-MAU']);
    expect(stagesOf(page, 'C1')).toEqual(['cancelled:AT-MAU-DL+MU-MAU']);
    expect(detailCalls(fake)).toHaveLength(0);
  });

  it('shipped order with goods back is returned too, with no delivery day', async () => {
    const { page } = await poll([order('S1', { status: 'TO_RETURN' })], [ret('R1', 'S1')]);
    expect(page.orders.find((o) => o.stage === 'returned')).toMatchObject({ shippedAt: '2026-11-17', deliveredAt: null });
  });
});

describe('line identity and paging', () => {
  it('never splits an order whose lines share a SKU (the intake numbers repeats in row order), and asks no detail for it', async () => {
    const twin = order('A1', { items: [item({ modelSku: 'SAME', quantity: 1 }), item({ itemId: 2600144045, modelId: 5074620259, modelSku: 'SAME', quantity: 2 })] });
    const { page, fake } = await poll([twin], [ret('R1', 'A1', { items: [{ itemId: 2600144045, modelId: 5074620259, amount: 2 }] })]);
    expect(stagesOf(page, 'A1')).toEqual(['completed:SAME+SAME']);
    expect(detailCalls(fake)).toHaveLength(0);
    // The intake's own base key: a SKU `A|` and a line with no SKU named `A` both become `A|`, so that order is not split either.
    const crossed = order('A1', { items: [item({ modelSku: 'A|', itemSku: '', quantity: 1, name: 'Khác', modelName: '' }), item({ itemId: 2600144045, modelId: 5074620259, modelSku: '', itemSku: '', name: 'A', modelName: '', quantity: 2 })] });
    const second = await poll([crossed], [ret('R1', 'A1', { items: [{ itemId: 2600144045, modelId: 5074620259, amount: 2 }] })]);
    expect(stagesOf(second.page, 'A1')).toEqual(['completed:A|+']);
    expect(detailCalls(second.fake)).toHaveLength(0);
    // The writer puts a `'` in front of a name that starts a formula, so a SKU `'=A|` and a line with no SKU named `=A` make the same base too.
    const formula = order('A1', { items: [item({ modelSku: "'=A|", itemSku: '', quantity: 1, name: 'Khác', modelName: '' }), item({ itemId: 2600144045, modelId: 5074620259, modelSku: '', itemSku: '', name: '=A', modelName: '', quantity: 2 })] });
    const third = await poll([formula], [ret('R1', 'A1', { items: [{ itemId: 2600144045, modelId: 5074620259, amount: 2 }] })]);
    expect(stagesOf(third.page, 'A1')).toEqual(["completed:'=A|+"]);
    expect(detailCalls(third.fake)).toHaveLength(0);
    // The same two lines under different SKUs are split as usual.
    const distinct = order('A1', { items: [item({ modelSku: 'ONE', quantity: 1 }), item({ itemId: 2600144045, modelId: 5074620259, modelSku: 'TWO', quantity: 2 })] });
    expect(stagesOf((await poll([distinct], [ret('R1', 'A1', { items: [{ itemId: 2600144045, modelId: 5074620259, amount: 2 }] })])).page, 'A1')).toEqual(['returned:TWO', 'completed:ONE']);
  });

  it('rejects a list page that says there is more and carries no list, and keeps a valid empty list', async () => {
    const onList = (body: string) => (path: string): Response | undefined => (path === '/api/v2/returns/get_return_list' ? new Response(body) : undefined);
    expect(await kindOf(() => poll([order('A1')], [], onList('{"error":"","message":"","response":{"more":true}}')))).toBe('not_recognized');
    const quiet = await poll([order('A1')], [], onList('{"error":"","message":"","response":{"more":false}}'));
    expect(stagesOf(quiet.page, 'A1')).toEqual(['completed:AT-MAU-DL+MU-MAU']);
  });

  it('does not take a window as whole when a page changed between two reads, whichever page it was', async () => {
    // 120 returns: three pages. The second read of page 2 answers a page with its first return gone (it was updated meanwhile and left the window): the rows behind it shift up.
    const rets = Array.from({ length: 120 }, (_, i) => ret(`Q${String(i).padStart(3, '0')}`, 'A1', { status: 'REQUESTED', updatedMs: NOW - HOUR - (120 - i) * 1000 }));
    for (const changedPage of ['1', '2', '3']) {
      let reads = 0;
      const fake = fakeShopee({ ...CRED, raws: [order('A1')], returns: rets, now: () => NOW });
      const options = {
        fetch: hostBoundFetch(SHOPEE_HOSTS, async (url: string, init?: RequestInit) => {
          const u = new URL(url);
          if (u.pathname === '/api/v2/returns/get_return_list' && u.searchParams.get('page_no') === changedPage) {
            reads += 1;
            if (reads === 2) {
              const real = (await (await fake.fetch(url, init)).json()) as { response: { more: boolean; return: unknown[] } };
              return new Response(JSON.stringify({ ...real, response: { ...real.response, return: real.response.return.slice(1) } }));
            }
          }
          return fake.fetch(url, init);
        }),
        now: () => new Date(NOW),
        spacingMs: 0,
      };
      const provider = shopeeMarketplace(options, shopeeCaller(options));
      const page = await provider.listOrders(SECRET, 'shopee', null);
      // The window was read twice and the reads disagreed: it was NOT taken as whole. The poll cut it to the 3 day width from the floor (an empty window there), so the cursor is twelve days back, not at the
      // end of the full window where the 120 returns are.
      expect(reads, `page ${changedPage}`).toBeGreaterThanOrEqual(2);
      expect(page.nextCursor, `page ${changedPage}`).toBe(`o:${new Date(NOW - 12 * DAY).toISOString()}`);
    }
  });

  it('takes a window of several pages whole when two reads agree', async () => {
    const rets = Array.from({ length: 120 }, (_, i) => ret(`Q${String(i).padStart(3, '0')}`, 'A1', { status: 'REQUESTED', updatedMs: NOW - 2 * HOUR - (120 - i) * 1000 }));
    const s = setup([order('A1')], rets);
    const page = await s.provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - 3 * HOUR).toISOString()}`);
    expect(page.orders.length).toBeGreaterThan(0);
    expect(s.fake.calls.filter((c) => c.path === '/api/v2/returns/get_return_list')).toHaveLength(6);
  });
});

describe('what is asked and what is kept', () => {
  it('asks for the returns of the same window as the orders, one detail call for each return that could bring goods back, and no buyer field', async () => {
    const { page, fake } = await poll([order('A1')], [ret('R1', 'A1'), ret('R2', 'A1', { status: 'REQUESTED' })]);
    const orderList = fake.calls.find((c) => c.path === '/api/v2/order/get_order_list')!;
    const returnList = fake.calls.find((c) => c.path === '/api/v2/returns/get_return_list')!;
    expect(returnList.query).toMatchObject({ page_no: '1', page_size: '50', update_time_from: orderList.query.time_from, update_time_to: orderList.query.time_to });
    expect(detailCalls(fake).map((c) => c.query.return_sn)).toEqual(['R1']);
    expect(JSON.stringify(page)).not.toMatch(/nguyenvanthu|buyer|0901234567|Nguyễn Văn|Đường Thử|portrait/);
    expect(parseMarketplaceOrderPage(page)).not.toBeNull();
  });

  it('reads the return pages whole, and cuts the window when there are more returns than it reads', async () => {
    const many = Array.from({ length: 160 }, (_, i) => ret(`RR${String(i).padStart(3, '0')}`, 'A1', { status: 'REQUESTED', updatedMs: NOW - HOUR - i * 1000 }));
    const s = setup([order('A1')], many);
    const page = await s.provider.listOrders(SECRET, 'shopee', null);
    // The 15 day window holds 160 returns (more than three pages of 50): it is cut, and the cut window is read.
    const lists = s.fake.calls.filter((c) => c.path === '/api/v2/returns/get_return_list');
    expect(lists.length).toBeGreaterThan(3);
    expect(page.nextCursor).toMatch(/^o:/);
  });

  it('refuses, rather than skips, a window whose returns need more detail calls than one page may', async () => {
    const orders = Array.from({ length: 41 }, (_, i) => order(`A${String(i).padStart(2, '0')}`, { updatedMs: NOW - 30_000 }));
    const returns = orders.map((o, i) => ret(`R${i}`, o.sn, { updatedMs: NOW - 30_000 }));
    const s = setup(orders, returns);
    expect(await kindOf(() => s.provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - 20_000).toISOString()}`))).toBe('not_recognized');
  });
});

describe('overlap and cursor advance over the detail cap (#4287)', () => {
  it('advances across two successive polls when the 10-minute overlap plus next slice holds over 40 returns, without skipping or exceeding 40 details per poll', async () => {
    const orders = Array.from({ length: 45 }, (_, i) => order(`A${String(i).padStart(2, '0')}`, { updatedMs: NOW - 2 * HOUR }));
    // 40 accepted returns inside the 10-minute overlap before `NOW - MIN`, plus 5 in the next 1-minute slice.
    const returns = orders.map((o, i) =>
      ret(`R${String(i).padStart(2, '0')}`, o.sn, {
        updatedMs: i < 40 ? NOW - 5 * MIN + i * 1000 : NOW - 40_000 + (i - 40) * 5000,
      }),
    );
    const s = setup(orders, returns);
    const first = await s.provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - MIN).toISOString()}`);
    expect(detailCalls(s.fake).map((c) => c.query.return_sn)).toEqual(returns.slice(0, 40).map((r) => r.returnSn));
    expect(detailCalls(s.fake).length).toBeLessThanOrEqual(SHOPEE_MAX_RETURN_DETAILS);
    expect(first.more).toBe(true);
    expect(first.nextCursor).toBe(`o:${new Date(NOW).toISOString()};r:${new Date(NOW - 41_000).toISOString()}`);
    expect(first.nextCursor!.length).toBeLessThanOrEqual(200);
    expect(first.nextCursor).not.toContain('|');
    expect(parseMarketplaceOrderPage(first)).not.toBeNull();

    s.fake.calls.length = 0;
    const second = await s.provider.listOrders(SECRET, 'shopee', first.nextCursor);
    expect(detailCalls(s.fake).map((c) => c.query.return_sn)).toEqual(returns.slice(40).map((r) => r.returnSn));
    expect(detailCalls(s.fake).length).toBeLessThanOrEqual(SHOPEE_MAX_RETURN_DETAILS);
    expect(second.more).toBe(false);
    expect(second.nextCursor).toBe(`o:${new Date(NOW).toISOString()}`);
    expect(parseMarketplaceOrderPage(second)).not.toBeNull();

    const returnedOrders = new Set([...first.orders, ...second.orders].filter((o) => o.stage === 'returned').map((o) => o.orderNo));
    expect(returnedOrders).toEqual(new Set(orders.map((o) => o.sn)));
  });

  it('orders returns deterministically by update time and return number even when get_return_list answers out of order', async () => {
    const orders = Array.from({ length: 43 }, (_, i) => order(`A${String(i).padStart(2, '0')}`, { updatedMs: NOW - 2 * HOUR }));
    // Give R40..R42 later timestamps; shuffle R00..R39 across shared seconds to exercise the returnSn tie-break too.
    const returns = orders.map((o, i) =>
      ret(`R${String(i).padStart(2, '0')}`, o.sn, {
        updatedMs: i < 40 ? NOW - 5 * MIN + Math.floor(i / 4) * 1000 : NOW - 30_000 + (i - 40) * 1000,
      }),
    );
    const reversedFake = fakeShopee({ ...CRED, raws: orders, returns, now: () => NOW });
    const options = {
      fetch: hostBoundFetch(SHOPEE_HOSTS, async (url: string, init?: RequestInit) => {
        const res = await reversedFake.fetch(url, init);
        const u = new URL(url);
        if (u.pathname === '/api/v2/returns/get_return_list') {
          const body = (await res.json()) as { response?: { more: boolean; return?: unknown[] }; error: string; message: string; request_id: string };
          if (body.response?.return) {
            body.response.return = [...body.response.return].reverse();
            return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return res;
      }),
      now: () => new Date(NOW),
      spacingMs: 0,
    };
    const provider = shopeeMarketplace(options, shopeeCaller(options));
    const first = await provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - MIN).toISOString()}`);
    expect(detailCalls(reversedFake).map((c) => c.query.return_sn)).toEqual(returns.slice(0, 40).map((r) => r.returnSn));
    reversedFake.calls.length = 0;
    const second = await provider.listOrders(SECRET, 'shopee', first.nextCursor);
    expect(detailCalls(reversedFake).map((c) => c.query.return_sn)).toEqual(returns.slice(40).map((r) => r.returnSn));
    expect(second.nextCursor).toBe(`o:${new Date(NOW).toISOString()}`);
  });

  it('advances cleanly across adjacent seconds without looping when first taken and first held are 1 second apart', async () => {
    const orders = Array.from({ length: 41 }, (_, i) => order(`A${String(i).padStart(2, '0')}`, { updatedMs: NOW - 2 * HOUR }));
    // Case A: 1 return at t, 40 returns at t + 1s.
    const oneThenForty = orders.map((o, i) => ret(`R${String(i).padStart(2, '0')}`, o.sn, { updatedMs: i === 0 ? NOW - 5 * MIN : NOW - 5 * MIN + 1000 }));
    const a = setup(orders, oneThenForty);
    const a1 = await a.provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - MIN).toISOString()}`);
    expect(detailCalls(a.fake)).toHaveLength(40);
    expect(a1.more).toBe(true);
    expect(a1.nextCursor).toBe(`o:${new Date(NOW).toISOString()};r:${new Date(NOW - 5 * MIN + 1000).toISOString()}`);
    a.fake.calls.length = 0;
    const a2 = await a.provider.listOrders(SECRET, 'shopee', a1.nextCursor);
    expect(detailCalls(a.fake)).toHaveLength(40);
    expect(a2.more).toBe(false);
    expect(a2.nextCursor).toBe(`o:${new Date(NOW).toISOString()}`);
    expect(new Set([...a1.orders, ...a2.orders].filter((o) => o.stage === 'returned').map((o) => o.orderNo))).toEqual(new Set(orders.map((o) => o.sn)));

    // Case B: 40 returns at t, 1 return at t + 1s.
    const fortyThenOne = orders.map((o, i) => ret(`R${String(i).padStart(2, '0')}`, o.sn, { updatedMs: i < 40 ? NOW - 5 * MIN : NOW - 5 * MIN + 1000 }));
    const b = setup(orders, fortyThenOne);
    const b1 = await b.provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - MIN).toISOString()}`);
    expect(detailCalls(b.fake)).toHaveLength(40);
    expect(b1.more).toBe(true);
    expect(b1.nextCursor).toBe(`o:${new Date(NOW).toISOString()};r:${new Date(NOW - 5 * MIN + 1000).toISOString()}`);
    b.fake.calls.length = 0;
    const b2 = await b.provider.listOrders(SECRET, 'shopee', b1.nextCursor);
    expect(detailCalls(b.fake).map((c) => c.query.return_sn)).toEqual(['R40']);
    expect(b2.more).toBe(false);
    expect(b2.nextCursor).toBe(`o:${new Date(NOW).toISOString()}`);
  });

  it('clears the held returns cursor even when the follow-up poll finds the remaining returns no longer eligible and emits zero orders', async () => {
    const orders = Array.from({ length: 42 }, (_, i) => order(`A${String(i).padStart(2, '0')}`, { updatedMs: NOW - 2 * HOUR }));
    const returns = orders.map((o, i) => ret(`R${String(i).padStart(2, '0')}`, o.sn, { updatedMs: i < 40 ? NOW - 5 * MIN : NOW - 30_000 }));
    const first = await setup(orders, returns).provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - MIN).toISOString()}`);
    expect(first.nextCursor).toBe(`o:${new Date(NOW).toISOString()};r:${new Date(NOW - 31_000).toISOString()}`);

    const cancelled = returns.map((r, i) => (i >= 40 ? { ...r, status: 'CANCELLED' } : r));
    const second = await setup(orders, cancelled).provider.listOrders(SECRET, 'shopee', first.nextCursor);
    expect(second).toEqual({ orders: [], nextCursor: `o:${new Date(NOW).toISOString()}`, more: false });
  });

  it('holds returns before exceeding the 100-order page cap and finishes them on the next poll even when the clock advances and 100 orders remain in the overlap', async () => {
    let clock = NOW;
    const updated = Array.from({ length: 95 }, (_, i) => order(`U${String(i).padStart(2, '0')}`, { updatedMs: NOW - 30_000 }));
    const oldOrders = Array.from({ length: 10 }, (_, i) => order(`A${String(i).padStart(2, '0')}`, { updatedMs: NOW - 2 * HOUR }));
    const returns = oldOrders.map((o, i) => ret(`R${String(i).padStart(2, '0')}`, o.sn, { updatedMs: NOW - 20_000 + i * 1000 }));
    const extra = Array.from({ length: 5 }, (_, i) => order(`V${String(i).padStart(2, '0')}`, { updatedMs: NOW + 30_000 }));
    const fake = fakeShopee({ ...CRED, raws: [...updated, ...oldOrders, ...extra], returns, now: () => clock });
    const options = { fetch: hostBoundFetch(SHOPEE_HOSTS, fake.fetch), now: () => new Date(clock), spacingMs: 0 };
    const provider = shopeeMarketplace(options, shopeeCaller(options));

    const first = await provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - MIN).toISOString()}`);
    expect(new Set(first.orders.map((o) => o.orderNo)).size).toBe(100);
    expect(detailCalls(fake).map((c) => c.query.return_sn)).toEqual(['R00', 'R01', 'R02', 'R03', 'R04']);
    expect(first.nextCursor).toBe(`o:${new Date(NOW).toISOString()};r:${new Date(NOW - 15_000).toISOString()}`);
    expect(first.more).toBe(true);

    // Advance the clock by 1 minute: `[NOW - 10m, NOW + 1m]` now holds 100 orders (`U00..U94` + `V00..V04`), yet returns catch up first without starving.
    clock = NOW + MIN;
    fake.calls.length = 0;
    const second = await provider.listOrders(SECRET, 'shopee', first.nextCursor);
    expect(fake.calls.some((c) => c.path === '/api/v2/order/get_order_list')).toBe(false);
    expect(detailCalls(fake).map((c) => c.query.return_sn)).toEqual(['R05', 'R06', 'R07', 'R08', 'R09']);
    expect(second.orders.filter((o) => o.stage === 'returned').map((o) => o.orderNo)).toEqual(['A05', 'A06', 'A07', 'A08', 'A09']);
    expect(second.more).toBe(true);
    expect(second.nextCursor).toBe(`o:${new Date(NOW).toISOString()}`);

    fake.calls.length = 0;
    const third = await provider.listOrders(SECRET, 'shopee', second.nextCursor);
    expect(third.orders.map((o) => o.orderNo)).toContain('V04');
    expect(third.more).toBe(true);
    expect(third.nextCursor).toBe(`o:${new Date(NOW + MIN).toISOString()};r:${new Date(NOW - 20_000).toISOString()}`);

    const fourth = await provider.listOrders(SECRET, 'shopee', third.nextCursor);
    expect(fourth.more).toBe(false);
    expect(fourth.nextCursor).toBe(`o:${new Date(NOW + MIN).toISOString()}`);
  });

  it('narrows past a later single-second >40 return burst on a wide window instead of refusing earlier orders', async () => {
    const earlyOrder = order('EARLY1', { updatedMs: NOW - 14 * DAY });
    const burstOrders = Array.from({ length: 41 }, (_, i) => order(`B${String(i).padStart(2, '0')}`, { updatedMs: NOW - 2 * DAY }));
    const burstReturns = burstOrders.map((o, i) => ret(`BR${String(i).padStart(2, '0')}`, o.sn, { updatedMs: NOW - DAY }));
    const s = setup([earlyOrder, ...burstOrders], burstReturns);
    const page = await s.provider.listOrders(SECRET, 'shopee', null);
    expect(stagesOf(page, 'EARLY1')).toEqual(['completed:AT-MAU-DL+MU-MAU']);
    expect(page.nextCursor).toBe(`o:${new Date(NOW - 12 * DAY).toISOString()};s:1`);
    expect(page.more).toBe(true);
  });

  it('narrows and widens the held returns slice width (`;rs:`) when catch-up returns span over 150 entries', async () => {
    const orders = [order('A1', { updatedMs: NOW - 10 * DAY })];
    // 160 REQUESTED returns inside [NOW - 10d, NOW - 7d], then an empty [NOW - 5d, NOW - 2d] slice that widens `;rs:1` back to 0, and 1 accepted return at NOW - DAY.
    const many = Array.from({ length: 160 }, (_, i) => ret(`RQ${String(i).padStart(3, '0')}`, 'A1', { status: 'REQUESTED', updatedMs: NOW - 10 * DAY + i * 20 * MIN }));
    const accepted = ret('RA1', 'A1', { updatedMs: NOW - DAY });
    const s = setup(orders, [...many, accepted]);
    const held = `o:${new Date(NOW).toISOString()};r:${new Date(NOW - 11 * DAY).toISOString()}`;
    const p1 = await s.provider.listOrders(SECRET, 'shopee', held);
    expect(p1.orders).toEqual([]);
    expect(p1.more).toBe(true);
    expect(p1.nextCursor).toBe(`o:${new Date(NOW).toISOString()};r:${new Date(NOW - 8 * DAY).toISOString()};rs:1`);

    const p2 = await s.provider.listOrders(SECRET, 'shopee', p1.nextCursor);
    expect(p2.more).toBe(true);
    expect(p2.nextCursor).toBe(`o:${new Date(NOW).toISOString()};r:${new Date(NOW - 5 * DAY).toISOString()};rs:1`);

    const p3 = await s.provider.listOrders(SECRET, 'shopee', p2.nextCursor);
    expect(p3.more).toBe(true);
    expect(p3.nextCursor).toBe(`o:${new Date(NOW).toISOString()};r:${new Date(NOW - 2 * DAY).toISOString()}`);

    const p4 = await s.provider.listOrders(SECRET, 'shopee', p3.nextCursor);
    expect(stagesOf(p4, 'A1')).toEqual(['returned:AT-MAU-DL', 'completed:MU-MAU']);
    expect(p4.more).toBe(false);
    expect(p4.nextCursor).toBe(`o:${new Date(NOW).toISOString()}`);
  });

  it('does not skip a held return when the 15-day floor creeps past it between polls', async () => {
    const oldOrder = order('OLD1', { updatedMs: NOW - 16 * DAY });
    const floorReturn = ret('RF1', 'OLD1', { updatedMs: NOW - 15 * DAY + 1000 });
    let clock = NOW + 5 * MIN;
    const fake = fakeShopee({ ...CRED, raws: [oldOrder], returns: [floorReturn], now: () => clock });
    const options = { fetch: hostBoundFetch(SHOPEE_HOSTS, fake.fetch), now: () => new Date(clock), spacingMs: 0 };
    const provider = shopeeMarketplace(options, shopeeCaller(options));

    const held = `o:${new Date(NOW).toISOString()};r:${new Date(NOW - 15 * DAY + 1000).toISOString()}`;
    const page = await provider.listOrders(SECRET, 'shopee', held);
    expect(stagesOf(page, 'OLD1')).toEqual(['returned:AT-MAU-DL', 'completed:MU-MAU']);
    expect(page.nextCursor).toBe(`o:${new Date(NOW).toISOString()}`);
    expect(page.more).toBe(true);
  });

  it('refuses a return list entry without update_time and ignores a held returns cursor ahead of the orders cursor', async () => {
    const missingUpdateTime = (path: string): Response | undefined =>
      path === '/api/v2/returns/get_return_list'
        ? new Response(JSON.stringify({ error: '', message: '', response: { more: false, return: [{ return_sn: 'R1', order_sn: 'A1', status: 'CLOSED', return_solution: 0, item: [{ item_id: 2600144043, model_id: 5074620257, amount: 2 }] }] } }))
        : undefined;
    expect(await kindOf(() => poll([order('A1')], [], missingUpdateTime))).toBe('not_recognized');

    const badCursor = `o:${new Date(NOW - HOUR).toISOString()};r:${new Date(NOW - MIN).toISOString()}`;
    const s = setup([], []);
    await s.provider.listOrders(SECRET, 'shopee', badCursor);
    const firstOrderCall = s.fake.calls.find((c) => c.path === '/api/v2/order/get_order_list')!;
    expect(Number(firstOrderCall.query.time_from)).toBe(Math.floor((NOW - 15 * DAY) / 1000));
  });
});

describe('a page that is not what the platform sends', () => {
  const refused = (raws: FakeShopeeRaw[], returns: FakeShopeeReturn[], intercept?: Parameters<typeof setup>[2]) => kindOf(() => poll(raws, returns, intercept));
  const onList = (body: string) => (path: string): Response | undefined => (path === '/api/v2/returns/get_return_list' ? new Response(body, { status: 200 }) : undefined);

  it('refuses a status or a solution that is not in the tables', async () => {
    expect(await refused([order('A1')], [ret('R1', 'A1', { status: 'REFUNDED' })])).toBe('not_recognized');
    expect(await refused([order('A1')], [ret('R1', 'A1', { solution: 2 })])).toBe('not_recognized');
  });

  it('refuses a return that names a line the order does not hold, or an order the answer does not hold', async () => {
    expect(await refused([order('A1')], [ret('R1', 'A1', { items: [{ itemId: 1, modelId: 2, amount: 1 }] })])).toBe('not_recognized');
    expect(await refused([order('A1')], [ret('R1', 'NOSUCH')])).toBe('not_recognized');
  });

  it('refuses a return with no item, a bad quantity, a line twice, a number twice or a masked number', async () => {
    expect(await refused([order('A1')], [ret('R1', 'A1', { items: [] })])).toBe('not_recognized');
    expect(await refused([order('A1')], [ret('R1', 'A1', { items: [{ itemId: 2600144043, modelId: 5074620257, amount: 0 }] })])).toBe('not_recognized');
    expect(await refused([order('A1')], [ret('R1', 'A1', { items: [{ itemId: 2600144043, modelId: 5074620257, amount: 1 }, { itemId: 2600144043, modelId: 5074620257, amount: 1 }] })])).toBe('not_recognized');
    expect(await refused([order('A1')], [ret('R1', 'A1'), ret('R1', 'A1')])).toBe('not_recognized');
    expect(await refused([order('A1')], [ret('R*1', 'A1')])).toBe('not_recognized');
  });

  it('refuses a list that is not a list and a `more` that is not a boolean', async () => {
    expect(await refused([order('A1')], [], onList('{"error":"","message":"","response":{"more":"no","return":[]}}'))).toBe('not_recognized');
    expect(await refused([order('A1')], [], onList('{"error":"","message":"","response":{"more":false,"return":{}}}'))).toBe('not_recognized');
  });

  it('refuses a detail that is another return, another order, or carries a validation or reverse word it cannot read', async () => {
    const wrongReturn = (path: string): Response | undefined => (path === '/api/v2/returns/get_return_detail' ? new Response(JSON.stringify({ error: '', message: '', response: { return_sn: 'OTHER', order_sn: 'A1', status: 'CLOSED', return_solution: 0, item: [{ item_id: 2600144043, model_id: 5074620257, amount: 2 }] } })) : undefined);
    expect(await refused([order('A1')], [ret('R1', 'A1')], wrongReturn)).toBe('not_recognized');
    const detailWith = (extra: Record<string, unknown>) => (path: string): Response | undefined =>
      path === '/api/v2/returns/get_return_detail'
        ? new Response(JSON.stringify({ error: '', message: '', response: { return_sn: 'R1', order_sn: 'A1', status: 'CLOSED', return_solution: 0, item: [{ item_id: 2600144043, model_id: 5074620257, amount: 2 }], ...extra } }))
        : undefined;
    expect(await refused([order('A1')], [ret('R1', 'A1')], detailWith({ validation_type: 'somewhere_else' }))).toBe('not_recognized');
    expect(await refused([order('A1')], [ret('R1', 'A1')], detailWith({ reverse_logistics_status: 'delivered!' }))).toBe('not_recognized');
    // Without a validation point or a reverse word the goods are not known to be back: nothing moves, the page is fine.
    const bare = await poll([order('A1')], [ret('R1', 'A1')], detailWith({}));
    expect(stagesOf(bare.page, 'A1')).toEqual(['completed:AT-MAU-DL+MU-MAU']);
  });

  it('is a failure kind for Shopee\'s own refusals on the return calls', async () => {
    expect(await refused([order('A1')], [], (path) => (path === '/api/v2/returns/get_return_list' ? new Response(JSON.stringify({ error: 'error_permission', message: 'x' })) : undefined))).toBe('credentials');
    expect(await refused([order('A1')], [], (path) => (path === '/api/v2/returns/get_return_list' ? new Response('', { status: 429 }) : undefined))).toBe('rate_limited');
  });

  it('keeps the order window and the cursor of S1 when there is no return', async () => {
    const { page } = await poll([order('A1', { updatedMs: NOW - HOUR })], []);
    expect(page.nextCursor).toBe(`o:${new Date(NOW - 1000).toISOString()}`);
    expect(stagesOf(page, 'A1')).toEqual(['completed:AT-MAU-DL+MU-MAU']);
  });

  it('a return of an ended hour does not need minutes of slack', async () => {
    const { page } = await poll([order('A1')], [ret('R1', 'A1', { updatedMs: NOW - 10 * MIN })]);
    expect(stagesOf(page, 'A1')).toEqual(['returned:AT-MAU-DL', 'completed:MU-MAU']);
  });
});

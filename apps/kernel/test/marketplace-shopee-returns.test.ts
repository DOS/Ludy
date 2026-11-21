// SPDX-License-Identifier: AGPL-3.0-only
// The Shopee returns reader (#2524, S2 = #4282) through the orders poll, against a made-up Shopee. What is pinned is THE STOCK RULE: a line is `returned` (stock back) only when the return is a return and refund in an
// accepted status, validated by the seller, whose reverse logistics status is LOGISTICS_DELIVERY_DONE and which names the whole line; LOGISTICS_LOST never brings stock back; a refund only, a warehouse validation, a
// partial quantity and every open or contested status move nothing; and a page that holds a word the tables do not know is refused with nothing stored. No buyer field is read or kept.
import { describe, expect, it } from 'vitest';
import { MarketplaceProviderError, parseMarketplaceOrderPage } from '@crove/mod-finance';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { SHOPEE_HOSTS, shopeeCaller } from '../src/marketplace-shopee.ts';
import { shopeeMarketplace } from '../src/marketplace-shopee-orders.ts';
import { SHOPEE_RETURN_STATUS } from '../src/marketplace-shopee-returns.ts';
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
const stagesOf = (page: { orders: Array<{ orderNo: string; stage: string; lines: Array<{ sku: string | null }> }> }, sn: string) => page.orders.filter((o) => o.orderNo === sn).map((o) => `${o.stage}:${o.lines.map((l) => l.sku).join('+')}`);
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
    // The order was last updated twenty days ago (outside the 15 day window the first poll reads); the return is recent.
    const old = order('A1', { updatedMs: NOW - 14.99 * DAY });
    const { page, fake } = await poll([old], [ret('R1', 'A1', { updatedMs: NOW - HOUR })]);
    expect(stagesOf(page, 'A1')).toEqual(['returned:AT-MAU-DL', 'completed:MU-MAU']);
    expect(fake.calls.some((c) => c.path === '/api/v2/order/get_order_detail' && c.query.order_sn_list === 'A1')).toBe(true);
  });

  it('ignores goods coming back on an order that never shipped or was cancelled', async () => {
    const { page } = await poll([order('P1', { status: 'READY_TO_SHIP', pickupDoneMs: undefined as unknown as number }), order('C1', { status: 'CANCELLED', cancelBy: 'buyer', pickupDoneMs: undefined as unknown as number })], [ret('R1', 'P1'), ret('R2', 'C1')]);
    expect(stagesOf(page, 'P1')).toEqual(['placed:AT-MAU-DL+MU-MAU']);
    expect(stagesOf(page, 'C1')).toEqual(['cancelled:AT-MAU-DL+MU-MAU']);
  });

  it('shipped order with goods back is returned too, with no delivery day', async () => {
    const { page } = await poll([order('S1', { status: 'TO_RETURN' })], [ret('R1', 'S1')]);
    expect(page.orders.find((o) => o.stage === 'returned')).toMatchObject({ shippedAt: '2026-11-17', deliveredAt: null });
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

// SPDX-License-Identifier: AGPL-3.0-only
// The Shopee caller, the connection test and the orders adapter (#2524, S1 = #4274) against a made-up Shopee. What is pinned: the signed address (partner id, timestamp, token, shop, signature in the query, nothing
// of the key); the failure kinds by Shopee's error words; an amount kept as the exact text Shopee wrote (a float would round it) and refused when it is an exponent or has more than four decimals; no buyer field asked
// for and none kept even when an answer carries one; the stage table and THE STOCK RULE (a system or Ops cancellation after pickup stays `shipped`, never `cancelled`); the window cuts and the cursor; and every
// hostile page refused as `not_recognized` with nothing stored.
import { describe, expect, it } from 'vitest';
import { MarketplaceProviderError, parseMarketplaceOrderPage } from '@crove/mod-finance';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { SHOPEE_HOSTS, ShopeeApiError, parseShopeeAnswer, parseShopeeSecret, shopeeCaller, shopeeShopInfo, testShopeeConnection } from '../src/marketplace-shopee.ts';
import { SHOPEE_ORDER_STAGE, shopeeMarketplace } from '../src/marketplace-shopee-orders.ts';
import { fakeShopee, fakeShopeeOrder, type FakeShopeeItem, type FakeShopeeOrderSpec, type FakeShopeeRaw } from './fake-shopee.ts';

const NOW = Date.parse('2026-11-21T08:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const CRED = { partnerId: '1000012', partnerKey: 'test-only-partner-key', shopId: '77777', accessToken: 'SHP_access' };
const SECRET = JSON.stringify(CRED);
const PLANTED = 'planted-sentence-sk-live-12345';

const item = (over: Partial<FakeShopeeItem> = {}): FakeShopeeItem => ({ itemId: 2600144043, modelId: 5074620257, name: 'Áo thun mẫu', modelName: 'Đen, L', itemSku: 'AT-MAU', modelSku: 'AT-MAU-DL', quantity: 2, original: '150000.0', discounted: '120000.0', ...over });
const order = (sn: string, over: Partial<FakeShopeeOrderSpec> = {}): FakeShopeeRaw =>
  fakeShopeeOrder({ sn, status: 'READY_TO_SHIP', createdMs: NOW - 2 * DAY, updatedMs: NOW - HOUR, items: [item()], ...over });

function setup(raws: FakeShopeeRaw[] = [], over: { intercept?: (path: string, query: Record<string, string>) => Response | undefined; shopStatus?: string; shopRegion?: string; now?: () => number } = {}) {
  const clock = over.now ?? (() => NOW);
  const fake = fakeShopee({ ...CRED, raws, now: clock, ...over });
  const options = { fetch: hostBoundFetch(SHOPEE_HOSTS, fake.fetch), now: () => new Date(clock()), spacingMs: 0 };
  const caller = shopeeCaller(options);
  return { fake, options, caller, provider: shopeeMarketplace(options, caller) };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const raw = (text: string, status = 200) => new Response(text, { status, headers: { 'content-type': 'application/json' } });
// The kind a call failed with.
const kindOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'no error';
  } catch (error) {
    return error instanceof MarketplaceProviderError ? error.kind : `other: ${String(error)}`;
  }
};

describe('the signed call', () => {
  it('puts the partner id, timestamp, token, shop and signature in the address, never the key, and nothing in a GET body', async () => {
    const { caller, fake } = setup();
    await caller(parseShopeeSecret(SECRET), { method: 'GET', path: '/api/v2/shop/get_shop_info', query: {} });
    const sent = fake.calls[0]!;
    expect(sent).toMatchObject({ method: 'GET', host: 'partner.shopeemobile.com', path: '/api/v2/shop/get_shop_info', body: null });
    expect(Object.keys(sent.query).sort()).toEqual(['access_token', 'partner_id', 'shop_id', 'sign', 'timestamp']);
    expect(sent.url).not.toContain(CRED.partnerKey);
    expect(sent.headers['x-tts-access-token']).toBeUndefined();
  });

  it('refuses a caller that passes a common parameter of its own', async () => {
    const { caller } = setup();
    for (const name of ['partner_id', 'timestamp', 'access_token', 'shop_id', 'sign']) {
      await expect(caller(parseShopeeSecret(SECRET), { method: 'GET', path: '/api/v2/shop/get_shop_info', query: { [name]: 'x' } })).rejects.toThrow(RangeError);
    }
  });

  it('maps Shopee\'s words to the port\'s failure kinds and never repeats its text, the address or a token', async () => {
    const failing = (status: number, body: unknown) => setup([], { intercept: () => json(body, status) });
    const kind = async (status: number, body: unknown) => kindOf(() => failing(status, body).caller(parseShopeeSecret(SECRET), { method: 'GET', path: '/api/v2/shop/get_shop_info', query: {} }));
    expect(await kind(200, { error: 'error_auth', message: PLANTED })).toBe('credentials');
    expect(await kind(200, { error: 'common.error_auth', message: 'Invalid access_token.' })).toBe('credentials');
    expect(await kind(200, { error: 'error_permission', message: PLANTED })).toBe('credentials');
    expect(await kind(200, { error: 'error_shop', message: PLANTED })).toBe('credentials');
    expect(await kind(403, { message: PLANTED })).toBe('credentials');
    expect(await kind(429, {})).toBe('rate_limited');
    expect(await kind(200, { error: 'error_rate_limit', message: PLANTED })).toBe('rate_limited');
    expect(await kind(200, { error: 'error_param', message: PLANTED })).toBe('not_recognized');
    expect(await kind(200, { error: 'order.order_list_invalid_time', message: PLANTED })).toBe('not_recognized');
    expect(await kind(200, { error: 'error_server', message: PLANTED })).toBe('unreachable');
    expect(await kind(502, 'bad gateway')).toBe('unreachable');
    expect(await kind(200, { error: PLANTED })).toBe('unreachable');
    expect(await kind(200, [1, 2])).toBe('unreachable');
    // A success without a `response` object is not Shopee's.
    expect(await kind(200, { error: '', message: '' })).toBe('not_recognized');
    try {
      await failing(200, { error: 'error_auth', message: PLANTED }).caller(parseShopeeSecret(SECRET), { method: 'GET', path: '/api/v2/shop/get_shop_info', query: {} });
    } catch (error) {
      const text = JSON.stringify(error) + String((error as Error).message);
      for (const word of [PLANTED, CRED.partnerKey, CRED.accessToken, 'partner.shopeemobile.com', 'sign=']) expect(text).not.toContain(word);
    }
  });

  it('reads a thrown network error as unreachable without its text', async () => {
    const options = { fetch: hostBoundFetch(SHOPEE_HOSTS, async () => Promise.reject(new Error(`${CRED.accessToken} ${PLANTED}`))), spacingMs: 0 };
    const error = await shopeeCaller(options)(parseShopeeSecret(SECRET), { method: 'GET', path: '/x', query: {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShopeeApiError);
    expect(JSON.stringify(error) + String((error as Error).message)).not.toContain(CRED.accessToken);
  });

  it('keeps one pace per partner and shop: the next call waits for the interval from the last one that started', async () => {
    let at = NOW;
    const waited: number[] = [];
    const fake = fakeShopee({ ...CRED, now: () => at });
    const caller = shopeeCaller({
      fetch: hostBoundFetch(SHOPEE_HOSTS, fake.fetch),
      now: () => new Date(at),
      spacingMs: 1000,
      sleep: async (ms) => {
        waited.push(ms);
        at += ms;
      },
    });
    await caller(parseShopeeSecret(SECRET), { method: 'GET', path: '/api/v2/shop/get_shop_info', query: {} });
    await caller(parseShopeeSecret(SECRET), { method: 'GET', path: '/api/v2/shop/get_shop_info', query: {} });
    expect(waited).toEqual([1000]);
  });
});

describe('the shop info and the connection test', () => {
  it('reads the shop and the end of the seller\'s authorization, and keeps nothing else', async () => {
    const { caller } = setup();
    const info = await shopeeShopInfo(caller, parseShopeeSecret(SECRET), NOW);
    expect(info).toMatchObject({ name: 'Cửa hàng Thử Nghiệm', region: 'VN', status: 'NORMAL' });
    expect(info.authorizationEndsAt?.getTime()).toBe(Math.floor((NOW + 200 * DAY) / 1000) * 1000);
    expect(Object.keys(info).sort()).toEqual(['authorizationEndsAt', 'name', 'region', 'status']);
  });

  it('reports `works` only for a Vietnam shop in good standing', async () => {
    expect(await testShopeeConnection(setup().caller, SECRET)).toBe('works');
    expect(await testShopeeConnection(setup([], { shopRegion: 'TH' }).caller, SECRET)).toBe('wrong_credentials');
    expect(await testShopeeConnection(setup([], { shopStatus: 'BANNED' }).caller, SECRET)).toBe('wrong_credentials');
  });

  it('says why in words: a wrong key, a wrong token, an app type without the API, an outage, a bad secret', async () => {
    const wrongKey = JSON.stringify({ ...CRED, partnerKey: 'another-key' });
    expect(await testShopeeConnection(setup().caller, wrongKey)).toBe('wrong_credentials');
    expect(await testShopeeConnection(setup().caller, JSON.stringify({ ...CRED, accessToken: 'nope' }))).toBe('wrong_credentials');
    expect(await testShopeeConnection(setup([], { intercept: () => json({ error: 'error_permission', message: 'x' }) }).caller, SECRET)).toBe('api_not_enabled');
    expect(await testShopeeConnection(setup([], { intercept: () => raw('down', 503) }).caller, SECRET)).toBe('unreachable');
    expect(await testShopeeConnection(setup().caller, 'not json')).toBe('wrong_credentials');
    expect(await testShopeeConnection(setup().caller, JSON.stringify({ ...CRED, partnerId: 'x' }))).toBe('wrong_credentials');
  });

  it('refuses a shop answer with no region or status as not recognized', async () => {
    const { caller } = setup([], { intercept: () => json({ error: '', response: {}, shop_name: 'x' }) });
    // The fake's own shape has the shop fields next to `response`; a real answer's are too (the page lists them at the top level of the object), and the caller hands back `response` only.
    await expect(shopeeShopInfo(caller, parseShopeeSecret(SECRET), NOW)).rejects.toMatchObject({ kind: 'not_recognized' });
  });
});

describe('parseShopeeAnswer', () => {
  it('keeps an amount and an id as the exact text, and every other number a number', () => {
    const parsed = parseShopeeAnswer('{"item_id":9007199254740993,"model_original_price":4503599627370497.5,"model_discounted_price":1000.0,"quantity":3,"other_price":10.5}') as Record<string, unknown>;
    expect(parsed).toEqual({ item_id: '9007199254740993', model_original_price: '4503599627370497.5', model_discounted_price: '1000.0', quantity: 3, other_price: 10.5 });
  });
});

describe('listOrders', () => {
  const list = async (raws: FakeShopeeRaw[], since: string | null = null, over: Parameters<typeof setup>[1] = {}) => {
    const s = setup(raws, over);
    return { ...s, page: await s.provider.listOrders(SECRET, 'shopee', since) };
  };

  it('is the port\'s provider: its hosts, its connect fields and its capability', () => {
    const { provider } = setup();
    expect(provider.id).toBe('shopee');
    expect(provider.hosts).toEqual(['partner.shopeemobile.com']);
    expect(provider.connectFields).toEqual(['partnerId', 'partnerKey']);
    expect(provider.capabilities.platforms.shopee).toEqual({ pageSize: 100, windowDays: 15, ratePerMinute: 60 });
  });

  it('reads an order into the port\'s shape: Vietnam days, one line per item and model, decimal strings, no buyer', async () => {
    const { page } = await list([order('2611A0001', { status: 'COMPLETED', createdMs: Date.parse('2026-11-18T18:30:00Z'), updatedMs: Date.parse('2026-11-20T10:00:00Z'), pickupDoneMs: Date.parse('2026-11-19T03:00:00Z') })]);
    expect(page.orders).toEqual([
      {
        orderNo: '2611A0001',
        // 18:30 UTC on the 18th is 01:30 on the 19th in Vietnam.
        orderedAt: '2026-11-19',
        shippedAt: '2026-11-19',
        deliveredAt: '2026-11-20',
        stage: 'completed',
        lines: [{ lineKey: '2600144043-5074620257', sku: 'AT-MAU-DL', itemName: 'Áo thun mẫu - Đen, L', quantity: '2', unitPrice: '120000', amount: '240000' }],
      },
    ]);
    // The page passes the port's own check for a page it will write.
    expect(parseMarketplaceOrderPage(page)).not.toBeNull();
    expect(JSON.stringify(page)).not.toMatch(/nguyenvanthu|0901234567|Nguyễn Văn|Quận 1/);
  });

  it('never asks for a buyer field, and drops one an answer carries anyway', async () => {
    const { fake } = await list([order('A1')]);
    const detail = fake.calls.find((c) => c.path === '/api/v2/order/get_order_detail')!;
    expect(detail.query.response_optional_fields).toBe('item_list,pickup_done_time,cancel_by');
    expect(detail.query.response_optional_fields).not.toMatch(/buyer|recipient|note|phone/);
    // A hostile answer that holds them regardless: the page still carries none (and the port's strict schema would refuse one that did).
    const text = fakeShopeeOrder({ sn: 'A1', status: 'READY_TO_SHIP', createdMs: NOW - DAY, updatedMs: NOW - HOUR, items: [item()] }).detail(['item_list', 'buyer_username', 'recipient_address']);
    const s = setup([order('A1')], {
      intercept: (path) => (path === '/api/v2/order/get_order_detail' ? raw(`{"error":"","message":"","response":{"order_list":[${text}]}}`) : undefined),
    });
    const page = await s.provider.listOrders(SECRET, 'shopee', null);
    expect(JSON.stringify(page)).not.toMatch(/nguyenvanthu|0901234567|Nguyễn Văn|Quận 1/);
    expect(parseMarketplaceOrderPage(page)).not.toBeNull();
  });

  it('keeps every amount as the exact text and refuses an exponent, more than four decimals, a negative and a float that would round', async () => {
    const exact = await list([order('A1', { items: [item({ quantity: 1, original: '4503599627370497.5', discounted: '4503599627370497.5' })] })]);
    expect(exact.page.orders[0]!.lines[0]).toMatchObject({ unitPrice: '4503599627370497.5', amount: '4503599627370497.5' });
    const money = await list([order('A1', { items: [item({ quantity: 3, original: '0.1', discounted: '0.1' })] })]);
    // A JS float gives 0.30000000000000004 for 3 times 0.1: the decimal string is exact.
    expect(money.page.orders[0]!.lines[0]).toMatchObject({ unitPrice: '0.1', amount: '0.3' });
    const refuse = async (original: string, discounted: string) => kindOf(() => list([order('A1', { items: [item({ original, discounted })] })]));
    expect(await refuse('1E3', '1000')).toBe('not_recognized');
    expect(await refuse('1000', '1e3')).toBe('not_recognized');
    expect(await refuse('1000.12345', '1000')).toBe('not_recognized');
    expect(await refuse('1000', '-5')).toBe('not_recognized');
    expect(await refuse('12345678901234567', '1')).toBe('not_recognized');
  });

  it('takes the original price for a bundle deal item, which answers 0 by design', async () => {
    const { page } = await list([order('A1', { items: [item({ quantity: 2, original: '150000', discounted: '0' })] })]);
    expect(page.orders[0]!.lines[0]).toMatchObject({ unitPrice: '150000', amount: '300000' });
  });

  it('keeps a long item id exact in the line key and takes the model SKU, else the item SKU, else none', async () => {
    const { page } = await list([
      order('A1', {
        items: [
          item({ itemId: '9007199254740993', modelId: 0, modelSku: '', itemSku: 'ITEM-SKU' }),
          item({ itemId: 2, modelId: 3, modelSku: '', itemSku: '', modelName: '' }),
        ],
      }),
    ]);
    expect(page.orders[0]!.lines.map((l) => [l.lineKey, l.sku, l.itemName])).toEqual([
      ['9007199254740993-0', 'ITEM-SKU', 'Áo thun mẫu - Đen, L'],
      ['2-3', null, 'Áo thun mẫu'],
    ]);
  });

  it('maps the status words to stages, and refuses a word it does not know', async () => {
    const words = Object.keys(SHOPEE_ORDER_STAGE).filter((w) => w !== 'CANCELLED' && w !== 'IN_CANCEL');
    const { page } = await list(words.map((w, i) => order(`S${String(i).padStart(2, '0')}`, { status: w })));
    const stageOf = new Map(page.orders.map((o) => [o.orderNo, o.stage] as const));
    words.forEach((w, i) => expect(stageOf.get(`S${String(i).padStart(2, '0')}`), w).toBe(SHOPEE_ORDER_STAGE[w]));
    expect(SHOPEE_ORDER_STAGE).toMatchObject({ UNPAID: 'placed', READY_TO_SHIP: 'placed', SHIPPED: 'shipped', TO_RETURN: 'shipped', COMPLETED: 'completed', CANCELLED: 'cancelled' });
    expect(await kindOf(() => list([order('A1', { status: 'LOST_BY_3PL' })]))).toBe('not_recognized');
  });

  it('THE STOCK RULE: a system or Ops cancellation after pickup stays shipped; a buyer or seller one, or one before pickup, is cancelled', async () => {
    const picked = NOW - 2 * DAY;
    const { page } = await list([
      order('SYSPICK', { status: 'CANCELLED', cancelBy: 'system', pickupDoneMs: picked }),
      order('OPSPICK', { status: 'CANCELLED', cancelBy: 'Ops', pickupDoneMs: picked }),
      order('BUYPICK', { status: 'CANCELLED', cancelBy: 'buyer', pickupDoneMs: picked }),
      order('SELPICK', { status: 'CANCELLED', cancelBy: 'seller', pickupDoneMs: picked }),
      order('SYSNONE', { status: 'CANCELLED', cancelBy: 'system' }),
      order('NOWHO', { status: 'CANCELLED', pickupDoneMs: picked }),
      order('INCANPICK', { status: 'IN_CANCEL', pickupDoneMs: picked }),
      order('INCANNONE', { status: 'IN_CANCEL' }),
    ]);
    const by = new Map(page.orders.map((o) => [o.orderNo, o] as const));
    expect(by.get('SYSPICK')).toMatchObject({ stage: 'shipped', shippedAt: '2026-11-19', deliveredAt: null });
    expect(by.get('OPSPICK')?.stage).toBe('shipped');
    expect(by.get('BUYPICK')?.stage).toBe('cancelled');
    expect(by.get('SELPICK')?.stage).toBe('cancelled');
    expect(by.get('SYSNONE')?.stage).toBe('cancelled');
    expect(by.get('NOWHO')?.stage).toBe('shipped');
    expect(by.get('INCANPICK')?.stage).toBe('shipped');
    expect(by.get('INCANNONE')?.stage).toBe('placed');
    // A cancelled order shipped nothing and delivered nothing on the page.
    expect(by.get('SYSNONE')).toMatchObject({ shippedAt: null, deliveredAt: null });
    expect(by.get('BUYPICK')).toMatchObject({ shippedAt: null, deliveredAt: null });
  });

  it('dates only what the stage makes true: no shipping day without pickup, no delivery day before completion', async () => {
    const { page } = await list([order('A1', { status: 'SHIPPED' }), order('A2', { status: 'SHIPPED', pickupDoneMs: NOW - DAY }), order('A3', { status: 'TO_RETURN', pickupDoneMs: NOW - DAY })]);
    expect(page.orders.map((o) => [o.orderNo, o.shippedAt, o.deliveredAt])).toEqual([
      ['A1', null, null],
      ['A2', '2026-11-20', null],
      ['A3', '2026-11-20', null],
    ]);
  });

  it('reads the whole 15 day window in one call the first time, by update time, with the port\'s page size, and sorts the orders by number', async () => {
    const { page, fake } = await list([order('B2'), order('A1')]);
    expect(page.orders.map((o) => o.orderNo)).toEqual(['A1', 'B2']);
    const lists = fake.calls.filter((c) => c.path === '/api/v2/order/get_order_list');
    expect(lists).toHaveLength(1);
    const first = lists[0]!;
    expect(first.query).toMatchObject({ time_range_field: 'update_time', page_size: '100', request_order_status_pending: 'true' });
    expect(Number(first.query.time_from)).toBe(Math.floor((NOW - 15 * DAY) / 1000));
    // One second inside the platform's limit, in case it counts the limit as exclusive.
    expect(Number(first.query.time_to)).toBe(Math.floor((NOW - 1000) / 1000));
    // The platform's own limit: never more than 15 days between the two times.
    expect(Number(first.query.time_to) - Number(first.query.time_from)).toBeLessThanOrEqual(15 * 86_400);
    expect(page.nextCursor).toBe(`o:${new Date(NOW - 1000).toISOString()}`);
    // The last second is read by the next poll, which resumes ten minutes back anyway.
    expect(page.more).toBe(true);
  });

  it('cuts the window to the next width when the list says over a page, keeps that width in the cursor, and says there is more', async () => {
    // 120 orders spread over the 15 days (one every three hours): the 15 day window holds over a page, the 3 day one holds 24.
    const spread = Array.from({ length: 120 }, (_, i) => order(`P${String(i).padStart(3, '0')}`, { updatedMs: NOW - 15 * DAY + 1000 + i * 3 * HOUR }));
    const s = setup(spread);
    const page = await s.provider.listOrders(SECRET, 'shopee', null);
    expect(page.orders).toHaveLength(24);
    expect(page.more).toBe(true);
    expect(page.nextCursor).toBe(`o:${new Date(NOW - 12 * DAY).toISOString()};s:1`);
    expect(s.fake.calls.filter((c) => c.path === '/api/v2/order/get_order_list')).toHaveLength(2);
    // The next poll starts at that width, 10 minutes before the cursor, and does not ask for the 15 days again.
    const next = await s.provider.listOrders(SECRET, 'shopee', page.nextCursor);
    const resumed = s.fake.calls.filter((c) => c.path === '/api/v2/order/get_order_list').at(-1)!;
    expect(Number(resumed.query.time_from)).toBe(Math.floor((NOW - 12 * DAY) / 1000) - 600);
    expect(Number(resumed.query.time_to) - Number(resumed.query.time_from)).toBeLessThanOrEqual(3 * 86_400 + 600);
    expect(next.orders.length).toBeLessThanOrEqual(100);
  });

  it('widens the next window after one with no order, so a burst that was cut is passed quickly', async () => {
    const s = setup([order('A1', { updatedMs: NOW - HOUR })]);
    const narrow = `o:${new Date(NOW - 14 * DAY).toISOString()};s:5`;
    const page = await s.provider.listOrders(SECRET, 'shopee', narrow);
    expect(page.orders).toEqual([]);
    expect(page.more).toBe(true);
    expect(page.nextCursor).toBe(`o:${new Date(NOW - 14 * DAY + 10 * MIN).toISOString()};s:4`);
    // From the 3 day width an empty window moves on and widens to the 15 days, which the cursor writes as no width at all.
    const wide = await setup().provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - 14 * DAY).toISOString()};s:1`);
    expect(wide).toEqual({ orders: [], nextCursor: `o:${new Date(NOW - 11 * DAY).toISOString()}`, more: true });
  });

  it('resumes 10 minutes before the cursor so an order updated late is not missed', async () => {
    const s = setup([order('LATE', { updatedMs: NOW - 5 * MIN - 1000 })]);
    const cursor = `o:${new Date(NOW - 5 * MIN).toISOString()}`;
    const page = await s.provider.listOrders(SECRET, 'shopee', cursor);
    expect(page.orders.map((o) => o.orderNo)).toEqual(['LATE']);
    const call = s.fake.calls.find((c) => c.path === '/api/v2/order/get_order_list')!;
    expect(Number(call.query.time_from)).toBe(Math.floor((NOW - 5 * MIN) / 1000) - 600);
  });

  it('keeps the cursor still when caught up with nothing new, and moves it to now when it found orders', async () => {
    const quiet = setup();
    const cursor = `o:${new Date(NOW - 5 * MIN).toISOString()}`;
    expect(await quiet.provider.listOrders(SECRET, 'shopee', cursor)).toEqual({ orders: [], nextCursor: cursor });
    const busy = setup([order('A1', { updatedMs: NOW - 2 * MIN })]);
    const page = await busy.provider.listOrders(SECRET, 'shopee', cursor);
    expect(page.orders.map((o) => o.orderNo)).toEqual(['A1']);
    expect(page.nextCursor).toBe(`o:${new Date(NOW).toISOString()}`);
    expect(page.more).toBe(false);
  });

  it('never looks back past 15 days, whatever the cursor says', async () => {
    const s = setup();
    await s.provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - 40 * DAY).toISOString()}`);
    const call = s.fake.calls.find((c) => c.path === '/api/v2/order/get_order_list')!;
    expect(Number(call.query.time_from) * 1000).toBeGreaterThanOrEqual(NOW - 15 * DAY - 1000);
  });

  it('ignores a cursor that is not its own and starts from the floor', async () => {
    const s = setup();
    expect(await s.provider.listOrders(SECRET, 'shopee', 'sandbox:2')).toMatchObject({ orders: [] });
    expect(s.fake.calls.length).toBeGreaterThan(0);
  });

  it('refuses a page over 100 orders even in the smallest window, never skipping it', async () => {
    // 150 orders inside the last minute can never be read in one page of 100.
    const burst = Array.from({ length: 150 }, (_, i) => order(`B${String(i).padStart(3, '0')}`, { updatedMs: NOW - 30_000 }));
    const s = setup(burst);
    expect(await kindOf(() => s.provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - 20_000).toISOString()}`))).toBe('not_recognized');
    for (const call of s.fake.calls.filter((c) => c.path === '/api/v2/order/get_order_list')) expect(call.query.page_size).toBe('100');
  });

  it('reads the details in batches of 50 and keeps a page at 100 orders', async () => {
    const raws = Array.from({ length: 100 }, (_, i) => order(`D${String(i).padStart(3, '0')}`));
    const s = setup(raws);
    const page = await s.provider.listOrders(SECRET, 'shopee', `o:${new Date(NOW - 3 * HOUR).toISOString()}`);
    expect(page.orders).toHaveLength(100);
    const details = s.fake.calls.filter((c) => c.path === '/api/v2/order/get_order_detail');
    expect(details.map((c) => c.query.order_sn_list!.split(',').length)).toEqual([50, 50]);
    expect(parseMarketplaceOrderPage(page)).not.toBeNull();
  });

  const refused = async (intercept: (path: string, query: Record<string, string>) => Response | undefined, raws: FakeShopeeRaw[] = [order('A1')]) =>
    kindOf(() => setup(raws, { intercept }).provider.listOrders(SECRET, 'shopee', null));
  const detailBody = (...orders: string[]) => raw(`{"request_id":"r","error":"","message":"","response":{"order_list":[${orders.join(',')}]}}`);
  const good = (over: Partial<FakeShopeeOrderSpec> = {}) => fakeShopeeOrder({ sn: 'A1', status: 'READY_TO_SHIP', createdMs: NOW - DAY, updatedMs: NOW - HOUR, items: [item()], ...over }).detail(['item_list', 'pickup_done_time', 'cancel_by']);
  const onDetail = (response: () => Response) => (path: string): Response | undefined => (path === '/api/v2/order/get_order_detail' ? response() : undefined);

  it('refuses, as not recognized, a page that is not what the platform sends', async () => {
    // A shop of another market, another currency, an unknown status, a time in the far future.
    expect(await refused(onDetail(() => detailBody(good({ region: 'TH' }))))).toBe('not_recognized');
    expect(await refused(onDetail(() => detailBody(good({ currency: 'USD' }))))).toBe('not_recognized');
    expect(await refused(onDetail(() => detailBody(good({ updatedMs: NOW + 3 * DAY }))))).toBe('not_recognized');
    // An order asked for and not answered, one answered and not asked for, one twice.
    expect(await refused(onDetail(() => detailBody()))).toBe('not_recognized');
    expect(await refused(onDetail(() => detailBody(good({ sn: 'ZZZ' }))))).toBe('not_recognized');
    expect(await refused(onDetail(() => detailBody(good(), good())))).toBe('not_recognized');
    // No item, a masked number, a line twice, a fractional or zero quantity, a missing price.
    expect(await refused(onDetail(() => detailBody(good({ items: [] }))))).toBe('not_recognized');
    expect(await refused(onDetail(() => detailBody(good({ sn: 'A*1' }))))).toBe('not_recognized');
    expect(await refused(onDetail(() => detailBody(good({ items: [item(), item()] }))))).toBe('not_recognized');
    expect(await refused(onDetail(() => detailBody(good({ items: [item({ quantity: 0 })] }))))).toBe('not_recognized');
    expect(await refused(onDetail(() => detailBody(good({ items: [item({ quantity: 1.5 })] }))))).toBe('not_recognized');
    expect(await refused(onDetail(() => detailBody(good().replace('"model_discounted_price":120000.0,', ''))))).toBe('not_recognized');
    // A cancel word it does not know.
    expect(await refused(onDetail(() => detailBody(good({ status: 'CANCELLED', cancelBy: 'aliens' }))))).toBe('not_recognized');
    // A list that is not a list, a `more` that is not a boolean, an order number twice.
    expect(await refused((path) => (path === '/api/v2/order/get_order_list' ? raw('{"error":"","message":"","response":{"more":"no","order_list":[]}}') : undefined))).toBe('not_recognized');
    expect(await refused((path) => (path === '/api/v2/order/get_order_list' ? raw('{"error":"","message":"","response":{"more":false,"order_list":{}}}') : undefined))).toBe('not_recognized');
    expect(await refused((path) => (path === '/api/v2/order/get_order_list' ? raw('{"error":"","message":"","response":{"more":false,"order_list":[{"order_sn":"A1"},{"order_sn":"A1"}]}}') : undefined))).toBe('not_recognized');
  });

  it('is a failure kind for Shopee\'s own refusals, with nothing stored', async () => {
    expect(await refused(() => json({ error: 'error_auth', message: PLANTED }))).toBe('credentials');
    expect(await refused(() => json({}, 429))).toBe('rate_limited');
    expect(await refused(() => raw('down', 503))).toBe('unreachable');
  });

  it('serves only its own platform and takes no money or stock from this slice', async () => {
    const { provider } = setup();
    expect(await kindOf(() => provider.listOrders(SECRET, 'lazada', null))).toBe('unreachable');
    expect(await provider.orderFinance(SECRET, 'A1')).toBeNull();
    expect(await provider.listStock(SECRET)).toEqual([]);
    expect(await kindOf(() => provider.listOrders('not json', 'shopee', null))).toBe('credentials');
  });
});

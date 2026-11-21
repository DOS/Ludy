// SPDX-License-Identifier: AGPL-3.0-only
// The TikTok Shop orders adapter (#2524, T2 = #4259) against a made-up TikTok (fake-tiktok.ts): the closed stage table and the stock rule, lines folded into a quantity, the two-window cursor and the bulk
// case read on by page token in one call, returns that bring goods back (and the ones that do not), the orders of a return read by id, hostile pages ending as `not_recognized`, no buyer field in any output,
// and the source reading as read only. No call to TikTok: the fetch is the fake.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { findOrderColumns, orderLines, type StatementGrid } from '@crove/l10n-vn';
import { MarketplaceProviderError, marketplaceOrdersCsv, splitWritableOrders, type MarketplaceOrder } from '@crove/mod-finance';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { TIKTOK_HOSTS } from '../src/marketplace-tiktok.ts';
import { TIKTOK_ORDER_STAGE, TIKTOK_RETURN_STATUS, TIKTOK_RETURN_TYPES, tiktokMarketplace } from '../src/marketplace-tiktok-orders.ts';
import { fakeLine, fakeOrder, fakeReturn, fakeShop, fakeTiktok, type FakeTiktokOptions } from './fake-tiktok.ts';

const KEY = { appKey: '123abc', appSecret: 'helloworld', accessToken: 'TTP_access_token_1' };
const CIPHER = 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3';
const SECRET = JSON.stringify({ ...KEY, shopCipher: CIPHER, shopId: '7000714532876273420' });
const NOW = Date.parse('2026-11-21T08:00:00Z');
// Unix seconds an hour before the test clock; `t(n)` is n seconds after it.
const T0 = Math.floor(NOW / 1000) - 3600;
const t = (n: number) => T0 + n;
const iso = (sec: number) => new Date(sec * 1000).toISOString();

function setup(over: Partial<FakeTiktokOptions> = {}) {
  const fake = fakeTiktok({ ...KEY, shops: [fakeShop()], now: () => NOW, ...over });
  const provider = tiktokMarketplace({ fetch: hostBoundFetch(TIKTOK_HOSTS, fake.fetch), now: () => new Date(NOW), sleep: async () => undefined });
  return { provider, fake };
}

const kindOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'no error';
  } catch (error) {
    return error instanceof MarketplaceProviderError ? error.kind : `other: ${String(error)}`;
  }
};

const orderNos = (orders: readonly MarketplaceOrder[]) => orders.map((o) => `${o.orderNo}:${o.stage}`);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the stage table and the stock rule', () => {
  it('maps every status word of the official pages to its stage, and `CANCEL` of the webhook as `CANCELLED`', () => {
    expect(TIKTOK_ORDER_STAGE).toEqual({
      UNPAID: 'placed',
      ON_HOLD: 'placed',
      AWAITING_SHIPMENT: 'placed',
      PARTIALLY_SHIPPING: 'shipped',
      AWAITING_COLLECTION: 'shipped',
      IN_TRANSIT: 'shipped',
      DELIVERED: 'completed',
      COMPLETED: 'completed',
      CANCELLED: 'cancelled',
      CANCEL: 'cancelled',
    });
  });

  it('stages one order per status word through the adapter, a status inside the order and a status on the line apart', async () => {
    const statuses = Object.keys(TIKTOK_ORDER_STAGE).filter((s) => s !== 'PARTIALLY_SHIPPING');
    const orders = statuses.map((status, i) => fakeOrder({ status, update_time: t(i + 1), line_items: [fakeLine({ display_status: status })] }));
    const { provider } = setup({ orders });
    const page = await provider.listOrders(SECRET, 'tiktok_shop', null);
    expect(page.orders.map((o) => o.stage).sort()).toEqual(statuses.map((s) => TIKTOK_ORDER_STAGE[s]!).sort());
  });

  it('refuses a status word the table does not hold, on the order or on a line, and stores nothing', async () => {
    for (const bad of ['SHIPPED', 'DISPUTE', '', 'awaiting_shipment']) {
      const { provider } = setup({ orders: [fakeOrder({ status: bad, update_time: t(1) })] });
      expect(await kindOf(() => provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
      const lineBad = setup({ orders: [fakeOrder({ update_time: t(1), line_items: [fakeLine({ display_status: bad })] })] });
      expect(await kindOf(() => lineBad.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
    }
  });

  it('keeps a line the SYSTEM cancelled after collection as `shipped` (a lost parcel never comes back into stock), and a cancellation before collection as `cancelled`', async () => {
    const lost = fakeOrder({ status: 'CANCELLED', update_time: t(1), collection_time: t(-500), rts_time: t(-900), line_items: [fakeLine({ display_status: 'CANCELLED', cancel_user: 'SYSTEM' })] });
    const never = fakeOrder({ status: 'CANCELLED', update_time: t(2), line_items: [fakeLine({ display_status: 'CANCELLED', cancel_user: 'SYSTEM' })] });
    const buyer = fakeOrder({ status: 'CANCELLED', update_time: t(3), line_items: [fakeLine({ display_status: 'CANCELLED', cancel_user: 'BUYER' })] });
    const { provider } = setup({ orders: [lost, never, buyer] });
    const page = await provider.listOrders(SECRET, 'tiktok_shop', null);
    expect(orderNos(page.orders)).toEqual([`${String(lost.id)}:shipped`, `${String(never.id)}:cancelled`, `${String(buyer.id)}:cancelled`]);
    // The lost parcel shows its shipping day and no delivery day.
    const lostPort = page.orders.find((o) => o.orderNo === lost.id);
    expect(lostPort?.shippedAt).toBe(new Date((t(-900) + 7 * 3600) * 1000).toISOString().slice(0, 10));
    expect(lostPort?.deliveredAt).toBeNull();
  });

  it('refuses a cancel_user it does not know', async () => {
    const { provider } = setup({ orders: [fakeOrder({ update_time: t(1), line_items: [fakeLine({ cancel_user: 'ROBOT' })] })] });
    expect(await kindOf(() => provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
  });
});

describe('the orders', () => {
  it('writes one row of quantity 1 for each line item, never a folded quantity, splits an order whose lines are in two stages (most advanced first) and keeps the days in Vietnam', async () => {
    const order = fakeOrder({
      status: 'PARTIALLY_SHIPPING',
      create_time: t(-86_400),
      update_time: t(10),
      rts_time: t(-3600),
      line_items: [
        fakeLine({ display_status: 'IN_TRANSIT', sale_price: '150000', original_price: '180000' }),
        fakeLine({ display_status: 'IN_TRANSIT', sale_price: '140000', original_price: '180000' }),
        fakeLine({ display_status: 'AWAITING_SHIPMENT', sku_id: '2729382476852921999', seller_sku: 'MAU-002', sale_price: '90000', original_price: '90000' }),
      ],
    });
    const { provider } = setup({ orders: [order] });
    const page = await provider.listOrders(SECRET, 'tiktok_shop', null);
    // The shipped stage comes before the placed one.
    expect(page.orders.map((o) => o.stage)).toEqual(['shipped', 'placed']);
    const shipped = page.orders[0]!;
    expect(shipped.lines.map(({ lineKey: _key, ...rest }) => rest)).toEqual([
      { sku: 'MAU-001', itemName: 'Áo thun mẫu - Đen, L', quantity: '1', unitPrice: '180000', amount: '150000' },
      { sku: 'MAU-001', itemName: 'Áo thun mẫu - Đen, L', quantity: '1', unitPrice: '180000', amount: '140000' },
    ]);
    expect(shipped.shippedAt).toBe(new Date((t(-3600) + 7 * 3600) * 1000).toISOString().slice(0, 10));
    const placed = page.orders[1]!;
    expect(placed.lines).toHaveLength(1);
    expect(placed.lines[0]).toMatchObject({ sku: 'MAU-002', quantity: '1', unitPrice: '90000', amount: '90000' });
    expect(placed.shippedAt).toBeNull();
    // The day of a 17:30 UTC order is the next day in Vietnam.
    const late = fakeOrder({ create_time: Math.floor(Date.parse('2026-11-20T17:30:00Z') / 1000), update_time: t(20) });
    const lateRun = await setup({ orders: [late] }).provider.listOrders(SECRET, 'tiktok_shop', null);
    expect(lateRun.orders[0]?.orderedAt).toBe('2026-11-21');
  });

  // What the intake does with the file this page writes: it names a line by its seller SKU and numbers repeats `#2`, `#3` in row order. This reads the CSV back with the real reader and follows the lines of
  // one order across polls: a line may only move FORWARD, and the stages after each poll must be exactly the truth.
  it('keeps the identity of a unit across polls: a partial return or a partial shipment moves the same keys forward and never writes a unit twice', async () => {
    const RANK = ['placed', 'shipped', 'completed', 'returned'];
    const gridOf = (csv: string): StatementGrid => {
      const grid = new Map<number, Map<number, { kind: string; value: string }>>();
      csv.trim().split('\n').forEach((line, i) => {
        const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replaceAll('""', '"'));
        const row = new Map<number, { kind: string; value: string }>();
        cells.forEach((value, col) => value !== '' && row.set(col, { kind: 'text', value }));
        grid.set(i + 1, row);
      });
      return grid;
    };
    const readLines = async (orders: Array<Record<string, unknown>>, returns: Array<Record<string, unknown>> = []) => {
      const page = await setup({ orders, returns }).provider.listOrders(SECRET, 'tiktok_shop', null);
      const grid = gridOf(marketplaceOrdersCsv('tiktok_shop', page.orders, 'conn-1'));
      const mapping = findOrderColumns(grid);
      const read = mapping ? orderLines(grid, mapping, 20_000) : null;
      expect(read?.skipped).toEqual([]);
      return new Map((read?.lines ?? []).map((l) => [l.lineKey, l.stage] as const));
    };
    const ids = ['5770865121200001', '5770865121200002', '5770865121200003'];
    const units = (statuses: string[]) => statuses.map((display_status, i) => fakeLine({ id: ids[i], display_status }));
    const order = (statuses: string[], status = 'IN_TRANSIT') => fakeOrder({ id: '5764614130399999', status, update_time: t(10), delivery_time: t(-100), line_items: units(statuses) });
    const returnOf = (lineId: string) => fakeReturn({ order_id: '5764614130399999', return_line_items: [{ order_line_item_id: lineId }] });
    const follow = async (...polls: Array<[Array<Record<string, unknown>>, Array<Record<string, unknown>>?]>) => {
      let before: Map<string, string> | null = null;
      for (const [orders, returns] of polls) {
        const now = await readLines(orders, returns);
        if (before) for (const [key, stage] of before) expect(RANK.indexOf(now.get(key) ?? '')).toBeGreaterThanOrEqual(RANK.indexOf(stage));
        before = now;
      }
      return before!;
    };
    // Three units delivered, then one of them returned.
    const afterReturn = await follow([[order(['COMPLETED', 'COMPLETED', 'COMPLETED'], 'COMPLETED')]], [[order(['COMPLETED', 'COMPLETED', 'COMPLETED'], 'COMPLETED')], [returnOf(ids[1]!)]]);
    expect([...afterReturn.values()].sort()).toEqual(['completed', 'completed', 'returned']);
    expect(afterReturn.size).toBe(3);
    // Three units placed, one shipped, then one delivered while one ships and one waits, then all delivered.
    const final = await follow(
      [[order(['AWAITING_SHIPMENT', 'AWAITING_SHIPMENT', 'AWAITING_SHIPMENT'], 'AWAITING_SHIPMENT')]],
      [[order(['AWAITING_SHIPMENT', 'IN_TRANSIT', 'AWAITING_SHIPMENT'], 'PARTIALLY_SHIPPING')]],
      [[order(['AWAITING_SHIPMENT', 'IN_TRANSIT', 'DELIVERED'], 'PARTIALLY_SHIPPING')]],
      [[order(['DELIVERED', 'DELIVERED', 'DELIVERED'], 'DELIVERED')]],
    );
    expect([...final.values()]).toEqual(['completed', 'completed', 'completed']);
    expect(final.size).toBe(3);
  });

  it('writes the delivery day only for a completed or returned stage', async () => {
    const done = fakeOrder({ status: 'COMPLETED', update_time: t(1), rts_time: t(-7200), delivery_time: t(-3600), line_items: [fakeLine({ display_status: 'COMPLETED' })] });
    const page = await setup({ orders: [done] }).provider.listOrders(SECRET, 'tiktok_shop', null);
    expect(page.orders[0]?.deliveredAt).toBe(new Date((t(-3600) + 7 * 3600) * 1000).toISOString().slice(0, 10));
  });

  it('keeps no buyer field: a name, phone, address, e-mail, nickname, id or message planted in the answer is in no output', async () => {
    const { provider } = setup({ orders: [fakeOrder({ update_time: t(1) })], returns: [] });
    const page = await provider.listOrders(SECRET, 'tiktok_shop', null);
    const text = JSON.stringify(page) + marketplaceOrdersCsv('tiktok_shop', page.orders, 'conn-1');
    for (const planted of ['Nguyễn Văn Thử', 'thu_nguyen_vn', 'chat.seller.tiktok.test', '7021436810468230477', 'Giao nhanh', '(+84)', 'Quận 1', 'giao giờ hành chính']) expect(text).not.toContain(planted);
  });

  it('writes the TikTok report layout, one row a line item, and nothing a one-row-per-unit layout would refuse', async () => {
    const order = fakeOrder({ update_time: t(1), line_items: [fakeLine(), fakeLine()] });
    const page = await setup({ orders: [order] }).provider.listOrders(SECRET, 'tiktok_shop', null);
    const csv = marketplaceOrdersCsv('tiktok_shop', page.orders);
    const rows = csv.trim().split('\n');
    expect(rows[0]).toContain('"Order ID"');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain('"1"');
    expect(splitWritableOrders('tiktok_shop', page.orders).refused).toBe(0);
  });

  it('refuses a currency other than dong, a missing one, a masked identifier, a non-decimal amount and a duplicate id, and stores nothing', async () => {
    const bad: Array<Record<string, unknown>> = [
      fakeOrder({ update_time: t(1), line_items: [fakeLine({ currency: 'USD' })] }),
      fakeOrder({ update_time: t(1), line_items: [fakeLine({ currency: undefined })] }),
      fakeOrder({ update_time: t(1), line_items: [fakeLine({ seller_sku: 'MAU-***' })] }),
      fakeOrder({ update_time: t(1), line_items: [fakeLine({ sale_price: 150000 })] }),
      fakeOrder({ update_time: t(1), line_items: [fakeLine({ sale_price: '1.5e5' })] }),
      fakeOrder({ update_time: t(1), line_items: [fakeLine({ sale_price: '-150000' })] }),
      fakeOrder({ update_time: t(1), line_items: [fakeLine({ original_price: '-1' })] }),
      fakeOrder({ update_time: t(1), line_items: [fakeLine({ display_status: 'PARTIALLY_SHIPPING' })] }),
      fakeOrder({ update_time: Math.floor(NOW / 1000) + 2 * 86_400 }),
      fakeOrder({ update_time: t(1), line_items: [fakeLine({ original_price: '150,000' })] }),
      fakeOrder({ update_time: t(1), line_items: [fakeLine({ sku_id: 'abc' })] }),
      fakeOrder({ update_time: t(1), line_items: [] }),
      fakeOrder({ update_time: 'yesterday' }),
      fakeOrder({ update_time: t(1), create_time: 5 }),
      fakeOrder({ update_time: t(1), id: 'order-1' }),
    ];
    for (const order of bad) {
      const { provider } = setup({ orders: [order] });
      expect(await kindOf(() => provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
    }
    const line = fakeLine();
    const twice = setup({ orders: [fakeOrder({ update_time: t(1), line_items: [line] }), fakeOrder({ update_time: t(2), line_items: [line] })] });
    expect(await kindOf(() => twice.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
    const sameOrder = fakeOrder({ update_time: t(1) });
    const dup = setup({ intercept: (_host, path) => (path === '/order/202309/orders/search' ? json({ code: 0, data: { orders: [sameOrder, sameOrder], next_page_token: '', total_count: 2 } }) : undefined) });
    expect(await kindOf(() => dup.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
  });

  it('refuses an answer that counts orders but holds no list, and an answer that is no object', async () => {
    const counts = setup({ intercept: (_host, path) => (path === '/order/202309/orders/search' ? json({ code: 0, data: { total_count: 12, next_page_token: '' } }) : undefined) });
    expect(await kindOf(() => counts.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
    const none = setup({ intercept: (_host, path) => (path === '/order/202309/orders/search' ? json({ code: 0, data: 'nothing' }) : undefined) });
    expect(await kindOf(() => none.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
    const tooMany = setup({ orders: Array.from({ length: 3 }, (_, i) => fakeOrder({ update_time: t(i + 1) })), intercept: (_h, path) => (path === '/order/202309/orders/search' ? json({ code: 0, data: { orders: Array.from({ length: 51 }, () => fakeOrder({ update_time: t(1) })), next_page_token: '' } }) : undefined) });
    expect(await kindOf(() => tooMany.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
  });

  it('answers an empty shop with an empty page and leaves the cursor where it was', async () => {
    const { provider } = setup();
    expect(await provider.listOrders(SECRET, 'tiktok_shop', null)).toEqual({ orders: [], nextCursor: null });
    const cursor = `o:${iso(t(-100))};r:${iso(t(-100))}`;
    expect(await provider.listOrders(SECRET, 'tiktok_shop', cursor)).toEqual({ orders: [], nextCursor: cursor });
  });

  it('is deterministic: the same window gives the same page bytes', async () => {
    const orders = [fakeOrder({ update_time: t(2) }), fakeOrder({ update_time: t(1) }), fakeOrder({ update_time: t(3), line_items: [fakeLine(), fakeLine({ sku_id: '2729382476852921001', seller_sku: 'MAU-009' })] })];
    const a = await setup({ orders }).provider.listOrders(SECRET, 'tiktok_shop', null);
    const b = await setup({ orders: [...orders].reverse() }).provider.listOrders(SECRET, 'tiktok_shop', null);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('the request', () => {
  it('signs the exact body it sends, sends the token in a header only, and asks for the shop, the size and the ascending update order', async () => {
    const { provider, fake } = setup({ orders: [fakeOrder({ update_time: t(1) })] });
    await provider.listOrders(SECRET, 'tiktok_shop', null);
    const orderCall = fake.calls.find((c) => c.path === '/order/202309/orders/search')!;
    expect(orderCall.method).toBe('POST');
    expect(orderCall.query).toMatchObject({ page_size: '50', sort_field: 'update_time', sort_order: 'ASC', shop_cipher: CIPHER, app_key: '123abc' });
    expect(orderCall.body).toBe(JSON.stringify({ update_time_ge: Math.floor(NOW / 1000) - 30 * 86_400 }));
    expect(orderCall.headers['x-tts-access-token']).toBe(KEY.accessToken);
    for (const call of fake.calls) {
      expect(call.url).not.toContain(KEY.accessToken);
      expect(call.url).not.toContain(KEY.appSecret);
      expect(call.host).toBe('open-api.tiktokglobalshop.com');
    }
    // One call for the orders and one for the returns when no return names an order outside the page.
    expect(fake.calls.map((c) => c.path)).toEqual(['/order/202309/orders/search', '/return_refund/202602/returns/search']);
  });

  it('refuses a connection that has chosen no shop, before any call', async () => {
    const { provider, fake } = setup();
    expect(await kindOf(() => provider.listOrders(JSON.stringify(KEY), 'tiktok_shop', null))).toBe('credentials');
    expect(fake.calls).toHaveLength(0);
    expect(await kindOf(() => provider.listOrders(SECRET, 'shopee', null))).toBe('unreachable');
  });

  it('maps a refused token, a bad signature secret and a throttle to the port kinds, with no secret in the error', async () => {
    const wrongSecret = setup();
    const stale = JSON.stringify({ ...KEY, appSecret: 'other', shopCipher: CIPHER });
    expect(await kindOf(() => wrongSecret.provider.listOrders(stale, 'tiktok_shop', null))).toBe('credentials');
    const throttled = setup({ intercept: (_h, path) => (path === '/order/202309/orders/search' ? json({ code: 36009002, message: 'slow down' }, 429) : undefined) });
    expect(await kindOf(() => throttled.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('rate_limited');
    try {
      await wrongSecret.provider.listOrders(stale, 'tiktok_shop', null);
    } catch (error) {
      expect(String(error)).not.toMatch(/other|helloworld|TTP_access/);
    }
  });
});

describe('the cursor and the windows', () => {
  it('starts at the 30 day floor, ends a short window ten minutes before its newest record and moves the two windows apart', async () => {
    const { provider } = setup({ orders: [fakeOrder({ update_time: t(100) }), fakeOrder({ update_time: t(200) })], returns: [fakeReturn({ order_id: '576461413038799000', return_status: 'REQUEST_REJECTED', update_time: t(150) })] });
    // The return names an order outside the page, but it brings no goods back, so no order is fetched for it.
    const page = await provider.listOrders(SECRET, 'tiktok_shop', null);
    expect(page.more).toBe(false);
    expect(page.nextCursor).toBe(`o:${iso(t(200) - 600)};r:${iso(t(150) - 600)}`);
  });

  it('never starts before the floor, whatever the cursor says, and ignores a cursor it does not know', async () => {
    const { provider, fake } = setup();
    await provider.listOrders(SECRET, 'tiktok_shop', `o:${iso(1_000_000_000)};r:${iso(1_000_000_000)}`);
    const floor = Math.floor(NOW / 1000) - 30 * 86_400;
    expect(JSON.parse(fake.calls[0]!.body!).update_time_ge).toBe(floor);
    const other = setup();
    await other.provider.listOrders(SECRET, 'tiktok_shop', 'u:2026-11-02T00:00:00.000Z');
    expect(JSON.parse(other.fake.calls[0]!.body!).update_time_ge).toBe(floor);
  });

  it('moves a full page to a second before its newest record and says more waits', async () => {
    const orders = Array.from({ length: 120 }, (_, i) => fakeOrder({ update_time: t(i + 1) }));
    const { provider } = setup({ orders });
    const page = await provider.listOrders(SECRET, 'tiktok_shop', null);
    expect(page.orders).toHaveLength(50);
    expect(page.more).toBe(true);
    expect(page.nextCursor).toContain(`o:${iso(t(50) - 1)}`);
    // Resumed from there, the next page continues with the orders after it (the second just before the newest is read again).
    const next = await provider.listOrders(SECRET, 'tiktok_shop', page.nextCursor);
    expect(next.orders).toHaveLength(50);
    // The second page starts at the second before the first page's newest (the order of t(49) is read twice), so nothing between them was skipped.
    expect(new Set([...page.orders, ...next.orders].map((o) => o.orderNo)).size).toBe(98);
  });

  it('reads a bulk change within one second on by page token in the same call, and never keeps a token', async () => {
    const orders = Array.from({ length: 120 }, () => fakeOrder({ update_time: t(5) }));
    const { provider, fake } = setup({ orders });
    // The first call moves the window to a second before the newest order, as for any full page.
    const first = await provider.listOrders(SECRET, 'tiktok_shop', null);
    expect(first.orders).toHaveLength(50);
    expect(first.more).toBe(true);
    // From there the whole page lies within a second of the window's start: the window cannot move, so it is read on by token, in this one call.
    fake.calls.length = 0;
    const page = await provider.listOrders(SECRET, 'tiktok_shop', first.nextCursor);
    expect(page.orders).toHaveLength(120);
    expect(page.more).toBe(false);
    expect(page.nextCursor).not.toMatch(/=|@/);
    const orderCalls = fake.calls.filter((c) => c.path === '/order/202309/orders/search');
    expect(orderCalls).toHaveLength(3);
    expect(orderCalls[0]!.query.page_token).toBeUndefined();
    expect(orderCalls[1]!.query.page_token).toBeTruthy();
    // The body is the same filter on every page of the window.
    expect(new Set(orderCalls.map((c) => c.body)).size).toBe(1);
  });

  it('refuses, visibly, a bulk change that does not end within the pages one call may read', async () => {
    const orders = Array.from({ length: 50 * 6 }, () => fakeOrder({ update_time: t(5) }));
    const { provider } = setup({ orders });
    const first = await provider.listOrders(SECRET, 'tiktok_shop', null);
    expect(await kindOf(() => provider.listOrders(SECRET, 'tiktok_shop', first.nextCursor))).toBe('not_recognized');
  });

  it('never lets a page pass the 250 orders a poll page may hold: returns that need an order read by id wait for the next call, and the window of the returns resumes before the first one held', async () => {
    const bulk = Array.from({ length: 250 }, () => fakeOrder({ update_time: t(5) }));
    const old = fakeOrder({ status: 'COMPLETED', update_time: t(-5000), line_items: [fakeLine({ display_status: 'COMPLETED' })] });
    const oldLine = (old.line_items as Array<Record<string, unknown>>)[0]!;
    const { provider, fake } = setup({ orders: [...bulk, old], returns: [fakeReturn({ order_id: old.id, update_time: t(30), return_line_items: [{ order_line_item_id: oldLine.id }] })] });
    // The orders window already sits a second before the bulk, so it cannot move and is read on by token: 250 orders.
    const start = `o:${iso(t(4))};r:${iso(t(-10))}`;
    // 250 orders in one second fill the page: the order of the return would be the 251st, so it is not read now and its window is not moved past it.
    const first = await provider.listOrders(SECRET, 'tiktok_shop', start);
    expect(first.orders).toHaveLength(250);
    expect(new Set(first.orders.map((o) => o.orderNo)).size).toBe(250);
    expect(fake.calls.some((c) => c.path === '/order/202507/orders')).toBe(false);
    expect(first.nextCursor).toContain(`;r:${iso(t(29))}`);
    expect(first.more).toBe(true);
    // The next call, with the orders window past the bulk, reads the return and its order by id.
    const second = await provider.listOrders(SECRET, 'tiktok_shop', `o:${iso(t(100))};r:${iso(t(29))}`);
    expect(orderNos(second.orders)).toEqual([`${String(old.id)}:returned`]);
  });

  it('refuses a return updated in the future, and dates a line kept `shipped` by its collection day when the order has no shipping day', async () => {
    const future = setup({ orders: [], returns: [fakeReturn({ update_time: Math.floor(NOW / 1000) + 2 * 86_400 })] });
    expect(await kindOf(() => future.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
    const lost = fakeOrder({ status: 'CANCELLED', update_time: t(1), collection_time: t(-500), line_items: [fakeLine({ display_status: 'CANCELLED', cancel_user: 'SYSTEM' })] });
    const page = await setup({ orders: [lost] }).provider.listOrders(SECRET, 'tiktok_shop', null);
    expect(page.orders[0]?.stage).toBe('shipped');
    expect(page.orders[0]?.shippedAt).toBe(new Date((t(-500) + 7 * 3600) * 1000).toISOString().slice(0, 10));
  });

  it('refuses a page token that is no token', async () => {
    const { provider } = setup({ intercept: (_h, path) => (path === '/order/202309/orders/search' ? json({ code: 0, data: { orders: [], next_page_token: 'bad token', total_count: 0 } }) : undefined) });
    expect(await kindOf(() => provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
  });
});

describe('the returns', () => {
  const lineA = fakeLine({ display_status: 'COMPLETED' });
  const lineB = fakeLine({ display_status: 'COMPLETED', sku_id: '2729382476852921999', seller_sku: 'MAU-002' });
  const delivered = () => fakeOrder({ status: 'COMPLETED', update_time: t(10), rts_time: t(-9000), delivery_time: t(-7000), line_items: [lineA, lineB] });

  it('moves only the lines a RETURN_AND_REFUND names to `returned` once the seller has the goods and the refund is approved or done', async () => {
    for (const status of ['RETURN_OR_REFUND_REQUEST_SUCCESS', 'RETURN_OR_REFUND_REQUEST_COMPLETE', 'REQUEST_SUCCESS']) {
      const order = delivered();
      const { provider } = setup({ orders: [order], returns: [fakeReturn({ order_id: order.id, return_status: status, return_line_items: [{ order_line_item_id: lineA.id }] })] });
      const page = await provider.listOrders(SECRET, 'tiktok_shop', null);
      expect(page.orders.map((o) => `${o.stage}:${o.lines.map((l) => l.sku).join(',')}`).sort()).toEqual(['completed:MAU-002', 'returned:MAU-001']);
      // A returned line keeps the delivery day: it was delivered first.
      expect(page.orders.find((o) => o.stage === 'returned')?.deliveredAt).not.toBeNull();
    }
  });

  it('moves no stock for a return still open, one rejected or cancelled, a refund where the buyer keeps the item, a replacement or an exchange', async () => {
    const open = Object.entries(TIKTOK_RETURN_STATUS).filter(([, effect]) => effect === 'no_stock').map(([status]) => status);
    for (const status of open) {
      const order = delivered();
      const { provider } = setup({ orders: [order], returns: [fakeReturn({ order_id: order.id, return_status: status, return_line_items: [{ order_line_item_id: lineA.id }] })] });
      const page = await provider.listOrders(SECRET, 'tiktok_shop', null);
      expect(page.orders.map((o) => o.stage)).toEqual(['completed']);
    }
    for (const type of ['REFUND', 'REPLACEMENT', 'EXCHANGE']) {
      const order = delivered();
      const { provider } = setup({ orders: [order], returns: [fakeReturn({ order_id: order.id, return_type: type, return_status: 'RETURN_OR_REFUND_REQUEST_COMPLETE', return_line_items: [{ order_line_item_id: lineA.id }] })] });
      const page = await provider.listOrders(SECRET, 'tiktok_shop', null);
      expect(page.orders.map((o) => o.stage)).toEqual(['completed']);
    }
  });

  it('reads the order by id when a return names one outside the orders page, and asks for it once', async () => {
    const old = fakeOrder({ status: 'COMPLETED', update_time: t(-5000), line_items: [fakeLine({ display_status: 'COMPLETED' })] });
    const fresh = fakeOrder({ update_time: t(20) });
    const oldLine = (old.line_items as Array<Record<string, unknown>>)[0]!;
    const { provider, fake } = setup({ orders: [old, fresh], returns: [fakeReturn({ order_id: old.id, update_time: t(30), return_line_items: [{ order_line_item_id: oldLine.id }] })] });
    // The orders window starts after the old order's update, the returns window before the return.
    const page = await provider.listOrders(SECRET, 'tiktok_shop', `o:${iso(t(-10))};r:${iso(t(-10))}`);
    expect(orderNos(page.orders).sort()).toEqual([`${String(old.id)}:returned`, `${String(fresh.id)}:placed`].sort());
    const detail = fake.calls.filter((c) => c.path === '/order/202507/orders');
    expect(detail).toHaveLength(1);
    expect(detail[0]!.query.ids).toBe(String(old.id));
    expect(detail[0]!.method).toBe('GET');
  });

  it('refuses a return of an order TikTok does not answer, a line the order does not hold, and a closed table word it does not know', async () => {
    const order = delivered();
    const ghost = setup({ orders: [], returns: [fakeReturn({ order_id: '576461413038799999' })] });
    expect(await kindOf(() => ghost.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
    const wrongLine = setup({ orders: [order], returns: [fakeReturn({ order_id: order.id, return_line_items: [{ order_line_item_id: '1' }] })] });
    expect(await kindOf(() => wrongLine.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
    const noLines = setup({ orders: [order], returns: [fakeReturn({ order_id: order.id, return_line_items: [] })] });
    expect(await kindOf(() => noLines.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
    for (const over of [{ return_status: 'PACKAGE_RETURNED' }, { return_status: '' }, { return_type: 'SWAP' }, { update_time: 'now' }, { return_id: 'r-1' }]) {
      const bad = setup({ orders: [order], returns: [fakeReturn({ order_id: order.id, return_line_items: [{ order_line_item_id: lineA.id }], ...over })] });
      expect(await kindOf(() => bad.provider.listOrders(SECRET, 'tiktok_shop', null))).toBe('not_recognized');
    }
  });

  it('holds both word families the official pages give for a finished return, and every return type', () => {
    for (const word of ['RETURN_OR_REFUND_REQUEST_SUCCESS', 'REQUEST_SUCCESS', 'REFUND_OR_RETURN_REQUEST_REJECT', 'REQUEST_REJECTED', 'REJECT_RECEIVE_PACKAGE', 'RECEIVE_REJECTED', 'RETURN_OR_REFUND_REQUEST_CANCEL', 'RETURN_OR_REFUND_CANCEL']) {
      expect(TIKTOK_RETURN_STATUS).toHaveProperty(word);
    }
    expect(Object.entries(TIKTOK_RETURN_STATUS).filter(([, effect]) => effect === 'goods_back').map(([word]) => word).sort()).toEqual(['REQUEST_SUCCESS', 'RETURN_OR_REFUND_REQUEST_COMPLETE', 'RETURN_OR_REFUND_REQUEST_SUCCESS']);
    expect([...TIKTOK_RETURN_TYPES].sort()).toEqual(['EXCHANGE', 'REFUND', 'REPLACEMENT', 'RETURN_AND_REFUND']);
  });

  it('keeps no buyer text of a return: the reason, the role and the line ids of the return are in no output', async () => {
    const order = delivered();
    const { provider } = setup({ orders: [order], returns: [fakeReturn({ order_id: order.id, return_line_items: [{ order_line_item_id: lineA.id }] })] });
    const text = JSON.stringify(await provider.listOrders(SECRET, 'tiktok_shop', null));
    expect(text).not.toContain('Không vừa');
    expect(text).not.toContain('Nguyễn Văn Thử');
    expect(text).not.toContain('4035227657962164811');
  });
});

describe('the provider', () => {
  it('names TikTok Shop, its host, the two things to type and its capabilities', () => {
    const { provider } = setup();
    expect(provider.id).toBe('tiktok_shop');
    expect(provider.hosts).toEqual([...TIKTOK_HOSTS]);
    expect(provider.connectFields).toEqual(['appKey', 'appSecret']);
    expect(Object.keys(provider.capabilities.platforms)).toEqual(['tiktok_shop']);
  });

  it('tests the connection with the shop list, reads no money and no stock', async () => {
    const { provider, fake } = setup();
    expect(await provider.testConnection(SECRET)).toBe('works');
    expect(fake.calls.map((c) => c.path)).toEqual(['/authorization/202309/shops']);
    expect(await provider.orderFinance(SECRET, '1')).toBeNull();
    expect(await provider.listStock(SECRET)).toEqual([]);
  });
});

describe('the source', () => {
  const source = readFileSync(new URL('../src/marketplace-tiktok-orders.ts', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');

  it('calls three paths and no other, makes no request of its own and names no write endpoint', () => {
    const paths = [...code.matchAll(/'(\/[a-z_]+\/\d{6}[^']*)'/g)].map((m) => m[1]);
    expect(paths.sort()).toEqual(['/order/202309/orders/search', '/order/202507/orders', '/return_refund/202602/returns/search']);
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|node:http|node:net/);
    expect(code).not.toMatch(/method: '(PUT|PATCH|DELETE)'/);
    expect(code).not.toMatch(/\/(fulfillment|products|finance|cancel|ship|reject|approve|refund)\b/i);
    expect(code).not.toMatch(/https?:\/\//);
  });

  it('copies no buyer field by name', () => {
    for (const name of ['recipient_address', 'buyer_email', 'buyer_message', 'buyer_nickname', 'user_id', 'phone', 'address', 'cpf']) expect(code).not.toContain(`'${name}'`);
  });
});

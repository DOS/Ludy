// SPDX-License-Identifier: AGPL-3.0-only
// The Lazada adapter (#2524, S1 = #4237) against a made-up Lazada (fake-lazada.ts): the signature checked by the fake's own implementation of the official algorithm, the window and its cursor, an order
// whose items are in different states, every status of the closed table, a buyer's data never reaching a type or a file, and a hostile, masked or oversized answer ending as `not_recognized` or a
// failure of the port, never a stored value. No call to Lazada: the fetch is the fake.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARKETPLACE_PLATFORM_LIMITS, MarketplaceProviderError, marketplaceOrdersCsv, parseMarketplaceOrderPage } from '@crove/mod-finance';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { LAZADA_HOSTS, LAZADA_ITEM_STAGE, lazadaMarketplace, lazadaStamp, parseLazadaSecret, parseLazadaTime, signLazadaRequest } from '../src/marketplace-lazada.ts';
import { fakeLazada, fakeOrder, type FakeOrder } from './fake-lazada.ts';

const KEY = { appKey: '123456', appSecret: 'helloworld', accessToken: '50000000001abcDEF' };
const SECRET = JSON.stringify(KEY);
const NOW = Date.parse('2026-11-10T03:00:00Z');

function setup(orders: FakeOrder[], over: { intercept?: Parameters<typeof fakeLazada>[0]['intercept'] } = {}) {
  const fake = fakeLazada({ ...KEY, orders, ...(over.intercept ? { intercept: over.intercept } : {}) });
  const waits: number[] = [];
  const provider = lazadaMarketplace({ fetch: hostBoundFetch(LAZADA_HOSTS, fake.fetch), now: () => new Date(NOW), sleep: async (ms) => void waits.push(ms) });
  return { provider, fake, waits };
}

const kind = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'no error';
  } catch (error) {
    return error instanceof MarketplaceProviderError ? error.kind : `other: ${String(error)}`;
  }
};

describe('the signature', () => {
  it('is the official algorithm: sorted keys, the path first, upper-case HMAC-SHA256 hex (a vector from the official Python sample)', () => {
    const params = { app_key: '123456', timestamp: '1517820392000', sign_method: 'sha256', access_token: '50000000001abcDEF', update_after: '2018-02-01T00:00:00+07:00', limit: '100', offset: '0', sort_by: 'updated_at', sort_direction: 'ASC' };
    expect(signLazadaRequest('helloworld', '/orders/get', params)).toBe('86218DD3C050BDC8A89D8C22205A993284B87D496D7EE65F1674019EF9347315');
  });

  it('leaves an empty parameter out and does not depend on the order the keys were written in', () => {
    const a = signLazadaRequest('s', '/orders/get', { b: '2', a: '1', c: '' });
    expect(a).toBe(signLazadaRequest('s', '/orders/get', { a: '1', b: '2' }));
    expect(a).toMatch(/^[0-9A-F]{64}$/);
  });
});

describe('the sealed secret and the times', () => {
  it('reads the three fields, ignores the rest, and refuses a malformed secret without echoing it', () => {
    expect(parseLazadaSecret(JSON.stringify({ ...KEY, refreshToken: 'later', extra: 1 }))).toEqual(KEY);
    for (const bad of ['not json', '{}', JSON.stringify({ ...KEY, appKey: '' }), JSON.stringify({ ...KEY, accessToken: 'has space' }), JSON.stringify({ ...KEY, appSecret: 7 }), 'null']) {
      expect(() => parseLazadaSecret(bad)).toThrow(MarketplaceProviderError);
    }
    try {
      parseLazadaSecret('{"appKey":"leakme"');
    } catch (error) {
      expect(String(error)).not.toContain('leakme');
    }
  });

  it('reads Lazada\'s two time spellings and writes Vietnam time with its offset', () => {
    expect(parseLazadaTime('2018-02-10T16:00:00+08:00')).toBe(Date.parse('2018-02-10T08:00:00Z'));
    expect(parseLazadaTime('2018-02-10 16:00:00 +0800')).toBe(Date.parse('2018-02-10T08:00:00Z'));
    expect(parseLazadaTime('2026-02-30T10:00:00+07:00')).toBeNull();
    expect(parseLazadaTime('yesterday')).toBeNull();
    expect(parseLazadaTime(20260210)).toBeNull();
    expect(lazadaStamp(Date.parse('2026-11-10T03:00:00Z'))).toBe('2026-11-10T10:00:00+07:00');
  });
});

describe('the provider', () => {
  it('declares what it is: the id, the one host, the two connect fields, the platform and its limits', () => {
    const { provider } = setup([]);
    expect(provider.id).toBe('lazada');
    expect(provider.hosts).toEqual(['api.lazada.vn']);
    expect(provider.connectFields).toEqual(['appKey', 'appSecret']);
    expect(provider.capabilities.platforms).toEqual({ lazada: MARKETPLACE_PLATFORM_LIMITS.lazada });
  });

  it('refuses a platform that is not Lazada', async () => {
    const { provider } = setup([]);
    expect(await kind(() => provider.listOrders(SECRET, 'shopee', null))).toBe('unreachable');
  });
});

describe('listOrders', () => {
  const two = [
    fakeOrder({ id: '1000000000000001', number: '9101000001', updatedAt: '2026-11-09T10:00:00+07:00', createdAt: '2026-11-08T09:00:00+07:00' }, [{ id: '2000000000000001' }, { id: '2000000000000002', paidPrice: '65000.00', itemPrice: '66000.00', sku: null, name: 'Túi vải mẫu' }]),
    // One order whose items are in different states: each keeps its own.
    fakeOrder({ id: '1000000000000002', number: '9101000002', updatedAt: '2026-11-09T11:00:00+07:00', createdAt: '2026-11-08T10:00:00+07:00' }, [{ id: '2000000000000003', status: 'returned' }, { id: '2000000000000004', status: 'shipped' }]),
  ];

  it('starts 30 days back on the first read, signs every call, and answers one port line for each item', async () => {
    const { provider, fake } = setup(two);
    const page = await provider.listOrders(SECRET, 'lazada', null);
    const first = fake.calls[0];
    expect(first?.path).toBe('/orders/get');
    expect(first?.params.update_after).toBe(lazadaStamp(NOW - 30 * 86_400_000));
    expect(first?.params).toMatchObject({ sort_by: 'updated_at', sort_direction: 'ASC', limit: '100', offset: '0', app_key: '123456', sign_method: 'sha256' });
    expect(page.orders.map((o) => [o.orderNo, o.stage, o.lines.map((l) => l.lineKey)])).toEqual([
      ['9101000001', 'completed', ['2000000000000001', '2000000000000002']],
      ['9101000002', 'returned', ['2000000000000003']],
      ['9101000002', 'shipped', ['2000000000000004']],
    ]);
    const line = page.orders[0]?.lines[1];
    // One unit each, the item's own price and paid price as decimal strings, an empty SKU as none, no delivery or shipping day invented.
    expect(line).toEqual({ lineKey: '2000000000000002', sku: null, itemName: 'Túi vải mẫu', quantity: '1', unitPrice: '66000.00', amount: '65000.00' });
    expect(page.orders[0]).toMatchObject({ orderedAt: '2026-11-08', shippedAt: null, deliveredAt: null });
    // The page is one the port's own check takes, and the report writes one row for each unit, with the head row and the connection row.
    expect(parseMarketplaceOrderPage(page)).not.toBeNull();
    expect(marketplaceOrdersCsv('lazada', page.orders, 'c1').trimEnd().split('\n')).toHaveLength(2 + 4);
  });

  it('keeps an item id past 2^53 exactly (a JSON parse would turn it into another id)', async () => {
    const { provider } = setup([fakeOrder({ id: '1234567890123456789', number: '9101000003' }, [{ id: '9007199254740993' }])]);
    const page = await provider.listOrders(SECRET, 'lazada', null);
    expect(page.orders[0]?.lines[0]?.lineKey).toBe('9007199254740993');
  });

  it('is deterministic: the same window gives the same page, byte for byte, so the intake recognises it', async () => {
    const a = await setup(two).provider.listOrders(SECRET, 'lazada', null);
    const b = await setup([...two].reverse()).provider.listOrders(SECRET, 'lazada', null);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('never lets a buyer\'s data through: not into a type, and not into the report', async () => {
    const { provider } = setup(two);
    const page = await provider.listOrders(SECRET, 'lazada', null);
    const everything = JSON.stringify(page) + marketplaceOrdersCsv('lazada', page.orders, 'c1');
    for (const secret of ['Nguyễn', 'Hà Nội', '0912345678', 'Phố Thử', '100200300', '079099123456', 'giao giờ', '0109876543', 'LZVN000000', 'customer_', 'address', 'buyer']) expect(everything).not.toContain(secret);
  });

  it('calls only the two read paths, by GET, one at a time, spaced a second apart', async () => {
    const { provider, fake, waits } = setup(two);
    await provider.listOrders(SECRET, 'lazada', null);
    expect(fake.calls.map((c) => `${c.method} ${c.host} ${c.path}`)).toEqual(['GET api.lazada.vn /orders/get', 'GET api.lazada.vn /orders/items/get']);
    expect(fake.calls[1]?.params.order_ids).toBe('[1000000000000001,1000000000000002]');
    expect(waits).toEqual([1000]);
  });

  it('says nothing is new, and keeps the cursor it was given', async () => {
    const { provider } = setup([]);
    expect(await provider.listOrders(SECRET, 'lazada', null)).toEqual({ orders: [], nextCursor: null });
    expect(await provider.listOrders(SECRET, 'lazada', 'u:2026-11-09T03:00:00.000Z')).toEqual({ orders: [], nextCursor: 'u:2026-11-09T03:00:00.000Z' });
  });

  it('resumes a little before the newest order, never earlier than the window it read, and reads the same page again for nothing new', async () => {
    const { provider, fake } = setup(two);
    const first = await provider.listOrders(SECRET, 'lazada', null);
    // The newest order was updated 2026-11-09T11:00:00+07:00 = 04:00Z; ten minutes before.
    expect(first.nextCursor).toBe('u:2026-11-09T03:50:00.000Z');
    const again = await provider.listOrders(SECRET, 'lazada', first.nextCursor);
    expect(fake.calls.filter((c) => c.path === '/orders/get')[1]?.params.update_after).toBe('2026-11-09T10:50:00+07:00');
    // Only the second order is inside the overlap, and the cursor does not move back or forward.
    expect(again.orders.map((o) => o.orderNo)).toEqual(['9101000002', '9101000002']);
    expect(again.nextCursor).toBe(first.nextCursor);
  });

  it('pages a full window by moving it forward, never by an offset: every read is offset 0, a full page resumes a second before its newest order, a short page ten minutes before it', async () => {
    const many = Array.from({ length: 230 }, (_, i) =>
      fakeOrder({ id: String(3000000000000000 + i), number: `91020${String(i).padStart(5, '0')}`, updatedAt: `2026-11-09T${String(Math.floor(i / 60) + 6).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00+07:00` }, [{ id: String(4000000000000000 + i) }]),
    );
    const { provider, fake } = setup(many);
    const seen = new Set<string>();
    let cursor: string | null = null;
    const sizes: number[] = [];
    for (let poll = 0; poll < 4; poll += 1) {
      const page: Awaited<ReturnType<typeof provider.listOrders>> = await provider.listOrders(SECRET, 'lazada', cursor);
      sizes.push(page.orders.length);
      for (const o of page.orders) seen.add(o.orderNo);
      cursor = page.nextCursor;
    }
    // Every order is read, whatever the overlap repeats, and no call ever asked for an offset.
    expect(seen.size).toBe(230);
    expect(sizes[0]).toBe(100);
    expect(fake.calls.filter((c) => c.path === '/orders/get').every((c) => c.params.offset === '0')).toBe(true);
    // The first full page ends at the 100th order by update time, 07:39:00 +07:00; the window resumes a second before it.
    const calls = fake.calls.filter((c) => c.path === '/orders/get');
    expect(calls[1]?.params.update_after).toBe('2026-11-09T07:38:59+07:00');
  });

  it('does not skip an order that Lazada updates between two pages (the list shifts, the window does not)', async () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      fakeOrder({ id: String(7000000000000000 + i), number: `91030${String(i).padStart(5, '0')}`, updatedAt: `2026-11-09T${String(Math.floor(i / 60) + 6).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00+07:00` }, [{ id: String(8000000000000000 + i) }]),
    );
    const { provider } = setup(many);
    const p1 = await provider.listOrders(SECRET, 'lazada', null);
    expect(p1.orders).toHaveLength(100);
    // Order 0, already read, is updated before the next page: it moves to the end of the list.
    many[0]!.updatedAt = '2026-11-09T12:00:00+07:00';
    const p2 = await provider.listOrders(SECRET, 'lazada', p1.nextCursor);
    const names = new Set([...p1.orders, ...p2.orders].map((o) => o.orderNo));
    expect(names.size).toBe(150);
  });

  it('drains a window that cannot move (a hundred orders updated within a second of its start) by offset, and reads every order', async () => {
    const same = Array.from({ length: 120 }, (_, i) => fakeOrder({ id: String(5000000000000000 + i), number: `9103${String(i).padStart(6, '0')}`, updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: String(6000000000000000 + i) }]));
    const { provider, fake } = setup(same);
    const first = await provider.listOrders(SECRET, 'lazada', 'u:2026-11-09T03:00:00.000Z');
    expect(first.orders).toHaveLength(100);
    // The window cannot move, so the same window is continued by offset.
    // ... a little back from the end of the page (25 positions), so an order updated in between cannot make an unread one slip past.
    expect(first.nextCursor).toBe('u:2026-11-09T03:00:00.000Z:75');
    const second = await provider.listOrders(SECRET, 'lazada', first.nextCursor);
    expect(second.orders).toHaveLength(45);
    expect(fake.calls.filter((c) => c.path === '/orders/get').map((c) => c.params.offset)).toEqual(['0', '75']);
    expect(new Set([...first.orders, ...second.orders].map((o) => o.orderNo)).size).toBe(120);
    // Read to its end: the cursor leaves the offset and moves on.
    expect(second.nextCursor).toBe('u:2026-11-09T03:00:00.000Z');
  });

  it('does not skip an unread order when an order already read is updated between two pages of a window that cannot move', async () => {
    const same = Array.from({ length: 120 }, (_, i) => fakeOrder({ id: String(1500000000000000 + i), number: `9113${String(i).padStart(6, '0')}`, updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: String(1600000000000000 + i) }]));
    const { provider } = setup(same);
    const first = await provider.listOrders(SECRET, 'lazada', 'u:2026-11-09T03:00:00.000Z');
    // Three orders already read are updated before the next page: they move to the end of the list and the unread ones shift up by three.
    const [a, b, c] = [same[0]!, same[1]!, same[2]!];
    for (const o of [a, b, c]) o.updatedAt = '2026-11-09T12:00:00+07:00';
    const second = await provider.listOrders(SECRET, 'lazada', first.nextCursor);
    const seen = new Set([...first.orders, ...second.orders].map((o) => o.orderNo));
    expect(seen.size).toBe(120);
  });

  it('reads the last order after a full page that spans two adjacent seconds (50 at one second, 50 at the next, one after)', async () => {
    const at = (second: number, i: number) => fakeOrder({ id: String(1300000000000000 + i), number: `9112${String(i).padStart(6, '0')}`, updatedAt: `2026-11-09T10:00:0${second}+07:00` }, [{ id: String(1400000000000000 + i) }]);
    const orders = [...Array.from({ length: 50 }, (_, i) => at(0, i)), ...Array.from({ length: 50 }, (_, i) => at(1, 50 + i)), at(2, 100)];
    const { provider } = setup(orders);
    const seen = new Set<string>();
    let cursor: string | null = 'u:2026-11-09T03:00:00.000Z';
    for (let poll = 0; poll < 3 && !seen.has('9112000100'); poll += 1) {
      const page: Awaited<ReturnType<typeof provider.listOrders>> = await provider.listOrders(SECRET, 'lazada', cursor);
      for (const o of page.orders) seen.add(o.orderNo);
      cursor = page.nextCursor;
    }
    expect(seen.has('9112000100')).toBe(true);
    expect(seen.size).toBe(101);
  });

  it('shows a window of more than 5000 orders within one second as not_recognized, at Lazada\'s offset limit, never skipping them silently', async () => {
    const many = Array.from({ length: 5100 }, (_, i) => fakeOrder({ id: String(5000000000000000 + i), number: `9103${String(i).padStart(6, '0')}`, updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: String(6000000000000000 + i) }]));
    const { provider } = setup(many);
    expect(await kind(() => provider.listOrders(SECRET, 'lazada', 'u:2026-11-09T03:00:00.000Z:4950'))).toBe('not_recognized');
    // Below the limit it still reads.
    expect((await provider.listOrders(SECRET, 'lazada', 'u:2026-11-09T03:00:00.000Z:4800')).nextCursor).toBe('u:2026-11-09T03:00:00.000Z:4875');
  });

  it('answers a full page of orders whose items are in two states as more port orders than a page, and the poll job takes it (the limit is on orders)', async () => {
    const mixed = Array.from({ length: 100 }, (_, i) =>
      fakeOrder({ id: String(1100000000000000 + i), number: `91040${String(i).padStart(5, '0')}`, updatedAt: `2026-11-09T${String(Math.floor(i / 60) + 6).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00+07:00` }, [
        { id: String(1200000000000000 + 2 * i), status: 'delivered' },
        { id: String(1200000000000000 + 2 * i + 1), status: 'returned' },
      ]),
    );
    const page = await setup(mixed).provider.listOrders(SECRET, 'lazada', null);
    expect(page.orders).toHaveLength(200);
    expect(new Set(page.orders.map((o) => o.orderNo)).size).toBe(100);
    expect(parseMarketplaceOrderPage(page)).not.toBeNull();
  });

  it('never reads a window older than the platform\'s 30 days, whatever cursor it is given', async () => {
    const { provider, fake } = setup(two);
    await provider.listOrders(SECRET, 'lazada', 'u:2020-01-01T00:00:00.000Z');
    expect(fake.calls[0]?.params.update_after).toBe(lazadaStamp(NOW - 30 * 86_400_000));
  });

  it('treats an unreadable cursor as no cursor', async () => {
    const { provider, fake } = setup(two);
    await provider.listOrders(SECRET, 'lazada', 'sandbox:3');
    expect(fake.calls[0]?.params.update_after).toBe(lazadaStamp(NOW - 30 * 86_400_000));
  });
});

describe('the closed status table', () => {
  // The expected mapping is this test's own table, not the adapter's: a change to the adapter's table that is not meant must fail here.
  const EXPECTED: Array<[string, string]> = [
    ['unpaid', 'placed'], ['pending', 'placed'], ['topack', 'placed'],
    ['ready_to_ship', 'shipped'], ['toship', 'shipped'], ['packed', 'shipped'], ['shipped', 'shipped'], ['shipping', 'shipped'],
    ['delivered', 'completed'],
    ['canceled', 'cancelled'], ['failed', 'cancelled'], ['lost', 'cancelled'],
    ['returned', 'returned'],
  ];

  it('is exactly the expected table', () => {
    expect(Object.entries(LAZADA_ITEM_STAGE).sort()).toEqual([...EXPECTED].sort());
  });

  it.each(EXPECTED)('maps %s to %s', async (status, stage) => {
    const { provider } = setup([fakeOrder({ id: '1', number: '9104000001', updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: '2', status }])]);
    expect((await provider.listOrders(SECRET, 'lazada', null)).orders[0]?.stage).toBe(stage);
  });

  it('is case-insensitive, and an unknown status makes the page not_recognized', async () => {
    const upper = setup([fakeOrder({ id: '1', number: '9104000001', updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: '2', status: 'Delivered' }])]);
    expect((await upper.provider.listOrders(SECRET, 'lazada', null)).orders[0]?.stage).toBe('completed');
    const odd = setup([fakeOrder({ id: '1', number: '9104000001', updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: '2', status: 'package_scrapped' }])]);
    expect(await kind(() => odd.provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
  });
});

describe('a page the adapter will not store', () => {
  const base = (items: Array<Partial<FakeOrder['items'][number]> & { id: string }>, over: Partial<FakeOrder> = {}) => [fakeOrder({ id: '1', number: '9105000001', updatedAt: '2026-11-09T10:00:00+07:00', ...over }, items)];

  it('refuses a masked order number or SKU, and an amount that is not a decimal string', async () => {
    for (const orders of [
      base([{ id: '2' }], { number: '91***0001' }),
      base([{ id: '2', sku: 'MA***01' }]),
      base([{ id: '2', paidPrice: '1e5' }]),
      base([{ id: '2', paidPrice: '140,000' }]),
      base([{ id: '2', paidPrice: '140000.12345' }]),
      base([{ id: '2', paidPrice: '' }]),
      base([{ id: '2', itemPrice: 'NaN' }]),
    ]) {
      expect(await kind(() => setup(orders).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
    }
  });

  it('refuses an amount written as a JSON number, an item of another order, a currency that is not dong and an order with no item', async () => {
    const asNumber = (path: string, params: Record<string, string>): Response | undefined => {
      void params;
      if (path !== '/orders/items/get') return undefined;
      return new Response(JSON.stringify({ code: '0', data: [{ order_id: 1, order_items: [{ order_item_id: 2, order_id: 1, sku: 'A', name: 'a', item_price: 150000, paid_price: 140000, status: 'delivered' }] }] }));
    };
    expect(await kind(() => setup(base([{ id: '2' }]), { intercept: asNumber }).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
    const otherOrder = (path: string): Response | undefined => (path === '/orders/items/get' ? new Response(JSON.stringify({ code: '0', data: [{ order_id: 1, order_items: [{ order_item_id: 2, order_id: 9, sku: 'A', name: 'a', item_price: '1', paid_price: '1', status: 'delivered' }] }] })) : undefined);
    expect(await kind(() => setup(base([{ id: '2' }]), { intercept: otherOrder }).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
    const usd = (path: string): Response | undefined => (path === '/orders/items/get' ? new Response(JSON.stringify({ code: '0', data: [{ order_id: 1, order_items: [{ order_item_id: 2, order_id: 1, sku: 'A', name: 'a', item_price: '1', paid_price: '1', status: 'delivered', currency: 'USD' }] }] })) : undefined);
    expect(await kind(() => setup(base([{ id: '2' }]), { intercept: usd }).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
    const none = (path: string): Response | undefined => (path === '/orders/items/get' ? new Response(JSON.stringify({ code: '0', data: [] })) : undefined);
    expect(await kind(() => setup(base([{ id: '2' }]), { intercept: none }).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
  });

  it('refuses an order with an unreadable time or a page larger than a page, whatever the fake would send', async () => {
    const badTime = (path: string): Response | undefined => (path === '/orders/get' ? new Response(JSON.stringify({ code: '0', data: { orders: [{ order_id: '1', order_number: '91', created_at: 'soon', updated_at: '2026-11-09T10:00:00+07:00' }] } })) : undefined);
    expect(await kind(() => setup([]).provider.listOrders(SECRET, 'lazada', null).then(() => setup([], { intercept: badTime }).provider.listOrders(SECRET, 'lazada', null)))).toBe('not_recognized');
    const huge = (path: string): Response | undefined =>
      path === '/orders/get'
        ? new Response(JSON.stringify({ code: '0', data: { orders: Array.from({ length: 101 }, (_, i) => ({ order_id: String(i + 1), order_number: `91${i}`, created_at: '2026-11-09T10:00:00+07:00', updated_at: '2026-11-09T10:00:00+07:00' })) } }))
        : undefined;
    expect(await kind(() => setup([], { intercept: huge }).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
  });
});

describe('ids and days a hostile answer could bend', () => {
  it('refuses an id that is not only digits (it is written into the list an items call is asked for), and an id or an item twice in one answer', async () => {
    const order = (id: string) => fakeOrder({ id, number: '9107000001', updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: '2' }]);
    for (const id of ['1,2', '1]', '12 3', '-5', '1e3', 'abc']) {
      const asOrder = (path: string): Response | undefined =>
        path === '/orders/get' ? new Response(JSON.stringify({ code: '0', data: { orders: [{ order_id: id, order_number: '91', created_at: '2026-11-09T10:00:00+07:00', updated_at: '2026-11-09T10:00:00+07:00' }] } })) : undefined;
      expect(await kind(() => setup([order('1')], { intercept: asOrder }).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
    }
    const twice = (path: string): Response | undefined => {
      const entry = { order_id: '1', order_number: '91', created_at: '2026-11-09T10:00:00+07:00', updated_at: '2026-11-09T10:00:00+07:00' };
      return path === '/orders/get' ? new Response(JSON.stringify({ code: '0', data: { orders: [entry, entry] } })) : undefined;
    };
    expect(await kind(() => setup([order('1')], { intercept: twice }).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
    const sameItem = (path: string): Response | undefined => {
      const item = { order_item_id: '2', order_id: '1', sku: 'A', name: 'a', item_price: '1', paid_price: '1', status: 'delivered' };
      return path === '/orders/items/get' ? new Response(JSON.stringify({ code: '0', data: [{ order_id: '1', order_items: [item, item] }] })) : undefined;
    };
    expect(await kind(() => setup([order('1')], { intercept: sameItem }).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
  });

  it('takes the order day in Vietnam, whatever offset the time is written in', async () => {
    // 2026-11-08 23:30 at +08:00 is 22:30 in Vietnam, still the 8th; 2026-11-09 00:30 at +08:00 is 23:30 on the 8th in Vietnam.
    const orders = [
      fakeOrder({ id: '1', number: '9108000001', createdAt: '2026-11-09T00:30:00+08:00', updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: '2' }]),
      fakeOrder({ id: '3', number: '9108000002', createdAt: '2026-11-08T23:30:00+08:00', updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: '4' }]),
      fakeOrder({ id: '5', number: '9108000003', createdAt: '2026-11-08T18:00:00-05:00', updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: '6' }]),
    ];
    const page = await setup(orders).provider.listOrders(SECRET, 'lazada', null);
    expect(page.orders.map((o) => [o.orderNo, o.orderedAt])).toEqual([['9108000001', '2026-11-08'], ['9108000002', '2026-11-08'], ['9108000003', '2026-11-09']]);
  });

  it('keeps an unquoted id past 2^53 as its digits, and refuses the same number as an amount (money is never a number)', async () => {
    const big = '9007199254740993';
    const asId = (path: string): Response | undefined =>
      path === '/orders/items/get'
        ? new Response(`{"code":"0","data":[{"order_id":1,"order_items":[{"order_item_id":${big},"order_id":1,"sku":"A","name":"a","item_price":"1","paid_price":"1","status":"delivered"}]}]}`)
        : undefined;
    const page = await setup([fakeOrder({ id: '1', number: '9111000001', updatedAt: '2026-11-09T10:00:00+07:00' })], { intercept: asId }).provider.listOrders(SECRET, 'lazada', null);
    expect(page.orders[0]?.lines[0]?.lineKey).toBe(big);
    for (const field of ['paid_price', 'item_price']) {
      const asAmount = (path: string): Response | undefined =>
        path === '/orders/items/get'
          ? new Response(`{"code":"0","data":[{"order_id":1,"order_items":[{"order_item_id":2,"order_id":1,"sku":"A","name":"a","item_price":${field === 'item_price' ? big : '"1"'},"paid_price":${field === 'paid_price' ? big : '"1"'},"status":"delivered"}]}]}`)
          : undefined;
      expect(await kind(() => setup([fakeOrder({ id: '1', number: '9111000001', updatedAt: '2026-11-09T10:00:00+07:00' })], { intercept: asAmount }).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
    }
    // A quoted decimal amount is still taken.
    const quoted = (path: string): Response | undefined =>
      path === '/orders/items/get'
        ? new Response('{"code":"0","data":[{"order_id":1,"order_items":[{"order_item_id":2,"order_id":1,"sku":"A","name":"a","item_price":"9007199254740993.5","paid_price":"1","status":"delivered"}]}]}')
        : undefined;
    expect((await setup([fakeOrder({ id: '1', number: '9111000001', updatedAt: '2026-11-09T10:00:00+07:00' })], { intercept: quoted }).provider.listOrders(SECRET, 'lazada', null)).orders[0]?.lines[0]?.unitPrice).toBe('9007199254740993.5');
  });

  it('keeps an asterisk in a product name (a size, a footnote) and still refuses one in an order number', async () => {
    const page = await setup([fakeOrder({ id: '1', number: '9109000001', updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: '2', name: 'Áo 5* size M' }])]).provider.listOrders(SECRET, 'lazada', null);
    expect(page.orders[0]?.lines[0]?.itemName).toBe('Áo 5* size M');
  });

  it('cuts a long name by characters, never inside one', async () => {
    const name = '😀'.repeat(400);
    const page = await setup([fakeOrder({ id: '1', number: '9110000001', updatedAt: '2026-11-09T10:00:00+07:00' }, [{ id: '2', name }])]).provider.listOrders(SECRET, 'lazada', null);
    expect(Array.from(page.orders[0]!.lines[0]!.itemName)).toHaveLength(300);
    // The same page passes the port's own check, which counts characters too (600 UTF-16 units).
    expect(parseMarketplaceOrderPage(page)).not.toBeNull();
    expect(page.orders[0]!.lines[0]!.itemName).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('an answer that counts orders but carries no list', () => {
  it('is not an empty page: it is not_recognized, while a zero or absent count (or an explicit empty list) is nothing new', async () => {
    const reply = (data: unknown) => (path: string): Response | undefined => (path === '/orders/get' ? new Response(JSON.stringify({ code: '0', data })) : undefined);
    for (const data of [{ countTotal: 3 }, { count: 2 }, { countTotal: '5', count: 0 }]) {
      expect(await kind(() => setup([], { intercept: reply(data) }).provider.listOrders(SECRET, 'lazada', null))).toBe('not_recognized');
    }
    for (const data of [{ countTotal: 0, count: 0 }, {}, { count: 0, orders: [] }]) {
      expect(await setup([], { intercept: reply(data) }).provider.listOrders(SECRET, 'lazada', null)).toEqual({ orders: [], nextCursor: null });
    }
  });
});

describe('a call that fails', () => {
  const orders = [fakeOrder({ id: '1', number: '9106000001', updatedAt: '2026-11-09T10:00:00+07:00' })];

  it('maps a refused token or signature to credentials, a call limit to rate_limited, and anything else to unreachable', async () => {
    expect(await kind(() => setup(orders).provider.listOrders(JSON.stringify({ ...KEY, accessToken: 'expired-token' }), 'lazada', null))).toBe('credentials');
    expect(await kind(() => setup(orders).provider.listOrders(JSON.stringify({ ...KEY, appSecret: 'wrong-secret' }), 'lazada', null))).toBe('credentials');
    for (const code of ['ApiCallLimit', 'AppApiCallLimit', 'E1002']) {
      const throttled = (): Response => new Response(JSON.stringify({ code, type: 'ISV', message: 'call limit' }));
      expect(await kind(() => setup(orders, { intercept: throttled }).provider.listOrders(SECRET, 'lazada', null))).toBe('rate_limited');
    }
    expect(await kind(() => setup(orders, { intercept: () => new Response('slow down', { status: 429 }) }).provider.listOrders(SECRET, 'lazada', null))).toBe('rate_limited');
    expect(await kind(() => setup(orders, { intercept: () => new Response('no', { status: 403 }) }).provider.listOrders(SECRET, 'lazada', null))).toBe('credentials');
    expect(await kind(() => setup(orders, { intercept: () => new Response('boom', { status: 500 }) }).provider.listOrders(SECRET, 'lazada', null))).toBe('unreachable');
    expect(await kind(() => setup(orders, { intercept: () => new Response('<html>not json</html>') }).provider.listOrders(SECRET, 'lazada', null))).toBe('unreachable');
    expect(await kind(() => setup(orders, { intercept: () => new Response(JSON.stringify({ code: 'SomethingNew', message: 'secret text' })) }).provider.listOrders(SECRET, 'lazada', null))).toBe('unreachable');
  });

  it('reads no more than a bounded answer: by its declared length, by what it streams, and by what it holds when it declares nothing', async () => {
    const big = () => new Response('x', { headers: { 'content-length': '999999999' } });
    expect(await kind(() => setup(orders, { intercept: big }).provider.listOrders(SECRET, 'lazada', null))).toBe('unreachable');
    // No declared length: a stream of 5 MB in 1 MB pieces is cut at the cap.
    const chunk = new Uint8Array(1_000_000).fill(120);
    let sent = 0;
    const streamed = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            sent += 1;
            if (sent > 20) controller.close();
            else controller.enqueue(chunk);
          },
        }),
      );
    expect(await kind(() => setup(orders, { intercept: streamed }).provider.listOrders(SECRET, 'lazada', null))).toBe('unreachable');
    expect(sent).toBeLessThan(10);
  });

  it('starts the calls of one app a second apart even when they are all asked at once and the clock moves only when the adapter sleeps', async () => {
    const { fake } = setup(orders);
    let clock = NOW;
    const provider = lazadaMarketplace({ fetch: fake.fetch, now: () => new Date(clock), sleep: async (ms) => void (clock += ms) });
    await Promise.all([provider.testConnection(SECRET), provider.testConnection(SECRET), provider.testConnection(SECRET)]);
    const stamps = fake.calls.map((c) => Number(c.params.timestamp));
    expect(stamps).toEqual([NOW, NOW + 1000, NOW + 2000]);
  });

  it('keeps going after a call that failed: the next one is not held back', async () => {
    const { fake } = setup(orders);
    let clock = NOW;
    const provider = lazadaMarketplace({ fetch: async () => Promise.reject(new Error('down')), now: () => new Date(clock), sleep: async (ms) => void (clock += ms) });
    expect(await provider.testConnection(SECRET)).toBe('unreachable');
    expect(await provider.testConnection(SECRET)).toBe('unreachable');
    expect(fake.calls).toHaveLength(0);
    expect(clock).toBe(NOW + 1000);
  });

  it('releases the body of an answer it refuses by status', async () => {
    let cancelled = false;
    const refusedBody = () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      );
    expect(await kind(() => setup(orders, { intercept: refusedBody }).provider.listOrders(SECRET, 'lazada', null))).toBe('unreachable');
    expect(cancelled).toBe(true);
  });

  it('spaces the calls of one app from each other and does not hold one app up for another', async () => {
    const { fake } = setup(orders);
    const waits: number[] = [];
    const provider = lazadaMarketplace({ fetch: fake.fetch, now: () => new Date(NOW), sleep: async (ms) => void waits.push(ms) });
    const other = { ...KEY, appKey: '999999' };
    // The fake knows one key, so the second app's calls are refused as credentials; what matters is when it is made.
    await provider.testConnection(SECRET);
    await provider.testConnection(SECRET);
    await provider.testConnection(JSON.stringify(other));
    expect(waits).toEqual([1000]);
  });

  it('does not carry Lazada\'s text or the credential in its error', async () => {
    try {
      await setup(orders, { intercept: () => new Response(JSON.stringify({ code: 'IllegalAccessToken', message: 'token 50000000001abcDEF is bad' })) }).provider.listOrders(SECRET, 'lazada', null);
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toMatch(/50000000001|helloworld|bad/);
    }
  });

  it('turns a network failure into unreachable', async () => {
    const provider = lazadaMarketplace({ fetch: async () => Promise.reject(new Error('ECONNRESET https://api.lazada.vn/rest?access_token=x')), now: () => new Date(NOW), sleep: async () => undefined });
    expect(await kind(() => provider.listOrders(SECRET, 'lazada', null))).toBe('unreachable');
  });
});

describe('testConnection', () => {
  it('works with a good key, and names the refusal of a bad one without raising it', async () => {
    expect(await setup([]).provider.testConnection(SECRET)).toBe('works');
    expect(await setup([]).provider.testConnection(JSON.stringify({ ...KEY, accessToken: 'bad-token' }))).toBe('wrong_credentials');
    expect(await setup([]).provider.testConnection('garbage')).toBe('wrong_credentials');
    expect(await setup([], { intercept: () => new Response('down', { status: 503 }) }).provider.testConnection(SECRET)).toBe('unreachable');
  });

  it('asks for one order from the last day, and nothing else', async () => {
    const { provider, fake } = setup([]);
    await provider.testConnection(SECRET);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.params).toMatchObject({ limit: '1', offset: '0', created_after: lazadaStamp(NOW - 86_400_000) });
  });
});

describe('what the adapter is allowed to reach', () => {
  const source = readFileSync(new URL('../src/marketplace-lazada.ts', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');

  it('names exactly two API paths, both read paths, as the only values the one request function is ever given', () => {
    const constants = [...code.matchAll(/const (\w+_PATH) = '([^']+)'/g)].map((m) => [m[1], m[2]]);
    expect(constants).toEqual([['ORDERS_PATH', '/orders/get'], ['ITEMS_PATH', '/orders/items/get']]);
    // No other string in the file looks like an API path.
    const slashed = [...code.matchAll(/'(\/[A-Za-z0-9_/.-]*)'/g)].map((m) => m[1]);
    expect([...new Set(slashed)].sort()).toEqual(['/orders/get', '/orders/items/get']);
    // Every call of the one request function names one of the two constants, never a literal or a computed path.
    const calls = [...code.matchAll(/\bcall\(credential, ([^,)]*)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c === 'ORDERS_PATH' || c === 'ITEMS_PATH')).toBe(true);
    expect([...code.matchAll(/\b(?:readOrders|readItems)\(/g)]).not.toHaveLength(0);
  });

  it('has exactly one request site, an explicit GET to the one host through the fetch it is given', () => {
    const sites = [...code.matchAll(/options\.fetch\(([^;]*)\);/g)].map((m) => m[1] ?? '');
    expect(sites).toHaveLength(1);
    expect(sites[0]).toContain("method: 'GET'");
    expect(sites[0]).toContain('https://${LAZADA_API_HOST}/rest${path}?');
    expect(code).not.toMatch(/(?<![\w])method:\s*'(?!GET')/i);
    expect(code).not.toMatch(/\bglobalThis\.fetch\b|[^.\w]fetch\(|node:https?|undici|XMLHttpRequest|WebSocket/);
    expect(code).not.toMatch(/\/(product|order\/(cancel|reverse|status)|reverse|fulfillment|finance)\//);
    expect(LAZADA_HOSTS).toEqual(['api.lazada.vn']);
  });
});

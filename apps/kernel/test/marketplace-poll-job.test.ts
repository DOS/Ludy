// SPDX-License-Identifier: AGPL-3.0-only
// The worker's poll of a marketplace connection, on a stub runtime (#2840 points 1 and 2, #4237): the page a provider returns is checked before anything of it is used, so a field the port does not name,
// a malformed amount or a masked-looking value ends as the state `not_recognized` with the cursor where it was and nothing written; the rows of a page are counted before any is built, so a few lines with
// huge quantities end as `too_large`; a provider's own text never reaches the log. The real database path is in marketplace-connection.db.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { EXTRACT_LIMITS } from '@crove/extract-contract';
import { MARKETPLACE_CSV_MAX_ROWS, MarketplaceProviderError, type MarketplaceOrderPage, type MarketplaceProvider } from '@crove/mod-finance';
import { sha256Hex, type BlobStore, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { LAZADA_HOSTS, lazadaMarketplace } from '../src/marketplace-lazada.ts';
import { runMarketplacePoll } from '../src/marketplace-poll-job.ts';
import { fakeLazada, fakeOrder } from './fake-lazada.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const goodPage = (): MarketplaceOrderPage => ({
  orders: [{ orderNo: '9101000001', orderedAt: '2026-11-02', shippedAt: null, deliveredAt: null, stage: 'placed', lines: [{ lineKey: '9101000001-1', sku: 'MAU-001', itemName: 'Áo', quantity: '1', unitPrice: '150000', amount: '150000' }] }],
  nextCursor: 'sandbox:1',
});

function setup(listOrders: () => Promise<unknown>, platform: 'lazada' | 'shopee' = 'shopee', ingestFails = false) {
  const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const puts: string[] = [];
  const runtime = {
    query: async () => ({ action: 'poll', id: CONNECTION, channelConnectionId: '33333333-3333-4333-8333-333333333333', adapter: 'sandbox', platform, legalEntityId: '44444444-4444-4444-8444-444444444444', cursor: null, lastPollState: null }),
    execute: async (name: string, input: Record<string, unknown>) => {
      executed.push({ name, input });
      if (ingestFails && name === 'finance.marketplace_connection.ingest_page') throw new Error('the page could not be filed');
      return name === 'finance.marketplace_connection.ingest_page' ? { fileId: '55555555-5555-4555-8555-555555555555', duplicate: false } : {};
    },
  } as unknown as Runtime;
  const store = {
    put: async (key: string, bytes: Uint8Array) => {
      puts.push(key);
      return `content:${sha256Hex(bytes)}`;
    },
  } as unknown as BlobStore;
  const provider = { id: 'sandbox', hosts: [], connectFields: [], capabilities: { platforms: {} }, listOrders, testConnection: async () => 'works', orderFinance: async () => null, listStock: async () => [] } as unknown as MarketplaceProvider;
  const deps = { runtime, broker: {} as CredentialBroker, store, providers: { sandbox: provider } };
  const run = () => runMarketplacePoll(deps, { orgId: ORG, connectionId: CONNECTION });
  const polls = () => executed.filter((e) => e.name === 'finance.marketplace_connection.record_poll').map((e) => e.input);
  const ingests = () => executed.filter((e) => e.name === 'finance.marketplace_connection.ingest_page');
  return { run, polls, ingests, puts };
}

describe('the page is checked before anything of it is used (#2840 point 2)', () => {
  const refused = async (page: unknown) => {
    const { run, polls, ingests, puts } = setup(async () => page);
    const outcome = await run();
    expect(outcome).toEqual({ state: 'not_recognized', orders: 0, staged: false });
    // The state is recorded, with no cursor: it stays where it was. Nothing is stored and nothing is ingested.
    expect(polls()).toEqual([{ id: CONNECTION, state: 'not_recognized' }]);
    expect(ingests()).toHaveLength(0);
    expect(puts).toHaveLength(0);
  };

  it('files a page through the link command with the connection and no entity or source of its own, and keeps the cursor when the command fails (#4250)', async () => {
    const { run, polls, ingests } = setup(async () => goodPage());
    await run();
    const input = ingests()[0]?.input ?? {};
    expect(input).toMatchObject({ marketplaceConnectionId: CONNECTION, contentType: 'text/csv' });
    expect(Object.keys(input)).not.toContain('legalEntityId');
    expect(Object.keys(input)).not.toContain('source');
    const failing = setup(async () => goodPage(), 'shopee', true);
    await expect(failing.run()).rejects.toThrow();
    // The cursor moves only after the page was filed: nothing is recorded when the command throws.
    expect(failing.polls()).toEqual([]);
  });

  it('takes a good page and stages it once', async () => {
    const { run, polls, ingests } = setup(async () => goodPage());
    expect(await run()).toEqual({ state: 'ok', orders: 1, staged: true });
    expect(ingests()).toHaveLength(1);
    expect(polls()).toEqual([{ id: CONNECTION, state: 'ok', cursor: 'sandbox:1' }]);
  });

  it('refuses a buyer\'s data riding along, a malformed quantity, a number for an amount and a day that does not exist', async () => {
    const order = goodPage().orders[0]!;
    await refused({ orders: [{ ...order, customerName: 'Nguyễn Văn A' }], nextCursor: null });
    await refused({ orders: [{ ...order, lines: [{ ...order.lines[0]!, quantity: 'abc' }] }], nextCursor: null });
    await refused({ orders: [{ ...order, lines: [{ ...order.lines[0]!, amount: 150000 }] }], nextCursor: null });
    await refused({ orders: [{ ...order, orderedAt: '2026-02-30' }], nextCursor: null });
    await refused('not a page');
    await refused(null);
  });

  it('records a failure of the provider as its own kind, and never writes the provider\'s text to the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const raw = setup(async () => {
        throw new Error('GET https://api.example.test/rest?access_token=SECRET-TOKEN failed: 500');
      });
      expect(await raw.run()).toEqual({ state: 'unreachable', orders: 0, staged: false });
      const kinded = setup(async () => {
        throw new MarketplaceProviderError('not_recognized');
      });
      expect(await kinded.run()).toEqual({ state: 'not_recognized', orders: 0, staged: false });
      expect(kinded.polls()).toEqual([{ id: CONNECTION, state: 'not_recognized' }]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-TOKEN');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the page limit is on orders, not on port orders', () => {
  const order = (n: number, stage: 'completed' | 'returned') => ({ orderNo: `91${String(n).padStart(8, '0')}`, orderedAt: '2026-11-02', shippedAt: null, deliveredAt: null, stage, lines: [{ lineKey: `${n}-${stage}`, sku: 'MAU-001', itemName: 'Áo', quantity: '1', unitPrice: '150000', amount: '150000' }] });

  it('takes 100 orders that each answer as two port orders (an order whose items are in two states), and refuses 101 orders', async () => {
    const hundred: MarketplaceOrderPage = { orders: Array.from({ length: 100 }, (_, n) => [order(n, 'completed'), order(n, 'returned')]).flat(), nextCursor: 'u:2026-11-09T03:00:00.000Z' };
    const ok = setup(async () => hundred, 'lazada');
    expect(await ok.run()).toEqual({ state: 'ok', orders: 200, staged: true });
    const many: MarketplaceOrderPage = { orders: Array.from({ length: 101 }, (_, n) => order(n, 'completed')), nextCursor: 'u:2026-11-09T03:00:00.000Z' };
    const refused = setup(async () => many, 'lazada');
    expect(await refused.run()).toEqual({ state: 'too_large', orders: 101, staged: false });
    expect(refused.ingests()).toHaveLength(0);
  });
});

describe('the real Lazada adapter through the job', () => {
  it('stages a full page of orders whose items are in two states (200 port orders for 100 orders), with the fake Lazada behind the adapter', async () => {
    const key = { appKey: '123456', appSecret: 'helloworld', accessToken: '50000000001abcDEF' };
    const mixed = Array.from({ length: 100 }, (_, i) =>
      fakeOrder({ id: String(1100000000000000 + i), number: `91040${String(i).padStart(5, '0')}`, updatedAt: `2026-11-09T${String(Math.floor(i / 60) + 6).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00+07:00` }, [
        { id: String(1200000000000000 + 2 * i), status: 'delivered' },
        { id: String(1200000000000000 + 2 * i + 1), status: 'returned' },
      ]),
    );
    const fake = fakeLazada({ ...key, orders: mixed });
    const lazada = lazadaMarketplace({ fetch: hostBoundFetch(LAZADA_HOSTS, fake.fetch), now: () => new Date('2026-11-10T03:00:00Z'), sleep: async () => undefined });
    // The job opens no credential for a provider with no host, so the secret is given by this wrapper.
    const { run, polls, ingests } = setup(() => lazada.listOrders(JSON.stringify(key), 'lazada', null), 'lazada');
    expect(await run()).toEqual({ state: 'ok', orders: 200, staged: true });
    expect(ingests()).toHaveLength(1);
    expect(polls()).toHaveLength(1);
    expect(polls()[0]).toMatchObject({ state: 'ok' });
  });
});

describe('the rows are counted before any is built (#2840 point 1)', () => {
  it('ends a page of 30 million rows as too_large at once, without building or storing any', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => ({ lineKey: `9101-${i}`, sku: 'MAU-001', itemName: 'Áo', quantity: '100000', unitPrice: '1000', amount: '100000000' }));
    const page: MarketplaceOrderPage = { orders: [{ ...goodPage().orders[0]!, lines }], nextCursor: 'sandbox:1' };
    const { run, polls, ingests, puts } = setup(async () => page, 'lazada');
    expect(await run()).toEqual({ state: 'too_large', orders: 1, staged: false });
    expect(polls()).toEqual([{ id: CONNECTION, state: 'too_large' }]);
    expect(ingests()).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it('stages a page of exactly the row limit and refuses one row over it (the connection row and the head row are not order lines)', async () => {
    const orders = (rows: number) =>
      Array.from({ length: Math.ceil(rows / 500) }, (_, o) => ({
        ...goodPage().orders[0]!,
        orderNo: `9300${String(o).padStart(6, '0')}`,
        lines: Array.from({ length: Math.min(500, rows - o * 500) }, (_, l) => ({ lineKey: `${o}-${l}`, sku: 'MAU-001', itemName: 'Áo', quantity: '1', unitPrice: '1000', amount: '1000' })),
      }));
    const atLimit = setup(async () => ({ orders: orders(MARKETPLACE_CSV_MAX_ROWS), nextCursor: 'sandbox:1' }));
    expect(await atLimit.run()).toMatchObject({ state: 'ok', staged: true });
    expect(atLimit.ingests()).toHaveLength(1);
    const over = setup(async () => ({ orders: orders(MARKETPLACE_CSV_MAX_ROWS + 1), nextCursor: 'sandbox:1' }));
    expect(await over.run()).toMatchObject({ state: 'too_large', staged: false });
    expect(over.ingests()).toHaveLength(0);
  });

  it('keeps the writer\'s row limit equal to the parsing sandbox\'s', () => {
    expect(MARKETPLACE_CSV_MAX_ROWS).toBe(EXTRACT_LIMITS.maxOrderLines);
  });
});

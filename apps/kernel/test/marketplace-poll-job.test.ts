// SPDX-License-Identifier: AGPL-3.0-only
// The worker's poll of a marketplace connection, on a stub runtime (#2840 points 1 and 2, #4237): the page a provider returns is checked before anything of it is used, so a field the port does not name,
// a malformed amount or a masked-looking value ends as the state `not_recognized` with the cursor where it was and nothing written; the rows of a page are counted before any is built, so a few lines with
// huge quantities end as `too_large`; a provider's own text never reaches the log. The real database path is in marketplace-connection.db.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { EXTRACT_LIMITS } from '@crove/extract-contract';
import { MARKETPLACE_CSV_MAX_ROWS, MarketplaceProviderError, type MarketplaceOrderPage, type MarketplaceProvider } from '@crove/mod-finance';
import { sha256Hex, type BlobStore, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { runMarketplacePoll } from '../src/marketplace-poll-job.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const goodPage = (): MarketplaceOrderPage => ({
  orders: [{ orderNo: '9101000001', orderedAt: '2026-11-02', shippedAt: null, deliveredAt: null, stage: 'placed', lines: [{ lineKey: '9101000001-1', sku: 'MAU-001', itemName: 'Áo', quantity: '1', unitPrice: '150000', amount: '150000' }] }],
  nextCursor: 'sandbox:1',
});

function setup(listOrders: () => Promise<unknown>, platform: 'lazada' | 'shopee' = 'shopee') {
  const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const puts: string[] = [];
  const runtime = {
    query: async () => ({ action: 'poll', id: CONNECTION, channelConnectionId: '33333333-3333-4333-8333-333333333333', adapter: 'sandbox', platform, legalEntityId: '44444444-4444-4444-8444-444444444444', cursor: null, lastPollState: null }),
    execute: async (name: string, input: Record<string, unknown>) => {
      executed.push({ name, input });
      return name === 'kernel.file.ingest' ? { fileId: '55555555-5555-4555-8555-555555555555', duplicate: false } : {};
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
  const ingests = () => executed.filter((e) => e.name === 'kernel.file.ingest');
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

describe('the rows are counted before any is built (#2840 point 1)', () => {
  it('ends a page of 30 million rows as too_large at once, without building or storing any', async () => {
    const lines = Array.from({ length: 300 }, (_, i) => ({ lineKey: `9101-${i}`, sku: 'MAU-001', itemName: 'Áo', quantity: '100000', unitPrice: '1000', amount: '100000000' }));
    const page: MarketplaceOrderPage = { orders: [{ ...goodPage().orders[0]!, lines }], nextCursor: 'sandbox:1' };
    const { run, polls, ingests, puts } = setup(async () => page, 'lazada');
    const started = Date.now();
    expect(await run()).toEqual({ state: 'too_large', orders: 1, staged: false });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(polls()).toEqual([{ id: CONNECTION, state: 'too_large' }]);
    expect(ingests()).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it('keeps the writer\'s row limit equal to the parsing sandbox\'s', () => {
    expect(MARKETPLACE_CSV_MAX_ROWS).toBe(EXTRACT_LIMITS.maxOrderLines);
  });
});

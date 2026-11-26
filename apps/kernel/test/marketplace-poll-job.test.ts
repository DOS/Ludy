// SPDX-License-Identifier: AGPL-3.0-only
// The worker's poll of a marketplace connection, on a stub runtime (#2840 points 1 and 2, #4237): the page a provider returns is checked before anything of it is used, so a field the port does not name,
// a malformed amount or a masked-looking value ends as the state `not_recognized` with the cursor where it was and nothing written; the rows of a page are counted before any is built, so a few lines with
// huge quantities end as `too_large`; a provider's own text never reaches the log. The real database path is in marketplace-connection.db.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { EXTRACT_LIMITS } from '@ludy/extract-contract';
import { MARKETPLACE_CSV_MAX_ROWS, MarketplaceProviderError, type MarketplaceOrderPage, type MarketplaceProvider } from '@ludy/mod-finance';
import { sha256Hex, type BlobStore, type CredentialBroker, type Runtime } from '@ludy/kernel-runtime';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { LAZADA_HOSTS, lazadaMarketplace } from '../src/marketplace-lazada.ts';
import { MARKETPLACE_MAX_PAGES_PER_RUN, marketplaceJobKind, runMarketplaceAuthorize, runMarketplacePoll, runMarketplaceTest, zMarketplaceJob } from '../src/marketplace-poll-job.ts';
import { fakeLazada, fakeOrder } from './fake-lazada.ts';
import { TIKTOK_HOSTS } from '../src/marketplace-tiktok.ts';
import { tiktokMarketplace } from '../src/marketplace-tiktok-orders.ts';
import { fakeLine as fakeTiktokLine, fakeOrder as fakeTiktokOrder, fakeReturn as fakeTiktokReturn, fakeTiktok } from './fake-tiktok.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
const goodPage = (): MarketplaceOrderPage => ({
  orders: [{ orderNo: '9101000001', orderedAt: '2026-11-02', shippedAt: null, deliveredAt: null, stage: 'placed', lines: [{ lineKey: '9101000001-1', sku: 'MAU-001', itemName: 'Áo', quantity: '1', unitPrice: '150000', amount: '150000' }] }],
  nextCursor: 'sandbox:1',
});

const TARGET_EXTRAS = { lastIncomePollState: null, lastIncomePolledAt: null, createdAt: '2026-10-01T00:00:00.000Z' } as const;

function setup(listOrders: () => Promise<unknown>, platform: 'lazada' | 'shopee' | 'tiktok_shop' = 'shopee', duplicate = false, ingestFails = false) {
  const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const puts: string[] = [];
  const runtime = {
    query: async () => ({ action: 'poll', id: CONNECTION, channelConnectionId: '33333333-3333-4333-8333-333333333333', adapter: 'sandbox', platform, legalEntityId: '44444444-4444-4444-8444-444444444444', cursor: null, lastPollState: null, lastPolledAt: null, ...TARGET_EXTRAS }),
    execute: async (name: string, input: Record<string, unknown>) => {
      executed.push({ name, input });
      if (ingestFails && name === 'finance.marketplace_connection.ingest_page') throw new Error('the page could not be filed');
      return name === 'finance.marketplace_connection.ingest_page' ? { fileId: '55555555-5555-4555-8555-555555555555', duplicate } : {};
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
  const run = (maxPages?: number) => runMarketplacePoll(deps, { orgId: ORG, connectionId: CONNECTION }, maxPages);
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
    const { run, ingests } = setup(async () => goodPage());
    await run();
    const input = ingests()[0]?.input ?? {};
    expect(input).toMatchObject({ marketplaceConnectionId: CONNECTION, contentType: 'text/csv' });
    expect(Object.keys(input)).not.toContain('legalEntityId');
    expect(Object.keys(input)).not.toContain('source');
    const failing = setup(async () => goodPage(), 'shopee', false, true);
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
    // A full page says more waits behind it; this stub answers the same page again, so one page is asked for here (the loop is tested below).
    expect(await run(1)).toEqual({ state: 'ok', orders: 200, staged: true });
    expect(ingests()).toHaveLength(1);
    expect(polls()).toHaveLength(1);
    expect(polls()[0]).toMatchObject({ state: 'ok' });
  });
});

describe('the real TikTok Shop adapter through the job', () => {
  it('stages a page of orders in two stages and a return, with the fake TikTok behind the adapter, and records a cursor the job accepts', async () => {
    const key = { appKey: '123abc', appSecret: 'helloworld', accessToken: 'TTP_access_token_1' };
    const now = Date.parse('2026-11-21T08:00:00Z');
    const base = Math.floor(now / 1000) - 3600;
    const lineA = fakeTiktokLine({ display_status: 'COMPLETED' });
    const done = fakeTiktokOrder({ status: 'COMPLETED', update_time: base + 10, rts_time: base - 9000, delivery_time: base - 7000, line_items: [lineA, fakeTiktokLine({ display_status: 'COMPLETED' })] });
    const mixed = fakeTiktokOrder({ status: 'PARTIALLY_SHIPPING', update_time: base + 20, line_items: [fakeTiktokLine({ display_status: 'IN_TRANSIT' }), fakeTiktokLine({ display_status: 'AWAITING_SHIPMENT' })] });
    const fake = fakeTiktok({ ...key, now: () => now, orders: [done, mixed], returns: [fakeTiktokReturn({ order_id: done.id, update_time: base + 30, return_line_items: [{ order_line_item_id: lineA.id }] })] });
    const tiktok = tiktokMarketplace({ fetch: hostBoundFetch(TIKTOK_HOSTS, fake.fetch), now: () => new Date(now), sleep: async () => undefined });
    const secret = JSON.stringify({ ...key, shopCipher: 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3', shopId: '7000714532876273420' });
    const { run, polls, ingests } = setup(() => tiktok.listOrders(secret, 'tiktok_shop', null), 'tiktok_shop');
    // The completed order's two units split into a completed line and a returned one; the mixed order into a shipped and a placed one: four port orders.
    expect(await run(1)).toEqual({ state: 'ok', orders: 4, staged: true });
    expect(ingests()).toHaveLength(1);
    expect(polls()).toHaveLength(1);
    expect(polls()[0]).toMatchObject({ state: 'ok', cursor: expect.stringMatching(/^o:.{24};r:.{24}$/) });
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


// A run reads several pages (#4238): each is ingested and its cursor recorded before the next is asked, and a run is bounded.
describe('a run follows a provider that says more waits, up to a cap', () => {
  const pageOf = (n: number, more: boolean): MarketplaceOrderPage => ({
    orders: [{ orderNo: `9102${String(n).padStart(6, '0')}`, orderedAt: '2026-11-02', shippedAt: null, deliveredAt: null, stage: 'placed', lines: [{ lineKey: `9102-${n}`, sku: 'MAU-001', itemName: 'Áo', quantity: '1', unitPrice: '150000', amount: '150000' }] }],
    nextCursor: `p:${n}`,
    more,
  });
  // A provider whose pages are numbered: the cursor `p:n` asks for page n + 1; the last one says nothing more waits.
  const paged = (total: number) => {
    const asked: Array<string | null> = [];
    const listOrders = async (_secret: string, _platform: string, since: string | null) => {
      asked.push(since);
      const n = since === null ? 1 : Number(since.slice(2)) + 1;
      return pageOf(n, n < total);
    };
    return { asked, listOrders: listOrders as unknown as () => Promise<unknown> };
  };

  it('reads every page of a short backlog in one run, recording each cursor after the page was ingested', async () => {
    const { asked, listOrders } = paged(3);
    const job = setup(listOrders as never, 'lazada');
    expect(await job.run()).toEqual({ state: 'ok', orders: 3, staged: true });
    // Each page starts from the cursor the one before recorded.
    expect(asked).toEqual([null, 'p:1', 'p:2']);
    expect(job.ingests()).toHaveLength(3);
    expect(job.polls().map((p) => p.cursor)).toEqual(['p:1', 'p:2', 'p:3']);
  });

  it('stops at the cap, leaving the rest to the next run', async () => {
    const { asked, listOrders } = paged(50);
    const job = setup(listOrders as never, 'lazada');
    expect(await job.run()).toEqual({ state: 'ok', orders: MARKETPLACE_MAX_PAGES_PER_RUN, staged: true });
    expect(asked).toHaveLength(MARKETPLACE_MAX_PAGES_PER_RUN);
    const two = setup(paged(50).listOrders as never, 'lazada');
    expect(await two.run(2)).toEqual({ state: 'ok', orders: 2, staged: true });
    expect(two.ingests()).toHaveLength(2);
    // A cap below one is one page, never none.
    const none = setup(paged(50).listOrders as never, 'lazada');
    expect(await none.run(0)).toEqual({ state: 'ok', orders: 1, staged: true });
  });

  it('reads one page when the provider does not say more waits (the sandbox, a short page)', async () => {
    const job = setup(async () => goodPage());
    expect(await job.run()).toEqual({ state: 'ok', orders: 1, staged: true });
    expect(job.ingests()).toHaveLength(1);
  });

  it('stops when a page was already ingested or the cursor did not move, so one window is never read in a loop', async () => {
    const same = setup(async () => ({ ...pageOf(1, true), nextCursor: null }), 'lazada');
    expect(await same.run()).toEqual({ state: 'ok', orders: 1, staged: true });
    expect(same.ingests()).toHaveLength(1);
    // The page keeps answering the cursor the first one recorded: the second page moves nothing, so the run ends there (two pages, not five).
    const stuck = setup(async () => pageOf(1, true), 'lazada');
    expect(await stuck.run()).toEqual({ state: 'ok', orders: 2, staged: true });
    expect(stuck.ingests()).toHaveLength(2);
    // A page that was ingested before (the same bytes) ends the run too.
    const twice = setup(async () => ({ ...pageOf(1, true), nextCursor: 'p:9' }), 'lazada', true);
    expect(await twice.run()).toEqual({ state: 'ok', orders: 0, staged: false });
    expect(twice.ingests()).toHaveLength(1);
  });

  it('keeps what earlier pages recorded when a later page fails, and ends with that failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      let call = 0;
      const job = setup(async () => {
        call += 1;
        if (call === 2) throw new MarketplaceProviderError('rate_limited');
        return pageOf(call, true);
      }, 'lazada');
      expect(await job.run()).toEqual({ state: 'rate_limited', orders: 1, staged: true });
      expect(job.polls()).toEqual([
        { id: CONNECTION, state: 'ok', cursor: 'p:1' },
        { id: CONNECTION, state: 'rate_limited' },
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the job payload is closed, and a test only records its state (#4238)', () => {
  it('knows two kinds, a job without one is a poll, and anything else or any other field is refused', () => {
    const base = { orgId: ORG, connectionId: CONNECTION };
    expect(zMarketplaceJob.safeParse(base).success).toBe(true);
    expect(zMarketplaceJob.safeParse({ ...base, kind: 'poll' }).success).toBe(true);
    expect(zMarketplaceJob.safeParse({ ...base, kind: 'test' }).success).toBe(true);
    expect(zMarketplaceJob.safeParse({ ...base, kind: 'sweep' }).success).toBe(false);
    expect(zMarketplaceJob.safeParse({ ...base, kind: 'test', secret: 'x' }).success).toBe(false);
    expect(zMarketplaceJob.safeParse({ orgId: 'x', connectionId: CONNECTION }).success).toBe(false);
    expect(marketplaceJobKind({})).toBe('poll');
    expect(marketplaceJobKind({ kind: 'test' })).toBe('test');
  });

  const testSetup = (opts: { target?: Record<string, unknown>; testConnection?: () => Promise<string>; open?: () => string; credential?: () => Promise<unknown> } = {}) => {
    const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
    const opened: string[] = [];
    const runtime = {
      query: async (name: string) =>
        name === 'kernel.channel.credential'
          ? opts.credential
            ? opts.credential()
            : { provider: 'marketplace_lazada', externalAccountId: 'x:lazada', keyId: 'k', envelope: Buffer.from('e').toString('base64') }
          : { action: 'poll', id: CONNECTION, channelConnectionId: '33333333-3333-4333-8333-333333333333', adapter: 'lazada', platform: 'lazada', legalEntityId: '44444444-4444-4444-8444-444444444444', cursor: 'u:2026-11-02T00:00:00.000Z', lastPollState: 'ok', lastPolledAt: null, ...TARGET_EXTRAS, ...opts.target },
      execute: async (name: string, input: Record<string, unknown>) => {
        executed.push({ name, input });
        return {};
      },
    } as unknown as Runtime;
    const broker = { open: () => (opened.push('x'), opts.open ? opts.open() : '{"appKey":"1"}') } as unknown as CredentialBroker;
    const provider = { id: 'lazada', hosts: ['api.lazada.vn'], connectFields: [], capabilities: { platforms: {} }, testConnection: opts.testConnection ?? (async () => 'works'), listOrders: async () => goodPage(), orderFinance: async () => null, listStock: async () => [] } as unknown as MarketplaceProvider;
    return {
      run: () => runMarketplaceTest({ runtime, broker, store: {} as BlobStore, providers: { lazada: provider } }, { orgId: ORG, connectionId: CONNECTION, kind: 'test' }),
      executed,
      opened,
    };
  };

  it('opens the credential, records the state and nothing else: no ingest, no poll state, no cursor', async () => {
    const t = testSetup({ testConnection: async () => 'api_not_enabled' });
    expect(await t.run()).toEqual({ state: 'api_not_enabled' });
    expect(t.opened).toHaveLength(1);
    expect(t.executed).toEqual([{ name: 'finance.marketplace_connection.record_test', input: { id: CONNECTION, state: 'api_not_enabled' } }]);
  });

  it('records `unreachable` for an adapter that throws, without keeping its text, and `wrong_credentials` for a credential that may no longer be used', async () => {
    const thrown = testSetup({
      testConnection: async () => {
        throw new Error('GET https://api.example.test?access_token=SECRET-TOKEN failed');
      },
    });
    expect(await thrown.run()).toEqual({ state: 'unreachable' });
    expect(JSON.stringify(thrown.executed)).not.toContain('SECRET-TOKEN');
    const { DomainError } = await import('@ludy/kernel-runtime');
    const left = testSetup({
      credential: async () => {
        throw new DomainError('CHANNEL_OWNER_LEFT', 409, 'x');
      },
    });
    expect(await left.run()).toEqual({ state: 'wrong_credentials' });
    expect(left.opened).toHaveLength(0);
    // The connection is marked expired as a poll does, and the state is recorded; no page is asked for.
    expect(left.executed.map((e) => e.name)).toEqual(['kernel.channel.mark_expired', 'finance.marketplace_connection.record_test']);
  });

  it('leaves a connection that is gone, not active or whose adapter is off alone', async () => {
    for (const reason of ['not_found', 'not_active', 'unknown_adapter']) {
      const t = testSetup({ target: { action: 'none', reason } });
      expect(await t.run()).toEqual({ state: 'skipped', reason });
      expect(t.executed).toEqual([]);
      expect(t.opened).toHaveLength(0);
    }
    const off = testSetup({ target: { adapter: 'other' } });
    expect(await off.run()).toEqual({ state: 'skipped', reason: 'provider_off' });
    expect(off.executed).toEqual([]);
  });
});

describe('a connection whose polls fail backs off (#4238)', () => {
  const NOW = new Date('2026-11-21T12:00:00Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const withState = (lastPollState: string | null, lastPolledAt: string | null, hosts: string[]) => {
    let asked = 0;
    const runtime = {
      query: async (name: string) =>
        name === 'kernel.channel.credential'
          ? { provider: 'marketplace_lazada', externalAccountId: 'x', keyId: 'k', envelope: Buffer.from('e').toString('base64') }
          : { action: 'poll', id: CONNECTION, channelConnectionId: '33333333-3333-4333-8333-333333333333', adapter: 'lazada', platform: 'lazada', legalEntityId: '44444444-4444-4444-8444-444444444444', cursor: null, lastPollState, lastPolledAt, ...TARGET_EXTRAS },
      execute: async () => ({}),
    } as unknown as Runtime;
    const provider = { id: 'lazada', hosts, connectFields: [], capabilities: { platforms: {} }, testConnection: async () => 'works', listOrders: async () => ((asked += 1), { orders: [], nextCursor: null }), orderFinance: async () => null, listStock: async () => [] } as unknown as MarketplaceProvider;
    const run = () => runMarketplacePoll({ runtime, broker: { open: () => '{}' } as unknown as CredentialBroker, store: {} as BlobStore, providers: { lazada: provider } }, { orgId: ORG, connectionId: CONNECTION }, 1, () => NOW);
    return { run, asked: () => asked };
  };

  it('does not ask again within the wait after a failure, and asks again after it', async () => {
    const hour = 3_600_000;
    const early = withState('unreachable', ago(hour / 2), ['api.lazada.vn']);
    expect(await early.run()).toEqual({ state: 'skipped', reason: 'backoff' });
    expect(early.asked()).toBe(0);
    const late = withState('unreachable', ago(hour + 1000), ['api.lazada.vn']);
    expect((await late.run()).state).toBe('ok');
    expect(late.asked()).toBe(1);
    // A refused login waits six hours.
    expect(await withState('credentials', ago(5 * hour), ['api.lazada.vn']).run()).toEqual({ state: 'skipped', reason: 'backoff' });
    expect((await withState('credentials', ago(6 * hour + 1000), ['api.lazada.vn']).run()).state).toBe('ok');
  });

  it('never holds back a good poll, a connection never polled, or the offline provider', async () => {
    expect((await withState('ok', ago(1000), ['api.lazada.vn']).run()).state).toBe('ok');
    expect((await withState(null, null, ['api.lazada.vn']).run()).state).toBe('ok');
    expect((await withState('unreachable', ago(1000), []).run()).state).toBe('ok');
  });
});

describe('every page asks again whether the credential may still be used (#4238)', () => {
  it('ends the run, recording `credentials`, when the connection stops being usable between two pages', async () => {
    const { DomainError } = await import('@ludy/kernel-runtime');
    let opens = 0;
    let asked = 0;
    const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
    const runtime = {
      query: async (name: string) => {
        if (name === 'kernel.channel.credential') {
          opens += 1;
          if (opens > 1) throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'x');
          return { provider: 'marketplace_lazada', externalAccountId: 'x', keyId: 'k', envelope: Buffer.from('e').toString('base64') };
        }
        return { action: 'poll', id: CONNECTION, channelConnectionId: '33333333-3333-4333-8333-333333333333', adapter: 'lazada', platform: 'lazada', legalEntityId: '44444444-4444-4444-8444-444444444444', cursor: null, lastPollState: null, lastPolledAt: null, ...TARGET_EXTRAS };
      },
      execute: async (name: string, input: Record<string, unknown>) => {
        executed.push({ name, input });
        return name === 'finance.marketplace_connection.ingest_page' ? { fileId: '55555555-5555-4555-8555-555555555555', duplicate: false } : {};
      },
    } as unknown as Runtime;
    const store = { put: async (_k: string, bytes: Uint8Array) => `content:${sha256Hex(bytes)}` } as unknown as BlobStore;
    const page = (n: number): MarketplaceOrderPage => ({ ...goodPage(), orders: [{ ...goodPage().orders[0]!, orderNo: `9103${String(n).padStart(6, '0')}` }], nextCursor: `p:${n}`, more: true });
    const provider = { id: 'lazada', hosts: ['api.lazada.vn'], connectFields: [], capabilities: { platforms: {} }, testConnection: async () => 'works', listOrders: async () => page((asked += 1)), orderFinance: async () => null, listStock: async () => [] } as unknown as MarketplaceProvider;
    const outcome = await runMarketplacePoll({ runtime, broker: { open: () => '{}' } as unknown as CredentialBroker, store, providers: { lazada: provider } }, { orgId: ORG, connectionId: CONNECTION });
    // One page was read and recorded; the second page's check refused, so Lazada was not asked again.
    expect(asked).toBe(1);
    expect(outcome).toEqual({ state: 'credentials', orders: 1, staged: true });
    expect(executed.filter((e) => e.name === 'finance.marketplace_connection.record_poll').map((e) => e.input.state)).toEqual(['ok', 'credentials']);
  });
});

describe('the worker finishes a seller\'s authorization (#4238)', () => {
  const TARGET = { action: 'authorize', id: CONNECTION, channelConnectionId: '33333333-3333-4333-8333-333333333333', adapter: 'lazada', codeKeyId: 'code-key', codeEnvelope: Buffer.from('code').toString('base64'), codeDigest: 'd'.repeat(64), codeAccount: `${CONNECTION}:authorize_code`, channelVersion: '2026-11-21T08:00:00.123Z' };
  const granted = { granted: { secret: '{"new":"secret"}', accessExpiresAt: new Date('2026-12-21T08:00:00Z'), refreshExpiresAt: new Date('2027-05-20T08:00:00Z') } };
  const setupAuthorize = (opts: { target?: Record<string, unknown>; authorize?: (secret: string, code: string) => Promise<unknown>; open?: (keyId: string) => string; complete?: () => Promise<unknown>; credentialError?: Error } = {}) => {
    const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
    const asked: Array<{ secret: string; code: string }> = [];
    const runtime = {
      query: async (name: string) => {
        if (name === 'kernel.channel.credential') {
          if (opts.credentialError) throw opts.credentialError;
          return { provider: 'marketplace_lazada', externalAccountId: 'ent:lazada', keyId: 'cred-key', envelope: Buffer.from('cred').toString('base64') };
        }
        return { ...TARGET, ...opts.target };
      },
      execute: async (name: string, input: Record<string, unknown>) => {
        executed.push({ name, input });
        if (name === 'finance.marketplace_connection.authorize_complete') return opts.complete ? opts.complete() : { recorded: true };
        return {};
      },
    } as unknown as Runtime;
    const broker = {
      open: (sealed: { keyId: string }) => (opts.open ? opts.open(sealed.keyId) : sealed.keyId === 'code-key' ? 'AUTH-CODE' : '{"appKey":"1","appSecret":"s"}'),
      seal: (value: string) => ({ keyId: 'next-key', envelope: Buffer.from(`sealed:${value}`) }),
    } as unknown as CredentialBroker;
    const provider = {
      id: 'lazada',
      hosts: ['api.lazada.vn'],
      connectFields: [],
      capabilities: { platforms: {} },
      authorize: async (secret: string, code: string) => {
        asked.push({ secret, code });
        return opts.authorize ? opts.authorize(secret, code) : granted;
      },
      testConnection: async () => 'works',
      listOrders: async () => goodPage(),
      orderFinance: async () => null,
      listStock: async () => [],
    } as unknown as MarketplaceProvider;
    const run = () => runMarketplaceAuthorize({ runtime, broker, store: {} as BlobStore, providers: { lazada: provider } }, { orgId: ORG, connectionId: CONNECTION, kind: 'authorize' });
    return { run, executed, asked };
  };

  it('trades the code once with the seller\'s secret and stores the new credential and the outcome in one command', async () => {
    const a = setupAuthorize();
    expect(await a.run()).toEqual({ state: 'authorized' });
    expect(a.asked).toEqual([{ secret: '{"appKey":"1","appSecret":"s"}', code: 'AUTH-CODE' }]);
    expect(a.executed).toHaveLength(1);
    expect(a.executed[0]).toMatchObject({
      name: 'finance.marketplace_connection.authorize_complete',
      input: { id: CONNECTION, codeDigest: TARGET.codeDigest, ifVersion: TARGET.channelVersion, expiresAt: '2026-12-21T08:00:00.000Z', reauthorizeBy: '2027-05-20T08:00:00.000Z', credential: { keyId: 'next-key' } },
    });
    // The tokens are only inside the sealed envelope, never in the command's other fields.
    expect(JSON.stringify({ ...a.executed[0]?.input, credential: undefined })).not.toContain('new');
  });

  it('names the seller who authorized and the seller of the connection\'s previous secret to the command, as plain ids only (#4285)', async () => {
    const grant = (sellerRef?: unknown) => async () => ({ granted: { secret: '{"new":"1"}', accessExpiresAt: new Date('2026-12-21T08:00:00.000Z'), refreshExpiresAt: new Date('2027-05-20T08:00:00.000Z'), ...(sellerRef === undefined ? {} : { sellerRef }) } });
    const previous = (sellerId: unknown) => (keyId: string) => (keyId === 'code-key' ? 'AUTH-CODE' : JSON.stringify({ appKey: '1', appSecret: 's', ...(sellerId === undefined ? {} : { sellerId }) }));
    const sent = async (authorize: () => Promise<unknown>, open?: (keyId: string) => string) => {
      const a = setupAuthorize({ authorize, ...(open ? { open } : {}) });
      expect(await a.run()).toEqual({ state: 'authorized' });
      return a.executed[0]?.input;
    };
    // Both known: the command gets both and decides.
    expect(await sent(grant('100200'), previous('300400'))).toMatchObject({ sellerRef: '100200', priorSellerRef: '300400' });
    // The answer names no seller, or a value that is not a plain id (a space, a name, an e-mail): nothing is passed for it.
    expect(await sent(grant(), previous('300400'))).toMatchObject({ sellerRef: null, priorSellerRef: '300400' });
    expect(await sent(grant('Nguyen Van A'), previous('seller@example.com'))).toMatchObject({ sellerRef: null, priorSellerRef: null });
    expect(await sent(grant(12345), previous(undefined))).toMatchObject({ sellerRef: null, priorSellerRef: null });
    // A previous secret that is not an object is no previous seller, not an error.
    expect(await sent(grant('100200'), (keyId) => (keyId === 'code-key' ? 'AUTH-CODE' : '"just a string"'))).toMatchObject({ sellerRef: '100200', priorSellerRef: null });
  });

  it('records a refused code and a failed trade (and a trade that throws) as such, clearing the code, and never asks twice', async () => {
    const refused = setupAuthorize({ authorize: async () => ({ refused: 'IllegalCode' }) });
    expect(await refused.run()).toEqual({ state: 'refused' });
    expect(refused.executed).toEqual([{ name: 'finance.marketplace_connection.authorize_record', input: { id: CONNECTION, codeDigest: TARGET.codeDigest, outcome: 'refused' } }]);
    const failed = setupAuthorize({ authorize: async () => ({ failed: 'NETWORK' }) });
    expect(await failed.run()).toEqual({ state: 'failed' });
    expect(failed.asked).toHaveLength(1);
    const thrown = setupAuthorize({
      authorize: async () => {
        throw new Error('POST https://auth.example?code=SECRET-CODE failed');
      },
    });
    expect(await thrown.run()).toEqual({ state: 'failed' });
    expect(JSON.stringify(thrown.executed)).not.toContain('SECRET-CODE');
  });

  it('asks nothing of the platform when a sealed value does not open under its own binding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const a = setupAuthorize({
        open: () => {
          throw new Error('bad binding');
        },
      });
      expect(await a.run()).toEqual({ state: 'failed' });
      expect(a.asked).toHaveLength(0);
      expect(a.executed.map((e) => e.name)).toEqual(['finance.marketplace_connection.authorize_record']);
    } finally {
      warn.mockRestore();
    }
  });

  it('says `superseded` when the connection or the code changed since the read, and records a failed outcome when the command refuses', async () => {
    const superseded = setupAuthorize({ complete: async () => ({ recorded: false }) });
    expect(await superseded.run()).toEqual({ state: 'superseded' });
    const { DomainError } = await import('@ludy/kernel-runtime');
    const refused = setupAuthorize({
      complete: async () => {
        throw new DomainError('CHANNEL_NOT_ACTIVE', 409, 'x');
      },
    });
    expect(await refused.run()).toEqual({ state: 'failed' });
    expect(refused.executed.map((e) => e.name)).toEqual(['finance.marketplace_connection.authorize_complete', 'finance.marketplace_connection.authorize_record']);
  });

  it('tries the store again after a passing database error (the tokens exist only here), and gives up after three', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const a = setupAuthorize({
        complete: async () => {
          calls += 1;
          if (calls < 3) throw new Error('connection reset');
          return { recorded: true };
        },
      });
      const done = a.run();
      await vi.runAllTimersAsync();
      expect(await done).toEqual({ state: 'authorized' });
      expect(calls).toBe(3);
      const b = setupAuthorize({
        complete: async () => {
          throw new Error('connection reset');
        },
      });
      const failing = b.run();
      const settled = failing.then(() => 'resolved', (error: Error) => error.message);
      await vi.runAllTimersAsync();
      expect(await settled).toBe('connection reset');
      // The spent code is not left sealed behind: after the third failure the job records `failed` (best effort) before it throws.
      expect(b.executed.filter((e) => e.name === 'finance.marketplace_connection.authorize_record').map((e) => e.input)).toEqual([{ id: CONNECTION, codeDigest: TARGET.codeDigest, outcome: 'failed' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a code that waited past the window as failed without trading it, so the sealed code is cleared', async () => {
    const a = setupAuthorize({ target: { action: 'expired', id: CONNECTION, codeDigest: 'e'.repeat(64) } });
    expect(await a.run()).toEqual({ state: 'failed' });
    expect(a.asked).toHaveLength(0);
    expect(a.executed).toEqual([{ name: 'finance.marketplace_connection.authorize_record', input: { id: CONNECTION, codeDigest: 'e'.repeat(64), outcome: 'failed' } }]);
  });

  it('leaves a connection that has nothing pending, is gone or whose adapter is off alone', async () => {
    for (const reason of ['not_found', 'not_active', 'not_pending', 'unknown_adapter']) {
      const a = setupAuthorize({ target: { action: 'none', reason } });
      expect(await a.run()).toEqual({ state: 'skipped', reason });
      expect(a.executed).toEqual([]);
    }
    const off = setupAuthorize({ target: { adapter: 'other' } });
    expect(await off.run()).toEqual({ state: 'skipped', reason: 'provider_off' });
    expect(zMarketplaceJob.safeParse({ orgId: ORG, connectionId: CONNECTION, kind: 'authorize' }).success).toBe(true);
  });
});

describe('orders cursor separator safety in pollPage (#4306)', () => {
  it('refuses an orders nextCursor containing `|` as not_recognized without ingesting or moving cursor', async () => {
    for (const page of [{ ...goodPage(), nextCursor: 'o:1|2' }, { orders: [], nextCursor: 'bad|cursor' }]) {
      const { run, polls, ingests, puts } = setup(async () => page);
      expect(await run()).toEqual({ state: 'not_recognized', orders: 0, staged: false });
      expect(polls()).toEqual([{ id: CONNECTION, state: 'not_recognized' }]);
      expect(ingests()).toHaveLength(0);
      expect(puts).toHaveLength(0);
    }
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The income leg of a marketplace poll (#4302): the two-part cursor, the one-closed-payment-day rule per platform, the leg's file and ingest in the worker, and a Shopee provider read end to end
// against the made-up Shopee. A stub runtime stands for the database (the real path of a staged file is marketplace-connection.db.test.ts and finance-marketplace-income.db.test.ts).
import { describe, expect, it, vi } from 'vitest';
import { findIncomeColumns, incomeLines, parseCsv } from '@ludy/l10n-vn';
import { EXTRACT_LIMITS } from '@ludy/extract-contract';
import { MarketplaceProviderError, marketplaceIncomeCsv, parseMarketplaceIncomePage, type MarketplaceIncomeLine, type MarketplaceIncomeOptions, type MarketplaceProvider } from '@ludy/mod-finance';
import { sha256Hex, type BlobStore, type CredentialBroker, type Runtime } from '@ludy/kernel-runtime';
import { hostBoundFetch } from '../src/marketplace-adapter-kit.ts';
import { INCOME_FIRST_DAYS, INCOME_MIN_SLICE_SECONDS, INCOME_PENDING_WAIT_DAYS, firstIncomeDay, joinPollCursor, readHalved, readIncomeDay, splitPollCursor, withLazadaIncome, withShopeeIncome, withTiktokIncome } from '../src/marketplace-income-leg.ts';
import { MARKETPLACE_MAX_PAGES_PER_RUN, runMarketplacePoll } from '../src/marketplace-poll-job.ts';
import { SHOPEE_HOSTS, shopeeCaller } from '../src/marketplace-shopee.ts';
import { shopeeFinance } from '../src/marketplace-shopee-finance.ts';
import { shopeeMarketplace } from '../src/marketplace-shopee-orders.ts';
import { LAZADA_HOSTS, lazadaCaller, lazadaMarketplace } from '../src/marketplace-lazada.ts';
import { lazadaFinance } from '../src/marketplace-lazada-finance.ts';
import { TIKTOK_HOSTS, tiktokCaller } from '../src/marketplace-tiktok.ts';
import { TIKTOK_FINANCE_MAX_STATEMENTS, tiktokFinance } from '../src/marketplace-tiktok-finance.ts';
import { tiktokMarketplace } from '../src/marketplace-tiktok-orders.ts';
import { fakeLazada } from './fake-lazada.ts';
import { fakeShopee } from './fake-shopee.ts';
import { fakeFinanceOrder, fakeShop, fakeStatement, fakeTiktok } from './fake-tiktok.ts';

const ORG = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';
// Noon in Vietnam on 2026-11-21: today in Vietnam is the 21st.
const NOW = Date.parse('2026-11-21T05:00:00Z');
const line = (over: Partial<MarketplaceIncomeLine> = {}): MarketplaceIncomeLine => ({
  orderNo: '2611A1',
  paidAt: '2026-11-15',
  sales: '100000',
  sellerDiscount: '5000',
  commission: '4000',
  serviceFee: '3000',
  paymentFee: '2000',
  shipping: '8000',
  taxWithheld: '0',
  refund: '0',
  other: '0',
  net: '78000',
  ...over,
});

describe('the two-part cursor', () => {
  it('reads a stored cursor with no separator as the orders part alone, and splits both parts', () => {
    expect(splitPollCursor(null)).toEqual({ orders: null, income: null });
    expect(splitPollCursor('u:2026-11-02T03:04:05.000Z')).toEqual({ orders: 'u:2026-11-02T03:04:05.000Z', income: null });
    expect(splitPollCursor('o:2026-11-02T03:04:05.000Z;s:2|d:2026-11-10')).toEqual({ orders: 'o:2026-11-02T03:04:05.000Z;s:2', income: 'd:2026-11-10' });
    expect(splitPollCursor('|d:2026-11-10')).toEqual({ orders: null, income: 'd:2026-11-10' });
  });

  it('joins them back, keeps an orders-only cursor as it was, and refuses a part that holds the separator or a result past the column', () => {
    expect(joinPollCursor({ orders: 'u:x', income: null })).toBe('u:x');
    expect(joinPollCursor({ orders: null, income: null })).toBeNull();
    expect(joinPollCursor({ orders: null, income: 'd:2026-11-10' })).toBe('|d:2026-11-10');
    expect(joinPollCursor({ orders: 'u:x', income: 'd:2026-11-10' })).toBe('u:x|d:2026-11-10');
    expect(() => joinPollCursor({ orders: 'a|b', income: null })).toThrow();
    expect(() => joinPollCursor({ orders: 'x'.repeat(190), income: 'd:2026-11-10' })).toThrow();
    for (const cursor of ['u:x|d:2026-11-10', '|d:2026-11-10', 'u:x']) expect(joinPollCursor(splitPollCursor(cursor))).toBe(cursor);
  });
});

describe('one closed payment day', () => {
  const reads: Array<{ startDay: string; endDay: string }> = [];
  const make = (since: string | null, over: { lookbackDays?: number; waitPending?: boolean; minStartDay?: string; lines?: MarketplaceIncomeLine[]; pending?: number } = {}) =>
    readIncomeDay({
      since,
      nowMs: NOW,
      lookbackDays: over.lookbackDays ?? 0,
      waitPending: over.waitPending ?? false,
      ...(over.minStartDay !== undefined ? { minStartDay: over.minStartDay } : {}),
      read: async (window) => {
        reads.push(window);
        return { lines: over.lines ?? [], pending: over.pending ?? 0 };
      },
    });

  it('starts at the later of INCOME_FIRST_DAYS back, connection creation (Vietnam) and the day after the last standing settlement', async () => {
    expect(firstIncomeDay({ nowMs: NOW })).toBe('2026-10-22');
    // Connection created at 18:00 UTC on 2026-11-10 is 2026-11-11 in Vietnam (+7).
    expect(firstIncomeDay({ nowMs: NOW, createdAt: '2026-11-10T18:00:00.000Z', lastSettlementEnd: null })).toBe('2026-11-11');
    // An already-imported settlement covering up to 2026-11-14 starts daily reads at 2026-11-15 to avoid OVERLAP.
    expect(firstIncomeDay({ nowMs: NOW, createdAt: '2026-10-01T00:00:00.000Z', lastSettlementEnd: '2026-11-14' })).toBe('2026-11-15');
    // An older connection or settlement never reaches further back than 30 days.
    expect(firstIncomeDay({ nowMs: NOW, createdAt: '2026-09-01T00:00:00.000Z', lastSettlementEnd: '2026-10-10' })).toBe('2026-10-22');
    reads.length = 0;
    const bounded = await make(null, { minStartDay: '2026-11-15', lines: [line({ paidAt: '2026-11-15' })] });
    expect(reads).toEqual([{ startDay: '2026-11-15', endDay: '2026-11-15' }]);
    expect(bounded.nextCursor).toBe('d:2026-11-16');
    // An existing cursor stays authoritative even if minStartDay is later.
    reads.length = 0;
    await make('d:2026-11-12', { minStartDay: '2026-11-18' });
    expect(reads).toEqual([{ startDay: '2026-11-12', endDay: '2026-11-12' }]);
  });

  it('starts INCOME_FIRST_DAYS back, anchors the cursor on the day it reads and moves it one day', async () => {
    reads.length = 0;
    const page = await make(null, { lines: [line({ paidAt: '2026-10-22' })] });
    expect(INCOME_FIRST_DAYS).toBe(30);
    expect(reads).toEqual([{ startDay: '2026-10-22', endDay: '2026-10-22' }]);
    expect(page).toEqual({ lines: [line({ paidAt: '2026-10-22' })], nextCursor: 'd:2026-10-23', more: true });
  });

  it('never reads a day until it has been over for a whole day in Vietnam, and keeps the cursor where it is', async () => {
    reads.length = 0;
    expect(await make('d:2026-11-21')).toEqual({ lines: [], nextCursor: 'd:2026-11-21' });
    expect(await make('d:2026-11-22')).toEqual({ lines: [], nextCursor: 'd:2026-11-22' });
    // Yesterday (the 20th) is still inside the grace.
    expect(await make('d:2026-11-20')).toEqual({ lines: [], nextCursor: 'd:2026-11-20' });
    expect(reads).toEqual([]);
    // The 19th is the last readable day: it is read, and nothing waits behind it.
    expect(await make('d:2026-11-19')).toEqual({ lines: [], nextCursor: 'd:2026-11-20', more: false });
  });

  it('gives only the lines paid on the day: a line of another day in the window is dropped, never filed under this one', async () => {
    const page = await make('d:2026-11-15', { lookbackDays: 30, lines: [line({ paidAt: '2026-11-14' }), line({ orderNo: '2611A2' }), line({ orderNo: '2611A3', paidAt: '2026-11-16' })] });
    expect(reads.at(-1)).toEqual({ startDay: '2026-10-16', endDay: '2026-11-15' });
    expect(page.lines.map((l) => l.orderNo)).toEqual(['2611A2']);
  });

  it('waits on a day with unpaid lines (nothing written, the cursor stays) until it is older than the wait, then goes on with what is paid', async () => {
    expect(await make('d:2026-11-15', { waitPending: true, pending: 3, lines: [line()] })).toEqual({ lines: [], nextCursor: 'd:2026-11-15' });
    expect(await make('d:2026-11-15', { waitPending: false, pending: 3, lines: [line()] })).toMatchObject({ lines: [line()], nextCursor: 'd:2026-11-16' });
    const old = `d:${new Date(NOW + 8 * 3_600_000 - (INCOME_PENDING_WAIT_DAYS + 1) * 86_400_000).toISOString().slice(0, 10)}`;
    expect((await make(old, { waitPending: true, pending: 3, lines: [] })).nextCursor).not.toBe(old);
  });

  it('refuses a cursor that is not its own', async () => {
    for (const bad of ['u:2026-11-02T03:04:05.000Z', 'd:2026-02-30', 'd:2026-11-1', 'x']) await expect(make(bad)).rejects.toMatchObject({ kind: 'not_recognized' });
  });
});

// A stub runtime and a provider whose orders leg has nothing new, so the income leg is what is asked.
function setup(
  listIncome: MarketplaceProvider['listIncome'],
  held: {
    cursor: string | null;
    lastPollState?: string | null;
    lastPolledAt?: string | null;
    lastIncomePollState?: string | null;
    lastIncomePolledAt?: string | null;
    createdAt?: string;
    lastSettlementEnd?: string | null;
  } = { cursor: null },
  opts: {
    duplicate?: boolean;
    ingestFails?: boolean;
    orders?: () => Promise<unknown>;
    hosts?: string[];
    nowMs?: number;
    platform?: 'shopee' | 'tiktok_shop' | 'lazada';
    adapter?: string;
  } = {},
) {
  const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
  const settlementQueries: Array<Record<string, unknown>> = [];
  const puts: Array<{ key: string; bytes: Uint8Array }> = [];
  let cursor = held.cursor;
  const adapter = opts.adapter ?? 'sandbox';
  const platform = opts.platform ?? 'shopee';
  const runtime = {
    query: async (name: string, input: Record<string, unknown>) => {
      if (name === 'kernel.channel.credential') {
        return { provider: `marketplace_${adapter}`, externalAccountId: 'x', keyId: 'k', envelope: Buffer.from('e').toString('base64') };
      }
      if (name === 'finance.marketplace_connection.last_settlement_end') {
        settlementQueries.push(input);
        return held.lastSettlementEnd ?? null;
      }
      return {
        action: 'poll',
        id: CONNECTION,
        channelConnectionId: '33333333-3333-4333-8333-333333333333',
        adapter,
        platform,
        legalEntityId: '44444444-4444-4444-8444-444444444444',
        cursor,
        lastPollState: held.lastPollState ?? 'ok',
        lastPolledAt: held.lastPolledAt ?? null,
        lastIncomePollState: held.lastIncomePollState ?? null,
        lastIncomePolledAt: held.lastIncomePolledAt ?? null,
        createdAt: held.createdAt ?? '2026-10-01T00:00:00.000Z',
      };
    },
    execute: async (name: string, input: Record<string, unknown>) => {
      executed.push({ name, input });
      if (opts.ingestFails && name === 'finance.marketplace_connection.ingest_page') throw new Error('the file could not be filed');
      if (name === 'finance.marketplace_connection.record_poll' && typeof input.cursor === 'string') cursor = input.cursor;
      return name === 'finance.marketplace_connection.ingest_page' ? { fileId: '55555555-5555-4555-8555-555555555555', duplicate: opts.duplicate ?? false } : {};
    },
  } as unknown as Runtime;
  const store = {
    put: async (key: string, bytes: Uint8Array) => {
      puts.push({ key, bytes });
      return `content:${sha256Hex(bytes)}`;
    },
  } as unknown as BlobStore;
  const provider = {
    id: adapter,
    hosts: opts.hosts ?? [],
    connectFields: [],
    capabilities: { platforms: {} },
    listOrders: opts.orders ?? (async () => ({ orders: [], nextCursor: null })),
    ...(listIncome ? { listIncome } : {}),
    testConnection: async () => 'works',
    orderFinance: async () => null,
    listStock: async () => [],
  } as unknown as MarketplaceProvider;
  const deps = { runtime, broker: { open: () => '{}' } as unknown as CredentialBroker, store, providers: { [adapter]: provider } };
  const run = (maxPages?: number) => runMarketplacePoll(deps, { orgId: ORG, connectionId: CONNECTION }, maxPages, () => new Date(opts.nowMs ?? NOW));
  const polls = () => executed.filter((e) => e.name === 'finance.marketplace_connection.record_poll').map((e) => e.input);
  const ingests = () => executed.filter((e) => e.name === 'finance.marketplace_connection.ingest_page').map((e) => e.input);
  return { run, polls, ingests, puts, stored: () => cursor, settlementQueries: () => settlementQueries.length };
}

describe('the leg in the worker', () => {
  it('writes the day as the platform\'s income file, ingests it as an upload of the connection and only then moves the income part, keeping the orders part', async () => {
    const page = { lines: [line()], nextCursor: 'd:2026-11-16', more: false };
    const { run, polls, ingests, puts } = setup(async () => page, { cursor: 'o:2026-11-20T00:00:00.000Z' });
    expect(await run()).toEqual({ state: 'ok', orders: 0, staged: true });
    expect(ingests()).toHaveLength(1);
    expect(ingests()[0]).toMatchObject({ marketplaceConnectionId: CONNECTION, contentType: 'text/csv', filename: `thu-nhap-shopee-${CONNECTION}-2026-11-15-2026-11-15.csv` });
    const text = new TextDecoder().decode(puts[0]?.bytes);
    expect(text.split('\n')[0]).toBe(`"Ludy marketplace connection ${CONNECTION}"`);
    expect(text).toContain('"2611A1"');
    expect(polls()).toEqual([{ id: CONNECTION, leg: 'income', state: 'ok', cursor: 'o:2026-11-20T00:00:00.000Z|d:2026-11-16' }]);
  });

  it('keeps the cursor when the file could not be filed, so the same day is read again', async () => {
    const { run, polls } = setup(async () => ({ lines: [line()], nextCursor: 'd:2026-11-16' }), { cursor: null }, { ingestFails: true });
    await expect(run()).rejects.toThrow();
    expect(polls()).toEqual([]);
  });

  it('moves the cursor for a day with no lines without writing a file, and for a file the intake already holds (a repeat) without handing the Inbox another', async () => {
    const empty = setup(async () => ({ lines: [], nextCursor: 'd:2026-11-16' }));
    expect(await empty.run()).toEqual({ state: 'ok', orders: 0, staged: false });
    expect(empty.ingests()).toHaveLength(0);
    expect(empty.puts).toHaveLength(0);
    expect(empty.polls()).toEqual([{ id: CONNECTION, leg: 'income', state: 'ok', cursor: '|d:2026-11-16' }]);
    const repeat = setup(async () => ({ lines: [line()], nextCursor: 'd:2026-11-16' }), { cursor: null }, { duplicate: true });
    expect(await repeat.run()).toEqual({ state: 'ok', orders: 0, staged: false });
    expect(repeat.polls()).toEqual([{ id: CONNECTION, leg: 'income', state: 'ok', cursor: '|d:2026-11-16' }]);
  });

  it('reads at most one run of days, each its own file with its own cursor step, and stops when nothing more waits', async () => {
    let day = 10;
    const listIncome = vi.fn(async () => {
      const paidAt = `2026-11-${day}`;
      day += 1;
      return { lines: [line({ paidAt })], nextCursor: `d:2026-11-${day}`, more: true };
    });
    const { run, ingests, stored } = setup(listIncome);
    await run();
    expect(listIncome).toHaveBeenCalledTimes(MARKETPLACE_MAX_PAGES_PER_RUN);
    expect(ingests()).toHaveLength(MARKETPLACE_MAX_PAGES_PER_RUN);
    expect(new Set(ingests().map((i) => i.filename)).size).toBe(MARKETPLACE_MAX_PAGES_PER_RUN);
    expect(stored()).toBe(`|d:2026-11-${day}`);
    const one = vi.fn(async () => ({ lines: [], nextCursor: 'd:2026-11-16', more: false }));
    await setup(one).run();
    expect(one).toHaveBeenCalledTimes(1);
  });

  it('does not ask for income when the orders leg did not end ok, or when the provider has no income reader', async () => {
    const asked = vi.fn(async () => ({ lines: [], nextCursor: null }));
    const failing = setup(asked, { cursor: null }, { orders: async () => Promise.reject(new MarketplaceProviderError('rate_limited')) });
    expect(await failing.run()).toMatchObject({ state: 'rate_limited' });
    expect(asked).not.toHaveBeenCalled();
    const none = setup(undefined);
    expect(await none.run()).toEqual({ state: 'ok', orders: 0, staged: false });
    expect(none.polls()).toEqual([]);
  });

  it('records a failure of the income read as its state with the cursor kept, and never logs the provider\'s text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const raw = setup(async () => Promise.reject(new Error('GET https://api.example.test/finance?access_token=SECRET-TOKEN failed')), { cursor: 'o:2026-11-20T00:00:00.000Z' });
      expect(await raw.run()).toEqual({ state: 'unreachable', orders: 0, staged: false });
      expect(raw.polls()).toEqual([{ id: CONNECTION, leg: 'income', state: 'unreachable' }]);
      const kinded = setup(async () => Promise.reject(new MarketplaceProviderError('not_recognized')));
      expect(await kinded.run()).toMatchObject({ state: 'not_recognized' });
      expect(kinded.polls()).toEqual([{ id: CONNECTION, leg: 'income', state: 'not_recognized' }]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET-TOKEN');
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the orders leg free of backoff when the income leg fails, while enforcing the income leg backoff (#4306)', async () => {
    const hosts = ['api.example.test'];
    const orders = vi.fn(async () => ({
      orders: [{ orderNo: '2611B1', orderedAt: '2026-11-20', shippedAt: null, deliveredAt: null, stage: 'placed', lines: [{ lineKey: 'k', sku: 'S', itemName: 'Áo', quantity: '1', unitPrice: '1000', amount: '1000' }] }],
      nextCursor: 'o:2026-11-21T00:00:00.000Z',
    }));
    const incomeFails = setup(
      async () => Promise.reject(new MarketplaceProviderError('rate_limited')),
      { cursor: 'o:2026-11-20T00:00:00.000Z', lastPollState: 'ok', lastIncomePollState: null },
      { orders, hosts },
    );
    expect(await incomeFails.run()).toEqual({ state: 'rate_limited', orders: 1, staged: true });
    // Orders leg recorded ok on orders state; income leg failure went only to leg: 'income'.
    expect(incomeFails.polls()).toEqual([
      { id: CONNECTION, state: 'ok', cursor: 'o:2026-11-21T00:00:00.000Z' },
      { id: CONNECTION, leg: 'income', state: 'rate_limited' },
    ]);

    // 30 minutes later: orders leg still runs normally; income leg is skipped under its 1h backoff.
    const halfHourAgo = new Date(NOW - 30 * 60_000).toISOString();
    const listIncomeBackedOff = vi.fn(async () => ({ lines: [], nextCursor: 'd:2026-11-16' }));
    const ordersNext = vi.fn(async () => ({
      orders: [{ orderNo: '2611B2', orderedAt: '2026-11-21', shippedAt: null, deliveredAt: null, stage: 'placed', lines: [{ lineKey: 'k', sku: 'S', itemName: 'Áo', quantity: '1', unitPrice: '1000', amount: '1000' }] }],
      nextCursor: 'o:2026-11-21T00:30:00.000Z',
    }));
    const duringIncomeBackoff = setup(
      listIncomeBackedOff,
      { cursor: 'o:2026-11-21T00:00:00.000Z', lastPollState: 'ok', lastPolledAt: halfHourAgo, lastIncomePollState: 'rate_limited', lastIncomePolledAt: halfHourAgo },
      { orders: ordersNext, hosts },
    );
    expect(await duringIncomeBackoff.run()).toEqual({ state: 'ok', orders: 1, staged: true });
    expect(ordersNext).toHaveBeenCalledTimes(1);
    expect(listIncomeBackedOff).not.toHaveBeenCalled();

    // Past the 1h income backoff window, the income leg resumes.
    const twoHoursAgo = new Date(NOW - 2 * 3_600_000).toISOString();
    const listIncomeAfter = vi.fn(async () => ({ lines: [], nextCursor: 'd:2026-11-16' }));
    const afterIncomeBackoff = setup(
      listIncomeAfter,
      { cursor: 'o:2026-11-21T00:30:00.000Z', lastPollState: 'ok', lastPolledAt: halfHourAgo, lastIncomePollState: 'rate_limited', lastIncomePolledAt: twoHoursAgo },
      { hosts },
    );
    expect(await afterIncomeBackoff.run()).toEqual({ state: 'ok', orders: 0, staged: false });
    expect(listIncomeAfter).toHaveBeenCalledTimes(1);
  });

  it('forwards minStartDay from connection creation and last standing settlement end only on the first income poll (#4306)', async () => {
    const received: Array<MarketplaceIncomeOptions | undefined> = [];
    const first = setup(
      async (_secret, _platform, _since, options) => {
        received.push(options);
        return { lines: [], nextCursor: 'd:2026-11-16' };
      },
      { cursor: null, createdAt: '2026-11-05T00:00:00.000Z', lastSettlementEnd: '2026-11-14' },
    );
    await first.run();
    expect(first.settlementQueries()).toBe(1);
    expect(received).toHaveLength(1);
    expect(received[0]?.minStartDay).toBe('2026-11-15');
    expect(received[0]?.cache).toBeInstanceOf(Map);

    // An existing income cursor or provider without listIncome skips the settlement query completely.
    const resumed = setup(async () => ({ lines: [], nextCursor: 'd:2026-11-16' }), { cursor: 'o:1|d:2026-11-15', lastSettlementEnd: '2026-11-14' });
    await resumed.run();
    expect(resumed.settlementQueries()).toBe(0);
    const noIncome = setup(undefined, { cursor: null, lastSettlementEnd: '2026-11-14' });
    await noIncome.run();
    expect(noIncome.settlementQueries()).toBe(0);
  });

  it('refuses a page the port does not name: a broken identity, an extra field, a formula-like order number, too many lines', async () => {
    for (const bad of [line({ net: '77999' }), { ...line(), buyerName: 'x' }, line({ orderNo: '=2611A1' })]) {
      const { run, polls, ingests } = setup(async () => ({ lines: [bad], nextCursor: 'd:2026-11-16' }) as never);
      expect(await run()).toMatchObject({ state: 'not_recognized' });
      expect(polls()).toEqual([{ id: CONNECTION, leg: 'income', state: 'not_recognized' }]);
      expect(ingests()).toHaveLength(0);
    }
    const many = setup(async () => ({ lines: Array.from({ length: EXTRACT_LIMITS.maxIncomeLines + 1 }, (_, n) => line({ orderNo: `A${n}` })), nextCursor: 'd:2026-11-16' }));
    expect(await many.run()).toMatchObject({ state: 'not_recognized' });
  });

  it('keeps an orders cursor that moves beside the income part it holds', async () => {
    const orders = async () => ({
      orders: [{ orderNo: '2611A1', orderedAt: '2026-11-02', shippedAt: null, deliveredAt: null, stage: 'placed', lines: [{ lineKey: 'k', sku: 'S', itemName: 'Áo', quantity: '1', unitPrice: '1000', amount: '1000' }] }],
      nextCursor: 'o:2026-11-21T00:00:00.000Z',
    });
    const { run, polls } = setup(async () => ({ lines: [], nextCursor: 'd:2026-11-21' }), { cursor: 'o:2026-11-20T00:00:00.000Z|d:2026-11-21' }, { orders });
    await run();
    expect(polls()[0]).toEqual({ id: CONNECTION, state: 'ok', cursor: 'o:2026-11-21T00:00:00.000Z|d:2026-11-21' });
  });

  it('hands the writer pages that parse the same way the worker checks them', () => {
    expect(parseMarketplaceIncomePage({ lines: [line()], nextCursor: 'd:2026-11-16' })?.lines).toHaveLength(1);
  });
});

describe('a Shopee day read end to end', () => {
  const CRED = { partnerId: '1000012', partnerKey: 'test-only-partner-key', shopId: '77777', accessToken: 'SHP_access' };
  const SECRET = JSON.stringify(CRED);
  // Noon in Vietnam on the 15th.
  const RELEASE = Date.parse('2026-11-15T05:00:00Z');
  const escrow = { orderSn: 'A1', releaseMs: RELEASE, payout: '78000.0', income: { escrow_amount: '78000.0', original_cost_of_goods_sold: '100000.0', voucher_from_seller: '5000.0', commission_fee: '4000.0', service_fee: '3000.0', seller_transaction_fee: '2000.0', actual_shipping_fee: '8000.0' } };
  const provider = () => {
    const fake = fakeShopee({ ...CRED, escrows: [escrow], now: () => NOW });
    const options = { fetch: hostBoundFetch(SHOPEE_HOSTS, fake.fetch), now: () => new Date(NOW), spacingMs: 0 };
    const caller = shopeeCaller(options);
    return withShopeeIncome(shopeeMarketplace(options, caller), options, shopeeFinance(options, caller));
  };

  it('reads the day an escrow was released as the income line of its order, the days before it as empty, and passes the port\'s own page check', async () => {
    const p = provider();
    const day = await p.listIncome?.(SECRET, 'shopee', 'd:2026-11-15');
    expect(parseMarketplaceIncomePage(day)).toEqual({
      lines: [{ orderNo: 'A1', paidAt: '2026-11-15', sales: '100000', sellerDiscount: '5000', commission: '4000', serviceFee: '3000', paymentFee: '2000', shipping: '8000', taxWithheld: '0', refund: '0', other: '0', net: '78000' }],
      nextCursor: 'd:2026-11-16',
      more: true,
    });
    expect(await p.listIncome?.(SECRET, 'shopee', 'd:2026-11-14')).toEqual({ lines: [], nextCursor: 'd:2026-11-15', more: true });
    await expect(p.listIncome?.(SECRET, 'lazada', 'd:2026-11-14')).rejects.toBeInstanceOf(MarketplaceProviderError);
    // The other two platforms wrap their readers the same way.
    expect(typeof withLazadaIncome).toBe('function');
    expect(typeof withTiktokIncome).toBe('function');
  });
});

describe('a Lazada day read end to end', () => {
  const KEY = { appKey: '123456', appSecret: 'helloworld', accessToken: '50000000001abcDEF' };
  const SECRET = JSON.stringify(KEY);
  const LAZADA_NOW = Date.parse('2026-11-10T03:00:00Z');
  const provider = (transactions: Array<{ orderNo: string; date: string; paidStatus: string; feeType: number; amount: string }>) => {
    const fake = fakeLazada({ ...KEY, orders: [], statements: [{ number: 'VN-0001', payout: '850000 VND' }], transactions });
    const options = { fetch: hostBoundFetch(LAZADA_HOSTS, fake.fetch), now: () => new Date(LAZADA_NOW), sleep: async () => undefined };
    const caller = lazadaCaller(options);
    return withLazadaIncome(lazadaMarketplace(options, caller), options, lazadaFinance(options, caller));
  };

  it('reads a paid day as the order\'s income line and moves one day; a day with an unpaid line is waited on, nothing written', async () => {
    const p = provider([
      { orderNo: '8000001', date: '5 Nov 2026', paidStatus: 'Paid', feeType: 13, amount: '1000000' },
      { orderNo: '8000001', date: '5 Nov 2026', paidStatus: 'Paid', feeType: 16, amount: '-100000' },
    ]);
    const paid = await p.listIncome?.(SECRET, 'lazada', 'd:2026-11-05');
    expect(parseMarketplaceIncomePage(paid)).toMatchObject({ lines: [{ orderNo: '8000001', paidAt: '2026-11-05', sales: '1000000', commission: '100000', net: '900000' }], nextCursor: 'd:2026-11-06', more: true });
    // The made-up Lazada answers every line whatever the window, so the unpaid line lives in its own provider.
    const waiting = provider([{ orderNo: '8000002', date: '6 Nov 2026', paidStatus: 'Not paid', feeType: 13, amount: '500000' }]);
    expect(await waiting.listIncome?.(SECRET, 'lazada', 'd:2026-11-06')).toEqual({ lines: [], nextCursor: 'd:2026-11-06' });
  });
});

describe('a window too large is split', () => {
  const tooLarge = () => new MarketplaceProviderError('too_large');
  const DAY_FROM = Date.parse('2026-11-14T17:00:00Z') / 1000;
  const DAY_TO = DAY_FROM + 86_399;

  it('halves a window the reader refuses as too large, reads the halves in order, and never shares an instant between two slices', async () => {
    const asked: Array<[number, number]> = [];
    const lines = await readHalved(DAY_FROM, DAY_TO, async (from, to) => {
      asked.push([from, to]);
      // More than 100 orders over a whole day, up to 100 in a half: only the whole day is refused.
      if (to - from + 1 > 43_200) throw tooLarge();
      return [line({ orderNo: `A${from}` })];
    });
    expect(asked).toEqual([[DAY_FROM, DAY_TO], [DAY_FROM, DAY_FROM + 43_199], [DAY_FROM + 43_200, DAY_TO]]);
    expect(lines).toHaveLength(2);
  });

  it('goes on halving down to about an hour and then stalls visibly with `too_large`; other errors pass unchanged and are never split', async () => {
    const sizes: number[] = [];
    await expect(
      readHalved(DAY_FROM, DAY_TO, async (from, to) => {
        sizes.push(to - from + 1);
        throw tooLarge();
      }),
    ).rejects.toMatchObject({ kind: 'too_large' });
    expect(Math.min(...sizes)).toBeLessThanOrEqual(INCOME_MIN_SLICE_SECONDS);
    expect(Math.min(...sizes)).toBeGreaterThan(INCOME_MIN_SLICE_SECONDS / 2 - 1);
    const unreachable = vi.fn(async () => Promise.reject(new MarketplaceProviderError('unreachable')));
    await expect(readHalved(DAY_FROM, DAY_TO, unreachable)).rejects.toMatchObject({ kind: 'unreachable' });
    expect(unreachable).toHaveBeenCalledTimes(1);
  });

  describe('Shopee, a campaign day of 150 orders', () => {
    const CRED = { partnerId: '1000012', partnerKey: 'test-only-partner-key', shopId: '77777', accessToken: 'SHP_access' };
    const SECRET = JSON.stringify(CRED);
    const income = { escrow_amount: '78000.0', original_cost_of_goods_sold: '100000.0', voucher_from_seller: '5000.0', commission_fee: '4000.0', service_fee: '3000.0', seller_transaction_fee: '2000.0', actual_shipping_fee: '8000.0' };
    const provider = (releases: number[]) => {
      const escrows = releases.map((releaseMs, i) => ({ orderSn: `O${String(i).padStart(4, '0')}`, releaseMs, payout: '78000.0', income }));
      const fake = fakeShopee({ ...CRED, escrows, now: () => NOW });
      const options = { fetch: hostBoundFetch(SHOPEE_HOSTS, fake.fetch), now: () => new Date(NOW), spacingMs: 0 };
      const caller = shopeeCaller(options);
      return withShopeeIncome(shopeeMarketplace(options, caller), options, shopeeFinance(options, caller));
    };
    const DAY_START_MS = Date.parse('2026-11-14T17:00:00Z');

    it('reads all 150 as ONE page of the day, every order once, with the list asked for smaller windows', async () => {
      // 150 orders over the afternoon, one every 100 seconds: a day holds more than a list call, any three-hour slice does not.
      const p = provider(Array.from({ length: 150 }, (_, i) => DAY_START_MS + (12 * 3600 + i * 100) * 1000));
      const page = parseMarketplaceIncomePage(await p.listIncome?.(SECRET, 'shopee', 'd:2026-11-15'));
      expect(page?.lines).toHaveLength(150);
      expect(new Set(page?.lines.map((l) => l.orderNo)).size).toBe(150);
      expect(page?.nextCursor).toBe('d:2026-11-16');
    });

    it('stalls visibly when one slice of about an hour still holds more than a list call: too_large, and the poll keeps the cursor', async () => {
      // 150 orders released within the same ten minutes.
      const p = provider(Array.from({ length: 150 }, (_, i) => DAY_START_MS + (12 * 3600 + i * 4) * 1000));
      await expect(p.listIncome?.(SECRET, 'shopee', 'd:2026-11-15')).rejects.toMatchObject({ kind: 'too_large' });
      // What the poll records for that error: the state, with the cursor kept and no file.
      const stalled = setup(async () => Promise.reject(new MarketplaceProviderError('too_large')), { cursor: 'o:2026-11-20T00:00:00.000Z|d:2026-11-15' });
      expect(await stalled.run()).toEqual({ state: 'too_large', orders: 0, staged: false });
      expect(stalled.polls()).toEqual([{ id: CONNECTION, leg: 'income', state: 'too_large' }]);
      expect(stalled.ingests()).toHaveLength(0);
    });
  });
});

describe('a TikTok Shop day read end to end (#4306)', () => {
  const KEY = { appKey: '123abc', appSecret: 'helloworld', accessToken: 'TTP_access_token_1' };
  const CIPHER = 'GCP_XF90igAAAABh00qsWgtvOiGFNqyubMt3';
  const SECRET = JSON.stringify({ ...KEY, shopCipher: CIPHER, shopId: '7000714532876273420' });
  const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const provider = (opts: { statements: Array<Record<string, unknown>>; statementTransactions: Record<string, { currency?: string; transactions: Array<Record<string, unknown>> }> }) => {
    const fake = fakeTiktok({ ...KEY, shops: [fakeShop()], now: () => NOW, payments: [], ...opts });
    const options = { fetch: hostBoundFetch(TIKTOK_HOSTS, fake.fetch), now: () => new Date(NOW), sleep: async () => undefined };
    const caller = tiktokCaller(options);
    return { provider: withTiktokIncome(tiktokMarketplace(options, caller), options, tiktokFinance(options, caller)), fake };
  };

  it('filters transactions by paidAt over the 30-day lookback, ignores busy statements on other days, and writes order adjustments into the CSV', async () => {
    // Generated on 2026-10-25 (inside lookback from 2026-11-15), paid on 2026-11-15.
    const targetStmt = fakeStatement({ id: '723880456409700001', statement_time: sec('2026-10-25T05:00:00Z'), payment_time: sec('2026-11-15T05:00:00Z') });
    // Earlier day statement (2026-11-10, paid 2026-11-10) holding > 3,000 transactions (3,001 > MAX_TRANSACTION_PAGES * 100).
    const busyStmt = fakeStatement({ id: '723880456409700002', statement_time: sec('2026-11-10T05:00:00Z'), payment_time: sec('2026-11-10T05:00:00Z') });
    // Statement paid on 2026-11-14: excluded from 2026-11-15.
    const otherStmt = fakeStatement({ id: '723880456409700003', statement_time: sec('2026-11-13T05:00:00Z'), payment_time: sec('2026-11-14T05:00:00Z') });
    const orderTx = fakeFinanceOrder({ order_id: '576463220456500101' });
    const orderAdj = { id: '163670004141300201', type: 'PLATFORM_PENALTY', adjustment_id: '88001122', adjustment_order_id: '576463220456500101', adjustment_amount: '-15000' };
    const shopAdj = { id: '163670004141300202', type: 'OTHER_ADJUSTMENT', adjustment_id: '88001123', adjustment_amount: '-5000' };
    const reserveTx = { id: '163670004141300203', type: 'RESERVE', adjustment_id: '88001124', reserve_amount: '-20000' };
    const orderReserveTx = { id: '163670004141300204', type: 'RESERVE', adjustment_id: '88001125', adjustment_order_id: '576463220456500101', reserve_amount: '-30000' };
    const otherDayTx = fakeFinanceOrder({ order_id: '576463220456500109' });
    const { provider: p, fake } = provider({
      statements: [targetStmt, busyStmt, otherStmt],
      statementTransactions: {
        '723880456409700001': { transactions: [orderTx, orderAdj, shopAdj, reserveTx, orderReserveTx] },
        '723880456409700002': { transactions: Array.from({ length: 3001 }, () => fakeFinanceOrder()) },
        '723880456409700003': { transactions: [otherDayTx] },
      },
    });

    const page = parseMarketplaceIncomePage(await p.listIncome?.(SECRET, 'tiktok_shop', 'd:2026-11-15'));
    expect(page?.nextCursor).toBe('d:2026-11-16');
    expect(page?.lines).toEqual([
      { orderNo: '576463220456500101', paidAt: '2026-11-15', sales: '120000', sellerDiscount: '10000', commission: '9000', serviceFee: '0', paymentFee: '3000', shipping: '8000', taxWithheld: '0', refund: '0', other: '-8000', net: '82000' },
      { orderNo: '576463220456500101', paidAt: '2026-11-15', sales: '0', sellerDiscount: '0', commission: '0', serviceFee: '0', paymentFee: '0', shipping: '0', taxWithheld: '0', refund: '0', other: '-15000', net: '-15000' },
    ]);
    // Payments API and non-matching statement transactions (including the busy 3,001-tx statement) were never requested.
    expect(fake.calls.some((c) => c.path.includes('/payments'))).toBe(false);
    expect(fake.calls.filter((c) => c.path.includes('/statement_transactions')).map((c) => c.path)).toEqual(['/finance/202501/statements/723880456409700001/statement_transactions']);
    // Writing the CSV and reading it back keeps both the order line and the adjustment line cleanly.
    const grid = parseCsv(marketplaceIncomeCsv('tiktok_shop', page?.lines ?? [], CONNECTION));
    const mapping = findIncomeColumns(grid);
    expect(mapping?.profile.platform).toBe('tiktok_shop');
    const parsed = incomeLines(grid, mapping as NonNullable<typeof mapping>, 100);
    expect(parsed?.skipped).toEqual([]);
    expect(parsed?.lines.map((l) => ({ orderNo: l.orderNo, sales: l.sales, other: l.other, net: l.net }))).toEqual([
      { orderNo: '576463220456500101', sales: '120000', other: '-8000', net: '82000' },
      { orderNo: '576463220456500101', sales: '0', other: '-15000', net: '-15000' },
    ]);
  });

  it('shares the statement cache across days in a poll run without re-reading the full 31-day lookback', async () => {
    // Generated on 2026-10-25 (within day 1's 30-day lookback), paid on day 4 (2026-11-17).
    const earlyStmt = fakeStatement({ id: '723880456409700010', statement_time: sec('2026-10-25T05:00:00Z'), payment_time: sec('2026-11-17T05:00:00Z') });
    const { provider: p, fake } = provider({
      statements: [earlyStmt],
      statementTransactions: { '723880456409700010': { transactions: [fakeFinanceOrder({ order_id: '576463220456500110' })] } },
    });
    const puts: Uint8Array[] = [];
    let cursor: string | null = 'o:2026-11-20T00:00:00.000Z|d:2026-11-14';
    const runtime = {
      query: async (name: string) =>
        name === 'kernel.channel.credential'
          ? { provider: 'marketplace_tiktok_shop', externalAccountId: 'shop', keyId: 'k', envelope: Buffer.from('e').toString('base64') }
          : name === 'finance.marketplace_connection.last_settlement_end'
            ? null
            : {
                action: 'poll',
                id: CONNECTION,
                channelConnectionId: '33333333-3333-4333-8333-333333333333',
                adapter: 'tiktok_shop',
                platform: 'tiktok_shop',
                legalEntityId: '44444444-4444-4444-8444-444444444444',
                cursor,
                lastPollState: 'ok',
                lastPolledAt: null,
                lastIncomePollState: null,
                lastIncomePolledAt: null,
                createdAt: '2026-10-01T00:00:00.000Z',
              },
      execute: async (name: string, input: Record<string, unknown>) => {
        if (name === 'finance.marketplace_connection.record_poll' && typeof input.cursor === 'string') cursor = input.cursor;
        return name === 'finance.marketplace_connection.ingest_page' ? { fileId: '55555555-5555-4555-8555-555555555555', duplicate: false } : {};
      },
    } as unknown as Runtime;
    const store = {
      put: async (_key: string, bytes: Uint8Array) => {
        puts.push(bytes);
        return `content:${sha256Hex(bytes)}`;
      },
    } as unknown as BlobStore;
    const tiktokProvider: MarketplaceProvider = {
      ...p,
      listOrders: async () => ({ orders: [], nextCursor: null }),
    };
    const deps = { runtime, broker: { open: () => SECRET } as unknown as CredentialBroker, store, providers: { tiktok_shop: tiktokProvider } };
    // Run starting at 2026-11-14 through 2026-11-17 (4 days before hitting the 2026-11-19 cutoff? NOW is 2026-11-21, so 2026-11-14..2026-11-18 = 5 days).
    await runMarketplacePoll(deps, { orgId: ORG, connectionId: CONNECTION }, 5, () => new Date(NOW));

    const statementCalls = fake.calls.filter((c) => c.path === '/finance/202309/statements');
    expect(statementCalls).toHaveLength(5);
    // Only the first call spans 31 days; the remaining 4 catch-up days read only 1 incremental day each.
    const spans = statementCalls.map((c) => (Number(c.query.statement_time_lt) - Number(c.query.statement_time_ge)) / 86_400);
    expect(spans).toEqual([31, 1, 1, 1, 1]);
    // The 2026-10-25 statement captured on day 1 is still matched from cache on day 4 (2026-11-17) and staged.
    expect(puts).toHaveLength(1);
    expect(new TextDecoder().decode(puts[0])).toContain('576463220456500110');
    expect(cursor).toBe('o:2026-11-20T00:00:00.000Z|d:2026-11-19');
  });

  it('refuses a cached statement window that exceeds TIKTOK_FINANCE_MAX_STATEMENTS or repeats a statement id (#4306)', async () => {
    const cache = new Map<string, unknown>();
    // 100 statements on day 1 (legal) + 1 more on day 2 = 101 > TIKTOK_FINANCE_MAX_STATEMENTS.
    const day1Statements = Array.from({ length: TIKTOK_FINANCE_MAX_STATEMENTS }, (_, i) =>
      fakeStatement({ id: `72388045640971${String(i).padStart(4, '0')}`, statement_time: sec('2026-11-01T05:00:00Z'), payment_time: sec('2026-11-02T05:00:00Z') }),
    );
    const day2Statement = fakeStatement({ id: '723880456409719999', statement_time: sec('2026-11-15T05:00:00Z'), payment_time: sec('2026-11-15T05:00:00Z') });
    const overLimit = provider({ statements: [...day1Statements, day2Statement], statementTransactions: {} }).provider;
    expect((await overLimit.listIncome?.(SECRET, 'tiktok_shop', 'd:2026-11-14', { cache }))?.nextCursor).toBe('d:2026-11-15');
    await expect(overLimit.listIncome?.(SECRET, 'tiktok_shop', 'd:2026-11-15', { cache })).rejects.toMatchObject({ kind: 'not_recognized' });

    // A statement id repeated across two separate day fetches fails as not_recognized rather than deduping silently.
    const dupCache = new Map<string, unknown>();
    const baseOptions = { fetch: hostBoundFetch(TIKTOK_HOSTS, async () => new Response('')), now: () => new Date(NOW), sleep: async () => undefined };
    let callIdx = 0;
    const dupFinance = {
      statements: async () => [{ id: 'dup-1', day: '2026-11-15', payout: '1000', status: 'PAID', paymentId: 'p1', paidDay: '2026-11-15' }],
      payments: async () => [],
      income: async () => {
        callIdx += 1;
        return {
          currency: 'VND' as const,
          statements: callIdx === 1 ? [{ id: 'dup-1', day: '2026-11-10', payout: '1000', status: 'PAID', paymentId: 'p1', paidDay: '2026-11-10' }] : [],
          payments: null,
          lines: [],
          adjustments: [],
          pendingStatements: 0,
        };
      },
    };
    const dupProvider = withTiktokIncome(tiktokMarketplace(baseOptions), baseOptions, dupFinance);
    await dupProvider.listIncome?.(SECRET, 'tiktok_shop', 'd:2026-11-14', { cache: dupCache });
    await expect(dupProvider.listIncome?.(SECRET, 'tiktok_shop', 'd:2026-11-15', { cache: dupCache })).rejects.toMatchObject({ kind: 'not_recognized' });
  });
});

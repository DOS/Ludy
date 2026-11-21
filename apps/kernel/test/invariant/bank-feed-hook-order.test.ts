// SPDX-License-Identifier: AGPL-3.0-only
// The hook route of a bank feed (Tingee, #4203) limits the address, then caps the body, and only then looks a key up (the order the webhook route of #4047 holds): hono's bodyLimit reads a body sent without a
// Content-Length (a chunked one) up to the cap before it calls the next handler, so a limiter inside the handler would refuse an address only after its body was read, and a lookup that ran first would let an address
// ask the database about keys without limit. The runtime and the adapter are fakes: nothing here needs a database. Keep this directory self-contained: no imports from outside test/invariant/ besides the app's own source.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { BankFeedProvider } from '@ludy/bank-feed';
import type { BlobStore, Runtime } from '@ludy/kernel-runtime';
import { loadConfig } from '../../src/config.ts';
import { createHttpApp } from '../../src/http.ts';
import { RateLimiter } from '../../src/rate-limit.ts';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const PATH = `/api/bank-feed/fake/webhook/${KEY}`;

function fixture(perMinute: number) {
  const lookups: string[] = [];
  const runtime = {
    installed: (name: string) => name === 'kernel' || name === 'finance',
    modules: () => ['kernel', 'finance'],
    // Any use of the database is recorded: a request that did not pass the limit and the cap must never get here.
    orgless: async () => {
      lookups.push('orgless');
      throw new Error('the database must not be reached by a refused request');
    },
  } as unknown as Runtime;
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' });
  const provider = { id: 'fake', hookTimestampFresh: () => true, verifyHook: () => 'ok' } as unknown as BankFeedProvider;
  const http = createHttpApp({
    config,
    runtime,
    store: {} as BlobStore,
    authenticate: (async () => {
      throw new Error('a notice must not authenticate a user');
    }) as never,
    pool: {} as pg.Pool,
    aiEnabled: false,
    bankFeedHooks: { fake: provider },
    bankFeedHookLimit: new RateLimiter({ perMinute }),
  });
  return { http, lookups };
}

describe('the bank feed hook route: limit, then cap, then lookup', () => {
  it('refuses a chunked body from a limited address without reading it or touching the database', async () => {
    const { http, lookups } = fixture(1);
    // The first request takes the one allowed token (whatever its answer; the lookup is refused by the fake).
    await http.request(PATH, { method: 'POST', body: 'x' });
    lookups.length = 0;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        if (pulled > 3) controller.close();
      },
    });
    const response = await http.request(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(429);
    expect(pulled).toBeLessThanOrEqual(1);
    expect(lookups).toEqual([]);
  });

  it('refuses a body over the cap before any lookup', async () => {
    const { http, lookups } = fixture(100);
    const response = await http.request(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(16 * 1024 + 1) });
    expect(response.status).toBe(413);
    expect(lookups).toEqual([]);
  });

  it('answers an unknown adapter 404 without using a token of the address or looking anything up', async () => {
    const { http, lookups } = fixture(1);
    expect((await http.request(`/api/bank-feed/nobody/webhook/${KEY}`, { method: 'POST', body: 'x' })).status).toBe(404);
    expect(lookups).toEqual([]);
    // The one token of the address is still there for a known adapter (the route reached the lookup, which the fake refuses).
    expect((await http.request(PATH, { method: 'POST', body: 'x' })).status).not.toBe(429);
  });
});

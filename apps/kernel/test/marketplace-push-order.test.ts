// SPDX-License-Identifier: AGPL-3.0-only
// The marketplace push route (#4346) limits the address, then caps the body, and only then looks a key up, the order the bank feed routes hold (#4047, #4203): hono's bodyLimit reads a body sent without a Content-Length
// (a chunked one) up to the cap before it calls the next handler, so a limiter inside the handler would refuse an address only after its body was read, and a lookup that ran first would let an address ask the database about
// keys without limit. Unlike the bank feed, an address over its limit is answered with an EMPTY 200, never a 429 (Shopee disables a subscription below 30% success). The runtime is a fake: nothing here needs a database.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { BlobStore, Runtime } from '@ludy/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const PATH = `/api/marketplace/tiktok_shop/webhook/${KEY}`;
const AUTH = { authorization: 'a'.repeat(64) };

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
  const http = createHttpApp({
    config,
    runtime,
    store: {} as BlobStore,
    authenticate: (async () => {
      throw new Error('a push must not authenticate a user');
    }) as never,
    pool: {} as pg.Pool,
    aiEnabled: false,
    marketplacePush: { adapters: ['tiktok_shop'], limit: new RateLimiter({ perMinute }) },
  });
  return { http, lookups };
}

describe('the marketplace push route: limit, then cap, then lookup', () => {
  it('answers an empty 200, not a 429, to a limited address without reading its chunked body or touching the database', async () => {
    const { http, lookups } = fixture(1);
    // The first request takes the one allowed token; it passes the limit, reaches the lookup and the fake refuses it (an error answer).
    await http.request(PATH, { method: 'POST', headers: AUTH, body: 'x' });
    lookups.length = 0;
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        if (pulled > 3) controller.close();
      },
    });
    const response = await http.request(PATH, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(pulled).toBeLessThanOrEqual(1);
    expect(lookups).toEqual([]);
  });

  it('answers an empty 200 to a body over the cap before any lookup', async () => {
    const { http, lookups } = fixture(100);
    const response = await http.request(PATH, { method: 'POST', headers: { ...AUTH, 'content-type': 'application/json' }, body: 'x'.repeat(16 * 1024 + 1) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(lookups).toEqual([]);
  });

  it('answers 404 to an adapter that is not run and to a key of the wrong shape without using a token of the address or looking anything up', async () => {
    const { http, lookups } = fixture(1);
    expect((await http.request(`/api/marketplace/lazada/webhook/${KEY}`, { method: 'POST', headers: AUTH, body: 'x' })).status).toBe(404);
    expect((await http.request('/api/marketplace/tiktok_shop/webhook/short', { method: 'POST', headers: AUTH, body: 'x' })).status).toBe(404);
    expect(lookups).toEqual([]);
    // The one token of the address is still there for a real request (it reaches the lookup, which the fake refuses with an error).
    const reached = await http.request(PATH, { method: 'POST', headers: AUTH, body: 'x' });
    expect(reached.status).toBe(500);
    expect(lookups).toEqual(['orgless']);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The bank feed notice route limits the address before the body cap reads a body (#4047): hono's bodyLimit reads a body sent without a Content-Length (a chunked one) up to the cap before it calls
// the next handler, so a limiter that ran inside the handler refused an address only after its body was read. The runtime and the adapter are fakes: nothing here needs a database.
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import type { BankFeedProvider } from '@crove/bank-feed';
import type { BlobStore, Runtime } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { RateLimiter } from '../src/rate-limit.ts';

const PATH = '/api/bank-feed/fake/webhook';

function fixture(perMinute: number) {
  const runtime = { installed: (name: string) => name === 'kernel' || name === 'finance', modules: () => ['kernel', 'finance'] } as unknown as Runtime;
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' });
  // An adapter that refuses every notice as malformed, so a request that passes the limit is answered 400 without a database.
  const provider = {
    id: 'fake',
    verifyWebhook: () => {
      throw Object.assign(new Error('x'), { name: 'BankFeedWebhookRejected' });
    },
  } as unknown as BankFeedProvider;
  return createHttpApp({
    config,
    runtime,
    store: {} as BlobStore,
    authenticate: (async () => {
      throw new Error('a notice must not authenticate a user');
    }) as never,
    pool: {} as pg.Pool,
    aiEnabled: false,
    bankFeedWebhooks: { fake: provider },
    bankFeedWebhookLimit: new RateLimiter({ perMinute }),
  });
}

describe('the bank feed notice route: limit, then cap, then handler', () => {
  it('refuses a chunked body from a limited address without reading it', async () => {
    const http = fixture(1);
    // The first request takes the one allowed token (whatever its answer).
    await http.request(PATH, { method: 'POST', body: 'x' });
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
    // A stream is primed with one chunk when it is made; a refused address must not read on from there.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('answers an unknown adapter 404 without using a token of the address', async () => {
    const http = fixture(1);
    expect((await http.request('/api/bank-feed/nobody/webhook', { method: 'POST', body: 'x' })).status).toBe(404);
    expect((await http.request('/api/bank-feed/nobody/webhook', { method: 'POST', body: 'x' })).status).toBe(404);
    // The one token is still there: the first real request is not limited.
    expect((await http.request(PATH, { method: 'POST', body: 'x' })).status).not.toBe(429);
    expect((await http.request(PATH, { method: 'POST', body: 'x' })).status).toBe(429);
  });
});

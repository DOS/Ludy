// SPDX-License-Identifier: AGPL-3.0-only
// The Threads reply webhook without a database (issue #3133): the same route and verify token as the Page webhook, signed with the Threads
// app's secret. A notice is taken in only when the secret of its own product verified it, and what is parked is the raw body under the
// provider `threads`. The runtime is a fake that records the call the route makes to park a notice.
import { createHmac } from 'node:crypto';
import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import { describe, expect, it } from 'vitest';
import type { Runtime } from '@crove/kernel-runtime';
import { FacebookReplayCache, acceptFacebookWebhook } from '../src/facebook-webhook.ts';
import { NOTICE_PARSERS } from '../src/conversations-worker.ts';

const PAGES = 'a'.repeat(32);
const THREADS = 't'.repeat(32);
const USER = '17841400000000777';
const NOW = Date.parse('2026-11-13T12:00:00Z');
const sign = (body: string, secret: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function fakeRuntime() {
  const parked: { sql: string; provider: unknown }[] = [];
  const db = new Kysely<unknown>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (event) => {
      if (event.level === 'query') parked.push({ sql: event.query.sql, provider: event.query.parameters[0] });
    },
  });
  return { parked, runtime: { orgless: async (fn: (d: Kysely<unknown>) => Promise<unknown>) => fn(db) } as unknown as Runtime };
}

const notice = (object: string) =>
  JSON.stringify({
    object,
    entry: [{ id: USER, time: NOW / 1000, changes: [{ field: 'replies', value: { id: '18100000000000010', text: 'Còn size M không shop?', username: 'khach.hang', timestamp: NOW / 1000 - 30, root_post: { id: '18000000000000001' }, replied_to: { id: '18000000000000001' } } }] }],
  });
const config = { appSecret: PAGES, threadsAppSecret: THREADS, now: () => NOW };
const send = (runtime: Runtime, body: string, secret: string, cache?: FacebookReplayCache) => acceptFacebookWebhook(runtime, config, { signature: sign(body, secret), body: new TextEncoder().encode(body) }, cache);

describe('the Threads reply webhook (#3133)', () => {
  it('parks a reply notice signed with the Threads secret under the provider threads, once per reply', async () => {
    const { parked, runtime } = fakeRuntime();
    const cache = new FacebookReplayCache(() => NOW);
    expect(await send(runtime, notice('threads'), THREADS, cache)).toEqual({ status: 200, parked: true });
    expect(parked).toHaveLength(1);
    expect(parked[0]?.sql).toContain('conversation_inbound_enqueue');
    expect(parked[0]?.provider).toBe('threads');
    // The same reply again, as Meta retries it, is acknowledged and not parked a second time.
    expect(await send(runtime, notice('threads'), THREADS, cache)).toEqual({ status: 200, parked: false });
    expect(parked).toHaveLength(1);
  });

  it('refuses a wrong signature, and reads a notice only as the product whose secret signed it', async () => {
    const { parked, runtime } = fakeRuntime();
    expect(await send(runtime, notice('threads'), 'wrong-secret-0123456789abcdef')).toEqual({ status: 401, code: 'WEBHOOK_SIGNATURE' });
    // A Threads object signed with the Pages secret, and a Page object signed with the Threads secret, are acknowledged and never parked.
    expect(await send(runtime, notice('threads'), PAGES)).toEqual({ status: 200, parked: false });
    expect(await send(runtime, notice('page'), THREADS)).toEqual({ status: 200, parked: false });
    expect(parked).toEqual([]);
    // Without a Threads secret configured nothing is read as Threads.
    const body = notice('threads');
    expect(await acceptFacebookWebhook(runtime, { appSecret: PAGES, now: () => NOW }, { signature: sign(body, THREADS), body: new TextEncoder().encode(body) })).toEqual({ status: 401, code: 'WEBHOOK_SIGNATURE' });
  });

  it('is acknowledged without a Pages app, and a body the parser cannot read is refused', async () => {
    const { parked, runtime } = fakeRuntime();
    const body = notice('threads');
    expect(await acceptFacebookWebhook(runtime, { appSecret: '', threadsAppSecret: THREADS, now: () => NOW }, { signature: sign(body, THREADS), body: new TextEncoder().encode(body) })).toEqual({ status: 200, parked: true });
    expect(parked).toHaveLength(1);
    expect(await send(runtime, '{"entry":[]}', THREADS)).toEqual({ status: 400, code: 'WEBHOOK_MALFORMED' });
  });

  it('is read by the worker with the Threads parser', () => {
    const parsed = NOTICE_PARSERS.threads?.(new TextEncoder().encode(notice('threads')));
    expect(Array.isArray(parsed) ? parsed[0]?.accountId : (parsed as { accountId?: string } | undefined)?.accountId).toBe(USER);
  });
});

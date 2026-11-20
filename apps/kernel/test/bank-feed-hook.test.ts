// SPDX-License-Identifier: AGPL-3.0-only
// The webhook of a bank feed whose provider signs with each customer's own secret (Tingee; #4203, S3 of #2045), through the real HTTP app without a database: the route exists only with a hook adapter and Finance, an
// address of the wrong shape or an unknown key stores nothing (404), the headers and the timestamp window are checked before anything is looked up, a good notice is stored raw for the worker with the org taken from OUR hook
// row (the SQL carries the hook's id and never the key or an id from the body), a repeat is a no-op, a stopped hook acknowledges and stores nothing, the budget per hook and the body cap hold, and nothing of a key, a
// signature or a body is logged. The worker's verification is tested below with a real adapter and a fake broker. The definers and the relay on a real database are in bank-feed-hook.db.test.ts.
import { createHash } from 'node:crypto';
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type Driver, type QueryResult } from 'kysely';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bankFeedHostedProviders, signTingeeRequest, vietnamStamp, type BankFeedProvider } from '@crove/bank-feed';
import { DomainError, type BlobStore, type CredentialBroker, type Runtime } from '@crove/kernel-runtime';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
import { MAX_BANK_FEED_HOOK_BYTES, bankFeedHookKeyHash, verifyBankFeedHookNotices, type BankFeedHookNoticeRow } from '../src/bank-feed-hook.ts';
import { RateLimiter } from '../src/rate-limit.ts';

const KEY = 'AbCdEfGhIjKlMnOpQrStUv';
const HOOK = '0192b2c0-0000-7000-8000-00000000aaaa';
const CLIENT = 'client-id-for-tests';
const SECRET = 'tingee-secret-token-for-tests-0123456789';
const PATH = `/api/bank-feed/bank_tingee/webhook/${KEY}`;
const tingee = bankFeedHostedProviders({ tingee: true, uat: false }).bank_tingee as BankFeedProvider;

type Seen = { sql: string; parameters: readonly unknown[] };
// A Kysely whose driver records each query and answers the two definers by their name.
function dbOf(seen: Seen[], answers: { lookup: Array<{ hook_id: string; standing: string }>; put: string }) {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      seen.push({ sql: query.sql, parameters: query.parameters });
      if (query.sql.includes('bank_feed_hook_lookup')) return { rows: answers.lookup as unknown as R[] };
      if (query.sql.includes('bank_feed_hook_put_notice')) return { rows: [{ put: answers.put }] as unknown as R[] };
      throw new Error(`unexpected SQL: ${query.sql}`);
    },
    streamQuery: async function* () {
      yield* [];
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  return new Kysely<unknown>({ dialect: { createAdapter: () => new PostgresAdapter(), createDriver: () => driver, createIntrospector: (k) => new PostgresIntrospector(k), createQueryCompiler: () => new PostgresQueryCompiler() } });
}

function fixture(over: Partial<HttpDeps> = {}, answers: { lookup?: Array<{ hook_id: string; standing: string }>; put?: string } = {}, installed: readonly string[] = ['kernel', 'finance']) {
  const seen: Seen[] = [];
  const db = dbOf(seen, { lookup: answers.lookup ?? [{ hook_id: HOOK, standing: 'ok' }], put: answers.put ?? 'accepted' });
  const runtime = {
    installed: (name: string) => installed.includes(name),
    modules: () => [...installed],
    orgless: async (fn: (d: Kysely<unknown>) => Promise<unknown>) => fn(db),
    execute: async () => {
      throw new Error('the API must not execute a command for a notice');
    },
  } as unknown as Runtime;
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' });
  const authenticate = vi.fn(async () => {
    throw new Error('a notice must not authenticate a user');
  });
  const http = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: authenticate as never, pool: {} as pg.Pool, aiEnabled: false, bankFeedHooks: { bank_tingee: tingee }, ...over });
  const body = JSON.stringify({ clientId: CLIENT, transactionId: 'T1', amount: 100000 });
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'content-type': 'application/json',
    'x-request-id': 'req-0001',
    'x-request-timestamp': vietnamStamp(new Date(), true),
    'x-signature': 'f'.repeat(128),
    ...extra,
  });
  const post = (init: { path?: string; body?: string; headers?: Record<string, string> } = {}) =>
    http.request(init.path ?? PATH, { method: 'POST', headers: init.headers ?? headers(), body: init.body ?? body });
  return { http, post, seen, headers, body, authenticate };
}

const logged: string[] = [];
beforeEach(() => {
  logged.length = 0;
  for (const method of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')));
});
afterEach(() => vi.restoreAllMocks());

describe('the hook route of a bank feed (Tingee webhook)', () => {
  it('exists only with a hook adapter and the Finance module', async () => {
    // Without the route a POST to the path falls through to the session check of /api/* (the fake refuses it) and reaches nothing.
    const none = fixture({ bankFeedHooks: {} });
    expect((await none.post()).status).not.toBe(200);
    expect(none.authenticate).toHaveBeenCalled();
    expect(none.seen).toEqual([]);
    const noFinance = fixture({}, {}, ['kernel']);
    expect((await noFinance.post()).status).not.toBe(200);
    expect(noFinance.authenticate).toHaveBeenCalled();
    expect(noFinance.seen).toEqual([]);
    const on = fixture();
    expect((await on.post()).status).toBe(200);
    expect(on.authenticate).not.toHaveBeenCalled();
  });

  it('answers an unknown provider and a key of the wrong shape 404 and looks nothing up', async () => {
    const on = fixture();
    expect((await on.post({ path: `/api/bank-feed/bank_other/webhook/${KEY}` })).status).toBe(404);
    for (const bad of ['short', `${KEY}x`, 'AbCdEfGhIjKlMnOpQrSt!!', 'a'.repeat(200)]) expect((await on.post({ path: `/api/bank-feed/bank_tingee/webhook/${encodeURIComponent(bad)}` })).status, bad).toBe(404);
    expect(on.seen).toEqual([]);
  });

  it('answers an unknown key 404 and stores nothing: one lookup, no put', async () => {
    const on = fixture({}, { lookup: [] });
    expect((await on.post()).status).toBe(404);
    expect(on.seen).toHaveLength(1);
    expect(on.seen[0]?.sql).toContain('bank_feed_hook_lookup');
  });

  it('stores a good notice raw for the worker, the hook found by the hash of the key, and answers the provider\'s success body', async () => {
    const on = fixture();
    const response = await on.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: '00', message: 'Success' });
    expect(on.seen).toHaveLength(2);
    // The lookup carries the provider's id and the SHA-256 of the key, never the key.
    expect(on.seen[0]?.parameters).toEqual(['bank_tingee', createHash('sha256').update(KEY).digest('hex')]);
    expect(bankFeedHookKeyHash(KEY)).toBe(on.seen[0]?.parameters[1]);
    // The put carries the hook's id, the request id, the timestamp and signature as sent, and the raw body: no org id, nothing from the body is read.
    expect(on.seen[1]?.parameters).toEqual([HOOK, 'req-0001', expect.stringMatching(/^\d{17}$/), 'f'.repeat(128), on.body]);
    expect(JSON.stringify(on.seen)).not.toContain(KEY);
    expect(on.authenticate).not.toHaveBeenCalled();
  });

  it('takes the org from its own hook row: a body that names another client or account changes nothing in what is stored', async () => {
    const on = fixture();
    const forged = JSON.stringify({ clientId: 'another-merchant', accountNumber: '9999', orgId: '11111111-1111-1111-1111-111111111111' });
    expect((await on.post({ body: forged })).status).toBe(200);
    const put = on.seen[1];
    expect(put?.parameters).toHaveLength(5);
    expect(put?.parameters[0]).toBe(HOOK);
    expect(put?.sql).not.toContain('org_id');
    expect(put?.parameters).not.toContain('11111111-1111-1111-1111-111111111111');
  });

  it('answers a repeat of the request id 200 (the definer says duplicate), and a stopped hook 200 with nothing stored', async () => {
    const dup = fixture({}, { put: 'duplicate' });
    expect((await dup.post()).status).toBe(200);
    const stopped = fixture({}, { lookup: [{ hook_id: HOOK, standing: 'stopped' }] });
    expect((await stopped.post()).status).toBe(200);
    expect(stopped.seen).toHaveLength(1);
    expect(stopped.seen[0]?.sql).toContain('bank_feed_hook_lookup');
  });

  it('answers a hook that is busy 503 and one that is gone 404', async () => {
    expect((await fixture({}, { put: 'busy' }).post()).status).toBe(503);
    expect((await fixture({}, { put: 'gone' }).post()).status).toBe(404);
  });

  it('checks the headers and the timestamp window before it looks anything up', async () => {
    const on = fixture();
    const stale = await on.post({ headers: on.headers({ 'x-request-timestamp': vietnamStamp(new Date(Date.now() - 11 * 60_000), true) }) });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toEqual({ code: 'WEBHOOK_STALE' });
    expect((await on.post({ headers: on.headers({ 'x-request-timestamp': vietnamStamp(new Date(Date.now() + 5 * 60_000), true) }) })).status).toBe(400);
    for (const missing of ['x-request-id', 'x-request-timestamp', 'x-signature']) {
      const headers = on.headers();
      delete headers[missing];
      const response = await on.post({ headers });
      expect(response.status, missing).toBe(400);
      expect(await response.json()).toEqual({ code: 'WEBHOOK_MALFORMED' });
    }
    expect((await on.post({ headers: on.headers({ 'x-request-id': 'r'.repeat(101) }) })).status).toBe(400);
    expect((await on.post({ body: '' })).status).toBe(400);
    expect(on.seen).toEqual([]);
  });

  it('answers the portal\'s address check for a known key without storing anything, and an unknown key 404', async () => {
    const on = fixture();
    const check = await on.post({ headers: { 'content-type': 'application/json', 'webhook-type': 'url-validation' }, body: '{}' });
    expect(check.status).toBe(200);
    expect(on.seen).toHaveLength(1);
    expect(on.seen[0]?.sql).toContain('bank_feed_hook_lookup');
    const unknown = fixture({}, { lookup: [] });
    expect((await unknown.post({ headers: { 'content-type': 'application/json', 'webhook-type': 'url-validation' }, body: '{}' })).status).toBe(404);
  });

  it('caps the body before reading it, and limits the address and each hook', async () => {
    const on = fixture();
    const big = await on.post({ body: 'x'.repeat(MAX_BANK_FEED_HOOK_BYTES + 1) });
    expect(big.status).toBe(413);
    expect(on.seen).toEqual([]);
    const address = fixture({ bankFeedHookLimit: new RateLimiter({ perMinute: 2 }) });
    expect((await address.post()).status).toBe(200);
    expect((await address.post()).status).toBe(200);
    const limited = await address.post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
    const budget = fixture({ bankFeedHookBudget: new RateLimiter({ perMinute: 1 }) });
    expect((await budget.post()).status).toBe(200);
    const over = await budget.post({ headers: budget.headers({ 'x-request-id': 'req-0002' }) });
    expect(over.status).toBe(429);
    // The refused notice was looked up but not stored.
    expect(budget.seen.filter((s) => s.sql.includes('bank_feed_hook_put_notice'))).toHaveLength(1);
  });

  it('logs nothing of the key, the signature or the body, whatever the answer', async () => {
    const on = fixture();
    await on.post();
    await on.post({ path: `/api/bank-feed/bank_tingee/webhook/${'Z'.repeat(22)}`, headers: on.headers({ 'x-signature': 's'.repeat(128) }) });
    await fixture({}, { lookup: [] }).post();
    const text = logged.join('\n');
    for (const secret of [KEY, 'f'.repeat(128), 's'.repeat(128), CLIENT, 'T1']) expect(text).not.toContain(secret);
  });
});

// The worker's check of the claimed notices, with the real adapter and a fake broker and runtime.
describe('the worker verification of claimed notices', () => {
  const stamp = vietnamStamp(new Date(), true);
  const body = JSON.stringify({ clientId: CLIENT, transactionId: 'T1', amount: 100000 });
  const row = (over: Partial<BankFeedHookNoticeRow> = {}): BankFeedHookNoticeRow => ({
    orgId: 'org-1',
    hookId: HOOK,
    connectionId: 'conn-1',
    provider: 'bank_tingee',
    requestId: 'req-1',
    timestamp: stamp,
    signature: signTingeeRequest(SECRET, stamp, body),
    body,
    ...over,
  });
  function deps(over: { credential?: () => Promise<unknown>; secret?: string } = {}) {
    const queries: string[] = [];
    const opened: string[] = [];
    const rejected: string[] = [];
    const runtime = {
      query: async (name: string, input: { connectionId: string }) => {
        queries.push(`${name}:${input.connectionId}`);
        if (over.credential) return over.credential();
        return { provider: 'bank_tingee', externalAccountId: CLIENT, keyId: 'k1', envelope: Buffer.from('x').toString('base64') };
      },
    } as unknown as Runtime;
    const broker = {
      id: 'test',
      open: (_sealed: unknown, binding: { orgId: string }) => {
        opened.push(binding.orgId);
        return over.secret ?? JSON.stringify({ clientId: CLIENT, secretToken: SECRET });
      },
    } as unknown as CredentialBroker;
    return { queries, opened, rejected, d: { runtime, broker, providers: { bank_tingee: tingee }, reject: async (hookId: string) => void rejected.push(hookId) } };
  }

  it('verifies a good notice, counts a bad signature and a body naming another client against the hook, and drops what it cannot read', async () => {
    const { d, rejected } = deps();
    const verdicts = await verifyBankFeedHookNotices(d, [
      row(),
      row({ signature: signTingeeRequest('another-secret', stamp, body), requestId: 'req-2' }),
      (() => {
        const other = JSON.stringify({ clientId: 'someone-else' });
        return row({ body: other, signature: signTingeeRequest(SECRET, stamp, other), requestId: 'req-3' });
      })(),
      (() => {
        const odd = JSON.stringify({ transactionId: 'T9' });
        return row({ body: odd, signature: signTingeeRequest(SECRET, stamp, odd), requestId: 'req-4' });
      })(),
      row({ provider: 'bank_nobody', requestId: 'req-5' }),
    ]);
    expect(verdicts).toEqual(['ok', 'refused', 'refused', 'dropped', 'dropped']);
    // Two refusals are counted on the hook; a signed body the adapter does not read and an adapter that is not there are not.
    expect(rejected).toEqual([HOOK, HOOK]);
  });

  it('opens a connection\'s secret once for the batch', async () => {
    const { d, queries, opened } = deps();
    await verifyBankFeedHookNotices(d, [row(), row({ requestId: 'req-2' }), row({ requestId: 'req-3' })]);
    expect(queries).toEqual(['kernel.channel.credential:conn-1']);
    expect(opened).toEqual(['org-1']);
    const two = deps();
    await verifyBankFeedHookNotices(two.d, [row(), row({ connectionId: 'conn-2', requestId: 'req-2' })]);
    expect(two.queries).toEqual(['kernel.channel.credential:conn-1', 'kernel.channel.credential:conn-2']);
  });

  it('drops a notice of a connection whose owner left, that is closed or whose credential cannot be read, so one broken credential never holds back the others', async () => {
    for (const code of ['CHANNEL_OWNER_LEFT', 'CHANNEL_NOT_ACTIVE']) {
      const { d, rejected } = deps({ credential: async () => Promise.reject(new DomainError(code, 409, 'no')) });
      expect(await verifyBankFeedHookNotices(d, [row()])).toEqual(['dropped']);
      expect(rejected).toEqual([]);
    }
    // Any other failure of that connection's credential (a retired key, an envelope that will not open, a missing row) is dropped too, and the next connection's notice is still checked.
    let calls = 0;
    const mixed = deps({
      credential: async () => {
        calls++;
        if (calls === 1) throw new Error('key retired');
        return { provider: 'bank_tingee', externalAccountId: CLIENT, keyId: 'k1', envelope: Buffer.from('x').toString('base64') };
      },
    });
    const verdicts = await verifyBankFeedHookNotices(mixed.d, [row(), row({ connectionId: 'conn-2', requestId: 'req-2' })]);
    expect(verdicts[0]).toBe('dropped');
    expect(verdicts).toHaveLength(2);
    expect(mixed.rejected).toEqual([]);
  });

  it('does not count a notice against its hook when the stored credential cannot be read', async () => {
    const { d, rejected } = deps({ secret: 'not json' });
    expect(await verifyBankFeedHookNotices(d, [row()])).toEqual(['dropped']);
    expect(rejected).toEqual([]);
  });

  it('answers a database failure 500 and logs only the error name, never a DETAIL that quotes the notice', async () => {
    const detail = `Key (body)=(${JSON.stringify({ clientId: CLIENT, transactionId: 'T1' })}) violates a constraint`;
    const on = fixture({
      runtime: {
        installed: () => true,
        modules: () => ['kernel', 'finance'],
        orgless: async () => {
          throw new Error(detail);
        },
      } as unknown as Runtime,
    });
    const response = await on.post();
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'INTERNAL' });
    const text = logged.join('\n');
    expect(text).toContain('bank-feed-hook');
    for (const secret of [KEY, CLIENT, 'T1', 'violates']) expect(text).not.toContain(secret);
  });
});

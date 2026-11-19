// SPDX-License-Identifier: AGPL-3.0-only
// MISA AMIS's callback route through the real HTTP app, without a database (#3903, S4 of #3854): the route exists only with the ClientID and the Finance module, the address is limited and the body capped before
// the body is read, a message with a bad signature changes nothing and touches nothing, a verified message only hands its signed results to the machinery table (one orgless call; the API records nothing and reads
// no tenant row) and is always answered the same, the unsigned fields are not passed on, and nothing of a body, a signature, MISA's text or the ClientID reaches a log. The runtime is a fake: its orgless call
// records the SQL and the parameters the route sends. The definers and the relay on a real database are tested in misa-amis-callback.db.test.ts, the relay's decisions in misa-amis-callback-relay.test.ts.
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type Driver, type QueryResult } from 'kysely';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlobStore, Runtime } from '@ludy/kernel-runtime';
import { signCallbackData } from '@ludy/misa-amis';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
import { MAX_MISA_AMIS_CALLBACK_BYTES } from '../src/misa-amis-callback.ts';
import { RateLimiter } from '../src/rate-limit.ts';

const CLIENT = 'misa-client-id-0001';
const CODE = `ludy-${'a'.repeat(32)}`;
const OTHER_CODE = `ludy-${'b'.repeat(32)}`;
const PATH = '/api/webhooks/misa-amis';
const REF1 = randomUUID();
const REF2 = randomUUID();
const REF3 = randomUUID();
const REASON_TEXT = 'LOI-RIENG-CUA-MISA-0042';

// A Kysely whose driver records every query (SQL and parameters) and fails when told to.
function dbOf(seen: { sql: string; parameters: readonly unknown[] }[], failure?: unknown) {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      seen.push({ sql: query.sql, parameters: query.parameters });
      if (failure) throw failure;
      return { rows: [{ misa_amis_callback_enqueue: 1 }] as unknown as R[] };
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

function fixture(over: Partial<HttpDeps> = {}, installed: readonly string[] = ['kernel', 'finance'], failure?: unknown) {
  const sqlSeen: { sql: string; parameters: readonly unknown[] }[] = [];
  const executed: string[] = [];
  const runtime = {
    installed: (name: string) => installed.includes(name),
    modules: () => [...installed],
    orgless: async (fn: (d: Kysely<unknown>) => Promise<unknown>) => fn(dbOf(sqlSeen, failure)),
    // The API cannot enter a system context: a command run here is a bug.
    execute: async (name: string) => {
      executed.push(name);
      throw new Error('the API must not execute a command for a callback');
    },
  } as unknown as Runtime;
  const config = loadConfig({ DATABASE_URL: 'postgres://localhost/x', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_ISSUER: 'crove-auth', WEB_DIST: '/nonexistent' });
  const authenticate = vi.fn(async () => {
    throw new Error('the callback must not authenticate a user');
  });
  const http = createHttpApp({ config, runtime, store: {} as BlobStore, authenticate: authenticate as never, pool: {} as pg.Pool, aiEnabled: false, misaAmisCallback: { clientId: CLIENT }, ...over });
  const post = (text: string) => http.request(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  return { http, post, sqlSeen, executed, authenticate };
}

type Item = { org_refid: string; voucher_type: number; success: boolean; error_code?: string; error_message?: string };
const item = (over: Partial<Item> = {}): Item => ({ org_refid: REF1, voucher_type: 1, success: true, ...over });
function message(items: Item[], over: Record<string, unknown> = {}, clientId = CLIENT): string {
  const data = JSON.stringify(items);
  return JSON.stringify({ success: true, app_id: clientId, error_code: '', error_message: '', signature: signCallbackData(data, clientId), data_type: 1, org_company_code: CODE, data, ...over });
}

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(' ')));
});
afterEach(() => vi.restoreAllMocks());
const bodyOf = async (response: Response) => (await response.json()) as Record<string, unknown>;

describe('the MISA AMIS callback route', () => {
  it('exists only with the ClientID and the Finance module, and is never behind a user session', async () => {
    const without = fixture({ misaAmisCallback: undefined } as unknown as Partial<HttpDeps>);
    expect((await without.post(message([item()]))).status).not.toBe(200);
    expect(without.sqlSeen).toEqual([]);
    const noModule = fixture({}, ['kernel']);
    expect((await noModule.post(message([item()]))).status).not.toBe(200);
    expect(noModule.sqlSeen).toEqual([]);
    const on = fixture();
    expect((await on.post(message([item()]))).status).toBe(200);
    expect(on.authenticate).not.toHaveBeenCalled();
  });

  it('hands the signed results to the machinery table in one orgless call, runs no command, and answers a fixed body', async () => {
    const on = fixture();
    const response = await on.post(message([item(), item({ org_refid: REF2, voucher_type: 4, success: false, error_code: 'IsCreatedVoucher', error_message: REASON_TEXT })]));
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true });
    expect(on.executed).toEqual([]);
    expect(on.sqlSeen).toHaveLength(1);
    expect(on.sqlSeen[0]?.sql).toContain('misa_amis_callback_enqueue');
    // The envelope's company code (a hint), the refids, voucher types and results of the signed data, MISA's code, and its text for the refusal only.
    expect(on.sqlSeen[0]?.parameters).toEqual([CODE, [REF1, REF2], [1, 4], [true, false], [null, 'IsCreatedVoucher'], [null, REASON_TEXT]]);
  });

  it('keeps the last result of a refid a message repeats, and sends nothing for a message with no result', async () => {
    const repeated = fixture();
    await repeated.post(message([item({ success: true }), item({ success: false, error_message: REASON_TEXT })]));
    expect(repeated.sqlSeen[0]?.parameters).toEqual([CODE, [REF1], [1], [false], [null], [REASON_TEXT]]);
    const empty = fixture();
    // A verified message with no result is acknowledged and stores nothing.
    expect((await empty.post(message([]))).status).toBe(200);
    expect(empty.sqlSeen).toEqual([]);
  });

  it('refuses a bad, tampered or missing signature, a wrong app_id and a malformed body with a fixed answer, and reads and writes nothing', async () => {
    const good = JSON.parse(message([item()])) as Record<string, unknown>;
    const cases: Array<[string, string, number]> = [
      ['signature of another key', message([item()], {}, 'another-client-id-2'), 401],
      ['tampered data', JSON.stringify({ ...good, data: JSON.stringify([item({ success: false })]) }), 401],
      ['signature missing', JSON.stringify({ ...good, signature: undefined }), 400],
      ['wrong signature text', JSON.stringify({ ...good, signature: 'f'.repeat(64) }), 401],
      ['app_id that is not the ClientID', message([item()], { app_id: 'someone-else-id' }), 401],
      ['not JSON', 'not json at all', 400],
      ['a list, not an envelope', '[]', 400],
      ['empty data', JSON.stringify({ ...good, data: '' }), 400],
    ];
    for (const [name, body, status] of cases) {
      const on = fixture();
      const response = await on.post(body);
      expect(response.status, name).toBe(status);
      expect(['WEBHOOK_SIGNATURE', 'WEBHOOK_MALFORMED'], name).toContain((await bodyOf(response)).code);
      expect(on.sqlSeen, name).toEqual([]);
    }
  });

  it('passes on only the signed results and the envelope hint: data_type, a batch error and the envelope texts reach nothing', async () => {
    const on = fixture();
    await on.post(message([item()], { data_type: 99, success: false, error_code: 'Boom', error_message: REASON_TEXT, org_company_code: OTHER_CODE }));
    // The signed result decides (success); the company code is the hint (the relay compares it with the located connection's); nothing of the envelope's own error is passed.
    expect(on.sqlSeen[0]?.parameters).toEqual([OTHER_CODE, [REF1], [1], [true], [null], [null]]);
    expect(JSON.stringify(on.sqlSeen)).not.toContain('Boom');
  });

  it("drops NUL and control characters from MISA's text before it is handed on, so it can be stored", async () => {
    const on = fixture();
    await on.post(message([item({ success: false, error_message: `Loi\u0000 rieng\u0007 ${REASON_TEXT}` })]));
    expect(on.sqlSeen[0]?.parameters).toEqual([CODE, [REF1], [1], [false], [null], [`Loi rieng ${REASON_TEXT}`]]);
  });

  it('drops a result whose voucher type AMIS does not have, on its own, so one bad result does not fail the message', async () => {
    const on = fixture();
    expect((await on.post(message([item({ voucher_type: 10_000_000_000 }), item({ org_refid: REF2, voucher_type: 4 }), item({ org_refid: REF3, voucher_type: 0 })]))).status).toBe(200);
    expect(on.sqlSeen[0]?.parameters).toEqual([CODE, [REF2], [4], [true], [null], [null]]);
    const onlyBad = fixture();
    expect((await onlyBad.post(message([item({ voucher_type: 100 })]))).status).toBe(200);
    expect(onlyBad.sqlSeen).toEqual([]);
  });

  it('answers a verified message the same whatever its results, so the answer never says whether a refid exists', async () => {
    const bodies = [
      await (await fixture().post(message([item()]))).text(),
      await (await fixture().post(message([item({ org_refid: REF3, success: false, error_message: REASON_TEXT })]))).text(),
    ];
    expect(new Set(bodies)).toEqual(new Set(['{"ok":true}']));
  });

  it('answers 503 with a fixed code when the table cannot take the results, so MISA retries, and logs that code only', async () => {
    const down = fixture({}, ['kernel', 'finance'], new Error(`boom ${REASON_TEXT}`));
    const response = await down.post(message([item({ success: false, error_message: REASON_TEXT })]));
    expect(response.status).toBe(503);
    expect(await bodyOf(response)).toEqual({ code: 'CALLBACK_UNAVAILABLE' });
    expect(logs.join('\n')).toContain('CALLBACK_UNAVAILABLE');
    expect(logs.join('\n')).not.toContain(REASON_TEXT);
  });

  it('refuses a body over the cap before reading it, and the cap is large enough for a thousand results', async () => {
    const on = fixture();
    const big = `{"x":"${'a'.repeat(MAX_MISA_AMIS_CALLBACK_BYTES)}"}`;
    expect((await on.post(big)).status).toBe(413);
    expect(on.sqlSeen).toEqual([]);
    const thousand = Array.from({ length: 1000 }, () => item({ org_refid: randomUUID(), success: false, error_message: 'x'.repeat(500) }));
    expect(Buffer.byteLength(message(thousand))).toBeLessThan(MAX_MISA_AMIS_CALLBACK_BYTES);
  });

  it('limits a client address before the body is read: a flood of unsigned bodies costs a fixed small amount each', async () => {
    const limit = new RateLimiter({ perMinute: 2 });
    const on = fixture({ misaAmisCallbackLimit: limit });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await on.post('not json')).status);
    expect(statuses).toEqual([400, 400, 429, 429]);
    expect(on.sqlSeen).toEqual([]);
  });

  it('limits the address before the body cap reads a chunked body: a refused address reads nothing', async () => {
    const limit = new RateLimiter({ perMinute: 1 });
    const on = fixture({ misaAmisCallbackLimit: limit });
    await on.post('not json');
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new TextEncoder().encode('x'.repeat(1024)));
        if (pulled > 3) controller.close();
      },
    });
    const response = await on.http.request(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(response.status).toBe(429);
    // A stream is primed with one chunk when it is made; a refused address must not read on from there.
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('puts nothing of a body, a signature, MISA text or the ClientID in a log line', async () => {
    const good = message([item({ success: false, error_message: REASON_TEXT })]);
    const parsed = JSON.parse(good) as { signature: string };
    await fixture().post(good);
    await fixture().post(message([item()], {}, 'another-client-id-2'));
    await fixture().post('not json');
    await fixture({}, ['kernel', 'finance'], new Error(`boom ${REASON_TEXT}`)).post(good);
    const all = logs.join('\n');
    for (const secret of [CLIENT, parsed.signature, REASON_TEXT, REF1, 'another-client-id-2']) expect(all, secret).not.toContain(secret);
  });
});

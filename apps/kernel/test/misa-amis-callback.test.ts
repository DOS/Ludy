// SPDX-License-Identifier: AGPL-3.0-only
// MISA AMIS's callback through the real HTTP app, without a database (#3903, S4 of #3854): the route exists only with the ClientID and the Finance module, it is capped and rate limited before the body is
// read, a message with a bad signature changes nothing and touches nothing, the organisation comes only from the stored push row (a refid in two organisations, a company code that is not the located one, an
// unknown refid and a row no result may answer move nothing), a verified message is always answered the same, and nothing of a body, a signature, MISA's text or the ClientID reaches a log. The runtime is a
// fake: its orgless call answers the rows the definer would, and its execute records the commands. The definer and the command's state graph are tested on a real database in misa-amis-callback.db.test.ts.
import { randomUUID } from 'node:crypto';
import { Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, type CompiledQuery, type DatabaseConnection, type Driver, type QueryResult } from 'kysely';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DomainError, type BlobStore, type Runtime } from '@crove/kernel-runtime';
import { signCallbackData } from '@crove/misa-amis';
import { loadConfig } from '../src/config.ts';
import { createHttpApp, type HttpDeps } from '../src/http.ts';
import { MAX_MISA_AMIS_CALLBACK_BYTES } from '../src/misa-amis-callback.ts';
import { RateLimiter } from '../src/rate-limit.ts';

const CLIENT = 'misa-client-id-0001';
const CODE = `ludy-${'a'.repeat(32)}`;
const OTHER_CODE = `ludy-${'b'.repeat(32)}`;
const PATH = '/api/webhooks/misa-amis';
const ORG_A = randomUUID();
const ORG_B = randomUUID();
const CONN_A = randomUUID();
const CONN_B = randomUUID();
const REF1 = randomUUID();
const REF2 = randomUUID();
const REF3 = randomUUID();
const REASON_TEXT = 'LOI-RIENG-CUA-MISA-0042';

interface Row {
  org_refid: string;
  org_id: string;
  connection_id: string;
  state: string;
  attempts: number;
  voucher_type: number;
  org_company_code: string;
}
const row = (over: Partial<Row> = {}): Row => ({ org_refid: REF1, org_id: ORG_A, connection_id: CONN_A, state: 'sent', attempts: 1, voucher_type: 1, org_company_code: CODE, ...over });

// A Kysely whose driver answers one fixed list of rows to every query and records the SQL and parameters.
function dbOf(rows: Row[], seen: { sql: string; parameters: readonly unknown[] }[]) {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      seen.push({ sql: query.sql, parameters: query.parameters });
      return { rows: rows as unknown as R[] };
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

interface Executed {
  name: string;
  input: { connectionId: string; rows: Array<{ orgRefid: string; attempts: number; from: string; to: string; reason: string | null }>; call: null };
  options: { actor: unknown; orgId: string };
}

function fixture(rows: Row[] = [row()], over: Partial<HttpDeps> = {}, installed: readonly string[] = ['kernel', 'finance'], executeError?: unknown) {
  const sqlSeen: { sql: string; parameters: readonly unknown[] }[] = [];
  const executed: Executed[] = [];
  const runtime = {
    installed: (name: string) => installed.includes(name),
    modules: () => [...installed],
    orgless: async (fn: (d: Kysely<unknown>) => Promise<unknown>) => fn(dbOf(rows, sqlSeen)),
    execute: async (name: string, input: Executed['input'], options: Executed['options']) => {
      executed.push({ name, input, options });
      if (executeError) throw executeError;
      return { applied: input.rows.length, ignored: 0 };
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
    const without = fixture([row()], { misaAmisCallback: undefined } as unknown as Partial<HttpDeps>);
    expect((await without.post(message([item()]))).status).not.toBe(200);
    expect(without.sqlSeen).toEqual([]);
    expect(without.executed).toEqual([]);
    const noModule = fixture([row()], {}, ['kernel']);
    expect((await noModule.post(message([item()]))).status).not.toBe(200);
    expect(noModule.sqlSeen).toEqual([]);
    const on = fixture();
    const response = await on.post(message([item()]));
    expect(response.status).toBe(200);
    expect(on.authenticate).not.toHaveBeenCalled();
  });

  it('records an acceptance for a sent row by the stored organisation, under the system actor, and answers a fixed body', async () => {
    const on = fixture();
    const response = await on.post(message([item()]));
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true });
    expect(on.sqlSeen).toHaveLength(1);
    expect(on.sqlSeen[0]?.sql).toContain('misa_amis_push_locate');
    expect(on.executed).toEqual([
      {
        name: 'finance.misa_amis.push_record',
        input: { connectionId: CONN_A, rows: [{ orgRefid: REF1, attempts: 1, from: 'sent', to: 'accepted', reason: null }], call: null },
        options: { actor: { type: 'system', component: 'finance.misa_amis' }, orgId: ORG_A },
      },
    ]);
  });

  it("records a refusal with MISA's own text, for a row whose answer was lost too, and one command per organisation", async () => {
    const rows = [row({ state: 'ambiguous', attempts: 1 }), row({ org_refid: REF2, org_id: ORG_B, connection_id: CONN_B, org_company_code: CODE })];
    const on = fixture(rows);
    await on.post(message([item({ success: false, error_message: REASON_TEXT }), item({ org_refid: REF2, success: true })]));
    expect(on.executed.map((e) => [e.options.orgId, e.input.connectionId, e.input.rows.map((r) => [r.orgRefid, r.attempts, r.from, r.to, r.reason])])).toEqual([
      [ORG_A, CONN_A, [[REF1, 1, 'ambiguous', 'refused', REASON_TEXT]]],
      [ORG_B, CONN_B, [[REF2, 1, 'sent', 'accepted', null]]],
    ]);
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
      expect(on.executed, name).toEqual([]);
    }
  });

  it('is replay safe by passing the row it found: a replay carries the same state and attempt, so the command ignores it', async () => {
    const on = fixture([row({ state: 'accepted' })]);
    const response = await on.post(message([item({ success: false, error_message: REASON_TEXT })]));
    expect(response.status).toBe(200);
    // An old failure replayed after an acceptance finds the row in `accepted`: nothing is even asked of the command.
    expect(on.executed).toEqual([]);
  });

  it('moves nothing for a row no result may answer, an unknown refid, a refid in two organisations, a company code or a voucher type that is not the located one', async () => {
    for (const state of ['queued', 'sending', 'accepted', 'refused', 'failed']) {
      const on = fixture([row({ state })]);
      expect((await on.post(message([item()]))).status, state).toBe(200);
      expect(on.executed, state).toEqual([]);
    }
    const unknown = fixture([]);
    expect((await unknown.post(message([item()]))).status).toBe(200);
    expect(unknown.executed).toEqual([]);
    const twoOrgs = fixture([row(), row({ org_id: ORG_B, connection_id: CONN_B })]);
    expect((await twoOrgs.post(message([item()]))).status).toBe(200);
    expect(twoOrgs.executed).toEqual([]);
    const sameOrgTwice = fixture([row(), row()]);
    expect((await sameOrgTwice.post(message([item()]))).status).toBe(200);
    expect(sameOrgTwice.executed).toEqual([]);
    const otherCode = fixture([row({ org_company_code: OTHER_CODE })]);
    expect((await otherCode.post(message([item()]))).status).toBe(200);
    expect(otherCode.executed).toEqual([]);
    const otherType = fixture([row({ voucher_type: 2 })]);
    expect((await otherType.post(message([item()]))).status).toBe(200);
    expect(otherType.executed).toEqual([]);
  });

  it("records MISA's text without a NUL or other control character, so the stored reason is a valid text value and MISA is not made to retry for ever", async () => {
    const on = fixture();
    const response = await on.post(message([item({ success: false, error_message: `Loi\u0000 rieng\u0007 ${REASON_TEXT}` })]));
    expect(response.status).toBe(200);
    expect(on.executed.map((e) => e.input.rows.map((r) => r.reason))).toEqual([[`Loi rieng ${REASON_TEXT}`]]);
  });

  it('does not record a refusal for a row that was sent again (an old refusal could be replayed against the second send), but still records an acceptance', async () => {
    const refusal = fixture([row({ attempts: 2 })]);
    expect((await refusal.post(message([item({ success: false, error_message: REASON_TEXT })]))).status).toBe(200);
    expect(refusal.executed).toEqual([]);
    const acceptance = fixture([row({ attempts: 2 })]);
    await acceptance.post(message([item()]));
    expect(acceptance.executed.map((e) => e.input.rows.map((r) => [r.attempts, r.to]))).toEqual([[[2, 'accepted']]]);
    const first = fixture([row({ attempts: 1 })]);
    await first.post(message([item({ success: false, error_message: REASON_TEXT })]));
    expect(first.executed.map((e) => e.input.rows.map((r) => r.to))).toEqual([['refused']]);
  });

  it('is not moved by the unsigned fields: a swapped company code moves nothing, data_type and a batch error move nothing more or less', async () => {
    const swapped = fixture();
    await swapped.post(message([item()], { org_company_code: OTHER_CODE }));
    expect(swapped.executed).toEqual([]);
    const typed = fixture();
    await typed.post(message([item()], { data_type: 99 }));
    expect(typed.executed.map((e) => e.input.rows.map((r) => r.to))).toEqual([['accepted']]);
    // The envelope says the whole batch failed, the signed result says success: the signed result decides.
    const batch = fixture();
    await batch.post(message([item()], { success: false, error_code: 'Boom', error_message: REASON_TEXT }));
    expect(batch.executed.map((e) => e.input.rows.map((r) => [r.to, r.reason]))).toEqual([[['accepted', null]]]);
    // And a batch error with no signed result for a row never moves it.
    const none = fixture([row()]);
    await none.post(message([item({ org_refid: REF3 })], { success: false, error_code: 'Boom' }));
    expect(none.executed).toEqual([]);
  });

  it('answers a verified message the same whatever became of each result, so the answer never says whether a refid exists', async () => {
    const known = await (await fixture().post(message([item()]))).text();
    const unknown = await (await fixture([]).post(message([item()]))).text();
    const refused = await (await fixture([row({ state: 'accepted' })]).post(message([item()]))).text();
    expect(new Set([known, unknown, refused])).toEqual(new Set(['{"ok":true}']));
  });

  it("does not make MISA retry for a refusal of the command, and does for an outage", async () => {
    const refusal = fixture([row()], {}, ['kernel', 'finance'], new DomainError('MODULE_OFF', 403, 'off'));
    expect((await refusal.post(message([item()]))).status).toBe(200);
    // Runtime.execute turns every failure into a DomainError: an outage is one with a 5xx status (or RETRY), and MISA must retry it.
    for (const outage of [new DomainError('INTERNAL', 500, 'x'), new DomainError('OVERLOADED', 503, 'x'), new DomainError('RETRY', 409, 'x')]) {
      const down = await fixture([row()], {}, ['kernel', 'finance'], outage).post(message([item()]));
      expect(down.status, outage.code).toBe(503);
      expect(await bodyOf(down)).toEqual({ code: 'CALLBACK_UNAVAILABLE' });
    }
    expect((await fixture([row()], {}, ['kernel', 'finance'], new Error('connection reset')).post(message([item()]))).status).toBe(503);
  });

  it('refuses a body over the cap before reading it, and the cap is large enough for a thousand results', async () => {
    const on = fixture();
    const big = `{"x":"${'a'.repeat(MAX_MISA_AMIS_CALLBACK_BYTES)}"}`;
    const response = await on.post(big);
    expect(response.status).toBe(413);
    expect(on.sqlSeen).toEqual([]);
    expect(on.executed).toEqual([]);
    const thousand = Array.from({ length: 1000 }, () => item({ org_refid: randomUUID(), success: false, error_message: 'x'.repeat(500) }));
    expect(Buffer.byteLength(message(thousand))).toBeLessThan(MAX_MISA_AMIS_CALLBACK_BYTES);
  });

  it('limits a client address before the body is read: a flood of unsigned bodies costs a fixed small amount each', async () => {
    const limit = new RateLimiter({ perMinute: 2 });
    const on = fixture([row()], { misaAmisCallbackLimit: limit });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await on.post('not json')).status);
    expect(statuses).toEqual([400, 400, 429, 429]);
    expect(on.sqlSeen).toEqual([]);
  });

  it('limits the address before the body cap reads a chunked body: a refused address reads nothing', async () => {
    const limit = new RateLimiter({ perMinute: 1 });
    const on = fixture([row()], { misaAmisCallbackLimit: limit });
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
    await fixture([row()], {}, ['kernel', 'finance'], new Error(`boom ${REASON_TEXT}`)).post(good);
    const all = logs.join('\n');
    for (const secret of [CLIENT, parsed.signature, REASON_TEXT, REF1, 'another-client-id-2']) expect(all, secret).not.toContain(secret);
  });
});

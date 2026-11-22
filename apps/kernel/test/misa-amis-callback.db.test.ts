// SPDX-License-Identifier: AGPL-3.0-only
// MISA AMIS's callback on a real PostgreSQL 17 (#3903, S4 of #3854): the three definers (the API login's enqueue, the worker's claim and done: who may run them, what they return, that a refid held by two
// organisations comes back as two rows, that an organisation whose Finance is off is not found, that a result taken and not done is taken again, that old results are purged) and the whole path, the route as the
// API login and the relay as the worker login, against the real command and the real state graph (a signed result moves a sent or lost-answer row, a replay and an old failure after an acceptance change nothing, a
// swapped company code, a refid of another organisation and a row still being sent move nothing, and an organisation whose Finance is off is acknowledged and dropped). The route's behaviour with a fake runtime is
// in misa-amis-callback.test.ts and the relay's decisions in misa-amis-callback-relay.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { signCallbackData } from '@ludy/misa-amis';
import { createAuthenticator } from '../src/auth.ts';
import { runMisaAmisCallbacks } from '../src/misa-amis-callback-relay.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET = 'test-only-jwt-secret-for-misa-amis-callback-0123456789';
const ISSUER = 'crove-auth';
const CLIENT = 'misa-client-id-0001';
const ASP_CLIENT = 'misa-asp-client-id-0001';
const PATH = '/api/webhooks/misa-amis';
const REASON_TEXT = 'LOI-RIENG-CUA-MISA-0042';

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

suite('MISA AMIS callback (#3903)', () => {
  const dbName = `crove_test_misa_amis_callback_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let api: Runtime;
  let worker: Runtime;
  let workerPool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  let cfg: ReturnType<typeof loadConfig>;
  const users = { owner: '', outsider: '' };
  const A = { org: '', entity: '', connection: '', code: '' };
  const B = { org: '', entity: '', connection: '', code: '' };
  // An organisation on MISA ASP (product asp), to prove a result signed under one product's key never settles the other product's row (#4113).
  const C = { org: '', entity: '', connection: '', code: '' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows);
  const ownerOf = (who: typeof A) => ({ actor: { type: 'user' as const, userId: who === A ? users.owner : users.outsider, aal: 'aal1' as const, sessionId: randomUUID() }, orgId: who.org });

  // A push row as it stands after a send, written by the superuser (the guard keeps what a restore writes).
  async function seed(who: typeof A, refid: string, state: string, over: { voucherType?: number } = {}) {
    await rows(
      `INSERT INTO crove_finance.misa_amis_push (org_id, legal_entity_id, connection_id, source_type, source_id, voucher_type, org_refid, org_refno, payload_digest, state)
       VALUES ($1, $2, $3, 'cash_voucher', $4, $5, $6, $7, $8, $9)`,
      [who.org, who.entity, who.connection, randomUUID(), over.voucherType ?? 1, refid, `PC${refid.slice(0, 8)}`, '0'.repeat(64), state],
    );
  }
  const stateOf = async (who: typeof A, refid: string) => (await rows<{ state: string; reason: string | null; answered_at: Date | null }>('SELECT state, reason, answered_at FROM crove_finance.misa_amis_push WHERE org_id = $1 AND org_refid = $2', [who.org, refid]))[0];

  type Item = { org_refid: string; voucher_type: number; success: boolean; error_message?: string };
  const message = (items: Item[], over: Record<string, unknown> = {}) => {
    const data = JSON.stringify(items);
    return JSON.stringify({ success: true, app_id: CLIENT, error_code: '', error_message: '', signature: signCallbackData(data, CLIENT), data_type: 1, org_company_code: A.code, data, ...over });
  };
  // The same message as an ASP result: signed and addressed with the ASP ClientID, for the ASP organisation (or another company code).
  const aspMessage = (items: Item[], over: Record<string, unknown> = {}) => {
    const data = JSON.stringify(items);
    return JSON.stringify({ success: true, app_id: ASP_CLIENT, error_code: '', error_message: '', signature: signCallbackData(data, ASP_CLIENT), data_type: 1, org_company_code: C.code, data, ...over });
  };
  const post = (text: string) => app.request(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  const enqueue = (company: string, results: Array<{ refid: string; type?: number; ok?: boolean; code?: string | null; text?: string | null }>) =>
    api.orgless(async (db) => {
      const { rows: out } = await sql<{ n: number }>`
        SELECT crove_finance.misa_amis_callback_enqueue(${company}, ${results.map((r) => r.refid)}::uuid[], ${results.map((r) => r.type ?? 1)}::integer[], ${results.map((r) => r.ok ?? true)}::boolean[],
          ${results.map((r) => r.code ?? null)}::text[], ${results.map((r) => r.text ?? null)}::text[]) AS n`.execute(db);
      return Number(out[0]?.n);
    });
  const enqueueAsp = (company: string, results: Array<{ refid: string; type?: number; ok?: boolean }>) =>
    api.orgless(async (db) => {
      const { rows: out } = await sql<{ n: number }>`
        SELECT crove_finance.misa_asp_callback_enqueue(${company}, ${results.map((r) => r.refid)}::uuid[], ${results.map((r) => r.type ?? 1)}::integer[], ${results.map((r) => r.ok ?? true)}::boolean[],
          ${results.map(() => null)}::text[], ${results.map(() => null)}::text[]) AS n`.execute(db);
      return Number(out[0]?.n);
    });
  const claim = (limit = 100) =>
    worker.orgless(async (db) => (await sql<Record<string, unknown>>`SELECT * FROM crove_finance.misa_amis_callback_claim(${limit}::int)`.execute(db)).rows);
  const pending = () => rows<{ seq: string; org_refid: string; claimed_at: Date | null }>('SELECT seq, org_refid, claimed_at FROM crove_finance.misa_amis_callback_pending ORDER BY seq');
  const clearPending = () => rows('DELETE FROM crove_finance.misa_amis_callback_pending');
  const relay = () => runMisaAmisCallbacks({ runtime: worker, workerDb: createDb(workerPool) });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 6 });
    api = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 2 });
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    const config = (cfg = loadConfig({ DATABASE_URL: login('ludy_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' }));
    app = createHttpApp({ config, runtime: api, store: new MemoryStore(), authenticate: createAuthenticator(config, createDb(pool)), pool, aiEnabled: false, misaAmisCallback: { keys: [{ product: 'amis', clientId: CLIENT }, { product: 'asp', clientId: ASP_CLIENT }] } });
    const token = async (email: string) =>
      new SignJWT({ role: 'authenticated', email, session_id: randomUUID(), aal: 'aal1', is_anonymous: false })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(randomUUID())
        .setIssuer(ISSUER)
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(new TextEncoder().encode(SECRET));
    const rpc = async (path: string, bearer: string, input: unknown) => {
      const response = await app.request(`/api/rpc/${path}`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify(input === undefined ? {} : { json: input }) });
      const text = await response.text();
      const body = (text ? JSON.parse(text) : null) as { json?: unknown } | null;
      return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
    };
    const tokens = { owner: await token('owner@misa-amis-callback.test'), outsider: await token('outsider@misa-amis-callback.test') };
    for (const key of ['owner', 'outsider'] as const) {
      const me = await rpc('me/get', tokens[key], undefined);
      expect(me.status).toBe(200);
      users[key] = String(me.body?.userId);
    }
    A.org = String((await rpc('org/create', tokens.owner, { name: 'Công ty nhận callback', idempotencyKey: randomUUID() })).body?.orgId);
    B.org = String((await rpc('org/create', tokens.outsider, { name: 'Công ty khác', idempotencyKey: randomUUID() })).body?.orgId);
    C.org = String((await rpc('org/create', tokens.owner, { name: 'Công ty dùng ASP', idempotencyKey: randomUUID() })).body?.orgId);
    for (const [who, owner, product] of [[A, users.owner, 'amis'], [B, users.outsider, 'amis'], [C, users.owner, 'asp']] as const) {
      who.entity = String((await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [who.org]))[0]?.id);
      const channel = randomUUID();
      await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $5, $3, 'MISA thử', $4)", [who.org, channel, who.entity, owner, `accounting_misa_${product}`]);
      who.connection = randomUUID();
      who.code = String(
        (
          await rows<{ org_company_code: string }>(
            "INSERT INTO crove_finance.misa_amis_connection (org_id, id, legal_entity_id, channel_connection_id, product, last_test_state, last_tested_at) VALUES ($1, $2, $3, $4, $5, 'works', pg_catalog.now()) RETURNING org_company_code",
            [who.org, who.connection, who.entity, channel, product],
          )
        )[0]?.org_company_code,
      );
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  beforeEach(async () => {
    await clearPending();
  });

  describe('the definers', () => {
    const FNS = ['crove_finance.misa_amis_callback_enqueue(text,uuid[],integer[],boolean[],text[],text[])', 'crove_finance.misa_amis_callback_claim(integer)', 'crove_finance.misa_amis_callback_done(bigint[])'] as const;

    it('are SECURITY DEFINER with a pinned search path; the API login runs the enqueue alone, the worker login the claim and done alone; no role touches the table', async () => {
      for (const fn of FNS) {
        const got = (await rows<{ secdef: boolean; config: string[] | null; acl: string | null }>('SELECT prosecdef AS secdef, proconfig AS config, proacl::text AS acl FROM pg_proc WHERE oid = $1::regprocedure', [fn]))[0];
        expect(got?.secdef, fn).toBe(true);
        expect(got?.config, fn).toEqual(['search_path=pg_catalog, pg_temp']);
        expect(got?.acl ?? '', fn).not.toMatch(/(^|[{,])=X\//);
      }
      const allowed: Record<string, Record<string, boolean>> = {
        [FNS[0]]: { ludy_app: true, ludy_worker: false, ludy_tenant: false, ludy_definer_tenant: false },
        [FNS[1]]: { ludy_app: false, ludy_worker: true, ludy_tenant: false, ludy_definer_tenant: false },
        [FNS[2]]: { ludy_app: false, ludy_worker: true, ludy_tenant: false, ludy_definer_tenant: false },
      };
      for (const [fn, roles] of Object.entries(allowed)) {
        for (const [role, ok] of Object.entries(roles)) {
          const got = (await rows<{ ok: boolean }>("SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok", [role, fn]))[0];
          expect(got?.ok, `${fn} ${role}`).toBe(ok);
        }
      }
      for (const role of ['ludy_app', 'ludy_worker', 'ludy_tenant', 'ludy_definer_tenant']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const got = (await rows<{ ok: boolean }>("SELECT has_table_privilege($1, 'crove_finance.misa_amis_callback_pending', $2) AS ok", [role, privilege]))[0];
          expect(got?.ok, `${role} ${privilege}`).toBe(false);
        }
      }
    });

    it('the private function behind both enqueues is not a definer, pins its search path and is granted to nobody, PUBLIC included; the ASP enqueue is a definer the API login alone runs (#4113)', async () => {
      const inner = 'crove_finance.misa_callback_enqueue_for(text,text,uuid[],integer[],boolean[],text[],text[])';
      const asp = 'crove_finance.misa_asp_callback_enqueue(text,uuid[],integer[],boolean[],text[],text[])';
      const got = async (fn: string) => (await rows<{ secdef: boolean; config: string[] | null; acl: string | null }>('SELECT prosecdef AS secdef, proconfig AS config, proacl::text AS acl FROM pg_proc WHERE oid = $1::regprocedure', [fn]))[0];
      const priv = await got(inner);
      expect(priv?.secdef).toBe(false);
      expect(priv?.config).toEqual(['search_path=pg_catalog, pg_temp']);
      // The revoke from PUBLIC is written out (an ACL exists), not left to a default.
      expect(priv?.acl).not.toBeNull();
      expect(priv?.acl ?? '').not.toMatch(/(^|[{,])=X\//);
      for (const role of ['ludy_app', 'ludy_worker', 'ludy_tenant', 'ludy_definer_tenant']) {
        expect((await rows<{ ok: boolean }>("SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok", [role, inner]))[0]?.ok, `${inner} ${role}`).toBe(false);
      }
      // A login that tries it directly is refused.
      await expect(
        api.orgless(async (db) => void (await sql`SELECT crove_finance.misa_callback_enqueue_for('asp', ${C.code}, ${[randomUUID()]}::uuid[], ${[1]}::integer[], ${[true]}::boolean[], ${[null]}::text[], ${[null]}::text[])`.execute(db))),
      ).rejects.toBeDefined();
      // (The refusal is pinned by the privilege checks above: has_function_privilege is false for every login and tenant role.)
      expect(await pending()).toEqual([]);
      const wrapper = await got(asp);
      expect(wrapper?.secdef).toBe(true);
      expect(wrapper?.config).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(wrapper?.acl ?? '').not.toMatch(/(^|[{,])=X\//);
      const allowed: Record<string, boolean> = { ludy_app: true, ludy_worker: false, ludy_tenant: false, ludy_definer_tenant: false };
      for (const [role, ok] of Object.entries(allowed)) {
        expect((await rows<{ ok: boolean }>("SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok", [role, asp]))[0]?.ok, `${asp} ${role}`).toBe(ok);
      }
    });

    it('each enqueue writes its own product, and a replay is one row per product, so the other product\'s copy cannot take the place of the real one', async () => {
      const refid = randomUUID();
      expect(await enqueue(A.code, [{ refid }])).toBe(1);
      expect(await enqueueAsp(C.code, [{ refid }])).toBe(1);
      expect(await enqueueAsp(C.code, [{ refid }])).toBe(0);
      expect(await rows<{ product: string }>('SELECT product FROM crove_finance.misa_amis_callback_pending ORDER BY product')).toEqual([{ product: 'amis' }, { product: 'asp' }]);
      // The ASP enqueue holds the same limits as the AMIS one.
      await expect(enqueueAsp('not a code!', [{ refid }])).rejects.toMatchObject({ code: 'INVALID' });
      await expect(enqueueAsp(C.code, [])).rejects.toMatchObject({ code: 'INVALID' });
    });

    it('claim finds the stored row only through a connection of the product that signed the result: an AMIS result does not find an ASP row, an ASP result does not find an AMIS row', async () => {
      const amisRow = randomUUID();
      const aspRow = randomUUID();
      await seed(A, amisRow, 'sent');
      await seed(C, aspRow, 'sent');
      await enqueue(A.code, [{ refid: amisRow }, { refid: aspRow }]);
      await enqueueAsp(C.code, [{ refid: aspRow }, { refid: amisRow }]);
      const got = await claim();
      const find = (refid: string, product: 'amis' | 'asp') => got.filter((r) => r.org_refid === refid && (r.org_company_code === (product === 'amis' ? A.code : C.code)));
      expect(find(amisRow, 'amis')[0]).toMatchObject({ m_org_id: A.org, m_state: 'sent' });
      expect(find(aspRow, 'asp')[0]).toMatchObject({ m_org_id: C.org, m_state: 'sent' });
      expect(find(aspRow, 'amis')[0]).toMatchObject({ m_org_id: null, m_state: null });
      expect(find(amisRow, 'asp')[0]).toMatchObject({ m_org_id: null, m_state: null });
      expect(Object.keys(got[0] ?? {}).sort()).toEqual(['error_code', 'error_message', 'm_attempts', 'm_connection_id', 'm_org_company_code', 'm_org_id', 'm_state', 'm_voucher_type', 'org_company_code', 'org_refid', 'seq', 'success', 'voucher_type']);
    });

    it('enqueue takes the signed results once (a replay is skipped), refuses malformed lists, and records nothing for a refid it knows nothing about', async () => {
      const refid = randomUUID();
      expect(await enqueue(A.code, [{ refid }, { refid: randomUUID(), ok: false, code: 'Boom', text: REASON_TEXT }])).toBe(2);
      expect(await enqueue(A.code, [{ refid }])).toBe(0);
      // The same refid with another result is another row; the claim and the graph decide between them. The unsigned company code is not part of the replay key: the first copy wins, so a replay with varied codes
      // cannot fill the backlog.
      expect(await enqueue(A.code, [{ refid, ok: false }])).toBe(1);
      for (const code of ['ludy-c', 'ludy-d', B.code]) expect(await enqueue(code, [{ refid }])).toBe(0);
      expect(await pending()).toHaveLength(3);
      await expect(enqueue('not a code!', [{ refid }])).rejects.toMatchObject({ code: 'INVALID' });
      await expect(enqueue(A.code, [])).rejects.toMatchObject({ code: 'INVALID' });
      await expect(enqueue(A.code, Array.from({ length: 1001 }, () => ({ refid: randomUUID() })))).rejects.toMatchObject({ code: 'INVALID' });
      // Lists of unequal length.
      await expect(api.orgless(async (db) => void (await sql`SELECT crove_finance.misa_amis_callback_enqueue(${A.code}, ${[randomUUID()]}::uuid[], ${[1, 2]}::integer[], ${[true]}::boolean[], ${[null]}::text[], ${[null]}::text[])`.execute(db)))).rejects.toMatchObject({ code: 'INVALID' });
    });

    it('enqueue refuses past ten thousand waiting results, so a flood cannot grow the table without bound', async () => {
      await rows(
        "INSERT INTO crove_finance.misa_amis_callback_pending (org_refid, voucher_type, org_company_code, success) SELECT gen_random_uuid(), 1, 'ludy-fill', true FROM generate_series(1, 10001)",
      );
      await expect(enqueue(A.code, [{ refid: randomUUID() }])).rejects.toBeDefined();
      await clearPending();
      expect(await enqueue(A.code, [{ refid: randomUUID() }])).toBe(1);
    });

    it('claim answers, per waiting result, the organisation that stored its refid: one row for one organisation, two for a refid two hold, none-matching for an unknown one', async () => {
      const mine = randomUUID();
      const both = randomUUID();
      const unknown = randomUUID();
      await seed(A, mine, 'sent');
      await seed(A, both, 'sent');
      await seed(B, both, 'ambiguous');
      await enqueue(A.code, [{ refid: mine }, { refid: both }, { refid: unknown }]);
      const got = await claim();
      const of = (refid: string) => got.filter((r) => r.org_refid === refid);
      expect(of(mine)).toHaveLength(1);
      expect(of(mine)[0]).toMatchObject({ m_org_id: A.org, m_connection_id: A.connection, m_state: 'sent', m_attempts: 1, m_voucher_type: 1, m_org_company_code: A.code, org_company_code: A.code, success: true, voucher_type: 1 });
      expect(of(both).map((r) => r.m_org_id).sort()).toEqual([A.org, B.org].sort());
      expect(of(unknown)).toHaveLength(1);
      expect(of(unknown)[0]).toMatchObject({ m_org_id: null, m_connection_id: null, m_state: null });
      expect(Object.keys(got[0] ?? {}).sort()).toEqual(['error_code', 'error_message', 'm_attempts', 'm_connection_id', 'm_org_company_code', 'm_org_id', 'm_state', 'm_voucher_type', 'org_company_code', 'org_refid', 'seq', 'success', 'voucher_type']);
    });

    it('claim marks what it took, takes it again after five minutes if it is not done, and done deletes it; results older than seven days are purged', async () => {
      const refid = randomUUID();
      await seed(A, refid, 'sent');
      await enqueue(A.code, [{ refid }]);
      const first = await claim();
      expect(first).toHaveLength(1);
      expect(await claim()).toEqual([]);
      await rows("UPDATE crove_finance.misa_amis_callback_pending SET claimed_at = pg_catalog.now() - interval '6 minutes'");
      const again = await claim();
      expect(again.map((r) => r.seq)).toEqual(first.map((r) => r.seq));
      const done = await worker.orgless(async (db) => Number((await sql<{ n: number }>`SELECT crove_finance.misa_amis_callback_done(${first.map((r) => String(r.seq))}::bigint[]) AS n`.execute(db)).rows[0]?.n));
      expect(done).toBe(1);
      expect(await pending()).toEqual([]);
      await enqueue(A.code, [{ refid: randomUUID() }]);
      await rows("UPDATE crove_finance.misa_amis_callback_pending SET received_at = pg_catalog.now() - interval '8 days'");
      expect(await claim()).toEqual([]);
      expect(await pending()).toEqual([]);
    });

    it('claim finds nothing for an organisation whose Finance is off, and finds it again when it is switched on', async () => {
      const refid = randomUUID();
      await seed(B, refid, 'sent');
      await enqueue(B.code, [{ refid }]);
      await api.execute('kernel.org.set_app', { module: 'finance', enabled: false }, ownerOf(B));
      try {
        expect((await claim()).map((r) => r.m_org_id)).toEqual([null]);
      } finally {
        await api.execute('kernel.org.set_app', { module: 'finance', enabled: true }, ownerOf(B));
      }
      await rows("UPDATE crove_finance.misa_amis_callback_pending SET claimed_at = NULL");
      expect((await claim()).map((r) => r.m_org_id)).toEqual([B.org]);
    });
  });

  describe('the route and the relay on the real command and graph', () => {
    it('records a sent row as accepted with the time of the answer, and a lost-answer row as refused with MISA\'s text', async () => {
      const sent = randomUUID();
      const lost = randomUUID();
      await seed(A, sent, 'sent');
      await seed(A, lost, 'ambiguous');
      const response = await post(message([{ org_refid: sent, voucher_type: 1, success: true }, { org_refid: lost, voucher_type: 1, success: false, error_message: REASON_TEXT }]));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      // The route recorded nothing about a voucher: the rows wait for the worker.
      expect((await stateOf(A, sent))?.state).toBe('sent');
      expect(await pending()).toHaveLength(2);
      expect(await relay()).toBe(2);
      expect(await stateOf(A, sent)).toMatchObject({ state: 'accepted', reason: null });
      expect((await stateOf(A, sent))?.answered_at).not.toBeNull();
      expect(await stateOf(A, lost)).toMatchObject({ state: 'refused', reason: REASON_TEXT });
      expect(await pending()).toEqual([]);
    });

    it('is replay safe and forward only: the same message again, and an old failure after an acceptance, change nothing', async () => {
      const refid = randomUUID();
      await seed(A, refid, 'sent');
      await post(message([{ org_refid: refid, voucher_type: 1, success: true }]));
      await relay();
      const before = (await rows<{ updated_at: Date }>('SELECT updated_at FROM crove_finance.misa_amis_push WHERE org_refid = $1 AND org_id = $2', [refid, A.org]))[0];
      await post(message([{ org_refid: refid, voucher_type: 1, success: true }]));
      await post(message([{ org_refid: refid, voucher_type: 1, success: false, error_message: REASON_TEXT }]));
      await relay();
      expect(await stateOf(A, refid)).toMatchObject({ state: 'accepted', reason: null });
      const after = (await rows<{ updated_at: Date }>('SELECT updated_at FROM crove_finance.misa_amis_push WHERE org_refid = $1 AND org_id = $2', [refid, A.org]))[0];
      expect(after?.updated_at).toEqual(before?.updated_at);
      expect(await pending()).toEqual([]);
    });

    it('records no refusal for a row that was sent again, and still records its acceptance', async () => {
      const refid = randomUUID();
      await seed(A, refid, 'sent');
      await rows('UPDATE crove_finance.misa_amis_push SET attempts = 2 WHERE org_id = $1 AND org_refid = $2', [A.org, refid]);
      await post(message([{ org_refid: refid, voucher_type: 1, success: false, error_message: REASON_TEXT }]));
      await relay();
      expect(await stateOf(A, refid)).toMatchObject({ state: 'sent', reason: null });
      await post(message([{ org_refid: refid, voucher_type: 1, success: true }]));
      await relay();
      expect(await stateOf(A, refid)).toMatchObject({ state: 'accepted' });
    });

    it('moves nothing for a row still being sent, a swapped company code, a wrong voucher type or an unknown refid, and the route answers the same', async () => {
      const sending = randomUUID();
      const swapped = randomUUID();
      const typed = randomUUID();
      await seed(A, sending, 'sending');
      await seed(A, swapped, 'sent');
      await seed(A, typed, 'sent', { voucherType: 2 });
      const bodies = [
        await (await post(message([{ org_refid: sending, voucher_type: 1, success: true }]))).text(),
        await (await post(message([{ org_refid: swapped, voucher_type: 1, success: true }], { org_company_code: B.code }))).text(),
        await (await post(message([{ org_refid: typed, voucher_type: 1, success: true }]))).text(),
        await (await post(message([{ org_refid: randomUUID(), voucher_type: 1, success: true }]))).text(),
      ];
      expect(new Set(bodies)).toEqual(new Set(['{"ok":true}']));
      await relay();
      expect((await stateOf(A, sending))?.state).toBe('sending');
      expect((await stateOf(A, swapped))?.state).toBe('sent');
      expect((await stateOf(A, typed))?.state).toBe('sent');
      // Only the result for the row still being sent waits (MISA can call back before the worker records `sent`); the others were dropped.
      expect((await pending()).map((r) => r.org_refid)).toEqual([sending]);
      // Once the row is sent, the next take records it.
      await rows("UPDATE crove_finance.misa_amis_push SET state = 'sent' WHERE org_id = $1 AND org_refid = $2", [A.org, sending]);
      await rows('UPDATE crove_finance.misa_amis_callback_pending SET claimed_at = pg_catalog.now() - interval \'6 minutes\'');
      await relay();
      expect((await stateOf(A, sending))?.state).toBe('accepted');
      expect(await pending()).toEqual([]);
    });

    it("never records for a refid held by two organisations, and a signed result of one organisation cannot move another's row", async () => {
      const both = randomUUID();
      await seed(A, both, 'sent');
      await seed(B, both, 'sent');
      await post(message([{ org_refid: both, voucher_type: 1, success: true }]));
      await relay();
      expect((await stateOf(A, both))?.state).toBe('sent');
      expect((await stateOf(B, both))?.state).toBe('sent');
      const onlyB = randomUUID();
      await seed(B, onlyB, 'sent');
      // A's company code on B's refid: the located connection is B's, so its code does not match.
      await post(message([{ org_refid: onlyB, voucher_type: 1, success: true }], { org_company_code: A.code }));
      await relay();
      expect((await stateOf(B, onlyB))?.state).toBe('sent');
      // B's own code moves B's row.
      await post(message([{ org_refid: onlyB, voucher_type: 1, success: true }], { org_company_code: B.code }));
      await relay();
      expect((await stateOf(B, onlyB))?.state).toBe('accepted');
    });

    it('acknowledges and drops the result of an organisation whose Finance is off', async () => {
      const refid = randomUUID();
      await seed(B, refid, 'sent');
      await api.execute('kernel.org.set_app', { module: 'finance', enabled: false }, ownerOf(B));
      try {
        expect((await post(message([{ org_refid: refid, voucher_type: 1, success: true }], { org_company_code: B.code }))).status).toBe(200);
        await relay();
        expect((await stateOf(B, refid))?.state).toBe('sent');
        expect(await pending()).toEqual([]);
      } finally {
        await api.execute('kernel.org.set_app', { module: 'finance', enabled: true }, ownerOf(B));
      }
    });

    it('stores nothing of the message but the results: no signature or ClientID in the machinery table, a push row or an audit row', async () => {
      const refid = randomUUID();
      await seed(A, refid, 'sent');
      const text = message([{ org_refid: refid, voucher_type: 1, success: true }]);
      const signature = (JSON.parse(text) as { signature: string }).signature;
      await post(text);
      await relay();
      for (const needle of [signature, CLIENT]) {
        const hits = await rows<{ n: number }>(
          `SELECT (SELECT count(*) FROM crove_finance.misa_amis_callback_pending p WHERE p::text LIKE '%' || $1 || '%')::int
                + (SELECT count(*) FROM crove_finance.misa_amis_push p WHERE p::text LIKE '%' || $1 || '%')::int
                + (SELECT count(*) FROM ludy_kernel.audit_event a WHERE a::text LIKE '%' || $1 || '%')::int AS n`,
          [needle],
        );
        expect(Number(hits[0]?.n), needle).toBe(0);
      }
    });
  });

  describe('the product of the key that signed the result (#4113)', () => {
    it('an ASP-signed result settles the ASP organisation\'s sent row, with the same states as AMIS', async () => {
      const sent = randomUUID();
      const lost = randomUUID();
      await seed(C, sent, 'sent');
      await seed(C, lost, 'ambiguous');
      const response = await post(aspMessage([{ org_refid: sent, voucher_type: 1, success: true }, { org_refid: lost, voucher_type: 1, success: false, error_message: REASON_TEXT }]));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect((await pending()).map((r) => r.org_refid).sort()).toEqual([sent, lost].sort());
      expect(await relay()).toBe(2);
      expect(await stateOf(C, sent)).toMatchObject({ state: 'accepted', reason: null });
      expect(await stateOf(C, lost)).toMatchObject({ state: 'refused', reason: REASON_TEXT });
      expect(await pending()).toEqual([]);
    });

    it('an AMIS-signed result for the ASP organisation\'s company code moves nothing, and an ASP-signed result for the AMIS organisation\'s row moves nothing; the route answers the same', async () => {
      const aspRow = randomUUID();
      const amisRow = randomUUID();
      await seed(C, aspRow, 'sent');
      await seed(A, amisRow, 'sent');
      const bodies = [
        // Signed and addressed with the AMIS ClientID, naming the ASP organisation's company code and its voucher.
        await (await post(message([{ org_refid: aspRow, voucher_type: 1, success: true }], { org_company_code: C.code }))).text(),
        // Signed and addressed with the ASP ClientID, naming the AMIS organisation's company code and its voucher.
        await (await post(aspMessage([{ org_refid: amisRow, voucher_type: 1, success: true }], { org_company_code: A.code }))).text(),
      ];
      expect(new Set(bodies)).toEqual(new Set(['{"ok":true}']));
      await relay();
      expect((await stateOf(C, aspRow))?.state).toBe('sent');
      expect((await stateOf(A, amisRow))?.state).toBe('sent');
      expect(await pending()).toEqual([]);
    });

    it('where MISA issued one ClientID for both products, a result is stored for each product and only the real connection\'s row is settled', async () => {
      const same = createHttpApp({ config: cfg, runtime: api, store: new MemoryStore(), authenticate: createAuthenticator(cfg, createDb(pool)), pool, aiEnabled: false, misaAmisCallback: { keys: [{ product: 'amis', clientId: CLIENT }, { product: 'asp', clientId: CLIENT }] } });
      const aspRow = randomUUID();
      const amisRow = randomUUID();
      await seed(C, aspRow, 'sent');
      await seed(A, amisRow, 'sent');
      const send = (items: Item[], company: string) => same.request(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: message(items, { org_company_code: company }) });
      expect((await send([{ org_refid: aspRow, voucher_type: 1, success: true }], C.code)).status).toBe(200);
      expect((await send([{ org_refid: amisRow, voucher_type: 1, success: true }], A.code)).status).toBe(200);
      // Each result is stored for both products; the claim finds each stored voucher through its own connection's product only.
      expect(await pending()).toHaveLength(4);
      await relay();
      expect((await stateOf(C, aspRow))?.state).toBe('accepted');
      expect((await stateOf(A, amisRow))?.state).toBe('accepted');
      expect(await pending()).toEqual([]);
    });

    it('a result signed with one ClientID but carrying the other\'s app_id is refused as a bad signature, and neither key is logged', async () => {
      const refid = randomUUID();
      await seed(C, refid, 'sent');
      const data = JSON.stringify([{ org_refid: refid, voucher_type: 1, success: true }]);
      const bad = await post(JSON.stringify({ success: true, app_id: CLIENT, error_code: '', error_message: '', signature: signCallbackData(data, ASP_CLIENT), data_type: 1, org_company_code: C.code, data }));
      expect(bad.status).toBe(401);
      const other = await post(JSON.stringify({ success: true, app_id: ASP_CLIENT, error_code: '', error_message: '', signature: signCallbackData(data, CLIENT), data_type: 1, org_company_code: C.code, data }));
      expect(other.status).toBe(401);
      expect(await pending()).toEqual([]);
      expect((await stateOf(C, refid))?.state).toBe('sent');
    });
  });
});

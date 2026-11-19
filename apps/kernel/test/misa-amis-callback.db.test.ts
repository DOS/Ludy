// SPDX-License-Identifier: AGPL-3.0-only
// MISA AMIS's callback on a real PostgreSQL 17 (#3903, S4 of #3854): the orgless locate function (what it returns, to whom it is granted, that it finds a refid only in the organisation that stored it and shows
// a refid held by two organisations as two rows, that it ignores an organisation whose Finance is off) and the whole route against the real command and the real state graph (a signed result moves a sent or
// lost-answer row, a replay and an old failure after an acceptance change nothing, a swapped company code, a refid of another organisation and a row still being sent move nothing, and an organisation whose
// Finance is off is acknowledged and dropped). The route's behaviour with a fake runtime is in misa-amis-callback.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { signCallbackData } from '@crove/misa-amis';
import { createAuthenticator } from '../src/auth.ts';
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
  let app: ReturnType<typeof createHttpApp>;
  const users = { owner: '', outsider: '' };
  const A = { org: '', entity: '', connection: '', code: '' };
  const B = { org: '', entity: '', connection: '', code: '' };

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
  const post = (text: string) => app.request(PATH, { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
  const locate = (ids: string[]) =>
    api.orgless(async (db) => {
      const { rows: found } = await sql<Record<string, unknown>>`SELECT * FROM crove_finance.misa_amis_push_locate(${ids}::uuid[])`.execute(db);
      return found;
    });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 6 });
    api = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({ DATABASE_URL: login('crove_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime: api, store: new MemoryStore(), authenticate: createAuthenticator(config, createDb(pool)), pool, aiEnabled: false, misaAmisCallback: { clientId: CLIENT } });
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
    for (const [who, owner] of [[A, users.owner], [B, users.outsider]] as const) {
      who.entity = String((await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [who.org]))[0]?.id);
      const channel = randomUUID();
      await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'accounting_misa_amis', $3, 'AMIS thử', $4)", [who.org, channel, who.entity, owner]);
      who.connection = randomUUID();
      who.code = String(
        (
          await rows<{ org_company_code: string }>(
            "INSERT INTO crove_finance.misa_amis_connection (org_id, id, legal_entity_id, channel_connection_id, last_test_state, last_tested_at) VALUES ($1, $2, $3, $4, 'works', pg_catalog.now()) RETURNING org_company_code",
            [who.org, who.connection, who.entity, channel],
          )
        )[0]?.org_company_code,
      );
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  describe('the locate function', () => {
    it('is a read-only SECURITY DEFINER with a pinned search path, executable by the API login alone', async () => {
      const [fn] = await rows<{ secdef: boolean; config: string[] | null; acl: string | null; volatility: string }>(
        "SELECT prosecdef AS secdef, proconfig AS config, proacl::text AS acl, provolatile AS volatility FROM pg_proc WHERE oid = 'crove_finance.misa_amis_push_locate(uuid[])'::regprocedure",
      );
      expect(fn?.secdef).toBe(true);
      expect(fn?.config).toEqual(['search_path=pg_catalog, pg_temp']);
      // STABLE: it cannot write.
      expect(fn?.volatility).toBe('s');
      // No grant to PUBLIC (an ACL entry with an empty grantee reads `=X/owner`).
      expect(fn?.acl ?? '').not.toMatch(/(^|[{,])=X\//);
      for (const [role, allowed] of [['crove_app', true], ['crove_worker', false], ['crove_tenant', false], ['crove_definer_tenant', false]] as const) {
        const got = (await rows<{ ok: boolean }>("SELECT has_function_privilege($1, 'crove_finance.misa_amis_push_locate(uuid[])', 'EXECUTE') AS ok", [role]))[0];
        expect(got?.ok, role).toBe(allowed);
      }
    });

    it('returns only the organisation, the connection, the state, the attempt, the voucher type and the connection code of the rows it was asked about', async () => {
      const refid = randomUUID();
      await seed(A, refid, 'sent');
      const found = await locate([refid]);
      expect(found).toHaveLength(1);
      expect(Object.keys(found[0] ?? {}).sort()).toEqual(['attempts', 'connection_id', 'org_company_code', 'org_id', 'org_refid', 'state', 'voucher_type']);
      expect(found[0]).toMatchObject({ org_refid: refid, org_id: A.org, connection_id: A.connection, state: 'sent', attempts: 1, voucher_type: 1, org_company_code: A.code });
    });

    it('never returns another organisation\'s row for a refid it does not hold, and shows a refid held by two organisations as two rows', async () => {
      const mine = randomUUID();
      const theirs = randomUUID();
      const both = randomUUID();
      await seed(A, mine, 'sent');
      await seed(B, theirs, 'sent');
      await seed(A, both, 'sent');
      await seed(B, both, 'ambiguous');
      expect((await locate([mine])).map((r) => r.org_id)).toEqual([A.org]);
      expect((await locate([theirs])).map((r) => r.org_id)).toEqual([B.org]);
      expect((await locate([randomUUID()]))).toEqual([]);
      expect((await locate([both])).map((r) => r.org_id).sort()).toEqual([A.org, B.org].sort());
    });

    it('refuses an empty list and a list over a thousand', async () => {
      await expect(locate([])).rejects.toMatchObject({ message: expect.stringContaining('MISA_AMIS_LOCATE_INVALID') });
      await expect(locate(Array.from({ length: 1001 }, () => randomUUID()))).rejects.toMatchObject({ message: expect.stringContaining('MISA_AMIS_LOCATE_INVALID') });
      expect(await locate(Array.from({ length: 1000 }, () => randomUUID()))).toEqual([]);
    });

    it('finds nothing for an organisation whose Finance is off, and finds it again when it is switched on', async () => {
      const refid = randomUUID();
      await seed(B, refid, 'sent');
      expect(await locate([refid])).toHaveLength(1);
      await api.execute('kernel.org.set_app', { module: 'finance', enabled: false }, ownerOf(B));
      try {
        expect(await locate([refid])).toEqual([]);
      } finally {
        await api.execute('kernel.org.set_app', { module: 'finance', enabled: true }, ownerOf(B));
      }
      expect(await locate([refid])).toHaveLength(1);
    });
  });

  describe('the route on the real command and graph', () => {
    it('moves a sent row to accepted with the time of the answer, and a lost-answer row to refused with MISA\'s text', async () => {
      const sent = randomUUID();
      const lost = randomUUID();
      await seed(A, sent, 'sent');
      await seed(A, lost, 'ambiguous');
      const response = await post(message([{ org_refid: sent, voucher_type: 1, success: true }, { org_refid: lost, voucher_type: 1, success: false, error_message: REASON_TEXT }]));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(await stateOf(A, sent)).toMatchObject({ state: 'accepted', reason: null });
      expect((await stateOf(A, sent))?.answered_at).not.toBeNull();
      expect(await stateOf(A, lost)).toMatchObject({ state: 'refused', reason: REASON_TEXT });
    });

    it('is replay safe and forward only: the same message again, and an old failure after an acceptance, change nothing', async () => {
      const refid = randomUUID();
      await seed(A, refid, 'sent');
      const accepted = message([{ org_refid: refid, voucher_type: 1, success: true }]);
      await post(accepted);
      const [before] = await rows<{ updated_at: Date }>('SELECT updated_at FROM crove_finance.misa_amis_push WHERE org_refid = $1 AND org_id = $2', [refid, A.org]);
      expect((await post(accepted)).status).toBe(200);
      expect((await post(message([{ org_refid: refid, voucher_type: 1, success: false, error_message: REASON_TEXT }]))).status).toBe(200);
      expect(await stateOf(A, refid)).toMatchObject({ state: 'accepted', reason: null });
      const [after] = await rows<{ updated_at: Date }>('SELECT updated_at FROM crove_finance.misa_amis_push WHERE org_refid = $1 AND org_id = $2', [refid, A.org]);
      expect(after?.updated_at).toEqual(before?.updated_at);
    });

    it('moves nothing for a row still being sent, a swapped company code, a wrong voucher type or an unknown refid, and answers the same', async () => {
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
      expect((await stateOf(A, sending))?.state).toBe('sending');
      expect((await stateOf(A, swapped))?.state).toBe('sent');
      expect((await stateOf(A, typed))?.state).toBe('sent');
    });

    it("never records for a refid held by two organisations, and a signed result of one organisation cannot move another's row", async () => {
      const both = randomUUID();
      await seed(A, both, 'sent');
      await seed(B, both, 'sent');
      expect((await post(message([{ org_refid: both, voucher_type: 1, success: true }]))).status).toBe(200);
      expect((await stateOf(A, both))?.state).toBe('sent');
      expect((await stateOf(B, both))?.state).toBe('sent');
      const onlyB = randomUUID();
      await seed(B, onlyB, 'sent');
      // A's company code on B's refid: the located connection is B's, so its code does not match.
      await post(message([{ org_refid: onlyB, voucher_type: 1, success: true }], { org_company_code: A.code }));
      expect((await stateOf(B, onlyB))?.state).toBe('sent');
      // B's own code moves B's row, and A's untouched.
      await post(message([{ org_refid: onlyB, voucher_type: 1, success: true }], { org_company_code: B.code }));
      expect((await stateOf(B, onlyB))?.state).toBe('accepted');
    });

    it('acknowledges and drops the result of an organisation whose Finance is off', async () => {
      const refid = randomUUID();
      await seed(B, refid, 'sent');
      await api.execute('kernel.org.set_app', { module: 'finance', enabled: false }, ownerOf(B));
      try {
        const response = await post(message([{ org_refid: refid, voucher_type: 1, success: true }], { org_company_code: B.code }));
        expect(response.status).toBe(200);
        expect((await stateOf(B, refid))?.state).toBe('sent');
      } finally {
        await api.execute('kernel.org.set_app', { module: 'finance', enabled: true }, ownerOf(B));
      }
    });

    it('stores nothing of the message but the row\'s own state: no body, signature or ClientID in any table the callback can reach', async () => {
      const refid = randomUUID();
      await seed(A, refid, 'sent');
      const text = message([{ org_refid: refid, voucher_type: 1, success: true }]);
      const signature = (JSON.parse(text) as { signature: string }).signature;
      await post(text);
      for (const needle of [signature, CLIENT]) {
        const hits = await rows<{ n: number }>(
          `SELECT (SELECT count(*) FROM crove_finance.misa_amis_push p WHERE p::text LIKE '%' || $1 || '%')
                + (SELECT count(*) FROM crove_kernel.audit_event a WHERE a::text LIKE '%' || $1 || '%')::int AS n`,
          [needle],
        );
        expect(Number(hits[0]?.n), needle).toBe(0);
      }
    });
  });
});

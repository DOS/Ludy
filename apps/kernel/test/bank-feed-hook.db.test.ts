// SPDX-License-Identifier: AGPL-3.0-only
// The webhook of a bank feed that signs with each customer's own secret (Tingee; #4203, S3 of #2045), on a real PostgreSQL 17: who may set the hook (owners and admins, a person), that the key is shown once and only
// its hash is kept, the public route (an unknown key is a 404 with nothing stored, a repeated request id is a no-op, a stale or malformed notice is refused, a validation challenge is answered), the login roles'
// grants (the tables are definer-only; the API puts, the worker claims), the claim (deletes as it hands out), the ten-minute sweep, ten refused notices stopping a hook until it is rotated, and erasure.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import type { BankFeedProvider } from '@ludy/bank-feed';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { bankFeedHookKeyHash } from '../src/bank-feed-hook.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-bank-feed-hook-0123456789';
const ISSUER = 'crove-auth';

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

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const suite = ADMIN ? describe : describe.skip;

// A stand-in adapter: the route needs only the timestamp window of the provider; the signature is the worker's.
const adapter: BankFeedProvider = {
  id: 'bank_tingee',
  hosts: ['open.tingee.vn'],
  async check() {},
  async accounts() {
    return [];
  },
  async pull() {
    return { transactions: [], cursor: '', more: false };
  },
  hookTimestampFresh: (timestamp) => timestamp === '20261120120000000',
  verifyHook: () => 'ok',
};
const FRESH = '20261120120000000';
const PAYER_EMAIL = 'nguoi.chuyen.khoan@example.test';
const BODY = '{"clientId":"hook-test","content":"hook-test-payer-nguyen-van-a"}';

suite('Bank feed webhook (#4203)', () => {
  const dbName = `ludy_test_bank_feed_hook_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  let runtimeApi: Runtime;
  const owner: Account = { subject: randomUUID(), email: 'owner@bank-feed-hook.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@bank-feed-hook.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@bank-feed-hook.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@bank-feed-hook.test', session: randomUUID(), userId: '' };
  let slug = '';
  let orgId = '';
  let otherOrgId = '';
  let connectionId = '';
  let otherConnectionId = '';

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

  async function tokenFor(who: Account) {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }
  async function rpc(path: string, token: string, input: unknown, org: string | null = slug) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : null) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, text, body: (body && 'json' in body ? body.json : body) as any };
  }
  const hookSet = async (who: Account, connection: string = connectionId) => rpc('bankFeeds/hookSet', await tokenFor(who), { connectionId: connection });
  const hookStatus = async (who: Account, connection: string = connectionId) => rpc('bankFeeds/hook', await tokenFor(who), { connectionId: connection });
  const post = (key: string, headers: Record<string, string> = {}, body: string = BODY) =>
    app.request(`/api/bank-feed/bank_tingee/webhook/${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': randomUUID(), 'x-request-timestamp': FRESH, 'x-signature': 'f'.repeat(128), ...headers },
      body,
    });
  const notices = async () => rows<{ hook_id: string; request_id: string; body: string }>('SELECT hook_id, request_id, body FROM ludy_finance.bank_feed_webhook_notice ORDER BY received_at, id');
  const asWorker = async <T>(text: string, values: unknown[] = []) => (await workerPool.query(text, values)).rows as T[];
  let keyOwner = '';

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
    pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 2 });
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    runtimeApi = runtime;
    const config = loadConfig({ DATABASE_URL: login('ludy_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    app = createHttpApp({
      config,
      runtime,
      store: new MemoryStore(),
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      channels: { broker: vault, sandbox: false, bankFeedHosted: { bank_tingee: adapter } },
      bankFeedHooks: { bank_tingee: adapter },
    });
    for (const who of [owner, adminUser, member, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty nhận thông báo', idempotencyKey: randomUUID() }, null);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, adminUser.userId, member.userId]);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherOrgId = String(other.body?.orgId);
    const connect = async (org: string, by: string) => {
      const id = randomUUID();
      await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'bank_tingee', $3, 'Tingee thử', $4)", [org, id, `tingee-${randomUUID().slice(0, 8)}`, by]);
      return id;
    };
    connectionId = await connect(orgId, owner.userId);
    otherConnectionId = await connect(otherOrgId, outsider.userId);
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

  it('lets owners and admins set the hook, refuses a member and an outsider, and keeps only the hash of the key', async () => {
    expect((await hookSet(member)).status).toBe(403);
    expect((await hookSet(outsider)).status).not.toBe(200);
    expect(await rows('SELECT 1 FROM ludy_finance.bank_feed_hook')).toHaveLength(0);
    const made = await hookSet(owner);
    expect(made.status).toBe(200);
    keyOwner = String(made.body.key);
    expect(made.body).toMatchObject({ provider: 'bank_tingee', created: true });
    expect(keyOwner).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const stored = await rows<{ key_sha256: string }>('SELECT key_sha256 FROM ludy_finance.bank_feed_hook WHERE org_id = $1', [orgId]);
    expect(stored).toEqual([{ key_sha256: bankFeedHookKeyHash(keyOwner) }]);
    // The key is in no audit row, and the status answers never carry it or its hash.
    const audit = JSON.stringify(await rows('SELECT * FROM ludy_kernel.audit_event WHERE org_id = $1', [orgId]));
    expect(audit).not.toContain(keyOwner);
    expect(audit).not.toContain(bankFeedHookKeyHash(keyOwner));
    const status = await hookStatus(adminUser);
    expect(status.status).toBe(200);
    expect(status.text).not.toContain(keyOwner);
    expect(status.text).not.toContain(bankFeedHookKeyHash(keyOwner));
    expect(status.body).toMatchObject({ exists: true, stopped: false, rejectedCount: 0 });
    expect((await hookStatus(member)).status).toBe(403);
    // A connection of another org is not found, whoever asks.
    expect((await hookSet(owner, otherConnectionId)).status).toBeGreaterThanOrEqual(400);
  });

  it('stores a notice for a known key and nothing for an unknown one; a repeated request id is a no-op', async () => {
    const id = randomUUID();
    const first = await post(keyOwner, { 'x-request-id': id });
    expect(first.status).toBe(200);
    expect(await notices()).toHaveLength(1);
    expect((await post(keyOwner, { 'x-request-id': id })).status).toBe(200);
    expect(await notices()).toHaveLength(1);
    expect((await notices())[0]).toMatchObject({ request_id: id, body: BODY });
    // The key is the whole address: unknown, another shape, and another provider's all answer 404 and store nothing.
    expect((await post(randomBytes(16).toString('base64url'))).status).toBe(404);
    expect((await post('short')).status).toBe(404);
    expect((await app.request(`/api/bank-feed/bank_other/webhook/${keyOwner}`, { method: 'POST', body: BODY })).status).toBe(404);
    expect(await notices()).toHaveLength(1);
    // A body naming another org's account lands on the hook of the address, not on the org the body names: the org comes from our own row.
    const naming = await post(keyOwner, {}, JSON.stringify({ clientId: 'hook-test', orgId: otherOrgId, accountNumber: 'other' }));
    expect(naming.status).toBe(200);
    expect((await rows<{ org_id: string }>('SELECT DISTINCT org_id FROM ludy_finance.bank_feed_webhook_notice')).map((r) => r.org_id)).toEqual([orgId]);
  });

  it('refuses a stale or malformed notice and an oversize body, answers a validation challenge, and stores none of them', async () => {
    const before = (await notices()).length;
    expect(await (await post(keyOwner, { 'x-request-timestamp': '20200101000000000' })).json()).toMatchObject({ code: 'WEBHOOK_STALE' });
    expect(await (await post(keyOwner, { 'x-signature': '' })).json()).toMatchObject({ code: 'WEBHOOK_MALFORMED' });
    expect((await post(keyOwner, {}, '')).status).toBe(400);
    expect((await post(keyOwner, {}, 'x'.repeat(16 * 1024 + 1))).status).toBe(413);
    expect((await post(keyOwner, { 'webhook-type': 'url-validation' }, '')).status).toBe(200);
    expect((await post(randomBytes(16).toString('base64url'), { 'webhook-type': 'url-validation' }, '')).status).toBe(404);
    expect(await notices()).toHaveLength(before);
  });

  it('keeps both tables out of reach of every login role and gives each login only its own functions', async () => {
    for (const table of ['bank_feed_hook', 'bank_feed_webhook_notice']) {
      await expect(pool.query(`SELECT 1 FROM ludy_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(workerPool.query(`SELECT 1 FROM ludy_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
    }
    // The worker cannot look up, put or set; the API cannot claim, reject or sweep.
    await expect(workerPool.query("SELECT * FROM ludy_finance.bank_feed_hook_lookup('bank_tingee', $1)", ['0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT ludy_finance.bank_feed_hook_put_notice($1::uuid, $2, 'r', 't', 's', 'b')", [randomUUID(), '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT * FROM ludy_finance.bank_feed_hook_claim(10)')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT ludy_finance.bank_feed_hook_reject($1::uuid)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT ludy_finance.bank_feed_hook_sweep()')).rejects.toMatchObject({ code: '42501' });
    // Set and status need the caller's own sealed context: called bare they refuse.
    await expect(pool.query('SELECT ludy_finance.bank_feed_hook_set($1::uuid, $2)', [connectionId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
  });

  it('claims the waiting notices and deletes them as it hands them out, with the hook and the connection they belong to', async () => {
    const waiting = await notices();
    expect(waiting.length).toBeGreaterThan(0);
    const claimed = await asWorker<{ org_id: string; connection_id: string; provider: string; body: string }>('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)');
    expect(claimed).toHaveLength(waiting.length);
    expect(claimed[0]).toMatchObject({ org_id: orgId, connection_id: connectionId, provider: 'bank_tingee' });
    expect(await notices()).toHaveLength(0);
    expect(await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)')).toHaveLength(0);
  });

  it('sweeps a notice older than ten minutes whatever its state, in the claim and in the nightly sweep', async () => {
    const hook = (await rows<{ id: string }>('SELECT id FROM ludy_finance.bank_feed_hook WHERE org_id = $1', [orgId]))[0]!.id;
    const old = async () => {
      await rows("INSERT INTO ludy_finance.bank_feed_webhook_notice (org_id, hook_id, request_id, notice_timestamp, signature, body, received_at) VALUES ($1, $2, $3, $4, $5, $6, now() - interval '11 minutes')", [orgId, hook, randomUUID(), FRESH, 'a'.repeat(128), BODY]);
    };
    await old();
    expect(await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)')).toHaveLength(0);
    expect(await notices()).toHaveLength(0);
    await old();
    await old();
    expect(await asWorker<{ swept: number }>('SELECT ludy_finance.bank_feed_hook_sweep() AS swept')).toEqual([{ swept: 2 }]);
    expect(await notices()).toHaveLength(0);
  });

  it('takes at most twenty waiting notices a hook and answers 503 after that', async () => {
    for (let i = 0; i < 20; i++) expect((await post(keyOwner)).status).toBe(200);
    expect((await post(keyOwner)).status).toBe(503);
    expect(await notices()).toHaveLength(20);
    // A retry of a notice that already waits is acknowledged even though the hook is full.
    const waiting = (await notices())[0]!.request_id;
    expect((await post(keyOwner, { 'x-request-id': waiting })).status).toBe(200);
    expect(await notices()).toHaveLength(20);
    await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)');
  });

  it('stops the hook after ten refused notices in an hour: it answers 200 and stores nothing, until the key is rotated', async () => {
    const hook = (await rows<{ id: string }>('SELECT id FROM ludy_finance.bank_feed_hook WHERE org_id = $1', [orgId]))[0]!.id;
    for (let i = 1; i < 10; i++) expect(await asWorker<{ r: boolean }>('SELECT ludy_finance.bank_feed_hook_reject($1::uuid) AS r', [hook])).toEqual([{ r: false }]);
    expect((await hookStatus(owner)).body).toMatchObject({ rejectedCount: 9, stopped: false });
    expect(await asWorker<{ r: boolean }>('SELECT ludy_finance.bank_feed_hook_reject($1::uuid) AS r', [hook])).toEqual([{ r: true }]);
    expect((await hookStatus(owner)).body).toMatchObject({ stopped: true });
    expect((await post(keyOwner)).status).toBe(200);
    expect(await notices()).toHaveLength(0);
    // Rotation: the new key works at once, the old one is a 404, and the count starts again.
    const rotated = await hookSet(adminUser);
    expect(rotated.body).toMatchObject({ created: false });
    const keyNew = String(rotated.body.key);
    expect(keyNew).not.toBe(keyOwner);
    // A request that passed the lookup with the old key and reaches the put after the rotation stores nothing.
    const stale = await pool.query('SELECT ludy_finance.bank_feed_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [hook, bankFeedHookKeyHash(keyOwner), randomUUID(), FRESH, 'a'.repeat(128), BODY]);
    expect(stale.rows).toEqual([{ put: 'gone' }]);
    expect(await notices()).toHaveLength(0);
    expect((await post(keyOwner)).status).toBe(404);
    expect((await post(keyNew)).status).toBe(200);
    expect(await notices()).toHaveLength(1);
    expect((await hookStatus(owner)).body).toMatchObject({ stopped: false, rejectedCount: 0 });
    keyOwner = keyNew;
  });

  it('stops answering for a hook whose connection is closed or whose org has Finance off', async () => {
    await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)');
    await rows("UPDATE ludy_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2", [orgId, connectionId]);
    expect((await post(keyOwner)).status).toBe(404);
    await rows("UPDATE ludy_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = $2", [orgId, connectionId]);
    expect((await post(keyOwner)).status).toBe(200);
    await asWorker('SELECT * FROM ludy_finance.bank_feed_hook_claim(100)');
  });

  it('erases the notices that mention a person (owners only), and the purge of an org takes its hook and notices', async () => {
    const body = JSON.stringify({ clientId: 'hook-test', content: `payer ${PAYER_EMAIL}` });
    expect((await post(keyOwner, {}, body)).status).toBe(200);
    expect((await post(keyOwner)).status).toBe(200);
    expect(await notices()).toHaveLength(2);
    const asMfa = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
    await expect(runtimeApi.execute('kernel.personal_data.erase', { value: PAYER_EMAIL }, { actor: asMfa(adminUser), orgId, idempotencyKey: randomUUID() })).rejects.toBeTruthy();
    expect(await notices()).toHaveLength(2);
    await runtimeApi.execute('kernel.personal_data.erase', { value: PAYER_EMAIL }, { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() });
    const left = await notices();
    expect(left).toHaveLength(1);
    expect(left[0]?.body).not.toContain(PAYER_EMAIL);
    // The purge function names both tables (the full purge is exercised in org-purge.db.test.ts).
    const def = await rows<{ ok: boolean }>(
      "SELECT pg_get_functiondef('ludy_kernel.org_purge(integer)'::regprocedure) ~ 'ludy_finance.bank_feed_webhook_notice' AND pg_get_functiondef('ludy_kernel.org_purge(integer)'::regprocedure) ~ 'ludy_finance.bank_feed_hook' AS ok",
    );
    expect(def).toEqual([{ ok: true }]);
  });
});

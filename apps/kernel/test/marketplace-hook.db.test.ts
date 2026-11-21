// SPDX-License-Identifier: AGPL-3.0-only
// The push hook of a marketplace connection (#4316, S1 of #4315), on a real PostgreSQL 17, at the level of the SQL definers (the route is S2, the worker relay and the owner's command are S3): the lookup by the
// hash of a key (an unknown key, another adapter's key and the offline adapter all find nothing), the put (accepted, a repeated dedupe key is a no-op, a retired key stores nothing, the backlog bound), the login roles'
// grants (both tables are definer-only; the API puts, the worker claims), the claim (deletes as it hands out and returns the bytes), the ten-minute sweep, ten refused pushes stopping a hook, the body found nowhere
// but its own row (no outbox, audit or job row ever holds it), erasure, and that the org purge names both tables.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-marketplace-hook-0123456789';
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

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const CANARY = 'hook-canary-7d1f0c3a-do-not-keep';
// The bytes of a push, with one byte that is not valid UTF-8: the carrier must hand back exactly what was put.
const BODY = Buffer.concat([Buffer.from(`{"shop_id":"7495540735365777507","note":"${CANARY}"}`), Buffer.from([0xff, 0xfe])]);
const HEADER = 'a'.repeat(64);

suite('Marketplace push hook (#4316)', () => {
  const dbName = `crove_test_marketplace_hook_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  const owner: Account = { subject: randomUUID(), email: 'owner@marketplace-hook.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@marketplace-hook.test', session: randomUUID(), userId: '' };
  let orgId = '';
  let otherOrgId = '';
  let connectionId = '';
  let otherConnectionId = '';
  let hookId = '';
  let otherHookId = '';
  const key = randomBytes(16).toString('base64url');
  const otherKey = randomBytes(16).toString('base64url');

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
  const asApi = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => (await pool.query<T>(text, values)).rows;
  const asWorker = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => (await workerPool.query<T>(text, values)).rows;
  const put = async (hook: string, keyHash: string, dedupe: string, body: Buffer = BODY) =>
    (await asApi<{ put: string }>('SELECT crove_finance.marketplace_hook_put_notice($1::uuid, $2, $3, $4, $5) AS put', [hook, keyHash, dedupe, HEADER, body]))[0]?.put;
  const waiting = async () => rows<{ hook_id: string; dedupe_key: string }>('SELECT hook_id, dedupe_key FROM crove_finance.marketplace_hook_notice ORDER BY received_at, id');

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
  async function rpc(path: string, token: string, input: unknown, org: string | null = null) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : null) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({ DATABASE_URL: login('crove_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    app = createHttpApp({ config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels: { broker: vault, sandbox: false } });
    for (const who of [owner, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty nhận push', idempotencyKey: randomUUID() }, null);
    orgId = String(created.body?.orgId);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherOrgId = String(other.body?.orgId);
    // A marketplace connection of each org (the channel connection that holds its credential, then the connection itself: its entity is the org's default, by its trigger), and a hook of each.
    const connect = async (org: string, by: string, adapter: string) => {
      const channel = randomUUID();
      const connection = randomUUID();
      await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, 'Sàn thử', $5)", [org, channel, `marketplace_${adapter}`, `acct-${randomUUID().slice(0, 8)}`, by]);
      await rows('INSERT INTO crove_finance.marketplace_connection (org_id, id, channel_connection_id, provider, platform) VALUES ($1, $2, $3, $4, $5)', [org, connection, channel, `marketplace_${adapter}`, adapter]);
      return connection;
    };
    connectionId = await connect(orgId, owner.userId, 'shopee');
    otherConnectionId = await connect(otherOrgId, outsider.userId, 'tiktok_shop');
    hookId = (await rows<{ id: string }>('INSERT INTO crove_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id', [orgId, connectionId, sha(key)]))[0]?.id ?? '';
    otherHookId = (await rows<{ id: string }>('INSERT INTO crove_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id', [otherOrgId, otherConnectionId, sha(otherKey)]))[0]?.id ?? '';
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

  it('finds a hook only for its own adapter and a real key: an unknown key, another adapter, the offline adapter and a malformed hash all find nothing', async () => {
    const lookup = (adapter: string, hash: string) => asApi<{ hook_id: string; standing: string }>('SELECT * FROM crove_finance.marketplace_hook_lookup($1, $2)', [adapter, hash]);
    expect(await lookup('shopee', sha(key))).toEqual([{ hook_id: hookId, standing: 'ok' }]);
    expect(await lookup('tiktok_shop', sha(otherKey))).toEqual([{ hook_id: otherHookId, standing: 'ok' }]);
    expect(await lookup('lazada', sha(key))).toEqual([]);
    expect(await lookup('shopee', sha(otherKey))).toEqual([]);
    expect(await lookup('shopee', sha('unknown'))).toEqual([]);
    expect(await lookup('sandbox', sha(key))).toEqual([]);
    expect(await lookup('shopee', 'not-a-hash')).toEqual([]);
  });

  it('stores a push for a known key: the same header and body are a no-op, a retired key or another hook stores nothing, and the bytes come back exactly', async () => {
    expect(await put(hookId, sha(key), sha('one'))).toBe('accepted');
    expect(await put(hookId, sha(key), sha('one'))).toBe('duplicate');
    expect(await waiting()).toEqual([{ hook_id: hookId, dedupe_key: sha('one') }]);
    // A key that is not the hook's current one (rotated since the lookup), and a hook that is not there, store nothing.
    expect(await put(hookId, sha(otherKey), sha('two'))).toBe('gone');
    expect(await put(randomUUID(), sha(key), sha('three'))).toBe('gone');
    expect(await waiting()).toHaveLength(1);
    const [stored] = await rows<{ body: Buffer; authorization_header: string; org_id: string }>('SELECT body, authorization_header, org_id FROM crove_finance.marketplace_hook_notice');
    expect(Buffer.compare(stored?.body ?? Buffer.alloc(0), BODY)).toBe(0);
    expect(stored).toMatchObject({ authorization_header: HEADER, org_id: orgId });
    // A body past 16 KB, an empty one and a dedupe key of the wrong shape are refused before any row is read.
    await expect(put(hookId, sha(key), sha('big'), Buffer.alloc(16385, 1))).rejects.toMatchObject({ code: '22P02' });
    await expect(put(hookId, sha(key), sha('empty'), Buffer.alloc(0))).rejects.toMatchObject({ code: '22P02' });
    await expect(put(hookId, sha(key), 'short')).rejects.toMatchObject({ code: '22P02' });
  });

  it('keeps both tables definer-only and each function to its own login', async () => {
    for (const table of ['marketplace_hook', 'marketplace_hook_notice']) {
      await expect(pool.query(`SELECT 1 FROM crove_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(workerPool.query(`SELECT 1 FROM crove_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(workerPool.query("SELECT * FROM crove_finance.marketplace_hook_lookup('shopee', $1)", ['0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT crove_finance.marketplace_hook_put_notice($1::uuid, $2, $3, $4, $5)', [randomUUID(), '0'.repeat(64), '0'.repeat(64), 'a', Buffer.from('b')])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT * FROM crove_finance.marketplace_hook_claim(10)')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT crove_finance.marketplace_hook_reject($1::uuid)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT crove_finance.marketplace_hook_sweep()')).rejects.toMatchObject({ code: '42501' });
    // The owner's side needs a sealed context of an owner or admin: with none, even the API login is refused.
    await expect(pool.query('SELECT crove_finance.marketplace_hook_set($1::uuid, $2)', [connectionId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT * FROM crove_finance.marketplace_hook_status($1::uuid)', [connectionId])).rejects.toMatchObject({ code: '42501' });
  });

  it('claims the waiting pushes with their bytes and deletes them as it hands them out, one push for each org', async () => {
    expect(await put(otherHookId, sha(otherKey), sha('other'))).toBe('accepted');
    const claimed = await asWorker<{ org_id: string; hook_id: string; marketplace_connection_id: string; adapter: string; platform: string; dedupe_key: string; authorization_header: string; body: Buffer }>(
      'SELECT * FROM crove_finance.marketplace_hook_claim(10)',
    );
    expect(claimed.map((c) => [c.org_id, c.hook_id, c.marketplace_connection_id, c.adapter, c.platform, c.dedupe_key]).sort()).toEqual(
      [
        [orgId, hookId, connectionId, 'shopee', 'shopee', sha('one')],
        [otherOrgId, otherHookId, otherConnectionId, 'tiktok_shop', 'tiktok_shop', sha('other')],
      ].sort(),
    );
    const mine = claimed.find((c) => c.hook_id === hookId);
    expect(Buffer.compare(mine?.body ?? Buffer.alloc(0), BODY)).toBe(0);
    expect(await waiting()).toEqual([]);
    expect(await asWorker('SELECT * FROM crove_finance.marketplace_hook_claim(10)')).toEqual([]);
  });

  it('sweeps a push older than ten minutes, whatever it holds, with the next claim and with the sweep', async () => {
    await rows("INSERT INTO crove_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body, received_at) VALUES ($1, $2, $3, $4, $5, now() - interval '11 minutes')", [orgId, hookId, sha('old-1'), HEADER, BODY]);
    await rows("INSERT INTO crove_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body, received_at) VALUES ($1, $2, $3, $4, $5, now() - interval '12 minutes')", [orgId, hookId, sha('old-2'), HEADER, BODY]);
    expect(await asWorker('SELECT * FROM crove_finance.marketplace_hook_claim(10)')).toEqual([]);
    expect(await waiting()).toEqual([]);
    await rows("INSERT INTO crove_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body, received_at) VALUES ($1, $2, $3, $4, $5, now() - interval '11 minutes')", [orgId, hookId, sha('old-3'), HEADER, BODY]);
    expect((await asWorker<{ swept: number }>('SELECT crove_finance.marketplace_hook_sweep() AS swept'))[0]?.swept).toBe(1);
    expect(await waiting()).toEqual([]);
  });

  it('bounds the backlog: twenty waiting for a hook, then busy; a retry of one that waits is still acknowledged', async () => {
    for (let n = 0; n < 20; n++) expect(await put(hookId, sha(key), sha(`bulk-${n}`))).toBe('accepted');
    expect(await put(hookId, sha(key), sha('bulk-extra'))).toBe('busy');
    expect(await put(hookId, sha(key), sha('bulk-3'))).toBe('duplicate');
    expect((await asWorker('SELECT * FROM crove_finance.marketplace_hook_claim(100)')).length).toBe(20);
    expect(await waiting()).toEqual([]);
  });

  it('finds the body nowhere but in its own row: no outbox, archive, audit or job row holds it, and the wake-up carries no payload', async () => {
    const heard: string[] = [];
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    listener.on('notification', (message) => heard.push(String(message.payload ?? '')));
    await listener.query('LISTEN crove_outbox');
    expect(await put(hookId, sha(key), sha('canary'))).toBe('accepted');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await listener.end();
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((payload) => payload === '')).toBe(true);
    await asWorker('SELECT * FROM crove_finance.marketplace_hook_claim(10)');
    const tables = await rows<{ table_schema: string; table_name: string }>("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('crove_kernel', 'pgboss') AND table_type = 'BASE TABLE'");
    for (const { table_schema, table_name } of tables) {
      const found = await rows<{ hit: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table_schema}.${table_name} t WHERE t::text LIKE $1) AS hit`, [`%${CANARY}%`]);
      expect({ table: `${table_schema}.${table_name}`, hit: found[0]?.hit }).toEqual({ table: `${table_schema}.${table_name}`, hit: false });
    }
  });

  it('stops a hook after ten refused pushes in an hour: the lookup says stopped, a push stores nothing, and the claim hands back nothing of it', async () => {
    for (let n = 1; n < 10; n++) expect((await asWorker<{ stopped: boolean }>('SELECT crove_finance.marketplace_hook_reject($1::uuid) AS stopped', [otherHookId]))[0]?.stopped).toBe(false);
    expect((await asWorker<{ stopped: boolean }>('SELECT crove_finance.marketplace_hook_reject($1::uuid) AS stopped', [otherHookId]))[0]?.stopped).toBe(true);
    expect(await asApi('SELECT * FROM crove_finance.marketplace_hook_lookup($1, $2)', ['tiktok_shop', sha(otherKey)])).toEqual([{ hook_id: otherHookId, standing: 'stopped' }]);
    expect(await put(otherHookId, sha(otherKey), sha('stopped'))).toBe('gone');
    // A push that waited when the hook was stopped is deleted by the claim and not handed out.
    await rows('INSERT INTO crove_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body) VALUES ($1, $2, $3, $4, $5)', [otherOrgId, otherHookId, sha('late'), HEADER, BODY]);
    expect(await asWorker('SELECT * FROM crove_finance.marketplace_hook_claim(10)')).toEqual([]);
    expect(await waiting()).toEqual([]);
    // The other hook is untouched by it.
    expect(await asApi('SELECT * FROM crove_finance.marketplace_hook_lookup($1, $2)', ['shopee', sha(key)])).toEqual([{ hook_id: hookId, standing: 'ok' }]);
  });

  it('takes nothing for a closed org connection and removes the pushes with their hook', async () => {
    expect(await put(hookId, sha(key), sha('closing'))).toBe('accepted');
    await rows("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = (SELECT channel_connection_id FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2)", [orgId, connectionId]);
    expect(await asApi('SELECT * FROM crove_finance.marketplace_hook_lookup($1, $2)', ['shopee', sha(key)])).toEqual([]);
    expect(await put(hookId, sha(key), sha('closed'))).toBe('gone');
    // What waited for a connection that is no longer active is deleted by the claim, not handed out.
    expect(await asWorker('SELECT * FROM crove_finance.marketplace_hook_claim(10)')).toEqual([]);
    expect(await waiting()).toEqual([]);
    await rows("UPDATE crove_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = (SELECT channel_connection_id FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2)", [orgId, connectionId]);
    await rows('INSERT INTO crove_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body) VALUES ($1, $2, $3, $4, $5)', [orgId, hookId, sha('cascade'), HEADER, BODY]);
    await rows('DELETE FROM crove_finance.marketplace_hook WHERE org_id = $1 AND id = $2', [orgId, hookId]);
    expect(await waiting()).toEqual([]);
  });

  it('names both tables in the org purge', async () => {
    const [purge] = await rows<{ ok: boolean }>(
      "SELECT pg_get_functiondef('crove_kernel.org_purge(integer)'::regprocedure) ~ 'crove_finance.marketplace_hook_notice' AND pg_get_functiondef('crove_kernel.org_purge(integer)'::regprocedure) ~ 'crove_finance.marketplace_hook' AS ok",
    );
    expect(purge?.ok).toBe(true);
  });
});

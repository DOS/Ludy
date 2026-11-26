// SPDX-License-Identifier: AGPL-3.0-only
// The push hook of a marketplace connection (#4316, S1 of #4315), on a real PostgreSQL 17, at the level of the SQL definers (the route is S2, the worker relay and the owner's command are S3): the lookup by the
// hash of a key (an unknown key, another adapter's key and the offline adapter all find nothing), the put (accepted, a repeated dedupe key is a no-op, a retired key stores nothing, a put deleting its hook's stale pushes, the backlog bound), the login roles'
// grants (both tables are definer-only; the API puts, the worker claims), the claim (deletes as it hands out and returns the bytes), the ten-minute sweep, ten refused pushes stopping a hook, the body found nowhere
// but its own row (no outbox, audit or job row ever holds it), and that the org purge names both tables. The owner's side (set, status) and the erasure need a sealed context, so they are tested with the command that
// calls them (S3); here the API login is shown to be refused them without one.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { CredentialVault, mintContextToken, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-marketplace-hook-0123456789';
const ISSUER = 'ludy-auth';

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
  const dbName = `ludy_test_marketplace_hook_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  let runtime: Runtime;
  const owner: Account = { subject: randomUUID(), email: 'owner@marketplace-hook.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@marketplace-hook.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@marketplace-hook.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@marketplace-hook.test', session: randomUUID(), userId: '' };
  let orgId = '';
  let otherOrgId = '';
  // The org header of a call is the org's slug.
  let slug = '';
  let otherSlug = '';
  let connectionId = '';
  let otherConnectionId = '';
  let hookId = '';
  let otherHookId = '';
  let preUpgradeConnId = '';
  let preUpgradeHookId = '';
  let preUpgradeClaimId = '';
  let preUpgradeRotatedKey = '';
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
  async function asSealedApp<T extends pg.QueryResultRow = Record<string, unknown>>(
    who: Account,
    org: string,
    text: string,
    values: unknown[] = [],
    claims: { aal?: 'aal1' | 'aal2'; mfaAt?: number | null } = {},
  ) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ctxToken = mintContextToken(process.env.LUDY_CONTEXT_TOKEN_KEY ?? process.env.CROVE_CONTEXT_TOKEN_KEY ?? '', {
        userId: who.userId,
        orgId: org,
        sessionId: who.session,
        aal: claims.aal ?? 'aal1',
        mfaAt: claims.mfaAt ?? null,
      });
      await client.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [org, ctxToken]);
      const res = await client.query<T>(text, values);
      await client.query('COMMIT');
      return res.rows;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  const put = async (hook: string, keyHash: string, dedupe: string, body: Buffer = BODY, requestUrl: string | null = null) =>
    (await asApi<{ put: string }>('SELECT ludy_finance.marketplace_hook_put_notice($1::uuid, $2, $3, $4, $5, $6) AS put', [hook, keyHash, dedupe, HEADER, body, requestUrl]))[0]?.put;
  const waiting = async () => rows<{ hook_id: string; dedupe_key: string }>('SELECT hook_id, dedupe_key FROM ludy_finance.marketplace_hook_notice ORDER BY received_at, id');

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
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-ludy-org': org } : {}) },
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
    const preRoot = mkdtempSync(join(tmpdir(), 'ludy-4326-pre-'));
    const preDir = join(preRoot, 'migrations');
    const preVariantsDir = join(preRoot, 'shared-variants');
    try {
      mkdirSync(preDir);
      mkdirSync(preVariantsDir);
      const migrationNames = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort();
      const cutFile = migrationNames.find((n) => n.endsWith('_ludy_finance_marketplace_hook_reject_generation.sql'));
      expect(cutFile).toBeTruthy();
      const keptMigrations = new Set<string>();
      for (const name of migrationNames) {
        if (name < cutFile!) {
          symlinkSync(join(MIGRATIONS, name), join(preDir, name));
          keptMigrations.add(name);
        }
      }
      const variantsSource = fileURLToPath(new URL('../../../supabase/shared-variants', import.meta.url));
      if (existsSync(variantsSource)) {
        for (const name of readdirSync(variantsSource)) {
          if (keptMigrations.has(name)) symlinkSync(join(variantsSource, name), join(preVariantsDir, name));
        }
      }
      await migrate({
        adminUrl,
        dir: preDir,
        sharedVariantsDir: preVariantsDir,
      });
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
      runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
      const config = loadConfig({ DATABASE_URL: login('ludy_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
      const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
      app = createHttpApp({ config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels: { broker: vault, sandbox: false, apiUrl: 'https://api.example.test', marketplaceProviders: { shopee: { id: 'shopee', hosts: [] }, tiktok_shop: { id: 'tiktok_shop', hosts: [] } } as never }, marketplacePush: { adapters: ['shopee', 'tiktok_shop'] } });
      for (const who of [owner, outsider, adminUser, member]) {
        const me = await rpc('me/get', await tokenFor(who), undefined, null);
        expect(me.status).toBe(200);
        who.userId = String(me.body?.userId);
      }
      const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty nhận push', idempotencyKey: randomUUID() }, null);
      orgId = String(created.body?.orgId);
      slug = String(created.body?.slug);
      const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
      otherOrgId = String(other.body?.orgId);
      otherSlug = String(other.body?.slug);
      await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [orgId, adminUser.userId, member.userId]);
      // A marketplace connection of each org (the channel connection that holds its credential, then the connection itself: its entity is the org's default, by its trigger), and a hook of each.
      const connect = async (org: string, by: string, adapter: string) => {
        const channel = randomUUID();
        const connection = randomUUID();
        await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, 'Sàn thử', $5)", [org, channel, `marketplace_${adapter}`, `acct-${randomUUID().slice(0, 8)}`, by]);
        await rows('INSERT INTO ludy_finance.marketplace_connection (org_id, id, channel_connection_id, provider, platform) VALUES ($1, $2, $3, $4, $5)', [org, connection, channel, `marketplace_${adapter}`, adapter]);
        return connection;
      };
      connectionId = await connect(orgId, owner.userId, 'shopee');
      otherConnectionId = await connect(otherOrgId, outsider.userId, 'tiktok_shop');
      hookId = (await rows<{ id: string }>('INSERT INTO ludy_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id', [orgId, connectionId, sha(key)]))[0]?.id ?? '';
      otherHookId = (await rows<{ id: string }>('INSERT INTO ludy_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id', [otherOrgId, otherConnectionId, sha(otherKey)]))[0]?.id ?? '';

      // Simulate a hook claimed before rotation and rotated right before applying 20270328170000 (#4326).
      preUpgradeConnId = await connect(otherOrgId, outsider.userId, 'lazada');
      const preOldKey = randomBytes(16).toString('base64url');
      await asSealedApp(outsider, otherOrgId, 'SELECT ludy_finance.marketplace_hook_set($1::uuid, $2)', [preUpgradeConnId, sha(preOldKey)]);
      preUpgradeHookId = (await rows<{ id: string }>('SELECT id FROM ludy_finance.marketplace_hook WHERE marketplace_connection_id = $1', [preUpgradeConnId]))[0]?.id ?? '';
      expect(await put(preUpgradeHookId, sha(preOldKey), sha('pre-upgrade-push'))).toBe('accepted');
      const preClaims = await asWorker<{ hook_id: string }>('SELECT hook_id FROM ludy_finance.marketplace_hook_claim(10)');
      expect(preClaims).toEqual([{ hook_id: preUpgradeHookId }]);
      preUpgradeClaimId = preClaims[0]!.hook_id;
      preUpgradeRotatedKey = randomBytes(16).toString('base64url');
      await asSealedApp(outsider, otherOrgId, 'SELECT ludy_finance.marketplace_hook_set($1::uuid, $2)', [preUpgradeConnId, sha(preUpgradeRotatedKey)]);

      await migrate({ adminUrl, dir: MIGRATIONS });
    } finally {
      rmSync(preRoot, { recursive: true, force: true });
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

  // The owner's command and the status (S3b, #4348), through the real app: a connection of its own (TikTok Shop) so the hook of the other tests is not touched.
  describe('the owner command and the status', () => {
    let pushConnectionId = '';
    // The call names the caller's own org by its slug (the outsider's is the other one, so a connection of this org is not found for it, as an unknown id is).
    const orgOf = (who: Account) => (who === outsider ? otherSlug : slug);
    const pushSet = async (who: Account, id: string = pushConnectionId) => rpc('marketplace/connections/pushHookSet', await tokenFor(who), { id }, orgOf(who));
    const pushStatus = async (who: Account, id: string = pushConnectionId) => rpc('marketplace/connections/pushHook', await tokenFor(who), { id }, orgOf(who));
    const keyOf = (address: string) => String(address.split('/').pop());
    const lookupTiktok = (hash: string) => asApi<{ hook_id: string; standing: string }>('SELECT * FROM ludy_finance.marketplace_hook_lookup($1, $2)', ['tiktok_shop', hash]);

    beforeAll(async () => {
      const channel = randomUUID();
      pushConnectionId = randomUUID();
      await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'marketplace_tiktok_shop', $3, 'Sàn thử', $4)", [orgId, channel, `acct-${randomUUID().slice(0, 8)}`, owner.userId]);
      await rows("INSERT INTO ludy_finance.marketplace_connection (org_id, id, channel_connection_id, provider, platform) VALUES ($1, $2, $3, 'marketplace_tiktok_shop', 'tiktok_shop')", [orgId, pushConnectionId, channel]);
    });

    it('lets owners and admins make the address, refuses a member and an outsider, and keeps only the hash of the key', async () => {
      expect((await pushSet(member)).status).toBe(403);
      // The outsider's own org does not hold this connection: the same 404 an unknown id gets.
      expect(await pushSet(outsider)).toMatchObject({ status: 404, body: { code: 'MARKETPLACE_CONNECTION_NOT_FOUND' } });
      expect(await rows('SELECT 1 FROM ludy_finance.marketplace_hook WHERE marketplace_connection_id = $1', [pushConnectionId])).toHaveLength(0);
      const made = await pushSet(owner);
      expect(made.status).toBe(200);
      expect(made.body).toMatchObject({ adapter: 'tiktok_shop', created: true });
      const address = String(made.body.address);
      const newKey = keyOf(address);
      expect(newKey).toMatch(/^[A-Za-z0-9_-]{22}$/);
      // The address is the configured public URL, the adapter and the key, and nothing else.
      expect(address).toBe(`https://api.example.test/api/marketplace/tiktok_shop/webhook/${newKey}`);
      expect(made.body.key).toBeUndefined();
      const stored = await rows<{ key_sha256: string }>('SELECT key_sha256 FROM ludy_finance.marketplace_hook WHERE marketplace_connection_id = $1', [pushConnectionId]);
      expect(stored).toEqual([{ key_sha256: sha(newKey) }]);
      expect(await lookupTiktok(sha(newKey))).toEqual([{ hook_id: expect.any(String), standing: 'ok' }]);
      // The key, its hash and the address are in no audit row, and the status answers never carry them.
      const audit = JSON.stringify(await rows('SELECT * FROM ludy_kernel.audit_event WHERE org_id = $1', [orgId]));
      for (const secret of [newKey, sha(newKey), address]) expect(audit).not.toContain(secret);
      const status = await pushStatus(adminUser);
      expect(status.status).toBe(200);
      for (const secret of [newKey, sha(newKey), address]) expect(JSON.stringify(status.body)).not.toContain(secret);
      expect(status.body).toMatchObject({ exists: true, createdAt: expect.any(String), rotatedAt: null, lastSeenAt: null, stopped: false, rejectedCount: 0 });
      expect((await pushStatus(owner)).status).toBe(200);
      expect((await pushStatus(member)).status).toBe(403);
      // A connection of another org, or one that does not exist, is not found whichever of the two calls asks: the same 404 and code, so an id of another org learns nothing from either.
      for (const id of [otherConnectionId, randomUUID()]) {
        expect(await pushSet(owner, id)).toMatchObject({ status: 404, body: { code: 'MARKETPLACE_CONNECTION_NOT_FOUND' } });
        expect(await pushStatus(owner, id)).toMatchObject({ status: 404, body: { code: 'MARKETPLACE_CONNECTION_NOT_FOUND' } });
      }
      expect(await pushStatus(outsider)).toMatchObject({ status: 404, body: { code: 'MARKETPLACE_CONNECTION_NOT_FOUND' } });
    });

    it('replaces the address: the old key stops at once, waiting pushes go, stale-generation rejections stay ignored, and a stopped hook takes pushes again', async () => {
      const [first] = await rows<{ id: string; key_sha256: string; generation: number }>('SELECT id, key_sha256, generation FROM ludy_finance.marketplace_hook WHERE marketplace_connection_id = $1', [pushConnectionId]);
      const hookOfPush = first?.id ?? '';
      const oldHash = first?.key_sha256 ?? '';
      const gen1 = first?.generation ?? 1;
      expect(gen1).toBe(1);
      expect(await put(hookOfPush, oldHash, sha('before-rotation'))).toBe('accepted');
      for (let i = 1; i < 10; i++) expect(await asWorker<{ r: boolean }>('SELECT ludy_finance.marketplace_hook_reject($1::uuid, $2::int) AS r', [hookOfPush, gen1])).toEqual([{ r: false }]);
      expect(await asWorker<{ r: boolean }>('SELECT ludy_finance.marketplace_hook_reject($1::uuid, $2::int) AS r', [hookOfPush, gen1])).toEqual([{ r: true }]);
      expect((await pushStatus(owner)).body).toMatchObject({ stopped: true, rejectedCount: 10, rotatedAt: null });
      const rotated = await pushSet(adminUser);
      expect(rotated.status).toBe(200);
      expect(rotated.body).toMatchObject({ adapter: 'tiktok_shop', created: false });
      const [afterRotate] = await rows<{ generation: number }>('SELECT generation FROM ludy_finance.marketplace_hook WHERE id = $1', [hookOfPush]);
      const gen2 = afterRotate?.generation ?? 0;
      expect(gen2).toBe(gen1 + 1);
      // A pre-rotation refusal arriving after rotation (generation 1 vs 2, or via the 1-arg compatibility shim) never counts against or stops the rotated address.
      expect(await asWorker<{ r: boolean }>('SELECT ludy_finance.marketplace_hook_reject($1::uuid, $2::int) AS r', [hookOfPush, gen1])).toEqual([{ r: false }]);
      expect(await asWorker<{ r: boolean }>('SELECT ludy_finance.marketplace_hook_reject($1::uuid) AS r', [hookOfPush])).toEqual([{ r: false }]);
      expect((await pushStatus(owner)).body).toMatchObject({ stopped: false, rejectedCount: 0, rotatedAt: expect.any(String) });
      const newHash = sha(keyOf(String(rotated.body.address)));
      expect(newHash).not.toBe(oldHash);
      expect(await lookupTiktok(oldHash)).toEqual([]);
      expect(await lookupTiktok(newHash)).toEqual([{ hook_id: hookOfPush, standing: 'ok' }]);
      // The push that waited for the old key is gone, and a request that passed the lookup with the old key stores nothing.
      expect((await waiting()).filter((n) => n.hook_id === hookOfPush)).toEqual([]);
      expect(await put(hookOfPush, oldHash, sha('after-rotation'))).toBe('gone');
      expect(await put(hookOfPush, newHash, sha('with-new-key'))).toBe('accepted');
      expect((await pushStatus(owner)).body).toMatchObject({ stopped: false, rejectedCount: 0, rotatedAt: expect.any(String), lastSeenAt: expect.any(String) });
      await rows('DELETE FROM ludy_finance.marketplace_hook_notice WHERE hook_id = $1', [hookOfPush]);
    });

    it('enforces owner/admin access, cross-org refusal, dates and key-hash exclusion directly on the SQL definers in a sealed context', async () => {
      const definerKey = randomBytes(16).toString('base64url');
      const definerHash = sha(definerKey);
      // Member is refused at the definer boundary too (42501 MARKETPLACE_HOOK_FORBIDDEN).
      await expect(asSealedApp(member, orgId, 'SELECT ludy_finance.marketplace_hook_set($1::uuid, $2)', [pushConnectionId, definerHash])).rejects.toMatchObject({ code: '42501' });
      await expect(asSealedApp(member, orgId, 'SELECT * FROM ludy_finance.marketplace_hook_status($1::uuid)', [pushConnectionId])).rejects.toMatchObject({ code: '42501' });
      // Another org's connection is refused on set and returns no row on status.
      await expect(asSealedApp(owner, orgId, 'SELECT ludy_finance.marketplace_hook_set($1::uuid, $2)', [otherConnectionId, definerHash])).rejects.toMatchObject({ code: '22023' });
      expect(await asSealedApp(owner, orgId, 'SELECT * FROM ludy_finance.marketplace_hook_status($1::uuid)', [otherConnectionId])).toEqual([]);
      // Owner rotates through the definer directly: returns false (rotation), drops waiting pushes and increments generation; status returns dates/counts without key/hash.
      const [before] = await rows<{ id: string; key_sha256: string; generation: number }>('SELECT id, key_sha256, generation FROM ludy_finance.marketplace_hook WHERE marketplace_connection_id = $1', [pushConnectionId]);
      expect(await put(before!.id, before!.key_sha256, sha('definer-waiting'))).toBe('accepted');
      expect(await asSealedApp<{ created: boolean }>(owner, orgId, 'SELECT ludy_finance.marketplace_hook_set($1::uuid, $2) AS created', [pushConnectionId, definerHash])).toEqual([{ created: false }]);
      expect((await waiting()).filter((n) => n.hook_id === before!.id)).toEqual([]);
      const [after] = await rows<{ generation: number }>('SELECT generation FROM ludy_finance.marketplace_hook WHERE id = $1', [before!.id]);
      expect(after?.generation).toBe(before!.generation + 1);
      const st = await asSealedApp<{ created_at: Date; rotated_at: Date | null; last_seen_at: Date | null; rejected_count: number; stopped: boolean }>(
        adminUser,
        orgId,
        'SELECT * FROM ludy_finance.marketplace_hook_status($1::uuid)',
        [pushConnectionId],
      );
      expect(st).toHaveLength(1);
      expect(st[0]).toMatchObject({ rejected_count: 0, stopped: false });
      expect(st[0]?.created_at).toBeTruthy();
      expect(st[0]?.rotated_at).toBeTruthy();
      expect(Object.keys(st[0] ?? {}).sort()).toEqual(['created_at', 'last_seen_at', 'rejected_count', 'rotated_at', 'stopped']);
      expect(JSON.stringify(st)).not.toContain(definerKey);
      expect(JSON.stringify(st)).not.toContain(definerHash);
    });

    it('refuses an adapter that takes no push, and a call that carries an idempotency key (the key would be replayed from the stored answer)', async () => {
      // An offline adapter's connection: the command and the status answer, the first one refuses with MARKETPLACE_PUSH_UNSUPPORTED (422) and makes no hook.
      const channel = randomUUID();
      const offline = randomUUID();
      await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'marketplace_sandbox', $3, 'Sàn ngoại tuyến', $4)", [orgId, channel, `acct-${randomUUID().slice(0, 8)}`, owner.userId]);
      await rows("INSERT INTO ludy_finance.marketplace_connection (org_id, id, channel_connection_id, provider, platform) VALUES ($1, $2, $3, 'marketplace_sandbox', 'shopee')", [orgId, offline, channel]);
      expect(await pushSet(owner, offline)).toMatchObject({ status: 422, body: { code: 'MARKETPLACE_PUSH_UNSUPPORTED' } });
      expect(await rows('SELECT 1 FROM ludy_finance.marketplace_hook WHERE marketplace_connection_id = $1', [offline])).toHaveLength(0);
      expect(await pushStatus(owner, offline)).toMatchObject({ status: 200, body: { exists: false } });
      // The command itself, below the HTTP layer, refuses a member (access is owner and admin), and makes no hook.
      await expect(runtime.execute('finance.marketplace_connection.push_hook_set', { id: pushConnectionId }, { actor: { type: 'user', userId: member.userId, aal: 'aal1', sessionId: member.session }, orgId })).rejects.toMatchObject({ status: 403 });
      // The runtime refuses an idempotency key on this command (its answer holds the key), and makes no hook for it either.
      const before = await rows('SELECT key_sha256 FROM ludy_finance.marketplace_hook WHERE marketplace_connection_id = $1', [pushConnectionId]);
      await expect(
        runtime.execute('finance.marketplace_connection.push_hook_set', { id: pushConnectionId }, { actor: { type: 'user', userId: owner.userId, aal: 'aal1', sessionId: owner.session }, orgId, idempotencyKey: randomUUID() }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_UNSUPPORTED', status: 400 });
      expect(await rows('SELECT key_sha256 FROM ludy_finance.marketplace_hook WHERE marketplace_connection_id = $1', [pushConnectionId])).toEqual(before);
    });

    it('refuses a connection whose channel connection is not active, and a connection that does not exist', async () => {
      await rows("UPDATE ludy_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = (SELECT channel_connection_id FROM ludy_finance.marketplace_connection WHERE org_id = $1 AND id = $2)", [orgId, pushConnectionId]);
      expect((await pushSet(owner)).body).toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
      await rows("UPDATE ludy_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = (SELECT channel_connection_id FROM ludy_finance.marketplace_connection WHERE org_id = $1 AND id = $2)", [orgId, pushConnectionId]);
      expect((await pushSet(owner, randomUUID())).body).toMatchObject({ code: 'MARKETPLACE_CONNECTION_NOT_FOUND' });
    });
  });

  it('finds a hook only for its own adapter and a real key: an unknown key, another adapter, the offline adapter and a malformed hash all find nothing', async () => {
    const lookup = (adapter: string, hash: string) => asApi<{ hook_id: string; standing: string }>('SELECT * FROM ludy_finance.marketplace_hook_lookup($1, $2)', [adapter, hash]);
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
    const [stored] = await rows<{ body: Buffer; authorization_header: string; org_id: string }>('SELECT body, authorization_header, org_id FROM ludy_finance.marketplace_hook_notice');
    expect(Buffer.compare(stored?.body ?? Buffer.alloc(0), BODY)).toBe(0);
    expect(stored).toMatchObject({ authorization_header: HEADER, org_id: orgId });
    // A body past 16 KB, an empty one and a dedupe key of the wrong shape are refused before any row is read.
    await expect(put(hookId, sha(key), sha('big'), Buffer.alloc(16385, 1))).rejects.toMatchObject({ code: '22P02' });
    await expect(put(hookId, sha(key), sha('empty'), Buffer.alloc(0))).rejects.toMatchObject({ code: '22P02' });
    await expect(put(hookId, sha(key), 'short')).rejects.toMatchObject({ code: '22P02' });
  });

  it('keeps both tables definer-only and each function to its own login', async () => {
    for (const table of ['marketplace_hook', 'marketplace_hook_notice']) {
      await expect(pool.query(`SELECT 1 FROM ludy_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(workerPool.query(`SELECT 1 FROM ludy_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(workerPool.query("SELECT * FROM ludy_finance.marketplace_hook_lookup('shopee', $1)", ['0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query('SELECT ludy_finance.marketplace_hook_put_notice($1::uuid, $2, $3, $4, $5, $6)', [randomUUID(), '0'.repeat(64), '0'.repeat(64), 'a', Buffer.from('b'), null])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT * FROM ludy_finance.marketplace_hook_claim(10)')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT ludy_finance.marketplace_hook_reject($1::uuid, 1)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT ludy_finance.marketplace_hook_reject($1::uuid)', [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT ludy_finance.marketplace_hook_sweep()')).rejects.toMatchObject({ code: '42501' });
    // The owner's side needs a sealed context of an owner or admin: with none, even the API login is refused.
    await expect(pool.query('SELECT ludy_finance.marketplace_hook_set($1::uuid, $2)', [connectionId, '0'.repeat(64)])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT * FROM ludy_finance.marketplace_hook_status($1::uuid)', [connectionId])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query("SELECT ludy_finance.personal_data_erase_marketplace_hook_notice('email', 'x@example.test')")).rejects.toMatchObject({ code: '42501' });
    await expect(workerPool.query("SELECT ludy_finance.personal_data_erase_marketplace_hook_notice('email', 'x@example.test')")).rejects.toMatchObject({ code: '42501' });
  });

  it('claims the waiting pushes with their bytes and deletes them as it hands them out, one push for each org, keeping request_url for Shopee alone', async () => {
    const URL_SIGNED = 'https://example.test/api/marketplace/shopee/webhook/the-key-in-the-address';
    const lazadaChannel = randomUUID();
    const lazadaConnection = randomUUID();
    const lazadaKey = randomBytes(16).toString('base64url');
    await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'marketplace_lazada', $3, 'Lazada thử', $4)", [orgId, lazadaChannel, `acct-${randomUUID().slice(0, 8)}`, owner.userId]);
    await rows("INSERT INTO ludy_finance.marketplace_connection (org_id, id, channel_connection_id, provider, platform) VALUES ($1, $2, $3, 'marketplace_lazada', 'lazada')", [orgId, lazadaConnection, lazadaChannel]);
    const lazadaHook = (await rows<{ id: string }>('INSERT INTO ludy_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id', [orgId, lazadaConnection, sha(lazadaKey)]))[0]?.id ?? '';
    // TikTok Shop and Lazada hooks sent an address drop it (only Shopee signs the address); Shopee keeps its own.
    expect(await put(otherHookId, sha(otherKey), sha('other'), BODY, URL_SIGNED)).toBe('accepted');
    expect(await put(lazadaHook, sha(lazadaKey), sha('lazada-with-address'), BODY, URL_SIGNED)).toBe('accepted');
    expect(await put(hookId, sha(key), sha('shopee-with-address'), BODY, URL_SIGNED)).toBe('accepted');
    // Inspect the stored table rows BEFORE claim deletes them to confirm request_url was never written for TikTok Shop or Lazada.
    const storedBeforeClaim = await rows<{ hook_id: string; dedupe_key: string; request_url: string | null }>('SELECT hook_id, dedupe_key, request_url FROM ludy_finance.marketplace_hook_notice');
    expect(storedBeforeClaim.find((r) => r.hook_id === otherHookId)?.request_url).toBeNull();
    expect(storedBeforeClaim.find((r) => r.hook_id === lazadaHook)?.request_url).toBeNull();
    expect(storedBeforeClaim.find((r) => r.dedupe_key === sha('shopee-with-address'))?.request_url).toBe(URL_SIGNED);
    const claimed = await asWorker<{ org_id: string; hook_id: string; marketplace_connection_id: string; adapter: string; platform: string; dedupe_key: string; authorization_header: string; body: Buffer; request_url: string | null; generation: number }>(
      'SELECT * FROM ludy_finance.marketplace_hook_claim(10)',
    );
    expect(claimed.map((c) => [c.org_id, c.hook_id, c.marketplace_connection_id, c.adapter, c.platform, c.dedupe_key, c.generation]).sort()).toEqual(
      [
        [orgId, hookId, connectionId, 'shopee', 'shopee', sha('one'), 1],
        [orgId, hookId, connectionId, 'shopee', 'shopee', sha('shopee-with-address'), 1],
        [orgId, lazadaHook, lazadaConnection, 'lazada', 'lazada', sha('lazada-with-address'), 1],
        [otherOrgId, otherHookId, otherConnectionId, 'tiktok_shop', 'tiktok_shop', sha('other'), 1],
      ].sort(),
    );
    const mine = claimed.find((c) => c.hook_id === hookId && c.dedupe_key === sha('one'));
    // The address is kept only for a Shopee hook that was sent one, and comes back with the claim; TikTok Shop and Lazada hooks never keep it (20270207100000).
    expect(mine?.request_url).toBeNull();
    expect(claimed.find((c) => c.dedupe_key === sha('shopee-with-address'))?.request_url).toBe(URL_SIGNED);
    expect(claimed.find((c) => c.hook_id === otherHookId)?.request_url).toBeNull();
    expect(claimed.find((c) => c.hook_id === lazadaHook)?.request_url).toBeNull();
    expect(Buffer.compare(mine?.body ?? Buffer.alloc(0), BODY)).toBe(0);
    expect(await waiting()).toEqual([]);
    expect(await asWorker('SELECT * FROM ludy_finance.marketplace_hook_claim(10)')).toEqual([]);
    await rows('DELETE FROM ludy_finance.marketplace_hook WHERE org_id = $1 AND id = $2', [orgId, lazadaHook]);
    await rows('DELETE FROM ludy_finance.marketplace_connection WHERE org_id = $1 AND id = $2', [orgId, lazadaConnection]);
    await rows('DELETE FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, lazadaChannel]);
  });

  it('sweeps a push older than ten minutes, whatever it holds, with the next claim and with the sweep', async () => {
    await rows("INSERT INTO ludy_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body, received_at) VALUES ($1, $2, $3, $4, $5, now() - interval '11 minutes')", [orgId, hookId, sha('old-1'), HEADER, BODY]);
    await rows("INSERT INTO ludy_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body, received_at) VALUES ($1, $2, $3, $4, $5, now() - interval '12 minutes')", [orgId, hookId, sha('old-2'), HEADER, BODY]);
    expect(await asWorker('SELECT * FROM ludy_finance.marketplace_hook_claim(10)')).toEqual([]);
    expect(await waiting()).toEqual([]);
    await rows("INSERT INTO ludy_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body, received_at) VALUES ($1, $2, $3, $4, $5, now() - interval '11 minutes')", [orgId, hookId, sha('old-3'), HEADER, BODY]);
    expect((await asWorker<{ swept: number }>('SELECT ludy_finance.marketplace_hook_sweep() AS swept'))[0]?.swept).toBe(1);
    expect(await waiting()).toEqual([]);
  });

  it('deletes what its own hook holds past ten minutes on the next put, even with no claim', async () => {
    await rows("INSERT INTO ludy_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body, received_at) VALUES ($1, $2, $3, $4, $5, now() - interval '11 minutes')", [orgId, hookId, sha('stale'), HEADER, BODY]);
    expect(await put(hookId, sha(key), sha('fresh'))).toBe('accepted');
    expect(await waiting()).toEqual([{ hook_id: hookId, dedupe_key: sha('fresh') }]);
    expect((await asWorker('SELECT * FROM ludy_finance.marketplace_hook_claim(10)')).length).toBe(1);
  });

  it('bounds the backlog: twenty waiting for a hook, then busy; a retry of one that waits is still acknowledged', async () => {
    for (let n = 0; n < 20; n++) expect(await put(hookId, sha(key), sha(`bulk-${n}`))).toBe('accepted');
    expect(await put(hookId, sha(key), sha('bulk-extra'))).toBe('busy');
    expect(await put(hookId, sha(key), sha('bulk-3'))).toBe('duplicate');
    expect((await asWorker('SELECT * FROM ludy_finance.marketplace_hook_claim(100)')).length).toBe(20);
    expect(await waiting()).toEqual([]);
  });

  it('finds the body nowhere but in its own row: no outbox, archive, audit or job row holds it (the job schema is ludy_jobs), and the wake-up carries no payload', async () => {
    const heard: string[] = [];
    const listener = new pg.Client({ connectionString: adminUrl });
    await listener.connect();
    listener.on('notification', (message) => heard.push(String(message.payload ?? '')));
    await listener.query('LISTEN ludy_outbox');
    expect(await put(hookId, sha(key), sha('canary'))).toBe('accepted');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await listener.end();
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.every((payload) => payload === '')).toBe(true);
    await asWorker('SELECT * FROM ludy_finance.marketplace_hook_claim(10)');
    const tables = await rows<{ table_schema: string; table_name: string }>("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('ludy_kernel', 'ludy_jobs') AND table_type = 'BASE TABLE'");
    for (const { table_schema, table_name } of tables) {
      // The row as text shows a bytea column in hex, so the canary is looked for as text and as hex.
      const found = await rows<{ hit: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table_schema}.${table_name} t WHERE t::text LIKE $1 OR t::text LIKE $2) AS hit`, [`%${CANARY}%`, `%${Buffer.from(CANARY).toString('hex')}%`]);
      expect({ table: `${table_schema}.${table_name}`, hit: found[0]?.hit }).toEqual({ table: `${table_schema}.${table_name}`, hit: false });
    }
  });

  it('stops a hook after ten refused pushes in an hour: the lookup says stopped, a push stores nothing, and the claim hands back nothing of it', async () => {
    expect((await asWorker<{ stopped: boolean }>('SELECT ludy_finance.marketplace_hook_reject($1::uuid, $2::int) AS stopped', [otherHookId, 2]))[0]?.stopped).toBe(false);
    for (let n = 1; n < 10; n++) expect((await asWorker<{ stopped: boolean }>('SELECT ludy_finance.marketplace_hook_reject($1::uuid, $2::int) AS stopped', [otherHookId, 1]))[0]?.stopped).toBe(false);
    expect((await asWorker<{ stopped: boolean }>('SELECT ludy_finance.marketplace_hook_reject($1::uuid, $2::int) AS stopped', [otherHookId, 1]))[0]?.stopped).toBe(true);
    expect(await asApi('SELECT * FROM ludy_finance.marketplace_hook_lookup($1, $2)', ['tiktok_shop', sha(otherKey)])).toEqual([{ hook_id: otherHookId, standing: 'stopped' }]);
    expect(await put(otherHookId, sha(otherKey), sha('stopped'))).toBe('gone');
    // A push that waited when the hook was stopped is deleted by the claim and not handed out.
    await rows('INSERT INTO ludy_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body) VALUES ($1, $2, $3, $4, $5)', [otherOrgId, otherHookId, sha('late'), HEADER, BODY]);
    expect(await asWorker('SELECT * FROM ludy_finance.marketplace_hook_claim(10)')).toEqual([]);
    expect(await waiting()).toEqual([]);
    // The other hook is untouched by it.
    expect(await asApi('SELECT * FROM ludy_finance.marketplace_hook_lookup($1, $2)', ['shopee', sha(key)])).toEqual([{ hook_id: hookId, standing: 'ok' }]);
  });

  it('takes nothing for a closed org connection and removes the pushes with their hook', async () => {
    expect(await put(hookId, sha(key), sha('closing'))).toBe('accepted');
    await rows("UPDATE ludy_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = (SELECT channel_connection_id FROM ludy_finance.marketplace_connection WHERE org_id = $1 AND id = $2)", [orgId, connectionId]);
    expect(await asApi('SELECT * FROM ludy_finance.marketplace_hook_lookup($1, $2)', ['shopee', sha(key)])).toEqual([]);
    expect(await put(hookId, sha(key), sha('closed'))).toBe('gone');
    // What waited for a connection that is no longer active is deleted by the claim, not handed out.
    expect(await asWorker('SELECT * FROM ludy_finance.marketplace_hook_claim(10)')).toEqual([]);
    expect(await waiting()).toEqual([]);
    await rows("UPDATE ludy_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = (SELECT channel_connection_id FROM ludy_finance.marketplace_connection WHERE org_id = $1 AND id = $2)", [orgId, connectionId]);
    await rows('INSERT INTO ludy_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body) VALUES ($1, $2, $3, $4, $5)', [orgId, hookId, sha('cascade'), HEADER, BODY]);
    await rows('DELETE FROM ludy_finance.marketplace_hook WHERE org_id = $1 AND id = $2', [orgId, hookId]);
    expect(await waiting()).toEqual([]);
  });

  it('names both tables in the org purge', async () => {
    const [purge] = await rows<{ ok: boolean }>(
      "SELECT pg_get_functiondef('ludy_kernel.org_purge(integer)'::regprocedure) ~ 'ludy_finance.marketplace_hook_notice' AND pg_get_functiondef('ludy_kernel.org_purge(integer)'::regprocedure) ~ 'ludy_finance.marketplace_hook[^_]' AS ok",
    );
    expect(purge?.ok).toBe(true);
  });

  describe('personal data erasure and global 10k backlog cap (#4326)', () => {
    const capKey = randomBytes(16).toString('base64url');
    const capOtherKey = randomBytes(16).toString('base64url');
    let capHookId = '';
    let capOtherHookId = '';
    const asMfa = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal2' as const, sessionId: who.session, mfaAt: Math.floor(Date.now() / 1000) });

    beforeAll(async () => {
      await rows('DELETE FROM ludy_finance.marketplace_hook WHERE marketplace_connection_id = ANY($1::uuid[])', [[connectionId, otherConnectionId]]);
      await rows("UPDATE ludy_kernel.channel_connection SET status = 'active' WHERE org_id = ANY($1::uuid[])", [[orgId, otherOrgId]]);
      capHookId = (await rows<{ id: string }>('INSERT INTO ludy_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id', [orgId, connectionId, sha(capKey)]))[0]?.id ?? '';
      capOtherHookId = (await rows<{ id: string }>('INSERT INTO ludy_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id', [otherOrgId, otherConnectionId, sha(capOtherKey)]))[0]?.id ?? '';
      await rows('DELETE FROM ludy_finance.marketplace_hook_notice');
    });

    it('erases waiting pushes mentioning a person (ASCII, non-ASCII UTF-8 and invalid UTF-8 bytes) for owners only, leaving unrelated and cross-org pushes', async () => {
      const targetEmail = 'buyer.erase@example.test';
      const targetPhone = '0900000000';
      const asciiMatch = Buffer.from(JSON.stringify({ buyer: 'Buyer A', email: targetEmail }), 'utf8');
      const utf8Match = Buffer.from(JSON.stringify({ buyer: 'Nguyễn Thị Hương', note: `Liên hệ ${targetEmail} giao hàng` }), 'utf8');
      const utf8PhoneMatch = Buffer.from(JSON.stringify({ buyer: 'Trần Văn Đức', phone: 'điện thoại 0900\u00a0000\u00a0000' }), 'utf8');
      const invalidUtf8Match = Buffer.concat([Buffer.from(`{"note":"${targetEmail}"}`, 'utf8'), Buffer.from([0xff, 0xfe])]);
      const unrelated = Buffer.concat([Buffer.from('{"buyer":"Lê Văn An","note":"không khớp"}', 'utf8'), Buffer.from([0xff, 0xfe])]);
      const otherOrgMatch = Buffer.from(JSON.stringify({ buyer: 'Khách khác', email: targetEmail, phone: targetPhone }), 'utf8');

      expect(await put(capHookId, sha(capKey), sha('erase-ascii'), asciiMatch)).toBe('accepted');
      expect(await put(capHookId, sha(capKey), sha('erase-utf8-email'), utf8Match)).toBe('accepted');
      expect(await put(capHookId, sha(capKey), sha('erase-utf8-phone'), utf8PhoneMatch)).toBe('accepted');
      expect(await put(capHookId, sha(capKey), sha('erase-invalid-utf8'), invalidUtf8Match)).toBe('accepted');
      expect(await put(capHookId, sha(capKey), sha('erase-unrelated'), unrelated)).toBe('accepted');
      expect(await put(capOtherHookId, sha(capOtherKey), sha('erase-other-org'), otherOrgMatch)).toBe('accepted');

      // Only the org owner may erase personal data; admins and members are refused, and invalid shapes fail before reading rows.
      await expect(runtime.execute('kernel.personal_data.erase', { value: targetEmail }, { actor: asMfa(adminUser), orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
      await expect(runtime.execute('kernel.personal_data.erase', { value: targetEmail }, { actor: asMfa(member), orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
      await expect(asSealedApp(adminUser, orgId, "SELECT ludy_finance.personal_data_erase_marketplace_hook_notice('email', $1)", [targetEmail])).rejects.toMatchObject({ code: '42501' });
      await expect(asSealedApp(member, orgId, "SELECT ludy_finance.personal_data_erase_marketplace_hook_notice('email', $1)", [targetEmail])).rejects.toMatchObject({ code: '42501' });
      await expect(asSealedApp(owner, orgId, "SELECT ludy_finance.personal_data_erase_marketplace_hook_notice('email', 'not-an-email')")).rejects.toMatchObject({ code: '22023' });

      const erasedByEmail = await runtime.execute<{ erased: Array<{ column: string; rows: number }> }>(
        'kernel.personal_data.erase',
        { value: targetEmail },
        { actor: asMfa(owner), orgId, idempotencyKey: randomUUID() },
      );
      expect(erasedByEmail.erased.find((entry) => entry.column === 'ludy_finance.marketplace_hook_notice.body')?.rows).toBe(3);

      // Direct owner call deletes the non-ASCII Vietnamese UTF-8 body mentioning the phone with no-break spaces.
      const erasedByPhone = await asSealedApp<{ rows: number }>(owner, orgId, "SELECT ludy_finance.personal_data_erase_marketplace_hook_notice('digits', $1) AS rows", [targetPhone]);
      expect(erasedByPhone).toEqual([{ rows: 1 }]);

      expect(await waiting()).toEqual([
        { hook_id: capHookId, dedupe_key: sha('erase-unrelated') },
        { hook_id: capOtherHookId, dedupe_key: sha('erase-other-org') },
      ]);
      await rows('DELETE FROM ludy_finance.marketplace_hook_notice');
    });

    it('enforces the global 10,000-row cap across all hooks: returns busy at 10,000 while retries stay duplicate', async () => {
      await rows('DELETE FROM ludy_finance.marketplace_hook_notice');
      await rows(
        `INSERT INTO ludy_finance.marketplace_hook_notice (org_id, hook_id, dedupe_key, authorization_header, body)
         SELECT $1, $2, pg_catalog.lpad(pg_catalog.to_hex(g), 64, '0'), $3, $4
         FROM pg_catalog.generate_series(1, 9999) AS g`,
        [otherOrgId, capOtherHookId, HEADER, BODY],
      );
      // capHookId has 0 rows (< 20 per-hook limit) and total rows is 9,999: the 10,000th row is accepted.
      expect(await put(capHookId, sha(capKey), sha('global-10000'))).toBe('accepted');
      // Now total rows = 10,000 (only 1 on capHookId): a new push hits the global cap and returns busy without inserting.
      expect(await put(capHookId, sha(capKey), sha('global-10001'))).toBe('busy');
      expect((await rows<{ n: number }>('SELECT count(*)::int AS n FROM ludy_finance.marketplace_hook_notice'))[0]?.n).toBe(10000);
      // A retry of a waiting push on capHookId is still acknowledged as duplicate even past the global cap.
      expect(await put(capHookId, sha(capKey), sha('global-10000'))).toBe('duplicate');
      // Dropping one row opens room for one more accepted push, and the next hits busy again.
      await rows('DELETE FROM ludy_finance.marketplace_hook_notice WHERE hook_id = $1 AND dedupe_key = $2', [capOtherHookId, '1'.padStart(64, '0')]);
      expect(await put(capHookId, sha(capKey), sha('global-after-free'))).toBe('accepted');
      expect(await put(capHookId, sha(capKey), sha('global-over-again'))).toBe('busy');
      await rows('DELETE FROM ludy_finance.marketplace_hook_notice');
    });

    it('backfills reject_token on hooks rotated before migration so stale pre-upgrade 1-arg rejections stay ignored while current ones stop at 10', async () => {
      const [row] = await rows<{ reject_token: string | null }>('SELECT reject_token FROM ludy_finance.marketplace_hook WHERE id = $1', [preUpgradeHookId]);
      expect(row?.reject_token).toBeTruthy();
      expect(row?.reject_token).not.toBe(preUpgradeHookId);
      expect(await asWorker<{ stopped: boolean }>('SELECT ludy_finance.marketplace_hook_reject($1::uuid) AS stopped', [preUpgradeClaimId])).toEqual([{ stopped: false }]);
      expect(
        await asSealedApp<{ rejected_count: number; stopped: boolean }>(outsider, otherOrgId, 'SELECT rejected_count, stopped FROM ludy_finance.marketplace_hook_status($1::uuid)', [preUpgradeConnId]),
      ).toEqual([{ rejected_count: 0, stopped: false }]);
      expect(await put(preUpgradeHookId, sha(preUpgradeRotatedKey), sha('post-upgrade-push'))).toBe('accepted');
      const claimed = await asWorker<{ hook_id: string }>('SELECT hook_id FROM ludy_finance.marketplace_hook_claim(10)');
      expect(claimed).toEqual([{ hook_id: row!.reject_token }]);
      for (let n = 1; n < 10; n++) {
        expect(await asWorker<{ stopped: boolean }>('SELECT ludy_finance.marketplace_hook_reject($1::uuid) AS stopped', [claimed[0]!.hook_id])).toEqual([{ stopped: false }]);
      }
      expect(await asWorker<{ stopped: boolean }>('SELECT ludy_finance.marketplace_hook_reject($1::uuid) AS stopped', [claimed[0]!.hook_id])).toEqual([{ stopped: true }]);
      expect(
        await asSealedApp<{ rejected_count: number; stopped: boolean }>(outsider, otherOrgId, 'SELECT rejected_count, stopped FROM ludy_finance.marketplace_hook_status($1::uuid)', [preUpgradeConnId]),
      ).toEqual([{ rejected_count: 10, stopped: true }]);
      await rows('DELETE FROM ludy_finance.marketplace_hook WHERE org_id = $1 AND id = $2', [otherOrgId, preUpgradeHookId]);
      await rows('DELETE FROM ludy_finance.marketplace_connection WHERE org_id = $1 AND id = $2', [otherOrgId, preUpgradeConnId]);
    });
  });

  // The route (S2, #4346): POST /api/marketplace/<adapter>/webhook/<hookKey> through the real app. The adapters this deployment runs are shopee and tiktok_shop (see the app above); lazada is not run.
  describe('the route', () => {
    // Earlier tests of this file delete and rotate the hooks they use, so the route tests make hooks of their own on the same two connections.
    const routeKey = randomBytes(16).toString('base64url');
    const routeOtherKey = randomBytes(16).toString('base64url');
    let routeHook = '';
    let routeOtherHook = '';
    beforeAll(async () => {
      await rows('DELETE FROM ludy_finance.marketplace_hook WHERE marketplace_connection_id = ANY($1::uuid[])', [[connectionId, otherConnectionId]]);
      routeHook = (await rows<{ id: string }>('INSERT INTO ludy_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id', [orgId, connectionId, sha(routeKey)]))[0]?.id ?? '';
      routeOtherHook = (await rows<{ id: string }>('INSERT INTO ludy_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id', [otherOrgId, otherConnectionId, sha(routeOtherKey)]))[0]?.id ?? '';
      // The channel connections are active (the closing test above puts them back).
      await rows("UPDATE ludy_kernel.channel_connection SET status = 'active' WHERE org_id = ANY($1::uuid[])", [[orgId, otherOrgId]]);
      await rows('DELETE FROM ludy_finance.marketplace_hook_notice');
    });
    const push = (adapter: string, hookKey: string, body: Buffer | string = BODY, headers: Record<string, string> = { authorization: HEADER }, origin = 'http://localhost:8080') =>
      app.request(`${origin}/api/marketplace/${adapter}/webhook/${hookKey}`, { method: 'POST', headers, body: typeof body === 'string' ? body : new Uint8Array(body) });
    const stored = () => rows<{ hook_id: string; dedupe_key: string; request_url: string | null; authorization_header: string; body: Buffer }>('SELECT hook_id, dedupe_key, request_url, authorization_header, body FROM ludy_finance.marketplace_hook_notice ORDER BY received_at, id');
    const clear = () => rows('DELETE FROM ludy_finance.marketplace_hook_notice');

    it('stores the raw push of a Shopee hook with the address from the configured public URL, whatever Host and X-Forwarded-* say, and answers an empty 200', async () => {
      await clear();
      const response = await push('shopee', routeKey, BODY, { authorization: HEADER, 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'http' }, 'http://evil.example');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
      const [row] = await stored();
      expect(row?.hook_id).toBe(routeHook);
      expect(row?.authorization_header).toBe(HEADER);
      expect(Buffer.compare(row?.body ?? Buffer.alloc(0), BODY)).toBe(0);
      expect(row?.request_url).toBe(`http://localhost:8080/api/marketplace/shopee/webhook/${routeKey}`);
      await clear();
    });

    it('keeps no address for a TikTok Shop push, answers a repeat with an empty 200 and stores it once', async () => {
      await clear();
      expect((await push('tiktok_shop', routeOtherKey)).status).toBe(200);
      expect((await push('tiktok_shop', routeOtherKey)).status).toBe(200);
      const all = await stored();
      expect(all).toHaveLength(1);
      expect(all[0]?.hook_id).toBe(routeOtherHook);
      expect(all[0]?.request_url).toBeNull();
      await clear();
    });

    it('answers a 404 and stores nothing for an unknown key, a key of another adapter, a malformed key and an adapter this deployment does not run', async () => {
      await clear();
      expect((await push('shopee', randomBytes(16).toString('base64url'))).status).toBe(404);
      expect((await push('shopee', routeOtherKey)).status).toBe(404);
      expect((await push('shopee', 'short')).status).toBe(404);
      expect((await push('lazada', routeKey)).status).toBe(404);
      expect((await push('nope', routeKey)).status).toBe(404);
      expect(await stored()).toEqual([]);
    });

    it('answers an empty 200 and stores nothing for a stopped hook, a push with no header, an empty body and a body over 16 KB', async () => {
      await clear();
      await rows('UPDATE ludy_finance.marketplace_hook SET stopped_at = now() WHERE org_id = $1 AND id = $2', [orgId, routeHook]);
      expect((await push('shopee', routeKey)).status).toBe(200);
      await rows('UPDATE ludy_finance.marketplace_hook SET stopped_at = NULL WHERE org_id = $1 AND id = $2', [orgId, routeHook]);
      const noHeader = await push('shopee', routeKey, BODY, {});
      expect(noHeader.status).toBe(200);
      expect(await noHeader.text()).toBe('');
      expect((await push('shopee', routeKey, '')).status).toBe(200);
      const large = await push('shopee', routeKey, Buffer.alloc(16 * 1024 + 1, 0x61));
      expect(large.status).toBe(200);
      expect(await large.text()).toBe('');
      expect(await stored()).toEqual([]);
    });

    it('takes no GET, and answers a success (never a 429) for a push to a hook that is full', async () => {
      await clear();
      expect((await app.request(`http://localhost:8080/api/marketplace/shopee/webhook/${routeKey}`, { method: 'GET' })).status).not.toBe(200);
      for (let i = 0; i < 25; i++) {
        const response = await push('shopee', routeKey, Buffer.from(`{"shop_id":"7495540735365777507","n":${i}}`));
        expect(response.status).toBe(200);
      }
      // Twenty wait for the hook; the rest were answered a success and dropped.
      expect(await stored()).toHaveLength(20);
      await clear();
    });
  });
});

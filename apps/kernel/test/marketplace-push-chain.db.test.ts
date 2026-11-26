// SPDX-License-Identifier: AGPL-3.0-only
// The whole push chain of a marketplace on a real PostgreSQL 17 (#4364, #4315): a platform's signed push POSTed to the public route (S2, #4347), stored in the hook's table (S1, #4324), claimed by the worker's relay,
// verified against the connection's sealed secret and turned into ONE coalesced poll job per connection (S3a, #4344). Each slice has tests of its own; this one runs them TOGETHER, through the real app, the real definers,
// a real credential vault and the worker's own relay steps (claim, verify, send, count; mirrored from the loop in startWorker, see below), so an incompatible change at any seam (a header the worker cannot read, a stored address that is not the one the platform
// signed, a claim that does not reach verification, a poll job per push) fails here. The job queue is a recording fake: the poll job's shape is checked, not pg-boss.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { jobKey } from '../src/job-keys.ts';
import { QUEUES } from '../src/jobs-schema.ts';
import { marketplacePushSignature } from '../src/marketplace-push.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { MARKETPLACE_PUSH_SLOT_SECONDS, claimMarketplaceHookNotices, rejectMarketplaceHook, verifyMarketplaceHookNotices } from '../src/marketplace-push-relay.ts';
import type { MarketplacePollJob } from '../src/marketplace-poll-job.ts';
import { relayBatch, type JobSender } from '../src/worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-marketplace-chain-0123456789';
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
const CANARY = 'chain-canary-3b9e1d70-do-not-keep';
const PUBLIC_URL = 'http://localhost:8080';
const TIKTOK = { appKey: 'tt-app-key', appSecret: 'tt-app-secret', accessToken: 'tok-test', shopCipher: null, shopId: '7495540735365777507' };
const SHOPEE = { partnerId: '1000012', partnerKey: 'chain-test-partner-key', shopId: '77777', accessToken: 'SHP_access' };
const nowSeconds = () => Math.floor(Date.now() / 1000);
const tiktokBody = (n: number, over: Record<string, unknown> = {}) => JSON.stringify({ type: 1, shop_id: TIKTOK.shopId, timestamp: nowSeconds(), data: { n, note: CANARY }, ...over });
const shopeeBody = (n: number) => JSON.stringify({ shop_id: 77777, code: 3, success: 1, timestamp: nowSeconds(), data: { ordersn: `2611A${n}`, note: CANARY } });
const tiktokSign = (body: string, secret = TIKTOK.appSecret) => marketplacePushSignature('tiktok_shop', { appKey: TIKTOK.appKey, key: secret }, new TextEncoder().encode(body));
const shopeeSign = (body: string, address: string) => marketplacePushSignature('shopee', { key: SHOPEE.partnerKey, requestUrl: address }, new TextEncoder().encode(body));

suite('Marketplace push chain (#4364)', () => {
  const dbName = `ludy_test_marketplace_chain_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let workerDb: Db;
  let app: ReturnType<typeof createHttpApp>;
  let vault: CredentialVault;
  let worker: Runtime;
  let api: Runtime;
  const owner: Account = { subject: randomUUID(), email: 'owner@marketplace-chain.test', session: randomUUID(), userId: '' };
  let orgId = '';
  const tiktok = { channelId: '', connectionId: '', hookId: '', key: randomBytes(16).toString('base64url') };
  const shopee = { channelId: '', connectionId: '', hookId: '', key: randomBytes(16).toString('base64url') };
  const sent: Array<{ name: string; data: object | null | undefined; options: object | undefined }> = [];
  const sender: JobSender = {
    send: async (name, data, options) => {
      sent.push({ name, data, options });
      return randomUUID();
    },
  };

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
  const stored = () => rows<{ hook_id: string; request_url: string | null }>('SELECT hook_id, request_url FROM ludy_finance.marketplace_hook_notice ORDER BY received_at, id');
  const rejected = async (hookId: string) => Number((await rows<{ n: number }>('SELECT rejected_count AS n FROM ludy_finance.marketplace_hook WHERE id = $1', [hookId]))[0]?.n ?? 0);
  // One round of the relay, the same steps as the loop body in startWorker (apps/kernel/src/worker.ts, "A signed push of a marketplace"): claim, verify, ONE poll per connection with a good push, refusals counted after
  // the commit. It mirrors that body and does not call it (the send must stay inline in startWorker, where the job-egress invariant has reviewed it), so a change to the loop must be made here too.
  const relay = async () => {
    const tally = { ok: 0, refused: 0, dropped: 0 };
    const refusedHooks: Array<{ hookId: string; generation: number }> = [];
    const adapters = new Set(['tiktok_shop', 'shopee']);
    const claimed = await relayBatch(workerDb, sender, async (trx) => {
      const rows = await claimMarketplaceHookNotices(trx);
      const verdicts = await verifyMarketplaceHookNotices({ runtime: worker, broker: vault, adapters, reject: async (hookId, generation) => void refusedHooks.push({ hookId, generation }) }, rows);
      const seen = new Set<string>();
      return rows.map((row, i) => {
        const verdict = verdicts[i] ?? 'dropped';
        tally[verdict]++;
        if (verdict !== 'ok' || seen.has(row.marketplaceConnectionId)) return async () => null;
        seen.add(row.marketplaceConnectionId);
        const target = { orgId: row.orgId, connectionId: row.marketplaceConnectionId } satisfies MarketplacePollJob;
        return (boss: JobSender) =>
          boss.send(QUEUES.marketplacePoll, target, {
            singletonKey: jobKey(target.orgId, QUEUES.marketplacePoll, target.connectionId),
            singletonSeconds: MARKETPLACE_PUSH_SLOT_SECONDS,
            retryLimit: 3,
            retryDelay: 30,
            retryBackoff: true,
          });
      });
    });
    for (const refused of refusedHooks) await rejectMarketplaceHook(workerDb, refused.hookId, refused.generation);
    return { claimed, tally };
  };
  const post = (adapter: string, key: string, body: string, authorization: string, origin = PUBLIC_URL) =>
    app.request(`${origin}/api/marketplace/${adapter}/webhook/${key}`, { method: 'POST', headers: { authorization }, body });
  const asOwner = () => ({ type: 'user' as const, userId: owner.userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

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
  async function rpc(path: string, token: string, input: unknown) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const text = await response.text();
    const parsed = (text ? JSON.parse(text) : null) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (parsed && 'json' in parsed ? parsed.json : parsed) as any };
  }

  // A marketplace connection with its secret SEALED by the vault under the binding the worker opens it with: the channel connection (the credential lives on the connector's membership) and the marketplace connection
  // on it, then a hook with a key of its own.
  async function connect(adapter: 'tiktok_shop' | 'shopee', secret: object, hookKey: string) {
    const provider = `marketplace_${adapter}`;
    const externalAccountId = `acct-${randomUUID().slice(0, 8)}`;
    const sealed = vault.seal(JSON.stringify(secret), { orgId, provider, externalAccountId });
    const channel = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      { provider, externalAccountId, displayName: `Sàn ${adapter}`, scopes: [], expiresAt: null, credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') } },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const connectionId = randomUUID();
    await rows('INSERT INTO ludy_finance.marketplace_connection (org_id, id, channel_connection_id, provider, platform) VALUES ($1, $2, $3, $4, $5)', [orgId, connectionId, channel.connectionId, provider, adapter]);
    const hookId = (await rows<{ id: string }>('INSERT INTO ludy_finance.marketplace_hook (org_id, marketplace_connection_id, key_sha256) VALUES ($1, $2, $3) RETURNING id', [orgId, connectionId, sha(hookKey)]))[0]?.id ?? '';
    return { channelId: channel.connectionId, connectionId, hookId };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    const db = createDb(pool);
    workerDb = createDb(workerPool);
    const registered = { commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] };
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const }).register(registered);
    api = runtime;
    // The worker's runtime is on the worker login, as in production: it reads the sealed credential as the system.
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
    const config = loadConfig({ DATABASE_URL: login('ludy_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    expect(config.PUBLIC_URL).toBe(PUBLIC_URL);
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    app = createHttpApp({ config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels: { broker: vault, sandbox: false }, marketplacePush: { adapters: ['tiktok_shop', 'shopee'] } });
    const me = await rpc('me/get', await tokenFor(owner), undefined);
    expect(me.status).toBe(200);
    owner.userId = String(me.body?.userId);
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty chuỗi push', idempotencyKey: randomUUID() });
    orgId = String(created.body?.orgId);
    Object.assign(tiktok, await connect('tiktok_shop', TIKTOK, tiktok.key));
    Object.assign(shopee, await connect('shopee', SHOPEE, shopee.key));
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('turns three good TikTok Shop pushes of one shop into ONE poll of its connection: ids only, nothing of the push in the job, nothing left waiting', async () => {
    sent.length = 0;
    for (let n = 1; n <= 3; n++) {
      const body = tiktokBody(n);
      const response = await post('tiktok_shop', tiktok.key, body, tiktokSign(body));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('');
    }
    expect(await stored()).toHaveLength(3);
    const done = await relay();
    expect(done).toEqual({ claimed: 3, tally: { ok: 3, refused: 0, dropped: 0 } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.name).toBe(QUEUES.marketplacePoll);
    expect(sent[0]?.data).toEqual({ orgId, connectionId: tiktok.connectionId });
    // The poll job coalesces: one singleton key for the connection and a slot, so pushes of the next rounds share it too.
    expect(sent[0]?.options).toMatchObject({ singletonKey: jobKey(orgId, QUEUES.marketplacePoll, tiktok.connectionId), singletonSeconds: 30 });
    expect(JSON.stringify(sent)).not.toContain(CANARY);
    // The claim consumed them: nothing waits, and a second round finds nothing.
    expect(await stored()).toEqual([]);
    expect(await relay()).toEqual({ claimed: 0, tally: { ok: 0, refused: 0, dropped: 0 } });
    expect(await rejected(tiktok.hookId)).toBe(0);
  });

  it('verifies a Shopee push over the address the route stored (built from PUBLIC_URL, whatever Host says), and refuses one signed over any other address', async () => {
    sent.length = 0;
    const registered = `${PUBLIC_URL}/api/marketplace/shopee/webhook/${shopee.key}`;
    const good = shopeeBody(1);
    // The request arrives with a Host the platform never used (a proxy, a client): the stored address is still the registered one.
    expect((await post('shopee', shopee.key, good, shopeeSign(good, registered), 'http://evil.example')).status).toBe(200);
    expect((await stored())[0]?.request_url).toBe(registered);
    expect(await relay()).toEqual({ claimed: 1, tally: { ok: 1, refused: 0, dropped: 0 } });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data).toEqual({ orgId, connectionId: shopee.connectionId });
    // A push signed over the evil address is not the registered one: refused and counted.
    const forged = shopeeBody(2);
    expect((await post('shopee', shopee.key, forged, shopeeSign(forged, `http://evil.example/api/marketplace/shopee/webhook/${shopee.key}`))).status).toBe(200);
    sent.length = 0;
    expect(await relay()).toEqual({ claimed: 1, tally: { ok: 0, refused: 1, dropped: 0 } });
    expect(sent).toEqual([]);
    expect(await rejected(shopee.hookId)).toBe(1);
  });

  it('counts a wrong signature against the hook but not a signed push that names another shop, and polls for neither', async () => {
    sent.length = 0;
    const before = await rejected(tiktok.hookId);
    const wrong = tiktokBody(10);
    expect((await post('tiktok_shop', tiktok.key, wrong, tiktokSign(wrong, 'not-the-secret'))).status).toBe(200);
    const foreign = tiktokBody(11, { shop_id: '1111111111111111111' });
    expect((await post('tiktok_shop', tiktok.key, foreign, tiktokSign(foreign))).status).toBe(200);
    expect(await relay()).toEqual({ claimed: 2, tally: { ok: 0, refused: 1, dropped: 1 } });
    expect(sent).toEqual([]);
    expect(await rejected(tiktok.hookId)).toBe(before + 1);
  });

  it('stops a hook after ten refused pushes in an hour: the route then answers an empty 200 and stores nothing, and a good push no longer polls', async () => {
    sent.length = 0;
    const need = 10 - (await rejected(tiktok.hookId));
    for (let n = 0; n < need; n++) {
      const body = tiktokBody(100 + n);
      expect((await post('tiktok_shop', tiktok.key, body, tiktokSign(body, 'not-the-secret'))).status).toBe(200);
    }
    expect((await relay()).tally).toEqual({ ok: 0, refused: need, dropped: 0 });
    expect(await rejected(tiktok.hookId)).toBe(10);
    expect((await rows<{ stopped_at: string | null }>('SELECT stopped_at FROM ludy_finance.marketplace_hook WHERE id = $1', [tiktok.hookId]))[0]?.stopped_at).not.toBeNull();
    const good = tiktokBody(200);
    const response = await post('tiktok_shop', tiktok.key, good, tiktokSign(good));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
    expect(await stored()).toEqual([]);
    expect(await relay()).toEqual({ claimed: 0, tally: { ok: 0, refused: 0, dropped: 0 } });
    expect(sent).toEqual([]);
    // The other connection's hook is not touched by it.
    const other = shopeeBody(3);
    expect((await post('shopee', shopee.key, other, shopeeSign(other, `${PUBLIC_URL}/api/marketplace/shopee/webhook/${shopee.key}`))).status).toBe(200);
    expect((await relay()).tally).toEqual({ ok: 1, refused: 0, dropped: 0 });
  });

  it('answers 404 and stores nothing once the connection behind a hook is closed, and drops a push that waited for it without polling', async () => {
    sent.length = 0;
    const waiting = shopeeBody(4);
    expect((await post('shopee', shopee.key, waiting, shopeeSign(waiting, `${PUBLIC_URL}/api/marketplace/shopee/webhook/${shopee.key}`))).status).toBe(200);
    await rows("UPDATE ludy_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2", [orgId, shopee.channelId]);
    // Closed in between: the route does not know the key any more, and what waited is dropped by the claim (nothing is handed out, nothing polled).
    expect((await post('shopee', shopee.key, shopeeBody(5), 'a'.repeat(64))).status).toBe(404);
    expect(await relay()).toEqual({ claimed: 0, tally: { ok: 0, refused: 0, dropped: 0 } });
    expect(sent).toEqual([]);
    expect(await stored()).toEqual([]);
  });

  it('binds reject to the hook generation: a bad push claimed before key rotation never counts against the rotated address', async () => {
    sent.length = 0;
    // The test above stopped tiktok at generation 1; rotating moves it to generation 2 and accepts pushes again.
    const gen2 = await api.execute<{ key: string }>('finance.marketplace_connection.push_hook_set', { id: tiktok.connectionId }, { actor: asOwner(), orgId });
    const badBefore = tiktokBody(300);
    expect((await post('tiktok_shop', gen2.key, badBefore, tiktokSign(badBefore, 'not-the-secret'))).status).toBe(200);
    const claimedPreRotation: Array<{ hookId: string; generation: number }> = [];
    await relayBatch(workerDb, sender, async (trx) => {
      const batch = await claimMarketplaceHookNotices(trx);
      const verdicts = await verifyMarketplaceHookNotices(
        { runtime: worker, broker: vault, adapters: new Set(['tiktok_shop', 'shopee']), reject: async (hookId, generation) => void claimedPreRotation.push({ hookId, generation }) },
        batch,
      );
      expect(verdicts).toEqual(['refused']);
      return [];
    });
    expect(claimedPreRotation).toHaveLength(1);
    expect(claimedPreRotation[0]?.generation).toBe(2);
    expect(claimedPreRotation[0]?.hookId).not.toBe(tiktok.hookId);
    // Rotate before the post-commit reject runs: the hook moves to generation 3, and the pre-rotation refusal must not count against it.
    const gen3 = await api.execute<{ key: string }>('finance.marketplace_connection.push_hook_set', { id: tiktok.connectionId }, { actor: asOwner(), orgId });
    expect(await rejectMarketplaceHook(workerDb, claimedPreRotation[0]!.hookId, claimedPreRotation[0]!.generation)).toBe(false);
    expect(await rejected(tiktok.hookId)).toBe(0);
    // A bad push on the new address IS generation 3 and counts; a good push still polls.
    const badAfter = tiktokBody(301);
    expect((await post('tiktok_shop', gen3.key, badAfter, tiktokSign(badAfter, 'not-the-secret'))).status).toBe(200);
    expect(await relay()).toEqual({ claimed: 1, tally: { ok: 0, refused: 1, dropped: 0 } });
    expect(await rejected(tiktok.hookId)).toBe(1);
    const goodAfter = tiktokBody(302);
    expect((await post('tiktok_shop', gen3.key, goodAfter, tiktokSign(goodAfter))).status).toBe(200);
    expect(await relay()).toEqual({ claimed: 1, tally: { ok: 1, refused: 0, dropped: 0 } });
    expect(sent).toHaveLength(1);
  });

  // The tests above leave state for the next (rejected counts, the stopped hook, the revoked channel connection), so they run in this order.
  it('keeps the body of every push in no row of the kernel, jobs or finance schemas once the notices are gone: not as text, not as hex, and not in a job the relay sent', async () => {
    expect(await stored()).toEqual([]);
    await admin(async (client) => {
      const tables = (await client.query<{ table_schema: string; table_name: string }>("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema IN ('ludy_kernel', 'ludy_jobs', 'ludy_finance') AND table_type = 'BASE TABLE'")).rows;
      expect(tables.length).toBeGreaterThan(0);
      for (const { table_schema, table_name } of tables) {
        // The row as text shows a bytea column in hex, so the canary is looked for as text and as hex.
        const found = (await client.query<{ hit: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${table_schema}.${table_name} t WHERE t::text LIKE $1 OR t::text LIKE $2) AS hit`, [`%${CANARY}%`, `%${Buffer.from(CANARY).toString('hex')}%`])).rows;
        expect({ table: `${table_schema}.${table_name}`, hit: found[0]?.hit }).toEqual({ table: `${table_schema}.${table_name}`, hit: false });
      }
    });
    // The queue is a recording fake, so ludy_jobs holds nothing here: what a poll job carries is what the relay sent.
    expect(JSON.stringify(sent)).not.toContain(CANARY);
  });
});

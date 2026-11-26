// SPDX-License-Identifier: AGPL-3.0-only
// Security and concurrency invariants for WhatsApp Business webhooks, one-org-per-number binding, and number hand-over (#3152).
// Self-contained under test/invariant/ (fixtures from ./fixtures only):
// - cross-provider webhook signatures (Pages/Instagram/Threads/Zalo) never pass WhatsApp verification or park rows, and vice versa;
// - one organization holds a WhatsApp phone number at a time while active or expired (409 CHANNEL_ACCOUNT_TAKEN);
// - concurrent Org B connect waiting on Org A disconnect serializes on the handover advisory lock and stores post-lock clock_timestamp()
//   connected_at, so delayed notices from Org A never leak into Org B.
// Part of the invariant suite: set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a PostgreSQL 17 superuser URL.
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CredentialVault, Runtime, parseVaultKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { runConversationIntake } from '../../src/conversations-worker.ts';
import { FACEBOOK_SIGNATURE_HEADER, FACEBOOK_WEBHOOK_PATH } from '../../src/facebook-webhook.ts';
import { createHttpApp } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { WHATSAPP_SIGNATURE_HEADER, WHATSAPP_WEBHOOK_PATH } from '../../src/whatsapp-webhook.ts';
import { ZALO_SIGNATURE_HEADER, ZALO_WEBHOOK_PATH } from '../../src/zalo-webhook.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SYSTEM = { type: 'system' as const, component: 'whatsapp-handover-invariant' };
const JWT_SECRET = 'invariant-jwt-secret-whatsapp-0123456789-abcdef';
const WA_SECRET = 'invariant-wa-app-secret-not-real-0001';
const WA_VERIFY = 'invariant-wa-verify-token-not-real';
const FB_SECRET = 'invariant-fb-app-secret-not-real-0002';
const IG_SECRET = 'invariant-ig-app-secret-not-real-0003';
const THREADS_SECRET = 'invariant-th-app-secret-not-real-0004';
const FB_VERIFY = 'invariant-fb-verify-token-not-real';
const ZALO_APP_ID = '4200000000000000001';
const ZALO_SECRET = 'invariant-zalo-oa-secret-not-real-005';
const ACCESS_TOKEN = `EAAG${'w'.repeat(48)}`;

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const found = this.blobs.get(key);
    if (!found) throw new Error('missing blob');
    return found;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

const signHub = (body: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;

const signZalo = (appId: string, body: string, timestamp: string, secret: string) =>
  `mac=${createHash('sha256').update(appId + body + timestamp + secret).digest('hex')}`;

suite('WhatsApp webhook isolation, org binding, and handover lock invariants (#3152)', () => {
  const dbName = `crove_test_wa_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  const pools: pg.Pool[] = [];
  let appDb: Db;
  let workerDb: Db;
  let api: Runtime;
  let worker: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) =>
    admin(async (c) => (await c.query<T>(text, params)).rows);

  let phoneCounter = 0;
  async function makeOrg(name = 'owner'): Promise<{ orgId: string; owner: string; phoneId: string; connectionId: string }> {
    const owner = (await upsertIdentity(appDb, {
      issuer: 'test',
      subject: randomUUID(),
      email: `${name}-${randomUUID().slice(0, 8)}@wa-inv.test`,
      name: null,
    })) as string;
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const phoneId = `1050000000${String(1000 + phoneCounter++)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '205000000000001' }), {
      orgId,
      provider: 'whatsapp',
      externalAccountId: phoneId,
    });
    const connected = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      {
        provider: 'whatsapp',
        externalAccountId: phoneId,
        displayName: 'Tiệm Bánh Thử Nghiệm',
        scopes: ['whatsapp_business_messaging'],
        expiresAt: null,
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asUser(owner), orgId },
    );
    return { orgId, owner, phoneId, connectionId: connected.connectionId };
  }

  function waCustomerNotice(phoneId: string, waId: string, timestamp: string, body = 'Xin chào shop'): string {
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '205000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '84900000099', phone_number_id: phoneId },
                contacts: [{ profile: { name: 'Khách' }, wa_id: waId }],
                messages: [{ from: waId, id: `wamid.inv-${randomUUID().slice(0, 12)}`, timestamp, type: 'text', text: { body } }],
              },
            },
          ],
        },
      ],
    });
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const login = (user: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = dbIds ? dbIds.roleName(user) : user;
      u.password = password;
      return u.toString();
    };
    const appUrl = login('crove_app', 'test-app-pw');
    const appPool = createDbPool({ connectionString: appUrl, max: 4 }, dbIds);
    pools.push(appPool);
    appDb = createDb(appPool);
    const workerPool = createDbPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 }, dbIds);
    pools.push(workerPool);
    workerDb = createDb(workerPool);

    const defs = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: null })] };
    api = new Runtime(appDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register(defs);
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(defs);
    const store = new MemoryStore();
    const appConfig = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_SECRET,
      AUTH_ISSUER: 'ludy-auth',
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({
      config: appConfig,
      runtime: api,
      store,
      authenticate: createAuthenticator(appConfig, appDb),
      pool: appPool,
      aiEnabled: false,
      whatsappWebhook: { appSecret: WA_SECRET, verifyToken: WA_VERIFY },
      facebookWebhook: { appSecret: FB_SECRET, instagramAppSecret: IG_SECRET, threadsAppSecret: THREADS_SECRET, verifyToken: FB_VERIFY },
      zaloWebhook: { appId: ZALO_APP_ID, oaSecretKey: ZALO_SECRET },
    });
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('refuses cross-provider and malformed webhook signatures with 401 and parks zero pending rows', async () => {
    const waBody = waCustomerNotice('105000000999999', '84900000011', String(Math.floor(Date.now() / 1000)));
    const zaloTs = String(Date.now());
    const zaloBody = JSON.stringify({
      event_name: 'user_send_text',
      timestamp: zaloTs,
      sender: { id: 'zalo-u-1' },
      recipient: { id: 'zalo-oa-1' },
      message: { msg_id: `zm-${randomUUID().slice(0, 8)}`, text: 'Xin chào' },
    });
    const pageBody = JSON.stringify({
      object: 'page',
      entry: [{ id: '990000000001', time: Math.floor(Date.now() / 1000), changes: [{ field: 'feed', value: { item: 'comment', comment_id: '990000000001_1', post_id: '990000000001_2', message: 'Hi', from: { id: '1', name: 'A' }, created_time: Math.floor(Date.now() / 1000) } }] }],
    });

    // Reject missing, malformed, wrong, Pages, Instagram, Threads, and Zalo signatures on the WhatsApp webhook route.
    const badWaHeaders: Array<Record<string, string>> = [
      {},
      { [WHATSAPP_SIGNATURE_HEADER]: '' },
      { [WHATSAPP_SIGNATURE_HEADER]: `md5=${'a'.repeat(32)}` },
      { [WHATSAPP_SIGNATURE_HEADER]: 'sha256=deadbeef' },
      { [WHATSAPP_SIGNATURE_HEADER]: signHub(waBody, 'wrong-whatsapp-secret') },
      { [WHATSAPP_SIGNATURE_HEADER]: signHub(waBody, FB_SECRET) },
      { [WHATSAPP_SIGNATURE_HEADER]: signHub(waBody, IG_SECRET) },
      { [WHATSAPP_SIGNATURE_HEADER]: signHub(waBody, THREADS_SECRET) },
      { [ZALO_SIGNATURE_HEADER]: signZalo(ZALO_APP_ID, waBody, String(Math.floor(Date.now() / 1000)), ZALO_SECRET) },
    ];
    for (const headers of badWaHeaders) {
      const res = await app.request(WHATSAPP_WEBHOOK_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: waBody,
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ code: 'WEBHOOK_SIGNATURE' });
    }

    // Reject payloads signed with the WhatsApp app secret on Facebook and Zalo webhook routes.
    const fbWithWaSig = await app.request(FACEBOOK_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FACEBOOK_SIGNATURE_HEADER]: signHub(pageBody, WA_SECRET) },
      body: pageBody,
    });
    expect(fbWithWaSig.status).toBe(401);
    expect(await fbWithWaSig.json()).toEqual({ code: 'WEBHOOK_SIGNATURE' });

    const fbWithWaBodyAndSig = await app.request(FACEBOOK_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [FACEBOOK_SIGNATURE_HEADER]: signHub(waBody, WA_SECRET) },
      body: waBody,
    });
    expect(fbWithWaBodyAndSig.status).toBe(401);
    expect(await fbWithWaBodyAndSig.json()).toEqual({ code: 'WEBHOOK_SIGNATURE' });

    const waWithPageBodyAndSig = await app.request(WHATSAPP_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WHATSAPP_SIGNATURE_HEADER]: signHub(pageBody, FB_SECRET) },
      body: pageBody,
    });
    expect(waWithPageBodyAndSig.status).toBe(401);
    expect(await waWithPageBodyAndSig.json()).toEqual({ code: 'WEBHOOK_SIGNATURE' });

    const zaloWithWaHub = await app.request(ZALO_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WHATSAPP_SIGNATURE_HEADER]: signHub(zaloBody, WA_SECRET) },
      body: zaloBody,
    });
    expect(zaloWithWaHub.status).toBe(401);
    expect(await zaloWithWaHub.json()).toEqual({ code: 'WEBHOOK_SIGNATURE' });

    const zaloWithWaMac = await app.request(ZALO_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ZALO_SIGNATURE_HEADER]: signZalo(ZALO_APP_ID, zaloBody, zaloTs, WA_SECRET) },
      body: zaloBody,
    });
    expect(zaloWithWaMac.status).toBe(401);
    expect(await zaloWithWaMac.json()).toEqual({ code: 'WEBHOOK_SIGNATURE' });

    // None of the cross-provider or malformed attempts parked any row.
    expect(await rows('SELECT 1 FROM crove_kernel.conversation_inbound_pending')).toHaveLength(0);

    // Positive control: each route still accepts its own valid signature and parks only its own provider.
    const waOk = await app.request(WHATSAPP_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WHATSAPP_SIGNATURE_HEADER]: signHub(waBody, WA_SECRET) },
      body: waBody,
    });
    expect(waOk.status).toBe(200);
    const zaloOk = await app.request(ZALO_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [ZALO_SIGNATURE_HEADER]: signZalo(ZALO_APP_ID, zaloBody, zaloTs, ZALO_SECRET) },
      body: zaloBody,
    });
    expect(zaloOk.status).toBe(200);
    const parked = await rows<{ provider: string }>('SELECT provider FROM crove_kernel.conversation_inbound_pending ORDER BY seq');
    expect(parked.map((r) => r.provider)).toEqual(['whatsapp', 'zalo_oa']);

    // Drain positive control pending rows through intake before testing handover isolation.
    await runConversationIntake({ workerDb, runtime: worker, log: () => undefined });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation_inbound_pending')).toHaveLength(0);
  });

  it('enforces one non-revoked organization per WhatsApp phone number (active and expired) and refuses unique index bypass', async () => {
    const a = await makeOrg('a');
    const b = await makeOrg('b');
    const connectB = (phoneId: string) => {
      const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '205000000000001' }), {
        orgId: b.orgId,
        provider: 'whatsapp',
        externalAccountId: phoneId,
      });
      return api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        {
          provider: 'whatsapp',
          externalAccountId: phoneId,
          displayName: 'Tiệm B',
          scopes: ['whatsapp_business_messaging'],
          expiresAt: null,
          credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
        },
        { actor: asUser(b.owner), orgId: b.orgId },
      );
    };

    // Active connection held by Org A refuses Org B with 409 CHANNEL_ACCOUNT_TAKEN.
    await expect(connectB(a.phoneId)).rejects.toMatchObject({ code: 'CHANNEL_ACCOUNT_TAKEN', status: 409 });
    expect(await rows('SELECT 1 FROM crove_kernel.channel_connection WHERE org_id = $1 AND external_account_id = $2', [b.orgId, a.phoneId])).toHaveLength(0);

    // Even when Org A's connection is expired (not revoked), Org B is still refused.
    await worker.execute(
      'kernel.channel.mark_expired',
      { connectionId: a.connectionId, reason: 'token_expired' },
      { actor: SYSTEM, orgId: a.orgId },
    );
    await expect(connectB(a.phoneId)).rejects.toMatchObject({ code: 'CHANNEL_ACCOUNT_TAKEN', status: 409 });

    // Direct database insertion also enforces channel_connection_whatsapp_account_uq.
    await expect(
      rows(
        "INSERT INTO crove_kernel.channel_connection (org_id, provider, external_account_id, display_name, status, connected_by) VALUES ($1, 'whatsapp', $2, 'Bypass', 'active', $3)",
        [b.orgId, a.phoneId, b.owner],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'channel_connection_whatsapp_account_uq' });

    // Only after Org A disconnects can Org B connect the number.
    await api.execute('kernel.channel.disconnect', { connectionId: a.connectionId }, { actor: asUser(a.owner), orgId: a.orgId });
    await expect(connectB(a.phoneId)).resolves.toMatchObject({ reconnected: false });
  });

  it('serializes concurrent WhatsApp handover on the advisory lock with post-lock connected_at so earlier notices cannot leak', async () => {
    const a = await makeOrg('handover-a');
    const b = await makeOrg('handover-b');
    const connectB = () => {
      const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '205000000000001' }), {
        orgId: b.orgId,
        provider: 'whatsapp',
        externalAccountId: a.phoneId,
      });
      return api.execute<{ connectionId: string; reconnected: boolean }>(
        'kernel.channel.connect',
        {
          provider: 'whatsapp',
          externalAccountId: a.phoneId,
          displayName: 'Tiệm B Handover',
          scopes: ['whatsapp_business_messaging'],
          expiresAt: null,
          credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
        },
        { actor: asUser(b.owner), orgId: b.orgId },
      );
    };
    const waitUntil = async (client: pg.Client, sqlText: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const res = await client.query<{ ready: boolean }>(sqlText);
        if (res.rows[0]?.ready) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`Timed out waiting for lock condition: ${sqlText}`);
    };

    const blocker = createDbClient({ connectionString: adminUrl }, dbIds);
    const observer = createDbClient({ connectionString: adminUrl }, dbIds);
    await blocker.connect();
    await observer.connect();
    let disconnectPromise: Promise<unknown> | undefined;
    let connectPromise: Promise<{ connectionId: string; reconnected: boolean }> | undefined;
    let connectStartedAt = 0;
    let finalNoticeAt = 0;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2 FOR KEY SHARE', [a.orgId, a.connectionId]);

      disconnectPromise = api.execute('kernel.channel.disconnect', { connectionId: a.connectionId }, { actor: asUser(a.owner), orgId: a.orgId });
      await waitUntil(
        observer,
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks l
           JOIN pg_stat_activity s ON s.pid = l.pid
           WHERE l.locktype = 'advisory' AND l.granted
             AND s.datname = current_database() AND s.pid <> pg_backend_pid() AND s.wait_event_type = 'Lock'
         ) AS ready`,
      );

      connectStartedAt = Date.now();
      connectPromise = connectB();
      await waitUntil(
        observer,
        `SELECT EXISTS (
           SELECT 1 FROM pg_locks l
           JOIN pg_stat_activity s ON s.pid = l.pid
           WHERE l.locktype = 'advisory' AND NOT l.granted
             AND s.datname = current_database() AND s.pid <> pg_backend_pid()
         ) AS ready`,
      );

      await new Promise((r) => setTimeout(r, 20));
      finalNoticeAt = Date.now();
      expect(finalNoticeAt).toBeGreaterThan(connectStartedAt);
      const staleNotice = waCustomerNotice(a.phoneId, '84900000077', String(finalNoticeAt), 'Tin cũ trước bàn giao');
      expect(
        (
          await app.request(WHATSAPP_WEBHOOK_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [WHATSAPP_SIGNATURE_HEADER]: signHub(staleNotice, WA_SECRET) },
            body: staleNotice,
          })
        ).status,
      ).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      await blocker.query('COMMIT');
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end().catch(() => undefined);
      await observer.end().catch(() => undefined);
    }

    const [discRes, connRes] = await Promise.all([disconnectPromise, connectPromise]);
    expect(discRes).toEqual({ connectionId: a.connectionId, status: 'revoked' });
    expect(connRes).toMatchObject({ reconnected: false });

    const bConn = await rows<{ connected_at: Date }>('SELECT connected_at FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [b.orgId, connRes?.connectionId]);
    const bConnectedMs = new Date(bConn[0]?.connected_at as Date).getTime();
    expect(bConnectedMs).toBeGreaterThan(finalNoticeAt);
    expect(bConnectedMs).toBeGreaterThan(connectStartedAt);

    expect(await runConversationIntake({ workerDb, runtime: worker, log: () => undefined })).toMatchObject({ dropped: 0 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = ANY($1::uuid[])', [[a.orgId, b.orgId]])).toHaveLength(0);

    await new Promise((r) => setTimeout(r, 15));
    const freshNotice = waCustomerNotice(a.phoneId, '84900000088', String(Date.now()), 'Tin mới của tổ chức B');
    expect(
      (
        await app.request(WHATSAPP_WEBHOOK_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [WHATSAPP_SIGNATURE_HEADER]: signHub(freshNotice, WA_SECRET) },
          body: freshNotice,
        })
      ).status,
    ).toBe(200);
    expect(await runConversationIntake({ workerDb, runtime: worker, log: () => undefined })).toMatchObject({ dropped: 0 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [b.orgId])).toHaveLength(1);
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [a.orgId])).toHaveLength(0);
  });

  it('stamps connected_at after INSERT clears an uncommitted org_purge DELETE on channel_connection_whatsapp_account_uq', async () => {
    const purgedOrg = await makeOrg('purge-a');
    const takerOrg = await makeOrg('purge-b');
    const waitUntil = async (client: pg.Client, sqlText: string): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const res = await client.query<{ ready: boolean }>(sqlText);
        if (res.rows[0]?.ready) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`Timed out waiting for lock condition: ${sqlText}`);
    };
    const purgeClient = createDbClient({ connectionString: adminUrl }, dbIds);
    const observer = createDbClient({ connectionString: adminUrl }, dbIds);
    await purgeClient.connect();
    await observer.connect();
    let takerPromise: Promise<{ connectionId: string }> | undefined;
    let delayedNoticeAt = 0;
    try {
      await purgeClient.query('BEGIN');
      await purgeClient.query('DELETE FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [purgedOrg.orgId, purgedOrg.connectionId]);

      const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '205000000000001' }), {
        orgId: takerOrg.orgId,
        provider: 'whatsapp',
        externalAccountId: purgedOrg.phoneId,
      });
      takerPromise = api.execute<{ connectionId: string }>(
        'kernel.channel.connect',
        {
          provider: 'whatsapp',
          externalAccountId: purgedOrg.phoneId,
          displayName: 'Tiệm Sau Purge',
          scopes: ['whatsapp_business_messaging'],
          expiresAt: null,
          credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
        },
        { actor: asUser(takerOrg.owner), orgId: takerOrg.orgId },
      );

      await waitUntil(
        observer,
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity s
           WHERE s.datname = current_database() AND s.pid <> pg_backend_pid() AND s.wait_event_type = 'Lock'
         ) AS ready`,
      );
      await new Promise((r) => setTimeout(r, 20));
      delayedNoticeAt = Date.now();
      const staleNotice = waCustomerNotice(purgedOrg.phoneId, '84900000066', String(delayedNoticeAt), 'Tin cũ trước org_purge');
      expect(
        (
          await app.request(WHATSAPP_WEBHOOK_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [WHATSAPP_SIGNATURE_HEADER]: signHub(staleNotice, WA_SECRET) },
            body: staleNotice,
          })
        ).status,
      ).toBe(200);
      await new Promise((r) => setTimeout(r, 20));
      await purgeClient.query('COMMIT');
    } finally {
      await purgeClient.query('ROLLBACK').catch(() => undefined);
      await purgeClient.end().catch(() => undefined);
      await observer.end().catch(() => undefined);
    }

    const takerConn = await takerPromise;
    const takerRow = await rows<{ connected_at: Date }>('SELECT connected_at FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [takerOrg.orgId, takerConn?.connectionId]);
    expect(new Date(takerRow[0]?.connected_at as Date).getTime()).toBeGreaterThan(delayedNoticeAt);
    expect(await runConversationIntake({ workerDb, runtime: worker, log: () => undefined })).toMatchObject({ dropped: 0 });
    expect(await rows('SELECT 1 FROM crove_kernel.conversation WHERE org_id = $1', [takerOrg.orgId])).toHaveLength(0);
  });
});

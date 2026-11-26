// SPDX-License-Identifier: AGPL-3.0-only
// Security invariants for WhatsApp inbound `received_at` anchoring and `WHATSAPP_CLOCK_SKEW_MS` (#5047).
// Self-contained under test/invariant/ (fixtures from ./fixtures only):
// - pre-handover webhooks whose upstream Meta `event.at` is skewed forward past Org B's `connected_at`
//   still fail closed because PostgreSQL `received_at < connected_at` (including sub-millisecond offsets);
// - omitted or unparseable `receivedAt` on WhatsApp `kernel.conversation.ingest` fails closed (`ignored`);
// - events past `received_at + WHATSAPP_CLOCK_SKEW_MS` (including +1 microsecond) are rejected;
// - post-handover fresh webhooks within skew succeed without leaking prior-holder notices.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WHATSAPP_CLOCK_SKEW_MS } from '@ludy/channel';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { CONVERSATION_WHATSAPP_CLOCK_SKEW_MS } from '@ludy/kernel-contract';
import { CredentialVault, Runtime, parseVaultKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { createAuthenticator } from '../../src/auth.ts';
import { loadConfig } from '../../src/config.ts';
import { runConversationIntake } from '../../src/conversations-worker.ts';
import { createHttpApp } from '../../src/http.ts';
import { createSessionStatusSource } from '../../src/sessions.ts';
import { WHATSAPP_SIGNATURE_HEADER, WHATSAPP_WEBHOOK_PATH } from '../../src/whatsapp-webhook.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SYSTEM = { type: 'system' as const, component: 'whatsapp-clock-skew-invariant' };
const JWT_SECRET = 'invariant-jwt-secret-wa-skew-0123456789-abcdef';
const WA_SECRET = 'invariant-wa-skew-secret-not-real-0001';
const WA_VERIFY = 'invariant-wa-skew-verify-token-not-real';
const ACCESS_TOKEN = `EAAG${'s'.repeat(48)}`;
const PINNED_MAX_SKEW_MS = 600_000;

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

const signHub = (body: string, secret = WA_SECRET) =>
  `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;

suite('WhatsApp received_at anchoring and clock-skew invariants (#5047)', () => {
  const dbName = `ludy_test_wa_skew_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
      email: `${name}-${randomUUID().slice(0, 8)}@wa-skew-inv.test`,
      name: null,
    })) as string;
    const { orgId } = await createOrg(api, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const phoneId = `1060000000${String(1000 + phoneCounter++)}`;
    const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '206000000000001' }), {
      orgId,
      provider: 'whatsapp',
      externalAccountId: phoneId,
    });
    const connected = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      {
        provider: 'whatsapp',
        externalAccountId: phoneId,
        displayName: 'Cửa hàng Skew Test',
        scopes: ['whatsapp_business_messaging'],
        expiresAt: null,
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asUser(owner), orgId },
    );
    return { orgId, owner, phoneId, connectionId: connected.connectionId };
  }

  function waNotice(phoneId: string, waId: string, timestamp: string, body = 'Xin chào'): string {
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '206000000000001',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '84000000099', phone_number_id: phoneId },
                contacts: [{ profile: { name: 'Khách' }, wa_id: waId }],
                messages: [{ from: waId, id: `wamid.skew-inv-${randomUUID().slice(0, 12)}`, timestamp, type: 'text', text: { body } }],
              },
            },
          ],
        },
      ],
    });
  }

  const intake = () => runConversationIntake({ workerDb, runtime: worker, log: () => undefined });

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

  it('rejects forward-skewed pre-handover notices across handover and same-millisecond microsecond boundaries, while allowing fresh post-handover notices', async () => {
    expect(WHATSAPP_CLOCK_SKEW_MS).toBe(PINNED_MAX_SKEW_MS);
    expect(CONVERSATION_WHATSAPP_CLOCK_SKEW_MS).toBe(PINNED_MAX_SKEW_MS);

    const a = await makeOrg('skew-a');
    const b = await makeOrg('skew-b');

    // Webhook arrives while Org A holds the number, carrying Meta timestamp +5 min ahead (within WHATSAPP_CLOCK_SKEW_MS).
    const preHandoverBody = waNotice(a.phoneId, '84000000101', String(Date.now() + 5 * 60_000), 'Tin của khách tổ chức A');
    expect(
      (
        await app.request(WHATSAPP_WEBHOOK_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [WHATSAPP_SIGNATURE_HEADER]: signHub(preHandoverBody) },
          body: preHandoverBody,
        })
      ).status,
    ).toBe(200);

    await new Promise((r) => setTimeout(r, 10));
    await api.execute('kernel.channel.disconnect', { connectionId: a.connectionId }, { actor: asUser(a.owner), orgId: a.orgId });
    const sealed = vault.seal(JSON.stringify({ accessToken: ACCESS_TOKEN, wabaId: '206000000000001' }), {
      orgId: b.orgId,
      provider: 'whatsapp',
      externalAccountId: a.phoneId,
    });
    const bConn = await api.execute<{ connectionId: string }>(
      'kernel.channel.connect',
      {
        provider: 'whatsapp',
        externalAccountId: a.phoneId,
        displayName: 'Cửa hàng B',
        scopes: ['whatsapp_business_messaging'],
        expiresAt: null,
        credential: { keyId: sealed.keyId, envelope: sealed.envelope.toString('base64') },
      },
      { actor: asUser(b.owner), orgId: b.orgId },
    );

    // Even with event.at > b.connected_at, received_at < b.connected_at so intake never leaks Org A's notice into Org B.
    expect(await intake()).toEqual({ stored: 0, dropped: 0 });
    expect(await rows('SELECT 1 FROM ludy_kernel.conversation WHERE org_id = ANY($1::uuid[])', [[a.orgId, b.orgId]])).toHaveLength(0);

    // Post-handover fresh webhook arrives after connected_at (within skew) and stores under Org B.
    await new Promise((r) => setTimeout(r, 15));
    const postHandoverBody = waNotice(a.phoneId, '84000000102', String(Date.now()), 'Tin mới của tổ chức B');
    expect(
      (
        await app.request(WHATSAPP_WEBHOOK_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [WHATSAPP_SIGNATURE_HEADER]: signHub(postHandoverBody) },
          body: postHandoverBody,
        })
      ).status,
    ).toBe(200);
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    expect(await rows('SELECT 1 FROM ludy_kernel.conversation WHERE org_id = $1', [b.orgId])).toHaveLength(1);

    // Same-millisecond microsecond check: received_at 100us before connected_at is still blocked even when Meta event.at > connected_at.
    const baseSecMs = Math.floor((Date.now() - 25 * 60_000) / 1000) * 1000;
    const isoWithMicros = (secOffsetMs: number, micros: number) => {
      const base = new Date(baseSecMs + secOffsetMs).toISOString();
      return `${base.slice(0, -1)}${String(micros).padStart(3, '0')}Z`;
    };
    const subMsConnectedIso = isoWithMicros(0, 500);
    await rows('UPDATE ludy_kernel.channel_connection SET connected_at = $3::timestamptz WHERE org_id = $1 AND id = $2', [b.orgId, bConn.connectionId, subMsConnectedIso]);
    const sameMsSkewBody = waNotice(a.phoneId, '84000000103', String(Math.floor((baseSecMs + 5 * 60_000) / 1000)), 'Sub-ms skew');
    const overSkewBody = waNotice(a.phoneId, '84000000104', String(baseSecMs + PINNED_MAX_SKEW_MS + 1), 'Over skew');
    const atMaxSkewBody = waNotice(a.phoneId, '84000000105', String(baseSecMs + PINNED_MAX_SKEW_MS), 'At exact skew');
    await rows(
      `INSERT INTO ludy_kernel.conversation_inbound_pending (provider, body, received_at)
       VALUES ('whatsapp', $1, $4::timestamptz), ('whatsapp', $2, $5::timestamptz), ('whatsapp', $3, $5::timestamptz)`,
      [Buffer.from(sameMsSkewBody, 'utf8'), Buffer.from(overSkewBody, 'utf8'), Buffer.from(atMaxSkewBody, 'utf8'), isoWithMicros(0, 400), isoWithMicros(0, 500)],
    );
    expect(await intake()).toEqual({ stored: 1, dropped: 0 });
    expect(await rows('SELECT 1 FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = ANY($2::text[])', [b.orgId, ['84000000103', '84000000104']])).toHaveLength(0);
    expect(await rows('SELECT 1 FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = $2', [b.orgId, '84000000105'])).toHaveLength(1);
  });

  it('fails closed on direct WhatsApp ingest when receivedAt is omitted, before connected_at, or past WHATSAPP_CLOCK_SKEW_MS', async () => {
    const o = await makeOrg('skew-direct');
    const baseSecMs = Math.floor((Date.now() - 25 * 60_000) / 1000) * 1000;
    const isoWithMicros = (secOffsetMs: number, micros: number) => {
      const base = new Date(baseSecMs + secOffsetMs).toISOString();
      return `${base.slice(0, -1)}${String(micros).padStart(3, '0')}Z`;
    };
    const connectedIso = isoWithMicros(0, 500);
    await rows('UPDATE ludy_kernel.channel_connection SET connected_at = $3::timestamptz WHERE org_id = $1 AND id = $2', [o.orgId, o.connectionId, connectedIso]);

    const ev = (atIso: string, suffix: string) => ({
      kind: 'direct' as const,
      threadId: '84000000201',
      messageId: `wamid.inv-direct-${suffix}-${randomUUID().slice(0, 8)}`,
      direction: 'in' as const,
      contact: { id: '84000000201', name: 'Khách Direct' },
      text: `direct-${suffix}`,
      at: atIso,
    });

    // 1. Omitted receivedAt on WhatsApp fails closed.
    await expect(
      worker.execute('kernel.conversation.ingest', { connectionId: o.connectionId, events: [ev(connectedIso, 'missing-recv')] }, { actor: SYSTEM, orgId: o.orgId }),
    ).resolves.toMatchObject({ stored: 0, ignored: 1 });

    // 2. receivedAt 1us before connected_at with skewed event.at fails closed.
    await expect(
      worker.execute(
        'kernel.conversation.ingest',
        { connectionId: o.connectionId, receivedAt: isoWithMicros(0, 499), events: [ev(isoWithMicros(5 * 60_000, 500), 'subms-pre-recv')] },
        { actor: SYSTEM, orgId: o.orgId },
      ),
    ).resolves.toMatchObject({ stored: 0, ignored: 1 });

    // 3. event.at 1us before connected_at with receivedAt === connected_at fails closed.
    await expect(
      worker.execute(
        'kernel.conversation.ingest',
        { connectionId: o.connectionId, receivedAt: connectedIso, events: [ev(isoWithMicros(0, 499), 'subms-pre-event')] },
        { actor: SYSTEM, orgId: o.orgId },
      ),
    ).resolves.toMatchObject({ stored: 0, ignored: 1 });

    // 4. event.at past receivedAt + 600_000ms (10 minutes) by 1us fails closed.
    await expect(
      worker.execute(
        'kernel.conversation.ingest',
        { connectionId: o.connectionId, receivedAt: connectedIso, events: [ev(isoWithMicros(PINNED_MAX_SKEW_MS, 501), 'subms-over-skew')] },
        { actor: SYSTEM, orgId: o.orgId },
      ),
    ).resolves.toMatchObject({ stored: 0, ignored: 1 });

    // 5. Exact upper bound receivedAt + 600_000ms (10 minutes) stores cleanly.
    await expect(
      worker.execute(
        'kernel.conversation.ingest',
        { connectionId: o.connectionId, receivedAt: connectedIso, events: [ev(isoWithMicros(PINNED_MAX_SKEW_MS, 500), 'subms-exact-skew')] },
        { actor: SYSTEM, orgId: o.orgId },
      ),
    ).resolves.toMatchObject({ stored: 1, ignored: 0 });
  });
});

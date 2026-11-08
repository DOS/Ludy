// SPDX-License-Identifier: AGPL-3.0-only
// The org's connection to a marketplace (#2519, ADR-0045 point 7, plan stock-and-marketplaces.md section 8.7), on a real PostgreSQL 17 through the HTTP API and the worker's poll: the adapters the
// deployment offers (and the platforms with none, which stay on the report file), connect (the credential sealed at the edge, no secret in any answer, audit row or stored row), the test, the
// poll that writes the offline provider's orders as a CSV and ingests it through the SAME intake as an upload (staged, no order stored until a member confirms; a poll twice stages once; the
// cursor moves only after the ingest), a failed poll's state, a revoked connection left alone, who may do what, disconnect, and the database's own guards.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { ExtractClient } from '@crove/extract-contract';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { MarketplaceProviderError, createSandboxMarketplaceProvider, financeCommands, financeQueries, readMarketplaceFile, type MarketplaceProvider } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runMarketplacePoll } from '../src/marketplace-poll-job.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { enterUser } from './context-token.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-marketplace-connections-0123456789';
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

// A store that cannot keep a file, so the ingest of a poll fails.
const failingStore: BlobStore = {
  async put() {
    throw new Error('store down');
  },
  async get() {
    throw new Error('missing blob');
  },
  async delete() {},
};

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

// A planted secret: nothing the API answers, audits, queues or stores in a readable table may carry it.
const PLANTED = `planted-secret-${randomBytes(6).toString('hex')}`;

const suite = ADMIN ? describe : describe.skip;

suite('marketplace connections (#2519)', () => {
  const dbName = `crove_test_marketplace_conn_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let worker: Runtime;
  let rt: Runtime;
  let vault: CredentialVault;
  let extract: ExtractClient;
  const store = new MemoryStore();
  // The deployment with the offline provider on, one with none, and one with a provider that behaves like a real adapter (a host and two fields to connect with).
  let app: ReturnType<typeof createHttpApp>;
  let offApp: ReturnType<typeof createHttpApp>;
  let realApp: ReturnType<typeof createHttpApp>;
  const owner: Account = { subject: randomUUID(), email: 'owner@marketplace-conn.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@marketplace-conn.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@marketplace-conn.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@marketplace-conn.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@marketplace-conn.test', session: randomUUID(), userId: '' };
  let slug = '';
  let orgId = '';
  let otherSlug = '';

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
  const count = async (text: string, values: unknown[] = []) => Number((await rows<{ n: string }>(`SELECT count(*) AS n FROM (${text}) t`, values))[0]?.n);

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
  async function rpc(path: string, token: string, input: unknown, org: string | null = slug, on: ReturnType<typeof createHttpApp> = app) {
    const response = await on.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-crove-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : null) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, text, body: (body && 'json' in body ? body.json : body) as any };
  }
  const call = async (path: string, who: Account, input?: unknown, on: ReturnType<typeof createHttpApp> = app) => rpc(`marketplace/${path}`, await tokenFor(who), input, slug, on);
  const connectInput = (extra: Record<string, unknown> = {}) => ({ adapter: 'sandbox', platform: 'shopee', legalEntityId: null, fields: {}, ...extra });
  const asUser = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const only = <T,>(list: readonly T[]): T => {
    expect(list).toHaveLength(1);
    return list[0] as T;
  };
  const defaultEntity = async () => String((await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id);

  // The worker's poll for a connection, with the providers the deployment offers (the offline one unless another is given).
  const poll = (connectionId: string, providers: Record<string, MarketplaceProvider> = { sandbox: createSandboxMarketplaceProvider() }, on: BlobStore = store) =>
    runMarketplacePoll({ runtime: worker, broker: vault, store: on, providers }, { orgId, connectionId });
  const connection = async (platform: string) => {
    const list = (await call('connections/list', owner)).body as Array<{ id: string; connectionId: string; platform: string; lastPollState: string | null; lastPolledAt: string | null; ordersWaiting: number }>;
    return list.find((c) => c.platform === platform) as (typeof list)[number];
  };
  const cursorOf = async (id: string) => (await rows<{ poll_cursor: string | null }>('SELECT poll_cursor FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2', [orgId, id]))[0]?.poll_cursor;
  const files = () => rows<{ id: string; source: string; content_type: string; filename: string }>('SELECT id, source, content_type, filename FROM crove_kernel.file WHERE org_id = $1 ORDER BY created_at', [orgId]);
  const staged = () => rt.query<Array<{ fileId: string; summary: { platform: string; orders: number; profileConfirmed: boolean } }>>('finance.marketplace.staged', {}, { actor: asUser(member), orgId });

  beforeAll(async () => {
    extract = inProcessExtract();
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
    const register = (target: ReturnType<typeof createDb>, sessions = false) =>
      new Runtime(target, { manifests: TEST_MANIFESTS, ...(sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' as const } : {}) }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    const runtime = register(db, true);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    worker = register(createDb(workerPool));
    const config = loadConfig({ DATABASE_URL: login('crove_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const deps = { config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    const channels = (marketplaceProviders: Record<string, MarketplaceProvider>) => ({ broker: vault, sandbox: false, marketplaceProviders });
    const offline = createSandboxMarketplaceProvider();
    app = createHttpApp({ ...deps, channels: channels({ sandbox: offline }) });
    offApp = createHttpApp({ ...deps, channels: channels({}) });
    realApp = createHttpApp({ ...deps, channels: channels({ sandbox: { ...offline, hosts: ['marketplace.example.test'], connectFields: ['user', 'password'] } }) });

    for (const who of [owner, adminUser, member, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Bán sàn', idempotencyKey: randomUUID() }, null);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser.userId, member.userId, viewer.userId]);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherSlug = String(other.body?.slug);
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

  it('offers only the adapters the deployment turned on, lists the platforms with none as files to bring, and refuses a connect to any other', async () => {
    expect((await call('providers', member)).body).toEqual({
      adapters: [{ id: 'sandbox', offline: true, connectFields: [], platforms: ['lazada', 'shopee', 'tiktok_shop'] }],
      platforms: [
        { platform: 'shopee', adapter: true, adapters: ['sandbox'] },
        { platform: 'tiktok_shop', adapter: true, adapters: ['sandbox'] },
        { platform: 'lazada', adapter: true, adapters: ['sandbox'] },
      ],
    });
    expect((await call('providers', member, undefined, offApp)).body).toEqual({
      adapters: [],
      platforms: [
        { platform: 'shopee', adapter: false, adapters: [] },
        { platform: 'tiktok_shop', adapter: false, adapters: [] },
        { platform: 'lazada', adapter: false, adapters: [] },
      ],
    });
    await expect(call('connections/connect', owner, connectInput(), offApp)).resolves.toMatchObject({ status: 404, body: { code: 'MARKETPLACE_DISABLED' } });
    expect((await call('connections/connect', owner, connectInput({ adapter: 'misa' }))).body).toMatchObject({ code: 'MARKETPLACE_DISABLED' });
    expect(await rows('SELECT 1 FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId])).toEqual([]);
  });

  it('connects the offline provider for an owner or admin only, once for an account, and shows every member its state with no credential', async () => {
    for (const who of [member, viewer]) expect((await call('connections/connect', who, connectInput())).status).toBe(403);
    // Fields the offline provider does not ask for are refused, before anything is sealed.
    expect((await call('connections/connect', owner, connectInput({ fields: { user: 'x' } }))).body).toMatchObject({ code: 'MARKETPLACE_FIELDS' });
    expect(await rows('SELECT 1 FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId])).toEqual([]);
    const connected = await call('connections/connect', adminUser, connectInput());
    expect(connected.status).toBe(200);
    const id = String(connected.body.id);
    expect(await rows('SELECT provider, connected_by FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId])).toEqual([{ provider: 'marketplace_sandbox', connected_by: adminUser.userId }]);
    // The same account again is the same connection.
    expect((await call('connections/connect', owner, connectInput())).body).toEqual({ id });
    expect((await call('connections/list', viewer)).body).toEqual([
      {
        id,
        connectionId: expect.any(String),
        legalEntityId: await defaultEntity(),
        provider: 'marketplace_sandbox',
        platform: 'shopee',
        displayName: 'Sàn thử nghiệm (shopee)',
        status: 'active',
        lastTestState: null,
        lastTestedAt: null,
        lastPolledAt: null,
        lastPollState: null,
        ordersWaiting: 0,
      },
    ]);
    expect((await rpc('marketplace/connections/list', await tokenFor(outsider), undefined, otherSlug)).body).toEqual([]);
    // Another platform of the same entity is its own connection.
    expect((await call('connections/connect', owner, connectInput({ platform: 'tiktok_shop' }))).status).toBe(200);
    expect((await call('connections/connect', owner, connectInput({ platform: 'lazada' }))).status).toBe(200);
    expect(await count('SELECT 1 FROM crove_finance.marketplace_connection WHERE org_id = $1', [orgId])).toBe(3);
  });

  it('tests the connection: owners and admins only, the state is shown to members, and another org finds nothing', async () => {
    const { id } = await connection('shopee');
    for (const who of [member, viewer]) expect((await call('connections/test', who, { id })).status).toBe(403);
    expect((await call('connections/test', owner, { id })).body).toEqual({ state: 'works' });
    expect(((await call('connections/list', member)).body as Array<{ platform: string; lastTestState: string; lastTestedAt: string }>).find((c) => c.platform === 'shopee')).toMatchObject({ lastTestState: 'works', lastTestedAt: expect.any(String) });
    expect((await rpc('marketplace/connections/test', await tokenFor(outsider), { id }, otherSlug)).body).toMatchObject({ code: 'MARKETPLACE_CONNECTION_NOT_FOUND' });
    const audits = await rows<{ command: string; detail: unknown }>("SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'finance.marketplace_connection.%' AND outcome = 'ok'", [orgId]);
    expect(audits.map((a) => a.command)).toEqual(expect.arrayContaining(['finance.marketplace_connection.connect', 'finance.marketplace_connection.record_test']));
  });

  it('asks for the orders now for an owner or admin only, and the request queues the poll as an event with ids only', async () => {
    const { id } = await connection('shopee');
    for (const who of [member, viewer]) expect((await call('connections/pollNow', who, { id })).status).toBe(403);
    expect((await call('connections/pollNow', owner, { id })).body).toEqual({ queued: true });
    const events = await rows<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.marketplace_poll_requested'", [orgId]);
    expect(events).toEqual([{ payload: { connection_id: id } }]);
    expect((await rpc('marketplace/connections/pollNow', await tokenFor(outsider), { id }, otherSlug)).body).toMatchObject({ code: 'MARKETPLACE_CONNECTION_NOT_FOUND' });
  });

  it('polls the offline provider: the orders are staged like an uploaded file, nothing is stored until a member confirms, a poll twice stages once, and confirming stores them', async () => {
    const entry = await connection('shopee');
    expect(await poll(entry.id)).toEqual({ state: 'ok', orders: 3, staged: true });
    // The page went through the intake as a file of the entity, the same as an upload.
    const filed = only(await files());
    expect(filed).toMatchObject({ source: 'upload', content_type: 'text/csv', filename: `don-hang-shopee-${entry.id}-2026-11-02-2026-11-06.csv` });
    expect((await rows<{ upload_entity_id: string | null; created_by: string | null }>('SELECT upload_entity_id, created_by FROM crove_kernel.file WHERE org_id = $1', [orgId]))[0]).toEqual({ upload_entity_id: await defaultEntity(), created_by: null });
    // The progress is recorded: the cursor, when and how it ended. What waits is counted from the Inbox, so nothing waits until the extraction has staged the file.
    expect(await cursorOf(entry.id)).toBe('sandbox:3');
    expect(await connection('shopee')).toMatchObject({ lastPollState: 'ok', lastPolledAt: expect.any(String), ordersWaiting: 0 });
    // The normal extraction event fires and the worker's reader stages the file: no order and no stock yet.
    const read = await readMarketplaceFile({ runtime: worker, store, extract }, orgId, filed.id);
    expect(read).toEqual({ handled: true });
    const waiting = only(await staged());
    expect(waiting).toMatchObject({ fileId: filed.id, summary: { platform: 'shopee', orders: 3, lines: 4, profileConfirmed: false } });
    expect(await count('SELECT 1 FROM crove_finance.channel_order WHERE org_id = $1', [orgId])).toBe(0);
    expect(await count('SELECT 1 FROM crove_finance.channel_order_line WHERE org_id = $1', [orgId])).toBe(0);
    expect(await count("SELECT 1 FROM crove_finance.stock_move WHERE org_id = $1 AND source_type = 'order_line'", [orgId])).toBe(0);
    // A poll again has nothing new: no second file, nothing staged twice, the count of what waits is left alone.
    expect(await poll(entry.id)).toEqual({ state: 'ok', orders: 0, staged: false });
    // The same page asked for again (the cursor lost): the same bytes, so the intake finds the file it has and stages nothing twice.
    await rows('UPDATE crove_finance.marketplace_connection SET poll_cursor = NULL WHERE org_id = $1 AND id = $2', [orgId, entry.id]);
    expect(await poll(entry.id)).toEqual({ state: 'ok', orders: 0, staged: false });
    expect(await files()).toHaveLength(1);
    expect(await count("SELECT 1 FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2", [orgId, filed.id])).toBe(1);
    expect(await cursorOf(entry.id)).toBe('sandbox:3');
    expect((await connection('shopee')).ordersWaiting).toBe(3);
    expect(await staged()).toHaveLength(1);
    // Only a member's confirmation stores the orders, exactly as for an upload.
    const confirmed = await rt.execute<{ newLines: number }>('finance.marketplace.confirm', { fileId: filed.id }, { actor: asUser(member), orgId, idempotencyKey: randomUUID() });
    expect(confirmed.newLines).toBe(4);
    // Confirming takes the orders out of what waits.
    expect((await connection('shopee')).ordersWaiting).toBe(0);
    expect(await count('SELECT 1 FROM crove_finance.channel_order WHERE org_id = $1', [orgId])).toBe(3);
    expect(await staged()).toEqual([]);
    // No buyer data exists anywhere in what was stored: the layout has no buyer column.
    const stored = JSON.stringify(await rows('SELECT * FROM crove_finance.channel_order_line WHERE org_id = $1', [orgId]));
    expect(stored).not.toMatch(/example\.com|Người Mua|Số điện thoại/);
  });

  it('reads a platform in pages: the cursor follows each page, and moves only after the ingest succeeded', async () => {
    const entry = await connection('tiktok_shop');
    const paged = { sandbox: createSandboxMarketplaceProvider({ pageSize: 2 }) };
    // A store that cannot keep the file fails the poll before the cursor moves, so the retry reads the same page again.
    await expect(poll(entry.id, paged, failingStore)).rejects.toThrow('store down');
    expect(await cursorOf(entry.id)).toBeNull();
    expect((await connection('tiktok_shop')).lastPolledAt).toBeNull();
    expect(await poll(entry.id, paged)).toEqual({ state: 'ok', orders: 2, staged: true });
    expect(await cursorOf(entry.id)).toBe('sandbox:2');
    expect(await poll(entry.id, paged)).toEqual({ state: 'ok', orders: 1, staged: true });
    expect(await cursorOf(entry.id)).toBe('sandbox:3');
    expect(await poll(entry.id, paged)).toEqual({ state: 'ok', orders: 0, staged: false });
    const all = await files();
    expect(all.map((f) => f.filename).filter((n) => n.includes('tiktok_shop'))).toHaveLength(2);
    // Each page is a report of its own platform's layout: the reader recognises it.
    for (const f of all.filter((x) => x.filename.includes('tiktok_shop'))) expect(await readMarketplaceFile({ runtime: worker, store, extract }, orgId, f.id)).toEqual({ handled: true });
    expect((await staged()).map((s) => [s.summary.platform, s.summary.orders]).sort()).toEqual([
      ['tiktok_shop', 1],
      ['tiktok_shop', 2],
    ]);
    // A second page adds to the first (it never overwrites it), and a reject lowers what waits.
    expect((await connection('tiktok_shop')).ordersWaiting).toBe(3);
    const second = only((await staged()).filter((s) => s.summary.platform === 'tiktok_shop' && s.summary.orders === 1));
    await rt.execute('finance.marketplace.reject', { fileId: second.fileId }, { actor: asUser(member), orgId, idempotencyKey: randomUUID() });
    expect((await connection('tiktok_shop')).ordersWaiting).toBe(2);
    // Lazada writes one row for each unit and is read through its own profile.
    const lazada = await connection('lazada');
    expect(await poll(lazada.id)).toEqual({ state: 'ok', orders: 3, staged: true });
    const lazadaFile = only((await files()).filter((f) => f.filename.includes('lazada')));
    expect(await readMarketplaceFile({ runtime: worker, store, extract }, orgId, lazadaFile.id)).toEqual({ handled: true });
    expect((await staged()).find((s) => s.summary.platform === 'lazada')).toMatchObject({ summary: { orders: 3, lines: 5 } });
  });

  it('gives each connection its own file: two entities on one offline platform both get their orders staged under their own entity', async () => {
    const entityIds: string[] = [];
    for (const name of ['Chi nhánh A', 'Chi nhánh B']) {
      entityIds.push(String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, $2, 'branch', $3) RETURNING id`, [orgId, name, owner.userId]))[0]?.id));
    }
    const ids: string[] = [];
    for (const legalEntityId of entityIds) {
      const connected = await call('connections/connect', owner, connectInput({ platform: 'lazada', legalEntityId }));
      expect(connected.status).toBe(200);
      ids.push(String(connected.body.id));
    }
    const before = (await files()).length;
    // The same platform serves the same orders, yet neither poll is taken for a repeat of the other: the bytes carry the connection.
    expect(await poll(ids[0] as string)).toEqual({ state: 'ok', orders: 3, staged: true });
    expect(await poll(ids[1] as string)).toEqual({ state: 'ok', orders: 3, staged: true });
    const added = (await files()).slice(before);
    expect(added).toHaveLength(2);
    const owners = await rows<{ filename: string; upload_entity_id: string }>(`SELECT filename, upload_entity_id FROM crove_kernel.file WHERE org_id = $1 AND filename LIKE ANY ($2::text[]) ORDER BY upload_entity_id`, [orgId, ids.map((id) => `%${id}%`)]);
    expect(owners.map((f) => f.upload_entity_id).sort()).toEqual([...entityIds].sort());
    for (const f of added) expect(await readMarketplaceFile({ runtime: worker, store, extract }, orgId, f.id)).toEqual({ handled: true });
    // The reader recognises the profile through the connection row, and each connection counts only its own file.
    const rowsStaged = (await staged()).filter((s) => added.some((f) => f.id === s.fileId));
    expect(rowsStaged).toHaveLength(2);
    for (const s of rowsStaged) expect(s.summary).toMatchObject({ platform: 'lazada', orders: 3, lines: 5 });
    const list = (await call('connections/list', owner)).body as Array<{ id: string; ordersWaiting: number }>;
    for (const id of ids) expect(list.find((c) => c.id === id)?.ordersWaiting).toBe(3);
  });

  it('writes nothing when a poll changes nothing the row holds: the sweep leaves no audit row for an idle connection', async () => {
    const entry = await connection('shopee');
    const recorded = () => count("SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.marketplace_connection.record_poll' AND target_id = $2", [orgId, entry.id]);
    const at = (await connection('shopee')).lastPolledAt;
    const before = await recorded();
    for (let i = 0; i < 3; i += 1) expect(await poll(entry.id)).toEqual({ state: 'ok', orders: 0, staged: false });
    expect(await recorded()).toBe(before);
    expect((await connection('shopee')).lastPolledAt).toBe(at);
    // A change is recorded: another state, and then the same state again is not.
    const failing: MarketplaceProvider = {
      ...createSandboxMarketplaceProvider(),
      async listOrders() {
        throw new MarketplaceProviderError('rate_limited');
      },
    };
    expect(await poll(entry.id, { sandbox: failing })).toEqual({ state: 'rate_limited', orders: 0, staged: false });
    expect(await recorded()).toBe(before + 1);
    expect(await poll(entry.id, { sandbox: failing })).toEqual({ state: 'rate_limited', orders: 0, staged: false });
    expect(await recorded()).toBe(before + 1);
    expect(await poll(entry.id)).toEqual({ state: 'ok', orders: 0, staged: false });
    expect(await recorded()).toBe(before + 2);
  });

  it('turns any other error of a provider into the unreachable state without keeping or logging its text, and names an order a layout cannot carry', async () => {
    const entry = await connection('lazada');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const broken: MarketplaceProvider = {
        ...createSandboxMarketplaceProvider(),
        async listOrders() {
          throw new Error(`socket hang up at https://secret.example.test/?token=${PLANTED}`);
        },
      };
      await rows("UPDATE crove_finance.marketplace_connection SET last_poll_state = 'ok' WHERE org_id = $1 AND id = $2", [orgId, entry.id]);
      expect(await poll(entry.id, { sandbox: broken })).toEqual({ state: 'unreachable', orders: 0, staged: false });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(PLANTED);
    } finally {
      warn.mockRestore();
    }
    // A fractional quantity on a platform with a row for each unit: the order is left out and the poll says so, the others are staged.
    const fractional: MarketplaceProvider = {
      ...createSandboxMarketplaceProvider(),
      async listOrders(_secret, _platform, since) {
        if (since !== null) return { orders: [], nextCursor: since };
        const line = (n: string, quantity: string) => ({ lineKey: `${n}-1`, sku: 'MAU-001', itemName: 'Áo', quantity, unitPrice: '100000', amount: '150000' });
        const order = (orderNo: string, quantity: string) => ({ orderNo, orderedAt: '2026-11-02', shippedAt: null, stage: 'placed' as const, lines: [line(orderNo, quantity)] });
        return { orders: [order('7000000001', '1.5'), order('7000000002', '3')], nextCursor: 'sandbox:2' };
      },
    };
    const other = await call('connections/connect', owner, connectInput({ platform: 'lazada', legalEntityId: String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh C', 'branch', $2) RETURNING id`, [orgId, owner.userId]))[0]?.id) }));
    const id = String(other.body.id);
    expect(await poll(id, { sandbox: fractional })).toEqual({ state: 'not_recognized', orders: 1, staged: true });
    expect(await cursorOf(id)).toBe('sandbox:2');
    const file = only((await files()).filter((f) => f.filename.includes(id)));
    expect(await readMarketplaceFile({ runtime: worker, store, extract }, orgId, file.id)).toEqual({ handled: true });
    expect((await staged()).find((s) => s.fileId === file.id)?.summary).toMatchObject({ platform: 'lazada', orders: 1, lines: 3 });
  });

  it('records a failed poll as a state, never the provider\'s text, and leaves the cursor and the Inbox alone', async () => {
    const entry = await connection('lazada');
    const before = await cursorOf(entry.id);
    const filesBefore = (await files()).length;
    for (const kind of ['rate_limited', 'credentials', 'unreachable'] as const) {
      const failing: MarketplaceProvider = {
        ...createSandboxMarketplaceProvider(),
        async listOrders() {
          throw Object.assign(new MarketplaceProviderError(kind), { message: `the platform said: ${PLANTED}` });
        },
      };
      expect(await poll(entry.id, { sandbox: failing })).toEqual({ state: kind, orders: 0, staged: false });
      expect((await connection('lazada')).lastPollState).toBe(kind);
    }
    expect(await cursorOf(entry.id)).toBe(before);
    expect(await files()).toHaveLength(filesBefore);
    const dump = JSON.stringify({ audit: await rows('SELECT * FROM crove_kernel.audit_event WHERE org_id = $1', [orgId]), connection: await rows('SELECT * FROM crove_finance.marketplace_connection WHERE org_id = $1', [orgId]) });
    expect(dump).not.toContain(PLANTED);
    // An adapter the deployment switched off is left alone and nothing is recorded.
    const polled = (await connection('lazada')).lastPolledAt;
    expect(await poll(entry.id, {})).toEqual({ state: 'skipped', reason: 'provider_off' });
    expect((await connection('lazada')).lastPolledAt).toBe(polled);
  });

  it('leaves a connection that is no longer active alone, and a connection that is gone', async () => {
    const connected = await call('connections/connect', owner, connectInput({ platform: 'shopee', legalEntityId: String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh sàn', 'branch', $2) RETURNING id`, [orgId, owner.userId]))[0]?.id) }));
    const id = String(connected.body.id);
    await rows("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE org_id = $1 AND id = (SELECT channel_connection_id FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2)", [orgId, id]);
    expect(await poll(id)).toEqual({ state: 'skipped', reason: 'not_active' });
    expect((await ((call('connections/list', owner))).then((r) => r.body as Array<{ id: string; lastPolledAt: string | null }>)).find((c) => c.id === id)?.lastPolledAt).toBeNull();
    expect(await poll(randomUUID())).toEqual({ state: 'skipped', reason: 'not_found' });
    // An owner cannot ask for the orders of a connection that is no longer active, nor test it.
    expect((await call('connections/pollNow', owner, { id })).body).toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
    expect((await call('connections/test', owner, { id })).body).toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
    expect((await call('connections/disconnect', owner, { id })).body).toEqual({ removed: true });
  });

  it('seals what the org types for an adapter that has fields, opens it only in the worker, and shows it nowhere: no answer, audit row, queued event, log or readable table', async () => {
    const branch = String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh bán sàn', 'branch', $2) RETURNING id`, [orgId, owner.userId]))[0]?.id);
    expect((await call('connections/connect', owner, connectInput({ legalEntityId: branch, fields: { user: 'u' } }), realApp)).body).toMatchObject({ code: 'MARKETPLACE_FIELDS' });
    expect((await call('connections/connect', owner, connectInput({ legalEntityId: branch, fields: { user: 'u', password: PLANTED, other: 'x' } }), realApp)).body).toMatchObject({ code: 'MARKETPLACE_FIELDS' });
    const connected = await call('connections/connect', owner, connectInput({ legalEntityId: branch, platform: 'lazada', fields: { user: 'ban-hang@ludy.test', password: PLANTED } }), realApp);
    expect(connected.status).toBe(200);
    expect(connected.text).not.toContain(PLANTED);
    for (const text of [(await call('connections/list', owner, undefined, realApp)).text, (await call('providers', owner, undefined, realApp)).text]) expect(text).not.toContain(PLANTED);
    // The test of an adapter reached over the network is the worker's, so the screen refuses it in words: the API never opens a credential; the same for pulling from a button.
    expect((await call('connections/test', owner, { id: connected.body.id }, realApp)).body).toMatchObject({ code: 'MARKETPLACE_PROVIDER_NOT_READY' });
    expect((await call('connections/pollNow', owner, { id: connected.body.id }, realApp)).body).toMatchObject({ code: 'MARKETPLACE_PROVIDER_NOT_READY' });
    // The worker opens the credential and hands it to the adapter alone; nothing is logged.
    const seen: string[] = [];
    const real: MarketplaceProvider = {
      ...createSandboxMarketplaceProvider(),
      hosts: ['marketplace.example.test'],
      connectFields: ['user', 'password'],
      async listOrders(secret) {
        seen.push(secret);
        return { orders: [], nextCursor: null };
      },
    };
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await poll(String(connected.body.id), { sandbox: real })).toEqual({ state: 'ok', orders: 0, staged: false });
      expect(JSON.stringify([logs.mock.calls, warns.mock.calls])).not.toContain(PLANTED);
    } finally {
      logs.mockRestore();
      warns.mockRestore();
    }
    expect(seen.map((s) => JSON.parse(s))).toEqual([{ user: 'ban-hang@ludy.test', password: PLANTED }]);
    const dump = JSON.stringify({
      audit: await rows('SELECT * FROM crove_kernel.audit_event WHERE org_id = $1', [orgId]),
      outbox: await rows('SELECT * FROM crove_kernel.outbox_event WHERE org_id = $1', [orgId]),
      idempotency: await rows('SELECT * FROM crove_kernel.idempotency_key WHERE org_id = $1', [orgId]),
      channel: await rows('SELECT * FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId]),
      activity: await rows('SELECT * FROM crove_kernel.activity WHERE org_id = $1', [orgId]),
      connection: await rows('SELECT * FROM crove_finance.marketplace_connection WHERE org_id = $1', [orgId]),
      file: await rows('SELECT * FROM crove_kernel.file WHERE org_id = $1', [orgId]),
      extraction: await rows('SELECT * FROM crove_kernel.extraction WHERE org_id = $1', [orgId]),
    });
    expect(dump).not.toContain(PLANTED);
    expect(dump).not.toContain('ban-hang@ludy.test');
    // The sealed envelope holds it, and the vault opens it for the binding it was sealed under, and for no other.
    const [credential] = await rows<{ key_id: string; envelope: Buffer }>(
      'SELECT c.key_id, c.envelope FROM crove_kernel.credential c WHERE c.org_id = $1 AND c.connection_id = (SELECT channel_connection_id FROM crove_finance.marketplace_connection WHERE org_id = $1 AND legal_entity_id = $2)',
      [orgId, branch],
    );
    expect(credential?.envelope.includes(Buffer.from(PLANTED))).toBe(false);
    const binding = { orgId, provider: 'marketplace_sandbox', externalAccountId: `${branch}:lazada` };
    const sealed = { keyId: String(credential?.key_id), envelope: credential?.envelope as Buffer };
    expect(JSON.parse(vault.open(sealed, binding))).toEqual({ user: 'ban-hang@ludy.test', password: PLANTED });
    expect(() => vault.open(sealed, { ...binding, orgId: randomUUID() })).toThrow();
    // Not in the shared channel list either: it names the entity in its account id.
    expect(JSON.stringify((await rpc('channels/list', await tokenFor(owner), {})).body)).not.toContain('marketplace_');
    expect((await call('connections/disconnect', owner, { id: connected.body.id }, realApp)).body).toEqual({ removed: true });
  });

  it('closes the connection: the credential is dropped, the row is gone, what was staged stays, and a second disconnect finds nothing', async () => {
    const { id, connectionId } = await connection('lazada');
    for (const who of [member, viewer]) expect((await call('connections/disconnect', who, { id })).status).toBe(403);
    const waiting = (await staged()).length;
    expect((await call('connections/disconnect', adminUser, { id })).body).toEqual({ removed: true });
    expect(((await call('connections/list', owner)).body as Array<{ id: string }>).map((c) => c.id)).not.toContain(id);
    expect(await rows('SELECT status FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, connectionId])).toEqual([{ status: 'revoked' }]);
    expect(await rows('SELECT 1 FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [orgId, connectionId])).toEqual([]);
    expect((await call('connections/disconnect', owner, { id })).body).toEqual({ removed: false });
    expect(await staged()).toHaveLength(waiting);
    // A poll of the closed connection asks nothing.
    expect(await poll(id)).toEqual({ state: 'skipped', reason: 'not_found' });
    // Connecting again is a new connection of the same account.
    const again = await call('connections/connect', owner, connectInput({ platform: 'lazada' }));
    expect(again.status).toBe(200);
    expect(String(again.body.id)).not.toBe(id);
  });

  it('holds the roles in SQL as the runtime\'s own login: owners and admins file a connection, members and viewers read it, and only the test and the poll columns can change', async () => {
    const entity = String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh vai trò', 'branch', $2) RETURNING id`, [orgId, owner.userId]))[0]?.id);
    const channel = randomUUID();
    await rows(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'marketplace_sandbox', $3, 'Vai trò', $4)`, [orgId, channel, `role-${randomUUID()}`, owner.userId]);
    const insertSql = 'INSERT INTO crove_finance.marketplace_connection (org_id, legal_entity_id, channel_connection_id, provider, platform) VALUES ($1, $2, $3, $4, $5) RETURNING id';
    async function asRole<T>(who: Account, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, who.userId, orgId);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
    for (const who of [member, viewer]) await expect(asRole(who, (c) => c.query(insertSql, [orgId, entity, channel, 'marketplace_sandbox', 'shopee']))).rejects.toMatchObject({ code: '42501' });
    expect(await asRole(adminUser, async (c) => (await c.query(insertSql, [orgId, entity, channel, 'marketplace_sandbox', 'shopee'])).rowCount)).toBe(1);
    const id = String((await rows<{ id: string }>(insertSql, [orgId, entity, channel, 'marketplace_sandbox', 'shopee']))[0]?.id);
    for (const who of [member, viewer, adminUser, owner]) expect(await asRole(who, async (c) => (await c.query('SELECT 1 FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2', [orgId, id])).rowCount)).toBe(1);
    const setPoll = "UPDATE crove_finance.marketplace_connection SET last_test_state = 'works', last_tested_at = now(), poll_cursor = 'c1', last_polled_at = now(), last_poll_state = 'ok' WHERE org_id = $1 AND id = $2";
    for (const who of [member, viewer]) {
      expect(await asRole(who, async (c) => (await c.query(setPoll, [orgId, id])).rowCount)).toBe(0);
      expect(await asRole(who, async (c) => (await c.query('DELETE FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2', [orgId, id])).rowCount)).toBe(0);
    }
    for (const who of [adminUser, owner]) {
      expect(await asRole(who, async (c) => (await c.query(setPoll, [orgId, id])).rowCount)).toBe(1);
      for (const column of ["platform = 'lazada'", "provider = 'marketplace_other'", `legal_entity_id = '${randomUUID()}'`, `channel_connection_id = '${randomUUID()}'`, 'created_at = now()']) {
        await expect(asRole(who, (c) => c.query(`UPDATE crove_finance.marketplace_connection SET ${column} WHERE org_id = $1 AND id = $2`, [orgId, id]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
      }
    }
    expect(await asRole(adminUser, async (c) => (await c.query('DELETE FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2', [orgId, id])).rowCount)).toBe(1);
    await rows('DELETE FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2', [orgId, id]);
  });

  it('holds the row rules in SQL: the provider is the channel connection\'s, the shapes are checked, and an account is connected once', async () => {
    const entity = String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh quy tắc', 'branch', $2) RETURNING id`, [orgId, owner.userId]))[0]?.id);
    const channelId = randomUUID();
    await rows(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'marketplace_sandbox', $3, 'Thử', $4)`, [orgId, channelId, `guard-${randomUUID()}`, owner.userId]);
    const insert = (provider: string, platform: string, channel = channelId) =>
      rows('INSERT INTO crove_finance.marketplace_connection (org_id, legal_entity_id, channel_connection_id, provider, platform) VALUES ($1, $2, $3, $4, $5)', [orgId, entity, channel, provider, platform]);
    await expect(insert('marketplace_misa', 'shopee')).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('MARKETPLACE_CONNECTION_PROVIDER') });
    await expect(insert('sandbox', 'shopee')).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('MARKETPLACE_CONNECTION_PROVIDER') });
    await expect(insert('marketplace_sandbox', 'amazon')).rejects.toMatchObject({ code: '23514' });
    await insert('marketplace_sandbox', 'shopee');
    const { id } = only(await rows<{ id: string }>('SELECT id FROM crove_finance.marketplace_connection WHERE org_id = $1 AND channel_connection_id = $2', [orgId, channelId]));
    // One connection per channel connection, and one per entity, adapter and platform.
    await expect(insert('marketplace_sandbox', 'lazada')).rejects.toMatchObject({ code: '23505' });
    const second = randomUUID();
    await rows(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'marketplace_sandbox', $3, 'Thử hai', $4)`, [orgId, second, `guard-${randomUUID()}`, owner.userId]);
    await expect(insert('marketplace_sandbox', 'shopee', second)).rejects.toMatchObject({ code: '23505' });
    // The test state and its time go together, from the list of states only; the poll's state and counts likewise.
    await expect(rows("UPDATE crove_finance.marketplace_connection SET last_test_state = 'works' WHERE org_id = $1 AND id = $2", [orgId, id])).rejects.toMatchObject({ code: '23514' });
    await expect(rows("UPDATE crove_finance.marketplace_connection SET last_test_state = 'broken', last_tested_at = now() WHERE org_id = $1 AND id = $2", [orgId, id])).rejects.toMatchObject({ code: '23514' });
    await expect(rows("UPDATE crove_finance.marketplace_connection SET last_poll_state = 'broken' WHERE org_id = $1 AND id = $2", [orgId, id])).rejects.toMatchObject({ code: '23514' });
    await expect(rows('UPDATE crove_finance.marketplace_connection SET orders_waiting = -1 WHERE org_id = $1 AND id = $2', [orgId, id])).rejects.toMatchObject({ code: '23514' });
    await expect(rows('UPDATE crove_finance.marketplace_connection SET poll_cursor = $3 WHERE org_id = $1 AND id = $2', [orgId, id, 'x'.repeat(201)])).rejects.toMatchObject({ code: '23514' });
    await rows('DELETE FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2', [orgId, id]);
  });

  it('lists the connections of active orgs for the worker\'s sweep, to the worker login alone', async () => {
    const due = await workerPool.query<{ org_id: string; id: string; provider: string }>('SELECT org_id, id, provider FROM crove_finance.marketplace_poll_due(NULL, NULL, 100) WHERE org_id = $1', [orgId]);
    expect(due.rows.length).toBeGreaterThan(0);
    expect(due.rows.every((r) => r.provider === 'marketplace_sandbox')).toBe(true);
    await expect(pool.query('SELECT * FROM crove_finance.marketplace_poll_due(NULL, NULL, 100)')).rejects.toMatchObject({ code: '42501' });
  });
});

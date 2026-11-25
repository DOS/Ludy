// SPDX-License-Identifier: AGPL-3.0-only
// An entity's connection to MISA AMIS Kế toán (#3875, S2 of #3854), on a real PostgreSQL 17 through the HTTP API: the connector is offered only when the deployment holds the integrator's ClientID,
// connect (the access code sealed at the edge, no secret in any answer, audit row or stored row), who may do what, one connection per entity (a second connect is the same connection), the
// opaque code AMIS is told (random, unique, never in an answer), disconnect (the sealed code dropped with the connection), and the database's own guards.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { AmisError, createAmisClient, type AmisRequest, type AmisResponse } from '@ludy/misa-amis';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runMisaAmisTest } from '../src/misa-amis-test-job.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-misa-amis-connections-0123456789';
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

// A planted access code: nothing the API answers, audits, queues or stores in a readable table may carry it.
const PLANTED = `planted-access-code-${randomBytes(6).toString('hex')}`;
const CODE = /^ludy-[0-9a-f]{32}$/;

const suite = ADMIN ? describe : describe.skip;

suite('MISA AMIS connections (#3875)', () => {
  afterEach(() => vi.restoreAllMocks());
  const dbName = `ludy_test_misa_amis_conn_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  // The worker's runtime (the system actor of the test job) and the one the API uses.
  let worker: Runtime;
  let api: Runtime;
  let vault: CredentialVault;
  // The deployment that holds the integrator's ClientID, and one that does not.
  let app: ReturnType<typeof createHttpApp>;
  let offApp: ReturnType<typeof createHttpApp>;
  // The deployment that also turned the push on (MISA_AMIS_PUSH=on), as against `app`, which holds the ClientID but not the switch.
  let pushApp: ReturnType<typeof createHttpApp>;
  // ASP's push on and AMIS's off, and the other way round (#4113): each product has a switch of its own.
  let aspPushApp: ReturnType<typeof createHttpApp>;
  let amisOnlyPushApp: ReturnType<typeof createHttpApp>;
  // The deployment that also holds the ClientID of MISA ASP (#4111), and one that holds only that one.
  let aspApp: ReturnType<typeof createHttpApp>;
  let aspOnlyApp: ReturnType<typeof createHttpApp>;
  const owner: Account = { subject: randomUUID(), email: 'owner@misa-amis-conn.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@misa-amis-conn.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@misa-amis-conn.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@misa-amis-conn.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@misa-amis-conn.test', session: randomUUID(), userId: '' };
  let slug = '';
  let orgId = '';
  let otherSlug = '';
  let otherOrgId = '';

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
  const call = async (path: string, who: Account, input?: unknown, on: ReturnType<typeof createHttpApp> = app, org: string | null = slug) => rpc(`misaAmis/${path}`, await tokenFor(who), input, org, on);
  const connectInput = (extra: Record<string, unknown> = {}) => ({ legalEntityId: null, accessCode: PLANTED, ...extra });
  const asUser = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const defaultEntity = async (org = orgId) => String((await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [org]))[0]?.id);

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
    const register = (target: ReturnType<typeof createDb>, sessions = false) =>
      new Runtime(target, { manifests: TEST_MANIFESTS, ...(sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' as const } : {}) }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    const runtime = register(db, true);
    api = runtime;
    worker = register(createDb(workerPool));
    const config = loadConfig({ DATABASE_URL: login('ludy_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const deps = { config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    app = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false, misaAmis: true } });
    offApp = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false } });
    pushApp = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false, misaAmis: true, misaAmisPush: true } });
    aspApp = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false, misaAmis: true, misaAsp: true } });
    aspPushApp = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false, misaAmis: true, misaAsp: true, misaAspPush: true } });
    amisOnlyPushApp = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false, misaAmis: true, misaAsp: true, misaAmisPush: true } });
    aspOnlyApp = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false, misaAsp: true } });

    for (const who of [owner, adminUser, member, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Kế toán AMIS', idempotencyKey: randomUUID() }, null);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser.userId, member.userId, viewer.userId]);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherSlug = String(other.body?.slug);
    otherOrgId = String(other.body?.orgId);
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

  it('is offered only where the deployment holds the integrator\'s ClientID, and refuses a connect anywhere else before anything is sealed', async () => {
    expect((await call('status', member)).body).toEqual({ offered: true, pushOffered: false, aspOffered: false, aspPushOffered: false });
    expect((await call('status', member, undefined, offApp)).body).toEqual({ offered: false, pushOffered: false, aspOffered: false, aspPushOffered: false });
    expect((await call('status', member, undefined, pushApp)).body).toEqual({ offered: true, pushOffered: true, aspOffered: false, aspPushOffered: false });
    await expect(call('connections/connect', owner, connectInput(), offApp)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_DISABLED' } });
    expect(await rows('SELECT 1 FROM ludy_kernel.channel_connection WHERE org_id = $1', [orgId])).toEqual([]);
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_connection WHERE org_id = $1', [orgId])).toEqual([]);
  });

  it('connects for an owner or admin only, seals the access code, and shows every member the connection with no secret', async () => {
    for (const who of [member, viewer]) expect((await call('connections/connect', who, connectInput())).status).toBe(403);
    expect((await call('connections/connect', owner, connectInput({ accessCode: '   ' }))).status).toBeGreaterThanOrEqual(400);
    const connected = await call('connections/connect', adminUser, connectInput());
    expect(connected.status).toBe(200);
    const id = String(connected.body.id);
    expect(connected.text).not.toContain(PLANTED);
    for (const who of [owner, adminUser, member, viewer]) {
      const list = await call('connections/list', who);
      expect(list.status).toBe(200);
      expect(list.text).not.toContain(PLANTED);
      expect(list.body).toEqual([expect.objectContaining({ id, product: 'amis', status: 'active', legalEntityId: await defaultEntity(), displayName: 'MISA AMIS Kế toán', connectedAt: expect.any(String) })]);
      // Neither the code nor the opaque code AMIS is told is in the answer.
      expect(JSON.stringify(list.body)).not.toMatch(/ludy-[0-9a-f]{32}/);
    }
    // The channel connection exists under the provider and holds a credential that is sealed: the planted code is in no readable column.
    const channel = (await rows<{ id: string; provider: string; external_account_id: string; status: string }>('SELECT id, provider, external_account_id, status FROM ludy_kernel.channel_connection WHERE org_id = $1', [orgId]))[0];
    expect(channel).toMatchObject({ provider: 'accounting_misa_amis', external_account_id: await defaultEntity(), status: 'active' });
    const [credential] = await rows<{ key_id: string; envelope: Buffer }>('SELECT key_id, envelope FROM ludy_kernel.credential WHERE org_id = $1 AND connection_id = $2', [orgId, channel?.id]);
    expect(credential?.envelope.includes(Buffer.from(PLANTED))).toBe(false);
    // The vault opens it for the binding it was sealed under (the access code as typed), and for no other org.
    const binding = { orgId, provider: 'accounting_misa_amis', externalAccountId: await defaultEntity() };
    const envelope = { keyId: String(credential?.key_id), envelope: credential?.envelope as Buffer };
    expect(vault.open(envelope, binding)).toBe(PLANTED);
    expect(() => vault.open(envelope, { ...binding, orgId: randomUUID() })).toThrow();
    // Nothing readable anywhere carries the code: the audit rows, the outbox, the connection rows.
    for (const table of ['ludy_kernel.audit_event', 'ludy_kernel.outbox_event', 'ludy_kernel.channel_connection', 'ludy_finance.misa_amis_connection']) {
      const hit = await rows(`SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t::text LIKE '%' || $2 || '%'`, [orgId, PLANTED]);
      expect(hit, table).toEqual([]);
    }
    // The audit row of the connect names the entity and the channel connection and nothing of the code.
    const audit = await rows<{ command: string }>("SELECT command FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.misa_amis_connection.connect'", [orgId]);
    expect(audit.length).toBeGreaterThan(0);
    // The company code MISA is given is a stable name of the org, not a secret, but it belongs to the connection row alone: no audit or outbox row repeats it.
    const [stored] = await rows<{ org_company_code: string }>('SELECT org_company_code FROM ludy_finance.misa_amis_connection WHERE org_id = $1', [orgId]);
    expect(stored?.org_company_code).toMatch(/^ludy-[0-9a-f]{32}$/);
    for (const table of ['ludy_kernel.audit_event', 'ludy_kernel.outbox_event']) {
      const hit = await rows(`SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t::text LIKE '%' || $2 || '%'`, [orgId, stored?.org_company_code]);
      expect(hit, table).toEqual([]);
    }
  });

  it('files one connection per entity: a second connect is the same connection, and another org gets its own', async () => {
    const before = await call('connections/list', owner);
    const again = await call('connections/connect', owner, connectInput({ accessCode: `${PLANTED}-again` }));
    expect(again.status).toBe(200);
    expect(again.body.id).toBe((before.body as Array<{ id: string }>)[0]?.id);
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_connection WHERE org_id = $1', [orgId])).toHaveLength(1);
    const theirs = await call('connections/connect', outsider, connectInput(), app, otherSlug);
    expect(theirs.status).toBe(200);
    // Each org sees only its own.
    expect(((await call('connections/list', outsider, undefined, app, otherSlug)).body as unknown[]).length).toBe(1);
    expect(((await call('connections/list', owner)).body as unknown[]).length).toBe(1);
  });

  it('tells AMIS an opaque code of its own for each connection: random, in the shape, unique across orgs, and never given to a tenant to change', async () => {
    const codes = await rows<{ org_id: string; org_company_code: string }>('SELECT org_id, org_company_code FROM ludy_finance.misa_amis_connection ORDER BY created_at');
    expect(codes).toHaveLength(2);
    for (const row of codes) expect(row.org_company_code).toMatch(CODE);
    expect(new Set(codes.map((c) => c.org_company_code)).size).toBe(2);
    expect(codes.map((c) => c.org_id).sort()).toEqual([orgId, otherOrgId].sort());
    // A code outside the shape is refused by the database, and a duplicate too.
    await expect(rows("UPDATE ludy_finance.misa_amis_connection SET org_company_code = 'not-a-code' WHERE org_id = $1", [orgId])).rejects.toThrow();
    await expect(rows('UPDATE ludy_finance.misa_amis_connection SET org_company_code = $1 WHERE org_id = $2', [codes[1]?.org_company_code, orgId])).rejects.toThrow(/misa_amis_connection_code_uq/);
    // A tenant role never types the code or a test result: as the owner of the org (through the sealed context, as the tenant role) an INSERT that names both is stored with a fresh code and no result.
    const typed = 'ludy-' + '0'.repeat(32);
    const stored = await admin(async (c) => {
      await c.query('BEGIN');
      try {
        // An entity and a channel connection of its own, made as the admin connection and rolled back with the rest.
        const entity = randomUUID();
        const channel = randomUUID();
        await c.query("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh thử mã', 'branch', $3)", [orgId, entity, owner.userId]);
        await c.query("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'accounting_misa_amis', $3, 'AMIS thử', $4)", [orgId, channel, `a-${entity}`, owner.userId]);
        await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner.userId, orgId)]);
        await c.query('SET LOCAL ROLE ludy_tenant');
        const { rows: inserted } = await c.query<{ org_company_code: string; last_test_state: string | null; last_tested_at: Date | null }>(
          "INSERT INTO ludy_finance.misa_amis_connection (org_id, legal_entity_id, channel_connection_id, org_company_code, last_test_state, last_tested_at) VALUES ($1, $2, $3, $4, 'works', pg_catalog.now()) RETURNING org_company_code, last_test_state, last_tested_at",
          [orgId, entity, channel, typed],
        );
        return inserted[0] ?? null;
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(stored?.org_company_code).not.toBe(typed);
    expect(stored?.org_company_code).toMatch(CODE);
    expect(stored?.last_test_state).toBeNull();
    expect(stored?.last_tested_at).toBeNull();
  });

  it('refuses, in the database, a row filed on a channel connection of another provider', async () => {
    const entity = randomUUID();
    const channel = randomUUID();
    await rows("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh thử', 'branch', $3)", [orgId, entity, owner.userId]);
    await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'marketplace_sandbox', $3, 'Sàn thử', $4)", [orgId, channel, `m-${entity}`, owner.userId]);
    await expect(rows('INSERT INTO ludy_finance.misa_amis_connection (org_id, legal_entity_id, channel_connection_id) VALUES ($1, $2, $3)', [orgId, entity, channel])).rejects.toThrow(/MISA_AMIS_CONNECTION_PROVIDER/);
  });

  // A fake AMIS: it knows the integrator's ClientID, the access code the connection was last made with and the connection's company code, and answers the way MISA documents.
  const CLIENT_ID = 'planted-integrator-client-id-0123';
  const fakeAmis = (accessCode: string, orgCompanyCode: string, force: (path: string) => AmisResponse | Promise<AmisResponse> | undefined = () => undefined) => {
    const seen: Array<{ path: string; accessCode?: unknown }> = [];
    const ok = (data: unknown): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: true, ErrorMessage: '', Data: data }) });
    const refuse = (code: string): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: false, ErrorCode: code, ErrorMessage: `planted AMIS text ${accessCode}` }) });
    const transport = async (request: AmisRequest): Promise<AmisResponse> => {
      const path = new URL(request.url).pathname.replace(/^\/apis/, '');
      const body = JSON.parse(request.body) as Record<string, unknown>;
      seen.push({ path, accessCode: body.access_code });
      const forced = await force(path);
      if (forced) return forced;
      if (request.headers.ClientID !== CLIENT_ID) return refuse('InvalidAPPID');
      if (path === '/amiskt/v1/token') return body.access_code === accessCode && body.org_company_code === orgCompanyCode ? ok({ access_token: 'tok-1' }) : refuse('InvalidAccessToken');
      if (request.headers['X-MISA-AccessToken'] !== 'tok-1') return refuse('InvalidToken');
      return path === '/amiskt/v1/get_company_info' ? ok({ company_name: 'Công ty thử' }) : refuse('InvalidParam');
    };
    return { seen, client: createAmisClient({ clientId: CLIENT_ID, transport }) };
  };
  const system = { type: 'system' as const, component: 'finance.misa_amis' };

  it('asks for a test for an owner or admin only, queues it as an event with ids only, and refuses where the connector is off, for another org and for a connection that is gone', async () => {
    const [listed] = (await call('connections/list', owner)).body as Array<{ id: string }>;
    const id = String(listed?.id);
    for (const who of [member, viewer]) expect((await call('connections/test', who, { id })).status).toBe(403);
    await expect(call('connections/test', owner, { id }, offApp)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_DISABLED' } });
    // Another org's owner cannot reach it.
    expect((await call('connections/test', outsider, { id }, app, otherSlug)).body).toMatchObject({ code: 'MISA_AMIS_CONNECTION_NOT_FOUND' });
    expect((await call('connections/test', owner, { id: randomUUID() })).body).toMatchObject({ code: 'MISA_AMIS_CONNECTION_NOT_FOUND' });
    expect(await rows("SELECT 1 FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.misa_amis_connection.test_requested'", [orgId])).toEqual([]);
    for (const who of [owner, adminUser]) expect((await call('connections/test', who, { id })).body).toEqual({ queued: true });
    const events = await rows<{ payload: Record<string, unknown> }>("SELECT payload FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.misa_amis_connection.test_requested'", [orgId]);
    expect(events).toEqual([{ payload: { connection_id: id } }, { payload: { connection_id: id } }]);
    // The event and the audit row carry ids: not the access code, the company code or the ClientID.
    const [stored] = await rows<{ org_company_code: string }>('SELECT org_company_code FROM ludy_finance.misa_amis_connection WHERE org_id = $1', [orgId]);
    for (const table of ['ludy_kernel.audit_event', 'ludy_kernel.outbox_event']) {
      for (const secret of [PLANTED, stored?.org_company_code, CLIENT_ID]) expect(await rows(`SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t::text LIKE '%' || $2 || '%'`, [orgId, secret]), `${table} ${secret}`).toEqual([]);
    }
  });

  it('gates the confirm route behind the push switch (404 before anything is read), and lets every member read the pushed rows while an owner or admin alone settles one', async () => {
    const [listed] = (await call('connections/list', owner)).body as Array<{ id: string }>;
    const id = String(listed?.id);
    const confirm = { kind: 'cash_payment', connectionId: id, digest: 'a'.repeat(64) };
    const vouchers = async (who: Account, on: ReturnType<typeof createHttpApp>) => rpc('vouchers/misaAmisPush', await tokenFor(who), confirm, slug, on);
    // Switch off (the ClientID alone is not enough) or no connector at all: the route is a 404 for everyone, an owner included.
    for (const on of [app, offApp]) await expect(vouchers(owner, on)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_PUSH_DISABLED' } });
    // The switch is read before membership: someone who is not a member of the org gets the same 404, not a 403 that tells the org exists.
    await expect(vouchers(outsider, app)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_PUSH_DISABLED' } });
    // Switch on: a member or viewer is refused by role, an owner reaches the command (the connection was not tested here, so it says so and queues nothing).
    for (const who of [member, viewer]) expect((await vouchers(who, pushApp)).status).toBe(403);
    await expect(vouchers(owner, pushApp)).resolves.toMatchObject({ status: 409, body: { code: 'MISA_AMIS_NOT_TESTED' } });
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_push WHERE org_id = $1', [orgId])).toEqual([]);
    // Rows already pushed stay readable by every member whatever the switch says (nothing is sent by a read), and another org's user cannot read them.
    for (const on of [app, offApp, pushApp]) for (const who of [owner, adminUser, member, viewer]) await expect(call('pushes/list', who, { connectionId: id }, on)).resolves.toMatchObject({ status: 200, body: [] });
    expect((await call('pushes/list', outsider, { connectionId: id }, app, slug)).status).toBe(403);
    // Settling a row is an owner's or admin's: a member is refused by role; an owner asking for a row that is not there is told the row cannot be settled.
    const settle = { connectionId: id, orgRefid: randomUUID(), outcome: 'in_amis' };
    for (const who of [member, viewer]) expect((await call('pushes/resolve', who, settle)).status).toBe(403);
    await expect(call('pushes/resolve', owner, settle)).resolves.toMatchObject({ status: 409, body: { code: 'MISA_AMIS_PUSH_STATE' } });
  });

  it('runs the test as the worker against AMIS: opens the sealed code, records only a state and a time that every member then reads, and keeps AMIS\'s text, the code and the ClientID out of every row', async () => {
    const [listed] = (await call('connections/list', owner)).body as Array<{ id: string; lastTestState: string | null; lastTestedAt: string | null }>;
    const id = String(listed?.id);
    expect(listed).toMatchObject({ lastTestState: null, lastTestedAt: null });
    const [stored] = await rows<{ org_company_code: string }>('SELECT org_company_code FROM ludy_finance.misa_amis_connection WHERE org_id = $1', [orgId]);
    const company = String(stored?.org_company_code);
    // The access code is the one the connection was last made with (the second connect of the entity replaced the first).
    const code = `${PLANTED}-again`;
    const run = (amis: ReturnType<typeof fakeAmis>) => runMisaAmisTest({ runtime: worker, broker: vault, client: amis.client }, { orgId, connectionId: id });
    const read = async (who: Account = member) => ((await call('connections/list', who)).body as Array<{ lastTestState: string | null; lastTestedAt: string | null }>)[0];
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const good = fakeAmis(code, company);
    expect(await run(good)).toEqual({ state: 'works' });
    expect(good.seen.map((c) => c.path)).toEqual(['/amiskt/v1/token', '/amiskt/v1/get_company_info']);
    expect(good.seen[0]?.accessCode).toBe(code);
    const first = await read();
    expect(first).toMatchObject({ lastTestState: 'works', lastTestedAt: expect.any(String) });

    // AMIS refuses the code: a state a person can act on, and the time moves.
    expect(await run(fakeAmis('another-code', company))).toEqual({ state: 'wrong_credentials' });
    const second = await read(viewer);
    expect(second).toMatchObject({ lastTestState: 'wrong_credentials' });
    expect(new Date(String(second?.lastTestedAt)).getTime()).toBeGreaterThanOrEqual(new Date(String(first?.lastTestedAt)).getTime());

    // AMIS cannot be reached.
    expect(await run(fakeAmis(code, company, () => Promise.reject(new AmisError('timeout'))))).toEqual({ state: 'unreachable' });
    expect(await read()).toMatchObject({ lastTestState: 'unreachable' });
    expect(await run(fakeAmis(code, company, () => ({ status: 503, body: 'planted gateway text' })))).toEqual({ state: 'unreachable' });

    // Back to working: the row follows the last test.
    expect(await run(good)).toEqual({ state: 'works' });
    expect(await read()).toMatchObject({ lastTestState: 'works' });

    // Only a state and a time: the audit rows of the test name the state and nothing else, and no row anywhere carries the code, the company code, the ClientID or AMIS's text.
    const audits = await rows<{ detail: unknown }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.misa_amis_connection.record_test' AND outcome = 'ok'", [orgId]);
    expect(audits).toHaveLength(5);
    // The runtime adds the actor's component (and the worker's instance) to every audit detail; what the command adds is the state alone.
    const own = (detail: unknown) => Object.fromEntries(Object.entries(detail as Record<string, unknown>).filter(([key]) => key !== 'component' && key !== 'workerInstance'));
    for (const a of audits) expect(Object.keys(own(a.detail))).toEqual(['state']);
    expect(audits.map((a) => (own(a.detail) as { state: string }).state).sort()).toEqual(['unreachable', 'unreachable', 'works', 'works', 'wrong_credentials']);
    for (const table of ['ludy_kernel.audit_event', 'ludy_kernel.outbox_event', 'ludy_kernel.channel_connection', 'ludy_finance.misa_amis_connection']) {
      for (const secret of [PLANTED, company, CLIENT_ID, 'planted AMIS text', 'planted gateway text']) {
        // The connection row holds its own company code, which is the one thing here that may be in it.
        if (table === 'ludy_finance.misa_amis_connection' && secret === company) continue;
        expect(await rows(`SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t::text LIKE '%' || $2 || '%'`, [orgId, secret]), `${table} ${secret}`).toEqual([]);
      }
    }
  });

  it('lets only the system record or read a test: a user, even an owner, is refused both', async () => {
    const [listed] = (await call('connections/list', owner)).body as Array<{ id: string }>;
    const id = String(listed?.id);
    const user = asUser(owner);
    await expect(api.execute('finance.misa_amis_connection.record_test', { id, state: 'works' }, { actor: user, orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(api.query('finance.misa_amis_connection.test_target', { id }, { actor: user, orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The system reads the target of this org's connection, and of no other org's.
    expect(await worker.query('finance.misa_amis_connection.test_target', { id }, { actor: system, orgId })).toMatchObject({ action: 'test', id });
    expect(await worker.query('finance.misa_amis_connection.test_target', { id }, { actor: system, orgId: otherOrgId })).toEqual({ action: 'none', reason: 'not_found' });
    // A state outside the three is refused before it is written.
    await expect(worker.execute('finance.misa_amis_connection.record_test', { id, state: 'maybe' }, { actor: system, orgId })).rejects.toThrow();
  });

  it('refuses a test of a connection that is no longer live, and the worker leaves it alone', async () => {
    const [listed] = (await call('connections/list', owner)).body as Array<{ id: string; connectionId: string }>;
    const id = String(listed?.id);
    await rows("UPDATE ludy_kernel.channel_connection SET status = 'expired' WHERE org_id = $1 AND id = $2", [orgId, listed?.connectionId]);
    try {
      expect((await call('connections/test', owner, { id })).body).toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
      expect(await runMisaAmisTest({ runtime: worker, broker: vault, client: fakeAmis('x', 'y').client }, { orgId, connectionId: id })).toEqual({ state: 'skipped', reason: 'not_active' });
    } finally {
      await rows("UPDATE ludy_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = $2", [orgId, listed?.connectionId]);
    }
  });

  it('disconnects for an owner or admin only, dropping the sealed access code with the connection, and a viewer or another org cannot', async () => {
    const [listed] = (await call('connections/list', owner)).body as Array<{ id: string; connectionId: string }>;
    for (const who of [member, viewer]) expect((await call('connections/disconnect', who, { id: listed?.id })).status).toBe(403);
    // Another org's owner cannot reach it.
    expect((await call('connections/disconnect', outsider, { id: listed?.id }, app, otherSlug)).body).toEqual({ removed: false });
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_connection WHERE org_id = $1', [orgId])).toHaveLength(1);
    expect((await call('connections/disconnect', owner, { id: listed?.id })).body).toEqual({ removed: true });
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_connection WHERE org_id = $1', [orgId])).toEqual([]);
    expect(await rows('SELECT 1 FROM ludy_kernel.credential WHERE org_id = $1 AND connection_id = $2', [orgId, listed?.connectionId])).toEqual([]);
    expect((await rows<{ status: string }>('SELECT status FROM ludy_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, listed?.connectionId]))[0]?.status).toBe('revoked');
    expect(((await call('connections/list', owner)).body as unknown[]).length).toBe(0);
    // A connection that is gone is left alone by a test: nothing is asked, and the request is refused.
    expect((await call('connections/test', owner, { id: listed?.id })).body).toMatchObject({ code: 'MISA_AMIS_CONNECTION_NOT_FOUND' });
    expect(await runMisaAmisTest({ runtime: worker, broker: vault, client: fakeAmis('x', 'y').client }, { orgId, connectionId: String(listed?.id) })).toEqual({ state: 'skipped', reason: 'not_found' });
    // A second disconnect of nothing is a plain no.
    expect((await call('connections/disconnect', owner, { id: listed?.id })).body).toEqual({ removed: false });
    // A reconnect is a new connection with a new code.
    const reconnected = await call('connections/connect', owner, connectInput());
    expect(reconnected.status).toBe(200);
    expect(reconnected.body.id).not.toBe(listed?.id);
  });
  // MISA ASP (#4111, S2 of #4103): the same connection table with a product. The access code is sealed under ASP's own provider id, a legal entity is on one product, the database holds the
  // provider to the product, and the worker's test and the push each take the connection's product into account.
  const ASP_CODE = `planted-asp-code-${randomBytes(6).toString('hex')}`;
  const newEntity = async (name: string) => {
    const id = randomUUID();
    await rows("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, $3, 'branch', $4)", [orgId, id, name, owner.userId]);
    return id;
  };

  it('offers MISA ASP only where the deployment holds its own ClientID, and refuses a connect of a product the deployment does not hold before anything is sealed', async () => {
    expect((await call('status', member, undefined, aspApp)).body).toEqual({ offered: true, pushOffered: false, aspOffered: true, aspPushOffered: false });
    expect((await call('status', member, undefined, aspOnlyApp)).body).toEqual({ offered: false, pushOffered: false, aspOffered: true, aspPushOffered: false });
    const entity = await newEntity('Chi nhánh chưa bật ASP');
    await expect(call('connections/connect', owner, connectInput({ legalEntityId: entity, product: 'asp', accessCode: ASP_CODE }), app)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_DISABLED' } });
    await expect(call('connections/connect', owner, connectInput({ legalEntityId: entity, accessCode: ASP_CODE }), aspOnlyApp)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_DISABLED' } });
    expect(await rows('SELECT 1 FROM ludy_kernel.channel_connection WHERE org_id = $1 AND external_account_id = $2', [orgId, entity])).toEqual([]);
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND legal_entity_id = $2', [orgId, entity])).toEqual([]);
  });

  it('connects an ASP entity: the code is sealed under accounting_misa_asp and opens for no other provider, the product is in the list, and an entity is on one product only', async () => {
    const entity = await newEntity('Chi nhánh ASP');
    const connected = await call('connections/connect', adminUser, connectInput({ legalEntityId: entity, product: 'asp', accessCode: ASP_CODE }), aspOnlyApp);
    expect(connected.status).toBe(200);
    expect(connected.text).not.toContain(ASP_CODE);
    const id = String(connected.body.id);
    const listed = ((await call('connections/list', member)).body as Array<Record<string, unknown>>).find((c) => c.id === id);
    expect(listed).toMatchObject({ product: 'asp', displayName: 'MISA ASP', status: 'active', legalEntityId: entity });
    expect(JSON.stringify(listed)).not.toContain(ASP_CODE);
    const [channel] = await rows<{ id: string; provider: string }>('SELECT id, provider FROM ludy_kernel.channel_connection WHERE org_id = $1 AND external_account_id = $2', [orgId, entity]);
    expect(channel?.provider).toBe('accounting_misa_asp');
    const [credential] = await rows<{ key_id: string; envelope: Buffer }>('SELECT key_id, envelope FROM ludy_kernel.credential WHERE org_id = $1 AND connection_id = $2', [orgId, channel?.id]);
    expect(credential?.envelope.includes(Buffer.from(ASP_CODE))).toBe(false);
    const envelope = { keyId: String(credential?.key_id), envelope: credential?.envelope as Buffer };
    expect(vault.open(envelope, { orgId, provider: 'accounting_misa_asp', externalAccountId: entity })).toBe(ASP_CODE);
    // Bound to its provider: the code of an ASP connection is never opened as an AMIS one.
    expect(() => vault.open(envelope, { orgId, provider: 'accounting_misa_amis', externalAccountId: entity })).toThrow();
    expect((await rows<{ product: string }>('SELECT product FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND id = $2', [orgId, id]))[0]?.product).toBe('asp');
    // The same product again is the same connection; the other product on this entity is refused, and what it began (a channel connection) is rolled back with it.
    const again = await call('connections/connect', owner, connectInput({ legalEntityId: entity, product: 'asp', accessCode: `${ASP_CODE}-2` }), aspOnlyApp);
    expect(again.body.id).toBe(id);
    await expect(call('connections/connect', owner, connectInput({ legalEntityId: entity, accessCode: PLANTED }), aspApp)).resolves.toMatchObject({ status: 409, body: { code: 'MISA_AMIS_CONNECTION_EXISTS' } });
    expect((await rows<{ provider: string }>('SELECT provider FROM ludy_kernel.channel_connection WHERE org_id = $1 AND external_account_id = $2', [orgId, entity])).map((r) => r.provider)).toEqual(['accounting_misa_asp']);
    for (const table of ['ludy_kernel.audit_event', 'ludy_kernel.outbox_event', 'ludy_kernel.channel_connection', 'ludy_finance.misa_amis_connection']) {
      expect(await rows(`SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t::text LIKE '%' || $2 || '%'`, [orgId, ASP_CODE]), table).toEqual([]);
    }
  });

  it('holds the provider to the product in the database, fixes the product for the row\'s life, and keeps the AMIS rows already there as AMIS', async () => {
    const entityA = await newEntity('Chi nhánh khóa A');
    const entityB = await newEntity('Chi nhánh khóa B');
    const amisChannel = randomUUID();
    const aspChannel = randomUUID();
    const insertChannel = (id: string, provider: string, entity: string) =>
      rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, 'Thử', $5)", [orgId, id, provider, entity, owner.userId]);
    await insertChannel(amisChannel, 'accounting_misa_amis', entityA);
    await insertChannel(aspChannel, 'accounting_misa_asp', entityB);
    const file = (entity: string, channel: string, product?: string) =>
      product === undefined
        ? rows('INSERT INTO ludy_finance.misa_amis_connection (org_id, legal_entity_id, channel_connection_id) VALUES ($1, $2, $3)', [orgId, entity, channel])
        : rows('INSERT INTO ludy_finance.misa_amis_connection (org_id, legal_entity_id, channel_connection_id, product) VALUES ($1, $2, $3, $4)', [orgId, entity, channel, product]);
    // An AMIS channel under an ASP row, an ASP channel under an AMIS row (the default) and under a row that says so, are all refused; a product outside the two is refused by its constraint.
    await expect(file(entityA, amisChannel, 'asp')).rejects.toThrow(/MISA_AMIS_CONNECTION_PROVIDER/);
    await expect(file(entityB, aspChannel)).rejects.toThrow(/MISA_AMIS_CONNECTION_PROVIDER/);
    await expect(file(entityB, aspChannel, 'amis')).rejects.toThrow(/MISA_AMIS_CONNECTION_PROVIDER/);
    // The guard runs before the constraint: a product outside the two reaches the constraint on a channel the guard lets through.
    await expect(file(entityA, amisChannel, 'other')).rejects.toThrow(/misa_amis_connection_product_ck/);
    await file(entityB, aspChannel, 'asp');
    await file(entityA, amisChannel);
    expect((await rows<{ product: string }>('SELECT product FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND legal_entity_id = $2', [orgId, entityA]))[0]?.product).toBe('amis');
    // A tenant role (the owner, through the sealed context) cannot change the product of a row.
    const refused = await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner.userId, orgId)]);
        await c.query('SET LOCAL ROLE ludy_tenant');
        await c.query("UPDATE ludy_finance.misa_amis_connection SET product = 'amis' WHERE org_id = $1 AND legal_entity_id = $2", [orgId, entityB]);
        return null;
      } catch (error) {
        return String((error as Error).message);
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(refused).toMatch(/permission denied/);
    // And not by anyone else either (a later grant, a definer function, the admin connection): the trigger refuses a re-bound product or channel connection, while the last test's state is still written.
    await expect(rows("UPDATE ludy_finance.misa_amis_connection SET product = 'amis' WHERE org_id = $1 AND legal_entity_id = $2", [orgId, entityB])).rejects.toThrow(/MISA_AMIS_CONNECTION_FIXED/);
    await expect(rows('UPDATE ludy_finance.misa_amis_connection SET channel_connection_id = $3 WHERE org_id = $1 AND legal_entity_id = $2', [orgId, entityB, amisChannel])).rejects.toThrow(/MISA_AMIS_CONNECTION_FIXED/);
    await rows("UPDATE ludy_finance.misa_amis_connection SET last_test_state = 'works', last_tested_at = pg_catalog.now() WHERE org_id = $1 AND legal_entity_id = $2", [orgId, entityB]);
    // The rows made before the column existed are AMIS ones: the existing connection of the default entity.
    expect((await rows<{ product: string }>('SELECT product FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND legal_entity_id = $2', [orgId, await defaultEntity()]))[0]?.product).toBe('amis');
  });

  it('tests an ASP connection as the worker with the ASP client (a token, then one row of the organization-unit catalogue), and asks for a test only where the deployment holds that product', async () => {
    const entity = await newEntity('Chi nhánh ASP thử');
    const connected = await call('connections/connect', owner, connectInput({ legalEntityId: entity, product: 'asp', accessCode: ASP_CODE }), aspOnlyApp);
    const id = String(connected.body.id);
    // Asked on a deployment without the ASP ClientID: refused as AMIS's is. Where it holds it, queued with ids only.
    await expect(call('connections/test', owner, { id }, app)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_DISABLED' } });
    expect((await call('connections/test', owner, { id }, aspOnlyApp)).body).toEqual({ queued: true });
    // A connection that is not there is not found, on a deployment that holds only ASP's ClientID too (the product cannot be told, so it is not asked).
    expect((await call('connections/test', owner, { id: randomUUID() }, aspOnlyApp)).body).toMatchObject({ code: 'MISA_AMIS_CONNECTION_NOT_FOUND' });
    const [stored] = await rows<{ org_company_code: string }>('SELECT org_company_code FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND id = $2', [orgId, id]);
    const company = String(stored?.org_company_code);
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    const asp = createAmisClient({
      clientId: CLIENT_ID,
      product: 'asp',
      transport: async (request: AmisRequest): Promise<AmisResponse> => {
        const path = new URL(request.url).pathname.replace(/^\/apis/, '');
        const body = JSON.parse(request.body) as Record<string, unknown>;
        seen.push({ path, body });
        const ok = (data: unknown): AmisResponse => ({ status: 200, body: JSON.stringify({ Success: true, ErrorMessage: '', Data: data }) });
        if (path === '/asp/v1/token') return body.access_code === `${ASP_CODE}` && body.org_company_code === company ? ok({ access_token: 'tok-asp' }) : { status: 200, body: JSON.stringify({ Success: false, ErrorCode: 'InvalidAccessToken', ErrorMessage: '' }) };
        return path === '/asp/v1/get_dictionary' && request.headers['X-MISA-AccessToken'] === 'tok-asp' ? ok([{ organization_unit_id: 'b1' }]) : { status: 200, body: JSON.stringify({ Success: false, ErrorCode: 'InvalidParam', ErrorMessage: '' }) };
      },
    });
    expect(await runMisaAmisTest({ runtime: worker, broker: vault, client: null, aspClient: asp }, { orgId, connectionId: id })).toEqual({ state: 'works' });
    expect(seen.map((s) => s.path)).toEqual(['/asp/v1/token', '/asp/v1/get_dictionary']);
    expect(seen[1]?.body).toMatchObject({ data_type: 6, skip: 0, take: 1 });
    const [listed] = ((await call('connections/list', member)).body as Array<{ id: string; lastTestState: string | null }>).filter((c) => c.id === id);
    expect(listed?.lastTestState).toBe('works');
    // The worker of a deployment without the ASP ClientID leaves the connection alone and records nothing new.
    expect(await runMisaAmisTest({ runtime: worker, broker: vault, client: fakeAmis('x', 'y').client, aspClient: null }, { orgId, connectionId: id })).toEqual({ state: 'skipped', reason: 'product_off' });
  });

  it('hands the worker the product of an ASP connection, and no longer refuses the push command for it; each product has its own push switch (#4113)', async () => {
    const [asp] = await rows<{ id: string; legal_entity_id: string }>("SELECT id, legal_entity_id FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND product = 'asp' ORDER BY created_at LIMIT 1", [orgId]);
    const [amis] = await rows<{ id: string; legal_entity_id: string }>("SELECT id, legal_entity_id FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND product = 'amis' ORDER BY created_at LIMIT 1", [orgId]);
    const target = await worker.query('finance.misa_amis.push_target', { connectionId: String(asp?.id) }, { actor: system, orgId });
    expect(target).toMatchObject({ action: 'push', id: String(asp?.id), product: 'asp' });
    // Nothing to send and, for ASP, nothing waits for a poll: no result check is ever asked for an ASP connection.
    const begin = await worker.execute('finance.misa_amis.push_begin', { connectionId: String(asp?.id), branchKnown: false, checked: false }, { actor: system, orgId });
    expect(begin).toEqual({ action: 'none', reason: 'nothing', waiting: false });
    // Status: each product's push has its own flag.
    expect((await call('status', member, undefined, aspPushApp)).body).toEqual({ offered: true, pushOffered: false, aspOffered: true, aspPushOffered: true });
    expect((await call('status', member, undefined, amisOnlyPushApp)).body).toEqual({ offered: true, pushOffered: true, aspOffered: true, aspPushOffered: false });
    const press = async (on: ReturnType<typeof createHttpApp>, row: { id: string; legal_entity_id: string } | undefined) =>
      rpc('vouchers/misaAmisPush', await tokenFor(owner), { connectionId: String(row?.id), kind: 'purchase_services', digest: 'a'.repeat(64), legalEntityId: String(row?.legal_entity_id) }, slug, on);
    // With the ASP push on, a press on the ASP connection reaches the command (refused there for what it holds, never for its product); a press on the AMIS connection answers the 404 of a switched-off push.
    const reached = await press(aspPushApp, asp);
    expect(reached.status).not.toBe(404);
    expect(reached.body?.code).not.toBe('MISA_ASP_PUSH_NOT_AVAILABLE');
    await expect(press(aspPushApp, amis)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_PUSH_DISABLED' } });
    // With only AMIS's push on, the ASP connection answers the same 404; with neither on, both do.
    await expect(press(amisOnlyPushApp, asp)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_PUSH_DISABLED' } });
    await expect(press(aspApp, asp)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_PUSH_DISABLED' } });
    await expect(press(aspApp, amis)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_PUSH_DISABLED' } });
    // A capital letter in the id (the contract accepts it) does not slip the gate: the AMIS connection of an ASP-only push answers the same 404.
    await expect(press(aspPushApp, { id: String(amis?.id).toUpperCase(), legal_entity_id: String(amis?.legal_entity_id) })).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_PUSH_DISABLED' } });
    // The catalogue check follows the connection's product too (#4152): the job reads with that product's client and opens only a code sealed for it. A connection whose product the deployment holds no ClientID for
    // answers the same 404 as a deployment without the connector and nothing is queued; with the ClientID the check is queued, in either case of the id (the second press is the same batch, already running).
    const askOf = (row: { legal_entity_id: string } | undefined) => ({ kind: 'purchase_services', legalEntityId: String(row?.legal_entity_id) });
    await expect(call('matches/check', owner, { id: String(asp?.id), ask: askOf(asp) }, app)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_DISABLED' } });
    await expect(call('matches/check', owner, { id: String(amis?.id), ask: askOf(amis) }, aspOnlyApp)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_DISABLED' } });
    await expect(call('matches/check', owner, { id: String(asp?.id), ask: askOf(asp) }, aspApp)).resolves.toMatchObject({ status: 200, body: { queued: true, running: false } });
    // The worker is handed the connection's product with the waiting check, so its job picks the ASP client and the ASP-sealed code.
    expect(await worker.query('finance.misa_amis_match.check_target', { id: String(asp?.id) }, { actor: system, orgId })).toMatchObject({ action: 'check', id: String(asp?.id), product: 'asp' });
    await expect(call('matches/check', owner, { id: String(asp?.id).toUpperCase(), ask: askOf(asp) }, aspApp)).resolves.toMatchObject({ status: 200, body: { queued: false, running: true } });
  });

  it('keeps the default stock of an ASP connection for its sales lines (#4125): typed, owner or admin only, refused for AMIS, bounded in the table, and handed to the check with the connection', async () => {
    const [asp] = await rows<{ id: string }>("SELECT id FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND product = 'asp' ORDER BY created_at LIMIT 1", [orgId]);
    const [amis] = await rows<{ id: string }>("SELECT id FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND product = 'amis' ORDER BY created_at LIMIT 1", [orgId]);
    const aspId = String(asp?.id);
    const stockOf = async (id: string) => ((await call('connections/list', owner)).body as Array<{ id: string; defaultSalesStockCode?: string | null }>).find((c) => c.id === id)?.defaultSalesStockCode;
    expect(await call('connections/setDefaultItem', owner, { id: aspId, role: 'sales_stock', code: ' KHO1 ' })).toMatchObject({ status: 200, body: { saved: true } });
    expect(await stockOf(aspId)).toBe('KHO1');
    // The worker is handed it with the waiting check, for an ASP connection only.
    await call('matches/check', owner, { id: aspId, ask: { kind: 'sales', legalEntityId: String((await rows<{ legal_entity_id: string }>('SELECT legal_entity_id FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND id = $2', [orgId, aspId]))[0]?.legal_entity_id) } }, aspApp);
    expect(await worker.query('finance.misa_amis_match.check_target', { id: aspId }, { actor: system, orgId })).toMatchObject({ action: 'check', defaultSalesStockCode: 'KHO1' });
    // Owner or admin only; a member and a viewer are refused.
    for (const who of [member, viewer]) expect(await call('connections/setDefaultItem', who, { id: aspId, role: 'sales_stock', code: 'KHO2' })).toMatchObject({ status: 403 });
    // A control character is refused as a bad input (a NUL would otherwise reach the table and fail there).
    for (const code of ['KHO\u00001', 'KHO\n1', 'KHO\u007f']) expect(await call('connections/setDefaultItem', owner, { id: aspId, role: 'sales_stock', code })).toMatchObject({ status: 400 });
    // An AMIS connection keeps none (its sales lines leave no stock), and clearing one is always allowed.
    expect(await call('connections/setDefaultItem', owner, { id: String(amis?.id), role: 'sales_stock', code: 'KHO1' })).toMatchObject({ status: 422, body: { code: 'MISA_AMIS_STOCK_NOT_ASP' } });
    expect(await call('connections/setDefaultItem', owner, { id: String(amis?.id), role: 'sales_stock', code: null })).toMatchObject({ status: 200 });
    // The table holds the bound and the product too.
    await expect(rows('UPDATE ludy_finance.misa_amis_connection SET default_sales_stock_code = $3 WHERE org_id = $1 AND id = $2', [orgId, aspId, 'x'.repeat(51)])).rejects.toThrow(/misa_amis_connection_default_stock_ck/);
    await expect(rows("UPDATE ludy_finance.misa_amis_connection SET default_sales_stock_code = 'KHO1' WHERE org_id = $1 AND id = $2", [orgId, String(amis?.id)])).rejects.toThrow(/misa_amis_connection_default_stock_ck/);
    expect(await call('connections/setDefaultItem', owner, { id: aspId, role: 'sales_stock', code: null })).toMatchObject({ status: 200 });
    expect(await stockOf(aspId)).toBeNull();
  });

  it('keeps the MISA names a person typed for units of an ASP connection (#4125): per unit, folded, owner or admin only, refused for AMIS, bounded in the command and in the table, and handed to the check', async () => {
    const [asp] = await rows<{ id: string; legal_entity_id: string }>("SELECT id, legal_entity_id FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND product = 'asp' ORDER BY created_at LIMIT 1", [orgId]);
    const [amis] = await rows<{ id: string }>("SELECT id FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND product = 'amis' ORDER BY created_at LIMIT 1", [orgId]);
    const aspId = String(asp?.id);
    const aliasesOf = async () => ((await call('connections/list', owner)).body as Array<{ id: string; unitAliases?: Record<string, string> }>).find((c) => c.id === aspId)?.unitAliases;
    // Folded like the check folds a unit (composed, lower case, one space), the typed name trimmed.
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: '  CHIẾC  Lớn ', misaName: ' Cái ' })).toMatchObject({ status: 200, body: { saved: true } });
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: 'hộp', misaName: 'Hộp' })).toMatchObject({ status: 200 });
    expect(await aliasesOf()).toEqual({ 'chiếc lớn': 'Cái', hộp: 'Hộp' });
    // A unit named like a prototype property is an ordinary unit: stored, listed and cleared like any other.
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: '__proto__', misaName: 'P' })).toMatchObject({ status: 200 });
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: 'constructor', misaName: 'C' })).toMatchObject({ status: 200 });
    // (Read from the row: a JSON answer built from a plain record cannot carry an own `__proto__` key, which nothing on the screen reads.)
    const [stored] = await rows<{ unit_aliases: Record<string, string> }>('SELECT unit_aliases FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND id = $2', [orgId, aspId]);
    expect(Object.entries(stored?.unit_aliases ?? {}).sort()).toEqual([['__proto__', 'P'], ['chiếc lớn', 'Cái'], ['constructor', 'C'], ['hộp', 'Hộp']]);
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: '__proto__', misaName: null })).toMatchObject({ status: 200 });
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: 'constructor', misaName: null })).toMatchObject({ status: 200 });
    // Replaced per unit, and cleared per unit with a null name, without touching the others.
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: 'chiếc lớn', misaName: 'Chiếc' })).toMatchObject({ status: 200 });
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: 'HỘP', misaName: null })).toMatchObject({ status: 200 });
    expect(await aliasesOf()).toEqual({ 'chiếc lớn': 'Chiếc' });
    // The worker is handed them with the waiting check.
    await call('matches/check', owner, { id: aspId, ask: { kind: 'sales', legalEntityId: String(asp?.legal_entity_id) } }, aspApp);
    expect(await worker.query('finance.misa_amis_match.check_target', { id: aspId }, { actor: system, orgId })).toMatchObject({ action: 'check', unitAliases: { 'chiếc lớn': 'Chiếc' } });
    // Owner or admin only; an AMIS connection has none; a unit that folds to nothing, or a name over 64 characters, is refused.
    for (const who of [member, viewer]) expect(await call('connections/setUnitAlias', who, { id: aspId, unit: 'cái', misaName: 'Cái' })).toMatchObject({ status: 403 });
    expect(await call('connections/setUnitAlias', owner, { id: String(amis?.id), unit: 'cái', misaName: 'Cái' })).toMatchObject({ status: 422, body: { code: 'MISA_AMIS_UNIT_NOT_ASP' } });
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: 'x'.repeat(65), misaName: 'Cái' })).toMatchObject({ status: 400 });
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: 'cái', misaName: 'x'.repeat(65) })).toMatchObject({ status: 400 });
    // A control character in either text is a bad input, never a 500 from the table.
    for (const bad of ['cái\u0000', 'cá\ni', '\u007fcái']) {
      expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: bad, misaName: 'Cái' })).toMatchObject({ status: 400 });
      expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: 'cái', misaName: bad })).toMatchObject({ status: 400 });
    }
    expect(await call('connections/setUnitAlias', owner, { id: randomUUID(), unit: 'cái', misaName: 'Cái' })).toMatchObject({ status: 404 });
    // 200 units at most: a 201st is refused by the command, the 200 stay.
    await rows("UPDATE ludy_finance.misa_amis_connection SET unit_aliases = (SELECT jsonb_object_agg('u' || g, 'V' || g) FROM generate_series(1, 200) g) WHERE org_id = $1 AND id = $2", [orgId, aspId]);
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: 'một đơn vị nữa', misaName: 'X' })).toMatchObject({ status: 422, body: { code: 'MISA_AMIS_UNIT_ALIASES_FULL' } });
    expect(await call('connections/setUnitAlias', owner, { id: aspId, unit: 'u1', misaName: 'Mới' })).toMatchObject({ status: 200 });
    // The table holds the bounds too: an object, 200 entries, texts of 1 to 64 characters, ASP only.
    const bad = (value: string, id = aspId) => rows('UPDATE ludy_finance.misa_amis_connection SET unit_aliases = $3::jsonb WHERE org_id = $1 AND id = $2', [orgId, id, value]);
    await expect(bad('[]')).rejects.toThrow(/misa_amis_connection_unit_aliases_ck/);
    await expect(bad('{"a": 1}')).rejects.toThrow(/misa_amis_connection_unit_aliases_ck/);
    await expect(bad(`{"a": "${'x'.repeat(65)}"}`)).rejects.toThrow(/misa_amis_connection_unit_aliases_ck/);
    await expect(bad('{"": "x"}')).rejects.toThrow(/misa_amis_connection_unit_aliases_ck/);
    await expect(rows("UPDATE ludy_finance.misa_amis_connection SET unit_aliases = (SELECT jsonb_object_agg('u' || g, 'V') FROM generate_series(1, 201) g) WHERE org_id = $1 AND id = $2", [orgId, aspId])).rejects.toThrow(/misa_amis_connection_unit_aliases_ck/);
    await expect(bad('{"cái": "Cái"}', String(amis?.id))).rejects.toThrow(/misa_amis_connection_unit_aliases_ck/);
    // The units of the last check a person can give a name: the unmatched ones, and one with a name typed (matched through it), never a matched unit with no name; the list is for owners and admins.
    await rows("UPDATE ludy_finance.misa_amis_connection SET unit_aliases = '{\"chiếc\": \"Cái\", \"mới\": \"Hộp\"}'::jsonb WHERE org_id = $1 AND id = $2", [orgId, aspId]);
    const [chk] = await rows<{ legal_entity_id: string }>('SELECT legal_entity_id FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND id = $2', [orgId, aspId]);
    for (const [key, state, code, id] of [['cái', 'matched', 'Cái', randomUUID()], ['chiếc', 'matched', 'Cái', randomUUID()], ['kg', 'unknown', null, null], ['hộp', 'ambiguous', null, null]] as const) {
      await rows('INSERT INTO ludy_finance.misa_amis_match (org_id, connection_id, legal_entity_id, kind, match_key, state, catalogue_code, catalogue_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [orgId, aspId, chk?.legal_entity_id, 'unit', key, state, code, id]);
    }
    expect((await call('matches/units', owner, { connectionId: aspId }, aspApp)).body).toEqual([
      // A name typed for a unit no check has asked about comes first, so a long list never hides a name that can no longer be cleared.
      { unit: 'mới', state: 'unknown', alias: 'Hộp' },
      { unit: 'chiếc', state: 'matched', alias: 'Cái' },
      { unit: 'hộp', state: 'ambiguous', alias: null },
      { unit: 'kg', state: 'unknown', alias: null },
    ]);
    expect(await call('matches/units', member, { connectionId: aspId }, aspApp)).toMatchObject({ status: 403 });
    await rows("DELETE FROM ludy_finance.misa_amis_match WHERE org_id = $1 AND connection_id = $2 AND kind = 'unit'", [orgId, aspId]);
    await rows("UPDATE ludy_finance.misa_amis_connection SET unit_aliases = '{}'::jsonb WHERE org_id = $1 AND id = $2", [orgId, aspId]);
    expect(await aliasesOf()).toEqual({});
  });

  // The insert guard fails closed and cannot be skipped (#4132, two LOW items of the security review of #4131).
  it('files a connection only when the channel connection of its product is found, so a channel row the writer cannot see is refused, and the guard fires in replica mode too', async () => {
    const entity = await newEntity('Chi nhánh guard kín');
    const channel = randomUUID();
    await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'accounting_misa_asp', $3, 'ASP thử', $4)", [orgId, channel, entity, owner.userId]);
    // As the owner of the org (the sealed context, the tenant role), with a restrictive policy that hides the ASP channel rows from the tenant role: the foreign key still sees the row, the guard does not.
    const fileAsOwner = (product: string, hide: boolean) =>
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          if (hide) await c.query("CREATE POLICY hide_asp_test ON ludy_kernel.channel_connection AS RESTRICTIVE FOR SELECT TO ludy_tenant USING (provider <> 'accounting_misa_asp')");
          await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner.userId, orgId)]);
          await c.query('SET LOCAL ROLE ludy_tenant');
          await c.query('INSERT INTO ludy_finance.misa_amis_connection (org_id, legal_entity_id, channel_connection_id, product) VALUES ($1, $2, $3, $4)', [orgId, entity, channel, product]);
          return 'filed';
        } catch (error) {
          return String((error as Error).message);
        } finally {
          await c.query('ROLLBACK');
        }
      });
    // The control: with the row visible, the right product files and the wrong one is refused.
    expect(await fileAsOwner('asp', false)).toBe('filed');
    expect(await fileAsOwner('amis', false)).toMatch(/MISA_AMIS_CONNECTION_PROVIDER/);
    // Hidden from the writer: neither product can be filed (before, the wrong one passed and the right one too, unchecked).
    expect(await fileAsOwner('amis', true)).toMatch(/MISA_AMIS_CONNECTION_PROVIDER/);
    expect(await fileAsOwner('asp', true)).toMatch(/MISA_AMIS_CONNECTION_PROVIDER/);
    // ENABLE ALWAYS: the trigger is enabled in every replication role, and a superuser's insert in replica mode is still held to the provider.
    const [trigger] = await rows<{ tgenabled: string }>("SELECT tgenabled FROM pg_catalog.pg_trigger WHERE tgname = 'misa_amis_connection_guard' AND NOT tgisinternal");
    expect(trigger?.tgenabled).toBe('A');
    const replica = await admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query("INSERT INTO ludy_finance.misa_amis_connection (org_id, legal_entity_id, channel_connection_id, product) VALUES ($1, $2, $3, 'amis')", [orgId, entity, channel]);
        return 'filed';
      } catch (error) {
        return String((error as Error).message);
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(replica).toMatch(/MISA_AMIS_CONNECTION_PROVIDER/);
  });
  // The default item of a connection (#4124, S3b of #4103): two columns on the connection row, kept as typed by an owner or admin.
  it('keeps and clears the default item of a connection for an owner or admin only, as typed, and nothing else of the row can be written by a tenant role', async () => {
    const entity = await newEntity('Chi nhánh mã mặc định');
    const channel = randomUUID();
    await rows("INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'accounting_misa_amis', $3, 'Thử', $4)", [orgId, channel, entity, owner.userId]);
    await rows('INSERT INTO ludy_finance.misa_amis_connection (org_id, legal_entity_id, channel_connection_id) VALUES ($1, $2, $3)', [orgId, entity, channel]);
    const id = String((await rows<{ id: string }>('SELECT id FROM ludy_finance.misa_amis_connection WHERE org_id = $1 AND legal_entity_id = $2', [orgId, entity]))[0]?.id);
    const mine = async (who: Account = owner) => ((await call('connections/list', who)).body as Array<Record<string, unknown>>).find((c) => c.id === id);
    expect(await mine()).toMatchObject({ defaultServiceItemCode: null, defaultSalesItemCode: null });

    // Owner or admin only; another org's user is not a member here.
    for (const who of [member, viewer]) expect((await call('connections/setDefaultItem', who, { id, role: 'service', code: 'DV_CHUNG' })).status, who.email).toBe(403);
    expect((await call('connections/setDefaultItem', outsider, { id, role: 'service', code: 'DV_CHUNG' })).status).not.toBe(200);
    expect(await mine()).toMatchObject({ defaultServiceItemCode: null });

    // Kept as typed, trimmed; every member reads it; the two roles are independent.
    expect(await call('connections/setDefaultItem', owner, { id, role: 'service', code: '  DV_CHUNG ' })).toMatchObject({ status: 200, body: { saved: true } });
    expect(await call('connections/setDefaultItem', adminUser, { id, role: 'sales', code: 'BH_CHUNG' })).toMatchObject({ status: 200, body: { saved: true } });
    for (const who of [owner, adminUser, member, viewer]) expect(await mine(who), who.email).toMatchObject({ defaultServiceItemCode: 'DV_CHUNG', defaultSalesItemCode: 'BH_CHUNG' });
    // A null code clears one role and leaves the other.
    expect(await call('connections/setDefaultItem', owner, { id, role: 'service', code: null })).toMatchObject({ status: 200 });
    expect(await mine()).toMatchObject({ defaultServiceItemCode: null, defaultSalesItemCode: 'BH_CHUNG' });

    // Malformed asks are refused before anything is written; a connection that is not there (or another org's) is a 404.
    for (const bad of [{ id, role: 'service', code: '' }, { id, role: 'service', code: 'x'.repeat(51) }, { id, role: 'other', code: 'A' }, { id, role: 'service', code: 'A', extra: 1 }]) {
      expect((await call('connections/setDefaultItem', owner, bad)).status, JSON.stringify(bad)).toBeGreaterThanOrEqual(400);
    }
    expect(await call('connections/setDefaultItem', owner, { id: randomUUID(), role: 'sales', code: 'A' })).toMatchObject({ status: 404, body: { code: 'MISA_AMIS_CONNECTION_NOT_FOUND' } });
    expect((await call('connections/setDefaultItem', outsider, { id, role: 'sales', code: 'A' }, app, otherSlug)).body).toMatchObject({ code: 'MISA_AMIS_CONNECTION_NOT_FOUND' });
    expect(await mine()).toMatchObject({ defaultSalesItemCode: 'BH_CHUNG' });

    // The audit row says the role and whether a code was kept, not the code.
    const audit = await rows<{ detail: unknown }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.misa_amis_connection.set_default_item'", [orgId]);
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toMatch(/DV_CHUNG|BH_CHUNG/);

    // The table holds the bound too; a tenant role may write these two columns and no other column of the row (the company code, the entity, the channel stay as they were made).
    await expect(rows('UPDATE ludy_finance.misa_amis_connection SET default_sales_item_code = $3 WHERE org_id = $1 AND id = $2', [orgId, id, 'x'.repeat(51)])).rejects.toThrow(/misa_amis_connection_default_items_ck/);
    await expect(rows("UPDATE ludy_finance.misa_amis_connection SET default_service_item_code = '' WHERE org_id = $1 AND id = $2", [orgId, id])).rejects.toThrow(/misa_amis_connection_default_items_ck/);
    const asTenant = (statement: string, who: Account = owner) =>
      admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(who.userId, orgId)]);
          await c.query('SET LOCAL ROLE ludy_tenant');
          const result = await c.query(statement, [orgId, id]);
          return `updated ${result.rowCount}`;
        } catch (error) {
          return String((error as Error).message);
        } finally {
          await c.query('ROLLBACK');
        }
      });
    expect(await asTenant("UPDATE ludy_finance.misa_amis_connection SET default_sales_item_code = 'KHAC' WHERE org_id = $1 AND id = $2")).toBe('updated 1');
    // A member or a viewer who reached the table with the tenant role (no command, no route) updates no row: the update policy hides the row from them.
    for (const who of [member, viewer]) expect(await asTenant("UPDATE ludy_finance.misa_amis_connection SET default_sales_item_code = 'KHAC' WHERE org_id = $1 AND id = $2", who), who.email).toBe('updated 0');
    expect(await asTenant("UPDATE ludy_finance.misa_amis_connection SET org_company_code = 'ludy-00000000000000000000000000000000' WHERE org_id = $1 AND id = $2")).toMatch(/permission denied/);
    expect(await asTenant("UPDATE ludy_finance.misa_amis_connection SET legal_entity_id = legal_entity_id WHERE org_id = $1 AND id = $2")).toMatch(/permission denied/);
    // The trigger that fixes the product and the channel connection still does, for anyone.
    await expect(rows("UPDATE ludy_finance.misa_amis_connection SET product = 'asp' WHERE org_id = $1 AND id = $2", [orgId, id])).rejects.toThrow(/MISA_AMIS_CONNECTION_FIXED/);
  });
});

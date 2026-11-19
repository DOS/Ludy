// SPDX-License-Identifier: AGPL-3.0-only
// An entity's connection to MISA AMIS Kế toán (#3875, S2 of #3854), on a real PostgreSQL 17 through the HTTP API: the connector is offered only when the deployment holds the integrator's ClientID,
// connect (the access code sealed at the edge, no secret in any answer, audit row or stored row), who may do what, one connection per entity (a second connect is the same connection), the
// opaque code AMIS is told (random, unique, never in an answer), disconnect (the sealed code dropped with the connection), and the database's own guards.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { AmisError, createAmisClient, type AmisRequest, type AmisResponse } from '@crove/misa-amis';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runMisaAmisTest } from '../src/misa-amis-test-job.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
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
  const dbName = `crove_test_misa_amis_conn_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const defaultEntity = async (org = orgId) => String((await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [org]))[0]?.id);

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
    const register = (target: ReturnType<typeof createDb>, sessions = false) =>
      new Runtime(target, { manifests: TEST_MANIFESTS, ...(sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' as const } : {}) }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
      });
    const runtime = register(db, true);
    api = runtime;
    worker = register(createDb(workerPool));
    const config = loadConfig({ DATABASE_URL: login('crove_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const deps = { config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    app = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false, misaAmis: true } });
    offApp = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false } });
    pushApp = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false, misaAmis: true, misaAmisPush: true } });

    for (const who of [owner, adminUser, member, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Kế toán AMIS', idempotencyKey: randomUUID() }, null);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser.userId, member.userId, viewer.userId]);
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
    expect((await call('status', member)).body).toEqual({ offered: true, pushOffered: false });
    expect((await call('status', member, undefined, offApp)).body).toEqual({ offered: false, pushOffered: false });
    expect((await call('status', member, undefined, pushApp)).body).toEqual({ offered: true, pushOffered: true });
    await expect(call('connections/connect', owner, connectInput(), offApp)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_DISABLED' } });
    expect(await rows('SELECT 1 FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId])).toEqual([]);
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_connection WHERE org_id = $1', [orgId])).toEqual([]);
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
      expect(list.body).toEqual([expect.objectContaining({ id, status: 'active', legalEntityId: await defaultEntity(), displayName: 'MISA AMIS Kế toán', connectedAt: expect.any(String) })]);
      // Neither the code nor the opaque code AMIS is told is in the answer.
      expect(JSON.stringify(list.body)).not.toMatch(/ludy-[0-9a-f]{32}/);
    }
    // The channel connection exists under the provider and holds a credential that is sealed: the planted code is in no readable column.
    const channel = (await rows<{ id: string; provider: string; external_account_id: string; status: string }>('SELECT id, provider, external_account_id, status FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId]))[0];
    expect(channel).toMatchObject({ provider: 'accounting_misa_amis', external_account_id: await defaultEntity(), status: 'active' });
    const [credential] = await rows<{ key_id: string; envelope: Buffer }>('SELECT key_id, envelope FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [orgId, channel?.id]);
    expect(credential?.envelope.includes(Buffer.from(PLANTED))).toBe(false);
    // The vault opens it for the binding it was sealed under (the access code as typed), and for no other org.
    const binding = { orgId, provider: 'accounting_misa_amis', externalAccountId: await defaultEntity() };
    const envelope = { keyId: String(credential?.key_id), envelope: credential?.envelope as Buffer };
    expect(vault.open(envelope, binding)).toBe(PLANTED);
    expect(() => vault.open(envelope, { ...binding, orgId: randomUUID() })).toThrow();
    // Nothing readable anywhere carries the code: the audit rows, the outbox, the connection rows.
    for (const table of ['crove_kernel.audit_event', 'crove_kernel.outbox_event', 'crove_kernel.channel_connection', 'crove_finance.misa_amis_connection']) {
      const hit = await rows(`SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t::text LIKE '%' || $2 || '%'`, [orgId, PLANTED]);
      expect(hit, table).toEqual([]);
    }
    // The audit row of the connect names the entity and the channel connection and nothing of the code.
    const audit = await rows<{ command: string }>("SELECT command FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.misa_amis_connection.connect'", [orgId]);
    expect(audit.length).toBeGreaterThan(0);
    // The company code MISA is given is a stable name of the org, not a secret, but it belongs to the connection row alone: no audit or outbox row repeats it.
    const [stored] = await rows<{ org_company_code: string }>('SELECT org_company_code FROM crove_finance.misa_amis_connection WHERE org_id = $1', [orgId]);
    expect(stored?.org_company_code).toMatch(/^ludy-[0-9a-f]{32}$/);
    for (const table of ['crove_kernel.audit_event', 'crove_kernel.outbox_event']) {
      const hit = await rows(`SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t::text LIKE '%' || $2 || '%'`, [orgId, stored?.org_company_code]);
      expect(hit, table).toEqual([]);
    }
  });

  it('files one connection per entity: a second connect is the same connection, and another org gets its own', async () => {
    const before = await call('connections/list', owner);
    const again = await call('connections/connect', owner, connectInput({ accessCode: `${PLANTED}-again` }));
    expect(again.status).toBe(200);
    expect(again.body.id).toBe((before.body as Array<{ id: string }>)[0]?.id);
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_connection WHERE org_id = $1', [orgId])).toHaveLength(1);
    const theirs = await call('connections/connect', outsider, connectInput(), app, otherSlug);
    expect(theirs.status).toBe(200);
    // Each org sees only its own.
    expect(((await call('connections/list', outsider, undefined, app, otherSlug)).body as unknown[]).length).toBe(1);
    expect(((await call('connections/list', owner)).body as unknown[]).length).toBe(1);
  });

  it('tells AMIS an opaque code of its own for each connection: random, in the shape, unique across orgs, and never given to a tenant to change', async () => {
    const codes = await rows<{ org_id: string; org_company_code: string }>('SELECT org_id, org_company_code FROM crove_finance.misa_amis_connection ORDER BY created_at');
    expect(codes).toHaveLength(2);
    for (const row of codes) expect(row.org_company_code).toMatch(CODE);
    expect(new Set(codes.map((c) => c.org_company_code)).size).toBe(2);
    expect(codes.map((c) => c.org_id).sort()).toEqual([orgId, otherOrgId].sort());
    // A code outside the shape is refused by the database, and a duplicate too.
    await expect(rows("UPDATE crove_finance.misa_amis_connection SET org_company_code = 'not-a-code' WHERE org_id = $1", [orgId])).rejects.toThrow();
    await expect(rows('UPDATE crove_finance.misa_amis_connection SET org_company_code = $1 WHERE org_id = $2', [codes[1]?.org_company_code, orgId])).rejects.toThrow(/misa_amis_connection_code_uq/);
    // A tenant role never types the code or a test result: as the owner of the org (through the sealed context, as the tenant role) an INSERT that names both is stored with a fresh code and no result.
    const typed = 'ludy-' + '0'.repeat(32);
    const stored = await admin(async (c) => {
      await c.query('BEGIN');
      try {
        // An entity and a channel connection of its own, made as the admin connection and rolled back with the rest.
        const entity = randomUUID();
        const channel = randomUUID();
        await c.query("INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh thử mã', 'branch', $3)", [orgId, entity, owner.userId]);
        await c.query("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'accounting_misa_amis', $3, 'AMIS thử', $4)", [orgId, channel, `a-${entity}`, owner.userId]);
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner.userId, orgId)]);
        await c.query('SET LOCAL ROLE crove_tenant');
        const { rows: inserted } = await c.query<{ org_company_code: string; last_test_state: string | null; last_tested_at: Date | null }>(
          "INSERT INTO crove_finance.misa_amis_connection (org_id, legal_entity_id, channel_connection_id, org_company_code, last_test_state, last_tested_at) VALUES ($1, $2, $3, $4, 'works', pg_catalog.now()) RETURNING org_company_code, last_test_state, last_tested_at",
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
    await rows("INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh thử', 'branch', $3)", [orgId, entity, owner.userId]);
    await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'marketplace_sandbox', $3, 'Sàn thử', $4)", [orgId, channel, `m-${entity}`, owner.userId]);
    await expect(rows('INSERT INTO crove_finance.misa_amis_connection (org_id, legal_entity_id, channel_connection_id) VALUES ($1, $2, $3)', [orgId, entity, channel])).rejects.toThrow(/MISA_AMIS_CONNECTION_PROVIDER/);
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
    expect(await rows("SELECT 1 FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.misa_amis_connection.test_requested'", [orgId])).toEqual([]);
    for (const who of [owner, adminUser]) expect((await call('connections/test', who, { id })).body).toEqual({ queued: true });
    const events = await rows<{ payload: Record<string, unknown> }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.misa_amis_connection.test_requested'", [orgId]);
    expect(events).toEqual([{ payload: { connection_id: id } }, { payload: { connection_id: id } }]);
    // The event and the audit row carry ids: not the access code, the company code or the ClientID.
    const [stored] = await rows<{ org_company_code: string }>('SELECT org_company_code FROM crove_finance.misa_amis_connection WHERE org_id = $1', [orgId]);
    for (const table of ['crove_kernel.audit_event', 'crove_kernel.outbox_event']) {
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
    // Switch on: a member or viewer is refused by role, an owner reaches the command (the connection was not tested here, so it says so and queues nothing).
    for (const who of [member, viewer]) expect((await vouchers(who, pushApp)).status).toBe(403);
    await expect(vouchers(owner, pushApp)).resolves.toMatchObject({ status: 409, body: { code: 'MISA_AMIS_NOT_TESTED' } });
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_push WHERE org_id = $1', [orgId])).toEqual([]);
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
    const [stored] = await rows<{ org_company_code: string }>('SELECT org_company_code FROM crove_finance.misa_amis_connection WHERE org_id = $1', [orgId]);
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
    const audits = await rows<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.misa_amis_connection.record_test' AND outcome = 'ok'", [orgId]);
    expect(audits).toHaveLength(5);
    // The runtime adds the actor's component (and the worker's instance) to every audit detail; what the command adds is the state alone.
    const own = (detail: unknown) => Object.fromEntries(Object.entries(detail as Record<string, unknown>).filter(([key]) => key !== 'component' && key !== 'workerInstance'));
    for (const a of audits) expect(Object.keys(own(a.detail))).toEqual(['state']);
    expect(audits.map((a) => (own(a.detail) as { state: string }).state).sort()).toEqual(['unreachable', 'unreachable', 'works', 'works', 'wrong_credentials']);
    for (const table of ['crove_kernel.audit_event', 'crove_kernel.outbox_event', 'crove_kernel.channel_connection', 'crove_finance.misa_amis_connection']) {
      for (const secret of [PLANTED, company, CLIENT_ID, 'planted AMIS text', 'planted gateway text']) {
        // The connection row holds its own company code, which is the one thing here that may be in it.
        if (table === 'crove_finance.misa_amis_connection' && secret === company) continue;
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
    await rows("UPDATE crove_kernel.channel_connection SET status = 'expired' WHERE org_id = $1 AND id = $2", [orgId, listed?.connectionId]);
    try {
      expect((await call('connections/test', owner, { id })).body).toMatchObject({ code: 'CHANNEL_NOT_ACTIVE' });
      expect(await runMisaAmisTest({ runtime: worker, broker: vault, client: fakeAmis('x', 'y').client }, { orgId, connectionId: id })).toEqual({ state: 'skipped', reason: 'not_active' });
    } finally {
      await rows("UPDATE crove_kernel.channel_connection SET status = 'active' WHERE org_id = $1 AND id = $2", [orgId, listed?.connectionId]);
    }
  });

  it('disconnects for an owner or admin only, dropping the sealed access code with the connection, and a viewer or another org cannot', async () => {
    const [listed] = (await call('connections/list', owner)).body as Array<{ id: string; connectionId: string }>;
    for (const who of [member, viewer]) expect((await call('connections/disconnect', who, { id: listed?.id })).status).toBe(403);
    // Another org's owner cannot reach it.
    expect((await call('connections/disconnect', outsider, { id: listed?.id }, app, otherSlug)).body).toEqual({ removed: false });
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_connection WHERE org_id = $1', [orgId])).toHaveLength(1);
    expect((await call('connections/disconnect', owner, { id: listed?.id })).body).toEqual({ removed: true });
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_connection WHERE org_id = $1', [orgId])).toEqual([]);
    expect(await rows('SELECT 1 FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [orgId, listed?.connectionId])).toEqual([]);
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, listed?.connectionId]))[0]?.status).toBe('revoked');
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
});

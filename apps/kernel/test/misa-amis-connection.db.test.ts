// SPDX-License-Identifier: AGPL-3.0-only
// An entity's connection to MISA AMIS Kế toán (#3875, S2 of #3854), on a real PostgreSQL 17 through the HTTP API: the connector is offered only when the deployment holds the integrator's ClientID,
// connect (the access code sealed at the edge, no secret in any answer, audit row or stored row), who may do what, one connection per entity (a second connect is the same connection), the
// opaque code AMIS is told (random, unique, never in an answer), disconnect (the sealed code dropped with the connection), and the database's own guards.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
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
  const dbName = `crove_test_misa_amis_conn_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let vault: CredentialVault;
  // The deployment that holds the integrator's ClientID, and one that does not.
  let app: ReturnType<typeof createHttpApp>;
  let offApp: ReturnType<typeof createHttpApp>;
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
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({ DATABASE_URL: login('crove_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const deps = { config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    app = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false, misaAmis: true } });
    offApp = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false } });

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
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is offered only where the deployment holds the integrator\'s ClientID, and refuses a connect anywhere else before anything is sealed', async () => {
    expect((await call('status', member)).body).toEqual({ offered: true });
    expect((await call('status', member, undefined, offApp)).body).toEqual({ offered: false });
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
  });

  it('refuses, in the database, a row filed on a channel connection of another provider', async () => {
    const entity = randomUUID();
    const channel = randomUUID();
    await rows("INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh thử', 'branch', $3)", [orgId, entity, owner.userId]);
    await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'marketplace_sandbox', $3, 'Sàn thử', $4)", [orgId, channel, `m-${entity}`, owner.userId]);
    await expect(rows('INSERT INTO crove_finance.misa_amis_connection (org_id, legal_entity_id, channel_connection_id) VALUES ($1, $2, $3)', [orgId, entity, channel])).rejects.toThrow(/MISA_AMIS_CONNECTION_PROVIDER/);
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
    // A second disconnect of nothing is a plain no.
    expect((await call('connections/disconnect', owner, { id: listed?.id })).body).toEqual({ removed: false });
    // A reconnect is a new connection with a new code.
    const reconnected = await call('connections/connect', owner, connectInput());
    expect(reconnected.status).toBe(200);
    expect(reconnected.body.id).not.toBe(listed?.id);
  });
});

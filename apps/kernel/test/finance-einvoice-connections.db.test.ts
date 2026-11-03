// SPDX-License-Identifier: AGPL-3.0-only
// The org's connection to an e-invoice provider (#2501, ADR-0044 point 2), on a real PostgreSQL 17 through the HTTP API: connect (the credential sealed at the edge, no
// secret in any answer, audit row or stored row), test (the state and the series the provider lists), the entity's default series, disconnect (the credential
// dropped), who may do what, a provider the deployment does not offer, a provider whose signature needs the seller's own token, and the database's own guards.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createSandboxEInvoiceProvider, type EInvoiceProvider } from '@crove/einvoice';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { enterpriseCheckDigit } from '@crove/l10n-vn';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-einvoice-connections-0123456789';
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

// A synthetic tax code made at run time (the repository holds no checksum-valid one).
const PREFIX = '010010910';
const TAX_CODE = `${PREFIX}${enterpriseCheckDigit(PREFIX)}`;

// A planted secret: nothing the API answers, audits, queues or stores in a readable table may carry it.
const PLANTED = `planted-secret-${randomBytes(6).toString('hex')}`;

const suite = ADMIN ? describe : describe.skip;

suite('e-invoice provider connections (#2501)', () => {
  const dbName = `crove_test_einvoice_conn_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let vault: CredentialVault;
  // The deployment with the offline provider on, one with it off, one whose provider needs the seller's own token to sign, and one that behaves like a real adapter
  // (a host, two fields to connect with) so the sealing of typed secrets can be searched for.
  let app: ReturnType<typeof createHttpApp>;
  let offApp: ReturnType<typeof createHttpApp>;
  let tokenApp: ReturnType<typeof createHttpApp>;
  let realApp: ReturnType<typeof createHttpApp>;
  const owner: Account = { subject: randomUUID(), email: 'owner@einvoice-conn.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@einvoice-conn.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@einvoice-conn.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@einvoice-conn.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@einvoice-conn.test', session: randomUUID(), userId: '' };
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
  const call = async (path: string, who: Account, input?: unknown, on: ReturnType<typeof createHttpApp> = app) => rpc(`einvoice/${path}`, await tokenFor(who), input, slug, on);
  const connectInput = (extra: Record<string, unknown> = {}) => ({ provider: 'sandbox', legalEntityId: null, sellerTaxCode: null, fields: {}, ...extra });

  const sandbox = (): EInvoiceProvider => createSandboxEInvoiceProvider().provider;
  const only = <T,>(list: readonly T[]): T => {
    expect(list).toHaveLength(1);
    return list[0] as T;
  };

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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    rt = runtime;
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const deps = { config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false };
    const channels = (einvoiceProviders: Record<string, EInvoiceProvider>) => ({ broker: vault, sandbox: false, einvoiceProviders });
    const offline = sandbox();
    app = createHttpApp({ ...deps, channels: channels({ sandbox: offline }) });
    offApp = createHttpApp({ ...deps, channels: channels({}) });
    tokenApp = createHttpApp({ ...deps, channels: channels({ sandbox: { ...offline, capabilities: { ...offline.capabilities, signing: 'seller_token' } } }) });
    realApp = createHttpApp({ ...deps, channels: channels({ sandbox: { ...offline, hosts: ['einvoice.example.test'], connectFields: ['user', 'password'] } }) });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });

    for (const who of [owner, adminUser, member, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Hóa đơn', idempotencyKey: randomUUID() }, null);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser.userId, member.userId, viewer.userId]);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherSlug = String(other.body?.slug);
  });

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const defaultEntity = async () => String((await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id);

  it('offers only the providers the deployment turned on, and refuses a connect to any other', async () => {
    expect((await call('providers', member)).body).toEqual([{ id: 'sandbox', offline: true, connectFields: [] }]);
    expect((await call('providers', member, undefined, offApp)).body).toEqual([]);
    expect(((await call('status', member, undefined, offApp)).body as { sandbox: boolean }).sandbox).toBe(false);
    await expect(call('connections/connect', owner, connectInput({ sellerTaxCode: TAX_CODE }), offApp)).resolves.toMatchObject({ status: 404, body: { code: 'EINVOICE_DISABLED' } });
    expect((await call('connections/connect', owner, connectInput({ provider: 'misa', sellerTaxCode: TAX_CODE }))).body).toMatchObject({ code: 'EINVOICE_DISABLED' });
    expect(await rows('SELECT 1 FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId])).toEqual([]);
  });

  it('refuses a provider whose signature needs the seller\'s own token, before anything is sealed', async () => {
    const refused = await call('connections/connect', owner, connectInput({ sellerTaxCode: TAX_CODE }), tokenApp);
    expect(refused).toMatchObject({ status: 422, body: { code: 'EINVOICE_SIGNING_TOKEN' } });
    expect(await rows('SELECT 1 FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId])).toEqual([]);
    expect(await rows('SELECT 1 FROM crove_kernel.credential WHERE org_id = $1', [orgId])).toEqual([]);
  });

  it('connects the offline provider for an owner or admin only, under the entity and the tax code it has, once', async () => {
    for (const who of [member, viewer]) expect((await call('connections/connect', who, connectInput({ sellerTaxCode: TAX_CODE }))).status).toBe(403);
    // The entity has no tax code yet and none is typed.
    expect((await call('connections/connect', owner, connectInput())).body).toMatchObject({ code: 'EINVOICE_TAX_CODE_NEEDED' });
    // A typed one is used when the entity has none; once the entity has one, another is refused.
    const entity = await defaultEntity();
    expect((await rpc('org/setTaxCode', await tokenFor(owner), { taxCode: TAX_CODE })).status).toBe(200);
    expect((await call('connections/connect', owner, connectInput({ sellerTaxCode: '0123456789' }))).body).toMatchObject({ code: 'EINVOICE_TAX_CODE_MISMATCH' });
    // Fields the provider does not ask for are refused.
    expect((await call('connections/connect', owner, connectInput({ fields: { user: 'x' } }))).body).toMatchObject({ code: 'EINVOICE_FIELDS' });
    expect(await rows('SELECT 1 FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId])).toEqual([]);

    const connected = await call('connections/connect', adminUser, connectInput());
    expect(connected.status).toBe(200);
    const id = String(connected.body.id);
    // One credential row holds the sealed login; it is the connecting admin's.
    expect(await rows('SELECT provider, connected_by FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId])).toEqual([{ provider: 'einvoice_sandbox', connected_by: adminUser.userId }]);
    // The same account again is the same connection (and a takeover: the owner who connects it now holds its credential).
    expect((await call('connections/connect', owner, connectInput())).body).toEqual({ id });
    const list = (await call('connections/list', viewer)).body;
    expect(list).toEqual([
      { id, connectionId: expect.any(String), legalEntityId: entity, provider: 'sandbox', sellerTaxCode: TAX_CODE, displayName: 'Nhà cung cấp hóa đơn thử nghiệm', status: 'active', lastTestState: null, lastTestedAt: null },
    ]);
    // Another org sees nothing of it.
    expect((await rpc('einvoice/connections/list', await tokenFor(outsider), undefined, otherSlug)).body).toEqual([]);
    expect(await rows('SELECT connected_by FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId])).toEqual([{ connected_by: owner.userId }]);
    expect(Number((await rows<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.credential WHERE org_id = $1', [orgId]))[0]?.n)).toBe(1);
    // A second connection for the same entity, provider and tax code cannot exist.
    expect(await rows('SELECT 1 FROM crove_finance.einvoice_connection WHERE org_id = $1', [orgId])).toHaveLength(1);
  });

  it('tests the connection and adds the provider\'s series to the entity, then lets an owner or admin pick the default', async () => {
    const { id } = only((await call('connections/list', owner)).body as Array<{ id: string }>);
    for (const who of [member, viewer]) expect((await call('connections/test', who, { id })).status).toBe(403);
    const tested = await call('connections/test', owner, { id });
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ state: 'works', added: 2, series: [{ templateNo: '1', symbol: 'C26TSB', isDefault: true }, { templateNo: '2', symbol: 'C26TSM', isDefault: false }] });
    const [after] = (await call('connections/list', member)).body as Array<{ lastTestState: string; lastTestedAt: string }>;
    expect(after).toMatchObject({ lastTestState: 'works', lastTestedAt: expect.any(String) });
    // A second test adds nothing and keeps the default.
    expect((await call('connections/test', adminUser, { id })).body).toMatchObject({ state: 'works', added: 0 });
    // Not found in another org.
    expect((await rpc('einvoice/connections/test', await tokenFor(outsider), { id }, otherSlug)).body).toMatchObject({ code: 'EINVOICE_CONNECTION_NOT_FOUND' });
    // The default moves, one per entity; a member cannot move it.
    const second = tested.body.series.find((s: { symbol: string }) => s.symbol === 'C26TSM') as { id: string };
    expect((await call('series/setDefault', member, { seriesId: second.id })).status).toBe(403);
    const moved = await call('series/setDefault', adminUser, { seriesId: second.id });
    expect(moved.body.series.map((s: { symbol: string; isDefault: boolean }) => [s.symbol, s.isDefault])).toEqual([['C26TSB', false], ['C26TSM', true]]);
    expect((await call('series/setDefault', owner, { seriesId: randomUUID() })).body).toMatchObject({ code: 'EINVOICE_SERIES_NOT_FOUND' });
    // The audit facts name ids, a state and a count, never the tax code.
    const audits = await rows<{ command: string; detail: Record<string, unknown>; target_id: string | null }>(
      "SELECT command, detail, target_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'finance.einvoice_%' AND outcome = 'ok' ORDER BY occurred_at",
      [orgId],
    );
    expect(audits.map((a) => a.command)).toEqual(expect.arrayContaining(['finance.einvoice_connection.link', 'finance.einvoice_connection.record_test', 'finance.einvoice_series.set_default']));
    expect(JSON.stringify(audits)).not.toContain(TAX_CODE);
  });

  it('closes the connection: the credential is dropped, the row is gone, the series stay, and a second disconnect finds nothing', async () => {
    const { id, connectionId } = only((await call('connections/list', owner)).body as Array<{ id: string; connectionId: string }>);
    for (const who of [member, viewer]) expect((await call('connections/disconnect', who, { id })).status).toBe(403);
    expect((await call('connections/disconnect', adminUser, { id })).body).toEqual({ removed: true });
    expect((await call('connections/list', owner)).body).toEqual([]);
    expect(await rows('SELECT status FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, connectionId])).toEqual([{ status: 'revoked' }]);
    expect(await rows('SELECT 1 FROM crove_kernel.credential WHERE org_id = $1', [orgId])).toEqual([]);
    expect((await call('connections/disconnect', owner, { id })).body).toEqual({ removed: false });
    expect(Number((await rows<{ n: string }>('SELECT count(*) AS n FROM crove_finance.einvoice_series WHERE org_id = $1', [orgId]))[0]?.n)).toBe(2);
    // Connecting again is a new connection of the same account.
    const again = await call('connections/connect', owner, connectInput());
    expect(again.status).toBe(200);
    expect(String(again.body.id)).not.toBe(id);
  });

  it('keeps e-invoice connections out of the shared channel list, and lets two connects of one account at once both succeed on one connection', async () => {
    // The shared list is the Social and messaging channels': an e-invoice connection names the seller's tax code and entity in its account id, which only the finance
    // list shows (to the members of that entity).
    const shared = await rpc('channels/list', await tokenFor(owner), {});
    expect(shared.status).toBe(200);
    expect(JSON.stringify(shared.body)).not.toContain('einvoice_');
    expect(JSON.stringify(shared.body)).not.toContain(TAX_CODE);
    // Two connects of one new account at once (a double click, a retry): both answer with the same connection, and neither call revokes what the other returned.
    const branch = String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by, tax_code) VALUES ($1, 'Chi nhánh song song', 'branch', $2, $3) RETURNING id`, [orgId, owner.userId, `${TAX_CODE}-002`]))[0]?.id);
    const both = await Promise.all([call('connections/connect', owner, connectInput({ legalEntityId: branch })), call('connections/connect', adminUser, connectInput({ legalEntityId: branch }))]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(both[0]?.body.id).toBe(both[1]?.body.id);
    const mine = (await call('connections/list', owner)).body.filter((c: { legalEntityId: string }) => c.legalEntityId === branch);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'active' });
    expect(await rows("SELECT status FROM crove_kernel.channel_connection WHERE org_id = $1 AND external_account_id = $2", [orgId, branch])).toEqual([{ status: 'active' }]);
    expect(Number((await rows<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.credential WHERE org_id = $1 AND connection_id = $2', [orgId, mine[0]?.connectionId]))[0]?.n)).toBe(1);
    // Closed again, so the tests after this one see the connections they made.
    expect((await call('connections/disconnect', owner, { id: both[0]?.body.id })).body).toEqual({ removed: true });
    // The command itself, linking one channel connection from four calls at once: one row, the same answer to all, none refused for the others' work.
    const channel = randomUUID();
    await rows(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'einvoice_sandbox', $3, 'Song song', $4)`, [orgId, channel, `race-${channel}`, owner.userId]);
    const raceEntity = String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by, tax_code) VALUES ($1, 'Chi nhánh đua', 'branch', $2, $3) RETURNING id`, [orgId, owner.userId, `${TAX_CODE}-003`]))[0]?.id);
    const actor = { type: 'user' as const, userId: owner.userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    const linked = await Promise.all(
      [1, 2, 3, 4].map(() => rt.execute<{ id: string; existing: boolean }>('finance.einvoice_connection.link', { connectionId: channel, legalEntityId: raceEntity, sellerTaxCode: null }, { actor, orgId, idempotencyKey: randomUUID() })),
    );
    expect(new Set(linked.map((l) => l.id)).size).toBe(1);
    expect(linked.filter((l) => !l.existing)).toHaveLength(1);
    expect(await rows('SELECT 1 FROM crove_finance.einvoice_connection WHERE org_id = $1 AND channel_connection_id = $2', [orgId, channel])).toHaveLength(1);
  });

  it('seals what the org types for a provider that has fields, and shows it nowhere: no answer, audit row, queued event or readable table', async () => {
    const entity = await defaultEntity();
    // A second entity, so the account is its own connection beside the offline one.
    const branch = String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by, tax_code) VALUES ($1, 'Chi nhánh hóa đơn', 'branch', $2, $3) RETURNING id`, [orgId, owner.userId, `${TAX_CODE}-001`]))[0]?.id);
    // Missing and extra fields are refused, in words.
    expect((await call('connections/connect', owner, connectInput({ legalEntityId: branch, fields: { user: 'u' } }), realApp)).body).toMatchObject({ code: 'EINVOICE_FIELDS' });
    expect((await call('connections/connect', owner, connectInput({ legalEntityId: branch, fields: { user: 'u', password: PLANTED, other: 'x' } }), realApp)).body).toMatchObject({ code: 'EINVOICE_FIELDS' });
    const connected = await call('connections/connect', owner, connectInput({ legalEntityId: branch, fields: { user: 'ketoan@ludy.test', password: PLANTED } }), realApp);
    expect(connected.status).toBe(200);
    expect(connected.text).not.toContain(PLANTED);
    for (const text of [(await call('connections/list', owner, undefined, realApp)).text, (await call('providers', owner, undefined, realApp)).text, (await call('series/list', owner, undefined, realApp)).text]) {
      expect(text).not.toContain(PLANTED);
    }
    // The test of a provider reached over the network is the worker's, so the screen refuses it in words: the API never opens a credential.
    expect((await call('connections/test', owner, { id: connected.body.id }, realApp)).body).toMatchObject({ code: 'EINVOICE_PROVIDER_NOT_READY' });
    // Nothing readable holds the secret: every audit row, queued event and stored answer of the org, and every finance and channel row, as text.
    const dump = JSON.stringify({
      audit: await rows('SELECT * FROM crove_kernel.audit_event WHERE org_id = $1', [orgId]),
      outbox: await rows('SELECT * FROM crove_kernel.outbox_event WHERE org_id = $1', [orgId]),
      idempotency: await rows('SELECT * FROM crove_kernel.idempotency_key WHERE org_id = $1', [orgId]),
      channel: await rows('SELECT * FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId]),
      activity: await rows('SELECT * FROM crove_kernel.activity WHERE org_id = $1', [orgId]),
      connection: await rows('SELECT * FROM crove_finance.einvoice_connection WHERE org_id = $1', [orgId]),
    });
    expect(dump).not.toContain(PLANTED);
    expect(dump).not.toContain('ketoan@ludy.test');
    // The seller's tax code is in the finance row and nowhere that outlives it: not in the channel row (which stays as history after a disconnect), not in an audit row, a queued
    // event, a stored answer or the activity feed.
    const elsewhere = JSON.stringify({
      audit: await rows('SELECT * FROM crove_kernel.audit_event WHERE org_id = $1', [orgId]),
      outbox: await rows('SELECT * FROM crove_kernel.outbox_event WHERE org_id = $1', [orgId]),
      idempotency: await rows('SELECT * FROM crove_kernel.idempotency_key WHERE org_id = $1', [orgId]),
      channel: await rows('SELECT * FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId]),
      activity: await rows('SELECT * FROM crove_kernel.activity WHERE org_id = $1', [orgId]),
    });
    expect(elsewhere).not.toContain(TAX_CODE);
    // The sealed envelope holds it, and the vault opens it for the binding it was sealed under, and for no other.
    const [credential] = await rows<{ key_id: string; envelope: Buffer }>(
      'SELECT c.key_id, c.envelope FROM crove_kernel.credential c WHERE c.org_id = $1 AND c.connection_id = (SELECT channel_connection_id FROM crove_finance.einvoice_connection WHERE org_id = $1 AND legal_entity_id = $2)',
      [orgId, branch],
    );
    expect(credential?.envelope.includes(Buffer.from(PLANTED))).toBe(false);
    const binding = { orgId, provider: 'einvoice_sandbox', externalAccountId: branch };
    const sealed = { keyId: String(credential?.key_id), envelope: credential?.envelope as Buffer };
    expect(JSON.parse(vault.open(sealed, binding))).toEqual({ user: 'ketoan@ludy.test', password: PLANTED });
    expect(() => vault.open(sealed, { ...binding, orgId: randomUUID() })).toThrow();
    // The same account of the first entity is a different account (a different entity), so the first connection of the default entity is a separate one.
    expect(entity).not.toBe(branch);
  });

  it('stops a connection\'s credential from opening once the member who connected it is no longer an owner or admin', async () => {
    // A connect of an account that is already connected is a takeover: the admin who connects it now holds its credential.
    const connected = await call('connections/connect', adminUser, connectInput());
    expect(connected.status).toBe(200);
    const { connectionId } = only((await call('connections/list', owner)).body.filter((c: { id: string }) => c.id === connected.body.id) as Array<{ connectionId: string }>);
    const open = async () => {
      const c = await workerPool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
        return await c.query('SELECT key_id FROM crove_kernel.credential_get($1::uuid)', [connectionId]);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    expect((await open()).rowCount).toBe(1);
    await rows("UPDATE crove_kernel.tenant_member SET role = 'member' WHERE org_id = $1 AND user_id = $2", [orgId, adminUser.userId]);
    await expect(open()).rejects.toMatchObject({ message: expect.stringContaining('CHANNEL_OWNER_LEFT') });
    await rows("UPDATE crove_kernel.tenant_member SET role = 'admin' WHERE org_id = $1 AND user_id = $2", [orgId, adminUser.userId]);
  });

  it('does not issue an entity\'s invoices under another entity\'s tax code, nor change the seller of a connected account', async () => {
    const entityA = await defaultEntity();
    const bare = String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh chưa có mã', 'branch', $2) RETURNING id`, [orgId, owner.userId]))[0]?.id);
    // The other entity's code is refused for an entity without one, by the command and by the database.
    expect((await call('connections/connect', owner, connectInput({ legalEntityId: bare, sellerTaxCode: TAX_CODE }))).body).toMatchObject({ code: 'EINVOICE_TAX_CODE_MISMATCH' });
    expect(await rows('SELECT 1 FROM crove_kernel.channel_connection WHERE org_id = $1 AND external_account_id = $2', [orgId, bare])).toEqual([]);
    const channelId = randomUUID();
    await rows(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'einvoice_sandbox', $3, 'Thử', $4)`, [orgId, channelId, `sql-${randomUUID()}`, owner.userId]);
    await expect(rows('INSERT INTO crove_finance.einvoice_connection (org_id, legal_entity_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, $3, $4, $5)', [orgId, bare, channelId, 'einvoice_sandbox', TAX_CODE])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('EINVOICE_CONNECTION_TAX_CODE') });
    expect(entityA).not.toBe(bare);
    // A code of its own is taken, and the same account under another code is refused, leaving the connection as it was.
    const first = await call('connections/connect', owner, connectInput({ legalEntityId: bare, sellerTaxCode: '0123456789' }));
    expect(first.status).toBe(200);
    const again = await call('connections/connect', owner, connectInput({ legalEntityId: bare, sellerTaxCode: '0123456780' }));
    expect(again).toMatchObject({ status: 409, body: { code: 'EINVOICE_CONNECTION_EXISTS' } });
    expect((await call('connections/list', owner)).body.filter((c: { legalEntityId: string }) => c.legalEntityId === bare)).toMatchObject([{ id: first.body.id, sellerTaxCode: '0123456789', status: 'active' }]);
    expect((await call('connections/disconnect', owner, { id: first.body.id })).body).toEqual({ removed: true });
  });

  it('closes the new channel connection and its credential when the account turns out to be connected already, and removes a row only once the connection is closed', async () => {
    const entity = String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh đã nối', 'branch', $2) RETURNING id`, [orgId, owner.userId]))[0]?.id);
    // The entity already has a connection under this provider and tax code (another channel row), so the new one cannot be filed.
    const existingChannel = randomUUID();
    await rows(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'einvoice_sandbox', $3, 'Có sẵn', $4)`, [orgId, existingChannel, `pre-${randomUUID()}`, owner.userId]);
    await rows(`INSERT INTO crove_finance.einvoice_connection (org_id, legal_entity_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, $3, 'einvoice_sandbox', '0123456799')`, [orgId, entity, existingChannel]);
    const refused = await call('connections/connect', owner, connectInput({ legalEntityId: entity, sellerTaxCode: '0123456799' }));
    expect(refused).toMatchObject({ status: 409, body: { code: 'EINVOICE_CONNECTION_EXISTS' } });
    // No live connection and no credential is left for the account that was refused.
    expect(await rows('SELECT status FROM crove_kernel.channel_connection WHERE org_id = $1 AND external_account_id = $2', [orgId, entity])).toEqual([{ status: 'revoked' }]);
    expect(await rows('SELECT 1 FROM crove_kernel.credential c JOIN crove_kernel.channel_connection ch ON ch.org_id = c.org_id AND ch.id = c.connection_id WHERE c.org_id = $1 AND ch.external_account_id = $2', [orgId, entity])).toEqual([]);
    // A row of a live connection is not removed by the command: the credential would be left without its row.
    const id = String((await rows<{ id: string }>('SELECT id FROM crove_finance.einvoice_connection WHERE org_id = $1 AND channel_connection_id = $2', [orgId, existingChannel]))[0]?.id);
    const actor = { type: 'user' as const, userId: owner.userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) };
    await expect(rt.execute('finance.einvoice_connection.unlink', { id }, { actor, orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'EINVOICE_CONNECTION_LIVE' });
    await rows("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2", [orgId, existingChannel]);
    expect(await rt.execute('finance.einvoice_connection.unlink', { id }, { actor, orgId, idempotencyKey: randomUUID() })).toEqual({ removed: true });
  });

  it('holds the roles in SQL as the runtime\'s own login: owners and admins write a connection, members and viewers read it, and only the last test can change', async () => {
    const entity = String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh vai trò', 'branch', $2) RETURNING id`, [orgId, owner.userId]))[0]?.id);
    const channel = randomUUID();
    await rows(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'einvoice_sandbox', $3, 'Vai trò', $4)`, [orgId, channel, `role-${randomUUID()}`, owner.userId]);
    const insertSql = 'INSERT INTO crove_finance.einvoice_connection (org_id, legal_entity_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, $3, $4, $5) RETURNING id';
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
    // A member and a viewer cannot file a connection; an admin can (in a transaction rolled back here).
    for (const who of [member, viewer]) {
      await expect(asRole(who, (c) => c.query(insertSql, [orgId, entity, channel, 'einvoice_sandbox', '0123456798']))).rejects.toMatchObject({ code: '42501' });
    }
    expect(await asRole(adminUser, async (c) => (await c.query(insertSql, [orgId, entity, channel, 'einvoice_sandbox', '0123456798'])).rowCount)).toBe(1);
    // A row of the org: everyone reads it, a member or viewer changes and deletes nothing, an admin changes the last test and nothing else, and may delete it.
    const id = String((await rows<{ id: string }>(insertSql, [orgId, entity, channel, 'einvoice_sandbox', '0123456798']))[0]?.id);
    for (const who of [member, viewer, adminUser, owner]) expect(await asRole(who, async (c) => (await c.query('SELECT 1 FROM crove_finance.einvoice_connection WHERE org_id = $1 AND id = $2', [orgId, id])).rowCount)).toBe(1);
    const setState = "UPDATE crove_finance.einvoice_connection SET last_test_state = 'works', last_tested_at = now() WHERE org_id = $1 AND id = $2";
    for (const who of [member, viewer]) {
      expect(await asRole(who, async (c) => (await c.query(setState, [orgId, id])).rowCount)).toBe(0);
      expect(await asRole(who, async (c) => (await c.query('DELETE FROM crove_finance.einvoice_connection WHERE org_id = $1 AND id = $2', [orgId, id])).rowCount)).toBe(0);
    }
    for (const who of [adminUser, owner]) {
      expect(await asRole(who, async (c) => (await c.query(setState, [orgId, id])).rowCount)).toBe(1);
      for (const column of ["seller_tax_code = '0123456797'", "provider = 'einvoice_other'", `legal_entity_id = '${randomUUID()}'`, `channel_connection_id = '${randomUUID()}'`, "created_at = now()"]) {
        await expect(asRole(who, (c) => c.query(`UPDATE crove_finance.einvoice_connection SET ${column} WHERE org_id = $1 AND id = $2`, [orgId, id]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
      }
    }
    expect(await asRole(adminUser, async (c) => (await c.query('DELETE FROM crove_finance.einvoice_connection WHERE org_id = $1 AND id = $2', [orgId, id])).rowCount)).toBe(1);
    await rows('DELETE FROM crove_finance.einvoice_connection WHERE org_id = $1 AND id = $2', [orgId, id]);
  });

  it('holds the row rules in SQL: the provider is the channel connection\'s, the tax code the entity\'s, and no tenant role changes the rest', async () => {
    const entity = await defaultEntity();
    const channelId = randomUUID();
    await rows(
      `INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'einvoice_sandbox', $3, 'Thử', $4)`,
      [orgId, channelId, `guard-${randomUUID()}`, owner.userId],
    );
    const insert = (provider: string, taxCode: string, entityId = entity) =>
      rows('INSERT INTO crove_finance.einvoice_connection (org_id, legal_entity_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, $3, $4, $5)', [orgId, entityId, channelId, provider, taxCode]);
    await expect(insert('einvoice_misa', TAX_CODE)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('EINVOICE_CONNECTION_PROVIDER') });
    await expect(insert('einvoice_sandbox', '0123456789')).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('EINVOICE_CONNECTION_TAX_CODE') });
    await expect(insert('sandbox', TAX_CODE)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('EINVOICE_CONNECTION_PROVIDER') });
    // An entity with no tax code of its own leaves the shape to the CHECKs.
    const bare = String((await rows<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh trống', 'branch', $2) RETURNING id`, [orgId, owner.userId]))[0]?.id);
    await expect(insert('einvoice_sandbox', 'abc', bare)).rejects.toMatchObject({ code: '23514' });
    await insert('einvoice_sandbox', '0123456789', bare);
    const { id } = only(await rows<{ id: string }>('SELECT id FROM crove_finance.einvoice_connection WHERE org_id = $1 AND channel_connection_id = $2', [orgId, channelId]));
    // One connection per entity, provider and tax code, and one per channel connection.
    const second = randomUUID();
    await rows(`INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'einvoice_sandbox', $3, 'Thử hai', $4)`, [orgId, second, `guard-${randomUUID()}`, owner.userId]);
    await expect(rows('INSERT INTO crove_finance.einvoice_connection (org_id, legal_entity_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, $3, $4, $5)', [orgId, bare, second, 'einvoice_sandbox', '0123456789'])).rejects.toMatchObject({ code: '23505' });
    await expect(rows('INSERT INTO crove_finance.einvoice_connection (org_id, legal_entity_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, $3, $4, $5)', [orgId, bare, channelId, 'einvoice_sandbox', '0123456780'])).rejects.toMatchObject({ code: '23505' });
    // The test state and its time go together, from the list of states only.
    await expect(rows("UPDATE crove_finance.einvoice_connection SET last_test_state = 'works' WHERE org_id = $1 AND id = $2", [orgId, id])).rejects.toMatchObject({ code: '23514' });
    await expect(rows("UPDATE crove_finance.einvoice_connection SET last_test_state = 'broken', last_tested_at = now() WHERE org_id = $1 AND id = $2", [orgId, id])).rejects.toMatchObject({ code: '23514' });
    await rows("DELETE FROM crove_finance.einvoice_connection WHERE org_id = $1 AND id = $2", [orgId, id]);
  });
});

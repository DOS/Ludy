// SPDX-License-Identifier: AGPL-3.0-only
// The check of a MISA AMIS connection's vouchers against the firm's catalogue (#4112, S3a of #4103), on a real PostgreSQL 17: who may ask, one waiting check per connection (a second press returns it),
// the worker's record (system only, replaces the results whole, refuses a malformed one), what the preview and the push read back, and that a disconnect takes the check and its results with it.
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
const SECRET = 'test-only-jwt-secret-for-misa-amis-match-0123456789';
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

const suite = ADMIN ? describe : describe.skip;

suite('MISA AMIS catalogue match (#4112)', () => {
  const dbName = `crove_test_misa_amis_match_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const owner: Account = { subject: randomUUID(), email: 'owner@misa-amis-match.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@misa-amis-match.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@misa-amis-match.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@misa-amis-match.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@misa-amis-match.test', session: randomUUID(), userId: '' };
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


  const SYSTEM = { type: 'system' as const, component: 'finance.misa_amis' };
  const ASK = { kind: 'purchase_services', from: '2026-10-01', to: '2026-10-31', serviceItemCode: 'DV_CHUNG' } as const;
  let connectionId = '';
  let entityId = '';
  const events = async () => (await rows<{ payload: { connection_id?: string } }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.misa_amis_match.check_requested' ORDER BY id", [orgId])).map((r) => r.payload);
  const checkRow = async () => (await rows<{ state: string; failure: string | null; params: Record<string, unknown>; finished_at: Date | null; requested_by: string | null }>('SELECT state, failure, params, finished_at, requested_by FROM crove_finance.misa_amis_match_check WHERE org_id = $1', [orgId]))[0];
  const results = (who: Account) => api.query<{ connectionId: string | null; status: { state: string; failure: string | null; requestedAt: string | null; checkedAt: string | null }; partyCodes: Map<string, string> | null; itemCodes: Set<string> | null }>('finance.misa_amis_match.results', {}, { actor: asUser(who), orgId });
  const requestedAt = async () => new Date((await rows<{ requested_at: Date }>('SELECT requested_at FROM crove_finance.misa_amis_match_check WHERE org_id = $1', [orgId]))[0]!.requested_at).toISOString();
  const record = async (input: Record<string, unknown>) => worker.execute('finance.misa_amis_match.record_check', { connectionId, requestedAt: await requestedAt(), ...input }, { actor: SYSTEM, orgId });

  it('connects the fixture connection', async () => {
    const connected = await call('connections/connect', owner, connectInput());
    expect(connected.status).toBe(200);
    connectionId = String(connected.body.id);
    entityId = await defaultEntity();
  });

  it('files a request for an owner or admin only, queues the worker once, and answers a second press with the one that waits', async () => {
    for (const who of [member, viewer]) expect((await call('matches/check', who, { id: connectionId, ask: ASK })).status).toBe(403);
    expect(await checkRow()).toBeUndefined();
    const first = await call('matches/check', adminUser, { id: connectionId, ask: ASK });
    expect(first).toMatchObject({ status: 200, body: { queued: true, running: false } });
    // The request keeps the batch asked about, the entity filled in from the connection, and who asked; the event carries the connection id and nothing else.
    expect(await checkRow()).toMatchObject({ state: 'requested', failure: null, finished_at: null, requested_by: adminUser.userId, params: { ...ASK, legalEntityId: entityId } });
    expect(await events()).toEqual([{ connection_id: connectionId }]);
    // A second press while the first waits returns it: no second event, the row unchanged.
    expect(await call('matches/check', owner, { id: connectionId, ask: ASK })).toMatchObject({ status: 200, body: { queued: false, running: true } });
    expect(await events()).toHaveLength(1);
    expect((await checkRow())?.requested_by).toBe(adminUser.userId);
  });

  it('asks again once the waiting check is older than ten minutes (a lost job must not block the connection for ever)', async () => {
    await rows("UPDATE crove_finance.misa_amis_match_check SET requested_at = now() - interval '11 minutes' WHERE org_id = $1", [orgId]);
    expect(await call('matches/check', owner, { id: connectionId, ask: { ...ASK, kind: 'sales', salesItemCode: 'BH_CHUNG' } })).toMatchObject({ status: 200, body: { queued: true, running: false } });
    expect(await events()).toHaveLength(2);
    expect(await checkRow()).toMatchObject({ state: 'requested', requested_by: owner.userId, params: { kind: 'sales', salesItemCode: 'BH_CHUNG' } });
  });

  it('answers a press for another batch by filing it anew, shows a check only for the batch it was asked about, and ignores a record of an older request', async () => {
    // The waiting check is the sales batch of the test above (its whole ask: the period and the codes are part of the batch).
    const asked = { ...ASK, kind: 'sales' as const, salesItemCode: 'BH_CHUNG' };
    // The check waiting is for the sales batch (the test above): the same ask returns it, another batch files anew.
    expect(await call('matches/check', owner, { id: connectionId, ask: asked })).toMatchObject({ status: 200, body: { queued: false, running: true } });
    const before = await events();
    expect(await call('matches/check', owner, { id: connectionId, ask: ASK })).toMatchObject({ status: 200, body: { queued: true, running: false } });
    expect(await events()).toHaveLength(before.length + 1);
    // A check for the purchase batch tells nothing about the sales batch.
    const other = await api.query<{ status: { state: string } }>('finance.misa_amis_match.results', { ask: asked }, { actor: asUser(owner), orgId });
    expect(other.status.state).toBe('none');
    // A job that took the older request records with its time: ignored.
    const stale = new Date(Date.now() - 3_600_000).toISOString();
    expect(await record({ requestedAt: stale, state: 'done', failure: null, results: [] })).toMatchObject({ recorded: false });
    expect((await checkRow())?.state).toBe('requested');
  });

  it('refuses where the connector is off, for a connection that is not there, and for an ask about another entity', async () => {
    await expect(call('matches/check', owner, { id: connectionId, ask: ASK }, offApp)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_DISABLED' } });
    await expect(call('matches/check', owner, { id: randomUUID(), ask: ASK })).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_CONNECTION_NOT_FOUND' } });
    const other = randomUUID();
    await rows("INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh khác', 'branch', $3)", [orgId, other, owner.userId]);
    await expect(call('matches/check', owner, { id: connectionId, ask: { ...ASK, legalEntityId: other } })).resolves.toMatchObject({ status: 422, body: { code: 'MISA_AMIS_MATCH_ENTITY' } });
    // Another org cannot see this connection at all.
    await expect(call('matches/check', outsider, { id: connectionId, ask: ASK }, app, otherSlug)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_CONNECTION_NOT_FOUND' } });
  });

  it('hands the worker the waiting check with its batch, and the worker alone: a user is refused the target and the record', async () => {
    const target = await worker.query('finance.misa_amis_match.check_target', { id: connectionId }, { actor: SYSTEM, orgId });
    expect(target).toMatchObject({ action: 'check', id: connectionId, legalEntityId: entityId, ask: { kind: 'purchase_services', serviceItemCode: 'DV_CHUNG', legalEntityId: entityId } });
    await expect(api.query('finance.misa_amis_match.check_target', { id: connectionId }, { actor: asUser(owner), orgId })).rejects.toMatchObject({ status: 403 });
    await expect(api.execute('finance.misa_amis_match.record_check', { connectionId, requestedAt: new Date().toISOString(), state: 'done', failure: null, results: [] }, { actor: asUser(owner), orgId })).rejects.toMatchObject({ status: 403 });
    expect((await checkRow())?.state).toBe('requested');
  });

  it('refuses a record that is malformed: a failure on a done check, a failed check with results or no reason, a result twice, a match with no code', async () => {
    const res = { kind: 'party', ref: '0101234564', state: 'unknown', code: null, entryId: null };
    await expect(record({ state: 'done', failure: 'credentials', results: [] })).rejects.toMatchObject({ code: 'MISA_AMIS_MATCH_INVALID' });
    await expect(record({ state: 'failed', failure: null, results: [] })).rejects.toMatchObject({ code: 'MISA_AMIS_MATCH_INVALID' });
    await expect(record({ state: 'failed', failure: 'unreachable', results: [res] })).rejects.toMatchObject({ code: 'MISA_AMIS_MATCH_INVALID' });
    await expect(record({ state: 'done', failure: null, results: [res, res] })).rejects.toMatchObject({ code: 'MISA_AMIS_MATCH_INVALID' });
    await expect(record({ state: 'done', failure: null, results: [{ ...res, state: 'matched' }] })).rejects.toMatchObject({ code: 'MISA_AMIS_MATCH_INVALID' });
    expect((await checkRow())?.state).toBe('requested');
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_match WHERE org_id = $1', [orgId])).toEqual([]);
  });

  it('records a done check: the results and the time, read back by every member as the codes the preview and the push write, and nothing but codes and ids stored', async () => {
    const entry = randomUUID();
    const done = await record({
      state: 'done',
      failure: null,
      results: [
        { kind: 'party', ref: '0101234564', state: 'matched', code: 'NCC_ABC', entryId: entry },
        { kind: 'party', ref: '0312345678', state: 'ambiguous', code: null, entryId: null },
        { kind: 'party', ref: '0999999999', state: 'unknown', code: null, entryId: null },
        { kind: 'item', ref: 'BH_CHUNG', state: 'matched', code: 'BH_CHUNG', entryId: null },
      ],
    });
    expect(done).toEqual({ recorded: true, results: 4 });
    expect(await checkRow()).toMatchObject({ state: 'done', failure: null });
    for (const who of [owner, adminUser, member, viewer]) {
      const read = await results(who);
      expect(read.connectionId).toBe(connectionId);
      expect(read.status).toMatchObject({ state: 'done', failure: null, checkedAt: expect.any(String) });
      expect(read.partyCodes).toEqual(new Map([['0101234564', 'NCC_ABC']]));
      expect(read.itemCodes).toEqual(new Set(['BH_CHUNG']));
    }
    // The stored rows hold a reference, a state, the matched entry's code and id: no column for a name, an address or a tax code of the catalogue.
    const columns = (await rows<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'crove_finance' AND table_name = 'misa_amis_match' ORDER BY ordinal_position")).map((r) => r.column_name);
    expect(columns).toEqual(['org_id', 'id', 'legal_entity_id', 'connection_id', 'kind', 'match_key', 'state', 'catalogue_code', 'catalogue_id', 'checked_at']);
    // The worker's target now says there is nothing waiting, and a second record of the same check changes nothing.
    expect(await worker.query('finance.misa_amis_match.check_target', { id: connectionId }, { actor: SYSTEM, orgId })).toEqual({ action: 'none', reason: 'not_requested' });
    expect(await record({ state: 'done', failure: null, results: [] })).toEqual({ recorded: false, results: 0 });
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_match WHERE org_id = $1', [orgId])).toHaveLength(4);
    // The audit row of the record names counts, no tax code, no code.
    const audit = await rows<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.misa_amis_match.record_check'", [orgId]);
    expect(JSON.stringify(audit)).not.toMatch(/0101234564|NCC_ABC/);
  });

  it('replaces the results whole with the next done check, and a failed check keeps the earlier ones and says why', async () => {
    expect(await call('matches/check', owner, { id: connectionId, ask: ASK })).toMatchObject({ body: { queued: true } });
    // While it waits, the earlier results still stand: asking again does not lift a block the last check raised.
    const waiting = await results(member);
    expect(waiting.status.state).toBe('requested');
    expect(waiting.partyCodes).toEqual(new Map([['0101234564', 'NCC_ABC']]));
    expect(await record({ state: 'done', failure: null, results: [{ kind: 'party', ref: '0312345678', state: 'matched', code: 'KH_B', entryId: null }] })).toEqual({ recorded: true, results: 1 });
    expect((await results(member)).partyCodes).toEqual(new Map([['0312345678', 'KH_B']]));
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_match WHERE org_id = $1', [orgId])).toHaveLength(1);
    await rows("UPDATE crove_finance.misa_amis_match_check SET requested_at = now() - interval '11 minutes' WHERE org_id = $1", [orgId]);
    expect(await call('matches/check', owner, { id: connectionId, ask: ASK })).toMatchObject({ body: { queued: true } });
    expect(await record({ state: 'failed', failure: 'catalogue_too_large', results: [] })).toEqual({ recorded: true, results: 0 });
    const failed = await results(owner);
    expect(failed.status).toMatchObject({ state: 'failed', failure: 'catalogue_too_large', checkedAt: null });
    // The failed re-check changed none of the stored results.
    expect(failed.partyCodes).toEqual(new Map([['0312345678', 'KH_B']]));
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_match WHERE org_id = $1', [orgId])).toHaveLength(1);
  });

  it('is the entity\'s alone: another org reads no check, and a disconnect takes the check and its results with the connection', async () => {
    const none = await api.query<{ connectionId: string | null; status: { state: string } }>('finance.misa_amis_match.results', {}, { actor: asUser(outsider), orgId: otherOrgId });
    expect(none).toMatchObject({ connectionId: null, status: { state: 'none' } });
    await rows("UPDATE crove_finance.misa_amis_match_check SET state = 'requested', failure = NULL, finished_at = NULL WHERE org_id = $1", [orgId]);
    await record({ state: 'done', failure: null, results: [{ kind: 'item', ref: 'DV_CHUNG', state: 'unknown', code: null, entryId: null }] });
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_match WHERE org_id = $1', [orgId])).toHaveLength(1);
    expect((await call('connections/disconnect', owner, { id: connectionId })).status).toBe(200);
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_match_check WHERE org_id = $1', [orgId])).toEqual([]);
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_match WHERE org_id = $1', [orgId])).toEqual([]);
  });
});

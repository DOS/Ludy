// SPDX-License-Identifier: AGPL-3.0-only
// The check of a MISA AMIS connection's vouchers against the firm's catalogue (#4112, S3a of #4103), on a real PostgreSQL 17: who may ask, one waiting check per connection (a second press returns it),
// the worker's record (system only, replaces the results whole, refuses a malformed one), what the preview and the push read back, and that a disconnect takes the check and its results with it.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { kernelCommands, kernelQueries } from '@ludy/kernel';
import { CredentialVault, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';
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
  let aspOnlyApp: ReturnType<typeof createHttpApp>;
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


  const SYSTEM = { type: 'system' as const, component: 'finance.misa_amis' };
  const ASK = { kind: 'purchase_services', from: '2026-10-01', to: '2026-10-31', serviceItemCode: 'DV_CHUNG' } as const;
  let connectionId = '';
  let entityId = '';
  const events = async () => (await rows<{ payload: { connection_id?: string } }>("SELECT payload FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.misa_amis_match.check_requested' ORDER BY id", [orgId])).map((r) => r.payload);
  const checkRow = async () => (await rows<{ state: string; failure: string | null; params: Record<string, unknown>; finished_at: Date | null; requested_by: string | null }>('SELECT state, failure, params, finished_at, requested_by FROM ludy_finance.misa_amis_match_check WHERE org_id = $1', [orgId]))[0];
  const results = (who: Account) => api.query<{ connectionId: string | null; status: { state: string; failure: string | null; requestedAt: string | null; checkedAt: string | null }; partyCodes: Map<string, string> | null; partyAmbiguous: Set<string> | null; itemCodes: Set<string> | null; partyNameCodes: Map<string, string> | null; unitIds: Map<string, { name: string; id: string }> | null; unitAmbiguous: Set<string> | null; stockIds: Map<string, string> | null; itemIds: Map<string, string> | null; product?: string }>('finance.misa_amis_match.results', {}, { actor: asUser(who), orgId });
  const requestedAt = async () => new Date((await rows<{ requested_at: Date }>('SELECT requested_at FROM ludy_finance.misa_amis_match_check WHERE org_id = $1', [orgId]))[0]!.requested_at).toISOString();
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
    await rows("UPDATE ludy_finance.misa_amis_match_check SET requested_at = now() - interval '11 minutes' WHERE org_id = $1", [orgId]);
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
    await rows("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh khác', 'branch', $3)", [orgId, other, owner.userId]);
    await expect(call('matches/check', owner, { id: connectionId, ask: { ...ASK, legalEntityId: other } })).resolves.toMatchObject({ status: 422, body: { code: 'MISA_AMIS_MATCH_ENTITY' } });
    // Another org cannot see this connection at all.
    await expect(call('matches/check', outsider, { id: connectionId, ask: ASK }, app, otherSlug)).resolves.toMatchObject({ status: 404, body: { code: 'MISA_AMIS_CONNECTION_NOT_FOUND' } });
  });

  it('hands the worker the waiting check with its batch, and the worker alone: a user is refused the target and the record', async () => {
    const target = await worker.query('finance.misa_amis_match.check_target', { id: connectionId }, { actor: SYSTEM, orgId });
    expect(target).toMatchObject({ action: 'check', id: connectionId, product: 'amis', legalEntityId: entityId, ask: { kind: 'purchase_services', serviceItemCode: 'DV_CHUNG', legalEntityId: entityId } });
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
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_match WHERE org_id = $1', [orgId])).toEqual([]);
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
      // The party the check found several active entries for is read back apart from the one it found none for (#4114): the preview names the two with different blockers.
      expect(read.partyAmbiguous).toEqual(new Set(['0312345678']));
      expect(read.itemCodes).toEqual(new Set(['BH_CHUNG']));
    }
    // The stored rows hold a reference, a state, the matched entry's code and id: no column for a name, an address or a tax code of the catalogue.
    const columns = (await rows<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'ludy_finance' AND table_name = 'misa_amis_match' ORDER BY ordinal_position")).map((r) => r.column_name);
    // Plus, since S3b (#4124), the name of a proposal (on that row alone) and who confirmed a name and when.
    expect(columns).toEqual(['org_id', 'id', 'legal_entity_id', 'connection_id', 'kind', 'match_key', 'state', 'catalogue_code', 'catalogue_id', 'checked_at', 'candidate_name', 'confirmed_by', 'confirmed_at']);
    // The worker's target now says there is nothing waiting, and a second record of the same check changes nothing.
    expect(await worker.query('finance.misa_amis_match.check_target', { id: connectionId }, { actor: SYSTEM, orgId })).toEqual({ action: 'none', reason: 'not_requested' });
    expect(await record({ state: 'done', failure: null, results: [] })).toEqual({ recorded: false, results: 0 });
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_match WHERE org_id = $1', [orgId])).toHaveLength(4);
    // The audit row of the record names counts, no tax code, no code.
    const audit = await rows<{ detail: unknown }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.misa_amis_match.record_check'", [orgId]);
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
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_match WHERE org_id = $1', [orgId])).toHaveLength(1);
    await rows("UPDATE ludy_finance.misa_amis_match_check SET requested_at = now() - interval '11 minutes' WHERE org_id = $1", [orgId]);
    expect(await call('matches/check', owner, { id: connectionId, ask: ASK })).toMatchObject({ body: { queued: true } });
    expect(await record({ state: 'failed', failure: 'catalogue_too_large', results: [] })).toEqual({ recorded: true, results: 0 });
    const failed = await results(owner);
    expect(failed.status).toMatchObject({ state: 'failed', failure: 'catalogue_too_large', checkedAt: null });
    // The failed re-check changed none of the stored results.
    expect(failed.partyCodes).toEqual(new Map([['0312345678', 'KH_B']]));
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_match WHERE org_id = $1', [orgId])).toHaveLength(1);
  });

  it('keeps a connection checked while a re-check waits or fails, even when its check had nothing to look up (no stored result): the sets are empty, never null', async () => {
    await rows("UPDATE ludy_finance.misa_amis_match_check SET state = 'requested', failure = NULL WHERE org_id = $1", [orgId]);
    expect(await record({ state: 'done', failure: null, results: [] })).toEqual({ recorded: true, results: 0 });
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_match WHERE org_id = $1', [orgId])).toEqual([]);
    expect(await call('matches/check', owner, { id: connectionId, ask: ASK })).toMatchObject({ body: { queued: true } });
    const waiting = await results(member);
    expect(waiting.status.state).toBe('requested');
    expect(waiting.partyCodes).toEqual(new Map());
    expect(waiting.itemCodes).toEqual(new Set());
    expect(await record({ state: 'failed', failure: 'unreachable', results: [] })).toEqual({ recorded: true, results: 0 });
    const failed = await results(member);
    expect(failed.status).toMatchObject({ state: 'failed', failure: 'unreachable', checkedAt: null });
    expect(failed.partyCodes).toEqual(new Map());
  });

  // Name proposals (#4124, S3b): a party with no tax code, found in the catalogue by name, and a person's decision.
  describe('name proposals', () => {
    const partyIds: string[] = [];
    const entry = randomUUID();
    const askAgain = async () => {
      await rows("UPDATE ludy_finance.misa_amis_match_check SET requested_at = now() - interval '11 minutes' WHERE org_id = $1", [orgId]);
      expect(await call('matches/check', owner, { id: connectionId, ask: ASK })).toMatchObject({ body: { queued: true } });
    };
    const nameRows = () =>
      rows<{ match_key: string; state: string; catalogue_code: string | null; candidate_name: string | null; confirmed_by: string | null; confirmed_at: Date | null }>(
        "SELECT match_key, state, catalogue_code, candidate_name, confirmed_by, confirmed_at FROM ludy_finance.misa_amis_match WHERE org_id = $1 AND kind = 'party_name' ORDER BY match_key",
        [orgId],
      );
    const proposal = (ref: string, code: string, candidateName: string) => ({ kind: 'party_name', ref, state: 'name_proposal', code, entryId: entry, candidateName });
    // What a person's decision carries: the row on screen and the code of the candidate on it.
    const rowOf = async (partyId: string) => String((await rows<{ id: string }>("SELECT id FROM ludy_finance.misa_amis_match WHERE org_id = $1 AND kind = 'party_name' AND match_key = $2", [orgId, partyId]))[0]?.id);
    const decision = async (partyId: string, candidateCode: string, over: Record<string, unknown> = {}) => ({ connectionId, partyId, proposalId: await rowOf(partyId), candidateCode, ...over });

    it('records what a name match found: a proposal with its name on that row alone, several as ambiguous, and nothing for none; a proposal is no match', async () => {
      for (const name of ['Hộ kinh doanh Hoa Sen', 'Hộ kinh doanh Hoa Mai', 'Hộ kinh doanh Hoa Lan', 'Hộ kinh doanh Hoa Cúc']) {
        partyIds.push(String((await rows<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name, source_trust) VALUES ($1, $2, 'external') RETURNING id", [orgId, name]))[0]?.id));
      }
      const [p1, p2, p3] = partyIds as [string, string, string];
      await askAgain();
      expect(
        await record({
          state: 'done',
          failure: null,
          results: [proposal(p1, 'KH_HS', 'Hoa Sen (HKD)'), { kind: 'party_name', ref: p2, state: 'ambiguous', code: null, entryId: null }, { kind: 'party_name', ref: p3, state: 'unknown', code: null, entryId: null }],
        }),
      ).toEqual({ recorded: true, results: 3 });
      // `unknown` for a party that was not confirmed is no row: the party has none, which is the same thing.
      expect(await nameRows()).toEqual([
        { match_key: p1, state: 'name_proposal', catalogue_code: 'KH_HS', candidate_name: 'Hoa Sen (HKD)', confirmed_by: null, confirmed_at: null },
        { match_key: p2, state: 'ambiguous', catalogue_code: null, candidate_name: null, confirmed_by: null, confirmed_at: null },
      ].sort((a, b) => a.match_key.localeCompare(b.match_key)));
      const read = await results(member);
      expect(read.status.state).toBe('done');
      // Nothing is matched by a proposal: no code for the party until a person confirms it.
      expect(read.partyNameCodes).toEqual(new Map());
      expect(read.partyCodes).toEqual(new Map());
      // The candidate's name is in no audit row, no event and no outbox payload.
      for (const table of ['ludy_kernel.audit_event', 'ludy_kernel.outbox_event']) expect(await rows(`SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t::text LIKE '%Hoa Sen (HKD)%'`, [orgId]), table).toEqual([]);
    });

    it('refuses a name result that does not fit its kind or its state, in the command and in the table', async () => {
      const [p1] = partyIds as [string];
      await askAgain();
      const bad = [
        { ...proposal(p1, 'KH', 'x'), candidateName: null },
        { ...proposal(p1, 'KH', 'x'), code: null },
        { kind: 'party_name', ref: p1, state: 'matched', code: 'KH', entryId: null },
        { kind: 'party_name', ref: p1, state: 'ambiguous', code: null, entryId: null, candidateName: 'x' },
        { kind: 'party', ref: '0101234564', state: 'name_proposal', code: 'KH', entryId: null, candidateName: 'x' },
        { kind: 'item', ref: 'DV_CHUNG', state: 'confirmed', code: 'KH', entryId: null },
      ];
      for (const result of bad) await expect(record({ state: 'done', failure: null, results: [result] }), JSON.stringify(result)).rejects.toMatchObject({ code: 'MISA_AMIS_MATCH_INVALID' });
      // The table says the same to a caller that bypasses the command.
      const insert = (kind: string, key: string, state: string, code: string | null, name: string | null) =>
        rows('INSERT INTO ludy_finance.misa_amis_match (org_id, legal_entity_id, connection_id, kind, match_key, state, catalogue_code, candidate_name) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [orgId, entityId, connectionId, kind, key, state, code, name]);
      await expect(insert('party_name', randomUUID(), 'name_proposal', 'KH', null)).rejects.toThrow(/misa_amis_match_found_ck/);
      await expect(insert('party_name', randomUUID(), 'confirmed', 'KH', 'a name')).rejects.toThrow(/misa_amis_match_found_ck/);
      // A confirmed row has the time it was confirmed.
      await expect(insert('party_name', randomUUID(), 'confirmed', 'KH', null)).rejects.toThrow(/misa_amis_match_found_ck/);
      await expect(insert('party_name', 'not-a-uuid', 'ambiguous', null, null)).rejects.toThrow(/misa_amis_match_key_ck/);
      await expect(insert('party', '0101234564', 'name_proposal', 'KH', 'a name')).rejects.toThrow(/misa_amis_match_found_ck/);
      await expect(insert('person', 'x', 'unknown', null, null)).rejects.toThrow(/misa_amis_match_kind_ck/);
      await expect(insert('party_name', randomUUID(), 'name_proposal', 'KH', 'x'.repeat(201))).rejects.toThrow(/misa_amis_match_name_ck/);
      // The record that was refused left the rows as they were.
      expect((await nameRows()).map((r) => r.state).sort()).toEqual(['ambiguous', 'name_proposal']);
      await record({ state: 'done', failure: null, results: [proposal(partyIds[0] as string, 'KH_HS', 'Hoa Sen (HKD)'), { kind: 'party_name', ref: partyIds[1] as string, state: 'ambiguous', code: null, entryId: null }] });
    });

    it('lets only a person make a confirmed row: a tenant insert of one is a user\'s, in their own name and with the time, and the system context (the worker) never inserts one', async () => {
      const [, , , p4] = partyIds as [string, string, string, string];
      const insertConfirmed = (by: string | null, at: string | null, key = p4) =>
        `INSERT INTO ludy_finance.misa_amis_match (org_id, legal_entity_id, connection_id, kind, match_key, state, catalogue_code, confirmed_by, confirmed_at) VALUES ('${orgId}', '${entityId}', '${connectionId}', 'party_name', '${key}', 'confirmed', 'KH_X', ${by === null ? 'NULL' : `'${by}'`}, ${at === null ? 'NULL' : `'${at}'::timestamptz`})`;
      const asOwner = (statement: string) =>
        admin(async (c) => {
          await c.query('BEGIN');
          try {
            await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(owner.userId, orgId)]);
            await c.query('SET LOCAL ROLE ludy_tenant');
            await c.query(statement);
            return 'inserted';
          } catch (error) {
            return String((error as Error).message);
          } finally {
            await c.query('ROLLBACK');
          }
        });
      const asSystem = async (statement: string) => {
        const c = await workerPool.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [orgId]);
          await c.query(statement);
          return 'inserted';
        } catch (error) {
          return String((error as Error).message);
        } finally {
          await c.query('ROLLBACK').catch(() => {});
          c.release();
        }
      };
      const now = new Date().toISOString();
      // An owner's own insert, in their own name and with the time, is the one a tenant role may make; the name of another member, none, or no time is refused.
      expect(await asOwner(insertConfirmed(owner.userId, now))).toBe('inserted');
      expect(await asOwner(insertConfirmed(adminUser.userId, now))).toMatch(/MISA_AMIS_MATCH_CONFIRMED/);
      expect(await asOwner(insertConfirmed(null, now))).toMatch(/MISA_AMIS_MATCH_CONFIRMED/);
      expect(await asOwner(insertConfirmed(owner.userId, null))).toMatch(/misa_amis_match_found_ck|MISA_AMIS_MATCH_CONFIRMED/);
      // The worker's system context never inserts a confirmed row, whoever it names; it still inserts what a check finds.
      expect(await asSystem(insertConfirmed(owner.userId, now))).toMatch(/MISA_AMIS_MATCH_CONFIRMED/);
      expect(await asSystem(insertConfirmed(null, now))).toMatch(/MISA_AMIS_MATCH_CONFIRMED/);
      expect(await asSystem(`INSERT INTO ludy_finance.misa_amis_match (org_id, legal_entity_id, connection_id, kind, match_key, state) VALUES ('${orgId}', '${entityId}', '${connectionId}', 'party', '0309999990', 'unknown')`)).toBe('inserted');
      expect(await nameRows()).toHaveLength(2);
    });

    it('shows the proposals to an owner or admin only, with the names as the party and the catalogue have them', async () => {
      const [p1] = partyIds as [string];
      for (const who of [member, viewer]) expect((await call('matches/proposals', who, { connectionId })).status, who.userId).toBe(403);
      expect((await call('matches/proposals', outsider, { connectionId })).status).not.toBe(200);
      for (const who of [owner, adminUser]) {
        const listed = await call('matches/proposals', who, { connectionId });
        expect(listed.status).toBe(200);
        expect(listed.body).toEqual([{ id: await rowOf(p1), partyId: p1, partyName: 'Hộ kinh doanh Hoa Sen', candidateName: 'Hoa Sen (HKD)', candidateCode: 'KH_HS', checkedAt: expect.any(String) }]);
      }
      expect((await call('matches/proposals', owner, { connectionId }, offApp)).status).toBe(404);
      // The connector asked for is the one of the connection's product: an AMIS connection on a deployment that has ASP only is as off as on one with none, for the list and for both decisions.
      for (const [route, input] of [['matches/proposals', { connectionId }], ['matches/confirmName', await decision(p1, 'KH_HS')], ['matches/rejectName', await decision(p1, 'KH_HS')]] as const) {
        expect(await call(route, owner, input, aspOnlyApp), route).toMatchObject({ status: 404, body: { code: 'MISA_AMIS_DISABLED' } });
      }
    });

    it('confirms a proposal: the code stays, the candidate name goes, who and when are kept, the party then has its code; it takes an owner or admin and a proposal that is still there', async () => {
      const [p1, p2] = partyIds as [string, string];
      for (const who of [member, viewer]) expect((await call('matches/confirmName', who, await decision(p1, 'KH_HS'))).status).toBe(403);
      expect(await nameRows()).toHaveLength(2);
      const gone = { status: 409, body: { code: 'MISA_AMIS_NAME_PROPOSAL_GONE' } };
      // An ambiguous row, a party with no row and a connection that is not there are not proposals to confirm.
      expect(await call('matches/confirmName', owner, await decision(p2, 'KH_HS'))).toMatchObject(gone);
      expect(await call('matches/confirmName', owner, { connectionId, partyId: randomUUID(), proposalId: randomUUID(), candidateCode: 'KH_HS' })).toMatchObject(gone);
      expect(await call('matches/confirmName', owner, { ...(await decision(p1, 'KH_HS')), connectionId: randomUUID() })).toMatchObject({ status: 404, body: { code: 'MISA_AMIS_CONNECTION_NOT_FOUND' } });
      // A decision is of the row and the candidate the person saw: another row id, another candidate's code, or another party's id is refused, and nothing changes.
      expect(await call('matches/confirmName', owner, await decision(p1, 'KH_KHAC'))).toMatchObject(gone);
      expect(await call('matches/confirmName', owner, await decision(p1, 'KH_HS', { proposalId: randomUUID() }))).toMatchObject(gone);
      expect(await call('matches/confirmName', owner, await decision(p1, 'KH_HS', { proposalId: await rowOf(p2) }))).toMatchObject(gone);
      expect(await call('matches/rejectName', owner, await decision(p1, 'KH_KHAC'))).toMatchObject(gone);
      expect((await nameRows()).find((r) => r.match_key === p1)).toMatchObject({ state: 'name_proposal', catalogue_code: 'KH_HS' });
      // The row the person saw is replaced by a newer check that proposes ANOTHER candidate for the same party: the old confirmation, for the old row and code, is refused.
      const seen = await decision(p1, 'KH_HS');
      await askAgain();
      await record({ state: 'done', failure: null, results: [proposal(p1, 'KH_MOI', 'Hoa Sen (mới)'), { kind: 'party_name', ref: p2, state: 'ambiguous', code: null, entryId: null }] });
      expect(await call('matches/confirmName', owner, seen)).toMatchObject(gone);
      expect((await nameRows()).find((r) => r.match_key === p1)).toMatchObject({ state: 'name_proposal', catalogue_code: 'KH_MOI' });
      await askAgain();
      await record({ state: 'done', failure: null, results: [proposal(p1, 'KH_HS', 'Hoa Sen (HKD)'), { kind: 'party_name', ref: p2, state: 'ambiguous', code: null, entryId: null }] });
      expect(await call('matches/confirmName', adminUser, await decision(p1, 'KH_HS'))).toMatchObject({ status: 200, body: { decided: true } });
      expect((await nameRows()).find((r) => r.match_key === p1)).toMatchObject({ state: 'confirmed', catalogue_code: 'KH_HS', candidate_name: null, confirmed_by: adminUser.userId, confirmed_at: expect.any(Date) });
      for (const who of [owner, member, viewer]) expect((await results(who)).partyNameCodes).toEqual(new Map([[p1, 'KH_HS']]));
      expect((await call('matches/proposals', owner, { connectionId })).body).toEqual([]);
      // Deciding twice finds nothing to decide; the name of the candidate is nowhere any more.
      expect(await call('matches/confirmName', owner, { connectionId, partyId: p1, proposalId: randomUUID(), candidateCode: 'KH_HS' })).toMatchObject(gone);
      expect(await rows("SELECT 1 FROM ludy_finance.misa_amis_match WHERE org_id = $1 AND candidate_name IS NOT NULL", [orgId])).toEqual([]);
      const audit = await rows<{ detail: unknown }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.misa_amis_match.confirm_name'", [orgId]);
      expect(audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(audit)).not.toMatch(/Hoa Sen|KH_HS/);
    });

    it('rejects a proposal by deleting it, and a later check may propose it again', async () => {
      const [, , p3] = partyIds as [string, string, string];
      await askAgain();
      await record({ state: 'done', failure: null, results: [proposal(p3, 'KH_HM', 'Hoa Mai (HKD)')] });
      for (const who of [member, viewer]) expect((await call('matches/rejectName', who, await decision(p3, 'KH_HM'))).status).toBe(403);
      const seen = await decision(p3, 'KH_HM');
      expect(await call('matches/rejectName', owner, seen)).toMatchObject({ status: 200, body: { decided: true } });
      expect((await nameRows()).filter((r) => r.match_key === p3)).toEqual([]);
      expect(await call('matches/rejectName', owner, seen)).toMatchObject({ status: 409, body: { code: 'MISA_AMIS_NAME_PROPOSAL_GONE' } });
      await askAgain();
      await record({ state: 'done', failure: null, results: [proposal(p3, 'KH_HM', 'Hoa Mai (HKD)')] });
      expect((await nameRows()).filter((r) => r.match_key === p3).map((r) => r.state)).toEqual(['name_proposal']);
    });

    it('keeps a confirmed name through the next check, hands it to the worker to check, and drops it when the worker says its code is gone; a proposal for a confirmed party is ignored', async () => {
      const [p1, , , p4] = partyIds as [string, string, string, string];
      await askAgain();
      expect(await worker.query('finance.misa_amis_match.check_target', { id: connectionId }, { actor: SYSTEM, orgId })).toMatchObject({ action: 'check', confirmed: [{ partyId: p1, code: 'KH_HS' }] });
      // The check finds a proposal for p4 and says p1's code still holds.
      await record({
        state: 'done',
        failure: null,
        results: [{ kind: 'party_name', ref: p1, state: 'confirmed', code: 'KH_HS', entryId: null }, proposal(p4, 'KH_HC', 'Hoa Cúc (HKD)')],
      });
      // The proposals of the earlier check are replaced whole (they are gone), p1 stays as it was confirmed, p4 is new.
      expect((await nameRows()).map((r) => [r.match_key, r.state, r.catalogue_code, r.candidate_name !== null])).toEqual(
        [[p1, 'confirmed', 'KH_HS', false], [p4, 'name_proposal', 'KH_HC', true]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      );
      expect((await nameRows()).find((r) => r.match_key === p1)?.confirmed_by).toBe(adminUser.userId);
      // A later check (wrongly) proposes another entry for p1, which a person already confirmed: the proposal is ignored and the confirmation stays.
      await askAgain();
      await record({ state: 'done', failure: null, results: [proposal(p1, 'KH_KHAC', 'Another')] });
      expect((await nameRows()).map((r) => [r.match_key, r.state, r.catalogue_code])).toEqual([[p1, 'confirmed', 'KH_HS']]);
      // The worker says p1's code is gone from the catalogue: the confirmation goes and the party is blocked again.
      await askAgain();
      await record({ state: 'done', failure: null, results: [{ kind: 'party_name', ref: p1, state: 'unknown', code: null, entryId: null }] });
      expect(await nameRows()).toEqual([]);
      expect((await results(owner)).partyNameCodes).toEqual(new Map());
    });

    it('a confirmation made while a check waits or runs makes that run\'s record a no-op, so a code no check verified is never shown as checked', async () => {
      const [p1] = partyIds as [string];
      await askAgain();
      await record({ state: 'done', failure: null, results: [proposal(p1, 'KH_HS', 'Hoa Sen (HKD)')] });
      await askAgain();
      // Even a request time ahead of the clock moves forward: a record of the run that took it can never match the new one.
      await rows("UPDATE ludy_finance.misa_amis_match_check SET requested_at = now() + interval '1 hour' WHERE org_id = $1", [orgId]);
      const taken = await requestedAt();
      expect(await call('matches/confirmName', owner, await decision(p1, 'KH_HS'))).toMatchObject({ body: { decided: true } });
      expect(new Date(await requestedAt()).getTime()).toBeGreaterThan(new Date(taken).getTime());
      // The run that took the earlier request records late: it read the confirmed names before this one existed, so its record is dropped.
      expect(await worker.execute('finance.misa_amis_match.record_check', { connectionId, requestedAt: taken, state: 'done', failure: null, results: [] }, { actor: SYSTEM, orgId })).toMatchObject({ recorded: false });
      expect(await rows("SELECT state FROM ludy_finance.misa_amis_match_check WHERE org_id = $1", [orgId])).toEqual([{ state: 'requested' }]);
      // The next run reads the confirmation and says its code is gone; the fixture is clean for the next test.
      await record({ state: 'done', failure: null, results: [{ kind: 'party_name', ref: p1, state: 'unknown', code: null, entryId: null }] });
      expect(await nameRows()).toEqual([]);
    });

    it('keeps a confirmed name when a check fails, as it keeps the other results', async () => {
      const [p1] = partyIds as [string];
      await askAgain();
      await record({ state: 'done', failure: null, results: [proposal(p1, 'KH_HS', 'Hoa Sen (HKD)')] });
      expect(await call('matches/confirmName', owner, await decision(p1, 'KH_HS'))).toMatchObject({ body: { decided: true } });
      await askAgain();
      await record({ state: 'failed', failure: 'unreachable', results: [] });
      expect((await results(owner)).partyNameCodes).toEqual(new Map([[p1, 'KH_HS']]));
      await askAgain();
      await record({ state: 'done', failure: null, results: [] });
      expect(await nameRows()).toHaveLength(1);
    });
  });

  it('records units and stocks (MISA ASP, #4125): their ids are read back apart from the item codes, and an unmatched or ambiguous unit has no id', async () => {
    const unitId = randomUUID();
    const stockId = randomUUID();
    expect(await call('matches/check', owner, { id: connectionId, ask: ASK })).toMatchObject({ body: { queued: true } });
    const done = await record({
      state: 'done',
      failure: null,
      results: [
        { kind: 'item', ref: 'HH1', state: 'matched', code: 'HH1', entryId: null },
        { kind: 'unit', ref: 'cái', state: 'matched', code: 'Cái', entryId: unitId },
        { kind: 'unit', ref: 'hộp', state: 'ambiguous', code: null, entryId: null },
        { kind: 'unit', ref: 'kg', state: 'unknown', code: null, entryId: null },
        { kind: 'stock', ref: 'KHO1', state: 'matched', code: 'KHO1', entryId: stockId },
        { kind: 'stock', ref: 'KHO2', state: 'unknown', code: null, entryId: null },
      ],
    });
    expect(done).toEqual({ recorded: true, results: 6 });
    const read = await results(owner);
    expect(read.itemCodes).toEqual(new Set(['HH1']));
    // The connection's product comes with the results, so the mapper knows whether to write ASP's ids; an item with no id has none to give.
    expect(read.product).toBe('amis');
    expect(read.itemIds).toEqual(new Map());
    expect(read.unitIds).toEqual(new Map([['cái', { name: 'Cái', id: unitId }]]));
    expect(read.unitAmbiguous).toEqual(new Set(['hộp']));
    expect(read.stockIds).toEqual(new Map([['KHO1', stockId]]));
    // A unit or a stock may not carry a name proposal or a confirmation: those are for a party with no tax code.
    expect(await call('matches/check', owner, { id: connectionId, ask: ASK })).toMatchObject({ body: { queued: true } });
    await expect(record({ state: 'done', failure: null, results: [{ kind: 'unit', ref: 'cái', state: 'name_proposal', code: 'Cái', entryId: unitId, candidateName: 'Cái' }] })).rejects.toThrow();
  });

  it('is the entity\'s alone: another org reads no check, and a disconnect takes the check and its results with the connection', async () => {
    const none = await api.query<{ connectionId: string | null; status: { state: string } }>('finance.misa_amis_match.results', {}, { actor: asUser(outsider), orgId: otherOrgId });
    expect(none).toMatchObject({ connectionId: null, status: { state: 'none' } });
    await rows("UPDATE ludy_finance.misa_amis_match_check SET state = 'requested', failure = NULL, finished_at = NULL WHERE org_id = $1", [orgId]);
    await record({ state: 'done', failure: null, results: [{ kind: 'item', ref: 'DV_CHUNG', state: 'unknown', code: null, entryId: null }] });
    // The check's own result is the one item row; a name a person confirmed (left by the tests above) stays through a check and goes only with the connection.
    expect(await rows("SELECT 1 FROM ludy_finance.misa_amis_match WHERE org_id = $1 AND kind = 'item'", [orgId])).toHaveLength(1);
    expect((await call('connections/disconnect', owner, { id: connectionId })).status).toBe(200);
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_match_check WHERE org_id = $1', [orgId])).toEqual([]);
    expect(await rows('SELECT 1 FROM ludy_finance.misa_amis_match WHERE org_id = $1', [orgId])).toEqual([]);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The push of vouchers to MISA AMIS Kế toán (#3902, S3b of #3854), on a real PostgreSQL 17: who may push, that a confirmation is bound to what the person saw (the digest) and refuses anything blocked,
// idempotency on `org_refid` (a replay, a double press and two presses at once queue each voucher part once), the state graph the table's guard enforces (a person may only send a refused or failed row
// again, with one more attempt; nothing erases a row), the worker's commands (the next step, the ledger call committed BEFORE a send, a batch with no answer turning ambiguous and never being sent again,
// results recorded only along the graph), tenancy, and that no voucher body, name or secret is stored. The vouchers come from a stand-in for `finance.vouchers.cash` (the real loaders are covered by
// their own tests); everything else is the real commands and the real migrations.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { Runtime, defineQuery, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { amisBatchDigest, amisContextOf, financeCommands, financeQueries, loadAmisEntries, type CashVoucher, type MisaAmisMatchResults, type MisaAmisPushBegin, type MisaAmisPushResult, type MisaAmisPushRow } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET = 'test-only-jwt-secret-for-misa-amis-push-0123456789';
const ISSUER = 'crove-auth';
const PARTY = 'Công ty TNHH Planted Party';

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

const MEMBER_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;

const cash = (sourceId: string, code: string, overrides: Partial<CashVoucher> = {}): CashVoucher => ({
  sourceId,
  type: 'cash_payment',
  code,
  numberPeriod: '2026',
  date: '2026-10-07',
  cashAccount: '1111',
  party: { name: PARTY, taxCode: '0101234564', address: '1 Láng Hạ, Hà Nội' },
  personName: 'Nguyễn Văn An',
  description: 'Trả tiền hóa đơn tháng 9',
  lines: [
    { lineNo: 1, account: '331', amount: '1650000', memo: 'HĐ C26TAA/123' },
    { lineNo: 2, account: '6422', amount: '35000.5', memo: null },
  ],
  ...overrides,
});

const ASK = { kind: 'cash_payment' as const, from: '2026-10-01', to: '2026-10-31' };

suite('MISA AMIS push (#3902)', () => {
  const dbName = `crove_test_misa_amis_push_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let api: Runtime;
  let worker: Runtime;
  // The vouchers the stand-in loader answers: a test sets what the "ledger" holds now.
  let vouchers: CashVoucher[] = [];
  // The vouchers of the ledger before the split voucher tests replaced them.
  let base: CashVoucher[] = [];
  const users: Record<(typeof MEMBER_ROLES)[number] | 'outsider', string> = { owner: '', admin: '', member: '', viewer: '', outsider: '' };
  let orgId = '';
  let otherOrgId = '';
  let entityId = '';
  let connectionId = '';
  let otherConnectionId = '';

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
  const asUser = (who: keyof typeof users, org = orgId) => ({ actor: { type: 'user' as const, userId: users[who], aal: 'aal1' as const, sessionId: randomUUID() }, orgId: org });
  const SYSTEM = (org = orgId) => ({ actor: { type: 'system' as const, component: 'finance.misa_amis' }, orgId: org });

  const ids = (n: number) => Array.from({ length: n }, () => randomUUID());
  type Ask = { kind: 'cash_payment'; from: string; to: string };
  const askOf = (extra: Record<string, unknown> = {}): Ask => ({ ...ASK, ...(extra as Partial<Ask>) });
  // A check of the batch that matched the party every voucher here has (S3b, #4124: a confirmation needs one no older than 15 minutes), made the way a person and the worker make it: a request, then the worker's record.
  // The helper remembers the batch it last checked, so a push for the same batch does not file another request.
  let checkedFor = '';
  async function freshCheck(ask: Ask = ASK): Promise<void> {
    await api.execute('finance.misa_amis_match.request_check', { id: connectionId, ask }, asUser('owner'));
    const [stored] = await rows<{ requested_at: Date }>('SELECT requested_at FROM crove_finance.misa_amis_match_check WHERE connection_id = $1', [connectionId]);
    await worker.execute(
      'finance.misa_amis_match.record_check',
      { connectionId, requestedAt: new Date(stored?.requested_at as Date).toISOString(), state: 'done', failure: null, results: [{ kind: 'party', ref: '0101234564', state: 'matched', code: 'NCC_ABC', entryId: null }] },
      SYSTEM(),
    );
    checkedFor = JSON.stringify(ask);
  }
  // What the person saw in the preview for the vouchers held now: written with what the last check of that batch matched, as the preview is.
  async function previewDigest(ask: Ask = ASK): Promise<string> {
    const full = { ...ask, legalEntityId: entityId };
    const matches = await api.query<MisaAmisMatchResults>('finance.misa_amis_match.results', { legalEntityId: entityId, ask: full }, asUser('owner'));
    const { entries } = await loadAmisEntries(async () => vouchers as never, full, amisContextOf(full, undefined, matches), 501);
    return amisBatchDigest(entries);
  }
  async function push(who: keyof typeof users, extra: Record<string, unknown> = {}, digest?: string) {
    const { legalEntityId: _entity, ...rest } = extra;
    const ask = askOf(rest);
    if (checkedFor !== JSON.stringify(ask)) await freshCheck(ask);
    return api.execute<MisaAmisPushResult>('finance.misa_amis.push', { connectionId, ...ASK, digest: digest ?? (await previewDigest(ask)), ...extra }, asUser(who));
  }
  const pushRows = (conn = connectionId) => rows<{ org_refid: string; state: string; attempts: number; reason: string | null; payload_digest: string; sent_at: Date | null; answered_at: Date | null }>(
    'SELECT org_refid, state, attempts, reason, payload_digest, sent_at, answered_at FROM crove_finance.misa_amis_push WHERE connection_id = $1 ORDER BY org_refid',
    [conn],
  );
  const stateOf = async (refid: string) => (await rows<{ state: string }>('SELECT state FROM crove_finance.misa_amis_push WHERE org_refid = $1', [refid]))[0]?.state;
  const begin = (opts: { branchKnown: boolean; checked: boolean }) => worker.execute<MisaAmisPushBegin>('finance.misa_amis.push_begin', { connectionId, ...opts }, SYSTEM());
  const record = (input: unknown) => worker.execute<{ applied: number; ignored: number }>('finance.misa_amis.push_record', { connectionId, ...(input as object) }, SYSTEM());

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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    // The stand-in for the cash voucher loader; every other query and command is the real one.
    const fakeCash = defineQuery({ name: 'finance.vouchers.cash', input: z.looseObject({}), access: MEMBER_ROLES, handler: async () => vouchers });
    const register = (db: ReturnType<typeof createDb>, sessions = false) =>
      new Runtime(db, { manifests: TEST_MANIFESTS, ...(sessions ? { sessions: createSessionStatusSource('off'), stepUp: 'required' as const } : {}) }).register({
        commands: [...kernelCommands, ...financeCommands],
        queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries.filter((q) => q.name !== 'finance.vouchers.cash'), fakeCash],
      });
    api = register(createDb(pool), true);
    worker = register(createDb(workerPool));

    // Two orgs made through the API as a person would, then the members the test needs.
    const config = loadConfig({ DATABASE_URL: login('crove_app', 'test-app-pw'), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    const app = createHttpApp({ config, runtime: api, store: new MemoryStore(), authenticate: createAuthenticator(config, createDb(pool)), pool, aiEnabled: false });
    const login2 = async (email: string) => {
      const subject = randomUUID();
      const token = await new SignJWT({ role: 'authenticated', email, session_id: randomUUID(), aal: 'aal1', is_anonymous: false })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(subject)
        .setIssuer(ISSUER)
        .setAudience('authenticated')
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(new TextEncoder().encode(SECRET));
      return token;
    };
    const post = async (path: string, token: string, input: unknown) => {
      const response = await app.request(`/api/rpc/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input === undefined ? {} : { json: input }) });
      const text = await response.text();
      const body = (text ? JSON.parse(text) : null) as { json?: unknown } | null;
      return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
    };
    const tokens: Record<string, string> = {};
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      tokens[key] = await login2(`${key}@misa-amis-push.test`);
      const me = await post('me/get', tokens[key] as string, undefined);
      expect(me.status).toBe(200);
      users[key] = String(me.body?.userId);
    }
    const mineOrg = await post('org/create', tokens.owner as string, { name: 'Công ty đẩy chứng từ', idempotencyKey: randomUUID() });
    orgId = String(mineOrg.body?.orgId);
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, users.admin, users.member, users.viewer]);
    const theirOrg = await post('org/create', tokens.outsider as string, { name: 'Công ty khác', idempotencyKey: randomUUID() });
    otherOrgId = String(theirOrg.body?.orgId);
    const connect = async (org: string, owner: string, test: 'works' | null) => {
      const entity = String((await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [org]))[0]?.id);
      const channel = randomUUID();
      await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'accounting_misa_amis', $3, 'AMIS thử', $4)", [org, channel, entity, owner]);
      const id = randomUUID();
      await rows(
        `INSERT INTO crove_finance.misa_amis_connection (org_id, id, legal_entity_id, channel_connection_id, last_test_state, last_tested_at) VALUES ($1, $2, $3, $4, $5, ${test ? 'pg_catalog.now()' : 'NULL'})`,
        [org, id, entity, channel, test],
      );
      return { id, entity };
    };
    const mine = await connect(orgId, users.owner, 'works');
    connectionId = mine.id;
    entityId = mine.entity;
    otherConnectionId = (await connect(otherOrgId, users.outsider, 'works')).id;
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

  const first = ids(3);

  it('lets only an owner or admin push, and only for a connection that was tested and works', async () => {
    vouchers = [cash(first[0] as string, 'PC00012')];
    for (const who of ['member', 'viewer'] as const) await expect(push(who), who).rejects.toMatchObject({ status: 403 });
    // Another org's connection is not found, never "forbidden".
    await expect(api.execute('finance.misa_amis.push', { connectionId: otherConnectionId, ...ASK, digest: await previewDigest() }, asUser('owner'))).rejects.toMatchObject({ code: 'MISA_AMIS_CONNECTION_NOT_FOUND' });
    await rows("UPDATE crove_finance.misa_amis_connection SET last_test_state = 'unreachable' WHERE org_id = $1", [orgId]);
    await expect(push('owner')).rejects.toMatchObject({ code: 'MISA_AMIS_NOT_TESTED' });
    await rows("UPDATE crove_finance.misa_amis_connection SET last_test_state = NULL, last_tested_at = NULL WHERE org_id = $1", [orgId]);
    await expect(push('owner')).rejects.toMatchObject({ code: 'MISA_AMIS_NOT_TESTED' });
    await rows("UPDATE crove_finance.misa_amis_connection SET last_test_state = 'works', last_tested_at = pg_catalog.now() WHERE org_id = $1", [orgId]);
    expect(await pushRows()).toEqual([]);
  });

  it('refuses a confirmation with no check of this batch against the catalogue in the last 15 minutes, and takes one just inside the window (#4124)', async () => {
    vouchers = [cash(first[0] as string, 'PC00012')];
    // The gate is read before the digest, so a digest that is wrong tells which gate was passed: STALE means the check was young enough.
    const confirm = (ask: Ask = ASK) => api.execute('finance.misa_amis.push', { connectionId, ...ask, digest: 'a'.repeat(64) }, asUser('owner'));
    const age = (minutes: number) => rows("UPDATE crove_finance.misa_amis_match_check SET finished_at = pg_catalog.clock_timestamp() - pg_catalog.make_interval(mins => $2::int) WHERE connection_id = $1", [connectionId, minutes]);
    // No check at all.
    await rows('DELETE FROM crove_finance.misa_amis_match_check WHERE connection_id = $1', [connectionId]);
    await expect(confirm()).rejects.toMatchObject({ code: 'MISA_AMIS_CHECK_REQUIRED', status: 409 });
    // A check of another batch, and one that never finished (a failed one).
    await freshCheck(askOf({ to: '2026-10-15' }));
    await expect(confirm()).rejects.toMatchObject({ code: 'MISA_AMIS_CHECK_REQUIRED' });
    await rows('DELETE FROM crove_finance.misa_amis_match_check WHERE connection_id = $1', [connectionId]);
    await api.execute('finance.misa_amis_match.request_check', { id: connectionId, ask: ASK }, asUser('owner'));
    const [waiting] = await rows<{ requested_at: Date }>('SELECT requested_at FROM crove_finance.misa_amis_match_check WHERE connection_id = $1', [connectionId]);
    await worker.execute('finance.misa_amis_match.record_check', { connectionId, requestedAt: new Date(waiting?.requested_at as Date).toISOString(), state: 'failed', failure: 'unreachable', results: [] }, SYSTEM());
    await expect(confirm()).rejects.toMatchObject({ code: 'MISA_AMIS_CHECK_REQUIRED' });
    // A check of this batch: old by a minute, refused; inside the window by a minute, past the gate.
    await freshCheck();
    await age(16);
    await expect(confirm()).rejects.toMatchObject({ code: 'MISA_AMIS_CHECK_REQUIRED' });
    await age(14);
    await expect(confirm()).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_STALE' });
    // A re-check that waits (or failed) has no finished check to stand on: the person waits for it, whatever the age of the one before. The earlier results still stand for the blockers, but nothing is confirmed on them.
    await api.execute('finance.misa_amis_match.request_check', { id: connectionId, ask: ASK }, asUser('owner'));
    await expect(confirm()).rejects.toMatchObject({ code: 'MISA_AMIS_CHECK_REQUIRED' });
    expect(await pushRows()).toEqual([]);
    // Back to a fresh one for the tests that follow.
    checkedFor = '';
  });

  it('refuses what changed since the person looked, what is blocked, what is empty and what names another entity', async () => {
    const seen = await previewDigest();
    // The data changed after the preview: a different amount.
    vouchers = [cash(first[0] as string, 'PC00012', { lines: [{ lineNo: 1, account: '331', amount: '1650001', memo: null }] })];
    await expect(push('owner', {}, seen)).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_STALE' });
    // A voucher with a number over MISA's limit blocks the whole batch, even with the right digest.
    vouchers = [cash(first[0] as string, 'PC00012'), cash(first[1] as string, 'PC1234567890123')];
    await expect(push('owner')).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_BLOCKED' });
    vouchers = [];
    await expect(push('owner')).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_EMPTY' });
    vouchers = [cash(first[0] as string, 'PC00012')];
    await expect(push('owner', { legalEntityId: randomUUID() })).rejects.toMatchObject({ code: 'MISA_AMIS_ENTITY_MISMATCH' });
    expect(await pushRows()).toEqual([]);
  });

  it('queues one row per voucher part with what rebuilds it and nothing of the voucher, and asks the worker to run', async () => {
    vouchers = [cash(first[0] as string, 'PC00012'), cash(first[1] as string, 'PC00013')];
    const result = await push('admin');
    expect(result).toEqual({ queued: 2, requeued: 0, already: 0, revised: 0 });
    const stored = await rows<Record<string, unknown>>('SELECT * FROM crove_finance.misa_amis_push WHERE connection_id = $1 ORDER BY org_refno', [connectionId]);
    expect(stored.map((r) => [r.org_refid, r.org_refno, r.voucher_type, r.part, r.state, r.attempts, r.source_type, r.source_id, r.legal_entity_id, r.requested_by])).toEqual([
      [first[0], 'CRPC202600012', 4, 1, 'queued', 1, 'cash_voucher', first[0], entityId, users.admin],
      [first[1], 'CRPC202600013', 4, 1, 'queued', 1, 'cash_voucher', first[1], entityId, users.admin],
    ]);
    expect(stored[0]?.params).toEqual({ kind: 'cash_payment', from: '2026-10-01', to: '2026-10-31' });
    expect(String(stored[0]?.payload_digest)).toMatch(/^[0-9a-f]{64}$/);
    // No voucher body, name or amount is in any column, the audit row or the outbox event.
    for (const table of ['crove_finance.misa_amis_push', 'crove_kernel.audit_event', 'crove_kernel.outbox_event']) {
      for (const text of [PARTY, '1650000', 'Nguyễn Văn An']) {
        expect(await rows(`SELECT 1 FROM ${table} t WHERE t.org_id = $1 AND t::text LIKE '%' || $2 || '%'`, [orgId, text]), `${table} ${text}`).toEqual([]);
      }
    }
    const events = await rows<{ payload: { connection_id: string } }>("SELECT payload FROM crove_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.misa_amis.push_requested'", [orgId]);
    expect(events.map((e) => e.payload)).toEqual([{ connection_id: connectionId }]);
    const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.misa_amis.push'", [orgId]);
    expect(audit.length).toBeGreaterThan(0);
  });

  it('queues nothing twice: a replay, a second press and two presses at once make each part once', async () => {
    const again = await push('owner');
    expect(again).toEqual({ queued: 0, requeued: 0, already: 2, revised: 0 });
    const fresh = ids(4);
    vouchers = [...vouchers, ...fresh.map((id, i) => cash(id, `PC0010${i}`))];
    base = vouchers;
    // A second set of choices (another end of the period), so the worker takes these rows as a batch of their own.
    await freshCheck(askOf({ to: '2026-10-30' }));
    const [a, b] = await Promise.all([push('owner', { to: '2026-10-30' }), push('admin', { to: '2026-10-30' })]);
    expect(a.queued + b.queued).toBe(4);
    // Each press sees six parts (the two queued before and the four new): twelve in all, four of them queued by one press and the rest found.
    expect(a.already + b.already).toBe(8);
    const all = await pushRows();
    expect(all).toHaveLength(6);
    expect(new Set(all.map((r) => r.org_refid)).size).toBe(6);
    expect(all.every((r) => r.state === 'queued' && r.attempts === 1)).toBe(true);
    // The database says the same without the command: a second row under one org_refid is refused.
    await expect(rows(
      `INSERT INTO crove_finance.misa_amis_push (org_id, legal_entity_id, connection_id, source_type, source_id, voucher_type, org_refid, org_refno, payload_digest) VALUES ($1, $2, $3, 'cash_voucher', $4, 4, $5, 'DUP', $6)`,
      [orgId, entityId, connectionId, randomUUID(), first[0], 'a'.repeat(64)],
    )).rejects.toThrow(/misa_amis_push_refid_uq/);
  });

  it('a voucher split in parts is several rows, each under its own id, and a part number over 20 characters is a blocker, not a cut', async () => {
    const lines = Array.from({ length: 501 }, (_, i) => ({ lineNo: i + 1, account: '6422', amount: '1000', memo: null }));
    const split = randomUUID();
    vouchers = [cash(split, 'PC1234567', { lines })];
    const result = await push('owner');
    expect(result.queued).toBe(2);
    expect(await rows<{ part: number; org_refno: string }>('SELECT part, org_refno FROM crove_finance.misa_amis_push WHERE source_id = $1 ORDER BY part', [split])).toEqual([
      { part: 1, org_refno: 'CRPC20261234567' },
      { part: 2, org_refno: 'CRPC20261234567/2' },
    ]);
    const tooLong = randomUUID();
    vouchers = [cash(tooLong, 'PC12345678901', { lines })];
    await expect(push('owner')).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_BLOCKED' });
    expect(await rows('SELECT 1 FROM crove_finance.misa_amis_push WHERE source_id = $1', [tooLong])).toEqual([]);
  });

  it('reads the queued rows only as the system, and every member reads the list with no secret in it', async () => {
    await expect(api.execute('finance.misa_amis.push_begin', { connectionId, branchKnown: true, checked: true }, asUser('owner'))).rejects.toMatchObject({ status: 403 });
    for (const who of MEMBER_ROLES) {
      const list = await api.query<MisaAmisPushRow[]>('finance.misa_amis.push_list', { connectionId }, asUser(who));
      expect(list.length, who).toBe(8);
      expect(JSON.stringify(list)).not.toContain(PARTY);
    }
    // A user of another org is not a member of this one at all, and another org's connection is not seen from here.
    await expect(api.query('finance.misa_amis.push_list', { connectionId: otherConnectionId }, asUser('outsider'))).rejects.toMatchObject({ code: 'NOT_A_MEMBER', status: 403 });
    expect(await api.query<MisaAmisPushRow[]>('finance.misa_amis.push_list', { connectionId }, asUser('outsider', otherOrgId))).toEqual([]);
  });

  it('begin asks for the branch before it moves anything, then commits the call to the ledger BEFORE the send and marks the batch sending', async () => {
    const need = await begin({ branchKnown: false, checked: true });
    expect(need).toEqual({ action: 'need_branch' });
    expect((await pushRows()).every((r) => r.state === 'queued')).toBe(true);
    const sent = await begin({ branchKnown: true, checked: true });
    if (sent.action !== 'send') throw new Error(`expected a send, got ${sent.action}`);
    // One voucher type and one set of choices, oldest first, at most the batch size.
    expect(sent.voucherType).toBe(4);
    expect(sent.rows.length).toBeGreaterThan(0);
    expect(sent.rows.length).toBeLessThanOrEqual(50);
    expect(sent.params).toMatchObject({ kind: 'cash_payment' });
    const ledger = await rows<{ key: string; state: string; step: string; target: string; retry_safety: string; calls: number }>('SELECT key, state, step, target, retry_safety, calls FROM crove_kernel.external_call WHERE org_id = $1', [orgId]);
    expect(ledger).toEqual([{ key: sent.callKey, state: 'started', step: 'save', target: 'misa_amis', retry_safety: 'reconcile_only', calls: 1 }]);
    const moved = await pushRows();
    for (const row of sent.rows) expect(moved.find((r) => r.org_refid === row.orgRefid)?.state).toBe('sending');
    // One batch at a time per connection: while this batch is sending, another run waits (the rows of the other choices are still queued).
    expect(await begin({ branchKnown: true, checked: true })).toEqual({ action: 'none', reason: 'busy', waiting: true });
    // Record the first batch as sent: the rows move along, the ledger call ends.
    const done = await record({ rows: sent.rows.map((r) => ({ orgRefid: r.orgRefid, attempts: r.attempts, from: 'sending', to: 'sent', reason: null })), call: { key: sent.callKey, end: { state: 'succeeded' } } });
    expect(done).toEqual({ applied: sent.rows.length, ignored: 0 });
    expect((await rows<{ state: string }>('SELECT state FROM crove_kernel.external_call WHERE key = $1', [sent.callKey]))[0]?.state).toBe('succeeded');
    const after = await pushRows();
    for (const row of sent.rows) expect(after.find((r) => r.org_refid === row.orgRefid)).toMatchObject({ state: 'sent', sent_at: expect.any(Date) });
    // Now the batch of the other choices goes out, and is left `sending` (no answer yet) for the next test.
    const other = await begin({ branchKnown: true, checked: true });
    if (other.action !== 'send') throw new Error(`expected a send, got ${other.action}`);
    expect(other.rows.map((r) => r.orgRefid).filter((id) => sent.rows.some((s) => s.orgRefid === id))).toEqual([]);
    expect(other.rows).toHaveLength(4);
    expect(other.callKey).not.toBe(sent.callKey);
    // The same record again changes nothing (the rows are not where it says they were).
    expect(await record({ rows: sent.rows.map((r) => ({ orgRefid: r.orgRefid, attempts: r.attempts, from: 'sending', to: 'sent', reason: null })), call: null })).toEqual({ applied: 0, ignored: sent.rows.length });
  });

  it('a batch with no answer for too long is ambiguous, is never sent again, and leaves only with MISA\'s own answer', async () => {
    // The batch of the other choices is still `sending` from the previous test: nothing answered for it. Let it age past the in-flight time.
    const sending = (await rows<{ org_refid: string }>("SELECT org_refid FROM crove_finance.misa_amis_push WHERE connection_id = $1 AND state = 'sending' ORDER BY org_refid", [connectionId])).map((r) => r.org_refid);
    expect(sending).toHaveLength(4);
    await rows("UPDATE crove_finance.misa_amis_push SET updated_at = pg_catalog.now() - interval '10 minutes' WHERE connection_id = $1 AND state = 'sending'", [connectionId]);
    const check = await begin({ branchKnown: true, checked: false });
    if (check.action !== 'check') throw new Error(`expected a check, got ${check.action}`);
    expect(check.rows.filter((r) => r.state === 'ambiguous').map((r) => r.orgRefid).sort()).toEqual(sending);
    // The sent rows of the first batch are asked about too.
    expect(check.rows.filter((r) => r.state === 'sent').length).toBe(4);
    for (const id of sending) expect(await stateOf(id)).toBe('ambiguous');
    // The sweep keeps the day the batch was begun in `sent_at` (not the day of the sweep), so the result check asks about that day.
    const kept = await rows<{ age: number }>("SELECT extract(epoch FROM (pg_catalog.now() - sent_at))::int AS age FROM crove_finance.misa_amis_push WHERE connection_id = $1 AND state = 'ambiguous' AND org_refid = ANY($2)", [connectionId, sending]);
    expect(kept).toHaveLength(4);
    for (const r of kept) expect(r.age).toBeGreaterThanOrEqual(590);
    // Nothing is queued any more, and the ambiguous rows are not taken for a send.
    const after = await begin({ branchKnown: true, checked: true });
    expect(after).toEqual({ action: 'none', reason: 'nothing', waiting: true });
    // MISA's answer moves them: refused or accepted. A person cannot, and nothing else can.
    const [one, two, three] = sending as [string, string, string];
    // A completion of another attempt than the row's is ignored; one of its own attempt applies.
    expect(await record({ rows: [{ orgRefid: one, attempts: 2, from: 'ambiguous', to: 'accepted', reason: null }], call: null })).toEqual({ applied: 0, ignored: 1 });
    expect(await stateOf(one)).toBe('ambiguous');
    expect(await record({ rows: [{ orgRefid: one, attempts: 1, from: 'ambiguous', to: 'accepted', reason: null }, { orgRefid: two, attempts: 1, from: 'ambiguous', to: 'refused', reason: 'Số chứng từ đã tồn tại' }], call: null })).toEqual({ applied: 2, ignored: 0 });
    expect(await stateOf(one)).toBe('accepted');
    expect(await stateOf(two)).toBe('refused');
    // The graph is closed on the worker's side too: ambiguous cannot go back to queued.
    await expect(record({ rows: [{ orgRefid: three, attempts: 1, from: 'ambiguous', to: 'queued', reason: null }], call: null })).rejects.toMatchObject({ status: 422 });
    expect(await stateOf(three)).toBe('ambiguous');
  });

  it('after three days without MISA\'s answer an owner or admin says what they found in AMIS: "in AMIS" is sent (no call), "not in AMIS" is failed and needs a new confirmed push', async () => {
    const ambiguous = (await rows<{ org_refid: string }>("SELECT org_refid FROM crove_finance.misa_amis_push WHERE connection_id = $1 AND state = 'ambiguous' ORDER BY org_refid", [connectionId])).map((r) => r.org_refid);
    expect(ambiguous.length).toBeGreaterThanOrEqual(2);
    const [inAmis, notInAmis] = ambiguous as [string, string];
    const resolve = (who: keyof typeof users, orgRefid: string, outcome: 'in_amis' | 'not_in_amis') => api.execute('finance.misa_amis.push_resolve', { connectionId, orgRefid, outcome }, asUser(who));
    // Too early: only a row with no answer for more than three days.
    await expect(resolve('owner', inAmis, 'in_amis')).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_STATE' });
    await rows("UPDATE crove_finance.misa_amis_push SET updated_at = pg_catalog.now() - interval '4 days' WHERE org_refid = ANY($1::uuid[])", [[inAmis, notInAmis]]);
    for (const who of ['member', 'viewer'] as const) await expect(resolve(who, inAmis, 'in_amis'), who).rejects.toMatchObject({ status: 403 });
    // Compared as text: the column keeps microseconds, a JS Date keeps milliseconds.
    const sentBefore = (await rows<{ sent_at: string | null }>('SELECT sent_at::text AS sent_at FROM crove_finance.misa_amis_push WHERE org_refid = $1', [inAmis]))[0]?.sent_at;
    expect(sentBefore).toBeTruthy();
    expect(await resolve('admin', inAmis, 'in_amis')).toEqual({ resolved: true });
    // The send day is kept (the result check asks MISA from that day), while the row is back in the result window.
    expect((await rows<{ same: boolean; fresh: boolean }>('SELECT sent_at::text = $2 AS same, updated_at > pg_catalog.now() - interval \'1 minute\' AS fresh FROM crove_finance.misa_amis_push WHERE org_refid = $1', [inAmis, sentBefore]))[0]).toEqual({ same: true, fresh: true });
    expect(await resolve('owner', notInAmis, 'not_in_amis')).toEqual({ resolved: true });
    expect(await rows<{ state: string; reason: string | null; attempts: number }>('SELECT state, reason, attempts FROM crove_finance.misa_amis_push WHERE org_refid = $1', [inAmis])).toEqual([{ state: 'sent', reason: 'CONFIRMED_IN_AMIS', attempts: 1 }]);
    expect(await rows<{ state: string; reason: string | null; attempts: number }>('SELECT state, reason, attempts FROM crove_finance.misa_amis_push WHERE org_refid = $1', [notInAmis])).toEqual([{ state: 'failed', reason: 'NOT_IN_AMIS', attempts: 1 }]);
    // A row that is not ambiguous cannot be resolved, and "not in AMIS" is not a resend: the row waits for a new confirmed push.
    await expect(resolve('owner', inAmis, 'not_in_amis')).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_STATE' });
    expect((await begin({ branchKnown: true, checked: true })).action).not.toBe('send');
    expect((await pushRows()).find((r) => r.org_refid === notInAmis)).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it('a sent row MISA never answered for in 24 hours is settled by an owner or admin: "in AMIS" is accepted, "not in AMIS" is failed; before that, and for anyone else, nothing moves', async () => {
    const sentRows = (await rows<{ org_refid: string }>("SELECT org_refid FROM crove_finance.misa_amis_push WHERE connection_id = $1 AND state = 'sent' ORDER BY org_refid", [connectionId])).map((r) => r.org_refid);
    expect(sentRows.length).toBeGreaterThanOrEqual(2);
    const [found, missing] = sentRows as [string, string];
    const resolve = (who: keyof typeof users, orgRefid: string, outcome: 'in_amis' | 'not_in_amis') => api.execute('finance.misa_amis.push_resolve', { connectionId, orgRefid, outcome }, asUser(who));
    const stateOf2 = async (id: string) => (await rows<{ state: string; reason: string | null; attempts: number; answered: boolean; sent: boolean }>('SELECT state, reason, attempts, answered_at IS NOT NULL AS answered, sent_at IS NOT NULL AS sent FROM crove_finance.misa_amis_push WHERE org_refid = $1', [id]))[0];
    // Inside the 24 hours the worker still asks: not yet.
    await rows("UPDATE crove_finance.misa_amis_push SET updated_at = pg_catalog.now() - interval '23 hours' WHERE org_refid = ANY($1::uuid[])", [[found, missing]]);
    await expect(resolve('owner', found, 'in_amis')).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_STATE' });
    await rows("UPDATE crove_finance.misa_amis_push SET updated_at = pg_catalog.now() - interval '25 hours' WHERE org_refid = ANY($1::uuid[])", [[found, missing]]);
    for (const who of ['member', 'viewer'] as const) await expect(resolve(who, found, 'in_amis'), who).rejects.toMatchObject({ status: 403 });
    expect(await resolve('admin', found, 'in_amis')).toEqual({ resolved: true });
    expect(await stateOf2(found)).toEqual({ state: 'accepted', reason: 'CONFIRMED_IN_AMIS', attempts: 1, answered: true, sent: true });
    expect(await resolve('owner', missing, 'not_in_amis')).toEqual({ resolved: true });
    expect(await stateOf2(missing)).toEqual({ state: 'failed', reason: 'NOT_IN_AMIS', attempts: 1, answered: false, sent: true });
    // Settled rows are final here; a failed one waits for a new confirmed push, never for the worker.
    await expect(resolve('owner', found, 'not_in_amis')).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_STATE' });
    await expect(resolve('owner', missing, 'in_amis')).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_STATE' });
    // The list says which rows a person may settle: the last change is on every row.
    const list = await api.query<MisaAmisPushRow[]>('finance.misa_amis.push_list', { connectionId }, asUser('viewer'));
    expect(list.every((r) => typeof r.changedAt === 'string' && !Number.isNaN(Date.parse(r.changedAt)))).toBe(true);
  });

  it('a person sends a refused row again only through a new confirmed push: one more attempt, the new digest, the reason cleared', async () => {
    vouchers = base;
    const refused = (await pushRows()).find((r) => r.state === 'refused');
    if (!refused) throw new Error('expected a refused row');
    const source = (await rows<{ source_id: string }>('SELECT source_id FROM crove_finance.misa_amis_push WHERE org_refid = $1', [refused.org_refid]))[0]?.source_id as string;
    // The voucher was corrected in Ludy meanwhile: another amount, so another digest.
    vouchers = vouchers.map((v) => (v.sourceId === source ? { ...v, lines: [{ lineNo: 1, account: '331', amount: '1650002', memo: null }] } : v));
    // The rows a person found "not in AMIS" (failed) go back too, with the same digest: each is one more attempt. Only a row whose voucher is in the books this test builds is sent again (the earlier tests settled
    // some sent rows by hand, and which ones depends on the ids), so the count is read from the rows, not fixed.
    const known = new Set(vouchers.map((v) => v.sourceId));
    const waitingAgain = (await rows<{ source_id: string }>("SELECT source_id FROM crove_finance.misa_amis_push WHERE connection_id = $1 AND state IN ('refused', 'failed')", [connectionId])).filter((r) => known.has(r.source_id)).length;
    expect(waitingAgain).toBeGreaterThanOrEqual(2);
    const result = await push('owner');
    expect(result.requeued).toBe(waitingAgain);
    const row = (await pushRows()).find((r) => r.org_refid === refused.org_refid);
    expect(row).toMatchObject({ state: 'queued', attempts: 2, reason: null, sent_at: null, answered_at: null });
    expect(row?.payload_digest).not.toBe(refused.payload_digest);
    // A voucher AMIS accepted whose source was revised afterwards is counted, never sent again.
    // An accepted row whose voucher is in the books this test builds.
    const acceptedRows = await rows<{ org_refid: string; source_id: string }>("SELECT org_refid, source_id FROM crove_finance.misa_amis_push WHERE connection_id = $1 AND state = 'accepted' ORDER BY org_refid", [connectionId]);
    const accepted = acceptedRows.find((r) => known.has(r.source_id));
    if (!accepted) throw new Error('expected an accepted row');
    const acceptedSource = accepted.source_id;
    vouchers = vouchers.map((v) => (v.sourceId === acceptedSource ? { ...v, lines: [{ lineNo: 1, account: '331', amount: '1650003', memo: null }] } : v));
    const revised = await push('owner');
    expect(revised.revised).toBe(1);
    expect((await pushRows()).find((r) => r.org_refid === accepted.org_refid)?.state).toBe('accepted');
  });

  it('the table\'s guard: a tenant role types no state, moves a row only from refused or failed back to queued, and deletes nothing', async () => {
    const tenant = async <T>(who: keyof typeof users, org: string, run: (c: pg.Client) => Promise<T>): Promise<T> => {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [org, contextToken(users[who], org)]);
        await c.query('SET LOCAL ROLE crove_tenant');
        return await run(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        await c.end();
      }
    };
    // A new row typed by an owner is always queued, attempt 1, with nothing answered, whatever it says.
    const stored = await tenant('owner', orgId, async (c) => {
      const { rows: inserted } = await c.query<{ state: string; attempts: number; reason: string | null; answered_at: Date | null }>(
        `INSERT INTO crove_finance.misa_amis_push (org_id, legal_entity_id, connection_id, source_type, source_id, voucher_type, org_refid, org_refno, payload_digest, state, attempts, reason, answered_at)
         VALUES ($1, $2, $3, 'cash_voucher', $4, 4, $5, 'TYPED', $6, 'accepted', 7, 'typed', pg_catalog.now()) RETURNING state, attempts, reason, answered_at`,
        [orgId, entityId, connectionId, randomUUID(), randomUUID(), 'c'.repeat(64)],
      );
      return inserted[0];
    });
    expect(stored).toEqual({ state: 'queued', attempts: 1, reason: null, answered_at: null });
    // A member cannot insert at all; an entity other than the connection's is refused.
    await expect(tenant('member', orgId, (c) => c.query(
      `INSERT INTO crove_finance.misa_amis_push (org_id, legal_entity_id, connection_id, source_type, source_id, voucher_type, org_refid, org_refno, payload_digest) VALUES ($1, $2, $3, 'cash_voucher', $4, 4, $5, 'M', $6)`,
      [orgId, entityId, connectionId, randomUUID(), randomUUID(), 'd'.repeat(64)],
    ))).rejects.toThrow();
    const accepted = (await pushRows()).find((r) => r.state === 'accepted')?.org_refid;
    const queued = (await pushRows()).find((r) => r.state === 'queued')?.org_refid;
    // An accepted row stays accepted for a person: not queued again, not edited, not deleted.
    await expect(tenant('owner', orgId, (c) => c.query("UPDATE crove_finance.misa_amis_push SET state = 'queued', attempts = attempts + 1 WHERE org_refid = $1", [accepted]))).rejects.toThrow(/MISA_AMIS_PUSH_STATE/);
    await expect(tenant('owner', orgId, (c) => c.query("UPDATE crove_finance.misa_amis_push SET state = 'accepted' WHERE org_refid = $1", [queued]))).rejects.toThrow(/MISA_AMIS_PUSH_STATE/);
    await expect(tenant('owner', orgId, (c) => c.query("UPDATE crove_finance.misa_amis_push SET attempts = 99 WHERE org_refid = $1", [queued]))).rejects.toThrow(/MISA_AMIS_PUSH_STATE/);
    await expect(tenant('owner', orgId, (c) => c.query('UPDATE crove_finance.misa_amis_push SET payload_digest = $2 WHERE org_refid = $1', [queued, 'e'.repeat(64)]))).rejects.toThrow(/MISA_AMIS_PUSH_STATE/);
    // What the grant never gave: the identity of the request and the connection.
    await expect(tenant('owner', orgId, (c) => c.query("UPDATE crove_finance.misa_amis_push SET org_refid = $2 WHERE org_refid = $1", [queued, randomUUID()]))).rejects.toThrow(/permission denied/);
    await expect(tenant('owner', orgId, (c) => c.query("DELETE FROM crove_finance.misa_amis_push WHERE org_refid = $1", [queued]))).rejects.toThrow(/permission denied/);
    // A `sent` row: a person writing it by hand moves it only after 24 hours, only to `accepted` (CONFIRMED_IN_AMIS, answered) or `failed` (NOT_IN_AMIS), never back to the queue or with another reason.
    const waiting = (await pushRows()).find((r) => r.state === 'sent')?.org_refid;
    if (!waiting) throw new Error('expected a sent row');
    await rows("UPDATE crove_finance.misa_amis_push SET updated_at = pg_catalog.now() WHERE org_refid = $1", [waiting]);
    await expect(tenant('owner', orgId, (c) => c.query("UPDATE crove_finance.misa_amis_push SET state = 'accepted', reason = 'CONFIRMED_IN_AMIS', answered_at = pg_catalog.now() WHERE org_refid = $1", [waiting]))).rejects.toThrow(/MISA_AMIS_PUSH_STATE/);
    await rows("UPDATE crove_finance.misa_amis_push SET updated_at = pg_catalog.now() - interval '25 hours' WHERE org_refid = $1", [waiting]);
    await expect(tenant('owner', orgId, (c) => c.query("UPDATE crove_finance.misa_amis_push SET state = 'accepted', reason = 'typed', answered_at = pg_catalog.now() WHERE org_refid = $1", [waiting]))).rejects.toThrow(/MISA_AMIS_PUSH_STATE/);
    await expect(tenant('owner', orgId, (c) => c.query("UPDATE crove_finance.misa_amis_push SET state = 'queued', attempts = attempts + 1, reason = NULL WHERE org_refid = $1", [waiting]))).rejects.toThrow(/MISA_AMIS_PUSH_STATE/);
    expect(await tenant('owner', orgId, async (c) => (await c.query("UPDATE crove_finance.misa_amis_push SET state = 'failed', reason = 'NOT_IN_AMIS' WHERE org_refid = $1", [waiting])).rowCount)).toBe(1);
    // A person's move is stamped with the database clock: a statement that backdates `updated_at` along with an allowed move (an old `ambiguous` row back to `sent`) gets the real time, so the row is not settled at once.
    // (The row is put back to `ambiguous` and four days old by the owner of the database, as the worker's history would leave it.)
    await rows("UPDATE crove_finance.misa_amis_push SET state = 'ambiguous', reason = NULL, answered_at = NULL, updated_at = pg_catalog.now() - interval '4 days' WHERE org_refid = $1", [waiting]);
    // (The helper rolls every transaction back, so the move and the check on it share one transaction.)
    let stamped: boolean | undefined;
    await expect(
      tenant('owner', orgId, async (c) => {
        const moved = await c.query<{ fresh: boolean }>("UPDATE crove_finance.misa_amis_push SET state = 'sent', reason = 'CONFIRMED_IN_AMIS', updated_at = pg_catalog.now() - interval '2 days' WHERE org_refid = $1 RETURNING updated_at >= pg_catalog.now() AS fresh", [waiting]);
        stamped = moved.rows[0]?.fresh;
        await c.query("UPDATE crove_finance.misa_amis_push SET state = 'accepted', reason = 'CONFIRMED_IN_AMIS', answered_at = pg_catalog.now() WHERE org_refid = $1", [waiting]);
      }),
    ).rejects.toThrow(/MISA_AMIS_PUSH_STATE/);
    expect(stamped).toBe(true);
    // Back to where the rest of the test expects it.
    await rows("UPDATE crove_finance.misa_amis_push SET state = 'failed', reason = 'NOT_IN_AMIS' WHERE org_refid = $1", [waiting]);
    // Another org sees none of it and changes none of it.
    expect(await tenant('outsider', otherOrgId, async (c) => (await c.query('SELECT 1 FROM crove_finance.misa_amis_push')).rowCount)).toBe(0);
    expect(await tenant('outsider', otherOrgId, async (c) => (await c.query("UPDATE crove_finance.misa_amis_push SET reason = 'x' WHERE org_refid = $1", [queued])).rowCount)).toBe(0);
  });

  it('a call the ledger already holds is never made again: rows queued under the key of a call begun or ended before fail as CALL_ENDED and nothing goes out (#4041)', async () => {
    // Two queued rows with params of their own (so a batch holds nothing else) and the oldest request in the queue (so begin takes them first; six days old, inside the week after which a queued row expires), whose
    // last change is a fixed time: the key of the call names the rows, their attempt and that time, so putting them back in the queue with the same time asks for the same call. The real flows do not reach these
    // branches (a worker that died leaves `sending` rows, which become `ambiguous`, and a record sets `updated_at` to now, a new key): they are defensive, and the test reaches them by putting the time back.
    const FIXED = '2000-01-01T00:00:00.000Z';
    const REQUESTED = new Date(Date.now() - 6 * 24 * 3600 * 1000).toISOString();
    const queue = async (tag: string) => {
      const refids = ids(2);
      for (const [i, refid] of refids.entries()) {
        await rows(
          `INSERT INTO crove_finance.misa_amis_push (org_id, legal_entity_id, connection_id, source_type, source_id, voucher_type, org_refid, org_refno, payload_digest, params, requested_at, updated_at)
           VALUES ($1, $2, $3, 'cash_voucher', $4, 4, $5, $6, $7, $8::jsonb, $9, $10)`,
          [orgId, entityId, connectionId, randomUUID(), refid, `AGAIN${tag}${i}`, 'f'.repeat(64), JSON.stringify({ kind: 'cash_payment', tag }), REQUESTED, FIXED],
        );
      }
      return refids.sort();
    };
    const requeue = (refids: string[]) => rows("UPDATE crove_finance.misa_amis_push SET state = 'queued', reason = NULL, updated_at = $2 WHERE org_refid = ANY($1::uuid[])", [refids, FIXED]);
    const ledgerOf = async (key: string) => (await rows<{ state: string; calls: number }>('SELECT state, calls FROM crove_kernel.external_call WHERE org_id = $1 AND key = $2', [orgId, key]))[0];
    const failedAsEnded = async (refids: string[]) => {
      const now = await pushRows();
      return refids.map((id) => now.find((r) => r.org_refid === id)).map((r) => ({ state: r?.state, reason: r?.reason }));
    };

    // A call still `started`: it is asked about, never made again.
    const started = await queue('A');
    const begunA = await begin({ branchKnown: true, checked: true });
    if (begunA.action !== 'send') throw new Error(`expected a send, got ${begunA.action}`);
    expect(begunA.rows.map((r) => r.orgRefid).sort()).toEqual(started);
    await requeue(started);
    expect(await begin({ branchKnown: true, checked: true })).toEqual({ action: 'none', reason: 'nothing', waiting: true });
    expect(await failedAsEnded(started)).toEqual([{ state: 'failed', reason: 'CALL_ENDED' }, { state: 'failed', reason: 'CALL_ENDED' }]);
    expect(await ledgerOf(begunA.callKey)).toEqual({ state: 'started', calls: 2 });

    // A call that ended (the rows went back to the queue because nothing left Ludy): it never changes, and the same rows under the same key are not sent.
    const ended = await queue('B');
    const begunB = await begin({ branchKnown: true, checked: true });
    if (begunB.action !== 'send') throw new Error(`expected a send, got ${begunB.action}`);
    expect(begunB.rows.map((r) => r.orgRefid).sort()).toEqual(ended);
    await record({
      rows: begunB.rows.map((r) => ({ orgRefid: r.orgRefid, attempts: r.attempts, from: 'sending', to: 'queued', reason: 'UNREACHABLE' })),
      call: { key: begunB.callKey, end: { state: 'failed', kind: 'transient', code: 'UNREACHABLE' } },
    });
    expect(await ledgerOf(begunB.callKey)).toEqual({ state: 'failed', calls: 1 });
    await requeue(ended);
    expect(await begin({ branchKnown: true, checked: true })).toEqual({ action: 'none', reason: 'nothing', waiting: true });
    expect(await failedAsEnded(ended)).toEqual([{ state: 'failed', reason: 'CALL_ENDED' }, { state: 'failed', reason: 'CALL_ENDED' }]);
    expect(await ledgerOf(begunB.callKey)).toEqual({ state: 'failed', calls: 1 });
  });

  it('a connection is not removed while vouchers MISA took have no result; once they have, the removal takes the rows with it (the audit trail and the ledger keep the history)', async () => {
    const before = (await pushRows()).length;
    expect(before).toBeGreaterThan(0);
    // The API asks first, before it revokes anything: refused while a row is sending, sent or ambiguous, so the channel and its access code stay; only owners and admins ask.
    expect((await pushRows()).some((r) => ['sending', 'sent', 'ambiguous'].includes(r.state))).toBe(true);
    await expect(api.query('finance.misa_amis_connection.can_disconnect', { id: connectionId }, asUser('owner'))).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_PENDING' });
    await expect(api.query('finance.misa_amis_connection.can_disconnect', { id: connectionId }, asUser('member'))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await rows<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE org_id = $1', [orgId])).every((r) => r.status !== 'revoked')).toBe(true);
    // The channel connection is revoked first (as the API does), then the row is removed by the command: refused while a row is sending, sent or ambiguous.
    await rows("UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1", [orgId]);
    expect((await pushRows()).some((r) => ['sending', 'sent', 'ambiguous'].includes(r.state))).toBe(true);
    await expect(api.execute('finance.misa_amis_connection.unlink', { id: connectionId }, asUser('owner'))).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_PENDING' });
    expect(await pushRows()).toHaveLength(before);
    await rows("UPDATE crove_finance.misa_amis_push SET state = 'failed', reason = 'x' WHERE connection_id = $1 AND state IN ('sending', 'sent', 'ambiguous')", [connectionId]);
    expect(await api.execute('finance.misa_amis_connection.unlink', { id: connectionId }, asUser('owner'))).toEqual({ removed: true });
    expect(await pushRows()).toEqual([]);
    expect((await rows('SELECT 1 FROM crove_kernel.external_call WHERE org_id = $1', [orgId])).length).toBeGreaterThan(0);
    expect((await rows('SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2', [orgId, 'finance.misa_amis.push'])).length).toBeGreaterThan(0);
  });

  // MISA ASP (#4113, S4 of #4103): the same begin, with no result check and no waiting for a row MISA took, which only the callback or a person settles.
  describe('a MISA ASP connection', () => {
    let aspConnection = '';
    const aspBegin = (opts: { branchKnown: boolean; checked: boolean }) => worker.execute<MisaAmisPushBegin>('finance.misa_amis.push_begin', { connectionId: aspConnection, ...opts }, SYSTEM());
    const aspRow = async (state: string, extra = '') => {
      const refid = randomUUID();
      await rows(
        `INSERT INTO crove_finance.misa_amis_push (org_id, legal_entity_id, connection_id, source_type, source_id, voucher_type, org_refid, org_refno, payload_digest, state${extra ? ', params' : ''})
         SELECT $1, legal_entity_id, id, 'cash_voucher', $2, 1, $3, $4, $5, $6${extra ? ", '{\"kind\":\"cash_payment\",\"from\":\"2026-10-01\",\"to\":\"2026-10-31\",\"purchasePurpose\":\"1\"}'::jsonb" : ''} FROM crove_finance.misa_amis_connection WHERE org_id = $1 AND id = $7`,
        [orgId, randomUUID(), refid, `PC${refid.slice(0, 8)}`, '0'.repeat(64), state, aspConnection],
      );
      return refid;
    };

    beforeAll(async () => {
      const entity = randomUUID();
      await rows("INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh ASP', 'branch', $3)", [orgId, entity, users.owner]);
      const channel = randomUUID();
      await rows("INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'accounting_misa_asp', $3, 'MISA ASP', $4)", [orgId, channel, entity, users.owner]);
      aspConnection = randomUUID();
      await rows("INSERT INTO crove_finance.misa_amis_connection (org_id, id, legal_entity_id, channel_connection_id, product, last_test_state, last_tested_at) VALUES ($1, $2, $3, $4, 'asp', 'works', pg_catalog.now())", [orgId, aspConnection, entity, channel]);
    });

    it('holds an ASP confirmation to the same fresh check as AMIS: refused with MISA_AMIS_CHECK_REQUIRED until a check of the batch exists (ASP checks come with #4152), and past that gate with a done check seeded (a wrong digest is STALE) (#4113)', async () => {
      // No source vouchers: the gates before the digest (blockers, too many) have nothing to say, so a wrong digest is what answers once the check gate is passed.
      vouchers = [];
      const confirm = () => api.execute('finance.misa_amis.push', { connectionId: aspConnection, ...ASK, digest: 'a'.repeat(64) }, asUser('owner'));
      await rows('DELETE FROM crove_finance.misa_amis_match_check WHERE connection_id = $1', [aspConnection]);
      await expect(confirm()).rejects.toMatchObject({ code: 'MISA_AMIS_CHECK_REQUIRED', status: 409 });
      // A done check seeded the way the S3a tests seed one (the route that asks for it is refused for ASP, the command is not).
      await api.execute('finance.misa_amis_match.request_check', { id: aspConnection, ask: ASK }, asUser('owner'));
      const [stored] = await rows<{ requested_at: Date }>('SELECT requested_at FROM crove_finance.misa_amis_match_check WHERE connection_id = $1', [aspConnection]);
      await worker.execute('finance.misa_amis_match.record_check', { connectionId: aspConnection, requestedAt: new Date(stored?.requested_at as Date).toISOString(), state: 'done', failure: null, results: [] }, SYSTEM());
      await expect(confirm()).rejects.toMatchObject({ code: 'MISA_AMIS_PUSH_STALE', status: 409 });
    });

    it('is handed to the worker with its product, and the begin never asks MISA for results of rows it took or whose answer was lost: those wait for the callback or a person', async () => {
      const target = await worker.query('finance.misa_amis.push_target', { connectionId: aspConnection }, SYSTEM());
      expect(target).toMatchObject({ action: 'push', id: aspConnection, product: 'asp' });
      const sent = await aspRow('sent');
      const ambiguous = await aspRow('ambiguous');
      // An AMIS connection would answer a `check` for these two rows; an ASP connection answers that there is nothing to do, and that nothing waits for a poll.
      expect(await aspBegin({ branchKnown: true, checked: false })).toEqual({ action: 'none', reason: 'nothing', waiting: false });
      expect((await rows<{ state: string }>('SELECT state FROM crove_finance.misa_amis_push WHERE org_refid = ANY($1) ORDER BY state', [[sent, ambiguous]])).map((r) => r.state)).toEqual(['ambiguous', 'sent']);
    });

    it('sends a queued row as for AMIS (the branch first, then the call committed to the ledger before the send), and the batch it is sending still counts as waiting so a lost answer is swept', async () => {
      const queued = await aspRow('queued', 'params');
      expect(await aspBegin({ branchKnown: false, checked: false })).toEqual({ action: 'need_branch' });
      const sending = await aspBegin({ branchKnown: true, checked: false });
      if (sending.action !== 'send') throw new Error(`expected a send, got ${sending.action}`);
      expect(sending.rows.map((r) => r.orgRefid)).toEqual([queued]);
      expect(sending.callKey).toContain(`misa_amis:save:${aspConnection}:`);
      expect((await rows<{ state: string }>('SELECT state FROM crove_finance.misa_amis_push WHERE org_refid = $1', [queued]))[0]?.state).toBe('sending');
      // While it is being sent the run waits (the next run sweeps it into `ambiguous` if its answer is lost): nothing else is queued, so there is nothing to send, and `waiting` stays true for the row in flight.
      expect(await aspBegin({ branchKnown: true, checked: true })).toEqual({ action: 'none', reason: 'nothing', waiting: true });
      await rows("UPDATE crove_finance.misa_amis_push SET updated_at = pg_catalog.now() - interval '10 minutes' WHERE org_refid = $1", [queued]);
      expect(await aspBegin({ branchKnown: true, checked: false })).toEqual({ action: 'none', reason: 'nothing', waiting: false });
      expect((await rows<{ state: string; reason: string }>('SELECT state, reason FROM crove_finance.misa_amis_push WHERE org_refid = $1', [queued]))[0]).toEqual({ state: 'ambiguous', reason: 'LOST_ANSWER' });
    });
  });
});

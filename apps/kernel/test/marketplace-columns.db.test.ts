// SPDX-License-Identifier: AGPL-3.0-only
// The check of a column mapping on an unrecognised marketplace order report (#4036, slice 1c of #3850), on a real PostgreSQL 17: who may ask (importers, a person, never an agent), one row per file (a second press
// returns the waiting one), what the worker may record (system only, an older request's record is dropped, a refusal and a preview never together), what the screen reads back, that a new request clears the
// verdict and keeps the sheet, the nightly prune (worker only), and that an erasure of a person deletes the check whose preview quotes them. Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and
// drops its own database.
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

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-marketplace-columns-0123456789';
const ISSUER = 'ludy-auth';

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

const suite = ADMIN ? describe : describe.skip;

const SYSTEM = { type: 'system' as const, component: 'finance.marketplace_columns' };
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
// The made-up buyer of a preview line: this email appears in no real person's name.
const BUYER_EMAIL = 'mua.thu.sang@example.com';
const SHEET = {
  headerRow: 2,
  columns: [
    { index: 0, header: 'Số hiệu đơn', samples: ['9999', '9999'], buyer: false },
    { index: 1, header: '', samples: [], buyer: true },
    { index: 2, header: 'Số lượng', samples: ['9'], buyer: false },
  ],
};
const PREVIEW = {
  lines: [{ rowNo: 3, orderNo: '9001', lineKey: `Bút ${BUYER_EMAIL}`, sku: null, itemName: 'Bút', quantity: '2', amount: '100000', status: 'Hoàn thành' }],
  total: 1,
  skipped: 0,
};
const MAPPING = { platform: 'shopee', assignments: [{ index: 0, field: 'orderNo' }, { index: 2, field: 'quantity' }] } as const;

suite('Marketplace column check (#4036)', () => {
  const dbName = `ludy_test_marketplace_columns_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  // The worker's runtime (the system actor of the test job) and the one the API uses.
  let worker: Runtime;
  let api: Runtime;
  let vault: CredentialVault;
  let app: ReturnType<typeof createHttpApp>;
  const owner: Account = { subject: randomUUID(), email: 'owner@marketplace-columns.test', session: randomUUID(), userId: '' };
  const adminUser: Account = { subject: randomUUID(), email: 'admin@marketplace-columns.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@marketplace-columns.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@marketplace-columns.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@marketplace-columns.test', session: randomUUID(), userId: '' };
  let slug = '';
  let orgId = '';
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
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(org ? { 'x-ludy-org': org } : {}) },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const text = await response.text();
    const body = (text ? JSON.parse(text) : null) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, text, body: (body && 'json' in body ? body.json : body) as any };
  }
  const call = async (path: string, who: Account, input?: unknown, org: string | null = slug) => rpc(`marketplace/${path}`, await tokenFor(who), input, org);
  const asUser = (who: Account) => ({ type: 'user' as const, userId: who.userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

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
    app = createHttpApp({ ...deps, channels: { broker: vault, sandbox: false } });

    for (const who of [owner, adminUser, member, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Báo cáo sàn', idempotencyKey: randomUUID() }, null);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser.userId, member.userId, viewer.userId]);
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
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

  // An org's own file, and the run the worker's readers left on it.
  async function fileOf(org: string, run: { method: string; result: unknown } | null, contentType = XLSX, size = 1000): Promise<string> {
    const id = randomUUID();
    const sha256 = randomBytes(32).toString('hex');
    await rows('INSERT INTO ludy_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [org, id, sha256, `org/${org}/${sha256}`, 'bao-cao.xlsx', contentType, size, 'upload']);
    if (run) await rows("INSERT INTO ludy_kernel.extraction (org_id, file_id, method, status, result, checks) VALUES ($1, $2, $3, 'failed', $4::jsonb, '[]')", [org, id, run.method, run.result === null ? null : JSON.stringify(run.result)]);
    return id;
  }
  const events = async (fileId: string) => (await rows<{ payload: { file_id?: string } }>("SELECT payload FROM ludy_kernel.outbox_event WHERE org_id = $1 AND type = 'finance.marketplace_column_check.requested' AND payload ->> 'file_id' = $2 ORDER BY id", [orgId, fileId])).map((r) => r.payload);
  const checkRow = async (fileId: string) => (await rows<{ state: string; failure: string | null; refusal: string | null; platform: string | null; assignments: unknown; sheet: unknown; preview: unknown; requested_by: string | null; finished_at: Date | null }>('SELECT state, failure, refusal, platform, assignments, sheet, preview, requested_by, finished_at FROM ludy_finance.marketplace_column_check WHERE org_id = $1 AND file_id = $2', [orgId, fileId]))[0];
  const requestedAt = async (fileId: string) => new Date((await rows<{ requested_at: Date }>('SELECT requested_at FROM ludy_finance.marketplace_column_check WHERE org_id = $1 AND file_id = $2', [orgId, fileId]))[0]!.requested_at).toISOString();
  const record = async (fileId: string, result: unknown, at?: string) => worker.execute('finance.marketplace.columns_record', { fileId, requestedAt: at ?? (await requestedAt(fileId)), result }, { actor: SYSTEM, orgId });
  const status = (who: Account, fileId: string) => call('columns', who, { fileId });
  let fileId = '';

  it('asks for a check: importers only, a person (never an agent), for an unrecognised spreadsheet of the org only', async () => {
    fileId = await fileOf(orgId, { method: 'unsupported', result: null });
    expect((await call('columnsCheck', viewer, { fileId, idempotencyKey: randomUUID() })).status).toBe(403);
    expect(await checkRow(fileId)).toBeUndefined();
    // A file that is not a spreadsheet, a report a reader recognised, a bank statement, an invoice, a file of another org and a file that is not there are all the same 404.
    const pdf = await fileOf(orgId, { method: 'unsupported', result: null }, 'application/pdf');
    const recognised = await fileOf(orgId, { method: 'unsupported', result: { kind: 'marketplace_orders', summary: { state: 'staged' } } });
    const statement = await fileOf(orgId, { method: 'unsupported', result: { kind: 'bank_statement', summary: { state: 'staged' } } });
    const invoice = await fileOf(orgId, { method: 'einvoice_xml', result: { kind: 'invoice' } });
    const foreign = await fileOf(otherOrgId, { method: 'unsupported', result: null });
    for (const id of [pdf, recognised, statement, invoice, foreign, randomUUID()]) {
      expect(await call('columnsCheck', owner, { fileId: id, idempotencyKey: randomUUID() }), id).toMatchObject({ status: 404, body: { code: 'MARKETPLACE_COLUMNS_NOT_FOUND' } });
    }
    // An agent cannot ask: the command refuses any actor that is not a person.
    await expect(api.execute('finance.marketplace.columns_check', { fileId }, { actor: { type: 'agent', agentId: randomUUID() } as never, orgId })).rejects.toBeTruthy();
    for (const who of [member, adminUser, owner]) {
      const id = await fileOf(orgId, { method: 'unsupported', result: null });
      expect((await call('columnsCheck', who, { fileId: id, idempotencyKey: randomUUID() })).status, who.email).toBe(200);
    }
  });

  it('files one row per file, queues the worker once with the file id alone, and answers a second press with the one that waits', async () => {
    const first = await call('columnsCheck', adminUser, { fileId, idempotencyKey: randomUUID() });
    expect(first).toMatchObject({ status: 200, body: { queued: true, running: false } });
    expect(await checkRow(fileId)).toMatchObject({ state: 'requested', failure: null, refusal: null, platform: null, assignments: [], sheet: null, preview: null, finished_at: null, requested_by: adminUser.userId });
    expect(await events(fileId)).toEqual([{ file_id: fileId }]);
    // The same ask while the first waits returns it: no second event, the row unchanged.
    expect(await call('columnsCheck', owner, { fileId, idempotencyKey: randomUUID() })).toMatchObject({ status: 200, body: { queued: false, running: true } });
    expect(await events(fileId)).toHaveLength(1);
    expect((await checkRow(fileId))?.requested_by).toBe(adminUser.userId);
    // Another mapping files it anew (the earlier job's record is then ignored): one row still, one more event.
    expect(await call('columnsCheck', owner, { fileId, mapping: MAPPING, idempotencyKey: randomUUID() })).toMatchObject({ status: 200, body: { queued: true, running: false } });
    expect(await events(fileId)).toHaveLength(2);
    expect(await checkRow(fileId)).toMatchObject({ state: 'requested', platform: 'shopee', assignments: MAPPING.assignments, requested_by: owner.userId });
    expect(await rows('SELECT 1 FROM ludy_finance.marketplace_column_check WHERE org_id = $1 AND file_id = $2', [orgId, fileId])).toHaveLength(1);
    // The same mapping pressed again while it waits returns the waiting one: the stored jsonb keeps its keys in its own order, so the mappings are compared field by field.
    expect(await call('columnsCheck', adminUser, { fileId, mapping: MAPPING, idempotencyKey: randomUUID() })).toMatchObject({ status: 200, body: { queued: false, running: true } });
    expect(await events(fileId)).toHaveLength(2);
  });

  it('asks again once the waiting check is older than ten minutes (a lost job must not block the file for ever)', async () => {
    await rows("UPDATE ludy_finance.marketplace_column_check SET requested_at = now() - interval '11 minutes' WHERE org_id = $1 AND file_id = $2", [orgId, fileId]);
    expect(await call('columnsCheck', owner, { fileId, mapping: MAPPING, idempotencyKey: randomUUID() })).toMatchObject({ status: 200, body: { queued: true, running: false } });
    expect(await events(fileId)).toHaveLength(3);
  });

  it('hands the worker the waiting check, and the worker alone: a user is refused the target and the record', async () => {
    const target = await worker.query('finance.marketplace.columns_target', { fileId }, { actor: SYSTEM, orgId });
    expect(target).toMatchObject({ action: 'check', fileId, mapping: MAPPING, requestedAt: await requestedAt(fileId) });
    await expect(api.query('finance.marketplace.columns_target', { fileId }, { actor: asUser(owner), orgId })).rejects.toMatchObject({ status: 403 });
    await expect(api.execute('finance.marketplace.columns_record', { fileId, requestedAt: new Date().toISOString(), result: { state: 'failed', failure: 'unavailable' } }, { actor: asUser(owner), orgId })).rejects.toMatchObject({ status: 403 });
    expect((await checkRow(fileId))?.state).toBe('requested');
  });

  it('ignores the record of an older request, and refuses a record that is malformed (a refusal and a preview together, a sheet that is not one, a preview of more than 20 lines)', async () => {
    expect(await record(fileId, { state: 'failed', failure: 'unavailable' }, new Date(Date.now() - 3_600_000).toISOString())).toMatchObject({ recorded: false });
    expect((await checkRow(fileId))?.state).toBe('requested');
    await expect(record(fileId, { state: 'done', sheet: SHEET, refusal: 'no_header', preview: PREVIEW })).rejects.toMatchObject({ code: 'MARKETPLACE_COLUMNS_INVALID' });
    await expect(record(fileId, { state: 'done', sheet: { headerRow: 2, columns: [{ index: 0, header: 'x', samples: ['0900000007'], buyer: false }] }, refusal: null, preview: null })).rejects.toBeTruthy();
    await expect(record(fileId, { state: 'done', sheet: SHEET, refusal: null, preview: { ...PREVIEW, lines: Array.from({ length: 21 }, () => PREVIEW.lines[0]) } })).rejects.toBeTruthy();
    expect((await checkRow(fileId))?.state).toBe('requested');
  });

  it('records a done check: the sheet, the verdict and the preview, read back by importers and refused to a viewer', async () => {
    expect(await record(fileId, { state: 'done', sheet: SHEET, refusal: null, preview: PREVIEW })).toMatchObject({ recorded: true });
    expect(await checkRow(fileId)).toMatchObject({ state: 'done', failure: null, refusal: null, sheet: SHEET, preview: PREVIEW });
    expect((await checkRow(fileId))?.finished_at).not.toBeNull();
    for (const who of [member, adminUser, owner]) {
      expect(await status(who, fileId), who.email).toMatchObject({ status: 200, body: { state: 'done', refusal: null, mapping: MAPPING, sheet: SHEET, preview: PREVIEW } });
    }
    expect((await status(viewer, fileId)).status).toBe(403);
    expect((await status(outsider, fileId)).status).not.toBe(200);
    // A record again for the same request is not recorded twice (the check is no longer waiting).
    expect(await record(fileId, { state: 'failed', failure: 'unavailable' }, await requestedAt(fileId))).toMatchObject({ recorded: false });
    // The audit row holds counts and codes: no header, no sample, no line, no email.
    const audit = JSON.stringify(await rows("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command LIKE 'finance.marketplace.columns%'", [orgId]));
    expect(audit).not.toContain(BUYER_EMAIL);
    expect(audit).not.toContain('Số hiệu đơn');
    expect(audit).not.toContain('Bút');
  });

  it('answers a file nobody asked about as none, and a new request clears the verdict and the preview and keeps the sheet', async () => {
    const fresh = await fileOf(orgId, { method: 'unsupported', result: null });
    expect(await status(owner, fresh)).toMatchObject({ status: 200, body: { state: 'none', sheet: null, preview: null, mapping: null } });
    // The file of the tests above: its mapping is asked again, differently.
    expect(await call('columnsCheck', owner, { fileId, mapping: { platform: 'lazada', assignments: [{ index: 0, field: 'orderNo' }] }, idempotencyKey: randomUUID() })).toMatchObject({ status: 200, body: { queued: true } });
    expect(await checkRow(fileId)).toMatchObject({ state: 'requested', platform: 'lazada', refusal: null, preview: null, sheet: SHEET });
    // A check that failed is read as failed, with its code and no sheet change.
    expect(await record(fileId, { state: 'failed', failure: 'too_large' })).toMatchObject({ recorded: true });
    expect(await status(owner, fileId)).toMatchObject({ status: 200, body: { state: 'failed', failure: 'too_large', sheet: SHEET, preview: null } });
  });

  it('keeps the refusal of a mapping the check refused, and lets the sheet record with no mapping', async () => {
    const other = await fileOf(orgId, { method: 'unsupported', result: null });
    expect((await call('columnsCheck', owner, { fileId: other, mapping: MAPPING, idempotencyKey: randomUUID() })).status).toBe(200);
    expect(await record(other, { state: 'done', sheet: SHEET, refusal: 'buyer_text', preview: null })).toMatchObject({ recorded: true });
    expect(await status(owner, other)).toMatchObject({ status: 200, body: { state: 'done', refusal: 'buyer_text', preview: null, sheet: SHEET } });
  });

  it('lists the unrecognised spreadsheets of the org newest first with where each check stands, no more than ten, and nothing else', async () => {
    const files = async (who: Account) => call('columnsFiles', who, {});
    // A recognised report, a PDF, and a file of another org are not offered; a new unrecognised spreadsheet is, first, with no check yet.
    const recognised = await fileOf(orgId, { method: 'unsupported', result: { kind: 'marketplace_orders' } });
    const pdf = await fileOf(orgId, { method: 'unsupported', result: null }, 'application/pdf');
    const otherOrg = await fileOf(otherOrgId, { method: 'unsupported', result: null });
    const fresh = await fileOf(orgId, { method: 'unsupported', result: null });
    for (const who of [owner, adminUser, member]) {
      const answer = await files(who);
      expect(answer.status, who.email).toBe(200);
      const list = answer.body as Array<{ fileId: string; filename: string; createdAt: string; state: string }>;
      expect(list.length).toBeLessThanOrEqual(10);
      expect(list[0], who.email).toMatchObject({ fileId: fresh, state: 'none' });
      const ids = list.map((f) => f.fileId);
      for (const hidden of [recognised, pdf, otherOrg]) expect(ids).not.toContain(hidden);
      // Names and states only: nothing of a sheet or a preview.
      expect(Object.keys(list[0] ?? {}).sort()).toEqual(['createdAt', 'fileId', 'filename', 'state']);
    }
    // Once asked, the file says where its check stands.
    expect((await call('columnsCheck', owner, { fileId: fresh, idempotencyKey: randomUUID() })).status).toBe(200);
    expect(((await files(owner)).body as Array<{ fileId: string; state: string }>)[0]).toMatchObject({ fileId: fresh, state: 'requested' });
    expect(await record(fresh, { state: 'done', sheet: SHEET, refusal: null, preview: null })).toMatchObject({ recorded: true });
    expect(((await files(owner)).body as Array<{ fileId: string; state: string }>)[0]).toMatchObject({ fileId: fresh, state: 'done' });
    // A viewer and an outsider are refused.
    expect((await files(viewer)).status).toBe(403);
    expect((await files(outsider)).status).not.toBe(200);
  });

  // A person's own context writes SQL as the tenant role: the policies let an importer write a row, so the guard alone must stop a person from typing a result (a forged passed check must never reach #4037's
  // confirm). Each statement runs in a transaction that is rolled back; the answer is the error, or `ok` and what the row held.
  const asPerson = (who: Account, statement: string, values: unknown[] = []) =>
    admin(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(who.userId, orgId)]);
        await c.query('SET LOCAL ROLE ludy_tenant');
        await c.query(statement, values);
        return 'ok';
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
      return 'ok';
    } catch (error) {
      return String((error as Error).message);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  };

  it('lets no person type a result: owner, admin and member contexts cannot move a check to done or failed, nor write the failure, the refusal, the sheet, the preview or the finish time', async () => {
    const waiting = await fileOf(orgId, { method: 'unsupported', result: null });
    expect((await call('columnsCheck', owner, { fileId: waiting, mapping: MAPPING, idempotencyKey: randomUUID() })).status).toBe(200);
    const where = `WHERE org_id = '${orgId}' AND file_id = '${waiting}'`;
    const forged = [
      `UPDATE ludy_finance.marketplace_column_check SET state = 'done', finished_at = now() ${where}`,
      `UPDATE ludy_finance.marketplace_column_check SET state = 'failed', failure = 'unavailable' ${where}`,
      `UPDATE ludy_finance.marketplace_column_check SET state = 'done', finished_at = now(), sheet = '{"headerRow":1,"columns":[]}'::jsonb, preview = '{"lines":[],"total":0,"skipped":0}'::jsonb ${where}`,
      `UPDATE ludy_finance.marketplace_column_check SET refusal = 'no_header' ${where}`,
      `UPDATE ludy_finance.marketplace_column_check SET sheet = '{"headerRow":1,"columns":[]}'::jsonb ${where}`,
      `UPDATE ludy_finance.marketplace_column_check SET preview = '{"lines":[],"total":0,"skipped":0}'::jsonb ${where}`,
      `UPDATE ludy_finance.marketplace_column_check SET finished_at = now() ${where}`,
      `UPDATE ludy_finance.marketplace_column_check SET failure = 'too_large' ${where}`,
    ];
    for (const who of [owner, adminUser, member]) {
      for (const statement of forged) expect(await asPerson(who, statement), `${who.email}: ${statement}`).toMatch(/MARKETPLACE_COLUMN_CHECK_STATE|marketplace_column_check_state_ck/);
    }
    // An insert of a check that says it is done is made a plain request: the guard clears every result column (the row is checked inside the same transaction, then rolled back).
    const fresh = await fileOf(orgId, { method: 'unsupported', result: null });
    for (const who of [owner, adminUser, member]) {
      const seen = await admin(async (c) => {
        await c.query('BEGIN');
        try {
          await c.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(who.userId, orgId)]);
          await c.query('SET LOCAL ROLE ludy_tenant');
          await c.query(`INSERT INTO ludy_finance.marketplace_column_check (org_id, file_id, state, finished_at, refusal, sheet, preview) VALUES ($1, $2, 'done', now(), 'no_header', '{"headerRow":1,"columns":[]}'::jsonb, '{"lines":[],"total":0,"skipped":0}'::jsonb)`, [orgId, fresh]);
          const { rows: made } = await c.query<{ state: string; failure: string | null; refusal: string | null; sheet: unknown; preview: unknown; finished_at: Date | null }>('SELECT state, failure, refusal, sheet, preview, finished_at FROM ludy_finance.marketplace_column_check WHERE org_id = $1 AND file_id = $2', [orgId, fresh]);
          return made[0];
        } catch (error) {
          return String((error as Error).message);
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(seen, who.email).toEqual({ state: 'requested', failure: null, refusal: null, sheet: null, preview: null, finished_at: null });
    }
    // What a person may do: ask again (the platform, the mapping, who and when change together; the verdict is cleared).
    for (const who of [owner, adminUser, member]) {
      expect(await asPerson(who, `UPDATE ludy_finance.marketplace_column_check SET platform = 'lazada', assignments = '[{"index":0,"field":"orderNo"}]'::jsonb, requested_by = '${who.userId}', requested_at = now(), state = 'requested', failure = NULL, refusal = NULL, preview = NULL ${where}`), who.email).toBe('ok');
    }
    // The worker's system context records a result, and never changes what was asked.
    expect(await asSystem(`UPDATE ludy_finance.marketplace_column_check SET platform = 'tiktok_shop' ${where}`)).toMatch(/MARKETPLACE_COLUMN_CHECK_STATE/);
    expect(await asSystem(`UPDATE ludy_finance.marketplace_column_check SET assignments = '[]'::jsonb ${where}`)).toMatch(/MARKETPLACE_COLUMN_CHECK_STATE/);
    expect(await asSystem(`UPDATE ludy_finance.marketplace_column_check SET state = 'done', finished_at = now() ${where}`)).toBe('ok');
    // Nothing above changed the row: it still waits, as the person last asked.
    expect(await checkRow(waiting)).toMatchObject({ state: 'requested', failure: null, refusal: null, sheet: null, preview: null, finished_at: null, platform: 'shopee' });
  });

  it('prunes the checks that finished more than the days ago, for the worker alone', async () => {
    const old = await fileOf(orgId, { method: 'unsupported', result: null });
    expect((await call('columnsCheck', owner, { fileId: old, idempotencyKey: randomUUID() })).status).toBe(200);
    expect(await record(old, { state: 'done', sheet: SHEET, refusal: null, preview: null })).toMatchObject({ recorded: true });
    await rows("UPDATE ludy_finance.marketplace_column_check SET finished_at = now() - interval '8 days', requested_at = now() - interval '8 days' WHERE org_id = $1 AND file_id = $2", [orgId, old]);
    // The app role (the API) cannot call it; the worker can, and it removes the old check and keeps the recent one.
    await expect(pool.query('SELECT ludy_finance.marketplace_column_check_prune(7)')).rejects.toThrow(/permission denied|WORKER_ONLY/);
    const recent = (await checkRow(fileId))?.state;
    const pruned = await workerPool.query<{ n: number }>('SELECT ludy_finance.marketplace_column_check_prune(7) AS n');
    expect(pruned.rows[0]?.n).toBeGreaterThanOrEqual(1);
    expect(await checkRow(old)).toBeUndefined();
    expect((await checkRow(fileId))?.state).toBe(recent);
    await expect(workerPool.query('SELECT ludy_finance.marketplace_column_check_prune(0)')).rejects.toThrow(/RETENTION_DAYS/);
    // A check asked again today keeps its old finish time (the guard allows no other move), and the prune looks at the later of the two: the waiting request is not deleted for an old finish.
    const again = await fileOf(orgId, { method: 'unsupported', result: null });
    expect((await call('columnsCheck', owner, { fileId: again, idempotencyKey: randomUUID() })).status).toBe(200);
    expect(await record(again, { state: 'done', sheet: SHEET, refusal: null, preview: null })).toMatchObject({ recorded: true });
    await rows("UPDATE ludy_finance.marketplace_column_check SET finished_at = now() - interval '8 days', requested_at = now() - interval '8 days' WHERE org_id = $1 AND file_id = $2", [orgId, again]);
    expect((await call('columnsCheck', owner, { fileId: again, mapping: MAPPING, idempotencyKey: randomUUID() })).status).toBe(200);
    expect(await checkRow(again)).toMatchObject({ state: 'requested' });
    await workerPool.query('SELECT ludy_finance.marketplace_column_check_prune(7)');
    expect((await checkRow(again))?.state).toBe('requested');
  });

  it('deletes the check whose preview quotes a person when an owner erases that person, and keeps the others', async () => {
    const quoted = await fileOf(orgId, { method: 'unsupported', result: null });
    expect((await call('columnsCheck', owner, { fileId: quoted, mapping: MAPPING, idempotencyKey: randomUUID() })).status).toBe(200);
    expect(await record(quoted, { state: 'done', sheet: SHEET, refusal: null, preview: PREVIEW })).toMatchObject({ recorded: true });
    const clean = await fileOf(orgId, { method: 'unsupported', result: null });
    expect((await call('columnsCheck', owner, { fileId: clean, mapping: MAPPING, idempotencyKey: randomUUID() })).status).toBe(200);
    expect(await record(clean, { state: 'done', sheet: SHEET, refusal: null, preview: { ...PREVIEW, lines: [{ ...PREVIEW.lines[0], lineKey: 'Bút|Xanh' }] } })).toMatchObject({ recorded: true });
    const erased = await api.execute<{ cleared: Record<string, number> }>('kernel.personal_data.erase', { value: BUYER_EMAIL }, { actor: asUser(owner), orgId, idempotencyKey: randomUUID() });
    expect(JSON.stringify(erased)).toContain('ludy_finance.marketplace_column_check.preview');
    expect(await checkRow(quoted)).toBeUndefined();
    expect((await checkRow(clean))?.state).toBe('done');
  });
});

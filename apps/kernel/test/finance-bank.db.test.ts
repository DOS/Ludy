// Bank statement import (issue #326, stage 1), on a real PostgreSQL 17, through the HTTP API: a statement becomes the
// lines of a bank account, an overlapping re-import stores only what it adds, "+X, -X, +X" on one day keeps all three,
// lines with neither reference nor balance are flagged instead of dropped or doubled, a newest-first file is stored
// oldest first, a mid-day overlap shows as a break in the running balance, and the account, the roles and the org
// boundary are checked. A bank feed's lines (ADR-0039, #2044) go through the same path: finance.bank.ingest, a system
// command, stores what is new, and a transaction the feed and a statement file both report is one line. The rules
// themselves are unit-tested in modules/finance/test/bank-statement.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeStatementAmount, type BankFeedLine, type BankImportResult, type BankStatementRow } from '@crove/kernel-contract';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries } from '@crove/kernel';
import { CredentialVault, contentGeneration, fileKey, parseVaultKey, Runtime, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries, type StatementStageOutcome } from '@crove/mod-finance';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { runBankFeedSync } from '../src/bank-feed-sync.ts';
import { bankFeedProviders, signSandboxWebhook } from '@crove/bank-feed';
import { RateLimiter } from '../src/rate-limit.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-bank-statements-0123456789';
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

const suite = ADMIN ? describe : describe.skip;
const WEBHOOK_SECRET = 'bank-feed-webhook-secret-0123456789-abcdef';

suite('bank statement import (#326)', () => {
  const dbName = `crove_test_bank_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let app: ReturnType<typeof createHttpApp>;
  // With the sandbox bank feed on (ADR-0039, #2044), and a credential key to seal its secret.
  let feedApp: ReturnType<typeof createHttpApp>;
  // The same, with a tight limit on signed notices per address.
  let limitedApp: ReturnType<typeof createHttpApp>;
  let vault: CredentialVault;
  // The API's runtime, and the worker's, which runs feed jobs as the system.
  let api: Runtime;
  let worker: Runtime;
  const workerPools: pg.Pool[] = [];
  const owner: Account = { subject: randomUUID(), email: 'owner@bank.test', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@bank.test', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@bank.test', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@bank.test', session: randomUUID(), userId: '' };
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

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false, ...mfa })
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
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as any };
  }

  // A row as the browser sends it: amounts printed as text cells, normalized.
  let rowNo = 1;
  const row = (date: string, moneyIn: string, moneyOut: string, balance = '', reference = '', description = 'Giao dịch'): BankStatementRow => ({
    rowNo: rowNo++,
    date,
    description,
    moneyIn: normalizeStatementAmount(moneyIn),
    moneyOut: normalizeStatementAmount(moneyOut),
    balance: normalizeStatementAmount(balance),
    reference,
  });
  const file = (rows: BankStatementRow[], bankAccount = '1121') => ({ bankAccount, filename: 'sao-ke.xlsx', rows });
  const preview = async (rows: BankStatementRow[], bankAccount = '1121', who = member) => rpc('bank/preview', await tokenFor(who), file(rows, bankAccount));
  const importFile = async (rows: BankStatementRow[], bankAccount = '1121', who = member, org = slug) =>
    rpc('bank/import', await tokenFor(who), { ...file(rows, bankAccount), idempotencyKey: randomUUID() }, org);
  const lines = async (period: string, bankAccount = '1121', who = viewer) => rpc('bank/lines', await tokenFor(who), { bankAccount, period });
  const stored = (account = '1121') =>
    admin(
      async (c) =>
        (
          await c.query<{ value_date: string; amount: string; running_balance: string | null; bank_ref: string | null; dedupe_key: string | null; ambiguous: boolean; position: number }>(
            `SELECT to_char(value_date, 'YYYY-MM-DD') AS value_date, amount::text, running_balance::text, bank_ref, dedupe_key, ambiguous, position
             FROM crove_finance.bank_line WHERE org_id = $1 AND bank_account = $2 ORDER BY value_date, import_id, position`,
            [orgId, account],
          )
        ).rows,
    );

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
    const db: Db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    app = createHttpApp({ config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    api = runtime;
    vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const notices = Object.fromEntries(Object.entries(bankFeedProviders({ sandbox: true, sandboxWebhookSecret: WEBHOOK_SECRET })).filter(([, p]) => p.verifyWebhook));
    const feedDeps = { config, runtime, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false, channels: { broker: vault, sandbox: false, bankFeedSandbox: true } };
    feedApp = createHttpApp({ ...feedDeps, bankFeedWebhooks: notices });
    limitedApp = createHttpApp({ ...feedDeps, bankFeedWebhooks: notices, bankFeedWebhookLimit: new RateLimiter({ perMinute: 2 }) });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'crove_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    workerPools.push(workerPool);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });

    for (const who of [owner, member, viewer, outsider]) {
      const me = await rpc('me/get', await tokenFor(who), undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body?.userId);
    }
    const created = await rpc('org/create', await tokenFor(owner), { name: 'Công ty Ngân hàng', idempotencyKey: randomUUID() }, null);
    slug = String(created.body?.slug);
    orgId = String(created.body?.orgId);
    for (const [who, role] of [
      [member, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await rpc('org/invite', await tokenFor(owner, { mfa: true }), { email: who.email, role });
      expect(invite.status).toBe(200);
      expect((await rpc('invites/accept', await tokenFor(who), { token: String(invite.body?.acceptPath).split('#')[1] }, null)).status).toBe(200);
    }
    const other = await rpc('org/create', await tokenFor(outsider), { name: 'Công ty khác', idempotencyKey: randomUUID() }, null);
    otherSlug = String(other.body?.slug);
    // A bank sub-account per bank (#319), and one the org stopped using.
    for (const [code, name] of [
      ['1121.VCB', 'Vietcombank'],
      ['1121.OLD', 'Tài khoản cũ'],
    ]) {
      expect((await rpc('accounts/create', await tokenFor(owner), { parentCode: '1121', code, name })).status).toBe(200);
    }
    expect((await rpc('accounts/update', await tokenFor(owner), { code: '1121.OLD', active: false })).status).toBe(200);
    // The other org's own sub-account, which this org cannot use.
    expect((await rpc('accounts/create', await tokenFor(outsider), { parentCode: '1121', code: '1121.ACB', name: 'ACB' }, otherSlug)).status).toBe(200);
  });

  afterAll(async () => {
    await pool?.end();
    for (const p of workerPools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('imports a statement, then stores only the lines an overlapping one adds', async () => {
    const first = [
      row('01/09/2026', '50.000.000', '', '50.000.000', 'FT001', 'Góp vốn'),
      row('03/09/2026', '', '11.000', '49.989.000', 'FT002', 'Phí SMS'),
      row('05/09/2026', '', '19.800.000', '30.189.000', 'FT003', 'Trả tiền hàng'),
    ];
    const checked = await preview(first);
    expect(checked).toMatchObject({ status: 200, body: { ok: true, order: 'oldest_first', counts: { new: 3, duplicate: 0, ambiguous: 0, invalid: 0 }, breaks: [], from: '2026-09-01', to: '2026-09-05' } });
    expect(await stored()).toEqual([]);
    const imported = await importFile(first);
    expect(imported).toMatchObject({ status: 200, body: { counts: { new: 3 }, breaks: [] } });
    // The overlapping export repeats two lines and adds one.
    const again = await importFile([first[1] as BankStatementRow, first[2] as BankStatementRow, row('07/09/2026', '2.000.000', '', '32.189.000', 'FT004', 'Khách trả tiền')]);
    expect(again).toMatchObject({ status: 200, body: { counts: { new: 1, duplicate: 2, ambiguous: 0, invalid: 0 }, breaks: [] } });
    expect((await stored()).map((l) => [l.value_date, l.amount, l.bank_ref, l.dedupe_key])).toEqual([
      ['2026-09-01', '50000000.0000', 'FT001', 'ref:FT001'],
      ['2026-09-03', '-11000.0000', 'FT002', 'ref:FT002'],
      ['2026-09-05', '-19800000.0000', 'FT003', 'ref:FT003'],
      ['2026-09-07', '2000000.0000', 'FT004', 'ref:FT004'],
    ]);
    const audits = await admin(
      async (c) => (await c.query(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.bank.import' AND outcome = 'ok' ORDER BY occurred_at`, [orgId])).rows,
    );
    expect(audits.map((a) => a.detail)).toEqual([
      expect.objectContaining({ bankAccount: '1121', new: 3, duplicate: 0, from: '2026-09-01', to: '2026-09-05', breaks: 0, filename: 'sao-ke.xlsx' }),
      expect.objectContaining({ bankAccount: '1121', new: 1, duplicate: 2 }),
    ]);
    // The lines of September, with money in and out.
    expect(await lines('2026-09')).toMatchObject({
      status: 200,
      body: { from: '2026-09-01', to: '2026-09-30', moneyIn: '52000000', moneyOut: '19811000', lines: [{ amount: '50000000', balance: '50000000', reference: 'FT001' }, {}, {}, { date: '2026-09-07' }] },
    });
  });

  it('keeps "+X, -X, +X" on one day, and a re-import of it stores nothing', async () => {
    const day = [row('10/09/2026', '5.000', '', '1.005.000'), row('10/09/2026', '', '5.000', '1.000.000'), row('10/09/2026', '5.000', '', '1.005.000')];
    expect(await importFile(day, '1121.VCB')).toMatchObject({ status: 200, body: { counts: { new: 3, duplicate: 0 } } });
    expect(await importFile(day, '1121.VCB')).toMatchObject({ status: 200, body: { counts: { new: 0, duplicate: 3 } } });
    expect((await stored('1121.VCB')).map((l) => l.dedupe_key)).toEqual([
      'bal:2026-09-10|5000|1005000|0',
      'bal:2026-09-10|-5000|1000000|0',
      'bal:2026-09-10|5000|1005000|1',
    ]);
  });

  it('flags lines with neither reference nor balance when an earlier import has the same date and amount', async () => {
    const plain = [row('12/09/2026', '', '22.000'), row('12/09/2026', '', '22.000')];
    // Identical lines in one file are both kept.
    expect(await importFile(plain, '1121.VCB')).toMatchObject({ status: 200, body: { counts: { new: 2, ambiguous: 0 } } });
    // The same file again: both kept, flagged for a person to decide, never dropped silently.
    expect(await importFile(plain, '1121.VCB')).toMatchObject({ status: 200, body: { counts: { new: 0, ambiguous: 2 } } });
    const twelfth = (await stored('1121.VCB')).filter((l) => l.value_date === '2026-09-12');
    expect(twelfth.map((l) => [l.dedupe_key, l.ambiguous])).toEqual([
      [null, false],
      [null, false],
      [null, true],
      [null, true],
    ]);
    expect((await lines('2026-09', '1121.VCB')).body.lines.filter((l: { ambiguous: boolean }) => l.ambiguous)).toHaveLength(2);
  });

  it('stores a newest-first file oldest first', async () => {
    await importFile(
      [row('22/09/2026', '', '300', '700', 'NB3'), row('21/09/2026', '', '200', '1.000', 'NB2'), row('20/09/2026', '1.200', '', '1.200', 'NB1')],
      '1121.VCB',
    );
    const newest = (await stored('1121.VCB')).filter((l) => l.bank_ref?.startsWith('NB'));
    expect(newest.map((l) => [l.bank_ref, l.position])).toEqual([
      ['NB1', 1],
      ['NB2', 2],
      ['NB3', 3],
    ]);
  });

  it('shows a mid-day overlap that would drop a line as a break in the running balance', async () => {
    // Stored: an export that ended at noon on the 25th.
    await importFile([row('24/09/2026', '100.000', '', '100.000'), row('25/09/2026', '5.000', '', '105.000')], '1121');
    // The next export starts at noon: -5,000 then +5,000 (same date, amount, balance and occurrence as the stored line),
    // then +1,000. The repeated +5,000 is taken for the stored one, so the +1,000 no longer follows from the balance.
    const next = [row('25/09/2026', '', '5.000', '100.000'), row('25/09/2026', '5.000', '', '105.000'), row('25/09/2026', '1.000', '', '106.000')];
    const checked = await preview(next, '1121');
    expect(checked.body.counts).toMatchObject({ new: 2, duplicate: 1 });
    expect(checked.body.breaks).toEqual([{ date: '2026-09-25', rowNo: next[2]?.rowNo, expected: '101000', balance: '106000' }]);
    expect(await importFile(next, '1121')).toMatchObject({ status: 200, body: { breaks: [{ date: '2026-09-25', expected: '101000' }] } });
  });

  it('refuses a file with an unreadable row, and stores none of it', async () => {
    const bad = [row('26/09/2026', '1.000', '', '', 'OK1'), row('Tổng cộng', '1.000', ''), row('27/09/2026', '1', '2', '', 'OK2')];
    const checked = await preview(bad);
    expect(checked.body).toMatchObject({ ok: false, counts: { new: 1, invalid: 2 } });
    expect(checked.body.rows.map((r: { errors: string[] }) => r.errors)).toEqual([[], ['DATE_INVALID'], ['AMOUNT_BOTH']]);
    expect(await importFile(bad)).toMatchObject({ status: 422, body: { code: 'BANK_IMPORT_INVALID', data: { rows: [bad[1]?.rowNo, bad[2]?.rowNo] } } });
    expect((await stored()).some((l) => l.bank_ref === 'OK1')).toBe(false);
  });

  it('takes only bank accounts the org uses, and only importers import', async () => {
    const one = [row('28/09/2026', '1', '')];
    for (const code of ['331', '1111', '1121.ACB', '9999']) {
      expect(await preview(one, code), code).toMatchObject({ status: 422, body: { code: 'NOT_A_BANK_ACCOUNT' } });
    }
    expect(await importFile(one, '1121.OLD')).toMatchObject({ status: 422, body: { code: 'ACCOUNT_INACTIVE' } });
    // An inactive account's lines can still be read.
    expect((await lines('2026-09', '1121.OLD')).status).toBe(200);
    expect(await importFile(one, '1121', viewer)).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    expect((await preview(one, '1121', viewer)).status).toBe(403);
    expect((await importFile(one, '1121', owner)).status).toBe(200);
  });

  it('keeps each org to its own lines, and the lines append-only', async () => {
    expect((await lines('2026-09', '1121', outsider)).status).toBe(403);
    const theirs = await rpc('bank/lines', await tokenFor(outsider), { bankAccount: '1121', period: '2026-09' }, otherSlug);
    expect(theirs).toMatchObject({ status: 200, body: { lines: [], moneyIn: '0', moneyOut: '0' } });
    await expect(admin((c) => c.query(`UPDATE crove_finance.bank_line SET amount = 1 WHERE org_id = $1`, [orgId]))).rejects.toMatchObject({ code: '42501' });
    await expect(admin((c) => c.query(`DELETE FROM crove_finance.bank_line WHERE org_id = $1`, [orgId]))).rejects.toMatchObject({ code: '42501' });
    // The database refuses a line on an account that is not a bank account, whoever writes it.
    await expect(
      admin((c) =>
        c.query(
          `INSERT INTO crove_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount) VALUES ($1, '331', $2, 1, '2026-09-01', 'x', 1)`,
          [orgId, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  // ADR-0039, #2044: a feed's lines are stored as a statement's are.
  const SYSTEM = { type: 'system' as const, component: 'finance.bank_feed' };
  const feedLine = (date: string, amount: string, reference: string, balance: string | null = null, description = 'Giao dịch'): BankFeedLine => ({
    date,
    description,
    amount,
    balance,
    reference,
  });
  const defaultEntity = () =>
    admin(async (c) => (await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId])).rows[0]?.id as string);
  const ingest = async (lines: BankFeedLine[], bankAccount = '1121.VCB') =>
    worker.execute<BankImportResult>('finance.bank.ingest', { bankAccount, legalEntityId: await defaultEntity(), source: 'sandbox', lines }, { actor: SYSTEM, orgId });

  it("stores a feed's lines once, whether they come again from the feed or in a statement file", async () => {
    const first = await ingest([
      feedLine('2026-11-03', '-22000', 'FT9002', '977978000', 'Phí chuyển tiền'),
      feedLine('2026-11-02', '1000000', 'FT9001', '978000000', 'Khách trả tiền'),
    ]);
    expect(first.counts).toEqual({ new: 2, duplicate: 0, ambiguous: 0, conflict: 0, invalid: 0 });
    // The next pull overlaps the first and adds one line.
    const next = await ingest([feedLine('2026-11-03', '-22000', 'FT9002', '977978000'), feedLine('2026-11-04', '5000000', 'FT9003', '982978000')]);
    expect(next.counts).toEqual({ new: 1, duplicate: 1, ambiguous: 0, conflict: 0, invalid: 0 });
    expect(next.breaks).toEqual([]);
    // The month's statement file has the same transactions: nothing new.
    const statement = await importFile(
      [row('02/11/2026', '1.000.000', '', '978.000.000', 'FT9001'), row('03/11/2026', '', '22.000', '977.978.000', 'FT9002')],
      '1121.VCB',
    );
    expect(statement.body?.counts).toMatchObject({ new: 0, duplicate: 2 });
    const kept = (await stored('1121.VCB')).filter((l) => l.value_date >= '2026-11-01');
    expect(kept.map((l) => [l.value_date, l.amount, l.dedupe_key])).toEqual([
      ['2026-11-02', '1000000.0000', 'ref:FT9001'],
      ['2026-11-03', '-22000.0000', 'ref:FT9002'],
      ['2026-11-04', '5000000.0000', 'ref:FT9003'],
    ]);
    // The import and the pulls are audited with their source.
    const audits = await admin(
      async (c) =>
        (await c.query<{ detail: { source: string; new: number } }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.bank.ingest' AND outcome = 'ok' ORDER BY occurred_at`, [orgId]))
          .rows,
    );
    expect(audits.map((a) => [a.detail.source, a.detail.new])).toEqual([
      ['sandbox', 2],
      ['sandbox', 1],
    ]);
  });

  it('takes feed lines only with a reference, so overlapping pulls never store one twice', async () => {
    const legalEntityId = await defaultEntity();
    const lines = [{ date: '2026-11-10', description: 'Phí', amount: '-11000', balance: null, reference: null }];
    await expect(worker.execute('finance.bank.ingest', { bankAccount: '1121.VCB', legalEntityId, source: 'sandbox', lines }, { actor: SYSTEM, orgId })).rejects.toBeTruthy();
    const fee = [feedLine('2026-11-10', '-11000', 'FT9010')];
    expect((await ingest(fee)).counts).toMatchObject({ new: 1 });
    expect((await ingest(fee)).counts).toEqual({ new: 0, duplicate: 1, ambiguous: 0, conflict: 0, invalid: 0 });
  });

  it('refuses a batch with an amount of zero or more than 2 decimals, or a day no statement has, storing none of it', async () => {
    const before = (await stored('1121.VCB')).length;
    await expect(
      ingest([feedLine('2026-11-12', '10000', 'FT9100'), feedLine('2026-11-12', '0', 'FT9101'), feedLine('2026-11-12', '1.005', 'FT9102'), feedLine('9999-12-31', '1', 'FT9103')]),
    ).rejects.toMatchObject({
      code: 'BANK_FEED_INVALID',
      status: 422,
      details: { rows: [2, 3, 4] },
    });
    expect((await stored('1121.VCB')).length).toBe(before);
  });

  it('takes feed lines only from the system, and only for an active bank account of the org', async () => {
    const lines = [feedLine('2026-11-15', '10000', 'FT9200')];
    const legalEntityId = await defaultEntity();
    // On the API's runtime, where an owner's context opens: the command itself refuses anyone but the system.
    await expect(api.execute('finance.bank.ingest', { bankAccount: '1121.VCB', legalEntityId, source: 'sandbox', lines }, { actor: { type: 'user', userId: owner.userId, aal: 'aal2', sessionId: owner.session, mfaAt: null }, orgId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'Không có quyền thực hiện',
    });
    await expect(ingest(lines, '1121.OLD')).rejects.toMatchObject({ code: 'ACCOUNT_INACTIVE' });
    await expect(ingest(lines, '331')).rejects.toMatchObject({ code: 'NOT_A_BANK_ACCOUNT' });
    await expect(ingest(lines, '1121.ACB')).rejects.toMatchObject({ code: 'NOT_A_BANK_ACCOUNT' });
  });

  // ADR-0039, #2044 part 2a: a bank feed connection's accounts mapped to the org's bank accounts.
  const feed = async (path: string, who: Account, input?: unknown) => rpc(`bankFeeds/${path}`, await tokenFor(who), input, slug, feedApp);
  // Part 2b: the worker's sync of a connection, with the sandbox adapter and the vault the API sealed with.
  // A fixed day, so the sandbox's days do not move under a test that crosses midnight.
  const SYNC_NOW = () => new Date('2026-11-20T08:00:00Z');
  const sync = (connectionId: string, org = orgId) =>
    runBankFeedSync({ runtime: worker, broker: vault, providers: bankFeedProviders({ sandbox: true, now: SYNC_NOW }) }, { orgId: org, connectionId });

  it('offers the sandbox bank feed only where the deployment turns it on', async () => {
    expect(((await (await feedApp.request('/api/config')).json()) as { bankFeeds: unknown }).bankFeeds).toEqual({ sandbox: true });
    expect(((await (await app.request('/api/config')).json()) as { bankFeeds: unknown }).bankFeeds).toEqual({ sandbox: false });
    expect(await rpc('bankFeeds/connectSandbox', await tokenFor(owner), { displayName: 'Ngân hàng thử' })).toMatchObject({ status: 404, body: { code: 'BANK_FEED_DISABLED' } });
  });

  it('connects the sandbox, maps an account to a bank account, and keeps the connection out of the Social channels', async () => {
    expect((await feed('connectSandbox', member, { displayName: 'Ngân hàng thử' })).status).toBe(403);
    const connected = await feed('connectSandbox', owner, { displayName: 'Ngân hàng thử' });
    expect(connected.status).toBe(200);
    const connectionId = String(connected.body.connectionId);
    // The API sealed the login and listed nothing: the worker's sync opens it and records the accounts it reaches.
    expect((await feed('listed', owner, { connectionId })).body).toEqual([]);
    // The connection shows in the owners' list at once, with nothing mapped yet (#2099); a member or viewer has no list
    // of connections, and another org's owner sees none of this org's.
    expect((await feed('connections', owner)).body).toContainEqual(expect.objectContaining({ id: connectionId, provider: 'bank_sandbox', displayName: 'Ngân hàng thử', status: 'active' }));
    expect((await feed('connections', member)).status).toBe(403);
    expect((await feed('connections', viewer)).status).toBe(403);
    expect((await rpc('bankFeeds/connections', await tokenFor(outsider), {}, otherSlug, feedApp)).body.map((c: { id: string }) => c.id)).not.toContain(connectionId);
    expect(await sync(connectionId)).toMatchObject({ accounts: 2, pages: 0 });
    expect((await feed('listed', owner, { connectionId })).body.map((a: { externalAccountId: string }) => a.externalAccountId)).toEqual(['SBX-001', 'SBX-002']);
    expect((await feed('listed', viewer, { connectionId })).status).toBe(403);
    // Sealed like any channel's: a credential row holds it, and no audit row or answer carries a sandbox secret.
    const stored = await admin(async (c) => (await c.query<{ provider: string }>('SELECT provider FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, connectionId])).rows);
    expect(stored).toEqual([{ provider: 'bank_sandbox' }]);
    expect(Number((await admin(async (c) => (await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.credential WHERE org_id = $1', [orgId])).rows[0]?.n)))).toBeGreaterThan(0);
    expect(JSON.stringify(connected.body)).not.toMatch(/sbx_/);
    expect(
      await admin(async (c) => (await c.query(`SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND detail::text LIKE '%sbx\\_%'`, [orgId])).rows),
    ).toEqual([]);
    expect((await rpc('channels/list', await tokenFor(owner), {}, slug, feedApp)).body.map((c: { id: string }) => c.id)).not.toContain(connectionId);

    const map = (who: Account, input: Record<string, unknown>) => feed('map', who, { connectionId, externalAccountId: 'SBX-001', bankAccount: '1121.VCB', idempotencyKey: randomUUID(), ...input });
    expect((await map(member, {})).status).toBe(403);
    expect((await map(viewer, {})).status).toBe(403);
    expect(await map(owner, { bankAccount: '331' })).toMatchObject({ status: 422, body: { code: 'NOT_A_BANK_ACCOUNT' } });
    expect(await map(owner, { externalAccountId: 'SBX-999' })).toMatchObject({ status: 422, body: { code: 'BANK_FEED_ACCOUNT_UNKNOWN' } });
    expect(await map(owner, { bankAccount: '1121.OLD' })).toMatchObject({ status: 422, body: { code: 'ACCOUNT_INACTIVE' } });
    const mapped = await map(owner, {});
    expect(mapped.status).toBe(200);
    // Mapping it again points it at another bank account of the same entity; another entity takes an unmap first.
    const again = await map(owner, { bankAccount: '1121' });
    expect(again.body.feedAccountId).toBe(mapped.body.feedAccountId);
    const branch = await admin(
      async (c) =>
        (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh ngân hàng', 'branch', $2) RETURNING id`, [orgId, owner.userId])).rows[0]
          ?.id as string,
    );
    expect(await map(owner, { bankAccount: '1121', legalEntityId: branch })).toMatchObject({ status: 409, body: { code: 'BANK_FEED_ACCOUNT_MAPPED' } });
    const listed = await feed('accounts', viewer);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject([
      { id: mapped.body.feedAccountId, connectionId, provider: 'bank_sandbox', connectionName: 'Ngân hàng thử', connectionStatus: 'active', externalAccountId: 'SBX-001', bankAccount: '1121', lastSyncedAt: null },
    ]);
    // Another org sees none of it, and cannot map this connection.
    expect((await rpc('bankFeeds/accounts', await tokenFor(outsider), {}, otherSlug, feedApp)).body).toEqual([]);
    expect(
      await rpc('bankFeeds/map', await tokenFor(outsider), { connectionId, externalAccountId: 'SBX-001', bankAccount: '1121', idempotencyKey: randomUUID() }, otherSlug, feedApp),
    ).toMatchObject({ status: 404, body: { code: 'BANK_FEED_NOT_FOUND' } });

    // Unmapped, it is gone from the list; a second unmap finds nothing.
    expect((await feed('unmap', member, { feedAccountId: mapped.body.feedAccountId, idempotencyKey: randomUUID() })).status).toBe(403);
    expect((await feed('unmap', owner, { feedAccountId: mapped.body.feedAccountId, idempotencyKey: randomUUID() })).status).toBe(200);
    expect((await feed('accounts', owner)).body).toEqual([]);
    expect(await feed('unmap', owner, { feedAccountId: mapped.body.feedAccountId, idempotencyKey: randomUUID() })).toMatchObject({ status: 404, body: { code: 'BANK_FEED_ACCOUNT_NOT_FOUND' } });
  });

  it('maps only a bank feed connection, and only an active one', async () => {
    const social = await admin(
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.channel_connection (org_id, provider, external_account_id, display_name, connected_by) VALUES ($1, 'sandbox', $2, 'Trang', $3) RETURNING id`,
            [orgId, randomUUID(), owner.userId],
          )
        ).rows[0]?.id as string,
    );
    expect(await feed('map', owner, { connectionId: social, externalAccountId: 'SBX-001', bankAccount: '1121', idempotencyKey: randomUUID() })).toMatchObject({
      status: 404,
      body: { code: 'BANK_FEED_NOT_FOUND' },
    });
    const connectionId = String((await feed('connectSandbox', owner, { displayName: 'Ngân hàng cũ' })).body.connectionId);
    await admin((c) => c.query(`UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2`, [orgId, connectionId]));
    expect(await feed('map', owner, { connectionId, externalAccountId: 'SBX-001', bankAccount: '1121', idempotencyKey: randomUUID() })).toMatchObject({
      status: 422,
      body: { code: 'BANK_FEED_INACTIVE' },
    });
  });

  // Part 2b: the sync stores a mapped account's lines once, however often it runs, and moves the cursor with them.
  it("pulls a mapped account's lines into its bank account once, and moves its cursor", async () => {
    const connectionId = String((await feed('connectSandbox', owner, { displayName: 'Ngân hàng đồng bộ' })).body.connectionId);
    await sync(connectionId);
    const mapped = await feed('map', owner, { connectionId, externalAccountId: 'SBX-002', bankAccount: '1121', idempotencyKey: randomUUID() });
    expect(mapped.status).toBe(200);
    const before = (await stored('1121')).length;
    const first = await sync(connectionId);
    expect(first.pages).toBe(1);
    expect(first.stored).toBeGreaterThan(0);
    const lines = await stored('1121');
    expect(lines.length - before).toBe(first.stored);
    expect(lines.filter((l) => l.dedupe_key?.startsWith('ref:SBX-002-')).length).toBe(first.stored);
    const account = (await feed('accounts', owner)).body.find((a: { id: string }) => a.id === mapped.body.feedAccountId);
    expect(account.lastSyncedAt).not.toBeNull();
    // Again: the cursor is at yesterday, so nothing new; and a pull from the start again stores nothing twice.
    expect((await sync(connectionId)).stored).toBe(0);
    await admin((c) => c.query('UPDATE crove_finance.bank_feed_account SET cursor = NULL WHERE org_id = $1 AND id = $2', [orgId, mapped.body.feedAccountId]));
    expect((await sync(connectionId)).stored).toBe(0);
    expect((await stored('1121')).length).toBe(lines.length);
    // The pull takes the mapping's account and entity, never the job's: a page for an unknown mapping is refused.
    await expect(
      worker.execute('finance.bank_feed.record_pull', { feedAccountId: randomUUID(), fromCursor: null, lines: [], cursor: '2026-11-01' }, { actor: SYSTEM, orgId }),
    ).rejects.toMatchObject({ code: 'BANK_FEED_ACCOUNT_NOT_FOUND' });
    // A late sync's page, pulled from a cursor the account has moved past, never moves it back.
    const at = (await admin(async (c) => (await c.query<{ cursor: string }>('SELECT cursor FROM crove_finance.bank_feed_account WHERE org_id = $1 AND id = $2', [orgId, mapped.body.feedAccountId])).rows[0]?.cursor)) as string;
    await expect(
      worker.execute('finance.bank_feed.record_pull', { feedAccountId: mapped.body.feedAccountId, fromCursor: '2026-01-01', lines: [], cursor: '2026-01-31' }, { actor: SYSTEM, orgId }),
    ).rejects.toMatchObject({ code: 'BANK_FEED_CURSOR_MOVED' });
    expect((await admin(async (c) => (await c.query<{ cursor: string }>('SELECT cursor FROM crove_finance.bank_feed_account WHERE org_id = $1 AND id = $2', [orgId, mapped.body.feedAccountId])).rows[0]?.cursor))).toBe(at);
  });

  it('stops syncing once the member who connected the feed may no longer use it', async () => {
    const connectionId = String((await feed('connectSandbox', owner, { displayName: 'Ngân hàng của chủ cũ' })).body.connectionId);
    await sync(connectionId);
    // The connector is no longer an owner or admin: the channel layer no longer opens the credential for the worker,
    // and the sync marks the connection expired, so the daily sweep leaves it until it is connected again.
    await admin((c) => c.query(`UPDATE crove_kernel.channel_connection SET connected_by = $3 WHERE org_id = $1 AND id = $2`, [orgId, connectionId, viewer.userId]));
    expect(await sync(connectionId)).toEqual({ accounts: 0, pages: 0, stored: 0 });
    expect(await admin(async (c) => (await c.query<{ status: string }>('SELECT status FROM crove_kernel.channel_connection WHERE org_id = $1 AND id = $2', [orgId, connectionId])).rows[0]?.status)).toBe('expired');
    expect(await sync(connectionId)).toEqual({ accounts: 0, pages: 0, stored: 0 });
  });

  it("pages the daily sweep's bank feeds by key, active ones of active orgs only, for the worker login alone", async () => {
    const workerAdmin = async <T>(fn: (c: pg.Client) => Promise<T>) => {
      const url = new URL(adminUrl);
      url.username = 'crove_worker';
      url.password = 'test-worker-pw';
      const c = new pg.Client({ connectionString: url.toString() });
      await c.connect();
      try {
        return await fn(c);
      } finally {
        await c.end();
      }
    };
    const connection = async (org: string, provider: string, status = 'active') =>
      admin(
        async (c) =>
          (
            await c.query<{ id: string }>(
              `INSERT INTO crove_kernel.channel_connection (org_id, provider, external_account_id, display_name, connected_by, status) VALUES ($1, $2, $3, 'Sweep', $4, $5) RETURNING id`,
              [org, provider, `sweep-${randomUUID()}`, owner.userId, status],
            )
          ).rows[0]?.id as string,
      );
    const otherOrg = await admin(async (c) => (await c.query<{ org_id: string }>('SELECT org_id FROM crove_kernel.tenant WHERE slug = $1', [otherSlug])).rows[0]?.org_id as string);
    const live = [await connection(orgId, 'bank_sandbox'), await connection(orgId, 'bank_sandbox')];
    await connection(orgId, 'bank_sandbox', 'revoked');
    await connection(orgId, 'bank_sandbox', 'expired');
    await connection(orgId, 'sandbox');
    await connection(otherOrg, 'bank_sandbox');
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET status = 'closed' WHERE org_id = $1`, [otherOrg]));
    // A page of one at a time, by key, reaches every live bank feed of this org and nothing else.
    const seen: string[] = [];
    let after: [string | null, string | null] = [null, null];
    for (let i = 0; i < 50; i++) {
      const rows = await workerAdmin(async (c) => (await c.query<{ org_id: string; connection_id: string }>('SELECT org_id, connection_id FROM crove_finance.bank_feeds_due($1::uuid, $2::uuid, 1)', after)).rows);
      const row = rows[0];
      if (!row) break;
      expect(row.org_id).toBe(orgId);
      seen.push(row.connection_id);
      after = [row.org_id, row.connection_id];
    }
    for (const id of live) expect(seen).toContain(id);
    expect(new Set(seen).size).toBe(seen.length);
    const callers = await admin(
      async (c) =>
        (
          await c.query<{ role: string }>(
            `SELECT r.rolname AS role FROM pg_catalog.pg_roles r
             WHERE r.rolname = ANY (ARRAY['crove_tenant', 'crove_app', 'crove_worker', 'crove_definer_tenant', 'crove_prober'])
               AND pg_catalog.has_function_privilege(r.oid, 'crove_finance.bank_feeds_due(uuid, uuid, integer)', 'EXECUTE')`,
          )
        ).rows,
    );
    expect(callers.map((r) => r.role)).toEqual(['crove_worker']);
  });

  // ADR-0039, #2044 part 2b-ii: a provider's signed notice only asks for a pull.
  const notice = (accounts: string[], over: { secret?: string; timestamp?: number; body?: string } = {}, on: ReturnType<typeof createHttpApp> = feedApp, provider = 'bank_sandbox') => {
    const body = over.body ?? JSON.stringify({ accounts });
    const timestamp = over.timestamp ?? Date.now();
    return on.request(`/api/bank-feed/${provider}/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-timestamp': String(timestamp), 'x-signature': signSandboxWebhook(over.secret ?? WEBHOOK_SECRET, timestamp, body) },
      body,
    });
  };
  const waiting = () => admin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_finance.bank_feed_notice_pending')).rows[0]?.n));
  const claim = async () => {
    const url = new URL(adminUrl);
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      return (await c.query<{ org_id: string | null; connection_id: string | null; provider: string | null }>('SELECT * FROM crove_finance.bank_feed_notice_claim(100)')).rows;
    } finally {
      await c.end();
    }
  };

  it("refuses a notice whose signature, timestamp or shape is wrong, and stores nothing of it", async () => {
    await admin((c) => c.query('DELETE FROM crove_finance.bank_feed_notice_pending'));
    const refused = async (response: Promise<Response> | Response) => ({ status: (await response).status });
    expect(await refused(notice(['SBX-001'], { secret: 'another-secret-0123456789-abcdefghijklmn' }))).toEqual({ status: 401 });
    expect(await refused(notice(['SBX-001'], { timestamp: Date.now() - 11 * 60_000 }))).toEqual({ status: 401 });
    expect(await refused(notice(['SBX-001'], { timestamp: Date.now() + 11 * 60_000 }))).toEqual({ status: 401 });
    // Signed, but not a notice: refused as malformed, never read as accounts.
    expect(await refused(notice([], { body: 'not json' }))).toEqual({ status: 400 });
    expect(await refused(notice([], { body: '{"accounts":[]}' }))).toEqual({ status: 400 });
    // No headers at all.
    expect((await feedApp.request('/api/bank-feed/bank_sandbox/webhook', { method: 'POST', body: '{"accounts":["SBX-001"]}' })).status).toBe(401);
    // An adapter this deployment does not have, and a deployment without notices.
    expect((await notice(['SBX-001'], {}, feedApp, 'bank_nothing')).status).toBe(404);
    expect((await notice(['SBX-001'], {}, feedApp, 'constructor')).status).toBe(404);
    // A deployment whose adapters take no notices has no such route: the POST falls to the authenticated API and is refused.
    expect((await notice(['SBX-001'], {}, app)).status).toBe(401);
    expect(await waiting()).toBe(0);
  });

  it('turns a verified notice into one waiting row per account, and the worker into a sync of each connection that lists it', async () => {
    await admin((c) => c.query('DELETE FROM crove_finance.bank_feed_notice_pending'));
    const connectionId = String((await feed('connectSandbox', owner, { displayName: 'Ngân hàng có thông báo' })).body.connectionId);
    await sync(connectionId);
    const first = await notice(['SBX-001', 'SBX-777']);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ queued: 2 });
    // The same notice again is the same waiting rows.
    expect(await (await notice(['SBX-001', 'SBX-777'])).json()).toEqual({ queued: 0 });
    expect(await waiting()).toBe(2);
    // Claimed: a row for each active connection that lists SBX-001 (the org comes from the listing), and a row of nulls
    // for SBX-777, which nothing lists. The claimed rows are gone.
    const claimed = await claim();
    expect(claimed.filter((r) => r.connection_id === connectionId)).toEqual([{ org_id: orgId, connection_id: connectionId, provider: 'bank_sandbox' }]);
    expect(claimed.filter((r) => r.connection_id === null)).toEqual([{ org_id: null, connection_id: null, provider: null }]);
    expect(claimed.every((r) => r.org_id === orgId || r.org_id === null)).toBe(true);
    expect(await waiting()).toBe(0);
    // A revoked connection is not synced for a notice.
    await admin((c) => c.query(`UPDATE crove_kernel.channel_connection SET status = 'revoked' WHERE org_id = $1 AND id = $2`, [orgId, connectionId]));
    await notice(['SBX-001']);
    expect((await claim()).map((r) => r.connection_id)).not.toContain(connectionId);
  });

  it('limits the notices one address may post a minute', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await notice(['SBX-001'], {}, limitedApp)).status);
    expect(statuses.slice(0, 2).every((s) => s === 202)).toBe(true);
    expect(statuses.slice(2)).toEqual([429, 429]);
    await admin((c) => c.query('DELETE FROM crove_finance.bank_feed_notice_pending'));
  });

  it("answers 503 when too many accounts are already waiting, and keeps the queue and its definers to the API and the worker", async () => {
    await admin((c) => c.query(`INSERT INTO crove_finance.bank_feed_notice_pending (provider, external_account_id) SELECT 'bank_sandbox', 'backlog-' || n FROM generate_series(1, 10001) n`));
    expect((await notice(['SBX-001'])).status).toBe(503);
    await admin((c) => c.query('DELETE FROM crove_finance.bank_feed_notice_pending'));
    const privileges = await admin(
      async (c) =>
        (
          await c.query<{ fn: string; role: string }>(
            `SELECT f AS fn, r AS role
             FROM unnest(ARRAY['crove_finance.bank_feed_notice_enqueue(text, text[])', 'crove_finance.bank_feed_notice_claim(integer)']) f
             CROSS JOIN unnest(ARRAY['crove_tenant', 'crove_app', 'crove_worker', 'crove_definer_tenant', 'crove_prober']) r
             WHERE pg_catalog.has_function_privilege(r, f, 'EXECUTE') ORDER BY 1, 2`,
          )
        ).rows,
    );
    expect(privileges).toEqual([
      { fn: 'crove_finance.bank_feed_notice_claim(integer)', role: 'crove_worker' },
      { fn: 'crove_finance.bank_feed_notice_enqueue(text, text[])', role: 'crove_app' },
    ]);
    // The queue table itself is read and written by no login role.
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const apiLogin = new pg.Client({ connectionString: url.toString() });
    await apiLogin.connect();
    try {
      await expect(apiLogin.query('SELECT * FROM crove_finance.bank_feed_notice_pending')).rejects.toMatchObject({ code: '42501' });
      await expect(apiLogin.query(`SELECT crove_finance.bank_feed_notice_enqueue('sandbox', ARRAY['x'])`)).rejects.toMatchObject({ code: '22P02' });
    } finally {
      await apiLogin.end();
    }
  });

  // #2079: a mapping that row security hides from the caller (here a test policy; in the books, another entity's rows)
  // answers like a visible one in another entity, not a generic conflict.
  it('answers BANK_FEED_ACCOUNT_MAPPED for an account whose mapping the caller cannot see', async () => {
    const connectionId = String((await feed('connectSandbox', owner, { displayName: 'Ngân hàng ẩn' })).body.connectionId);
    await sync(connectionId);
    const entity = await defaultEntity();
    const at = (account: string) => ({ connectionId, externalAccountId: account, bankAccount: '1121', legalEntityId: entity, idempotencyKey: randomUUID() });
    const mapped = await feed('map', owner, at('SBX-001'));
    expect(mapped.status).toBe(200);
    // Owners and admins always hold the whole-org scope today, so no entity-limited admin exists to hide a mapping: a
    // restrictive SELECT policy stands in for the other entity's row security. It hides that one row by its id: the row an
    // insert proposes must pass a SELECT policy too (RETURNING), so a policy on `external_account_id` would refuse the
    // insert itself.
    await admin((c) => c.query(`CREATE POLICY crove_test_hidden_2079 ON crove_finance.bank_feed_account AS RESTRICTIVE FOR SELECT TO crove_tenant USING (id <> '${mapped.body.feedAccountId}'::uuid)`));
    try {
      const refused = await feed('map', owner, at('SBX-001'));
      expect(refused).toMatchObject({ status: 409, body: { code: 'BANK_FEED_ACCOUNT_MAPPED' } });
      // The answer names no entity.
      expect(JSON.stringify(refused.body)).not.toContain(entity);
      // Another account of the connection maps as usual.
      expect((await feed('map', owner, at('SBX-002'))).status).toBe(200);
    } finally {
      await admin((c) => c.query('DROP POLICY IF EXISTS crove_test_hidden_2079 ON crove_finance.bank_feed_account'));
    }
    // Both mappings stay, and the hidden one was left as it was.
    const accounts = (await feed('accounts', owner)).body.filter((a: { connectionId: string }) => a.connectionId === connectionId);
    expect(accounts).toHaveLength(2);
    expect(accounts.find((a: { externalAccountId: string }) => a.externalAccountId === 'SBX-001').id).toBe(mapped.body.feedAccountId);
  });

  // #2142: a statement that arrives as a file (forwarded by email, whose sender no one can vouch for, or dropped in the
  // Inbox) is STAGED, never stored: the account its own number names comes from the bank feed mappings, the lines wait
  // with the file's read, and no line and no dedupe key exists until a member imports it. A skipped statement leaves every
  // key free for the real lines.
  describe('a statement read from a forwarded or dropped file (#2142)', () => {
    const NUMBER = '19880001234';
    const WORKER = { type: 'system' as const, component: 'finance.bank_statement' };
    // Uploading a file asks for no second factor: a session at aal1, as the API uploads for the member (an aal2 actor with no
    // mfaAt is refused as invalid when the context is entered).
    // Read when it is used: the accounts' user ids are filled in by beforeAll, after this block is collected.
    const ownerActor = () => ({ type: 'user' as const, userId: owner.userId, aal: 'aal1' as const, sessionId: owner.session });
    let mappingId = '';
    let connectionId = '';
    const stage = (rows: BankStatementRow[], accountNumber: string | null = NUMBER) =>
      worker.query<StatementStageOutcome>('finance.bank.statement_stage', { fileId: randomUUID(), filename: 'sao-ke.xlsx', accountNumber, rows }, { actor: WORKER, orgId });
    const rowsOf = (tag: string) => [
      row('01/09/2026', '2000000', '', '12000000', `FT-${tag}-1`),
      row('02/09/2026', '', '11000', '11989000', `FT-${tag}-2`),
      row('03/09/2026', '', '850000', '11139000', `FT-${tag}-3`),
    ];
    const lineCount = async () => Number((await admin(async (c) => (await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_finance.bank_line WHERE org_id = $1', [orgId])).rows[0]?.n)));
    const status = async (fileId: string) =>
      ((await rpc('files/recent', await tokenFor(owner), {})).body as Array<{ id: string; status: string; error: string | null; statement: { decidedBy?: { name: string | null; at: string } | null } | null; canReextract: boolean }>).find((f) => f.id === fileId);
    // A file stored as a ZIP, as an emailed .xlsx is, and its read recorded the way the worker records it.
    async function ingestZip(): Promise<string> {
      const bytes = new TextEncoder().encode(`PK-sao-ke-${randomUUID()}`);
      const sha256 = sha256Hex(bytes);
      const { fileId } = await api.execute<{ fileId: string }>(
        'kernel.file.ingest',
        { filename: 'sao-ke.zip', contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey: fileKey(orgId, sha256), generation: contentGeneration(sha256), source: 'upload' },
        { actor: ownerActor(), orgId },
      );
      return fileId;
    }
    const recordRead = (fileId: string, fields: Record<string, unknown>) =>
      worker.execute('kernel.extraction.record', { fileId, method: 'unsupported', checks: [], proposal: null, result: null, error: null, ...fields }, { actor: WORKER, orgId });
    async function stagedFile(rows: BankStatementRow[]): Promise<string> {
      const outcome = await stage(rows);
      if (outcome.outcome !== 'staged') throw new Error(`not staged: ${outcome.outcome}`);
      const fileId = await ingestZip();
      await recordRead(fileId, { status: 'done', statement: true, result: { kind: 'bank_statement', summary: outcome.summary, rows }, summary: 'Sao kê chờ nhập' });
      return fileId;
    }
    const confirm = async (fileId: string, who: Account = member, org = slug) => rpc('bank/statementConfirm', await tokenFor(who), { fileId, idempotencyKey: randomUUID() }, org);
    const reject = async (fileId: string, who: Account = member, org = slug) => rpc('bank/statementReject', await tokenFor(who), { fileId, idempotencyKey: randomUUID() }, org);

    it('stages the statement of the mapped account with its summary, and stores no line', async () => {
      connectionId = String((await feed('connectSandbox', owner, { displayName: 'Ngân hàng sao kê tệp' })).body.connectionId);
      // The account is listed with the spaces a bank prints; the file's number is its digits.
      await admin((c) =>
        c.query('INSERT INTO crove_finance.bank_feed_listed_account (org_id, channel_connection_id, external_account_id, display_name) VALUES ($1, $2, $3, $4)', [orgId, connectionId, '1988 0001 234', 'TK thử']),
      );
      const mapped = await feed('map', owner, { connectionId, externalAccountId: '1988 0001 234', bankAccount: '1121.VCB', idempotencyKey: randomUUID() });
      expect(mapped.status).toBe(200);
      mappingId = String(mapped.body.feedAccountId);
      const before = await stored('1121.VCB');
      const outcome = await stage(rowsOf('STAGE'));
      expect(outcome).toMatchObject({
        outcome: 'staged',
        summary: { state: 'staged', bankAccount: '1121.VCB', accountNumber: NUMBER, lines: 3, newLines: 3, duplicateLines: 0, from: '2026-09-01', to: '2026-09-03', totalIn: '2000000', totalOut: '861000' },
      });
      // Nothing is stored and no dedupe key is taken: a staged statement is only a question.
      expect(await stored('1121.VCB')).toEqual(before);
      // The file names no account number, or one no one mapped: nothing to stage.
      expect(await stage(rowsOf('NONE'), null)).toEqual({ outcome: 'unmapped', accountNumber: null });
      expect(await stage(rowsOf('NONE'), '009900000999')).toEqual({ outcome: 'unmapped', accountNumber: '009900000999' });
      // A row whose date is no day refuses the whole file, with its row number.
      expect(await stage([row('05/09/2026', '1000', '', '', 'FT-BAD-1'), row('not a date', '1000', '', '', 'FT-BAD-2')])).toMatchObject({ outcome: 'refused', code: 'BANK_IMPORT_INVALID', rows: [expect.any(Number)] });
      expect(await stored('1121.VCB')).toEqual(before);
    });

    it('writes no line before a member imports a statement, and stores its lines once after', async () => {
      const rows = rowsOf('APPROVE');
      const fileId = await stagedFile(rows);
      const before = await lineCount();
      // Read, but not imported: the Inbox shows it waiting with what a member needs to decide.
      expect(await status(fileId)).toMatchObject({
        status: 'staged',
        statement: { state: 'staged', bankAccount: '1121.VCB', lines: 3, newLines: 3, duplicateLines: 0, from: '2026-09-01', to: '2026-09-03', totalIn: '2000000', totalOut: '861000' },
      });
      expect(await lineCount()).toBe(before);
      // A viewer, and another org, cannot decide it.
      expect((await confirm(fileId, viewer)).status).toBe(403);
      // Another org's member never reaches it: not a member here, or the file is not visible there.
      const theirs = await confirm(fileId, outsider, otherSlug);
      expect([403, 409]).toContain(theirs.status);
      expect(['NOT_A_MEMBER', 'STATEMENT_NOT_STAGED']).toContain(theirs.body.code);
      expect(await lineCount()).toBe(before);
      // A member imports it: its three lines appear, on the mapped account, with the import's own keys.
      const done = await confirm(fileId);
      expect(done.status).toBe(200);
      expect(done.body.counts).toMatchObject({ new: 3, duplicate: 0 });
      expect(await lineCount()).toBe(before + 3);
      // Exactly the staged rows, as staged: nothing is read again from the email, and nothing else is added.
      const approved = (await stored('1121.VCB')).filter((l) => l.dedupe_key?.startsWith('ref:FT-APPROVE-'));
      expect(approved.map((l) => [l.value_date, Number(l.amount), Number(l.running_balance), l.bank_ref])).toEqual([
        ['2026-09-01', 2000000, 12000000, 'FT-APPROVE-1'],
        ['2026-09-02', -11000, 11989000, 'FT-APPROVE-2'],
        ['2026-09-03', -850000, 11139000, 'FT-APPROVE-3'],
      ]);
      // The Inbox says who imported it, from the audit row of the decision.
      const decision = await admin(async (c) => (await c.query<{ actor_id: string }>(`SELECT actor_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.extraction.statement_state' AND target_id = $2 AND outcome = 'ok'`, [orgId, fileId])).rows);
      expect(decision).toEqual([{ actor_id: member.userId }]);
      const imported = await status(fileId);
      expect(imported).toMatchObject({ status: 'imported', statement: { state: 'imported', newLines: 3, duplicateLines: 0 }, canReextract: false });
      expect(imported?.statement?.decidedBy).toMatchObject({ name: expect.stringContaining('member'), at: expect.any(String) });
      // Deciding it again stores nothing more, and the browser import of the same lines finds them there.
      expect(await confirm(fileId)).toMatchObject({ status: 409, body: { code: 'STATEMENT_NOT_STAGED' } });
      expect(await reject(fileId)).toMatchObject({ status: 409, body: { code: 'STATEMENT_NOT_STAGED' } });
      expect(await lineCount()).toBe(before + 3);
      expect((await importFile(rows, '1121.VCB')).body.counts).toMatchObject({ new: 0, duplicate: 3 });
      // A finished run never changes, so the decision is a new run of the file: the newest one, with no rows; the staged run before it keeps its rows like any run keeps its result.
      const runs = await admin(async (c) => (await c.query<{ version: number; has_rows: boolean; requested_by: string | null }>(`SELECT version, result ? 'rows' AS has_rows, requested_by FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2 ORDER BY version`, [orgId, fileId])).rows);
      expect(runs.map((r) => [r.version, r.has_rows])).toEqual([[1, true], [2, false]]);
      // Who decided is the audit row's (checked above), not the run's: a run inserted already finished has no requester.
      expect(runs[1]?.requested_by).toBeNull();
      // An imported statement is read no more, whatever the button says.
      expect(await rpc('files/reextract', await tokenFor(owner), { fileId, idempotencyKey: randomUUID() })).toMatchObject({ status: 409, body: { code: 'STATEMENT_IMPORTED' } });
    });

    it('stores a statement once when two members press import at the same time', async () => {
      const fileId = await stagedFile(rowsOf('RACE'));
      const before = await lineCount();
      const [first, second] = await Promise.all([confirm(fileId, member), confirm(fileId, owner)]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      expect(await lineCount()).toBe(before + 3);
      const decisions = await admin(async (c) => (await c.query(`SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.extraction.statement_state' AND target_id = $2 AND outcome = 'ok'`, [orgId, fileId])).rows);
      expect(decisions).toHaveLength(1);
    });

    it('stores nothing for a statement a member skips, and leaves its dedupe keys free for the real lines', async () => {
      // A forged statement, as anyone who knows the address could send it, with the references the real lines will have.
      const rows = rowsOf('FORGED');
      const fileId = await stagedFile(rows);
      const before = await lineCount();
      expect((await reject(fileId, viewer)).status).toBe(403);
      const skipped = await reject(fileId);
      expect(skipped.status).toBe(200);
      const dismissed = await status(fileId);
      expect(dismissed).toMatchObject({ status: 'dismissed', statement: { state: 'rejected' }, canReextract: true });
      expect(dismissed?.statement?.decidedBy).toMatchObject({ name: expect.stringContaining('member') });
      expect(await lineCount()).toBe(before);
      expect(await confirm(fileId)).toMatchObject({ status: 409, body: { code: 'STATEMENT_NOT_STAGED' } });
      // The real lines (the same references, from the feed or a genuine file) land as new: nothing took their keys.
      expect((await importFile(rows, '1121.VCB')).body.counts).toMatchObject({ new: 3, duplicate: 0 });
      expect(await lineCount()).toBe(before + 3);
      expect(
        (await worker.execute<BankImportResult>('finance.bank.ingest', { bankAccount: '1121.VCB', legalEntityId: await defaultEntity(), source: 'sandbox', lines: [feedLine('2026-09-04', '1000', 'FT-FORGED-4')] }, { actor: SYSTEM, orgId })).counts,
      ).toMatchObject({ new: 1 });
    });

    it('imports to the account the mapping names now, and refuses once the mapping is gone', async () => {
      const fileId = await stagedFile(rowsOf('MAPPING'));
      const before = await lineCount();
      expect((await feed('unmap', owner, { feedAccountId: mappingId, idempotencyKey: randomUUID() })).status).toBe(200);
      expect(await confirm(fileId)).toMatchObject({ status: 409, body: { code: 'STATEMENT_MAPPING_CHANGED' } });
      expect(await lineCount()).toBe(before);
      // The file still waits: the owner can map the account again and import, or skip it.
      expect(await status(fileId)).toMatchObject({ status: 'staged' });
      const remapped = await feed('map', owner, { connectionId, externalAccountId: '1988 0001 234', bankAccount: '1121.VCB', idempotencyKey: randomUUID() });
      expect(remapped.status).toBe(200);
      mappingId = String(remapped.body.feedAccountId);
      expect((await confirm(fileId)).body.counts).toMatchObject({ new: 3 });
      expect(await lineCount()).toBe(before + 3);
    });

    // An .xlsx statement is stored as a ZIP: its read is recorded with the statement flag, and a read that failed because
    // the account was not mapped yet can be asked for again.
    it('records the read of a statement stored as a ZIP, and lets a failed read be asked for again', async () => {
      const fileId = await ingestZip();
      // Without the statement flag a ZIP is still never read as a document; the flag is for a statement run alone.
      await expect(recordRead(fileId, { status: 'failed', error: 'x' })).rejects.toMatchObject({ code: 'ARCHIVE_NOT_READ' });
      await expect(recordRead(fileId, { status: 'failed', error: 'x', statement: true, method: 'archive' })).rejects.toThrow();
      // Unmapped when first read: a failed read with the reason, which may be read again.
      await recordRead(fileId, { status: 'failed', error: 'Số tài khoản chưa được liên kết', statement: true });
      expect(await status(fileId)).toMatchObject({ status: 'failed', error: 'Số tài khoản chưa được liên kết', statement: null, canReextract: true });
      const again = await rpc('files/reextract', await tokenFor(owner), { fileId, idempotencyKey: randomUUID() });
      expect(again.status).toBe(200);
      expect(again.body.version).toBe(2);
      // The re-read lands on that run, and the file waits for a member again.
      const rows = rowsOf('REREAD');
      const outcome = await stage(rows);
      if (outcome.outcome !== 'staged') throw new Error('expected staged');
      await recordRead(fileId, { version: 2, status: 'done', statement: true, result: { kind: 'bank_statement', summary: outcome.summary, rows }, summary: 'Sao kê chờ nhập' });
      expect(await status(fileId)).toMatchObject({ status: 'staged', statement: { state: 'staged', lines: 3 }, canReextract: true });
      // A ZIP that was opened as an archive is still never read again.
      const archive = await ingestZip();
      expect(await rpc('files/reextract', await tokenFor(owner), { fileId: archive, idempotencyKey: randomUUID() })).toMatchObject({ status: 409 });
    });

    it('keeps a bounded amount of rows with a staged statement, and refuses a bigger file with the reason', async () => {
      // 4,300 lines of 1,000 characters are about 4.3 MB of rows: over what a staged statement may keep.
      const big = Array.from({ length: 4300 }, (_, i) => ({ ...row('01/09/2026', '1000', '', '', `FT-BIG-${i}`), description: 'x'.repeat(1000) }));
      expect(await stage(big)).toMatchObject({ outcome: 'refused', code: 'STATEMENT_TOO_LARGE' });
      // Bytes, not characters: 1,500 lines of 1,000 Vietnamese letters of 3 bytes each are 4.5 MB though only 1.5 million characters.
      const accented = Array.from({ length: 1500 }, (_, i) => ({ ...row('01/09/2026', '1000', '', '', `FT-VN-${i}`), description: 'ế'.repeat(1000) }));
      expect(await stage(accented)).toMatchObject({ outcome: 'refused', code: 'STATEMENT_TOO_LARGE' });
      // The kernel holds the same bound on what a staged run records.
      const fileId = await ingestZip();
      await expect(recordRead(fileId, { status: 'done', statement: true, result: { kind: 'bank_statement', summary: {}, rows: big } })).rejects.toMatchObject({ code: 'STATEMENT_TOO_LARGE' });
      // A statement of a month, however long its lines, fits.
      expect(await stage(Array.from({ length: 300 }, (_, i) => ({ ...row('01/09/2026', '1000', '', '', `FT-MID-${i}`), description: 'x'.repeat(1000) })))).toMatchObject({ outcome: 'staged' });
    });

    it('lists the statements that wait however many files came since, and records a re-read in the entity its account is mapped to', async () => {
      const staged = await stagedFile(rowsOf('LIST'));
      const waiting = async () => ((await rpc('files/staged', await tokenFor(viewer), {})).body as Array<{ id: string; status: string }>).map((f) => f.id);
      expect(await waiting()).toContain(staged);
      // Not the ones a member decided.
      expect((await reject(staged)).status).toBe(200);
      expect(await waiting()).not.toContain(staged);
      // An account mapped to another legal entity than the one the first (failed) read belongs to.
      const branch = await admin(
        async (c) =>
          (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh sao kê', 'branch', $2) RETURNING id`, [orgId, owner.userId])).rows[0]?.id as string,
      );
      await admin((c) =>
        c.query('INSERT INTO crove_finance.bank_feed_listed_account (org_id, channel_connection_id, external_account_id, display_name) VALUES ($1, $2, $3, $4)', [orgId, connectionId, '5566 7788 9900', 'TK chi nhánh']),
      );
      expect((await feed('map', owner, { connectionId, externalAccountId: '5566 7788 9900', bankAccount: '1121', legalEntityId: branch, idempotencyKey: randomUUID() })).status).toBe(200);
      const fileId = await ingestZip();
      await recordRead(fileId, { status: 'failed', error: 'Số tài khoản chưa được liên kết', statement: true });
      expect((await rpc('files/reextract', await tokenFor(owner), { fileId, idempotencyKey: randomUUID() })).status).toBe(200);
      const rows = rowsOf('MOVED');
      const outcome = await stage(rows, '556677889900');
      if (outcome.outcome !== 'staged') throw new Error(`expected staged: ${JSON.stringify(outcome)}`);
      expect(outcome.summary.legalEntityId).toBe(branch);
      await recordRead(fileId, { version: 2, status: 'done', statement: true, legalEntityId: branch, result: { kind: 'bank_statement', summary: outcome.summary, rows }, summary: 'Sao kê chờ nhập' });
      // The run the account's entity sees is a new one; the pending run of the first entity is closed with nothing of the statement.
      const runs = await admin(async (c) => (await c.query<{ version: number; status: string; legal_entity_id: string; has_result: boolean }>(`SELECT version, status, legal_entity_id, result IS NOT NULL AS has_result FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2 ORDER BY version`, [orgId, fileId])).rows);
      expect(runs.map((r) => [r.version, r.status, r.legal_entity_id === branch, r.has_result])).toEqual([[1, 'failed', false, false], [2, 'failed', false, false], [3, 'done', true, true]]);
      expect(await waiting()).toContain(fileId);
    });

    // #2191: the approver decides blind, and a forged statement may reuse a real reference with another amount.
    const feedOne = async (line: BankFeedLine) =>
      worker.execute<BankImportResult>('finance.bank.ingest', { bankAccount: '1121.VCB', legalEntityId: await defaultEntity(), source: 'sandbox', lines: [line] }, { actor: SYSTEM, orgId });

    it('flags a staged line whose reference the books already hold with another amount, shows it before Import, and stores it flagged instead of dropping it', async () => {
      // The real transaction arrives first, from the feed.
      await feedOne(feedLine('2026-09-01', '2000000', 'FT-REAL-1', '12000000', 'Khách trả tiền'));
      // A forged statement reuses that reference with a larger amount, next to a line that is genuinely new.
      const forged = [row('01/09/2026', '9000000', '', '19000000', 'FT-REAL-1', 'Chuyển khoản lạ'), row('04/09/2026', '1000', '', '19001000', 'FT-REAL-NEW')];
      const outcome = await stage(forged);
      expect(outcome).toMatchObject({ outcome: 'staged', summary: { lines: 2, newLines: 2, duplicateLines: 0, conflictLines: 1 } });
      const fileId = await stagedFile(forged);
      const before = await stored('1121.VCB');
      // The card's data: how the file came, the entity and the masked number, never the number itself.
      const shown = await status(fileId);
      expect(shown).toMatchObject({
        status: 'staged',
        statement: { conflictLines: 1, accountMask: '*******1234', origin: { channel: 'upload', by: expect.any(String) }, entity: { id: await defaultEntity(), name: expect.any(String) } },
      });
      expect(JSON.stringify(shown)).not.toContain(NUMBER);
      // The lines, conflicts first, with the line they clash with.
      const listed = await rpc('bank/statementLines', await tokenFor(member), { fileId });
      expect(listed.status).toBe(200);
      expect(listed.body).toMatchObject({ total: 2, conflicts: 1 });
      expect((listed.body.lines as Array<{ reference: string; status: string; clash: unknown }>).map((l) => [l.reference, l.status, l.clash])).toEqual([
        ['FT-REAL-1', 'conflict', { date: '2026-09-01', amount: '2000000' }],
        ['FT-REAL-NEW', 'new', null],
      ]);
      // A viewer decides nothing and sees no lines; nothing was stored by looking.
      expect((await rpc('bank/statementLines', await tokenFor(viewer), { fileId })).status).toBe(403);
      expect(await stored('1121.VCB')).toEqual(before);
      // Importing stores both: the conflict keyless and flagged "needs a look", never merged into the real line.
      const done = await confirm(fileId);
      expect(done.status).toBe(200);
      expect(done.body.counts).toMatchObject({ new: 1, conflict: 1, duplicate: 0 });
      const kept = (await stored('1121.VCB')).filter((l) => l.bank_ref?.startsWith('FT-REAL'));
      expect(kept.map((l) => [l.bank_ref, Number(l.amount), l.dedupe_key, l.ambiguous])).toEqual([
        ['FT-REAL-1', 2000000, 'ref:FT-REAL-1', false],
        ['FT-REAL-1', 9000000, null, true],
        ['FT-REAL-NEW', 1000, 'ref:FT-REAL-NEW', false],
      ]);
      // Once decided, the lines are no longer offered.
      expect(await rpc('bank/statementLines', await tokenFor(member), { fileId })).toMatchObject({ status: 409, body: { code: 'STATEMENT_NOT_STAGED' } });
      // Importing the same forged lines again finds them all there: a retry stores nothing more.
      expect((await importFile(forged, '1121.VCB')).body.counts).toMatchObject({ new: 0, conflict: 0, duplicate: 2 });
      expect((await stored('1121.VCB')).filter((l) => l.bank_ref?.startsWith('FT-REAL'))).toHaveLength(3);
    });

    it('keeps the real line of a feed that arrives after a forged statement was imported, flagged, never dropped as a duplicate', async () => {
      // The member imported a forged line first: FT-LATE-1 as 9,000,000.
      const fileId = await stagedFile([row('02/09/2026', '9000000', '', '', 'FT-LATE-1', 'Chuyển khoản lạ')]);
      expect((await confirm(fileId)).status).toBe(200);
      // The real feed line, the same reference with the amount the bank has, arrives.
      const real = feedLine('2026-09-02', '3000000', 'FT-LATE-1', null, 'Khách trả tiền thật');
      const first = await feedOne(real);
      expect(first.counts).toEqual({ new: 0, duplicate: 0, ambiguous: 0, conflict: 1, invalid: 0 });
      const kept = (await stored('1121.VCB')).filter((l) => l.bank_ref === 'FT-LATE-1');
      expect(kept.map((l) => [Number(l.amount), l.dedupe_key, l.ambiguous])).toEqual([
        [9000000, 'ref:FT-LATE-1', false],
        [3000000, null, true],
      ]);
      // The owners and admins are told there is a line to look at, as for any flagged line.
      const told = await admin(async (c) => (await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.bank.ingest' AND outcome = 'ok' AND (detail->>'conflict')::int > 0`, [orgId])).rows[0]?.n);
      expect(Number(told)).toBeGreaterThan(0);
      // The same pull again stores nothing more.
      expect((await feedOne(real)).counts).toEqual({ new: 0, duplicate: 1, ambiguous: 0, conflict: 0, invalid: 0 });
      expect((await stored('1121.VCB')).filter((l) => l.bank_ref === 'FT-LATE-1')).toHaveLength(2);
    });

    it('refuses to import a statement the books made conflict with after its card was shown, and counts conflicts in the imported summary', async () => {
      // Staged while the books hold nothing under FT-SHIFT-1: the card shows no conflict.
      const fileId = await stagedFile([row('05/09/2026', '9000000', '', '', 'FT-SHIFT-1', 'Chuyển khoản lạ')]);
      expect(await status(fileId)).toMatchObject({ statement: { conflictLines: 0 } });
      // The real line arrives from the feed meanwhile, with another amount.
      await feedOne(feedLine('2026-09-05', '3000000', 'FT-SHIFT-1', null, 'Khách trả tiền thật'));
      const before = await lineCount();
      // Importing is refused, nothing is stored, and the lines show the conflict as the books have it now.
      expect(await confirm(fileId)).toMatchObject({ status: 409, body: { code: 'STATEMENT_CONFLICTS_CHANGED' } });
      expect(await lineCount()).toBe(before);
      expect(await status(fileId)).toMatchObject({ status: 'staged' });
      expect(await rpc('bank/statementLines', await tokenFor(member), { fileId })).toMatchObject({ status: 200, body: { conflicts: 1 } });
      // Read again, the file is staged afresh with the conflict counted, and a member who has seen it may import.
      const rows = [row('05/09/2026', '9000000', '', '', 'FT-SHIFT-1', 'Chuyển khoản lạ')];
      const again = await stagedFile(rows);
      expect(await status(again)).toMatchObject({ statement: { conflictLines: 1, newLines: 1 } });
      expect((await confirm(again)).body.counts).toMatchObject({ new: 0, conflict: 1 });
      // The imported summary counts the stored conflict line.
      expect(await status(again)).toMatchObject({ status: 'imported', statement: { state: 'imported', newLines: 1 } });
    });

    // #2196: a statement forwarded by email names the mail it came in, so the card can show its sender.
    const receiveStatementMail = async (from: string | null) => {
      const bytes = new TextEncoder().encode(`PK-sao-ke-mail-${randomUUID()}`);
      const sha256 = sha256Hex(bytes);
      const received = await worker.execute<{ duplicate: boolean; fileIds: string[] }>(
        'kernel.inbound.receive',
        {
          messageId: `<${randomUUID()}@ngan-hang.test>`,
          from,
          subject: 'Sao kê tháng 9',
          files: [{ filename: 'sao-ke.xlsx', contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey: fileKey(orgId, sha256), generation: contentGeneration(sha256), source: 'email' }],
        },
        { actor: { type: 'system', component: 'inbound' }, orgId },
      );
      const fileId = received.fileIds[0] as string;
      const rows = rowsOf(`MAIL-${randomUUID().slice(0, 8)}`);
      const outcome = await stage(rows);
      if (outcome.outcome !== 'staged') throw new Error(`not staged: ${outcome.outcome}`);
      await recordRead(fileId, { status: 'done', statement: true, result: { kind: 'bank_statement', summary: outcome.summary, rows }, summary: 'Sao kê chờ nhập' });
      return fileId;
    };
    const originAs = async (who: Account, fileId: string) =>
      ((await rpc('files/recent', await tokenFor(who), {})).body as Array<{ id: string; statement: { origin: { channel: string; by: string | null; from: string | null } } | null }>).find((f) => f.id === fileId)?.statement?.origin;

    it('shows the sender of a statement that came by email to members who read mails, and to nobody else', async () => {
      const fileId = await receiveStatementMail('ketoan@ngan-hang.example');
      // The receive path linked the file to its mail.
      const link = await admin(async (c) => (await c.query<{ from_address: string }>(`SELECT m.from_address FROM crove_kernel.file f JOIN crove_kernel.inbound_message m ON m.org_id = f.org_id AND m.id = f.inbound_message_id WHERE f.id = $1`, [fileId])).rows);
      expect(link).toEqual([{ from_address: 'ketoan@ngan-hang.example' }]);
      expect(await originAs(owner, fileId)).toEqual({ channel: 'email', by: null, from: 'ketoan@ngan-hang.example' });
      expect(await originAs(member, fileId)).toEqual({ channel: 'email', by: null, from: 'ketoan@ngan-hang.example' });
      // A viewer reads no mails, so no sender.
      expect(await originAs(viewer, fileId)).toEqual({ channel: 'email', by: null, from: null });
      // Nor does a member limited to one legal entity (a mail has none).
      const entityId = await defaultEntity();
      await admin((c) => c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, member.userId, entityId, owner.userId]));
      try {
        expect(await originAs(member, fileId)).toEqual({ channel: 'email', by: null, from: null });
      } finally {
        await admin((c) => c.query(`DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2`, [orgId, member.userId]));
      }
      // An address erased with its mail (personal-data erasure) is no longer shown; the card says the sender is unknown.
      await admin((c) => c.query(`UPDATE crove_kernel.inbound_message m SET from_address = NULL FROM crove_kernel.file f WHERE f.id = $1 AND m.org_id = f.org_id AND m.id = f.inbound_message_id`, [fileId]));
      expect(await originAs(member, fileId)).toEqual({ channel: 'email', by: null, from: null });
    });

    it('lets a member name no mail for an upload, and the receive path only for a file that is an email attachment', async () => {
      const bytes = new TextEncoder().encode(`PK-forged-${randomUUID()}`);
      const sha256 = sha256Hex(bytes);
      const mail = await admin(async (c) => (await c.query<{ id: string }>(`SELECT id FROM crove_kernel.inbound_message WHERE org_id = $1 LIMIT 1`, [orgId])).rows[0]?.id as string);
      const file = { filename: 'sao-ke.zip', contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey: fileKey(orgId, sha256), generation: contentGeneration(sha256), inboundMessageId: mail };
      // A member's upload cannot claim a mail of the org as its source.
      await expect(api.execute('kernel.file.ingest', { ...file, source: 'upload' }, { actor: ownerActor(), orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(api.execute('kernel.file.ingest', { ...file, source: 'email' }, { actor: ownerActor(), orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // The receive path takes no link from its caller: the attachment is linked to the message it records, whatever the
      // input names.
      const received = await worker.execute<{ fileIds: string[] }>(
        'kernel.inbound.receive',
        { messageId: `<${randomUUID()}@ngan-hang.test>`, from: 'a@b.example', subject: null, files: [{ ...file, source: 'email', inboundMessageId: mail }] },
        { actor: { type: 'system', component: 'inbound' }, orgId },
      );
      const linked = await admin(async (c) => (await c.query<{ from_address: string }>(`SELECT m.from_address FROM crove_kernel.file f JOIN crove_kernel.inbound_message m ON m.org_id = f.org_id AND m.id = f.inbound_message_id WHERE f.id = $1`, [received.fileIds[0]])).rows);
      expect(linked).toEqual([{ from_address: 'a@b.example' }]);
    });

    it('tells the member a statement came by email, and who uploaded one that did not', async () => {
      // An email attachment is stored by the worker with no uploader (a file never changes, so it is stored so from the start).
      const rows = rowsOf('EMAIL');
      const outcome = await stage(rows);
      if (outcome.outcome !== 'staged') throw new Error(`not staged: ${outcome.outcome}`);
      const bytes = new TextEncoder().encode(`PK-sao-ke-email-${randomUUID()}`);
      const sha256 = sha256Hex(bytes);
      const fileId = await admin(
        async (c) =>
          (
            await c.query<{ id: string }>(
              `INSERT INTO crove_kernel.file (org_id, sha256, storage_key, generation, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, 'sao-ke.zip', 'application/zip', $5, 'email') RETURNING id`,
              [orgId, sha256, fileKey(orgId, sha256), contentGeneration(sha256), bytes.byteLength],
            )
          ).rows[0]?.id as string,
      );
      await recordRead(fileId, { status: 'done', statement: true, result: { kind: 'bank_statement', summary: outcome.summary, rows }, summary: 'Sao kê chờ nhập' });
      expect(await status(fileId)).toMatchObject({ status: 'staged', statement: { origin: { channel: 'email', by: null }, conflictLines: 0 } });
    });

    // #2183: the number of a bank account recorded by an owner or admin, so a statement matches without a bank feed.
    describe('with the number of a bank account recorded instead of a bank feed', () => {
      const NO_FEED = '0123456789';
      const numbers = async (who: Account = owner, org = slug) => rpc('bankAccountNumbers/list', await tokenFor(who), undefined, org);
      const setNumber = async (bankAccount: string, accountNumber: string, who: Account = owner, org = slug) =>
        rpc('bankAccountNumbers/set', await tokenFor(who), { bankAccount, accountNumber, idempotencyKey: randomUUID() }, org);
      const clearNumber = async (id: string, who: Account = owner, org = slug) => rpc('bankAccountNumbers/clear', await tokenFor(who), { id, idempotencyKey: randomUUID() }, org);
      // A second org of the owner's, made once: its numbers are its own.
      let second = '';
      const secondOrg = async () => {
        if (!second) second = String((await rpc('org/create', await tokenFor(owner), { name: 'Công ty thứ hai', idempotencyKey: randomUUID() }, null)).body?.slug);
        return second;
      };
      const stageFor = (accountNumber: string) => stage(rowsOf(`NUM-${randomUUID().slice(0, 8)}`), accountNumber);

      it('stages a statement for a number recorded on bank account 1121, whatever grouping it was typed with, and stores nothing until a member imports it', async () => {
        // Nothing records 0123456789 yet: the statement has no account.
        expect(await stageFor(NO_FEED)).toEqual({ outcome: 'unmapped', accountNumber: NO_FEED });
        const set = await setNumber('1121', '0123 456 789');
        expect(set.status).toBe(200);
        expect(await numbers()).toMatchObject({ status: 200, body: [{ id: set.body.id, bankAccount: '1121', accountNumber: NO_FEED }] });
        // The same statement now goes to 1121, as a pending import: nothing is stored.
        const before = await lineCount();
        const outcome = await stageFor(NO_FEED);
        expect(outcome).toMatchObject({ outcome: 'staged', summary: { bankAccount: '1121', accountNumber: NO_FEED, accountMask: '******6789', lines: 3, newLines: 3 } });
        expect(await lineCount()).toBe(before);
        // A member imports it: the lines land on 1121.
        const rows = rowsOf('NUMBERED');
        const fileId = await (async () => {
          const staged = await stage(rows, NO_FEED);
          if (staged.outcome !== 'staged') throw new Error(`not staged: ${staged.outcome}`);
          const id = await ingestZip();
          await recordRead(id, { status: 'done', statement: true, result: { kind: 'bank_statement', summary: staged.summary, rows }, summary: 'Sao kê chờ nhập' });
          return id;
        })();
        expect((await confirm(fileId)).status).toBe(200);
        expect((await stored('1121')).filter((l) => l.bank_ref?.startsWith('FT-NUMBERED-'))).toHaveLength(3);
      });

      it('keeps a number on one bank account of the org, and says so the same way for a number a bank feed already maps', async () => {
        const first = await setNumber('1121', NO_FEED);
        // The same number on the same account (typed differently) is the same record; on another account it is refused.
        expect((await setNumber('1121', '0123.456.789')).body.id).toBe(first.body.id);
        expect(await setNumber('1121.VCB', NO_FEED)).toMatchObject({ status: 409, body: { code: 'BANK_ACCOUNT_NUMBER_TAKEN' } });
        // The number of a bank feed mapping (19880001234 on 1121.VCB) cannot go on another account either.
        expect(await setNumber('1121', '1988 0001 234')).toMatchObject({ status: 409, body: { code: 'BANK_ACCOUNT_NUMBER_TAKEN' } });
        // A bank account may hold several numbers.
        expect((await setNumber('1121', '9876543210')).status).toBe(200);
        // Another org's number is its own: the same digits there are fine and hold no sway here.
        expect(await setNumber('1121', NO_FEED, owner, await secondOrg())).toMatchObject({ status: 200 });
        expect(await stageFor(NO_FEED)).toMatchObject({ outcome: 'staged', summary: { bankAccount: '1121' } });
      });

      it('refuses what is not a number, a bank account the org does not use, and any role but owner or admin', async () => {
        for (const bad of ['12345', '0123 abc 789', '123456789012345678901']) {
          expect(await setNumber('1121', bad), bad).toMatchObject({ status: 422, body: { code: 'BANK_ACCOUNT_NUMBER_INVALID' } });
        }
        // Nothing at all is refused at the door.
        expect((await setNumber('1121', '')).status).toBe(400);
        expect(await setNumber('5111', '5550001111')).toMatchObject({ status: 422, body: { code: 'NOT_A_BANK_ACCOUNT' } });
        expect(await setNumber('1121.OLD', '5550002222')).toMatchObject({ status: 422, body: { code: 'ACCOUNT_INACTIVE' } });
        for (const who of [member, viewer]) {
          expect((await setNumber('1121', '5550003333', who)).status, who.email).toBe(403);
          expect((await numbers(who)).status, who.email).toBe(403);
        }
      });

      it('refuses to map a bank feed account whose number is recorded on another bank account, and maps it to the same one', async () => {
        expect((await setNumber('1121', '7770001111')).status).toBe(200);
        await admin((c) =>
          c.query('INSERT INTO crove_finance.bank_feed_listed_account (org_id, channel_connection_id, external_account_id, display_name) VALUES ($1, $2, $3, $4)', [orgId, connectionId, '7770001111', 'TK đã ghi số']),
        );
        // The feed account's digits are the recorded number: they may not put it on another bank account.
        expect(await feed('map', owner, { connectionId, externalAccountId: '7770001111', bankAccount: '1121.VCB', idempotencyKey: randomUUID() })).toMatchObject({ status: 409, body: { code: 'BANK_ACCOUNT_NUMBER_TAKEN' } });
        expect((await feed('map', owner, { connectionId, externalAccountId: '7770001111', bankAccount: '1121', idempotencyKey: randomUUID() })).status).toBe(200);
        // Both name the same place: the statement still stages.
        expect(await stageFor('7770001111')).toMatchObject({ outcome: 'staged', summary: { bankAccount: '1121' } });
      });

      it('answers ambiguous for a number a bank feed and a recording put on two different bank accounts, and stages nothing', async () => {
        // The set command refuses this; raw rows (a mapping made after the number, say) are what the statement path guards against.
        await admin((c) => c.query(`INSERT INTO crove_finance.bank_account_number (org_id, legal_entity_id, bank_account, account_number) VALUES ($1, (SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default), '1121', '19880001234')`, [orgId]));
        try {
          expect(await stage(rowsOf('AMBIG'), '19880001234')).toEqual({ outcome: 'ambiguous', accountNumber: '19880001234' });
        } finally {
          await admin((c) => c.query(`DELETE FROM crove_finance.bank_account_number WHERE org_id = $1 AND account_number = '19880001234'`, [orgId]));
        }
        // The same account named by both is one place.
        await admin((c) => c.query(`INSERT INTO crove_finance.bank_account_number (org_id, legal_entity_id, bank_account, account_number) VALUES ($1, (SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default), '1121.VCB', '19880001234')`, [orgId]));
        try {
          expect(await stage(rowsOf('SAME'), '19880001234')).toMatchObject({ outcome: 'staged', summary: { bankAccount: '1121.VCB' } });
        } finally {
          await admin((c) => c.query(`DELETE FROM crove_finance.bank_account_number WHERE org_id = $1 AND account_number = '19880001234'`, [orgId]));
        }
      });

      it('removes a number, audits both changes with the number masked, and leaves a statement for it unmapped again', async () => {
        const set = await setNumber('1121', '5550004444');
        expect(await stageFor('5550004444')).toMatchObject({ outcome: 'staged' });
        // Only the org's managers clear it; another org cannot reach it.
        expect((await clearNumber(String(set.body.id), member)).status).toBe(403);
        expect(await clearNumber(String(set.body.id), owner, await secondOrg())).toMatchObject({ status: 404, body: { code: 'BANK_ACCOUNT_NUMBER_NOT_FOUND' } });
        expect((await clearNumber(String(set.body.id))).status).toBe(200);
        expect(await clearNumber(String(set.body.id))).toMatchObject({ status: 404, body: { code: 'BANK_ACCOUNT_NUMBER_NOT_FOUND' } });
        expect(await stageFor('5550004444')).toEqual({ outcome: 'unmapped', accountNumber: '5550004444' });
        const audits = await admin(
          async (c) =>
            (await c.query<{ command: string; detail: Record<string, unknown> }>(`SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'finance.bank_account_number.%' AND outcome = 'ok' ORDER BY occurred_at`, [orgId])).rows,
        );
        const mine = audits.filter((a) => a.detail['accountMask'] === '******4444');
        expect(mine.map((a) => a.command)).toEqual(['finance.bank_account_number.set', 'finance.bank_account_number.clear']);
        // The whole number is in no audit row.
        expect(JSON.stringify(audits)).not.toContain('5550004444');
      });
    });

    it('is decided by users alone: the worker cannot import or skip a statement', async () => {
      const fileId = await stagedFile(rowsOf('WORKER'));
      await expect(worker.execute('finance.bank.statement_confirm', { fileId }, { actor: WORKER, orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(worker.execute('finance.bank.statement_reject', { fileId }, { actor: WORKER, orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(worker.execute('kernel.extraction.statement_state', { fileId, state: 'imported' }, { actor: WORKER, orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await status(fileId)).toMatchObject({ status: 'staged' });
    });
  });
});

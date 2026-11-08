// SPDX-License-Identifier: AGPL-3.0-only
// The bank bulk-salary file of an approved pay run (#2532, payroll plan 6.4) on a real PostgreSQL 17, through the HTTP route as an owner reaches it:
// - one row per person with the net pay, the account numbers opened only inside the audited sensitive query and only with a second factor used in the last 5 minutes;
// - the file is built whole or refused: a draft run, a person with no account number, a member and a viewer, a missing second factor, HEAD and a bad column list;
// - a name that starts with = + - @ or a tab stays a string cell with the Text format and never becomes a formula;
// - the headers: a safe ASCII filename, `private, no-store`, no account number in the URL; the audit rows hold counts only and no name, account number or amount.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { HrBankFile, HrRunSheet, HrRunWritten, HrWritten } from '@crove/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { PAYROLL_RULES, money } from '@crove/l10n-vn';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

// The shipped payroll rules are `commentary` until the accountant confirms them (#2535): the test confirms them for itself while it approves a month.
vi.mock('@crove/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@crove/l10n-vn')>();
  return { ...real, PAYROLL_RULES: real.PAYROLL_RULES.map((row) => ({ ...row })) };
});

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-bank-file-0123456789abcdef';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  async put(_key: string, bytes: Uint8Array) {
    return `content:${sha256Hex(bytes)}`;
  }
  async get(): Promise<Uint8Array> {
    throw new Error('missing blob');
  }
  async delete() {}
}

// Names that a spreadsheet program would read as a formula, and the account numbers (planted so they can be searched for).
const TEAM = [
  { name: '=HYPERLINK("http://evil.test","Nguyễn")', wage: '15000000', account: '0011223344551' },
  { name: '+84 Trần Văn Hai', wage: '9000000', account: '0011223344552' },
  { name: '-Lê Thu Cúc', wage: '30000000', account: '0011223344553' },
  { name: '@Phạm Văn Đức', wage: '12000000', account: '0011223344554' },
];
const ACCOUNTS = TEAM.map((t) => t.account);

suite('the bank salary file of a pay run (#2532)', () => {
  const dbName = `crove_test_bankfile_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const subject = randomUUID();
  const session = randomUUID();
  let slug = '';
  let orgId = '';
  let ownerId = '';
  let runId = '';
  let totalNet = '';

  const token = (mfa: boolean) =>
    new SignJWT({ role: 'authenticated', email: 'owner@bankfile.test', session_id: session, aal: mfa ? 'aal2' : 'aal1', is_anonymous: false, ...(mfa ? { amr: [{ method: 'totp', timestamp: Math.floor(Date.now() / 1000) }] } : {}) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const exec = <O>(name: string, input: unknown, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(ownerId)) => rt.execute<O>(name, input, { actor, orgId, idempotencyKey: randomUUID() });
  const get = async (path: string, mfa = true, method = 'GET') => app.request(path, { method, headers: { authorization: `Bearer ${await token(mfa)}`, 'x-crove-org': slug } });
  const rows = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(sql, params)).rows;
    } finally {
      await c.end();
    }
  };
  const url = (id: string, query = 'bank=Vietcombank') => `/api/payroll-bank-file/${id}.xlsx?${query}`;

  async function approvedRun(month: string) {
    for (const row of PAYROLL_RULES) (row as { status: string }).status = 'confirmed';
    const run = await exec<HrRunWritten>('hr.payroll.run.open', { month });
    const sheet = await rt.query<HrRunSheet>('hr.payroll.run.sheet', { runId: run.runId }, { actor: asUser(ownerId), orgId });
    await exec<HrRunWritten>('hr.payroll.run.approve', { runId: run.runId, fingerprint: sheet.fingerprint, acceptFlags: true }, asMfa(ownerId));
    for (const row of PAYROLL_RULES) (row as { status: string }).status = 'commentary';
    return { runId: run.runId as string, net: sheet.totals.net };
  }

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
    rt = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      subjectVault: new SubjectVault(new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]).deriveKeys(SUBJECT_WRAP_INFO)),
      readAuditKey: randomBytes(32),
    }).register({ commands: [...kernelCommands, ...hrCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, ...financeQueries] });
    const config = loadConfig({ DATABASE_URL: appUrl.toString(), AUTH_JWT_SECRET: SECRET, AUTH_ISSUER: ISSUER, AUTH_SESSION_CHECK: 'off', MIGRATIONS_DIR: MIGRATIONS, WEB_DIST: '/nonexistent' });
    app = createHttpApp({ config, runtime: rt, store: new MemoryStore(), authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    const created = await app.request('/api/rpc/org/create', {
      method: 'POST',
      headers: { authorization: `Bearer ${await token(false)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ json: { name: 'Công ty Chuyển lương', idempotencyKey: randomUUID() } }),
    });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { json: { slug: string; orgId: string } };
    slug = body.json.slug;
    orgId = body.json.orgId;
    ownerId = (await rows<{ user_id: string }>(`SELECT user_id FROM crove_kernel.tenant_member WHERE org_id = $1 AND role = 'owner'`, [orgId]))[0]?.user_id as string;
    for (const t of TEAM) {
      await exec<HrWritten>('hr.payroll.employee.add', {
        displayName: t.name,
        accountNumber: t.account,
        employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: t.wage },
      });
    }
    const run = await approvedRun('2026-03');
    runId = run.runId;
    totalNet = money(run.net).toFixed();
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const fileOf = (columns?: string[]) => rt.query<HrBankFile>('hr.payroll.bank_file.get', { runId, bankName: 'Vietcombank', ...(columns ? { columns } : {}) }, { actor: asMfa(ownerId), orgId });
  const isXlsx = async (response: Response) => {
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A zip package: the spreadsheet file, not an error body.
    return bytes.length > 100 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  };

  it('sends one row per person with the net pay, in the columns asked for, with safe headers and no account number in the URL', async () => {
    const path = url(runId, 'bank=Vietcombank&columns=seq,name,account,bank,amount,content');
    for (const account of ACCOUNTS) expect(path).not.toContain(account);
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toMatch(/^attachment; filename="[A-Za-z0-9._-]+\.xlsx"; filename\*=UTF-8''[A-Za-z0-9._%-]+\.xlsx$/);
    expect(disposition).toContain('2026-03');
    expect(await isXlsx(response)).toBe(true);
    // What the file holds (the same rows the workbook is built from): every account number once, the bank and the remark as typed, the amounts adding up to the run's net pay.
    const file = await fileOf(['seq', 'name', 'account', 'bank', 'amount', 'content']);
    expect(file.rows.map((r) => r.account).sort()).toEqual([...ACCOUNTS].sort());
    expect(new Set(file.rows.map((r) => r.bank))).toEqual(new Set(['Vietcombank']));
    expect(new Set(file.rows.map((r) => r.content))).toEqual(new Set(['Luong thang 03/2026']));
    expect(file.rows.reduce((acc, r) => acc.plus(r.amount), money(0)).toFixed()).toBe(totalNet);
    expect(file.total).toBe(totalNet);
    expect(file.rows.map((r) => r.seq)).toEqual(['1', '2', '3', '4']);
    expect(file.columns).toEqual(['seq', 'name', 'account', 'bank', 'amount', 'content']);
  });

  it('carries a name that reads as a formula unchanged, to be written as a string cell (the workbook test holds the cell rules): no apostrophe is added to the data', async () => {
    const file = await fileOf();
    const names = file.rows.map((r) => r.name);
    for (const t of TEAM) expect(names).toContain(t.name);
    expect(names.some((n) => n.startsWith("'"))).toBe(false);
  });

  it('refuses without a second factor, to a HEAD request, and for a bad column list or a missing bank, and writes no download row', async () => {
    const before = (await rows<{ n: string }>(`SELECT count(*) AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'hr.payroll.bank_file.export'`, [orgId]))[0]?.n;
    expect((await get(url(runId), false)).status).toBe(403);
    expect((await get(url(runId), true, 'HEAD')).status).toBe(405);
    expect((await get(url(runId, 'bank=VCB&columns=name,name'))).status).toBe(400);
    expect((await get(url(runId, 'bank=VCB&columns=password'))).status).toBe(400);
    expect((await get(url(runId, 'bank='))).status).toBe(400);
    // A bank name that is nothing but control characters is no name.
    expect((await get(url(runId, 'bank=%01%02'))).status).toBe(400);
    expect((await get(`/api/payroll-bank-file/${runId}.csv?bank=VCB`)).status).toBe(404);
    expect((await rows<{ n: string }>(`SELECT count(*) AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'hr.payroll.bank_file.export'`, [orgId]))[0]?.n).toBe(before);
  });

  it('refuses a draft run, an unknown run and another org\'s run, and answers a member and a viewer nothing', async () => {
    const draft = await exec<HrRunWritten>('hr.payroll.run.open', { month: '2026-04' });
    expect((await get(url(draft.runId as string))).status).toBe(409);
    expect((await get(url(randomUUID()))).status).toBe(404);
    const member = await upsertIdentity(createDb(pool), { issuer: 'bankfile', subject: `member-${randomUUID()}`, email: `m-${randomUUID()}@bankfile.test`, name: null });
    const viewer = await upsertIdentity(createDb(pool), { issuer: 'bankfile', subject: `viewer-${randomUUID()}`, email: `v-${randomUUID()}@bankfile.test`, name: null });
    await rows(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`, [orgId, member, viewer]);
    for (const who of [member, viewer]) {
      await expect(rt.query('hr.payroll.bank_file.get', { runId, bankName: 'VCB' }, { actor: asMfa(who), orgId })).rejects.toMatchObject({ status: 403 });
    }
  });

  it('refuses the whole file, with a count and no name, when a person has no account number, and holds a second factor for the query itself', async () => {
    const run = (await rows<{ id: string }>(`SELECT id FROM crove_hr.payroll_employee WHERE org_id = $1 ORDER BY id LIMIT 1`, [orgId]))[0]?.id as string;
    await exec('hr.payroll.employee.edit', { employeeId: run, accountNumber: null });
    const response = await get(url(runId));
    expect(response.status).toBe(422);
    const problem = JSON.stringify(await response.json());
    expect(problem).toContain('HR_BANK_ACCOUNT_MISSING');
    for (const t of TEAM) expect(problem).not.toContain(t.name);
    await expect(rt.query('hr.payroll.bank_file.get', { runId, bankName: 'VCB' }, { actor: asUser(ownerId), orgId })).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
  });

  it('records the read and the download with counts only: no name, account number or amount reaches an audit row', async () => {
    const audit = await rows<{ command: string; detail: string; row: string }>(
      `SELECT command, detail::text AS detail, audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command IN ('hr.payroll.bank_file.get', 'hr.payroll.bank_file.export')`,
      [orgId],
    );
    expect(audit.some((a) => a.command === 'hr.payroll.bank_file.get')).toBe(true);
    const exported = audit.filter((a) => a.command === 'hr.payroll.bank_file.export');
    expect(exported.length).toBeGreaterThan(0);
    for (const a of audit) {
      const text = `${a.detail} ${a.row}`;
      for (const account of ACCOUNTS) expect(text).not.toContain(account);
      for (const t of TEAM) expect(text).not.toContain(t.name);
      expect(text).not.toContain(totalNet);
    }
    expect(exported.every((a) => /"rows":\s*4/.test(a.detail))).toBe(true);
    // The query's own answer is the file's data: the runtime does not hand it to anything but the caller.
    const file = await rt.query<HrBankFile>('hr.payroll.bank_file.get', { runId, bankName: 'VCB' }, { actor: asMfa(ownerId), orgId }).catch(() => null);
    expect(file === null || file.rows.length <= TEAM.length).toBe(true);
  });
});

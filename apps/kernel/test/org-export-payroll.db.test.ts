// SPDX-License-Identifier: AGPL-3.0-only
// The owner's org export carries the payroll people (#2676, follow-up of #2530) on a real PostgreSQL 17:
// - the owner-run path (kernel.org.export.people, GET /api/org-export/hr.payroll_*) lists the payroll tables, with no plain identity or account number and no sealed text;
// - every read is audited before it reads, with no value in the row;
// - a member, an admin of the org (owners only), an admin of another org, an agent-less system actor and the worker read none of it, and the export job's snapshot still cannot be asked for these tables.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { OWNER_RUN_EXPORT_TABLE_NAMES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { HrWritten } from '@crove/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const IDENTITY = '079 123 456 789';
const IDENTITY_DIGITS = '079123456789';
const ACCOUNT = '1903 4455 6677 88';
const ACCOUNT_DIGITS = '19034455667788';
const NAME = 'Nguyễn Thị Hằng Canary';
const DEPENDENT = 'Nguyễn Văn Con Canary';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
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

suite('org export carries the payroll people through the owner-run path (#2676)', () => {
  const dbName = `crove_test_export_hr_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const system = { type: 'system' as const, component: 'org-export' };

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  // `closing`: the org is moved to offboarding (R3, a fresh second factor), as the export is taken when an owner closes it.
  async function org(closing = false) {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hr', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Xuất nhân sự ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, admin, member]));
    const added = await rt.execute<HrWritten>(
      'hr.payroll.employee.add',
      {
        displayName: NAME,
        address: '12 Đường Canary, Quận 1',
        identityNumber: IDENTITY,
        accountNumber: ACCOUNT,
        employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
      },
      { actor: asUser(owner), orgId },
    );
    await rt.execute('hr.payroll.dependent.add', { employeeId: added.employeeId, displayName: DEPENDENT, relation: 'child', registeredOn: '2026-02-01' }, { actor: asUser(owner), orgId });
    // One pay month: a run with one line, from the stored terms.
    await rt.execute('hr.payroll.run.open', { month: '2026-06' }, { actor: asUser(owner), orgId });
    if (closing) await rt.execute('kernel.org.offboard', { confirmSlug: slug }, { actor: asMfa(owner), orgId });
    return { orgId, slug, owner, admin, member };
  }

  const read = async (runtime: Runtime, table: string, actor: Parameters<Runtime['stream']>[2]['actor'], orgId: string) => {
    const lines: string[] = [];
    await runtime.stream('kernel.org.export.people', { table }, { actor, orgId }, async (raw) => {
      lines.push(...(raw as { lines: string[] }).lines);
    });
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  beforeAll(async () => {
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const u = new URL(adminUrl);
      u.username = username;
      u.password = password;
      return u.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 4 });
    const register = (target: pg.Pool) =>
      new Runtime(createDb(target), {
        manifests: TEST_MANIFESTS,
        subjectVault: new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO)),
        readAuditKey: randomBytes(32),
      }).register({ commands: [...kernelCommands, ...hrCommands], queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries] });
    rt = register(pool);
    workerRt = register(workerPool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('streams the payroll tables to the owner with no plain number and no sealed text, and audits each read before it', async () => {
    const o = await org(true);
    expect(OWNER_RUN_EXPORT_TABLE_NAMES).toEqual(['hr.payroll_employee', 'hr.payroll_employment', 'hr.payroll_dependent', 'hr.payroll_run', 'hr.payroll_line', 'hr.payroll_bank_template']);
    const employees = await read(rt, 'hr.payroll_employee', asUser(o.owner), o.orgId);
    const employments = await read(rt, 'hr.payroll_employment', asUser(o.owner), o.orgId);
    const dependents = await read(rt, 'hr.payroll_dependent', asUser(o.owner), o.orgId);
    const runs = await read(rt, 'hr.payroll_run', asUser(o.owner), o.orgId);
    const lines = await read(rt, 'hr.payroll_line', asUser(o.owner), o.orgId);
    // No bank template was saved in this org: the table is served, and empty.
    const templates = await read(rt, 'hr.payroll_bank_template', asUser(o.owner), o.orgId);
    expect([employees.length, employments.length, dependents.length, runs.length, lines.length, templates.length]).toEqual([1, 1, 1, 1, 1, 0]);
    expect(runs[0]).toMatchObject({ month: '2026-06', status: 'draft' });
    expect(lines[0]).toMatchObject({ kind: 'pay', employee_id: employees[0]?.id });
    expect(employees[0]).toMatchObject({ display_name: NAME });
    expect(employees[0]).not.toHaveProperty('national_id_sealed');
    expect(employees[0]).not.toHaveProperty('bank_account_sealed');
    expect(employments[0]).toMatchObject({ contract_type: 'indefinite' });
    expect(dependents[0]).toMatchObject({ display_name: DEPENDENT });
    const text = JSON.stringify([employees, employments, dependents, runs, lines]);
    for (const needle of [IDENTITY, IDENTITY_DIGITS, ACCOUNT, ACCOUNT_DIGITS, 'crove:s1:']) expect(text, needle).not.toContain(needle);
    const audits = await withAdmin(
      async (c) => (await c.query<{ outcome: string; detail: string; row: string }>(`SELECT outcome, detail::text AS detail, audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.export.people' ORDER BY id`, [o.orgId])).rows,
    );
    expect(audits.map((a) => a.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    // Each row names the table read (not personal data) and says the read was started.
    expect(audits.map((a) => (JSON.parse(a.detail) as { table: string }).table)).toEqual([...OWNER_RUN_EXPORT_TABLE_NAMES]);
    expect(JSON.parse(audits[0]?.detail ?? '{}')).toMatchObject({ read: 'sensitive', stage: 'before_read' });
    for (const a of audits) for (const needle of [IDENTITY_DIGITS, ACCOUNT_DIGITS, NAME, DEPENDENT]) expect(a.row, needle).not.toContain(needle);
  });

  it('refuses a member, an admin, an admin of another org, the system and the worker; the snapshot cannot be asked for the tables', async () => {
    const o = await org();
    const other = await org();
    for (const who of [o.member, o.admin, other.owner]) {
      for (const table of OWNER_RUN_EXPORT_TABLE_NAMES) await expect(read(rt, table, asUser(who), o.orgId), `${who} ${table}`).rejects.toMatchObject({ status: 403 });
    }
    for (const table of OWNER_RUN_EXPORT_TABLE_NAMES) {
      await expect(read(rt, table, system, o.orgId), 'system (app)').rejects.toMatchObject({ status: 403 });
      await expect(read(workerRt, table, system, o.orgId), 'system (worker)').rejects.toMatchObject({ status: 403 });
      await expect(workerRt.stream('kernel.org.export.snapshot', { table }, { actor: system, orgId: o.orgId }, async () => {}), 'snapshot').rejects.toMatchObject({ code: 'VALIDATION' });
    }
    // An agent is refused too, and the owner of an org that is not closing reads nothing: the download is part of closing the org.
    await expect(read(rt, 'hr.payroll_line', { type: 'agent', agentId: randomUUID(), runId: randomUUID() }, o.orgId), 'agent').rejects.toMatchObject({ status: 403 });
    await expect(read(rt, 'hr.payroll_line', asUser(o.owner), o.orgId), 'active org').rejects.toMatchObject({ code: 'ORG_NOT_OFFBOARDING' });
    // The export job's snapshot reads no payroll row: no hr table is among the tables it streams.
    const tables = new Set<string>();
    await workerRt.stream('kernel.org.export.snapshot', {}, { actor: system, orgId: o.orgId }, async (raw) => {
      tables.add((raw as { table: string }).table);
    });
    expect([...tables].filter((t) => t.startsWith('hr.'))).toEqual([]);
    // Refused reads leave no audit row of a read: only the owner's attempt on the active org, which passed access and was refused after its row, has one.
    const rows = await withAdmin(async (c) => (await c.query(`SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.export.people'`, [o.orgId])).rowCount);
    expect(rows).toBe(1);
  });

  it('serves the tables on the owner download route and nobody else', async () => {
    const o = await org();
    const closing = await org(true);
    const other = await org(true);
    const users = new Map<string, AuthUser>(
      [o.owner, o.admin, o.member, other.owner, closing.owner].map((id) => [id, { userId: id, email: '', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null }]),
    );
    const app = createHttpApp({
      config: loadConfig({
        DATABASE_URL: appUrl,
        AUTH_JWT_SECRET: 'test-only-jwt-secret-for-export-0123456789',
        AUTH_ISSUER: 'test-auth',
        WEB_DIST: '/nonexistent',
        EXPORT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }),
      runtime: rt,
      store: new MemoryStore(),
      authenticate: async (header) => users.get(String(header).replace('Bearer ', ''))!,
      pool,
      aiEnabled: false,
    });
    const get = (table: string, userId: string, slug: string) => app.request(`/api/org-export/${table}`, { headers: { authorization: `Bearer ${userId}`, 'x-crove-org': slug } });
    // The org is not closing: the owner is refused with a clear code, a member and an admin and another org's owner are refused too.
    const active = await get('hr.payroll_employee', o.owner, o.slug);
    expect(active.status).toBe(409);
    expect(await active.json()).toMatchObject({ code: 'ORG_NOT_OFFBOARDING' });
    for (const who of [o.admin, o.member]) expect((await get('hr.payroll_employee', who, o.slug)).status).toBe(403);
    expect((await get('hr.payroll_employee', other.owner, o.slug)).status).toBe(403);
    // The org is closing: works with no finished export (the people are read live), as streamed NDJSON with the download headers.
    for (const table of OWNER_RUN_EXPORT_TABLE_NAMES) {
      const ok = await get(table, closing.owner, closing.slug);
      expect(ok.status, table).toBe(200);
      expect(ok.headers.get('content-type')).toContain('application/x-ndjson');
      expect(ok.headers.get('cache-control')).toBe('private, no-store');
      expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
      expect(ok.headers.get('content-disposition')).toContain('attachment');
      const text = await ok.text();
      const all = text.trim().split('\n').map((l) => JSON.parse(l) as { org_id: string; _end?: boolean; rows?: number });
      // The last line says how many rows came before it, so a cut download cannot look whole.
      const expected = table === 'hr.payroll_bank_template' ? 0 : 1;
      expect(all.at(-1), table).toEqual({ _end: true, rows: expected });
      const rows = all.slice(0, -1);
      expect(rows.length, table).toBe(expected);
      if (expected > 0) expect(rows[0]?.org_id).toBe(closing.orgId);
      for (const needle of [IDENTITY_DIGITS, ACCOUNT_DIGITS, 'crove:s1:']) expect(text).not.toContain(needle);
    }
    // Another org's owner reads their own people, never this org's.
    const own = JSON.parse((await (await get('hr.payroll_dependent', other.owner, other.slug)).text()).trim().split('\n')[0] as string) as { org_id: string };
    expect(own.org_id).toBe(other.orgId);
    expect((await get('hr.payroll_employee', other.owner, closing.slug)).status).toBe(403);
    // A key of Object.prototype is not an owner-run table: it takes the stored-export path and finds no export.
    expect((await get('constructor', closing.owner, closing.slug)).status).toBe(404);
  });
});

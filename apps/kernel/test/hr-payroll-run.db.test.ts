// SPDX-License-Identifier: AGPL-3.0-only
// The HR module's monthly pay run (#2531, payroll plan 6.2 and 6.3, ADR-0046) on a real PostgreSQL 17, through the runtime:
// - opening a month computes every person's line from the stored terms and the dated rules, to the figures of the calculator (#2529), and copies what recurs from last month;
// - approving is R3 (a fresh second factor), refuses while a rule a line used is `commentary` (listing the rows with their sources), a refused line, a changed sheet and an unaccepted flag;
// - an approved run and its lines never change: the commands refuse and so does the database, whoever writes;
// - a correction is an adjustment line in a later run; a payslip is a view of the stored line;
// - owners and admins only, in the commands and in the database; no audit row carries a name or an amount;
// - the owner's org export carries the payroll tables through the owner-run path (#2676), with no plain number, an audit row naming each table, the refusals, and the download route.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { OWNER_RUN_EXPORT_TABLE_NAMES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { HrDeclarationDocument, HrPayslip, HrRunSheet, HrRunSummary, HrRunWritten, HrWritten } from '@crove/kernel-contract';
import { CredentialVault, DomainError, Runtime, SUBJECT_WRAP_INFO, SubjectVault, defineCommand, defineQuery, parseVaultKey, sha256Hex, type BlobStore, type CommandDef, type QueryDef } from '@crove/kernel-runtime';
import { calculatePayroll, PAYROLL_RULES } from '@crove/l10n-vn';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import type { AuthUser } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { TEST_MANIFESTS } from './manifests.ts';

// A blob store in memory, for the HTTP app of the org export tests.
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

// Every rule of the shipped set is `commentary` until the accountant confirms it (#2535), so a real approval cannot pass yet. The tests that approve confirm the rows for the test: the
// array module code reads is the one mutated here, in place; a test that needs the gate puts the status back.
vi.mock('@crove/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@crove/l10n-vn')>();
  return { ...real, PAYROLL_RULES: real.PAYROLL_RULES.map((row) => ({ ...row })) };
});
const setRuleStatus = (status: 'confirmed' | 'commentary') => {
  for (const row of PAYROLL_RULES) (row as { status: string }).status = status;
};

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const MONTH = '2026-11';
const PREVIOUS = '2026-10';
const NAMES = ['Nguyễn Thị Hằng Canary', 'Trần Văn Hai Canary', 'Lê Thu Cúc Canary'];
const WAGES = ['15000000', '9000000', '30000000'];

suite('HR monthly pay run on PostgreSQL (#2531)', () => {
  const dbName = `crove_test_hrrun_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let appUrl = '';
  let rt: Runtime;
  let workerRt: Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  // What a member would see in the two tables, and a write a member attempts, so the database's policies and guard are what answer (the module's access lists would refuse first).
  const PEEK = defineQuery({
    name: 't2531.peek',
    input: z.object({}),
    access: ['owner', 'admin', 'member', 'viewer'],
    handler: async (ctx) => {
      const runs = await ctx.trx.selectFrom('crove_hr.payroll_run').select('id').where('org_id', '=', ctx.orgId).execute();
      const lines = await ctx.trx.selectFrom('crove_hr.payroll_line').select('id').where('org_id', '=', ctx.orgId).execute();
      return { runs: runs.length, lines: lines.length };
    },
  }) as QueryDef<unknown, unknown>;
  // A change of a line by a statement that skips the commands, by whoever the caller is: the guard of the database answers.
  const TOUCH_LINE = defineCommand({
    name: 't2531.touch_line',
    input: z.object({ lineId: z.string() }),
    risk: 'R1',
    sideEffect: 'internal',
    access: ['owner', 'admin', 'member', 'viewer'],
    writes: [],
    handler: async (ctx, input) => {
      await ctx.trx.updateTable('crove_hr.payroll_line').set({ updated_at: ctx.now }).where('org_id', '=', ctx.orgId).where('id', '=', input.lineId).execute();
      return {};
    },
  }) as CommandDef<unknown, unknown>;

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function org() {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hrrun', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId, slug } = await createOrg(rt, asUser(owner), `Lương ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, admin, member, viewer]));
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    const hire = (extra: Record<string, unknown> = {}, wage = WAGES[0], name = NAMES[0]) =>
      exec<HrWritten>(owner, 'hr.payroll.employee.add', { displayName: name, employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: wage }, ...extra });
    const team = async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i += 1) ids.push((await hire({}, WAGES[i], NAMES[i])).employeeId as string);
      return ids;
    };
    const open = (month = MONTH, extra: Record<string, unknown> = {}) => exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month, ...extra });
    const sheet = (runId: string, who = owner) => query<HrRunSheet>(who, 'hr.payroll.run.sheet', { runId });
    const approve = (runId: string, fingerprint: string, extra: Record<string, unknown> = {}) => exec<HrRunWritten>(owner, 'hr.payroll.run.approve', { runId, fingerprint, ...extra }, asMfa(owner));
    const audits = (command: string) => withAdmin(async (c) => (await c.query<{ outcome: string; detail: unknown }>('SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY id', [orgId, command])).rows);
    return { orgId, slug, owner, admin, member, viewer, exec, query, hire, team, open, sheet, approve, audits };
  }

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
    const login = new URL(url.toString());
    login.username = 'crove_worker';
    login.password = 'test-worker-pw';
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    workerPool = createPool({ connectionString: login.toString(), max: 2 });
    const register = (target: pg.Pool) =>
      new Runtime(createDb(target), {
        manifests: TEST_MANIFESTS,
        subjectVault: new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO)),
        readAuditKey: randomBytes(32),
      }).register({ commands: [...kernelCommands, ...hrCommands, TOUCH_LINE], queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, PEEK] });
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

  it('opens a month of three employees with the figures of the calculator, and the sheet shows each breakdown and the totals', async () => {
    setRuleStatus('commentary');
    const o = await org();
    await o.team();
    const written = await o.open();
    expect(written.lines).toBe(3);
    const s = await o.sheet(written.runId);
    expect(s.run).toMatchObject({ month: MONTH, status: 'draft', workingDays: '26.0' });
    expect(s.lines).toHaveLength(3);
    for (const line of s.lines) {
      const wage = WAGES[NAMES.indexOf(line.employeeName)] as string;
      const expected = calculatePayroll(
        { region: 'I', contract: 'indefinite', contractTermMonths: null, resident: true, insured: true, baseWage: wage, allowances: [] },
        { month: MONTH, standardWorkingDays: '26' },
        PAYROLL_RULES,
      );
      expect(line.status).toBe('calculated');
      // Stored as numeric(20,2): the same amounts, with the two decimals the column keeps.
      const stored = Object.fromEntries(Object.entries(line.figures ?? {}).map(([k, v]) => [k, Number(v)]));
      expect(stored).toMatchObject({
        gross: Number(wage),
        employeeInsurance: Number(expected.employeeInsurance),
        employerInsurance: Number(expected.employerInsurance),
        unionFee: Number(expected.unionFee),
        pit: Number(expected.pit),
        net: Number(expected.net),
        employerCost: Number(expected.employerCost),
      });
      expect(line.breakdown).toMatchObject({ pay: { baseWage: wage }, insurance: { funds: expect.any(Array) }, tax: { mode: 'progressive' } });
    }
    // The totals are the lines' sums, in decimals.
    const sum = (key: 'gross' | 'net' | 'pit') => s.lines.reduce((acc, l) => acc + Number(l.figures?.[key]), 0);
    expect(Number(s.totals.gross)).toBe(sum('gross'));
    expect(Number(s.totals.net)).toBe(sum('net'));
    expect(Number(s.totals.gross)).toBe(54_000_000);
    // A second run of the same month is refused; the list shows the run with its totals.
    await expect(o.open()).rejects.toMatchObject({ code: 'HR_RUN_EXISTS' });
    const list = await o.query<HrRunSummary[]>(o.admin, 'hr.payroll.run.list', {});
    expect(list).toEqual([expect.objectContaining({ id: written.runId, month: MONTH, lines: 3, refused: 0, status: 'draft' })]);
  });

  it('copies what recurs from last month and starts the rest empty, and recalculates when the inputs, the working days or the terms change', async () => {
    setRuleStatus('commentary');
    const o = await org();
    const [first] = await o.team();
    const previous = await o.open(PREVIOUS);
    const before = await o.sheet(previous.runId);
    const line = before.lines.find((l) => l.employeeId === first) as HrRunSheet['lines'][number];
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: line.id,
      inputs: {
        allowances: [{ label: 'Ăn trưa', amount: '1000000', type: 'meal_cash', namedInContract: false }],
        bonus: '2000000',
        overtime: [{ dayKind: 'normal_day', night: false, hours: '10' }],
        unpaidLeaveDays: '2',
      },
    });
    const edited = (await o.sheet(previous.runId)).lines.find((l) => l.id === line.id) as HrRunSheet['lines'][number];
    expect(Number(edited.figures?.gross)).toBeGreaterThan(15_000_000);
    expect(edited.breakdown).toMatchObject({ pay: { overtime: [expect.objectContaining({ hours: '10' })] } });
    const next = await o.open(MONTH);
    const copied = (await o.sheet(next.runId)).lines.find((l) => l.employeeId === first) as HrRunSheet['lines'][number];
    expect(copied.inputs).toMatchObject({ allowances: [expect.objectContaining({ label: 'Ăn trưa' })], bonus: '0', unpaidLeaveDays: '0', overtime: [] });
    // Other working days change the proration; a raise since the month was opened enters a recalculation.
    const unpaid = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.line.inputs.set', { lineId: copied.id, inputs: { ...copied.inputs, unpaidLeaveDays: '1' } });
    expect(unpaid.runId).toBe(next.runId);
    const days = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.recalculate', { runId: next.runId, workingDays: '22' });
    expect(days.lines).toBe(3);
    await o.exec(o.owner, 'hr.payroll.employment.add', { employeeId: first, effectiveFrom: '2026-11-01', contractType: 'indefinite', region: 'I', baseWage: '20000000' });
    await o.exec(o.owner, 'hr.payroll.run.recalculate', { runId: next.runId });
    const raised = (await o.sheet(next.runId)).lines.find((l) => l.employeeId === first) as HrRunSheet['lines'][number];
    expect((await o.sheet(next.runId)).run.workingDays).toBe('22.0');
    expect(raised.breakdown).toMatchObject({ pay: { baseWage: expect.stringMatching(/^19\d{6}/) } });
  });

  it('flags a new hire, a person leaving, a failed check and a net pay under the minimum wage, and refuses a month the calculator cannot compute', async () => {
    setRuleStatus('commentary');
    const o = await org();
    const ids = await o.team();
    const hired = await o.hire({ displayName: 'Phạm Mới Canary', employment: { effectiveFrom: '2026-11-10', contractType: 'indefinite', region: 'I', baseWage: '4000000' } });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: ids[1], endedOn: '2026-11-20' });
    const term = await o.hire({ displayName: 'Vũ Hợp Đồng Canary', employment: { effectiveFrom: '2026-01-01', contractType: 'fixed_term', region: 'I', baseWage: '8000000' } });
    const run = await o.open();
    const s = await o.sheet(run.runId);
    const of = (id: string) => s.lines.find((l) => l.employeeId === id) as HrRunSheet['lines'][number];
    expect(of(hired.employeeId as string).flags).toEqual(expect.arrayContaining(['new_hire', 'check_minimum_wage', 'net_below_minimum']));
    expect(of(ids[1] as string).flags).toContain('ends_this_month');
    // A fixed-term contract with no term typed is refused for that person, not guessed: no figure, a reason, and the run cannot be approved.
    const refused = of(term.employeeId as string);
    expect(refused).toMatchObject({ status: 'refused', figures: null });
    expect(refused.refusal).toBeTruthy();
    expect(refused.flags).toEqual(expect.arrayContaining(['refused', 'fixed_term_months_missing']));
    expect(s.obstacles).toContain('refused_lines');
    expect(s.approvable).toBe(false);
    // Typing the term computes it.
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', { lineId: refused.id, inputs: { ...refused.inputs, contractTermMonths: 12 } });
    expect((await o.sheet(run.runId)).lines.find((l) => l.employeeId === term.employeeId)).toMatchObject({ status: 'calculated' });
  });

  it('refuses the approval while a rule a line used is commentary, listing the rows with their sources, and accepts it once they are confirmed', async () => {
    const o = await org();
    await o.team();
    const run = await o.open();
    setRuleStatus('commentary');
    const s = await o.sheet(run.runId);
    expect(s.blocking.length).toBeGreaterThan(0);
    expect(s.obstacles).toContain('rules_commentary');
    expect(s.approvable).toBe(false);
    expect(s.blocking[0]).toMatchObject({ status: 'commentary', cite: expect.any(String), confidence: expect.any(String) });
    const refusal = await o.approve(run.runId, s.fingerprint).catch((e: unknown) => e);
    expect(refusal).toMatchObject({ code: 'HR_RULES_COMMENTARY', details: { rules: expect.arrayContaining([expect.objectContaining({ id: s.blocking[0]?.id, cite: s.blocking[0]?.cite })]) } });
    expect((await o.sheet(run.runId)).run.status).toBe('draft');
    // The accountant has confirmed the rows (here, for the test): the same sheet is approvable.
    setRuleStatus('confirmed');
    const confirmed = await o.sheet(run.runId);
    expect(confirmed.blocking).toEqual([]);
    expect(confirmed.approvable).toBe(true);
    expect(confirmed.fingerprint).toBe(s.fingerprint);
    setRuleStatus('commentary');
  });

  it('approves with a fresh second factor only, by an owner or admin, never an agent; the figures must be the ones shown; a flag needs an acceptance', async () => {
    setRuleStatus('confirmed');
    const o = await org();
    const ids = await o.team();
    await o.hire({ displayName: 'Phạm Thấp Canary', employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '4000000' } });
    const run = await o.open();
    const s = await o.sheet(run.runId);
    // No fresh second factor (aal1), a member, a viewer and an agent are refused.
    await expect(o.exec(o.owner, 'hr.payroll.run.approve', { runId: run.runId, fingerprint: s.fingerprint, acceptFlags: true })).rejects.toMatchObject({ code: expect.stringMatching(/STEP_UP|MFA/) });
    for (const who of [o.member, o.viewer]) await expect(o.exec(who, 'hr.payroll.run.approve', { runId: run.runId, fingerprint: s.fingerprint }, asMfa(who))).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(rt.execute('hr.payroll.run.approve', { runId: run.runId, fingerprint: s.fingerprint }, { actor: { type: 'agent', agentId: randomUUID(), onBehalfOf: o.owner } as never, orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The sheet changed after it was shown: the old fingerprint is refused.
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', { lineId: (s.lines.find((l) => l.employeeId === ids[0]) as HrRunSheet['lines'][number]).id, inputs: { bonus: '1000000' } });
    await expect(o.approve(run.runId, s.fingerprint, { acceptFlags: true })).rejects.toMatchObject({ code: 'HR_RUN_CHANGED' });
    const fresh = await o.sheet(run.runId);
    // The line under the minimum wage is a flag, not a refusal: it needs the person's word that they have seen it.
    await expect(o.approve(run.runId, fresh.fingerprint)).rejects.toMatchObject({ code: 'HR_FLAGS_NOT_ACCEPTED' });
    const approved = await o.approve(run.runId, fresh.fingerprint, { acceptFlags: true });
    expect(approved.runId).toBe(run.runId);
    const after = await o.sheet(run.runId);
    expect(after.run).toMatchObject({ status: 'approved' });
    expect(after.run.approvedAt).toBeTruthy();
    expect(after.totals).toEqual(fresh.totals);
    expect(after.rules.length).toBeGreaterThan(0);
    // The record of the approval: who, when, the fingerprint and the rules as they were.
    const row = await withAdmin(async (c) => (await c.query<{ approved_by: string; approval: { fingerprint: string; flagsAccepted: boolean; rules: { id: string }[] } }>('SELECT approved_by, approval FROM crove_hr.payroll_run WHERE id = $1', [run.runId])).rows[0]);
    expect(row?.approved_by).toBe(o.owner);
    expect(row?.approval).toMatchObject({ fingerprint: fresh.fingerprint, flagsAccepted: true });
    expect(row?.approval.rules.length).toBe(after.rules.length);
    await expect(o.approve(run.runId, fresh.fingerprint, { acceptFlags: true })).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });
    setRuleStatus('commentary');
  });

  it('refuses to approve lines that no longer match the people, their terms and the rules, until the sheet is recalculated', async () => {
    setRuleStatus('confirmed');
    const o = await org();
    const ids = await o.team();
    const run = await o.open();
    // A raise and a new hire after the month was opened: the shown figures are out of date, so the approval is refused even with the sheet's own fingerprint.
    await o.exec(o.owner, 'hr.payroll.employment.add', { employeeId: ids[0], effectiveFrom: '2026-11-01', contractType: 'indefinite', region: 'I', baseWage: '20000000' });
    const before = await o.sheet(run.runId);
    await expect(o.approve(run.runId, before.fingerprint)).rejects.toMatchObject({ code: 'HR_RUN_STALE' });
    await o.hire({}, '12000000', 'Đỗ Mới Canary');
    await o.exec(o.owner, 'hr.payroll.run.recalculate', { runId: run.runId });
    const after = await o.sheet(run.runId);
    expect(after.lines).toHaveLength(4);
    await o.approve(run.runId, after.fingerprint);
    expect((await o.sheet(run.runId)).run.status).toBe('approved');
    setRuleStatus('commentary');
  });

  it('takes a person no longer paid out of the sheet on recalculation, and refuses to approve while their line is still there', async () => {
    setRuleStatus('confirmed');
    const o = await org();
    const ids = await o.team();
    const run = await o.open();
    expect((await o.sheet(run.runId)).lines).toHaveLength(3);
    // The second employee is ended on the last day of the month before: they are not paid in November, but their line was opened with the sheet.
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: ids[1], endedOn: '2026-10-31' });
    const before = await o.sheet(run.runId);
    await expect(o.approve(run.runId, before.fingerprint)).rejects.toMatchObject({ code: 'HR_RUN_STALE' });
    await o.exec(o.owner, 'hr.payroll.run.recalculate', { runId: run.runId });
    const after = await o.sheet(run.runId);
    expect(after.lines.map((l) => l.employeeId).sort()).toEqual([ids[0], ids[2]].sort());
    expect(Number(after.totals.gross)).toBe(45_000_000);
    await o.approve(run.runId, after.fingerprint);
    const [recalc] = (await o.audits('hr.payroll.run.recalculate')).slice(-1);
    expect(recalc?.detail).toMatchObject({ removed: 1 });
    // An approved month never loses a line, not even to a recalculation or a direct delete.
    await expect(o.exec(o.owner, 'hr.payroll.run.recalculate', { runId: run.runId })).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });
    await expect(withAdmin((c) => c.query('DELETE FROM crove_hr.payroll_line WHERE id = $1', [after.lines[0]?.id]))).rejects.toThrow(/frozen/);
    setRuleStatus('commentary');
  });

  it('refuses TRUNCATE of the pay run tables to every role, the table owner included', async () => {
    await org();
    for (const table of ['crove_hr.payroll_line', 'crove_hr.payroll_run']) {
      await expect(withAdmin((c) => c.query(`TRUNCATE ${table} CASCADE`)), table).rejects.toThrow(/is append-only/);
    }
  });

  it('never changes an approved run or its lines: the commands refuse, and so does the database for anyone', async () => {
    setRuleStatus('confirmed');
    const o = await org();
    await o.team();
    const run = await o.open();
    const s = await o.sheet(run.runId);
    await o.approve(run.runId, s.fingerprint);
    const line = s.lines[0] as HrRunSheet['lines'][number];
    await expect(o.exec(o.owner, 'hr.payroll.line.inputs.set', { lineId: line.id, inputs: { bonus: '1' } })).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });
    await expect(o.exec(o.owner, 'hr.payroll.run.recalculate', { runId: run.runId })).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });
    // The database's guard answers (its error is a permission error, whatever the caller).
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(o.exec(o.owner, 't2531.touch_line', { lineId: line.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      logged.mockRestore();
    }
    // Even the table's owner with the role that bypasses row security meets the guard (it fires in replica mode as well).
    await expect(withAdmin((c) => c.query('UPDATE crove_hr.payroll_line SET net = 1 WHERE id = $1', [line.id]))).rejects.toThrow(/frozen/);
    await expect(withAdmin((c) => c.query("UPDATE crove_hr.payroll_run SET status = 'draft', approved_at = NULL, approved_by = NULL, approval = NULL WHERE id = $1", [run.runId]))).rejects.toThrow(/frozen/);
    await expect(withAdmin((c) => c.query('DELETE FROM crove_hr.payroll_line WHERE id = $1', [line.id]))).rejects.toThrow(/frozen/);
    await expect(
      withAdmin(async (c) => {
        await c.query("SET session_replication_role = 'replica'");
        await c.query('UPDATE crove_hr.payroll_line SET net = 1 WHERE id = $1', [line.id]);
      }),
    ).rejects.toThrow(/frozen/);
    // The run is unchanged.
    expect((await o.sheet(run.runId)).totals).toEqual(s.totals);
    setRuleStatus('commentary');
  });

  it('corrects an approved month by an adjustment line in a later run, and shows a payslip as the stored facts of a person-month', async () => {
    setRuleStatus('confirmed');
    const o = await org();
    const ids = await o.team();
    const october = await o.open(PREVIOUS);
    const octoberSheet = await o.sheet(october.runId);
    await o.approve(october.runId, octoberSheet.fingerprint);
    const november = await o.open(MONTH);
    // A correction in the same month or in an unapproved one is refused; in a later run it is a signed line that changes the totals.
    await expect(o.exec(o.owner, 'hr.payroll.line.adjust', { runId: october.runId, adjustsRunId: october.runId, employeeId: ids[0], note: 'x', gross: '1' })).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });
    await expect(o.exec(o.owner, 'hr.payroll.line.adjust', { runId: november.runId, adjustsRunId: november.runId, employeeId: ids[0], note: 'x', gross: '1' })).rejects.toMatchObject({ code: 'HR_ADJUST_NOT_APPROVED' });
    // A person with no pay line in the corrected month cannot be corrected there.
    const late = await o.hire({ displayName: 'Hồ Muộn Canary', employment: { effectiveFrom: '2026-11-15', contractType: 'indefinite', region: 'I', baseWage: '9000000' } });
    await expect(o.exec(o.owner, 'hr.payroll.line.adjust', { runId: november.runId, adjustsRunId: october.runId, employeeId: late.employeeId, note: 'x', gross: '1' })).rejects.toMatchObject({ code: 'HR_ADJUST_NOT_PAID' });
    const adjusted = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.line.adjust', { runId: november.runId, adjustsRunId: october.runId, employeeId: ids[0], note: 'Tính thiếu tiền làm thêm giờ tháng 10', gross: '500000', pit: '25000' });
    const s = await o.sheet(november.runId);
    const adjustment = s.lines.find((l) => l.id === adjusted.lineId) as HrRunSheet['lines'][number];
    expect(adjustment).toMatchObject({ kind: 'adjustment', adjustsMonth: PREVIOUS, note: 'Tính thiếu tiền làm thêm giờ tháng 10', figures: expect.objectContaining({ gross: '500000.00', net: '475000.00', employerCost: '500000.00', pit: '25000.00' }) });
    expect(Number(s.totals.gross)).toBe(54_500_000);
    // The October lines are as they were.
    expect((await o.sheet(october.runId)).totals).toEqual(octoberSheet.totals);
    // A payslip is the stored line: the same figures and breakdown, the period, the employer and the person; an adjustment has none.
    const payLine = octoberSheet.lines[0] as HrRunSheet['lines'][number];
    const slip = await o.query<HrPayslip>(o.admin, 'hr.payroll.line.payslip', { lineId: payLine.id });
    expect(slip).toMatchObject({ month: PREVIOUS, status: 'approved', employeeName: payLine.employeeName, figures: payLine.figures, breakdown: payLine.breakdown });
    expect(slip.employerName.length).toBeGreaterThan(0);
    await expect(o.query(o.owner, 'hr.payroll.line.payslip', { lineId: adjustment.id })).rejects.toMatchObject({ code: 'HR_NO_PAYSLIP' });
    setRuleStatus('commentary');
  });

  it('keeps a member, a viewer and the system out of the runs, the lines and the database rows', async () => {
    setRuleStatus('commentary');
    const o = await org();
    await o.team();
    const run = await o.open();
    const s = await o.sheet(run.runId);
    for (const who of [o.member, o.viewer]) {
      await expect(o.query(who, 'hr.payroll.run.list', {}), 'list').rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(o.sheet(run.runId, who), 'sheet').rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(o.query(who, 'hr.payroll.line.payslip', { lineId: (s.lines[0] as HrRunSheet['lines'][number]).id }), 'payslip').rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(o.exec(who, 'hr.payroll.run.open', { month: '2026-12' }), 'open').rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(await o.query(who, 't2531.peek')).toEqual({ runs: 0, lines: 0 });
    }
    expect(await o.query(o.admin, 't2531.peek')).toEqual({ runs: 1, lines: 3 });
    // A refused read leaves no audit row of a read; an allowed one leaves one before it.
    expect((await o.audits('hr.payroll.run.list')).length).toBe(0);
    await o.query(o.admin, 'hr.payroll.run.list', {});
    expect((await o.audits('hr.payroll.run.list')).map((a) => a.outcome)).toEqual(['ok']);
  });

  it('leaves no name and no amount in any audit row', async () => {
    setRuleStatus('confirmed');
    const o = await org();
    await o.team();
    const run = await o.open();
    const s = await o.sheet(run.runId);
    await o.approve(run.runId, s.fingerprint);
    const all = await withAdmin(async (c) => (await c.query<{ row: string }>('SELECT audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1', [o.orgId])).rows.map((r) => r.row).join('\n'));
    for (const needle of [...NAMES, '15000000', '9000000', '30000000', '54000000']) expect(all, needle).not.toContain(needle);
    const [approval] = await o.audits('hr.payroll.run.approve');
    expect(approval?.detail).toMatchObject({ runId: run.runId, month: MONTH, lines: 3, approval: { redacted: 'sensitive' } });
    // The fingerprint is a plain hash over inputs and figures: audit rows reach the WORM archive, so it stays in the run's own approval record and out of every audit row.
    expect(approval?.detail).not.toHaveProperty('fingerprint');
    expect(all, 'the approval fingerprint').not.toContain(s.fingerprint);
    setRuleStatus('commentary');
  });

  // ---- The owner's org export carries the payroll people through the owner-run path (#2676). Folded into this file, which already has a migrated database, so CI creates and
  // migrates no database of its own for it (the database shards are near their 20 minute limit, #2736).
  const EXPORT_IDENTITY = '079 123 456 789';
  const EXPORT_IDENTITY_DIGITS = '079123456789';
  const EXPORT_ACCOUNT = '1903 4455 6677 88';
  const EXPORT_ACCOUNT_DIGITS = '19034455667788';
  const EXPORT_TAX = '3498120657';
  const EXPORT_INSURANCE = '9071263845';
  const EXPORT_NAME = 'Nguyễn Thị Hằng Export';
  const EXPORT_DEPENDENT = 'Nguyễn Văn Con Export';
  const system = { type: 'system' as const, component: 'org-export' };

  // An org with one employee (the identity and account numbers sealed), a dependent and a draft pay run; `closing` moves it to offboarding (R3, a fresh second factor), as an owner closing it does.
  async function exportOrg(closing = false) {
    const o = await org();
    const employee = await o.hire({ address: '12 Đường Canary, Quận 1', identityNumber: EXPORT_IDENTITY, accountNumber: EXPORT_ACCOUNT, birthDate: '1990-05-17', taxCode: EXPORT_TAX, insuranceNumber: EXPORT_INSURANCE }, WAGES[0], EXPORT_NAME);
    await o.exec(o.owner, 'hr.payroll.dependent.add', { employeeId: employee.employeeId, displayName: EXPORT_DEPENDENT, relation: 'child', registeredOn: '2026-02-01' });
    await o.open('2026-06');
    if (closing) await rt.execute('kernel.org.offboard', { confirmSlug: o.slug }, { actor: asMfa(o.owner), orgId: o.orgId });
    return o;
  }

  const read = async (runtime: Runtime, table: string, actor: Parameters<Runtime['stream']>[2]['actor'], orgId: string) => {
    const lines: string[] = [];
    await runtime.stream('kernel.org.export.people', { table }, { actor, orgId }, async (raw) => {
      lines.push(...(raw as { lines: string[] }).lines);
    });
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  };

  // The payroll declaration exports (#2533): figures from approved runs only, sealed identifiers opened in the audited sensitive path only, owners and admins only, no caching.
  const DECL_IDENTITY = '079 321 654 987';
  const DECL_IDENTITY_DIGITS = '079321654987';
  const DECL_TAX = '8765432101';
  const DECL_INSURANCE = 'SI-4455667788';
  async function declarationOrg() {
    setRuleStatus('confirmed');
    const o = await org();
    const an = await o.hire({ identityNumber: DECL_IDENTITY, taxCode: DECL_TAX, insuranceNumber: DECL_INSURANCE, birthDate: '1990-05-17' }, '35000000', NAMES[0]);
    const binh = await o.hire({ identityNumber: '079 111 222 333' }, WAGES[1], NAMES[1]);
    const chi = await o.hire({ taxCode: '1234567890' }, WAGES[2], NAMES[2]);
    const formula = await o.hire({}, '12000000', '=HYPERLINK("http://example.test","click")');
    for (const id of [chi.employeeId, formula.employeeId]) await o.exec(o.owner, 'hr.payroll.employee.finalization.set', { employeeId: id, year: 2026, authorized: true });
    const months = ['2026-07', '2026-08'];
    for (const month of months) {
      const run = await o.open(month);
      await o.approve(run.runId, (await o.sheet(run.runId)).fingerprint, { acceptFlags: true });
    }
    // The third month stays a draft: it is in no declaration.
    await o.open('2026-09');
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: binh.employeeId, endedOn: '2026-08-15' });
    setRuleStatus('commentary');
    const get = (who: string, kind: string, period: string) => o.query<HrDeclarationDocument>(who, 'hr.payroll.declaration.get', { kind, period });
    return { o, an, binh, chi, formula, get };
  }

  it('(declarations, #2533) ties a quarter to the approved runs: a draft month is left out, a leaver stays for the months paid, the sealed identifiers are opened for the people in it', async () => {
    const { o, get } = await declarationOrg();
    const doc = await get(o.owner, 'kk', '2026-Q3');
    expect(doc.title.toLowerCase()).toContain('bảng kê để khai báo');
    expect(doc.layout.version).toBe('ludy-hr-05kk/1');
    expect(doc.draft).toContain('dòng 14');
    expect(doc.header.find((h) => h.label.startsWith('Tháng chưa'))?.value).toBe('2026-09');
    const [summary, progressive] = doc.sheets;
    const stored = await withAdmin(async (c) => (await c.query<{ pit: string; n: string }>(`SELECT COALESCE(sum(l.pit), 0)::text AS pit, count(DISTINCT l.employee_id)::text AS n FROM crove_hr.payroll_line l JOIN crove_hr.payroll_run r ON r.org_id = l.org_id AND r.id = l.run_id WHERE l.org_id = $1 AND r.status = 'approved'`, [o.orgId])).rows[0]);
    const value = (item: string) => summary?.rows.find((r) => r.item?.startsWith(item))?.value;
    expect(Number(value('Tổng số thuế'))).toBe(Number(stored?.pit));
    expect(value('Tổng số người lao động')).toBe(stored?.n);
    const binhRow = progressive?.rows.find((r) => r.name === NAMES[1]);
    expect(binhRow).toMatchObject({ months: '2026-07, 2026-08', note: 'Nghỉ việc ngày 2026-08-15', identityNumber: '079 111 222 333' });
    // The tax code is the one on file, or the identity number when none is: the document says so.
    const anRow = progressive?.rows.find((r) => r.name === NAMES[0]);
    expect(anRow).toMatchObject({ identityNumber: DECL_IDENTITY, taxCode: DECL_TAX, birthDate: '1990-05-17' });
    expect(binhRow?.taxCode).toBe('079 111 222 333');
    expect(doc.notes.join(' ')).toContain('chưa có mã số thuế riêng');
  });

  it('(declarations, #2533) lists the month of the D02-LT, the annual data of an authorizer and the certificates by the rules', async () => {
    const { o, get } = await declarationOrg();
    const d02 = await get(o.owner, 'd02lt', '2026-08');
    expect(d02.sheets[0]?.rows.map((r) => [r.name, r.movement, r.effectiveOn])).toEqual([[NAMES[1], 'Giảm lao động', '2026-08-15']]);
    expect(d02.layout.version).toBe('ludy-hr-d02lt/1');
    const july = await get(o.owner, 'd02lt', '2026-07');
    expect(july.sheets[0]?.rows).toEqual([]);
    const annual = await get(o.owner, 'qtt', '2026');
    expect(annual.sheets[1]?.rows.map((r) => r.name).sort()).toEqual([NAMES[2], '=HYPERLINK("http://example.test","click")'].sort());
    expect(annual.sheets[2]?.rows.map((r) => r.name).sort()).toEqual([NAMES[0], NAMES[1]].sort());
    expect(annual.notes[0]).toContain('Chưa có bảng lương đã duyệt');
    const certificates = await get(o.owner, 'certificate', '2026');
    // Only An (35M) and Chi (30M) are withheld; Chi authorized the payer to finalize, so An alone gets a certificate and Chi is listed as not given one. Bình (9M) and the 12M person owe no tax.
    expect(certificates.sheets[0]?.rows.map((r) => r.name)).toEqual([NAMES[0]]);
    expect(certificates.sheets[1]?.rows.map((r) => r.name)).toEqual([NAMES[2]]);
  });

  it('(declarations, #2533) is a sensitive query owners and admins only: audited before the read, with no identifier in any audit row', async () => {
    const { o, get } = await declarationOrg();
    await get(o.owner, 'kk', '2026-Q3');
    await get(o.admin, 'd02lt', '2026-08');
    for (const who of [o.member, o.viewer]) await expect(get(who, 'kk', '2026-Q3')).rejects.toMatchObject({ status: 403 });
    await expect(rt.query('hr.payroll.declaration.get', { kind: 'kk', period: '2026-Q3' }, { actor: { type: 'agent', agentId: randomUUID(), runId: randomUUID() } as never, orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(get(o.owner, 'kk', '2026-13')).rejects.toBeDefined();
    const rows = await withAdmin(async (c) => (await c.query<{ detail: string; row: string }>(`SELECT detail::text AS detail, audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'hr.payroll.declaration.get' ORDER BY id`, [o.orgId])).rows);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toMatchObject({ read: 'sensitive', stage: 'before_read' });
    for (const r of rows) for (const needle of [DECL_IDENTITY_DIGITS, DECL_TAX, DECL_INSURANCE, '079111222333', NAMES[0]]) expect(r.row, needle).not.toContain(needle);
    // Erased people read as none: shredding the key leaves the document with the placeholder and no identifier.
  });

  it('(declarations, #2533) serves the xlsx on an authenticated, audited, uncached route for owners and admins only', async () => {
    const { o } = await declarationOrg();
    const users = new Map<string, AuthUser>([o.owner, o.admin, o.member, o.viewer].map((id) => [id, { userId: id, email: '', name: null, aal: 'aal1', sessionId: randomUUID(), mfaAt: null }]));
    const app = createHttpApp({
      config: loadConfig({ DATABASE_URL: appUrl, AUTH_JWT_SECRET: 'test-only-jwt-secret-for-export-0123456789', AUTH_ISSUER: 'test-auth', WEB_DIST: '/nonexistent', EXPORT_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),
      runtime: rt,
      store: new MemoryStore(),
      authenticate: async (header) => {
        const user = users.get(String(header).replace('Bearer ', ''));
        if (!user) throw new DomainError('UNAUTHENTICATED', 401, 'no');
        return user;
      },
      pool,
      aiEnabled: false,
    });
    const get = (file: string, query: string, userId: string) => app.request(`/api/payroll-export/${file}?${query}`, { headers: { authorization: `Bearer ${userId}`, 'x-crove-org': o.slug } });
    expect((await app.request('/api/payroll-export/kk.xlsx?period=2026-Q3')).status).toBe(401);
    for (const who of [o.member, o.viewer]) expect((await get('kk.xlsx', 'period=2026-Q3', who)).status).toBe(403);
    expect((await get('nothing.xlsx', 'period=2026-Q3', o.owner)).status).toBe(404);
    expect((await get('kk.csv', 'period=2026-Q3', o.owner)).status).toBe(404);
    expect((await get('kk.xlsx', 'period=2026-13', o.owner)).status).toBe(422);
    for (const [file, period] of [['d02lt.xlsx', '2026-08'], ['kk.xlsx', '2026-Q3'], ['qtt.xlsx', '2026'], ['certificate.xlsx', '2026']] as const) {
      for (const who of [o.owner, o.admin]) {
        const res = await get(file, `period=${period}`, who);
        expect(res.status, `${file} ${who}`).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(res.headers.get('content-disposition')).toContain('attachment');
        const bytes = new Uint8Array(await res.arrayBuffer());
        expect(String.fromCharCode(bytes[0] as number, bytes[1] as number)).toBe('PK');
      }
    }
    // A download leaves an audit row with counts only.
    const exported = await withAdmin(async (c) => (await c.query<{ detail: string; row: string }>(`SELECT detail::text AS detail, audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'hr.payroll.declaration.export' ORDER BY id`, [o.orgId])).rows);
    expect(exported.length).toBe(8);
    expect(exported.map((r) => JSON.parse(r.detail) as { kind: string; period: string }).find((d) => d.kind === 'kk')).toMatchObject({ period: '2026-Q3' });
    for (const r of exported) for (const needle of [DECL_IDENTITY_DIGITS, DECL_TAX, NAMES[0], NAMES[1]]) expect(r.row, needle).not.toContain(needle);
  });

  it('(org export, #2676) streams the payroll tables to the owner with no plain number and no sealed text, and audits each read before it', async () => {
    const o = await exportOrg(true);
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
    expect(employees[0]).toMatchObject({ display_name: EXPORT_NAME });
    expect(employees[0]).not.toHaveProperty('national_id_sealed');
    expect(employees[0]).not.toHaveProperty('bank_account_sealed');
    expect(employees[0]).not.toHaveProperty('tax_code_sealed');
    expect(employees[0]).not.toHaveProperty('insurance_number_sealed');
    expect(employments[0]).toMatchObject({ contract_type: 'indefinite' });
    expect(dependents[0]).toMatchObject({ display_name: EXPORT_DEPENDENT });
    const text = JSON.stringify([employees, employments, dependents, runs, lines]);
    for (const needle of [EXPORT_IDENTITY, EXPORT_IDENTITY_DIGITS, EXPORT_ACCOUNT, EXPORT_ACCOUNT_DIGITS, EXPORT_TAX, EXPORT_INSURANCE, 'crove:s1:']) expect(text, needle).not.toContain(needle);
    const audits = await withAdmin(
      async (c) => (await c.query<{ outcome: string; detail: string; row: string }>(`SELECT outcome, detail::text AS detail, audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.org.export.people' ORDER BY id`, [o.orgId])).rows,
    );
    expect(audits.map((a) => a.outcome)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    // Each row names the table read (not personal data) and says the read was started.
    expect(audits.map((a) => (JSON.parse(a.detail) as { table: string }).table)).toEqual([...OWNER_RUN_EXPORT_TABLE_NAMES]);
    expect(JSON.parse(audits[0]?.detail ?? '{}')).toMatchObject({ read: 'sensitive', stage: 'before_read' });
    for (const a of audits) for (const needle of [EXPORT_IDENTITY_DIGITS, EXPORT_ACCOUNT_DIGITS, EXPORT_TAX, EXPORT_INSURANCE, EXPORT_NAME, EXPORT_DEPENDENT]) expect(a.row, needle).not.toContain(needle);
  });

  it('(org export, #2676) refuses a member, an admin, an admin of another org, the system and the worker; the snapshot cannot be asked for the tables', async () => {
    const o = await exportOrg();
    const other = await exportOrg();
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

  it('(org export, #2676) serves the tables on the owner download route and nobody else', async () => {
    const o = await exportOrg();
    const closing = await exportOrg(true);
    const other = await exportOrg(true);
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
      for (const needle of [EXPORT_IDENTITY_DIGITS, EXPORT_ACCOUNT_DIGITS, 'crove:s1:']) expect(text).not.toContain(needle);
    }
    // Another org's owner reads their own people, never this org's.
    const own = JSON.parse((await (await get('hr.payroll_dependent', other.owner, other.slug)).text()).trim().split('\n')[0] as string) as { org_id: string };
    expect(own.org_id).toBe(other.orgId);
    expect((await get('hr.payroll_employee', other.owner, closing.slug)).status).toBe(403);
    // A key of Object.prototype is not an owner-run table: it takes the stored-export path and finds no export.
    expect((await get('constructor', closing.owner, closing.slug)).status).toBe(404);
  });
});

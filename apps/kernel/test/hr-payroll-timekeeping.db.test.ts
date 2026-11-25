// SPDX-License-Identifier: AGPL-3.0-only
// Batch timekeeping import and monthly 40h overtime cap check (#3371) on real PostgreSQL 17.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { HrRunSheet, HrRunWritten, HrWritten } from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { PAYROLL_RULES } from '@ludy/l10n-vn';
import { hrCommands, hrQueries } from '@ludy/mod-hr';
import { TEST_MANIFESTS } from './manifests.ts';

vi.mock('@ludy/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ludy/l10n-vn')>();
  return { ...real, PAYROLL_RULES: real.PAYROLL_RULES.map((row) => ({ ...row })) };
});
const setRuleStatus = (status: 'confirmed' | 'commentary') => {
  for (const row of PAYROLL_RULES) (row as { status: string }).status = status;
};

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const MONTH = '2026-11';
const NAMES = ['Nguyễn Thị Hằng Canary', 'Trần Văn Hai Canary'] as const;
const WAGES = ['15000000', '10000000'] as const;

suite('HR payroll timekeeping import and overtime cap (#3371)', () => {
  const dbName = `ludy_test_hrot_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

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
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hrot', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, asUser(owner), `Chấm công ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, admin, member, viewer]));
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    const hire = (wage: string, name: string) =>
      exec<HrWritten>(owner, 'hr.payroll.employee.add', { displayName: name, employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: wage } });
    const open = (month = MONTH) => exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month });
    const sheet = (runId: string) => query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId });
    const approve = (runId: string, fingerprint: string, acceptFlags = false) =>
      exec<HrRunWritten>(owner, 'hr.payroll.run.approve', { runId, fingerprint, acceptFlags }, asMfa(owner));
    const audits = (command: string) => withAdmin(async (c) => (await c.query<{ outcome: string; detail: unknown }>('SELECT outcome, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY id', [orgId, command])).rows);
    return { orgId, owner, admin, member, viewer, exec, hire, open, sheet, approve, audits };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    rt = new Runtime(createDb(pool), {
      manifests: TEST_MANIFESTS,
      subjectVault,
      readAuditKey: randomBytes(32),
    }).register({ commands: [...kernelCommands, ...hrCommands], queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('imports timekeeping while preserving allowances, bonus, advance, and deductions, and enforces the 40h overtime_cap flag gate', async () => {
    setRuleStatus('commentary');
    const o = await org();
    await o.hire(WAGES[0], NAMES[0]);
    await o.hire(WAGES[1], NAMES[1]);
    const run = await o.open();
    const initial = await o.sheet(run.runId);
    const lineA = initial.lines.find((l) => l.employeeName === NAMES[0])!;
    const lineB = initial.lines.find((l) => l.employeeName === NAMES[1])!;

    // Seed non-timekeeping inputs on lineA that must survive timekeeping import.
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: lineA.id,
      inputs: {
        allowances: [{ label: 'Ăn trưa', type: 'meal_cash', amount: '730000', namedInContract: true }],
        bonus: '2000000',
        advance: '500000',
        deductions: [{ label: 'Bồi thường', kind: 'damage', amount: '100000' }],
        nightHours: '2',
        overtime: [{ dayKind: 'normal_day', night: false, hours: '5' }],
      },
    });

    const imported = await o.exec<HrRunWritten>(o.admin, 'hr.payroll.run.import_timekeeping', {
      runId: run.runId,
      rows: [
        {
          lineId: lineA.id,
          unpaidLeaveDays: '1',
          daysNotEmployed: '0',
          nightHours: '6',
          overtime: [
            { dayKind: 'normal_day', night: false, hours: '25' },
            { dayKind: 'weekly_rest_day', night: false, hours: '20' },
          ],
        },
        {
          lineId: lineB.id,
          unpaidLeaveDays: '0',
          daysNotEmployed: '2',
          nightHours: '0',
          overtime: [{ dayKind: 'normal_day', night: false, hours: '40' }],
        },
      ],
    });
    expect(imported).toEqual({ runId: run.runId, lines: 2 });

    // Audit records count only, with zero names, hours, or amounts.
    expect(await o.audits('hr.payroll.run.import_timekeeping')).toEqual([
      { outcome: 'ok', detail: { updatedLines: 2 } },
    ]);

    const after = await o.sheet(run.runId);
    const afterA = after.lines.find((l) => l.id === lineA.id)!;
    const afterB = after.lines.find((l) => l.id === lineB.id)!;

    expect(afterA.inputs).toMatchObject({
      allowances: [expect.objectContaining({ label: 'Ăn trưa', amount: '730000' })],
      bonus: '2000000',
      advance: '500000',
      deductions: [expect.objectContaining({ label: 'Bồi thường', amount: '100000' })],
      unpaidLeaveDays: '1',
      daysNotEmployed: '0',
      nightHours: '6',
      overtime: [
        { dayKind: 'normal_day', night: false, hours: '25' },
        { dayKind: 'weekly_rest_day', night: false, hours: '20' },
      ],
    });
    expect(afterA.checks).toContainEqual({ id: 'overtime_cap', ok: false, actual: '45', limit: '40' });
    expect(afterA.flags).toContain('check_overtime_cap');

    expect(afterB.checks).toContainEqual({ id: 'overtime_cap', ok: true, actual: '40', limit: '40' });
    expect(afterB.flags).not.toContain('check_overtime_cap');

    // Rules include overtime_caps when OT > 0; commentary blocks approval until confirmed.
    expect(after.rules.some((r) => r.id.startsWith('overtime_caps.'))).toBe(true);
    await expect(o.approve(run.runId, after.fingerprint, true)).rejects.toMatchObject({ code: 'HR_RULES_COMMENTARY' });

    setRuleStatus('confirmed');
    await expect(o.approve(run.runId, after.fingerprint, false)).rejects.toMatchObject({ code: 'HR_FLAGS_NOT_ACCEPTED' });
    await o.approve(run.runId, after.fingerprint, true);
    expect((await o.sheet(run.runId)).run.status).toBe('approved');
    setRuleStatus('commentary');
  });

  it('refuses non-managers, non-draft runs, adjustment lines, and cross-run lineIds', async () => {
    setRuleStatus('confirmed');
    const o = await org();
    await o.hire(WAGES[0], NAMES[0]);
    const prevRun = await o.open('2026-10');
    const prevSheet = await o.sheet(prevRun.runId);
    const prevLine = prevSheet.lines[0]!;

    for (const who of [o.member, o.viewer]) {
      await expect(
        o.exec(who, 'hr.payroll.run.import_timekeeping', {
          runId: prevRun.runId,
          rows: [{ lineId: prevLine.id, unpaidLeaveDays: '0', daysNotEmployed: '0', nightHours: '0', overtime: [] }],
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }

    // Approve Oct, open Nov with an adjustment line, test cross-run + non-draft + non-pay refusals.
    await o.approve(prevRun.runId, prevSheet.fingerprint);
    await expect(
      o.exec(o.owner, 'hr.payroll.run.import_timekeeping', {
        runId: prevRun.runId,
        rows: [{ lineId: prevLine.id, unpaidLeaveDays: '1', daysNotEmployed: '0', nightHours: '0', overtime: [] }],
      }),
    ).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });

    const novRun = await o.open('2026-11');
    const adj = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.line.adjust', {
      runId: novRun.runId,
      adjustsRunId: prevRun.runId,
      employeeId: prevLine.employeeId,
      gross: '500000',
      note: 'Bổ sung tháng 10',
    });

    await expect(
      o.exec(o.owner, 'hr.payroll.run.import_timekeeping', {
        runId: novRun.runId,
        rows: [{ lineId: adj.lineId!, unpaidLeaveDays: '0', daysNotEmployed: '0', nightHours: '0', overtime: [] }],
      }),
    ).rejects.toMatchObject({ code: 'HR_LINE_NOT_PAY' });

    await expect(
      o.exec(o.owner, 'hr.payroll.run.import_timekeeping', {
        runId: novRun.runId,
        rows: [{ lineId: prevLine.id, unpaidLeaveDays: '0', daysNotEmployed: '0', nightHours: '0', overtime: [] }],
      }),
    ).rejects.toMatchObject({ code: 'HR_LINE_NOT_FOUND' });

    const novSheet = await o.sheet(novRun.runId);
    const novPayLine = novSheet.lines.find((l) => l.kind === 'pay')!;
    const dupRow = { lineId: novPayLine.id, unpaidLeaveDays: '0', daysNotEmployed: '0', nightHours: '0', overtime: [] };
    await expect(
      o.exec(o.owner, 'hr.payroll.run.import_timekeeping', {
        runId: novRun.runId,
        rows: [dupRow, dupRow],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    setRuleStatus('commentary');
  });
});

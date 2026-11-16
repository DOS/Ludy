// SPDX-License-Identifier: AGPL-3.0-only
// Stage 2 slice 2b-2 (#3375): 13th-month salary proration, statutory severance allowance calculator, and Ly severance_check signal on real PostgreSQL 17.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { prepareMonth, type PayrollReads } from '../src/payroll-coworker-ai.ts';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type {
  HrEmployeeSeveranceResult,
  HrRunSheet,
  HrRunSummary,
  HrRunWritten,
  HrThirteenthMonthPreviewResult,
  HrWritten,
} from '@crove/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@crove/kernel-runtime';
import { PAYROLL_RULES } from '@crove/l10n-vn';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import { TEST_MANIFESTS } from './manifests.ts';

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

suite('HR 13th-month salary, statutory severance, and Ly severance_check (#3375)', () => {
  const dbName = `crove_test_hr2b2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hr2b2', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, asUser(owner), `HR 2b2 ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, admin, member, viewer]));
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    const hire = (name: string, effectiveFrom: string, baseWage: string) =>
      exec<HrWritten>(owner, 'hr.payroll.employee.add', {
        displayName: name,
        employment: { effectiveFrom, contractType: 'indefinite', region: 'I', baseWage },
      });
    const open = (month: string) => exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month });
    const sheet = (runId: string) => query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId });
    const approve = (runId: string, fingerprint: string, acceptFlags = false) =>
      exec<HrRunWritten>(owner, 'hr.payroll.run.approve', { runId, fingerprint, acceptFlags }, asMfa(owner));
    const audits = (command: string) =>
      withAdmin(async (c) => (await c.query<{ outcome: string; detail: unknown }>('SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY id', [orgId, command])).rows);
    return { orgId, owner, admin, member, viewer, exec, query, hire, open, sheet, approve, audits };
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
    url.username = 'crove_app';
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

  it('previews and applies prorated 13th-month salary in replace & add modes while preserving listRulesUsed approval and audit hygiene', async () => {
    setRuleStatus('commentary');
    const o = await org();
    const empA = await o.hire('Nguyễn Thị Lan Canary', '2025-01-01', '12000000');
    const empB = await o.hire('Trần Văn Minh Canary', '2026-07-17', '24000000');

    const decRun = await o.open('2026-12');
    const initial = await o.sheet(decRun.runId);
    const lineA = initial.lines.find((l) => l.employeeId === empA.employeeId)!;
    const lineB = initial.lines.find((l) => l.employeeId === empB.employeeId)!;

    // Seed existing inputs on lineB that must survive 13th-month apply in both modes.
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: lineB.id,
      inputs: {
        allowances: [{ label: 'Ăn trưa', type: 'meal_cash', amount: '730000', namedInContract: true }],
        bonus: '1000000',
        overtime: [{ dayKind: 'normal_day', night: false, hours: '8' }],
      },
    });

    const preview = await o.query<HrThirteenthMonthPreviewResult>(o.admin, 'hr.payroll.run.thirteenth_month_preview', { runId: decRun.runId });
    expect(preview.year).toBe(2026);
    expect(preview.minDaysForMonth).toBe(15);
    expect(preview.totalAmount).toBe('24000000');
    expect(preview.rulesUsed.some((r) => r.id.startsWith('thirteenth_month.'))).toBe(true);
    expect(preview.rows.find((r) => r.lineId === lineA.id)).toMatchObject({
      workedMonths: '12',
      amount: '12000000',
      existingBonus: '0',
    });
    expect(preview.rows.find((r) => r.lineId === lineB.id)).toMatchObject({
      workedMonths: '6',
      amount: '12000000',
      existingBonus: '1000000',
    });

    // Mode 'replace' with overridden workedMonths = 10 on lineA -> 10,000,000.
    const replaced = await o.exec<HrRunWritten>(o.admin, 'hr.payroll.run.apply_thirteenth_month', {
      runId: decRun.runId,
      year: 2026,
      mode: 'replace',
      rows: [{ lineId: lineA.id, workedMonths: '10' }],
    });
    expect(replaced).toEqual({ runId: decRun.runId, lines: 1 });

    // Mode 'add' on lineB -> 1,000,000 + 12,000,000 = 13,000,000; preserves allowances and overtime.
    const added = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.apply_thirteenth_month', {
      runId: decRun.runId,
      year: 2026,
      mode: 'add',
      rows: [{ lineId: lineB.id, workedMonths: 6 }],
    });
    expect(added).toEqual({ runId: decRun.runId, lines: 1 });

    const after = await o.sheet(decRun.runId);
    const afterA = after.lines.find((l) => l.id === lineA.id)!;
    const afterB = after.lines.find((l) => l.id === lineB.id)!;
    expect(afterA.inputs).toMatchObject({ bonus: '10000000' });
    expect(afterB.inputs).toMatchObject({
      bonus: '13000000',
      allowances: [expect.objectContaining({ label: 'Ăn trưa', amount: '730000' })],
      overtime: [{ dayKind: 'normal_day', night: false, hours: '8' }],
    });

    // Audit rows must carry zero names or amounts.
    expect(await o.audits('hr.payroll.run.apply_thirteenth_month')).toEqual([
      { outcome: 'ok', detail: { year: 2026, mode: 'replace', updatedLines: 1 } },
      { outcome: 'ok', detail: { year: 2026, mode: 'add', updatedLines: 1 } },
    ]);
    expect((await o.audits('hr.payroll.run.thirteenth_month_preview')).map((a) => a.outcome)).toEqual(['ok']);

    // runApprove must succeed cleanly (no LaborRuleRef leaked into payroll_line.rules_used).
    setRuleStatus('confirmed');
    await o.approve(decRun.runId, after.fingerprint, true);
    expect((await o.sheet(decRun.runId)).run.status).toBe('approved');

    // Non-managers and non-draft runs are refused; January defaults to prior year.
    for (const who of [o.member, o.viewer]) {
      await expect(o.query(who, 'hr.payroll.run.thirteenth_month_preview', { runId: decRun.runId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(
        o.exec(who, 'hr.payroll.run.apply_thirteenth_month', {
          runId: decRun.runId,
          year: 2026,
          mode: 'replace',
          rows: [{ lineId: lineA.id, workedMonths: 12 }],
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(o.query(o.owner, 'hr.payroll.run.thirteenth_month_preview', { runId: decRun.runId })).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });
    await expect(
      o.exec(o.owner, 'hr.payroll.run.apply_thirteenth_month', {
        runId: decRun.runId,
        year: 2026,
        mode: 'replace',
        rows: [{ lineId: lineA.id, workedMonths: 12 }],
      }),
    ).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });

    const janRun = await o.open('2027-01');
    const janPreview = await o.query<HrThirteenthMonthPreviewResult>(o.owner, 'hr.payroll.run.thirteenth_month_preview', { runId: janRun.runId });
    expect(janPreview.year).toBe(2026);

    const adj = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.line.adjust', {
      runId: janRun.runId,
      adjustsRunId: decRun.runId,
      employeeId: empA.employeeId!,
      gross: '500000',
      note: 'Bổ sung',
    });
    await expect(
      o.exec(o.owner, 'hr.payroll.run.apply_thirteenth_month', {
        runId: janRun.runId,
        year: 2026,
        mode: 'replace',
        rows: [{ lineId: adj.lineId!, workedMonths: 12 }],
      }),
    ).rejects.toMatchObject({ code: 'HR_LINE_NOT_PAY' });
    await expect(
      o.exec(o.owner, 'hr.payroll.run.apply_thirteenth_month', {
        runId: janRun.runId,
        year: 2026,
        mode: 'replace',
        rows: [{ lineId: lineA.id, workedMonths: 12 }],
      }),
    ).rejects.toMatchObject({ code: 'HR_LINE_NOT_FOUND' });

    setRuleStatus('commentary');
  });

  it('computes statutory severance with derived 6-month wages, enforces <12 vs >=12 and erased refusals, and flags severance_check for Ly', async () => {
    setRuleStatus('confirmed');
    const o = await org();

    // Emp C: hired 2025-01-01 at 10M, raised 2026-09-01 to 16M; approved Sep/Oct with namedInContract 2M (+ non-contract meal 730k excluded).
    const empC = await o.hire('Lê Thu Hà Canary', '2025-01-01', '10000000');
    await o.exec(o.owner, 'hr.payroll.employment.add', {
      employeeId: empC.employeeId,
      effectiveFrom: '2026-09-01',
      contractType: 'indefinite',
      region: 'I',
      baseWage: '16000000',
    });
    // Emp D: hired 2026-08-01 at 12M (< 12 months worked).
    const empD = await o.hire('Phạm Văn Tùng Canary', '2026-08-01', '12000000');

    for (const month of ['2026-09', '2026-10']) {
      const r = await o.open(month);
      const s = await o.sheet(r.runId);
      const lineC = s.lines.find((l) => l.employeeId === empC.employeeId)!;
      await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
        lineId: lineC.id,
        inputs: {
          allowances: [
            { label: 'Phụ cấp chức vụ', type: 'other', amount: '2000000', namedInContract: true },
            { label: 'Ăn trưa', type: 'meal_cash', amount: '730000', namedInContract: false },
          ],
        },
      });
      const updated = await o.sheet(r.runId);
      await o.approve(r.runId, updated.fingerprint, true);
    }

    // Open draft Nov run (with draft namedInContract allowance on empC that must NOT count toward derived 6-month wages).
    const novRun = await o.open('2026-11');
    const novInitial = await o.sheet(novRun.runId);
    const novLineC = novInitial.lines.find((l) => l.employeeId === empC.employeeId)!;
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: novLineC.id,
      inputs: {
        allowances: [{ label: 'Thử nghiệm nháp', type: 'other', amount: '5000000', namedInContract: true }],
      },
    });

    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empC.employeeId, endedOn: '2026-11-20' });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empD.employeeId, endedOn: '2026-11-30' });

    // 1. Eligible >= 12 months with derived 6-month wages (May..Oct 2026: four 10M + two 18M -> avg 12,666,666.6667, 1.5 yrs -> 9,500,000).
    const sevC = await o.query<HrEmployeeSeveranceResult>(o.admin, 'hr.payroll.employee.severance', {
      employeeId: empC.employeeId,
      unemploymentInsuredMonths: 4,
      paidAmount: '20000000',
    });
    expect(sevC).toMatchObject({
      employeeId: empC.employeeId,
      status: 'ended',
      hireDate: '2025-01-01',
      endedOn: '2026-11-20',
      totalWorkedMonths: 22,
      unemploymentInsuredMonths: 4,
      priorSettledMonths: 0,
      sixMonthWages: ['10000000', '10000000', '10000000', '10000000', '18000000', '18000000'],
      qualifyingMonths: 18,
      qualifyingYears: '1.5',
      eligible: true,
      reason: null,
      amount: '9500000',
      pitExemptAmount: '9500000',
      taxableExcess: '10500000',
    });
    expect(sevC.rulesUsed.some((r) => r.id.startsWith('severance.'))).toBe(true);

    // 2. Ineligible < 6 & < 12 months: sixMonthWages length = 4.
    const sevD = await o.query<HrEmployeeSeveranceResult>(o.owner, 'hr.payroll.employee.severance', {
      employeeId: empD.employeeId,
    });
    expect(sevD).toMatchObject({
      totalWorkedMonths: 4,
      sixMonthWages: ['12000000', '12000000', '12000000', '12000000'],
      eligible: false,
      reason: 'worked_under_12_months',
      amount: '0',
    });

    // 3. Overridden totalWorkedMonths reaching before hireDate falls back to earliest base_wage and keeps length 6.
    const sevDOverride = await o.query<HrEmployeeSeveranceResult>(o.owner, 'hr.payroll.employee.severance', {
      employeeId: empD.employeeId,
      totalWorkedMonths: 14,
    });
    expect(sevDOverride.sixMonthWages).toHaveLength(6);
    expect(sevDOverride.sixMonthWages).toEqual(['12000000', '12000000', '12000000', '12000000', '12000000', '12000000']);
    expect(sevDOverride.eligible).toBe(true);

    // 4. 0-month preview still obeys sixMonthWages length 1, and endedOn before hireDate returns HR_END_BEFORE_START.
    const empE = await o.hire('Vũ Thị Hoa Canary', '2026-11-01', '9000000');
    const sevEZero = await o.query<HrEmployeeSeveranceResult>(o.owner, 'hr.payroll.employee.severance', {
      employeeId: empE.employeeId,
      endedOn: '2026-11-15',
    });
    expect(sevEZero.totalWorkedMonths).toBe(0);
    expect(sevEZero.sixMonthWages).toEqual(['9000000']);
    await expect(
      o.query(o.owner, 'hr.payroll.employee.severance', { employeeId: empE.employeeId, endedOn: '2026-10-31' }),
    ).rejects.toMatchObject({ code: 'HR_END_BEFORE_START' });

    // 5. Non-managers refused (403) and erased employees refused (HR_EMPLOYEE_ERASED, 409).
    for (const who of [o.member, o.viewer]) {
      await expect(o.query(who, 'hr.payroll.employee.severance', { employeeId: empC.employeeId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    const oldEmp = await o.hire('Cụ Đặng Văn An Canary', '2005-01-01', '5000000');
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: oldEmp.employeeId, endedOn: '2010-01-01' });
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: oldEmp.employeeId }, asMfa(o.owner));
    await expect(o.query(o.owner, 'hr.payroll.employee.severance', { employeeId: oldEmp.employeeId })).rejects.toMatchObject({
      code: 'HR_EMPLOYEE_ERASED',
      status: 409,
    });

    // 6. runSheet emits 'severance_check' only for empC (>= 12 months), and Ly prepareMonth surfaces 'severance_check' with AI off.
    const novSheet = await o.sheet(novRun.runId);
    const sheetLineC = novSheet.lines.find((l) => l.employeeId === empC.employeeId)!;
    const sheetLineD = novSheet.lines.find((l) => l.employeeId === empD.employeeId)!;
    expect(sheetLineC.flags).toContain('ends_this_month');
    expect(sheetLineC.flags).toContain('severance_check');
    expect(sheetLineD.flags).toContain('ends_this_month');
    expect(sheetLineD.flags).not.toContain('severance_check');

    const runsList = await o.query<HrRunSummary[]>(o.owner, 'hr.payroll.run.list', {});
    const reads: PayrollReads = {
      sheet: async (id) => o.sheet(id),
      runs: async () => runsList,
      payslip: async (lineId) => o.query(o.owner, 'hr.payroll.line.payslip', { lineId }),
    };
    const prepared = await prepareMonth({ reader: null, budget: new DraftBudget() }, reads, o.orgId, o.owner, novRun.runId, 'vi');
    expect(prepared.ai).toBe('off');
    const sevSignals = prepared.items.filter((i) => i.kind === 'severance_check');
    expect(sevSignals).toHaveLength(1);
    expect(sevSignals[0]).toMatchObject({
      employeeId: empC.employeeId,
      kind: 'severance_check',
      text: null,
    });
    expect(sevSignals[0]?.facts).toContain('Lê Thu Hà Canary');
    expect(sevSignals[0]?.facts).toContain('12');

    expect((await o.audits('hr.payroll.employee.severance')).length).toBeGreaterThanOrEqual(4);
    setRuleStatus('commentary');
  });
});

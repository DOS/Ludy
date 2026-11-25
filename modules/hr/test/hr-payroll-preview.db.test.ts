// SPDX-License-Identifier: AGPL-3.0-only
// Continuous payroll fluctuation preview & What-Changed diff tests (#4445, Stage 5E):
// covers pure diff/reason/decimal.js math unit tests and full PG17 DB integration tests
// for draft runs, projected snapshots, finalized runs, multi-entity isolation, erased employee
// masking, commentary approval gates remaining intact, strict HR-only RBAC, MODULE_OFF, and
// wage/PII-free sensitive read audit rows.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelManifest, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  HR_ERASED_NAME,
  zHrPayrollInputs,
  type HrAdjustmentActionResult,
  type HrLeaveWritten,
  type HrPayrollPreviewDiff,
  type HrRunSheet,
  type HrRunWritten,
  type HrSelfAdvanceSubmitResult,
  type HrWritten,
  type LegalEntity,
} from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { PAYROLL_RULES, money, toMoney } from '@ludy/l10n-vn';
import {
  computePayrollDiff,
  hrCommands,
  hrManifest,
  hrQueries,
  type PreviewEmploymentMeta,
  type PreviewPeriodSnapshot,
  type PreviewSourceLine,
} from '../src/index.ts';

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

type PoolHandle = ReturnType<typeof createPool>;

function makeSourceLine(overrides: Partial<PreviewSourceLine> & { employeeId: string }): PreviewSourceLine {
  return {
    employmentId: 'emp-term-1',
    kind: 'pay',
    status: 'calculated',
    inputs: zHrPayrollInputs.parse({}),
    figures: {
      gross: '20000000',
      employeeInsurance: '2100000',
      employerInsurance: '4300000',
      unionFee: '400000',
      taxableIncome: '20000000',
      pit: '300000',
      net: '17600000',
      employerCost: '24700000',
    },
    breakdown: { baseWage: '20000000', dependentsCounted: 0, taxMode: 'progressive' },
    hasFlags: false,
    ...overrides,
  };
}

function makeSnapshot(
  month: string,
  lines: PreviewSourceLine[],
  opts?: {
    runId?: string | null;
    status?: 'draft' | 'approved' | 'paid' | 'closed' | null;
    employments?: Map<string, PreviewEmploymentMeta>;
  },
): PreviewPeriodSnapshot {
  const employments =
    opts?.employments ??
    new Map<string, PreviewEmploymentMeta>([
      ['emp-term-1', { id: 'emp-term-1', baseWage: '20000000', payBasis: 'monthly', hourlyRate: null, pieceRate: null }],
    ]);
  return {
    runInfo: {
      runId: opts?.runId ?? null,
      month,
      status: opts?.status ?? null,
      approvedAt: null,
      headcount: new Set(lines.map((l) => l.employeeId)).size,
      refusedCount: lines.filter((l) => l.status === 'refused').length,
      flaggedCount: lines.filter((l) => l.hasFlags).length,
    },
    workingDays: '26',
    lines,
    employments,
  };
}

describe('computePayrollDiff pure unit tests (#4445)', () => {
  it('reconciles decimal.js figures and avoids false reason tag noise on plain raises or leave', () => {
    const prior = makeSnapshot(
      '2026-09',
      [
        makeSourceLine({ employeeId: 'e1' }), // plain salary raise
        makeSourceLine({ employeeId: 'e2' }), // plain unpaid leave (also with fixed allowance)
        makeSourceLine({ employeeId: 'e3' }), // terminated before next month
        makeSourceLine({ employeeId: 'e4' }), // unchanged
      ].map((line) =>
        line.employeeId === 'e2'
          ? {
              ...line,
              inputs: zHrPayrollInputs.parse({
                allowances: [{ label: 'Ăn trưa', type: 'meal_cash', amount: '730000', namedInContract: false }],
              }),
            }
          : line,
      ),
      { runId: 'run-sep', status: 'approved' },
    );

    const employments = new Map<string, PreviewEmploymentMeta>([
      ['emp-term-1', { id: 'emp-term-1', baseWage: '20000000', payBasis: 'monthly', hourlyRate: null, pieceRate: null }],
      ['emp-term-2', { id: 'emp-term-2', baseWage: '25000000', payBasis: 'monthly', hourlyRate: null, pieceRate: null }],
    ]);

    const current = makeSnapshot(
      '2026-10',
      [
        // e1: salary raise 20M -> 25M scales insurance & PIT automatically -> ONLY salary_change (no noisy deduction_change)
        makeSourceLine({
          employeeId: 'e1',
          employmentId: 'emp-term-2',
          figures: {
            gross: '25000000',
            employeeInsurance: '2625000',
            employerInsurance: '5375000',
            unionFee: '500000',
            taxableIncome: '25000000',
            pit: '750000',
            net: '21625000',
            employerCost: '30875000',
          },
          breakdown: { baseWage: '25000000', dependentsCounted: 0, taxMode: 'progressive' },
        }),
        // e2: unpaid leave 2 days while allowance input stayed identical -> ONLY leave_change (no noisy allowance_change)
        makeSourceLine({
          employeeId: 'e2',
          inputs: zHrPayrollInputs.parse({
            unpaidLeaveDays: '2',
            allowances: [{ label: 'Ăn trưa', type: 'meal_cash', amount: '730000', namedInContract: false }],
          }),
          figures: {
            gross: '18461538',
            employeeInsurance: '2100000',
            employerInsurance: '4300000',
            unionFee: '400000',
            taxableIncome: '18461538',
            pit: '200000',
            net: '16161538',
            employerCost: '23161538',
          },
        }),
        // e4: unchanged + e5: new hire
        makeSourceLine({ employeeId: 'e4' }),
        makeSourceLine({ employeeId: 'e5' }),
      ],
      { runId: 'run-oct', status: 'draft', employments },
    );

    const employees = new Map([
      ['e1', { displayName: 'Nguyễn Văn An', erased: false }],
      ['e2', { displayName: 'Trần Thị Bình', erased: false }],
      ['e3', { displayName: 'Lê Cựu Nhân Viên', erased: true }],
      ['e4', { displayName: 'Phạm Ổn Định', erased: false }],
      ['e5', { displayName: 'Võ Tân Binh', erased: false }],
    ]);

    const diffDefault = computePayrollDiff({
      mode: 'draft_run',
      legalEntityId: 'entity-1',
      legalEntityName: 'Công ty Thử Nghiệm',
      month: '2026-10',
      current,
      prior,
      employees,
      includeUnchanged: false,
    });

    expect(diffDefault.unchangedCount).toBe(1);
    expect(diffDefault.rows.map((r) => r.employeeId)).not.toContain('e4');
    expect(diffDefault.rows).toHaveLength(4);

    // Reconciliation invariants via decimal.js
    const d = diffDefault.deltas;
    expect(d.headcountDelta).toBe(0); // 4 current - 4 prior
    expect(toMoney(money(d.grossDelta).minus(money(d.employeeDeductionDelta)))).toBe(d.netDelta);
    expect(toMoney(money(d.grossDelta).plus(money(d.employerStatutoryDelta)))).toBe(d.employerCostDelta);
    expect(
      toMoney(money(d.employeeInsuranceDelta).plus(money(d.pitDelta)).plus(money(d.otherDeductionDelta))),
    ).toBe(d.employeeDeductionDelta);

    const row1 = diffDefault.rows.find((r) => r.employeeId === 'e1')!;
    expect(row1.reasons).toEqual(['salary_change']);
    expect(row1.grossDelta).toBe('5000000');
    expect(row1.employeeDeductionDelta).toBe('975000');
    expect(row1.netDelta).toBe('4025000');

    const row2 = diffDefault.rows.find((r) => r.employeeId === 'e2')!;
    expect(row2.reasons).toEqual(['leave_change']);
    expect(row2.currentLeaveDays).toBe('2');

    const row3 = diffDefault.rows.find((r) => r.employeeId === 'e3')!;
    expect(row3.reasons).toEqual(['terminated']);
    expect(row3.erased).toBe(true);
    expect(row3.employeeName).toBe(HR_ERASED_NAME);
    expect(row3.current).toBeNull();

    const row5 = diffDefault.rows.find((r) => r.employeeId === 'e5')!;
    expect(row5.reasons).toEqual(['new_hire']);
    expect(row5.prior).toBeNull();

    const diffWithUnchanged = computePayrollDiff({
      mode: 'draft_run',
      legalEntityId: 'entity-1',
      legalEntityName: 'Công ty Thử Nghiệm',
      month: '2026-10',
      current,
      prior,
      employees,
      includeUnchanged: true,
    });
    expect(diffWithUnchanged.rows).toHaveLength(5);
    const row4 = diffWithUnchanged.rows.find((r) => r.employeeId === 'e4')!;
    expect(row4.changed).toBe(false);
    expect(row4.reasons).toEqual([]);
  });

  it('aggregates adjustment lines with pay lines, tracks refused lines, and tags allowance/deduction changes', () => {
    const prior = makeSnapshot(
      '2026-09',
      [makeSourceLine({ employeeId: 'e1' }), makeSourceLine({ employeeId: 'e2' })],
      { runId: 'run-sep', status: 'approved' },
    );
    const current = makeSnapshot(
      '2026-10',
      [
        // e1 has allowance + advance deduction + prior-month adjustment line
        makeSourceLine({
          employeeId: 'e1',
          inputs: zHrPayrollInputs.parse({
            advance: '1000000',
            allowances: [{ label: 'Xăng xe', type: 'other', amount: '500000', namedInContract: false }],
          }),
          figures: {
            gross: '20500000',
            employeeInsurance: '2100000',
            employerInsurance: '4300000',
            unionFee: '400000',
            taxableIncome: '20500000',
            pit: '350000',
            net: '17050000',
            employerCost: '25200000',
          },
        }),
        makeSourceLine({
          employeeId: 'e1',
          kind: 'adjustment',
          figures: {
            gross: '500000',
            employeeInsurance: '0',
            employerInsurance: '0',
            unionFee: '0',
            taxableIncome: '500000',
            pit: '50000',
            net: '450000',
            employerCost: '500000',
          },
          breakdown: null,
        }),
        // e2 becomes refused
        makeSourceLine({
          employeeId: 'e2',
          status: 'refused',
          figures: null,
          hasFlags: true,
        }),
      ],
      { runId: 'run-oct', status: 'draft' },
    );
    const diff = computePayrollDiff({
      mode: 'draft_run',
      legalEntityId: 'entity-1',
      legalEntityName: 'Công ty Thử Nghiệm',
      month: '2026-10',
      current,
      prior,
      employees: new Map([
        ['e1', { displayName: 'Nhân viên 1', erased: false }],
        ['e2', { displayName: 'Nhân viên 2', erased: false }],
      ]),
      includeUnchanged: false,
    });
    const r1 = diff.rows.find((r) => r.employeeId === 'e1')!;
    expect(r1.reasons).toEqual(['salary_change', 'allowance_change', 'deduction_change']);
    expect(r1.current?.gross).toBe('21000000');
    expect(r1.current?.otherDeductions).toBe('1000000');
    expect(r1.grossDelta).toBe('1000000');
    expect(r1.otherDeductionDelta).toBe('1000000');

    const r2 = diff.rows.find((r) => r.employeeId === 'e2')!;
    expect(r2.hasRefused).toBe(true);
    expect(r2.current).toBeNull();
    expect(r2.grossDelta).toBe('-20000000');
  });

  it('emits dedicated retro_pay and offset_deduction reasons without noisy deduction_change false positives (#4597)', () => {
    const prior = makeSnapshot(
      '2026-09',
      [makeSourceLine({ employeeId: 'e1' }), makeSourceLine({ employeeId: 'e2' }), makeSourceLine({ employeeId: 'e3' })],
      { runId: 'run-sep', status: 'approved' },
    );
    const current = makeSnapshot(
      '2026-10',
      [
        // e1: retro pay only -> retro_pay without false salary_change or deduction_change
        makeSourceLine({
          employeeId: 'e1',
          inputs: zHrPayrollInputs.parse({ retroPay: '800000' }),
          figures: {
            gross: '20800000',
            employeeInsurance: '2100000',
            employerInsurance: '4300000',
            unionFee: '400000',
            taxableIncome: '20800000',
            pit: '380000',
            net: '18320000',
            employerCost: '25500000',
          },
        }),
        // e2: offset deduction only -> offset_deduction without noisy deduction_change
        makeSourceLine({
          employeeId: 'e2',
          inputs: zHrPayrollInputs.parse({ offsetDeduction: '250000' }),
          figures: {
            gross: '20000000',
            employeeInsurance: '2100000',
            employerInsurance: '4300000',
            unionFee: '400000',
            taxableIncome: '20000000',
            pit: '300000',
            net: '17350000',
            employerCost: '24700000',
          },
        }),
        // e3: salary advance + offset deduction -> both deduction_change and offset_deduction
        makeSourceLine({
          employeeId: 'e3',
          inputs: zHrPayrollInputs.parse({ advance: '500000', offsetDeduction: '200000' }),
          figures: {
            gross: '20000000',
            employeeInsurance: '2100000',
            employerInsurance: '4300000',
            unionFee: '400000',
            taxableIncome: '20000000',
            pit: '300000',
            net: '16900000',
            employerCost: '24700000',
          },
        }),
      ],
      { runId: null, status: null },
    );
    const diff = computePayrollDiff({
      mode: 'projected',
      legalEntityId: 'entity-1',
      legalEntityName: 'Công ty Thử Nghiệm',
      month: '2026-10',
      current,
      prior,
      employees: new Map([
        ['e1', { displayName: 'Nhân viên 1', erased: false }],
        ['e2', { displayName: 'Nhân viên 2', erased: false }],
        ['e3', { displayName: 'Nhân viên 3', erased: false }],
      ]),
      includeUnchanged: false,
    });
    expect(diff.rows.find((r) => r.employeeId === 'e1')?.reasons).toEqual(['retro_pay']);
    expect(diff.rows.find((r) => r.employeeId === 'e2')?.reasons).toEqual(['offset_deduction']);
    expect(diff.rows.find((r) => r.employeeId === 'e3')?.reasons).toEqual(['deduction_change', 'offset_deduction']);
  });
});

suite('hr.payroll.preview_diff on PostgreSQL 17 (#4445)', () => {
  const dbName = `ludy_test_hr_preview_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: PoolHandle;
  let appPool: PoolHandle;
  let rt: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function setupOrg(namePrefix: string) {
    const tag = randomUUID().slice(0, 8);
    const person = (role: string) =>
      upsertIdentity(createDb(appPool), {
        issuer: 'hr-preview',
        subject: `${role}-${tag}`,
        email: `${role}-${tag}@hr.test`,
        name: null,
      });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const created = await createOrg(rt, asUser(owner), `${namePrefix} ${tag}`);
    const orgId = created.orgId;
    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
      [orgId, admin, member, viewer],
    );
    await adminPool.query(
      `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, granted_by)
       VALUES ($1, $2, 'finance.chief_accountant', $3)`,
      [orgId, member, owner],
    );

    const exec = <O>(
      userId: string,
      name: string,
      input: unknown = {},
      actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId),
    ) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });
    const hire = (name: string, effectiveFrom: string, baseWage: string, legalEntityId?: string) =>
      exec<HrWritten>(owner, 'hr.payroll.employee.add', {
        displayName: name,
        ...(legalEntityId ? { legalEntityId } : {}),
        employment: { effectiveFrom, contractType: 'indefinite', region: 'I', baseWage },
      });
    const open = (month: string, legalEntityId?: string) =>
      exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month, ...(legalEntityId ? { legalEntityId } : {}) });
    const sheet = (runId: string) => query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId });
    const approve = (runId: string, fingerprint: string, acceptFlags = false) =>
      exec<HrRunWritten>(owner, 'hr.payroll.run.approve', { runId, fingerprint, acceptFlags }, asMfa(owner));

    return { orgId, owner, admin, member, viewer, exec, query, hire, open, sheet, approve };
  }

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1, resetOnRelease: false });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    adminPool = createPool({ connectionString: adminUrl, max: 2, resetOnRelease: false });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    appPool = createPool({ connectionString: appUrl.toString(), max: 4 });

    rt = new Runtime(createDb(appPool), {
      manifests: [kernelManifest.tables, hrManifest.tables],
      subjectVault: new SubjectVault(new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]).deriveKeys(SUBJECT_WRAP_INFO)),
      readAuditKey: randomBytes(32),
    }).register({
      commands: [...kernelCommands, ...hrCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries],
    });
  }, 240_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = createPool({ connectionString: ADMIN, max: 1, resetOnRelease: false });
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('compares projected, draft, and finalized runs across entities while enforcing commentary gate, masking, RBAC, MODULE_OFF, and clean audit', async () => {
    setRuleStatus('commentary');
    try {
      const orgA = await setupOrg('Công ty preview');
      const orgB = await setupOrg('Công ty khác');

      // Primary legal entity hires
      const empAn = await orgA.hire('Nguyễn Văn An Canary', '2026-01-01', '20000000');
      const empBinh = await orgA.hire('Trần Thị Bình Canary', '2026-01-01', '15000000');
      const empCu = await orgA.hire('Lê Văn Cũ Canary', '2025-01-01', '12000000');
      const empOnDinh = await orgA.hire('Phạm Ổn Định Canary', '2026-01-01', '18000000');

      // Secondary legal entity with an approved 2026-10 run (must NEVER interfere with primary entity's prior!)
      const branch = await orgA.exec<LegalEntity>(orgA.owner, 'kernel.legal_entity.create', {
        name: 'Chi nhánh Đà Nẵng',
        kind: 'branch',
        taxCode: null,
        parentId: null,
      });
      await orgA.hire('Nhân Sự Chi Nhánh', '2026-01-01', '14000000', branch.id);
      const branchSep = await orgA.open('2026-09', branch.id);

      // 1. Open primary Sep 2026 run (first month -> prior is null, all hires tagged new_hire).
      const runSep = await orgA.open('2026-09');
      const sepSheet = await orgA.sheet(runSep.runId);
      const sepPreview = await orgA.query<HrPayrollPreviewDiff>(orgA.owner, 'hr.payroll.preview_diff', {
        runId: runSep.runId,
      });
      expect(sepPreview.mode).toBe('draft_run');
      expect(sepPreview.prior).toBeNull();
      expect(sepPreview.priorTotals).toBeNull();
      expect(sepPreview.deltas.headcountDelta).toBe(4);
      expect(sepPreview.deltas.grossDelta).toBe(sepPreview.totals.gross);
      expect(sepPreview.rows.every((r) => r.reasons.includes('new_hire'))).toBe(true);

      // 2. Preview works in commentary mode, AND #2535 commentary gate on runApprove remains strictly enforced!
      await expect(orgA.approve(runSep.runId, sepSheet.fingerprint, true)).rejects.toMatchObject({
        code: 'HR_RULES_COMMENTARY',
        status: 422,
      });

      setRuleStatus('confirmed');
      await orgA.approve(runSep.runId, sepSheet.fingerprint, true);
      const branchSepSheet = await orgA.sheet(branchSep.runId);
      await orgA.approve(branchSep.runId, branchSepSheet.fingerprint, true);
      const branchOct = await orgA.open('2026-10', branch.id);
      const branchOctSheet = await orgA.sheet(branchOct.runId);
      await orgA.approve(branchOct.runId, branchOctSheet.fingerprint, true);

      // 3. Prepare Oct 2026 changes BEFORE opening Oct run -> test zero-write `projected` snapshot!
      // - Raise An 20M -> 24M
      await orgA.exec(orgA.owner, 'hr.payroll.employment.add', {
        employeeId: empAn.employeeId,
        effectiveFrom: '2026-10-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '24000000',
      });
      // - End + erase Cũ (must disappear from Oct and show masked HR_ERASED_NAME as terminated)
      await orgA.exec(orgA.owner, 'hr.payroll.employee.end', { employeeId: empCu.employeeId, endedOn: '2026-09-25' });
      await adminPool.query(
        `UPDATE ludy_hr.payroll_employee
         SET ended_on = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date
         WHERE org_id = $1 AND id = $2`,
        [orgA.orgId, empCu.employeeId],
      );
      await orgA.exec(orgA.owner, 'hr.payroll.employee.erase', { employeeId: empCu.employeeId }, asMfa(orgA.owner));
      // - Hire Dương in Oct
      const empDuong = await orgA.hire('Hoàng Văn Dương Canary', '2026-10-01', '16000000');
      // - Set approved unpaid leave (2 days) on Bình in Oct ledger
      await orgA.exec<HrLeaveWritten>(orgA.owner, 'hr.payroll.leave.set', {
        employeeId: empBinh.employeeId,
        month: '2026-10',
        kind: 'unpaid_leave',
        days: '2',
        approved: true,
      });

      // - Link member user to empAn and submit a PENDING leave request -> must NOT alter projected snapshot until approved!
      await adminPool.query(
        `UPDATE ludy_hr.payroll_employee SET user_id = $1 WHERE org_id = $2 AND id = $3`,
        [orgA.member, orgA.orgId, empAn.employeeId],
      );
      const pendingLeave = await orgA.exec<{ requestId: string }>(orgA.member, 'hr.self.leave.request_submit', {
        startOn: '2026-10-12',
        endOn: '2026-10-14',
        kind: 'unpaid_leave',
        days: '3',
        reason: 'Việc riêng',
      });
      expect(pendingLeave.requestId).toBeTruthy();

      const runsBeforeProjected = await adminPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ludy_hr.payroll_run WHERE org_id = $1`,
        [orgA.orgId],
      );

      const projectedOct = await orgA.query<HrPayrollPreviewDiff>(orgA.admin, 'hr.payroll.preview_diff', {
        month: '2026-10',
      });
      const runsAfterProjected = await adminPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM ludy_hr.payroll_run WHERE org_id = $1`,
        [orgA.orgId],
      );
      expect(runsAfterProjected.rows[0]?.count).toBe(runsBeforeProjected.rows[0]?.count); // Zero DB writes!

      expect(projectedOct.mode).toBe('projected');
      expect(projectedOct.legalEntityId).toBe(sepPreview.legalEntityId);
      expect(projectedOct.prior?.runId).toBe(runSep.runId);
      expect(projectedOct.prior?.month).toBe('2026-09');
      expect(projectedOct.unchangedCount).toBe(1); // empOnDinh unchanged

      const projAn = projectedOct.rows.find((r) => r.employeeId === empAn.employeeId)!;
      expect(projAn.reasons).toEqual(['salary_change']); // pending leave ignored!
      expect(projAn.currentLeaveDays).toBe('0');

      const projBinh = projectedOct.rows.find((r) => r.employeeId === empBinh.employeeId)!;
      expect(projBinh.reasons).toEqual(['leave_change']);
      expect(projBinh.currentLeaveDays).toBe('2');

      const projCu = projectedOct.rows.find((r) => r.employeeId === empCu.employeeId)!;
      expect(projCu.reasons).toEqual(['terminated']);
      expect(projCu.erased).toBe(true);
      expect(projCu.employeeName).toBe(HR_ERASED_NAME);
      expect(JSON.stringify(projectedOct)).not.toContain('Lê Văn Cũ Canary');

      const projDuong = projectedOct.rows.find((r) => r.employeeId === empDuong.employeeId)!;
      expect(projDuong.reasons).toEqual(['new_hire']);

      // Approve the self-service leave request directly via final approval (no L1 manager assigned) -> now An's projected snapshot updates cleanly!
      await orgA.exec(orgA.owner, 'hr.leave_request.approve_final', { requestId: pendingLeave.requestId });
      const projectedOctAfterApprove = await orgA.query<HrPayrollPreviewDiff>(orgA.owner, 'hr.payroll.preview_diff', {
        month: '2026-10',
      });
      const projAnAfter = projectedOctAfterApprove.rows.find((r) => r.employeeId === empAn.employeeId)!;
      expect(projAnAfter.reasons).toEqual(['salary_change', 'leave_change']);
      expect(projAnAfter.currentLeaveDays).toBe('3');

      // 4. Open Oct draft run, add allowance + advance deduction on An, check `draft_run` + unchanged toggle.
      const runOct = await orgA.open('2026-10');
      const octSheet = await orgA.sheet(runOct.runId);
      const octLineAn = octSheet.lines.find((l) => l.employeeId === empAn.employeeId)!;
      await orgA.exec(orgA.owner, 'hr.payroll.line.inputs.set', {
        lineId: octLineAn.id,
        inputs: {
          advance: '1000000',
          allowances: [{ label: 'Ăn trưa', type: 'meal_cash', amount: '730000', namedInContract: false }],
        },
      });
      const draftOctDiff = await orgA.query<HrPayrollPreviewDiff>(orgA.owner, 'hr.payroll.preview_diff', {
        runId: runOct.runId,
        includeUnchanged: true,
      });
      expect(draftOctDiff.mode).toBe('draft_run');
      expect(draftOctDiff.prior?.runId).toBe(runSep.runId);
      expect(draftOctDiff.rows.find((r) => r.employeeId === empAn.employeeId)?.reasons).toEqual([
        'salary_change',
        'allowance_change',
        'deduction_change',
      ]);
      expect(draftOctDiff.rows.find((r) => r.employeeId === empOnDinh.employeeId)).toMatchObject({
        changed: false,
        reasons: [],
      });
      // Exact decimal reconciliation across org totals
      expect(toMoney(money(draftOctDiff.deltas.grossDelta).minus(money(draftOctDiff.deltas.employeeDeductionDelta)))).toBe(
        draftOctDiff.deltas.netDelta,
      );
      expect(toMoney(money(draftOctDiff.deltas.grossDelta).plus(money(draftOctDiff.deltas.employerStatutoryDelta)))).toBe(
        draftOctDiff.deltas.employerCostDelta,
      );

      // 5. While Oct is still `draft`, previewing Nov projected must skip draft Oct and still pick finalized Sep!
      const projectedNov = await orgA.query<HrPayrollPreviewDiff>(orgA.owner, 'hr.payroll.preview_diff', {
        month: '2026-11',
      });
      expect(projectedNov.prior?.runId).toBe(runSep.runId);

      // Approve Oct run and check finalized_run mode
      const octUpdatedSheet = await orgA.sheet(runOct.runId);
      await orgA.approve(runOct.runId, octUpdatedSheet.fingerprint, true);
      const finalizedOctDiff = await orgA.query<HrPayrollPreviewDiff>(orgA.owner, 'hr.payroll.preview_diff', {
        runId: runOct.runId,
      });
      expect(finalizedOctDiff.mode).toBe('finalized_run');
      expect(finalizedOctDiff.current.status).toBe('approved');
      expect(finalizedOctDiff.prior?.runId).toBe(runSep.runId);

      // 6. Strict HR-only RBAC (Finance-only chief_accountant `member` & `viewer` blocked 403), MODULE_OFF (404), cross-org (404), zero audit leaks.
      const countPreviewAudits = async () => {
        const res = await adminPool.query<{ c: string }>(
          `SELECT COUNT(*)::text AS c FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'hr.payroll.preview_diff'`,
          [orgA.orgId],
        );
        return Number(res.rows[0]?.c ?? 0);
      };
      const beforeBadCount = await countPreviewAudits();

      for (const blockedUser of [orgA.member, orgA.viewer]) {
        await expect(
          orgA.query(blockedUser, 'hr.payroll.preview_diff', { runId: runOct.runId }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
        await expect(
          orgA.query(blockedUser, 'hr.payroll.preview_diff', { month: '2026-10' }),
        ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      }
      expect(await countPreviewAudits()).toBe(beforeBadCount);

      await orgA.exec(orgA.owner, 'kernel.org.set_app', { module: 'hr', enabled: false });
      await expect(
        orgA.query(orgA.owner, 'hr.payroll.preview_diff', { runId: runOct.runId }),
      ).rejects.toMatchObject({ code: 'MODULE_OFF', status: 404 });
      expect(await countPreviewAudits()).toBe(beforeBadCount);
      await orgA.exec(orgA.owner, 'kernel.org.set_app', { module: 'hr', enabled: true });

      // Cross-org isolation: Org B owner cannot read Org A run or entity
      await expect(
        orgB.query(orgB.owner, 'hr.payroll.preview_diff', { runId: runOct.runId }),
      ).rejects.toMatchObject({ code: 'HR_RUN_NOT_FOUND', status: 404 });
      await expect(
        orgB.query(orgB.owner, 'hr.payroll.preview_diff', { legalEntityId: sepPreview.legalEntityId, month: '2026-10' }),
      ).rejects.toMatchObject({ code: 'HR_LEGAL_ENTITY_NOT_FOUND', status: 404 });

      // Allowed sensitive reads wrote safe before_read audit events with ZERO wages or employee names.
      const audits = await adminPool.query<{ detail: Record<string, unknown>; row_text: string }>(
        `SELECT detail, audit_event::text AS row_text FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'hr.payroll.preview_diff'`,
        [orgA.orgId],
      );
      expect(audits.rows.length).toBeGreaterThanOrEqual(5);
      for (const row of audits.rows) {
        expect(row.detail).toMatchObject({ read: 'sensitive', stage: 'before_read' });
        expect(row.row_text).not.toContain('Nguyễn Văn An Canary');
        expect(row.row_text).not.toContain('Trần Thị Bình Canary');
        expect(row.row_text).not.toContain('24000000');
        expect(row.row_text).not.toContain('20000000');
      }
    } finally {
      setRuleStatus('commentary');
    }
  });

  it('includes approved Stage 6B advances, retro_pay, and offset_deduction in projected preview with explicit diff reasons and zero writes (#4597)', async () => {
    setRuleStatus('confirmed');
    try {
      const org = await setupOrg('Công ty preview 6B');
      const empA = await org.hire('Nguyễn Văn A', '2026-01-01', '10000000');
      const empB = await org.hire('Trần Thị B', '2026-01-01', '10000000');
      await adminPool.query(
        `UPDATE ludy_hr.payroll_employee SET user_id = $1 WHERE org_id = $2 AND id = $3`,
        [org.member, org.orgId, empA.employeeId],
      );

      // Finalize 2026-09 baseline run.
      const runSep = await org.open('2026-09');
      const sepSheet = await org.sheet(runSep.runId);
      await org.approve(runSep.runId, sepSheet.fingerprint, true);

      // Submit PENDING Stage 6B items for 2026-10 -> projected preview must IGNORE pending rows!
      const pendingAdv = await org.exec<HrSelfAdvanceSubmitResult>(org.member, 'hr.self.salary_advance.submit', {
        month: '2026-10',
        amount: '500000',
        reason: 'Tạm ứng tháng 10',
      });
      const pendingRetro = await org.exec<HrAdjustmentActionResult>(org.admin, 'hr.payroll.adjustment.create', {
        employeeId: empA.employeeId,
        month: '2026-10',
        kind: 'retro_pay',
        amount: '800000',
        reason: 'Truy lĩnh tháng trước',
      });
      const pendingOffset = await org.exec<HrAdjustmentActionResult>(org.admin, 'hr.payroll.adjustment.create', {
        employeeId: empB.employeeId,
        month: '2026-10',
        kind: 'offset_deduction',
        amount: '200000',
        reason: 'Bù trừ tạm ứng công tác',
      });

      const beforeApprove = await org.query<HrPayrollPreviewDiff>(org.owner, 'hr.payroll.preview_diff', {
        month: '2026-10',
      });
      expect(beforeApprove.mode).toBe('projected');
      expect(beforeApprove.rows).toHaveLength(0);
      expect(beforeApprove.unchangedCount).toBe(2);

      // Approve all three Stage 6B items -> projected preview now reflects them with zero payroll_run writes.
      await org.exec(org.owner, 'hr.salary_advance.approve_final', { requestId: pendingAdv.requestId });
      await org.exec(org.owner, 'hr.payroll.adjustment.approve', { itemId: pendingRetro.itemId });
      await org.exec(org.owner, 'hr.payroll.adjustment.approve', { itemId: pendingOffset.itemId });

      const runsBefore = await adminPool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ludy_hr.payroll_run WHERE org_id = $1`,
        [org.orgId],
      );
      const afterApprove = await org.query<HrPayrollPreviewDiff>(org.owner, 'hr.payroll.preview_diff', {
        month: '2026-10',
      });
      const runsAfter = await adminPool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM ludy_hr.payroll_run WHERE org_id = $1`,
        [org.orgId],
      );
      expect(runsAfter.rows[0]?.c).toBe(runsBefore.rows[0]?.c);
      expect(afterApprove.mode).toBe('projected');
      expect(afterApprove.unchangedCount).toBe(0);

      const rowA = afterApprove.rows.find((r) => r.employeeId === empA.employeeId)!;
      expect(rowA.reasons).toEqual(['deduction_change', 'retro_pay']);
      expect(rowA.grossDelta).toBe('800000');
      expect(rowA.otherDeductionDelta).toBe('500000');

      const rowB = afterApprove.rows.find((r) => r.employeeId === empB.employeeId)!;
      expect(rowB.reasons).toEqual(['offset_deduction']);
      expect(rowB.grossDelta).toBe('0');
      expect(rowB.otherDeductionDelta).toBe('200000');
      expect(rowB.netDelta).toBe('-200000');

      expect(toMoney(money(afterApprove.deltas.grossDelta).minus(money(afterApprove.deltas.employeeDeductionDelta)))).toBe(
        afterApprove.deltas.netDelta,
      );
    } finally {
      setRuleStatus('commentary');
    }
  });
});

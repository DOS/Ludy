// SPDX-License-Identifier: AGPL-3.0-only
// Statutory job-loss allowance (Labor Code 2019 Art. 47) sensitive query tests on real PostgreSQL 17 (#4296).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelManifest, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  HrEmployeeJobLossResult,
  HrRunSheet,
  HrRunWritten,
  HrWritten,
} from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { PAYROLL_RULES } from '@ludy/l10n-vn';
import { hrCommands, hrManifest, hrQueries } from '../src/index.ts';

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

suite('hr.payroll.employee.job_loss sensitive query (#4296)', () => {
  const dbName = `ludy_test_hr_jobloss_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
        issuer: 'hr-job-loss',
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

    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });
    const hire = (name: string, effectiveFrom: string, baseWage: string) =>
      exec<HrWritten>(owner, 'hr.payroll.employee.add', {
        displayName: name,
        employment: { effectiveFrom, contractType: 'indefinite', region: 'I', baseWage },
      });
    const open = (month: string) => exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month });
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

  it('computes Art. 47 job-loss allowance with 6-month wage prefill, 2-month floor, access/org isolation, and wage-free audit', async () => {
    setRuleStatus('confirmed');
    try {
      const orgA = await setupOrg('Công ty Sao Mai');
      const orgB = await setupOrg('Công ty Bình Minh');

      // Emp A: hired 2024-01-01 at 10M, raised 2026-09-01 to 16M, + 2M namedInContract allowance in Sep/Oct approved runs.
      const empA = await orgA.hire('Lê Thu Hà Canary', '2024-01-01', '10000000');
      await orgA.exec(orgA.owner, 'hr.payroll.employment.add', {
        employeeId: empA.employeeId,
        effectiveFrom: '2026-09-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '16000000',
      });

      for (const month of ['2026-09', '2026-10']) {
        const r = await orgA.open(month);
        const s = await orgA.sheet(r.runId);
        const lineA = s.lines.find((l) => l.employeeId === empA.employeeId)!;
        await orgA.exec(orgA.owner, 'hr.payroll.line.inputs.set', {
          lineId: lineA.id,
          inputs: {
            allowances: [
              { label: 'Phụ cấp chức vụ', type: 'other', amount: '2000000', namedInContract: true },
              { label: 'Ăn trưa', type: 'meal_cash', amount: '730000', namedInContract: false },
            ],
          },
        });
        const updated = await orgA.sheet(r.runId);
        await orgA.approve(r.runId, updated.fingerprint, true);
      }

      // Open draft Nov run with namedInContract allowance that MUST NOT enter 6-month wages.
      const novRun = await orgA.open('2026-11');
      const novSheet = await orgA.sheet(novRun.runId);
      const novLineA = novSheet.lines.find((l) => l.employeeId === empA.employeeId)!;
      await orgA.exec(orgA.owner, 'hr.payroll.line.inputs.set', {
        lineId: novLineA.id,
        inputs: {
          allowances: [{ label: 'Thử nghiệm nháp', type: 'other', amount: '5000000', namedInContract: true }],
        },
      });

      await orgA.exec(orgA.owner, 'hr.payroll.employee.end', { employeeId: empA.employeeId, endedOn: '2026-11-20' });

      // 1. 0 qualifying months (all 34 months covered by BHTN) STILL receives the 2-month minimum floor!
      // Derived May..Oct 2026: four 10M + two 18M -> avg 12,666,666.6666... -> 2-month floor = 25,333,333.
      const zeroQualifying = await orgA.query<HrEmployeeJobLossResult>(orgA.admin, 'hr.payroll.employee.job_loss', {
        employeeId: empA.employeeId,
        terminationReason: 'organizational_restructuring',
        unemploymentInsuredMonths: 34,
        paidAmount: '30000000',
      });
      expect(zeroQualifying).toMatchObject({
        employeeId: empA.employeeId,
        status: 'ended',
        hireDate: '2024-01-01',
        endedOn: '2026-11-20',
        terminationReason: 'organizational_restructuring',
        totalWorkedMonths: 34,
        unemploymentInsuredMonths: 34,
        priorSettledMonths: 0,
        sixMonthWages: ['10000000', '10000000', '10000000', '10000000', '18000000', '18000000'],
        qualifyingMonths: 0,
        qualifyingYears: '0',
        eligible: true,
        reason: null,
        amount: '25333333',
        minimumFloorApplied: true,
        paidAmount: '30000000',
        pitExemptAmount: '25333333',
        taxableExcess: '4666667',
      });
      expect(zeroQualifying.rulesUsed.map((r) => r.id)).toEqual([
        'job_loss.labor_code_art47@2021-01-01',
        'job_loss.decree145_art8@2021-02-01',
        'severance.pit_exemption@2026-01-01',
      ]);

      // 2. Over 2 qualifying years (34 worked - 4 BHTN = 30 qualifying months -> 2.5 years) beats 2-month floor.
      // 2.5 * 12,666,666.6666... = 31,666,666.6666... -> 31,666,667.
      const overFloor = await orgA.query<HrEmployeeJobLossResult>(orgA.owner, 'hr.payroll.employee.job_loss', {
        employeeId: empA.employeeId,
        terminationReason: 'economic_reasons',
        unemploymentInsuredMonths: 4,
      });
      expect(overFloor).toMatchObject({
        qualifyingMonths: 30,
        qualifyingYears: '2.5',
        eligible: true,
        amount: '31666667',
        minimumFloorApplied: false,
      });

      // 3. Non-Art. 42/43 reason -> ineligible.
      const nonArt42 = await orgA.query<HrEmployeeJobLossResult>(orgA.owner, 'hr.payroll.employee.job_loss', {
        employeeId: empA.employeeId,
        terminationReason: 'other_non_art42_art43',
      });
      expect(nonArt42).toMatchObject({
        eligible: false,
        reason: 'not_job_loss_reason',
        amount: '0',
        minimumFloorApplied: false,
      });

      // 4. Short-tenure employee (< 12 months) -> worked_under_12_months and short wage history.
      const empB = await orgA.hire('Phạm Văn Tùng Canary', '2026-08-01', '12000000');
      const shortTenured = await orgA.query<HrEmployeeJobLossResult>(orgA.owner, 'hr.payroll.employee.job_loss', {
        employeeId: empB.employeeId,
        endedOn: '2026-11-30',
      });
      expect(shortTenured).toMatchObject({
        totalWorkedMonths: 4,
        sixMonthWages: ['12000000', '12000000', '12000000', '12000000'],
        eligible: false,
        reason: 'worked_under_12_months',
        amount: '0',
        minimumFloorApplied: false,
      });

      // 5. Access control & org isolation: member/viewer refused (403); orgB owner gets 404 (not_found).
      for (const who of [orgA.member, orgA.viewer]) {
        await expect(orgA.query(who, 'hr.payroll.employee.job_loss', { employeeId: empA.employeeId })).rejects.toMatchObject({
          code: 'FORBIDDEN',
          status: 403,
        });
      }
      await expect(orgB.query(orgB.owner, 'hr.payroll.employee.job_loss', { employeeId: empA.employeeId })).rejects.toMatchObject({
        code: 'HR_EMPLOYEE_NOT_FOUND',
        status: 404,
      });

      // 6. Ended before hire date -> HR_END_BEFORE_START (422); erased employee -> HR_EMPLOYEE_ERASED (409).
      await expect(
        orgA.query(orgA.owner, 'hr.payroll.employee.job_loss', { employeeId: empB.employeeId, endedOn: '2026-07-31' }),
      ).rejects.toMatchObject({ code: 'HR_END_BEFORE_START', status: 422 });

      const oldEmp = await orgA.hire('Cụ Đặng Văn An Canary', '2005-01-01', '5000000');
      await orgA.exec(orgA.owner, 'hr.payroll.employee.end', { employeeId: oldEmp.employeeId, endedOn: '2010-01-01' });
      await orgA.exec(orgA.owner, 'hr.payroll.employee.erase', { employeeId: oldEmp.employeeId }, asMfa(orgA.owner));
      await expect(orgA.query(orgA.owner, 'hr.payroll.employee.job_loss', { employeeId: oldEmp.employeeId })).rejects.toMatchObject({
        code: 'HR_EMPLOYEE_ERASED',
        status: 409,
      });

      // 7. Sensitive audit rows record IDs and safe termination_reason enum only, with ZERO wages or PII.
      const auditRes = await adminPool.query<{
        target_type: string;
        target_id: string;
        detail: Record<string, unknown>;
        row_text: string;
      }>(
        `SELECT target_type, target_id, detail, audit_event::text AS row_text
         FROM ludy_kernel.audit_event
         WHERE org_id = $1 AND command = 'hr.payroll.employee.job_loss'
         ORDER BY id`,
        [orgA.orgId],
      );
      expect(auditRes.rows.length).toBeGreaterThanOrEqual(4);
      expect(auditRes.rows[0]?.detail).toMatchObject({
        termination_reason: 'organizational_restructuring',
        read: 'sensitive',
        stage: 'before_read',
      });
      for (const row of auditRes.rows) {
        expect(row.target_type).toBe('hr.payroll_employee');
        expect(row.row_text).not.toContain('Lê Thu Hà Canary');
        expect(row.row_text).not.toContain('10000000');
        expect(row.row_text).not.toContain('18000000');
        expect(row.row_text).not.toContain('30000000');
        expect(row.row_text).not.toContain('25333333');
      }
    } finally {
      setRuleStatus('commentary');
    }
  });
});

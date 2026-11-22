// SPDX-License-Identifier: AGPL-3.0-only
// Stage 4B integration tests (#4301) on real PostgreSQL 17:
// 1. Hourly and piece-rate pay bases end-to-end (DB constraints, runtime commands, calculations, PDF).
// 2. Foreign workers: non-resident 20% flat PIT, BHTN exemption, sealed work permit (masked last-4 in get, omitted from list/export, shredded on erase), and work permit alerts.
// 3. Sickness & maternity BHXH leave ledger entries: balance totals, pay-run auto-seed & sync, manual override preservation, >=14d BHXH suspension, declarations, and Ly coworker checks.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  HrEmployee,
  HrEmployeeErased,
  HrEmployeeSummary,
  HrLeaveBalanceResult,
  HrLeaveWritten,
  HrPayslip,
  HrRunSheet,
  HrRunSummary,
  HrRunWritten,
  HrWritten,
} from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { PAYROLL_RULES } from '@ludy/l10n-vn';
import { hrCommands, hrQueries } from '@ludy/mod-hr';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { explainPayslip, flagMonth, type PayrollReads } from '../src/payroll-coworker-ai.ts';
import { TEST_MANIFESTS } from './manifests.ts';

vi.mock('@ludy/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ludy/l10n-vn')>();
  return { ...real, PAYROLL_RULES: real.PAYROLL_RULES.map((row) => ({ ...row })) };
});
const setRuleStatus = (status: 'confirmed' | 'commentary') => {
  for (const row of PAYROLL_RULES) (row as { status: string }).status = status;
};

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

function addDaysIso(baseIso: string, deltaDays: number): string {
  const [y, m, d] = baseIso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + deltaDays)).toISOString().slice(0, 10);
}

suite('HR Stage 4B payroll, foreign worker work permit, and BHXH leave (#4301)', () => {
  const dbName = `crove_test_hr4b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hr4b', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const member = await person('member');
    const { orgId } = await createOrg(rt, asUser(owner), `HR 4B ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, member]));
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    return { orgId, owner, member, exec, query };
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

  it('calculates hourly and piece-rate payroll end-to-end and enforces DB positive-rate checks', async () => {
    const o = await setupOrg();
    const hourlyEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Nguyễn Theo Giờ Canary',
      employment: {
        effectiveFrom: '2026-08-01',
        contractType: 'fixed_term',
        contractForm: 'electronic',
        termMonths: 12,
        region: 'I',
        payBasis: 'hourly',
        hourlyRate: '50000',
        baseWage: '0',
      },
    });
    const pieceEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Trần Khoán Sản Phẩm Canary',
      employment: {
        effectiveFrom: '2026-08-01',
        contractType: 'indefinite',
        region: 'I',
        payBasis: 'piece_rate',
        pieceRate: '25000',
        baseWage: '0',
      },
    });

    // Validation rejects missing positive hourly/piece rates AND sub-85% hourly probation rate; >=85% hourly probation passes.
    await expect(
      o.exec(o.owner, 'hr.payroll.employee.add', {
        displayName: 'Invalid Hourly',
        employment: { effectiveFrom: '2026-08-01', contractType: 'indefinite', region: 'I', payBasis: 'hourly', baseWage: '0' },
      }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      o.exec(o.owner, 'hr.payroll.employee.add', {
        displayName: 'Low Hourly Probation',
        employment: {
          effectiveFrom: '2026-08-01',
          contractType: 'indefinite',
          region: 'I',
          payBasis: 'hourly',
          hourlyRate: '50000',
          baseWage: '0',
          probationRoleTier: 'college_or_above',
          probationEndOn: '2026-08-30',
          probationWage: '40000',
        },
      }),
    ).rejects.toMatchObject({ code: 'HR_CONTRACT_INVALID', status: 422 });
    const hourlyProbEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Valid Hourly Probation Canary',
      employment: {
        effectiveFrom: '2026-08-01',
        contractType: 'indefinite',
        region: 'I',
        payBasis: 'hourly',
        hourlyRate: '50000',
        baseWage: '0',
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-08-30',
        probationWage: '42500',
      },
    });
    expect(hourlyProbEmp.employeeId).toBeTruthy();

    await expect(
      withAdmin((c) =>
        c.query(
          `INSERT INTO crove_hr.payroll_employment (org_id, legal_entity_id, employee_id, effective_from, contract_type, region, base_wage, pay_basis, hourly_rate)
           SELECT org_id, legal_entity_id, employee_id, '2026-09-01', 'indefinite', 'I', 0, 'hourly', 0 FROM crove_hr.payroll_employment WHERE id = $1`,
          [hourlyEmp.employmentId],
        ),
      ),
    ).rejects.toThrow(/payroll_employment_hourly_rate_required_ck/);

    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-08' });
    const initialSheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const hourlyLine = initialSheet.lines.find((l) => l.employeeId === hourlyEmp.employeeId)!;
    const pieceLine = initialSheet.lines.find((l) => l.employeeId === pieceEmp.employeeId)!;

    // Newly opened hourly and piece-rate lines start refused until workedHours / pieceCount are entered.
    expect(hourlyLine.status).toBe('refused');
    expect(hourlyLine.inputs.workedHours).toBeNull();
    expect(pieceLine.status).toBe('refused');
    expect(pieceLine.inputs.pieceCount).toBeNull();
    await expect(
      o.exec(o.owner, 'hr.payroll.run.approve', { runId: run.runId, fingerprint: initialSheet.fingerprint }, asMfa(o.owner)),
    ).rejects.toMatchObject({ code: 'HR_RUN_HAS_REFUSED', status: 422 });

    // Explicitly entering '0' clears the refusal and calculates 0 gross cleanly.
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: hourlyLine.id,
      inputs: { workedHours: '0' },
    });
    const zeroHourlySheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const zeroHourly = zeroHourlySheet.lines.find((l) => l.employeeId === hourlyEmp.employeeId)!;
    expect(zeroHourly.status).toBe('calculated');
    expect(zeroHourly.figures?.gross).toBe('0.00');

    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: hourlyLine.id,
      inputs: { workedHours: '160', overtime: [{ dayKind: 'normal_day', night: false, hours: '10' }] },
    });
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: pieceLine.id,
      inputs: { pieceCount: '500' },
    });

    const sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const updatedHourly = sheet.lines.find((l) => l.employeeId === hourlyEmp.employeeId)!;
    const updatedPiece = sheet.lines.find((l) => l.employeeId === pieceEmp.employeeId)!;

    // 160h * 50,000 = 8,000,000 base; 10h * 50,000 * 1.5 = 750,000 OT -> gross 8,750,000.
    expect((updatedHourly.breakdown as { pay: { baseWage: string; hourlyRate: string } }).pay.baseWage).toBe('8000000');
    expect((updatedHourly.breakdown as { pay: { hourlyRate: string } }).pay.hourlyRate).toBe('50000');
    expect(updatedHourly.figures?.gross).toBe('8750000.00');
    expect(updatedHourly.checks.find((c) => c.id === 'minimum_wage')?.ok).toBe(true);

    // 500 units * 25,000 = 12,500,000 gross; meets Region I monthly minimum wage.
    expect((updatedPiece.breakdown as { pay: { baseWage: string } }).pay.baseWage).toBe('12500000');
    expect(updatedPiece.figures?.gross).toBe('12500000.00');
    expect(updatedPiece.checks.find((c) => c.id === 'minimum_wage')?.ok).toBe(true);

    // Partial line edit preserves previously entered workedHours (#4301):
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', { lineId: hourlyLine.id, inputs: { bonus: '100000' } });
    const bonusSheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const hourlyAfterBonus = bonusSheet.lines.find((l) => l.employeeId === hourlyEmp.employeeId)!;
    expect(hourlyAfterBonus.inputs.workedHours).toBe('160');
    expect(hourlyAfterBonus.inputs.bonus).toBe('100000');
    // 160h * 50,000 + 100,000 bonus = 8,100,000.00 (omitted overtime defaults to []).
    expect(hourlyAfterBonus.figures?.gross).toBe('8100000.00');

    const detail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: hourlyEmp.employeeId });
    expect(detail.current?.payBasis).toBe('hourly');
    expect(detail.current?.hourlyRate).toBe('50000.00');
    expect(detail.current?.taxResident).toBe(true);

    const pdf = await o.query<{ contentType: string; pdfBase64: string }>(o.owner, 'hr.employee.contract_pdf', {
      employeeId: hourlyEmp.employeeId,
      termsId: hourlyEmp.employmentId!,
    });
    expect(pdf.contentType).toBe('application/pdf');
    expect(Buffer.from(pdf.pdfBase64, 'base64').subarray(0, 5).toString('utf8')).toBe('%PDF-');
  });

  it('tracks foreign workers: non-resident 20% PIT, BHTN exemption, masked permit, alerts, erasure, and export omission', async () => {
    const o = await setupOrg();
    const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
    const soonDate = addDaysIso(today, 12);
    const pastDate = addDaysIso(today, -5);
    const PERMIT_RAW = 'GP2026-9876';

    const expSoon = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Alex Foreign Canary',
      isForeign: true,
      workPermitExempt: false,
      workPermitNumber: PERMIT_RAW,
      workPermitExpiresOn: soonDate,
      employment: {
        effectiveFrom: '2026-08-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '30000000',
        taxResident: false,
      },
    });
    const expiredPermit = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Sam Expired Canary',
      isForeign: true,
      workPermitExempt: false,
      workPermitNumber: 'GP2025-1111',
      workPermitExpiresOn: pastDate,
      employment: { effectiveFrom: '2026-08-01', contractType: 'indefinite', region: 'I', baseWage: '20000000', taxResident: true },
    });
    const exemptForeign = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Kim Exempt Canary',
      isForeign: true,
      workPermitExempt: true,
      workPermitExpiresOn: pastDate,
      employment: { effectiveFrom: '2026-08-01', contractType: 'indefinite', region: 'I', baseWage: '20000000', taxResident: true },
    });

    // Member cannot read employee list/get (owner_admin RLS & runtime access).
    await expect(o.query(o.member, 'hr.payroll.employee.list', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const list = await o.query<HrEmployeeSummary[]>(o.owner, 'hr.payroll.employee.list', {});
    const alexSummary = list.find((x) => x.id === expSoon.employeeId)!;
    const samSummary = list.find((x) => x.id === expiredPermit.employeeId)!;
    const kimSummary = list.find((x) => x.id === exemptForeign.employeeId)!;

    expect(alexSummary.isForeign).toBe(true);
    expect(alexSummary.hasWorkPermitNumber).toBe(true);
    expect(alexSummary.contractAlerts.map((a) => a.code)).toContain('work_permit_expiring_soon');
    expect(samSummary.contractAlerts.map((a) => a.code)).toContain('work_permit_expired');
    expect(kimSummary.contractAlerts).toEqual([]);
    expect(JSON.stringify(list)).not.toContain(PERMIT_RAW);

    const alexDetail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: expSoon.employeeId });
    expect(alexDetail.workPermitNumber).toBe('****9876');
    expect(alexDetail.workPermitNumber).not.toContain('GP2026');
    expect(alexDetail.current?.taxResident).toBe(false);

    // Run 2026-08: BHTN must be 0 (foreign exemption), PIT must be 20% flat non-resident (6,000,000 on 30M gross).
    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-08' });
    const sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const alexLine = sheet.lines.find((l) => l.employeeId === expSoon.employeeId)!;

    expect(alexLine.flags).toContain('work_permit_expiring');
    expect(alexLine.flags).toContain('non_resident_flat_pit');
    expect(alexLine.figures?.pit).toBe('6000000.00');
    const breakdown = alexLine.breakdown as {
      tax: { mode: string; flatPercent: string | null };
      insurance: { funds: Array<{ fund: string; employee: string; employer: string }> };
    };
    expect(breakdown.tax.mode).toBe('non_resident_flat');
    expect(breakdown.tax.flatPercent).toBe('20');
    expect(breakdown.insurance.funds.find((f) => f.fund === 'unemployment')).toEqual({ fund: 'unemployment', wage: '0', employee: '0', employer: '0' });

    // Confirm shipped rules only as needed to verify Ly coworker outputs.
    const reads: PayrollReads = {
      sheet: (runId) => o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId }),
      runs: (legalEntityId) => o.query<HrRunSummary[]>(o.owner, 'hr.payroll.run.list', { legalEntityId }),
      payslip: (lineId) => o.query<HrPayslip>(o.owner, 'hr.payroll.line.payslip', { lineId }),
    };
    const flagged = await flagMonth({ reader: null, budget: new DraftBudget() }, reads, o.orgId, o.owner, run.runId, 'vi');
    expect(flagged.items.map((i) => i.kind)).toContain('work_permit_expiring');
    expect(flagged.items.map((i) => i.kind)).toContain('non_resident_flat_pit');
    expect(flagged.items.map((i) => i.kind)).toContain('rule_blocks');

    // Audit events must carry no raw work permit or hourly/piece amounts or raw dates.
    const addAudits = await withAdmin(
      async (c) => (await c.query<{ raw: string }>(`SELECT audit_event::text AS raw FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'hr.payroll.employee.add'`, [o.orgId])).rows,
    );
    for (const row of addAudits) {
      expect(row.raw).not.toContain(PERMIT_RAW);
      expect(row.raw).not.toContain(soonDate);
    }

    // End + erase after 10y retention clears work_permit_expires_on and shreds key so workPermitNumber reads null.
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: expSoon.employeeId, endedOn: '2026-08-31' });
    await withAdmin((c) =>
      c.query(`UPDATE crove_hr.payroll_employee SET ended_on = ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date WHERE id = $1`, [expSoon.employeeId]),
    );
    const erased = await o.exec<HrEmployeeErased>(o.owner, 'hr.payroll.employee.erase', { employeeId: expSoon.employeeId }, asMfa(o.owner));
    expect(erased.shreddedKeys).toBe(1);
    expect(erased.cleared).toContain('work permit expiry');
    const afterErase = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: expSoon.employeeId });
    expect(afterErase.erased).toBe(true);
    expect(afterErase.workPermitNumber).toBeNull();
    expect(afterErase.workPermitExpiresOn).toBeNull();

    // Offboarding export (stream query) omits work_permit_number_sealed even for active employees like expiredPermit.
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [o.orgId]);
      await c.query('COMMIT');
    });
    const exportedEmployees: Array<Record<string, unknown>> = [];
    await rt.stream(
      'kernel.org.export.people',
      { table: 'hr.payroll_employee' },
      { actor: asUser(o.owner), orgId: o.orgId },
      async (batch) => {
        for (const line of (batch as { lines: string[] }).lines) {
          exportedEmployees.push(JSON.parse(line) as Record<string, unknown>);
        }
      },
    );
    expect(exportedEmployees.length).toBe(3);
    for (const row of exportedEmployees) {
      expect(row).not.toHaveProperty('work_permit_number_sealed');
    }
    const exportDump = JSON.stringify(exportedEmployees);
    expect(exportDump).not.toContain('crove:s1:');
    expect(exportDump).not.toContain('GP2025-1111');
    expect(exportDump).not.toContain(PERMIT_RAW);
  });

  it('syncs sickness & maternity BHXH leave to pay runs, preserves manual overrides, and suspends >=14d insurance regime', async () => {
    setRuleStatus('confirmed');
    try {
      const o = await setupOrg();
      const sickEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
        displayName: 'Lê Nghỉ Ốm Canary',
        employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '26000000' },
      });
      const matEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
        displayName: 'Phạm Thai Sản Canary',
        employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '26000000' },
      });

      await o.exec<HrLeaveWritten>(o.owner, 'hr.payroll.leave.set', {
        employeeId: sickEmp.employeeId,
        month: '2026-09',
        kind: 'sickness_bhxh',
        days: '5.5',
        approved: true,
      });
      await o.exec<HrLeaveWritten>(o.owner, 'hr.payroll.leave.set', {
        employeeId: matEmp.employeeId,
        month: '2026-09',
        kind: 'maternity_bhxh',
        days: '15',
        approved: true,
      });

      const sickBal = await o.query<HrLeaveBalanceResult>(o.owner, 'hr.payroll.leave.balance', {
        employeeId: sickEmp.employeeId,
        year: '2026',
      });
      expect(sickBal.balance.sicknessBhxhDays).toBe('5.5');
      expect(sickBal.balance.sicknessBhxhDaysByMonth).toEqual({ '2026-09': '5.5' });
      expect(sickBal.balance.takenAnnualDays).toBe('0');

      const matBal = await o.query<HrLeaveBalanceResult>(o.owner, 'hr.payroll.leave.balance', {
        employeeId: matEmp.employeeId,
        year: '2026',
      });
      expect(matBal.balance.maternityBhxhDays).toBe('15');
      expect(matBal.balance.maternityBhxhDaysByMonth).toEqual({ '2026-09': '15' });

      // Opening the September run automatically populates approved BHXH leave from the ledger.
      const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-09' });
      let sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
      let sickLine = sheet.lines.find((l) => l.employeeId === sickEmp.employeeId)!;
      const matLine = sheet.lines.find((l) => l.employeeId === matEmp.employeeId)!;

      expect(sickLine.inputs).toMatchObject({ sicknessBhxhDays: '5.5', sicknessBhxhFromLedger: true });
      expect(sickLine.flags).not.toContain('bhxh_suspended_regime');
      expect((sickLine.breakdown as { pay: { sicknessBhxhReduction: string } }).pay.sicknessBhxhReduction).toBe('5500000');

      // 15 days maternity >= 14d threshold: 0 insurance/union, breakdown suspended === 'maternity_leave', flag present.
      expect(matLine.inputs).toMatchObject({ maternityBhxhDays: '15', maternityBhxhFromLedger: true });
      expect(matLine.flags).toContain('bhxh_suspended_regime');
      expect(matLine.figures?.employeeInsurance).toBe('0.00');
      expect(matLine.figures?.employerInsurance).toBe('0.00');
      expect(matLine.figures?.unionFee).toBe('0.00');
      expect((matLine.breakdown as { pay: { maternityBhxhReduction: string }; insurance: { suspended: string } }).pay.maternityBhxhReduction).toBe('15000000');
      expect((matLine.breakdown as { insurance: { suspended: string } }).insurance.suspended).toBe('maternity_leave');

      // Update ledger to 14 days and sync_leave -> sickEmp now triggers sickness_leave BHXH suspension!
      await o.exec<HrLeaveWritten>(o.owner, 'hr.payroll.leave.set', {
        employeeId: sickEmp.employeeId,
        month: '2026-09',
        kind: 'sickness_bhxh',
        days: '14',
        approved: true,
      });
      await o.exec(o.owner, 'hr.payroll.run.sync_leave', { runId: run.runId });
      sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
      sickLine = sheet.lines.find((l) => l.employeeId === sickEmp.employeeId)!;
      expect(sickLine.inputs).toMatchObject({ sicknessBhxhDays: '14', sicknessBhxhFromLedger: true });
      expect(sickLine.flags).toContain('bhxh_suspended_regime');
      expect(sickLine.figures?.employeeInsurance).toBe('0.00');
      expect((sickLine.breakdown as { insurance: { suspended: string } }).insurance.suspended).toBe('sickness_leave');

      // Clearing ledger entry on a ledger-synced line resets sicknessBhxhDays back to '0'.
      await o.exec<HrLeaveWritten>(o.owner, 'hr.payroll.leave.set', {
        employeeId: sickEmp.employeeId,
        month: '2026-09',
        kind: 'sickness_bhxh',
        days: '0',
      });
      await o.exec(o.owner, 'hr.payroll.run.sync_leave', { runId: run.runId });
      sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
      sickLine = sheet.lines.find((l) => l.employeeId === sickEmp.employeeId)!;
      expect(sickLine.inputs).toMatchObject({ sicknessBhxhDays: '0', sicknessBhxhFromLedger: null });

      // Manual override via line.inputs.set (non-zero AND explicit '0') is preserved even if ledger later updates.
      await o.exec(o.owner, 'hr.payroll.line.inputs.set', { lineId: sickLine.id, inputs: { sicknessBhxhDays: '3' } });
      await o.exec<HrLeaveWritten>(o.owner, 'hr.payroll.leave.set', {
        employeeId: sickEmp.employeeId,
        month: '2026-09',
        kind: 'sickness_bhxh',
        days: '7',
        approved: true,
      });
      await o.exec(o.owner, 'hr.payroll.run.sync_leave', { runId: run.runId });
      sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
      sickLine = sheet.lines.find((l) => l.employeeId === sickEmp.employeeId)!;
      expect(sickLine.inputs).toMatchObject({ sicknessBhxhDays: '3', sicknessBhxhFromLedger: false });

      await o.exec(o.owner, 'hr.payroll.line.inputs.set', { lineId: sickLine.id, inputs: { sicknessBhxhDays: '0' } });
      await o.exec(o.owner, 'hr.payroll.run.sync_leave', { runId: run.runId });
      sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
      sickLine = sheet.lines.find((l) => l.employeeId === sickEmp.employeeId)!;
      expect(sickLine.inputs).toMatchObject({ sicknessBhxhDays: '0', sicknessBhxhFromLedger: false });

      const reads: PayrollReads = {
        sheet: (runId) => o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId }),
        runs: (legalEntityId) => o.query<HrRunSummary[]>(o.owner, 'hr.payroll.run.list', { legalEntityId }),
        payslip: (lineId) => o.query<HrPayslip>(o.owner, 'hr.payroll.line.payslip', { lineId }),
      };
      const explained = await explainPayslip({ reader: null, budget: new DraftBudget() }, reads, o.orgId, o.owner, matLine.id, 'vi');
      expect(explained.ai).toBe('off');
    } finally {
      setRuleStatus('commentary');
    }
  });
});

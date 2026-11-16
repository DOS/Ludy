// SPDX-License-Identifier: AGPL-3.0-only
// Stage 2 slice 2b-3 (#3384): labor contract tracking, probation compliance checks, expiry alerts,
// payroll contractTermMonths defaulting, runSheet flags, and Ly probation_ends_this_month on PostgreSQL 17.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import {
  vietnamToday,
  type HrEmployee,
  type HrEmployeeSummary,
  type HrRunSheet,
  type HrRunSummary,
  type HrRunWritten,
  type HrWritten,
} from '@crove/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@crove/kernel-runtime';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { prepareMonth, type PayrollReads } from '../src/payroll-coworker-ai.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

function shiftIsoDays(isoDate: string, deltaDays: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

suite('HR labor contract tracking, probation compliance, and expiry alerts (#3384)', () => {
  const dbName = `crove_test_hr2b3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

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
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hr2b3', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const { orgId } = await createOrg(rt, asUser(owner), `HR 2b3 ${tag}`);
    await withAdmin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, admin, member]),
    );
    const exec = <O>(userId: string, name: string, input: unknown = {}) => rt.execute<O>(name, input, { actor: asUser(userId), orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    const audits = (command: string) =>
      withAdmin(async (c) => (await c.query<{ outcome: string; detail: unknown }>('SELECT outcome, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY id', [orgId, command])).rows);
    return { orgId, owner, admin, member, exec, query, audits };
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

  it('persists contract & probation fields, auto-fills contractEndOn, keeps basic callers compatible, and redacts probation_wage in audit', async () => {
    const o = await org();

    // 1. Backwards-compatible basic callers omitting all 7 fields still work for fixed_term, indefinite, and none.
    const basicFixed = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Nguyễn Cơ Bản Canary',
      employment: { effectiveFrom: '2026-01-01', contractType: 'fixed_term', region: 'I', baseWage: '10000000' },
    });
    const basicDetail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: basicFixed.employeeId });
    expect(basicDetail.current).toMatchObject({
      contractType: 'fixed_term',
      contractForm: null,
      termMonths: null,
      contractEndOn: null,
      fixedTermSequence: null,
      probationRoleTier: null,
      probationEndOn: null,
      probationWage: null,
    });
    expect(basicDetail.contractAlerts).toEqual([]);

    // 2. Full fixed_term contract with auto-derived contractEndOn and compliant probation (exact 85% decimal floor).
    const full = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Trần Hợp Đồng Canary',
      employment: {
        effectiveFrom: '2026-01-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '10000001',
        contractForm: 'electronic',
        termMonths: 12,
        fixedTermSequence: 1,
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-03-01',
        probationWage: '8500000.85',
      },
    });
    const fullDetail = await o.query<HrEmployee>(o.admin, 'hr.payroll.employee.get', { employeeId: full.employeeId });
    expect(fullDetail.current).toMatchObject({
      contractType: 'fixed_term',
      contractForm: 'electronic',
      termMonths: 12,
      contractEndOn: '2026-12-31',
      fixedTermSequence: 1,
      probationRoleTier: 'college_or_above',
      probationEndOn: '2026-03-01',
      probationWage: '8500000.85',
    });

    // 3. Renewal (sequence 2, warning only) via hr.payroll.employment.add succeeds and retains audit redaction.
    await o.exec<HrWritten>(o.owner, 'hr.payroll.employment.add', {
      employeeId: full.employeeId,
      effectiveFrom: '2027-01-01',
      contractType: 'fixed_term',
      region: 'I',
      baseWage: '12000000',
      contractForm: 'written',
      termMonths: 24,
      fixedTermSequence: 2,
      probationRoleTier: 'enterprise_manager',
      probationEndOn: '2027-06-29',
      probationWage: '10200000',
    });

    // 4. Oral form allowed for under-one-month (`none`) contract with end date < 1 month.
    const oral = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Lê Thời Vụ Ngắn Canary',
      employment: {
        effectiveFrom: '2026-05-01',
        contractType: 'none',
        region: 'I',
        baseWage: '7000000',
        contractForm: 'oral',
        contractEndOn: '2026-05-20',
      },
    });
    const oralDetail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: oral.employeeId });
    expect(oralDetail.current).toMatchObject({
      contractType: 'none',
      contractForm: 'oral',
      contractEndOn: '2026-05-20',
    });

    // Audit rows must redact probation_wage and never leak raw wage numbers.
    const addAudits = await o.audits('hr.payroll.employee.add');
    const empAddAudits = await o.audits('hr.payroll.employment.add');
    const fullAddAudit = addAudits.find((a) => (a.detail as { employeeId?: string }).employeeId === full.employeeId);
    expect(fullAddAudit?.detail).toMatchObject({
      contractForm: 'electronic',
      termMonths: 12,
      contractEndOn: '2026-12-31',
      fixedTermSequence: 1,
      probationRoleTier: 'college_or_above',
      probationEndOn: '2026-03-01',
      probationWage: { redacted: 'sensitive' },
      baseWage: { redacted: 'sensitive' },
    });
    expect(empAddAudits[0]?.detail).toMatchObject({
      probationWage: { redacted: 'sensitive' },
      baseWage: { redacted: 'sensitive' },
    });
    expect(JSON.stringify([...addAudits, ...empAddAudits])).not.toMatch(/8500000\.85|10200000|10000001/);
  });

  it('rejects Labor Code 2019 violations cleanly (422 HR_CONTRACT_INVALID) and enforces DB CHECK constraints', async () => {
    const o = await org();
    const baseEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Phạm Kiểm Tra Canary',
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
    });

    const invalidCases = [
      // Probation wage below 85% (10,000,001 * 0.85 = 8,500,000.85 -> 8,500,000 fails).
      {
        effectiveFrom: '2026-02-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '10000001',
        termMonths: 12,
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-03-01',
        probationWage: '8500000',
      },
      // Probation exceeds 60 calendar days for college_or_above (2026-01-01..2026-03-02 = 61 days).
      {
        effectiveFrom: '2026-02-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '15000000',
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-04-03',
        probationWage: '13000000',
      },
      // Oral contract forbidden on fixed_term >= 1 month.
      {
        effectiveFrom: '2026-02-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '15000000',
        contractForm: 'oral',
        termMonths: 6,
      },
      // Probation prohibited on under-one-month (`none`) contract.
      {
        effectiveFrom: '2026-02-01',
        contractType: 'none',
        region: 'I',
        baseWage: '8000000',
        contractForm: 'oral',
        contractEndOn: '2026-02-15',
        probationRoleTier: 'other',
        probationEndOn: '2026-02-05',
        probationWage: '7000000',
      },
      // Under-one-month (`none`) spanning 1 full month is rejected.
      {
        effectiveFrom: '2026-02-01',
        contractType: 'none',
        region: 'I',
        baseWage: '8000000',
        contractForm: 'oral',
        contractEndOn: '2026-02-28',
      },
      // fixedTermSequence on indefinite contract rejected cleanly (not raw SQL error).
      {
        effectiveFrom: '2026-02-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '15000000',
        fixedTermSequence: 1,
      },
      // Mismatched termMonths and contractEndOn.
      {
        effectiveFrom: '2026-02-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '15000000',
        termMonths: 6,
        contractEndOn: '2026-12-31',
      },
    ];

    for (const bad of invalidCases) {
      await expect(
        o.exec(o.owner, 'hr.payroll.employee.add', { displayName: 'Sai Quy Định Canary', employment: bad }),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: 'HR_CONTRACT_INVALID', status: 422, details: { findings: expect.arrayContaining([expect.objectContaining({ severity: 'error' })]) } });
      await expect(
        o.exec(o.owner, 'hr.payroll.employment.add', { employeeId: baseEmp.employeeId, ...bad }),
        JSON.stringify(bad),
      ).rejects.toMatchObject({ code: 'HR_CONTRACT_INVALID', status: 422, details: { findings: expect.arrayContaining([expect.objectContaining({ severity: 'error' })]) } });
    }

    // Schema bounds (sequence 3, termMonths 37) rejected at validation boundary.
    await expect(
      o.exec(o.owner, 'hr.payroll.employment.add', {
        employeeId: baseEmp.employeeId,
        effectiveFrom: '2026-02-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '15000000',
        termMonths: 12,
        fixedTermSequence: 3,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Direct SQL constraints guard against bypassing commands.
    await expect(
      withAdmin((c) =>
        c.query(
          `INSERT INTO crove_hr.payroll_employment (org_id, legal_entity_id, employee_id, effective_from, contract_type, region, base_wage, contract_end_on)
           VALUES ($1, (SELECT legal_entity_id FROM crove_hr.payroll_employee WHERE id = $2), $2, '2026-05-01', 'indefinite', 'I', 10000000, '2026-12-31')`,
          [o.orgId, baseEmp.employeeId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      withAdmin((c) =>
        c.query(
          `INSERT INTO crove_hr.payroll_employment (org_id, legal_entity_id, employee_id, effective_from, contract_type, region, base_wage, fixed_term_sequence)
           VALUES ($1, (SELECT legal_entity_id FROM crove_hr.payroll_employee WHERE id = $2), $2, '2026-05-01', 'none', 'I', 10000000, 1)`,
          [o.orgId, baseEmp.employeeId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      withAdmin((c) =>
        c.query(
          `INSERT INTO crove_hr.payroll_employment (org_id, legal_entity_id, employee_id, effective_from, contract_type, region, base_wage, probation_end_on)
           VALUES ($1, (SELECT legal_entity_id FROM crove_hr.payroll_employee WHERE id = $2), $2, '2026-05-01', 'indefinite', 'I', 10000000, '2026-04-01')`,
          [o.orgId, baseEmp.employeeId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('evaluates deterministic contractAlerts on employee list & get for active employees only', async () => {
    const o = await org();
    const today = vietnamToday();

    // Active employee with probation ending in 10 days + contract expiring in 20 days + 2nd renewal.
    const expStart = shiftIsoDays(today, -35);
    const expEnd = shiftIsoDays(today, 20);
    const probEnd = shiftIsoDays(today, 10);
    const expiring = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Đỗ Sắp Hết Hạn Canary',
      employment: {
        effectiveFrom: expStart,
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '14000000',
        contractForm: 'written',
        contractEndOn: expEnd,
        fixedTermSequence: 2,
        probationRoleTier: 'college_or_above',
        probationEndOn: probEnd,
        probationWage: '12000000',
      },
    });

    // Active employee whose 1-month fixed-term contract already expired.
    const expiredStart = shiftIsoDays(today, -45);
    const expired = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Hoàng Quá Hạn Canary',
      employment: {
        effectiveFrom: expiredStart,
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '14000000',
        termMonths: 1,
      },
    });

    // Ended employee whose dates would otherwise alert must return empty contractAlerts.
    const left = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Vũ Đã Nghỉ Canary',
      employment: {
        effectiveFrom: expStart,
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '14000000',
        contractEndOn: expEnd,
        fixedTermSequence: 2,
      },
    });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: left.employeeId, endedOn: today });

    const list = await o.query<HrEmployeeSummary[]>(o.owner, 'hr.payroll.employee.list', { status: 'all' });
    const ofList = (id: string | undefined) => list.find((e) => e.id === id)!;

    expect(ofList(expiring.employeeId).contractAlerts.map((a) => [a.code, a.daysRemaining])).toEqual([
      ['contract_expiring_soon', 20],
      ['probation_ending_soon', 10],
      ['final_fixed_term_renewal', 20],
    ]);
    expect(ofList(expired.employeeId).contractAlerts.map((a) => a.code)).toEqual(['contract_expired']);
    expect(ofList(left.employeeId).contractAlerts).toEqual([]);

    const detail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: expiring.employeeId });
    expect(detail.contractAlerts).toEqual(ofList(expiring.employeeId).contractAlerts);
    const leftDetail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: left.employeeId });
    expect(leftDetail.contractAlerts).toEqual([]);
  });

  it('defaults contractTermMonths from terms, emits probation_ends_this_month & ends_this_month, and feeds Ly signals', async () => {
    const o = await org();

    // Employee A: 12-month fixed term starting 2025-12-01 -> contract_end_on auto-fills 2026-11-30; probation ended earlier in 2026-01.
    const empContractEnd = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Nguyễn Thị Lan Hợp Đồng',
      employment: {
        effectiveFrom: '2025-12-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '15000000',
        contractForm: 'written',
        termMonths: 12,
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-01-29',
        probationWage: '13000000',
      },
    });

    // Employee B: indefinite contract starting 2026-10-01 with probation ending 2026-11-20.
    const empProbEnd = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Trần Văn Minh Thử Việc',
      employment: {
        effectiveFrom: '2026-10-01',
        contractType: 'indefinite',
        region: 'I',
        baseWage: '16000000',
        probationRoleTier: 'college_or_above',
        probationEndOn: '2026-11-20',
        probationWage: '14000000',
      },
    });

    // Open 2026-11 pay run: empContractEnd automatically gets inputs.contractTermMonths = 12 (no fixed_term_months_missing refusal!).
    const opened = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-11' });

    // Employee C: fixed-term with termMonths 6 hired AFTER run.open -> run.recalculate picks up termMonths 6 automatically.
    const empRecalc = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Lê Thu Hà Thử Việc',
      employment: {
        effectiveFrom: '2026-11-05',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '14000000',
        termMonths: 6,
      },
    });
    await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.recalculate', { runId: opened.runId });

    const sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: opened.runId });
    const lineA = sheet.lines.find((l) => l.employeeId === empContractEnd.employeeId)!;
    const lineB = sheet.lines.find((l) => l.employeeId === empProbEnd.employeeId)!;
    const lineC = sheet.lines.find((l) => l.employeeId === empRecalc.employeeId)!;

    expect(lineA.status).toBe('calculated');
    expect(lineA.inputs.contractTermMonths).toBe(12);
    expect(lineA.flags).toContain('ends_this_month');
    expect(lineA.flags).not.toContain('probation_ends_this_month');
    expect(lineA.flags).not.toContain('severance_check');
    expect(lineA.flags).not.toContain('fixed_term_months_missing');

    expect(lineB.status).toBe('calculated');
    expect(lineB.flags).toContain('probation_ends_this_month');
    expect(lineB.flags).not.toContain('ends_this_month');

    expect(lineC.status).toBe('calculated');
    expect(lineC.inputs.contractTermMonths).toBe(6);
    expect(lineC.flags).toContain('new_hire');

    // Ly prepareMonth reads the live DB sheet and produces deterministic probation_ends & contract_ends signals with AI off.
    const reads: PayrollReads = {
      sheet: (runId) => o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId }),
      runs: () => o.query<HrRunSummary[]>(o.owner, 'hr.payroll.run.list', {}),
      payslip: () => Promise.reject(new Error('not called')),
    };
    const prepared = await prepareMonth({ reader: null, budget: new DraftBudget() }, reads, o.orgId, o.owner, opened.runId, 'vi');
    expect(prepared.ai).toBe('off');
    expect(prepared.items.some((i) => i.kind === 'probation_ends' && i.employeeId === empProbEnd.employeeId)).toBe(true);
    expect(prepared.items.some((i) => i.kind === 'contract_ends' && i.employeeId === empContractEnd.employeeId)).toBe(true);
    expect(prepared.items.some((i) => i.kind === 'new_hire' && i.employeeId === empRecalc.employeeId)).toBe(true);

    // And AI on never leaks employee names or calendar dates.
    const prompts: string[] = [];
    const preparedAi = await prepareMonth(
      {
        reader: {
          payrollPrepare: vi.fn(async (_s, _opts) => {
            prompts.push(JSON.stringify(_s));
            return { kind: 'ok' as const, items: [] };
          }),
          payrollFlag: vi.fn(),
          payrollExplain: vi.fn(),
        } as never,
        budget: new DraftBudget(),
      },
      reads,
      o.orgId,
      o.owner,
      opened.runId,
      'en',
    );
    expect(preparedAi.ai).toBe('used');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Nguyễn Thị Lan');
    expect(prompts[0]).not.toContain('Trần Văn Minh');
    expect(prompts[0]).not.toMatch(/2026-\d{2}-\d{2}/);
  });

  it('refreshes inputs.contractTermMonths when a person moves from a 2-month contract to a 12-month contract across runOpen and runRecalculate', async () => {
    const o = await org();
    // Month 1 (2026-09): 2-month fixed-term contract -> PIT uses flat 10% withholding mode.
    const emp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Bùi Đổi Hợp Đồng Canary',
      employment: {
        effectiveFrom: '2026-09-01',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '10000000',
        termMonths: 2,
        fixedTermSequence: 1,
      },
    });
    const sepRun = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-09' });
    const sepLine = (await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: sepRun.runId })).lines[0]!;
    expect(sepLine.inputs.contractTermMonths).toBe(2);
    expect((sepLine.breakdown as { tax?: { mode?: string } }).tax?.mode).toBe('flat');

    // Month 2 (2026-10): renew onto a 12-month fixed-term contract starting 2026-10-01 -> runOpen must switch contractTermMonths to 12 (progressive).
    await o.exec<HrWritten>(o.owner, 'hr.payroll.employment.add', {
      employeeId: emp.employeeId,
      effectiveFrom: '2026-10-01',
      contractType: 'fixed_term',
      region: 'I',
      baseWage: '10000000',
      termMonths: 12,
      fixedTermSequence: 2,
    });
    const octRun = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-10' });
    const octLine = (await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: octRun.runId })).lines[0]!;
    expect(octLine.inputs.contractTermMonths).toBe(12);
    expect((octLine.breakdown as { tax?: { mode?: string } }).tax?.mode).toBe('progressive');

    // Also test in-month contract transition via runRecalculate: open 2026-11 for a 2-month employee, then upgrade them to 12 months.
    const empRecalc = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Đào Tái Tính Canary',
      employment: {
        effectiveFrom: '2026-10-15',
        contractType: 'fixed_term',
        region: 'I',
        baseWage: '10000000',
        termMonths: 2,
      },
    });
    const novRun = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-11' });
    await o.exec<HrWritten>(o.owner, 'hr.payroll.employment.add', {
      employeeId: empRecalc.employeeId,
      effectiveFrom: '2026-11-01',
      contractType: 'fixed_term',
      region: 'I',
      baseWage: '10000000',
      termMonths: 12,
      fixedTermSequence: 2,
    });
    await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.recalculate', { runId: novRun.runId });
    const novLine = (await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: novRun.runId })).lines.find(
      (l) => l.employeeId === empRecalc.employeeId,
    )!;
    expect(novLine.inputs.contractTermMonths).toBe(12);
    expect((novLine.breakdown as { tax?: { mode?: string } }).tax?.mode).toBe('progressive');
  });
});

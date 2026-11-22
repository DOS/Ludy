// SPDX-License-Identifier: AGPL-3.0-only
// Stage 1 slice 1c-2 (#3394, #2540): monthly leave ledger, statutory leave balance, draft pay run unpaid-leave sync, and Ly annual_leave_exceeded anomaly on real PostgreSQL 17.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { flagMonth, type PayrollReads } from '../src/payroll-coworker-ai.ts';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  HrLeaveBalanceResult,
  HrLeaveWritten,
  HrRunSheet,
  HrRunSummary,
  HrRunWritten,
  HrWritten,
} from '@ludy/kernel-contract';
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

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('HR annual leave ledger, unpaid-leave sync, and Ly anomaly (#3394)', () => {
  const dbName = `crove_test_hrleave_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hrleave', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, asUser(owner), `HR Leave ${tag}`);
    await withAdmin((c) => c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [orgId, admin, member, viewer]));
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    const hire = (name: string, effectiveFrom: string, baseWage: string) =>
      exec<HrWritten>(owner, 'hr.payroll.employee.add', {
        displayName: name,
        employment: { effectiveFrom, contractType: 'indefinite', region: 'I', baseWage },
      });
    const open = (month: string) => exec<HrRunWritten>(owner, 'hr.payroll.run.open', { month });
    const sheet = (runId: string) => query<HrRunSheet>(owner, 'hr.payroll.run.sheet', { runId });
    const approve = (runId: string, fingerprint: string) =>
      exec<HrRunWritten>(owner, 'hr.payroll.run.approve', { runId, fingerprint, acceptFlags: false }, asMfa(owner));
    const audits = (command: string) =>
      withAdmin(async (c) => (await c.query<{ outcome: string; detail: unknown }>('SELECT outcome, detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY id', [orgId, command])).rows);
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

  it('tracks monthly leave entries, computes seniority and category balances, zero-deletes, and enforces validation', async () => {
    const o = await org();
    // Hired 2021-01-01 -> 5 full years in 2026 => +1 seniority day => 13 base+seniority days for standard category.
    const emp = await o.hire('Lê Thu Hà Canary', '2021-01-01', '12000000');
    const laterEmp = await o.hire('Đỗ Quốc Bảo Canary', '2026-06-01', '12000000');

    // Opening carry-over + approved leave + unapproved request + personal paid + unpaid leave.
    const opening = await o.exec<HrLeaveWritten>(o.admin, 'hr.payroll.leave.set', {
      employeeId: emp.employeeId,
      month: '2026-01',
      kind: 'opening_balance',
      days: '2',
      approved: true,
    });
    expect(opening.deleted).toBe(false);

    const mayLeave = await o.exec<HrLeaveWritten>(o.admin, 'hr.payroll.leave.set', {
      employeeId: emp.employeeId,
      month: '2026-05',
      kind: 'annual_leave',
      days: '3.5',
      approved: true,
    });
    // Upsert same slot updates days without error.
    const mayLeaveUpdated = await o.exec<HrLeaveWritten>(o.admin, 'hr.payroll.leave.set', {
      employeeId: emp.employeeId,
      month: '2026-05',
      kind: 'annual_leave',
      days: '4.5',
      approved: true,
    });
    expect(mayLeaveUpdated.entryId).toBe(mayLeave.entryId);

    // Unapproved annual leave is stored but does not consume entitlement.
    await o.exec<HrLeaveWritten>(o.owner, 'hr.payroll.leave.set', {
      employeeId: emp.employeeId,
      month: '2026-06',
      kind: 'annual_leave',
      days: '2',
      approved: false,
    });
    await o.exec<HrLeaveWritten>(o.owner, 'hr.payroll.leave.set', {
      employeeId: emp.employeeId,
      month: '2026-07',
      kind: 'personal_paid',
      days: '3',
      approved: true,
    });

    const std = await o.query<HrLeaveBalanceResult>(o.admin, 'hr.payroll.leave.balance', { employeeId: emp.employeeId, year: '2026' });
    expect(std.balance).toMatchObject({
      year: '2026',
      eligibleMonths: 12,
      entitlementDays: '12',
      seniorityYears: 5,
      seniorityDays: '1',
      totalEntitlementDays: '13',
      openingDays: '2',
      takenAnnualDays: '4.5',
      remainingAnnualDays: '10.5',
      exceededAnnualDays: '0',
      personalPaidDays: '3',
    });
    expect(std.entries).toHaveLength(4);

    const heavy = await o.query<HrLeaveBalanceResult>(o.owner, 'hr.payroll.leave.balance', {
      employeeId: emp.employeeId,
      year: '2026',
      category: 'heavy',
    });
    expect(heavy.balance.entitlementDays).toBe('14');
    expect(heavy.balance.remainingAnnualDays).toBe('12.5');

    // Setting days = '0' deletes the existing slot.
    const zeroed = await o.exec<HrLeaveWritten>(o.owner, 'hr.payroll.leave.set', {
      employeeId: emp.employeeId,
      month: '2026-06',
      kind: 'annual_leave',
      days: '0',
    });
    expect(zeroed).toMatchObject({ employeeId: emp.employeeId, deleted: true });

    // Deleting via explicit entryId removes personal_paid; deleting again yields 404.
    const personalEntry = std.entries.find((e) => e.kind === 'personal_paid')!;
    const deleted = await o.exec<HrLeaveWritten>(o.admin, 'hr.payroll.leave.delete', { entryId: personalEntry.id });
    expect(deleted).toMatchObject({ employeeId: emp.employeeId, entryId: personalEntry.id, deleted: true });
    await expect(o.exec(o.admin, 'hr.payroll.leave.delete', { entryId: personalEntry.id })).rejects.toMatchObject({
      code: 'HR_LEAVE_ENTRY_NOT_FOUND',
      status: 404,
    });

    // Validation errors: before-hire month & > 31 monthly days.
    await expect(
      o.exec(o.owner, 'hr.payroll.leave.set', { employeeId: laterEmp.employeeId, month: '2026-05', kind: 'annual_leave', days: '1' }),
    ).rejects.toMatchObject({ code: 'HR_LEAVE_BEFORE_HIRE', status: 422 });
    await expect(
      o.exec(o.owner, 'hr.payroll.leave.set', { employeeId: laterEmp.employeeId, month: '2026-06', kind: 'annual_leave', days: '32' }),
    ).rejects.toMatchObject({ code: 'HR_LEAVE_DAYS_EXCEEDS_MONTH', status: 422 });

    // Erased employee is refused on both write and balance read.
    const oldEmp = await o.hire('Cụ Đặng Văn An Canary', '2005-01-01', '5000000');
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: oldEmp.employeeId, endedOn: '2010-01-01' });
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: oldEmp.employeeId }, asMfa(o.owner));
    await expect(
      o.exec(o.owner, 'hr.payroll.leave.set', { employeeId: oldEmp.employeeId, month: '2026-06', kind: 'annual_leave', days: '1' }),
    ).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ERASED', status: 409 });
    await expect(o.query(o.owner, 'hr.payroll.leave.balance', { employeeId: oldEmp.employeeId, year: '2026' })).rejects.toMatchObject({
      code: 'HR_EMPLOYEE_ERASED',
      status: 409,
    });
  });

  it('syncs unpaid leave to draft pay runs without clobbering manual components, resets deleted entries, and flags annual_leave_exceeded cleanly', async () => {
    setRuleStatus('confirmed');
    try {
      const o = await org();
      // Hired 2026-10-01 -> by 2026-11 has 2 eligible months = 2 statutory annual leave days in Nov.
      const emp = await o.hire('Vũ Thị Mai Canary', '2026-10-01', '15000000');
      const run = await o.open('2026-11');
      const before = await o.sheet(run.runId);
      const line = before.lines.find((l) => l.employeeId === emp.employeeId)!;

      // Seed existing manual inputs that must survive syncLeave.
      await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
        lineId: line.id,
        inputs: {
          daysNotEmployed: '1',
          allowances: [{ label: 'Phụ cấp ăn', type: 'meal_cash', amount: '730000', namedInContract: true }],
          bonus: '2000000',
          advance: '500000',
          deductions: [
            { label: 'Hư hỏng', kind: 'damage', amount: '100000' },
            { label: 'Khác', kind: 'other', amount: '50000' },
          ],
          overtime: [{ dayKind: 'normal_day', night: false, hours: '4' }],
        },
      });

      // Record 2.5 days of unpaid_leave + 3.5 days approved annual_leave (exceeds 2 eligible days by 1.5 days).
      await o.exec(o.owner, 'hr.payroll.leave.set', {
        employeeId: emp.employeeId,
        month: '2026-11',
        kind: 'unpaid_leave',
        days: '2.5',
        approved: true,
      });
      await o.exec(o.owner, 'hr.payroll.leave.set', {
        employeeId: emp.employeeId,
        month: '2026-11',
        kind: 'annual_leave',
        days: '3.5',
        approved: true,
      });

      await o.exec<HrRunWritten>(o.admin, 'hr.payroll.run.sync_leave', { runId: run.runId });
      const synced = await o.sheet(run.runId);
      const syncedLine = synced.lines.find((l) => l.employeeId === emp.employeeId)!;
      expect(syncedLine.inputs?.unpaidLeaveDays).toBe('2.5');
      expect(syncedLine.inputs?.daysNotEmployed).toBe('1');
      expect(syncedLine.inputs?.bonus).toBe('2000000');
      expect(syncedLine.inputs?.advance).toBe('500000');
      expect(syncedLine.inputs?.deductions).toHaveLength(2);
      expect(syncedLine.inputs?.allowances).toHaveLength(1);
      expect(syncedLine.inputs?.overtime).toHaveLength(1);
      expect(syncedLine.flags).toContain('annual_leave_exceeded');
      expect(syncedLine.exceededAnnualDays).toBe('1.5');

      // Second sync without changes updates 0 lines (verified via audit detail).
      await o.exec<HrRunWritten>(o.admin, 'hr.payroll.run.sync_leave', { runId: run.runId });

      // Ly surfaces annual_leave_exceeded deterministically when AI is off without leaking names or dates.
      const sheetSummary: HrRunSummary = {
        id: run.runId,
        legalEntityId: synced.run.legalEntityId,
        month: '2026-11',
        status: 'draft',
        workingDays: synced.run.workingDays,
        lines: synced.lines.length,
        refused: 0,
        totals: synced.totals,
        approvedAt: null,
      };
      const reads: PayrollReads = {
        runs: async () => [sheetSummary],
        sheet: async () => synced,
        payslip: async () => {
          throw new Error('unused');
        },
      };
      const aiOff = await flagMonth({ reader: null, budget: new DraftBudget() }, reads, o.orgId, o.owner, run.runId, 'vi');
      expect(aiOff.ai).toBe('off');
      expect(aiOff.items.some((i) => i.kind === 'annual_leave_exceeded' && i.facts.includes('1,5'))).toBe(true);

      // A 2-decimal unpaid_leave entry such as '1.25' is rejected at write time; a legacy 2-decimal DB value also fails closed on sync.
      await expect(
        o.exec(o.owner, 'hr.payroll.leave.set', {
          employeeId: emp.employeeId,
          month: '2026-11',
          kind: 'unpaid_leave',
          days: '1.25',
          approved: true,
        }),
      ).rejects.toMatchObject({ status: 422 });
      await withAdmin((c) =>
        c.query(
          `UPDATE ludy_hr.payroll_leave_entry SET days = 1.25 WHERE org_id = $1 AND employee_id = $2 AND month = '2026-11' AND kind = 'unpaid_leave'`,
          [o.orgId, emp.employeeId],
        ),
      );
      await expect(o.exec(o.owner, 'hr.payroll.run.sync_leave', { runId: run.runId })).rejects.toMatchObject({
        code: 'HR_LEAVE_DAYS_OUT_OF_RANGE',
        status: 422,
      });

      // Removing unpaid_leave and re-syncing resets unpaidLeaveDays back to '0'.
      await o.exec(o.owner, 'hr.payroll.leave.set', {
        employeeId: emp.employeeId,
        month: '2026-11',
        kind: 'unpaid_leave',
        days: '0',
      });
      await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.sync_leave', { runId: run.runId });
      const resynced = await o.sheet(run.runId);
      const resyncedLine = resynced.lines.find((l) => l.employeeId === emp.employeeId)!;
      expect(resyncedLine.inputs?.unpaidLeaveDays).toBe('0');

      // Approving the run works even with annual_leave_exceeded advisory flag; syncing an approved run fails cleanly.
      await o.approve(run.runId, resynced.fingerprint);
      await expect(o.exec(o.owner, 'hr.payroll.run.sync_leave', { runId: run.runId })).rejects.toMatchObject({
        code: 'HR_RUN_NOT_DRAFT',
        status: 409,
      });

      const syncAudits = await o.audits('hr.payroll.run.sync_leave');
      expect(syncAudits.filter((a) => a.outcome === 'ok').map((a) => a.detail)).toEqual([
        { month: '2026-11', updatedLines: 1 },
        { month: '2026-11', updatedLines: 0 },
        { month: '2026-11', updatedLines: 1 },
      ]);
      expect(syncAudits.filter((a) => a.outcome !== 'ok')).toHaveLength(2);
    } finally {
      setRuleStatus('commentary');
    }
  });

  it('enforces owner/admin access, cross-org isolation, and audit redaction of sensitive leave days', async () => {
    const a = await org();
    const b = await org();
    const empA = await a.hire('Phạm Văn Sơn Canary', '2026-01-01', '12000000');

    const saved = await a.exec<HrLeaveWritten>(a.owner, 'hr.payroll.leave.set', {
      employeeId: empA.employeeId,
      month: '2026-04',
      kind: 'annual_leave',
      days: '4.5',
      approved: true,
    });

    // Non-managers and system actors are refused.
    for (const actorId of [a.member, a.viewer]) {
      await expect(a.query(actorId, 'hr.payroll.leave.balance', { employeeId: empA.employeeId, year: '2026' })).rejects.toMatchObject({ status: 403 });
      await expect(a.exec(actorId, 'hr.payroll.leave.set', { employeeId: empA.employeeId, month: '2026-05', kind: 'annual_leave', days: '1' })).rejects.toMatchObject({ status: 403 });
      await expect(a.exec(actorId, 'hr.payroll.leave.delete', { entryId: saved.entryId! })).rejects.toMatchObject({ status: 403 });
      await expect(a.exec(actorId, 'hr.payroll.run.sync_leave', { runId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      rt.execute('hr.payroll.leave.set', { employeeId: empA.employeeId, month: '2026-05', kind: 'annual_leave', days: '1' }, { actor: { type: 'system', component: 'worker' }, orgId: a.orgId }),
    ).rejects.toMatchObject({ status: 403 });

    // Cross-org isolation: org B cannot see or alter org A employee/entry.
    await expect(b.query(b.owner, 'hr.payroll.leave.balance', { employeeId: empA.employeeId, year: '2026' })).rejects.toMatchObject({
      code: 'HR_EMPLOYEE_NOT_FOUND',
      status: 404,
    });
    await expect(b.exec(b.owner, 'hr.payroll.leave.delete', { entryId: saved.entryId! })).rejects.toMatchObject({
      code: 'HR_LEAVE_ENTRY_NOT_FOUND',
      status: 404,
    });

    // Audit redaction: leave day counts are omitted from audit facts, never storing raw '4.5'.
    const leaveAudits = await a.audits('hr.payroll.leave.set');
    const detail = leaveAudits.find((row) => row.outcome === 'ok')?.detail as Record<string, unknown>;
    expect(detail).toEqual({
      employeeId: empA.employeeId,
      entryId: saved.entryId,
      month: '2026-04',
      kind: 'annual_leave',
      approved: true,
    });
    expect(JSON.stringify(leaveAudits)).not.toContain('4.5');
  });

  it('preserves imported timekeeping on unsynced lines, skips orphaned lines, refuses post-end leave writes, and honors heavy/custom baselines in Ly (#3411)', async () => {
    setRuleStatus('confirmed');
    try {
      const o = await org();
      const importedEmp = await o.hire('Trần Minh Khôi Canary', '2025-01-01', '14000000');
      const leavingEmp = await o.hire('Hoàng Thu Trang Canary', '2025-01-01', '14000000');
      const heavyEmp = await o.hire('Ngô Quốc Huy Canary', '2025-01-01', '18000000');

      const novRun = await o.open('2026-11');
      const initialSheet = await o.sheet(novRun.runId);
      const importedLine = initialSheet.lines.find((l) => l.employeeId === importedEmp.employeeId)!;
      const heavyLine = initialSheet.lines.find((l) => l.employeeId === heavyEmp.employeeId)!;

      // 1. Imported timekeeping sets unpaidLeaveDays = '3' on importedEmp (no leave ledger entry).
      await o.exec(o.owner, 'hr.payroll.run.import_timekeeping', {
        runId: novRun.runId,
        rows: [{ lineId: importedLine.id, unpaidLeaveDays: '3', daysNotEmployed: '0', nightHours: '0', overtime: [] }],
      });

      // 2. Configure heavyEmp with `leaveCategory: 'heavy'` (14 statutory days/year) and record 1.5 unpaid_leave + 12.5 annual_leave by Nov 2026
      // (11/12 * 14 = 12.83 prorated entitlement in Nov => 12.5 <= 12.83, whereas standard 12/year = 11 days in Nov would falsely flag 1.5 exceeded!).
      await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
        lineId: heavyLine.id,
        inputs: { ...heavyLine.inputs, leaveCategory: 'heavy' },
      });
      await o.exec(o.owner, 'hr.payroll.leave.set', {
        employeeId: heavyEmp.employeeId,
        month: '2026-11',
        kind: 'unpaid_leave',
        days: '1.5',
        approved: true,
      });
      await o.exec(o.owner, 'hr.payroll.leave.set', {
        employeeId: heavyEmp.employeeId,
        month: '2026-11',
        kind: 'annual_leave',
        days: '12.5',
        approved: true,
      });

      // 3. End leavingEmp on 2026-10-31 AFTER the 2026-11 draft run was opened:
      //    - Setting non-zero leave in 2026-11 refuses with HR_LEAVE_AFTER_END (422), while days = '0' cleanup stays allowed.
      //    - Syncing leave on 2026-11 skips leavingEmp's orphaned pay line instead of aborting the whole run sync.
      await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: leavingEmp.employeeId, endedOn: '2026-10-31' });
      await expect(
        o.exec(o.owner, 'hr.payroll.leave.set', {
          employeeId: leavingEmp.employeeId,
          month: '2026-11',
          kind: 'annual_leave',
          days: '1',
        }),
      ).rejects.toMatchObject({ code: 'HR_LEAVE_AFTER_END', status: 422 });
      const cleaned = await o.exec<HrLeaveWritten>(o.owner, 'hr.payroll.leave.set', {
        employeeId: leavingEmp.employeeId,
        month: '2026-11',
        kind: 'annual_leave',
        days: '0',
      });
      expect(cleaned.deleted).toBe(false);

      const syncRes = await o.exec<HrRunWritten>(o.admin, 'hr.payroll.run.sync_leave', { runId: novRun.runId });
      expect(syncRes.lines).toBe(1);

      const afterSync = await o.sheet(novRun.runId);
      const afterImported = afterSync.lines.find((l) => l.employeeId === importedEmp.employeeId)!;
      const afterHeavy = afterSync.lines.find((l) => l.employeeId === heavyEmp.employeeId)!;
      expect(afterImported.inputs.unpaidLeaveDays).toBe('3');
      expect(afterHeavy.inputs.unpaidLeaveDays).toBe('1.5');
      expect(afterHeavy.flags).not.toContain('annual_leave_exceeded');

      // Simulate pre-upgrade draft lines (no `unpaidLeaveFromLedger` key in stored JSONB):
      // - applying 13th-month bonus (`runApplyThirteenthMonth`) AND partial `import_timekeeping` on `importedEmp`
      //   do NOT mask `heavyEmp`'s synced leave provenance, so deleting `heavyEmp`'s leave entry still resets to '0';
      // - `importedEmp`'s pre-upgrade imported days ('3') survive repeated `sync_leave` calls.
      await withAdmin((c) =>
        c.query(`UPDATE ludy_hr.payroll_line SET inputs = inputs - 'unpaidLeaveFromLedger' WHERE org_id = $1 AND id = $2`, [
          o.orgId,
          afterHeavy.id,
        ]),
      );
      await o.exec(o.owner, 'hr.payroll.run.apply_thirteenth_month', {
        runId: novRun.runId,
        year: 2026,
        mode: 'replace',
        rows: [{ lineId: afterHeavy.id, workedMonths: '12' }],
      });
      await o.exec(o.owner, 'hr.payroll.run.import_timekeeping', {
        runId: novRun.runId,
        rows: [{ lineId: afterImported.id, unpaidLeaveDays: '3', daysNotEmployed: '0', nightHours: '0', overtime: [] }],
      });
      await withAdmin((c) =>
        c.query(`UPDATE ludy_hr.payroll_line SET inputs = inputs - 'unpaidLeaveFromLedger' WHERE org_id = $1 AND id = $2`, [
          o.orgId,
          afterImported.id,
        ]),
      );
      await o.exec(o.owner, 'hr.payroll.leave.set', {
        employeeId: heavyEmp.employeeId,
        month: '2026-11',
        kind: 'unpaid_leave',
        days: '0',
      });
      const legacyResetRes = await o.exec<HrRunWritten>(o.admin, 'hr.payroll.run.sync_leave', { runId: novRun.runId });
      expect(legacyResetRes.lines).toBe(1);
      // Second sync after stamping `unpaidLeaveFromLedger: false` on `importedEmp` keeps '3' untouched (0 updates).
      const secondLegacySync = await o.exec<HrRunWritten>(o.admin, 'hr.payroll.run.sync_leave', { runId: novRun.runId });
      expect(secondLegacySync.lines).toBe(0);
      const afterLegacyReset = await o.sheet(novRun.runId);
      expect(afterLegacyReset.lines.find((l) => l.employeeId === heavyEmp.employeeId)!.inputs.unpaidLeaveDays).toBe('0');
      expect(afterLegacyReset.lines.find((l) => l.employeeId === importedEmp.employeeId)!.inputs.unpaidLeaveDays).toBe('3');

      const sheetSummary: HrRunSummary = {
        id: novRun.runId,
        legalEntityId: afterSync.run.legalEntityId,
        month: '2026-11',
        status: 'draft',
        workingDays: afterSync.run.workingDays,
        lines: afterSync.lines.length,
        refused: 0,
        totals: afterSync.totals,
        approvedAt: null,
      };
      const lyReads: PayrollReads = {
        runs: async () => [sheetSummary],
        sheet: async () => afterSync,
        payslip: async () => {
          throw new Error('unused');
        },
      };
      const lyNov = await flagMonth({ reader: null, budget: new DraftBudget() }, lyReads, o.orgId, o.owner, novRun.runId, 'vi');
      expect(lyNov.items.some((i) => i.kind === 'annual_leave_exceeded')).toBe(false);

      // 4. Opening Dec 2026 copies recurring `leaveCategory: 'heavy'` forward, and custom `standardAnnualDays: '16'` is honored too.
      const decRun = await o.open('2026-12');
      const decSheet = await o.sheet(decRun.runId);
      const decHeavy = decSheet.lines.find((l) => l.employeeId === heavyEmp.employeeId)!;
      expect(decHeavy.inputs.leaveCategory).toBe('heavy');
      expect(decHeavy.inputs.unpaidLeaveFromLedger).toBe(false);

      // Taking another 2.5 days in Dec (total 15 > 14 heavy baseline) flags 1.0 exceeded day, until standardAnnualDays = '16' is set.
      await o.exec(o.owner, 'hr.payroll.leave.set', {
        employeeId: heavyEmp.employeeId,
        month: '2026-12',
        kind: 'annual_leave',
        days: '2.5',
        approved: true,
      });
      const decExceeded = (await o.sheet(decRun.runId)).lines.find((l) => l.employeeId === heavyEmp.employeeId)!;
      expect(decExceeded.flags).toContain('annual_leave_exceeded');
      expect(decExceeded.exceededAnnualDays).toBe('1');

      await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
        lineId: decHeavy.id,
        inputs: { ...decHeavy.inputs, standardAnnualDays: '16' },
      });
      const decCleared = (await o.sheet(decRun.runId)).lines.find((l) => l.employeeId === heavyEmp.employeeId)!;
      expect(decCleared.flags).not.toContain('annual_leave_exceeded');
    } finally {
      setRuleStatus('commentary');
    }
  });
});

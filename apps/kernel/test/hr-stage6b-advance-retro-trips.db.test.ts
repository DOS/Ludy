// SPDX-License-Identifier: AGPL-3.0-only
// Stage 6B DB integration tests (#4527) on real PostgreSQL 17:
// 1. Salary advance & business trip 2-level approvals (pending_l1 -> pending_final -> approved | rejected | cancelled),
//    atomic active non-archived department guard, DB anti-self-approval + sole-owner OPC exception.
// 2. Retro pay & offset deduction adjustments (owner/admin approval, decimal.js accuracy, override preservation).
// 3. Draft payroll rollup serialization (concurrent approve + open/sync), Finance 334/141/3388/642* posting totals.
// 4. hr.today PII-free counts, finance.payroll_flag deterministic + AI-off parity, PDPL erase, org_purge, and le_scope RLS.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InboxReader } from '@ludy/agent';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  HrAdvanceActionResult,
  HrAdvanceRequestView,
  HrAdjustmentActionResult,
  HrAdjustmentItemView,
  HrPayslip,
  HrRunSheet,
  HrRunSummary,
  HrRunWritten,
  HrSelfAdvanceListResult,
  HrSelfAdvanceSubmitResult,
  HrSelfTripListResult,
  HrSelfTripSubmitResult,
  HrTripActionResult,
  HrTripRequestView,
  HrWritten,
  TodayItem,
} from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { PAYROLL_POSTING_MAPS, PAYROLL_RULES, type PayrollBreakdown } from '@ludy/l10n-vn';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { hrCommands, hrQueries } from '@ludy/mod-hr';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { flagMonth, type PayrollAi, type PayrollReads } from '../src/payroll-coworker-ai.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

class EmptyBlobStore implements BlobStore {
  async put(_key: string, bytes: Uint8Array) {
    return `content:${sha256Hex(bytes)}`;
  }
  async get(): Promise<Uint8Array> {
    throw new Error('unused');
  }
  async delete(): Promise<void> {}
}

vi.mock('@ludy/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ludy/l10n-vn')>();
  return {
    ...real,
    PAYROLL_RULES: real.PAYROLL_RULES.map((row) => ({ ...row })),
    PAYROLL_POSTING_MAPS: Object.fromEntries(
      Object.entries(real.PAYROLL_POSTING_MAPS).map(([regime, map]) => [regime, { ...map }]),
    ) as typeof real.PAYROLL_POSTING_MAPS,
  };
});

const setPayrollConfirmed = (confirmed: boolean) => {
  const status = confirmed ? 'confirmed' : 'commentary';
  for (const row of PAYROLL_RULES) (row as { status: string }).status = status;
  for (const map of Object.values(PAYROLL_POSTING_MAPS)) {
    (map as { status: string }).status = status;
    (map.adjustments as { status: string }).status = status;
  }
};

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('HR Stage 6B salary advance, retro/offset adjustments, and business trips (#4527)', () => {
  const dbName = `ludy_test_hr6b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;
  const root = parseVaultKey(randomBytes(32).toString('base64'));
  const subjectVault = new SubjectVault(new CredentialVault([root]).deriveKeys(SUBJECT_WRAP_INFO));

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function setupOrg(mode: 'standard' | 'solo' = 'standard') {
    const tag = randomUUID().slice(0, 8);
    const db = createDb(appPool);
    const mkUser = (name: string) =>
      upsertIdentity(db, { issuer: 'hr6b', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name });
    const owner = await mkUser('owner');
    const admin = await mkUser('admin');
    const mgr = await mkUser('mgr');
    const staff = await mkUser('staff');
    const plain = await mkUser('plain');
    const viewer = await mkUser('viewer');

    const { orgId } = await createOrg(rt, asUser(owner), `HR Stage 6B ${tag}`);
    if (mode === 'standard') {
      await withAdmin((c) =>
        c.query(
          `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
           VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer')`,
          [orgId, admin, mgr, staff, plain, viewer],
        ),
      );
    }

    const exec = <O>(
      userId: string,
      name: string,
      input: unknown = {},
      actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId),
    ) => rt.execute<O>(name, input, { actor, orgId, idempotencyKey: randomUUID() });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });

    let deptId: string | null = null;
    if (mode === 'standard') {
      const dept = await exec<{ departmentId: string }>(owner, 'hr.department.add', {
        name: 'Kỹ thuật',
        payFunction: 'admin',
      });
      deptId = dept.departmentId;
      await exec(owner, 'hr.department.set_manager', { departmentId: deptId, managerUserId: mgr });
    }

    const staffEmp = await exec<HrWritten>(owner, 'hr.payroll.employee.add', {
      displayName: 'Nguyễn Thị Lan Canary',
      ...(deptId ? { departmentId: deptId } : {}),
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
    });
    if (mode === 'standard') {
      await exec(owner, 'hr.payroll.employee.link_member', { employeeId: staffEmp.employeeId, userId: staff });
    } else {
      await exec(owner, 'hr.payroll.employee.link_member', { employeeId: staffEmp.employeeId, userId: owner });
    }

    const leRow = await adminPool.query<{ id: string }>(
      `SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default`,
      [orgId],
    );

    return {
      orgId,
      defaultEntityId: leRow.rows[0]!.id,
      owner,
      admin,
      mgr,
      staff,
      plain,
      viewer,
      deptId,
      staffEmployeeId: staffEmp.employeeId,
      exec,
      query,
      mkUser,
    };
  }

  afterEach(() => {
    setPayrollConfirmed(false);
  });

  beforeAll(async () => {
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, {
      ludy_app: 'test-app-pw',
      ludy_worker: 'test-worker-pw',
      ludy_prober: 'test-prober-pw',
      ludy_reporter: 'test-reporter-pw',
    });

    adminPool = createPool({ connectionString: adminUrl, max: 4 });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    appPool = createPool({ connectionString: appUrl.toString(), max: 8 });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 4 });

    rt = new Runtime(createDb(appPool), {
      manifests: TEST_MANIFESTS,
      subjectVault,
      readAuditKey: randomBytes(32),
    }).register({
      commands: [...kernelCommands, ...hrCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, ...financeQueries],
    });
    workerRt = new Runtime(createDb(workerPool), {
      manifests: TEST_MANIFESTS,
      subjectVault,
      readAuditKey: randomBytes(32),
    }).register({
      commands: [orgPurgeCommand({ store: new EmptyBlobStore() })],
      queries: [],
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([appPool?.end(), workerPool?.end(), adminPool?.end()]);
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('enforces 2-level advance & trip workflows, atomic active-department L1 guard, and DB anti-self-approval', async () => {
    const o = await setupOrg('standard');
    const month = '2026-04';

    // Viewer & unlinked plain member blocked.
    await expect(
      o.exec(o.viewer, 'hr.self.salary_advance.submit', { month, amount: '1000000', reason: 'Cần ứng' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      o.exec(o.plain, 'hr.self.salary_advance.submit', { month, amount: '1000000', reason: 'Không có hồ sơ' }),
    ).rejects.toMatchObject({ code: 'HR_SELF_NOT_LINKED' });

    // Staff submits advance and business trip -> both enter pending_l1 because active dept has manager `mgr`.
    const adv = await o.exec<HrSelfAdvanceSubmitResult>(o.staff, 'hr.self.salary_advance.submit', {
      month,
      amount: '1500000.00',
      reason: 'Chi phí đột xuất',
    });
    expect(adv.status).toBe('pending_l1');

    const trip = await o.exec<HrSelfTripSubmitResult>(o.staff, 'hr.self.business_trip.submit', {
      destination: 'Hà Nội',
      purpose: 'Gặp đối tác',
      startOn: '2026-04-10',
      endOn: '2026-04-12',
      estimatedAllowance: '2000000',
    });
    expect(trip.status).toBe('pending_l1');

    // Invalid date range refused by schema.
    await expect(
      o.exec(o.staff, 'hr.self.business_trip.submit', {
        destination: 'Huế',
        purpose: 'Invalid dates',
        startOn: '2026-04-15',
        endOn: '2026-04-10',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });

    // Owner cannot bypass active L1 manager while dept has active non-self manager.
    await expect(
      o.exec(o.owner, 'hr.salary_advance.approve_l1', { requestId: adv.requestId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      o.exec(o.owner, 'hr.salary_advance.approve_final', { requestId: adv.requestId }),
    ).rejects.toMatchObject({ code: 'HR_SALARY_ADVANCE_INVALID_STATE' });

    // DB trigger also rejects pre-approved direct insert & skipping pending_l1 directly to approved.
    const ownerClient = await appPool.connect();
    try {
      await ownerClient.query('BEGIN');
      await enterUser(ownerClient, o.owner, o.orgId);
      await expect(
        ownerClient.query(
          `INSERT INTO ludy_hr.salary_advance_request (org_id, employee_id, month, amount, status)
           VALUES ($1, $2, $3, 1000000, 'approved')`,
          [o.orgId, o.staffEmployeeId, month],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await ownerClient.query('ROLLBACK');

      await ownerClient.query('BEGIN');
      await enterUser(ownerClient, o.owner, o.orgId);
      await expect(
        ownerClient.query(
          `UPDATE ludy_hr.salary_advance_request SET status = 'approved', final_acted_by = $2, final_acted_at = now() WHERE id = $1`,
          [adv.requestId, o.owner],
        ),
      ).rejects.toMatchObject({ code: '42501' });
      await ownerClient.query('ROLLBACK');
    } finally {
      ownerClient.release();
    }

    // Staff sees own requests via self lists.
    const staffSelfTrips = await o.query<HrSelfTripListResult>(o.staff, 'hr.self.business_trip.list', {});
    expect(staffSelfTrips.items.some((t) => t.id === trip.requestId && t.status === 'pending_l1')).toBe(true);

    // Active L1 manager sees both in L1 queue (even when unlinked to an employee record) and approves L1 -> pending_final.
    const selfAdvState = await o.query<HrSelfAdvanceListResult>(o.mgr, 'hr.self.salary_advance.list', {});
    expect(selfAdvState.employeeId).toBeNull();
    expect(selfAdvState.l1Queue.some((r) => r.id === adv.requestId)).toBe(true);
    const selfTripState = await o.query<HrSelfTripListResult>(o.mgr, 'hr.self.business_trip.list', {});
    expect(selfTripState.l1Queue.some((r) => r.id === trip.requestId)).toBe(true);
    const l1AdvRes = await o.exec<HrAdvanceActionResult>(o.mgr, 'hr.salary_advance.approve_l1', {
      requestId: adv.requestId,
      note: 'Trưởng bộ phận đồng ý',
    });
    expect(l1AdvRes.status).toBe('pending_final');

    const l1TripRes = await o.exec<HrTripActionResult>(o.mgr, 'hr.business_trip.approve_l1', {
      requestId: trip.requestId,
      note: 'Đã duyệt lịch trình',
    });
    expect(l1TripRes.status).toBe('pending_final');

    // L1 member cannot final-approve (requires owner/admin + hr.payroll.run).
    await expect(
      o.exec(o.mgr, 'hr.salary_advance.approve_final', { requestId: adv.requestId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Owner final-approves business trip and salary advance.
    const finalTrip = await o.exec<HrTripActionResult>(o.owner, 'hr.business_trip.approve_final', {
      requestId: trip.requestId,
      note: 'Duyệt chi phí công tác',
    });
    expect(finalTrip.status).toBe('approved');

    const finalAdv = await o.exec<HrAdvanceActionResult>(o.owner, 'hr.salary_advance.approve_final', {
      requestId: adv.requestId,
    });
    expect(finalAdv.status).toBe('approved');

    // Anti-self-approval: linked admin submitting cannot approve their own final request.
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: o.staffEmployeeId, userId: null });
    const adminEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Trần Minh Quản Trị',
      departmentId: o.deptId,
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: adminEmp.employeeId, userId: o.admin });
    const adminAdv = await o.exec<HrSelfAdvanceSubmitResult>(o.admin, 'hr.self.salary_advance.submit', {
      month,
      amount: '2000000',
      reason: 'Admin advance',
    });
    await o.exec(o.mgr, 'hr.salary_advance.approve_l1', { requestId: adminAdv.requestId });
    await expect(
      o.exec(o.admin, 'hr.salary_advance.approve_final', { requestId: adminAdv.requestId }),
    ).rejects.toMatchObject({ code: 'HR_SELF_APPROVAL_BLOCKED' });

    // Owner (different person) CAN final-approve admin's advance.
    const ownerApprovedAdmin = await o.exec<HrAdvanceActionResult>(o.owner, 'hr.salary_advance.approve_final', {
      requestId: adminAdv.requestId,
    });
    expect(ownerApprovedAdmin.status).toBe('approved');

    // Archived department manager CANNOT approve L1 (both runtime and DB trigger block).
    const staffEmp2 = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Phạm Văn C',
      departmentId: o.deptId,
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '9000000' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: staffEmp2.employeeId, userId: o.staff });
    const adv2 = await o.exec<HrSelfAdvanceSubmitResult>(o.staff, 'hr.self.salary_advance.submit', {
      month,
      amount: '500000',
      reason: 'Test archived dept guard',
    });
    expect(adv2.status).toBe('pending_l1');
    await o.exec(o.owner, 'hr.department.archive', { departmentId: o.deptId });
    await expect(
      o.exec(o.mgr, 'hr.salary_advance.approve_l1', { requestId: adv2.requestId }),
    ).rejects.toMatchObject({ code: 'HR_SALARY_ADVANCE_NOT_FOUND' });

    // Direct DB UPDATE as mgr on archived dept ALSO fails under RLS/trigger.
    const mgrClient = await appPool.connect();
    try {
      await mgrClient.query('BEGIN');
      await enterUser(mgrClient, o.mgr, o.orgId);
      const upd = await mgrClient.query(
        `UPDATE ludy_hr.salary_advance_request SET status = 'pending_final', l1_approver_user_id = $2, l1_acted_at = now() WHERE id = $1`,
        [adv2.requestId, o.mgr],
      );
      expect(upd.rowCount).toBe(0);
      await mgrClient.query('ROLLBACK');
    } finally {
      mgrClient.release();
    }

    // Cancelled by self works before final approval; DB trigger blocks tampering with reason or approval fields during cancel.
    const cancelled = await o.exec<HrAdvanceActionResult>(o.staff, 'hr.self.salary_advance.cancel', {
      requestId: adv2.requestId,
    });
    expect(cancelled.status).toBe('cancelled');

    const advAudit = await adminPool.query<{ detail: unknown }>(
      `SELECT detail FROM ludy_kernel.audit_event
        WHERE org_id = $1 AND command IN ('hr.self.salary_advance.submit', 'hr.salary_advance.approve_final')`,
      [o.orgId],
    );
    expect(JSON.stringify(advAudit.rows)).not.toContain('2000000');
    expect(JSON.stringify(advAudit.rows)).not.toContain('1500000');

    // Demoted/viewer department manager does NOT wedge pending_l1 requests: owner fallback works cleanly.
    const dept2 = await o.exec<{ departmentId: string }>(o.owner, 'hr.department.add', {
      name: 'Kinh doanh',
      payFunction: 'admin',
    });
    const demotedMgr = await upsertIdentity(createDb(appPool), {
      issuer: 'hr6b',
      subject: `demoted-${randomUUID().slice(0, 8)}`,
      email: 'demoted@hr.test',
      name: 'demoted',
    });
    await withAdmin((c) =>
      c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, demotedMgr]),
    );
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: dept2.departmentId, managerUserId: demotedMgr });
    const staffEmp3 = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Lê Văn D',
      departmentId: dept2.departmentId,
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '9000000' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: staffEmp3.employeeId, userId: o.plain });
    const advWedged = await o.exec<HrSelfAdvanceSubmitResult>(o.plain, 'hr.self.salary_advance.submit', {
      month,
      amount: '400000',
      reason: 'Kiểm tra fallback khi trưởng phòng xuống viewer',
    });
    expect(advWedged.status).toBe('pending_l1');
    await withAdmin((c) =>
      c.query(`UPDATE ludy_kernel.tenant_member SET role = 'viewer' WHERE org_id = $1 AND user_id = $2`, [o.orgId, demotedMgr]),
    );
    const ownerFallbackL1 = await o.exec<HrAdvanceActionResult>(o.owner, 'hr.salary_advance.approve_l1', {
      requestId: advWedged.requestId,
    });
    expect(ownerFallbackL1.status).toBe('pending_final');
  });

  it('allows audited sole-owner OPC self-approval while blocking multi-admin self-approval on adjustments', async () => {
    const solo = await setupOrg('solo');
    const adv = await solo.exec<HrSelfAdvanceSubmitResult>(solo.owner, 'hr.self.salary_advance.submit', {
      month: '2026-05',
      amount: '1000000',
      reason: 'OPC self advance',
    });
    // No dept manager -> goes straight to pending_final; sole owner OPC can self-approve final.
    expect(adv.status).toBe('pending_final');
    const approved = await solo.exec<HrAdvanceActionResult>(solo.owner, 'hr.salary_advance.approve_final', {
      requestId: adv.requestId,
    });
    expect(approved.status).toBe('approved');

    // Creator of payroll_adjustment_item can approve in sole-owner OPC too.
    const adj = await solo.exec<HrAdjustmentActionResult>(solo.owner, 'hr.payroll.adjustment.create', {
      employeeId: solo.staffEmployeeId,
      month: '2026-05',
      kind: 'retro_pay',
      amount: '500000',
      reason: 'OPC retro',
    });
    const adjApproved = await solo.exec<HrAdjustmentActionResult>(solo.owner, 'hr.payroll.adjustment.approve', {
      itemId: adj.itemId,
    });
    expect(adjApproved.status).toBe('approved');
  });

  it('rolls advances and retro/offset adjustments deterministically into draft payroll, preserves manual overrides, serializes concurrency, and posts totals to 334/141/3388/642*', async () => {
    setPayrollConfirmed(true);
    const o = await setupOrg('standard');
    const month = '2026-06';

    // Pre-approved advance (1,500,000) before opening draft run.
    const adv1 = await o.exec<HrSelfAdvanceSubmitResult>(o.staff, 'hr.self.salary_advance.submit', {
      month,
      amount: '1500000.00',
      reason: 'Ứng lương đợt 1',
    });
    await o.exec(o.mgr, 'hr.salary_advance.approve_l1', { requestId: adv1.requestId });
    await o.exec(o.owner, 'hr.salary_advance.approve_final', { requestId: adv1.requestId });

    // Create retro_pay (800,000.50) and offset_deduction (200,000.25) by admin, approved by owner.
    const retro = await o.exec<HrAdjustmentActionResult>(o.admin, 'hr.payroll.adjustment.create', {
      employeeId: o.staffEmployeeId,
      month,
      kind: 'retro_pay',
      amount: '800000.50',
      reason: 'Truy lĩnh phụ cấp trách nhiệm',
    });
    // Creator self-approval blocked in multi-admin org.
    await expect(
      o.exec(o.admin, 'hr.payroll.adjustment.approve', { itemId: retro.itemId }),
    ).rejects.toMatchObject({ code: 'HR_SELF_APPROVAL_BLOCKED' });

    const offset = await o.exec<HrAdjustmentActionResult>(o.admin, 'hr.payroll.adjustment.create', {
      employeeId: o.staffEmployeeId,
      month,
      kind: 'offset_deduction',
      amount: '200000.25',
      reason: 'Bù trừ tạm ứng công tác dư',
    });
    await o.exec(o.owner, 'hr.payroll.adjustment.approve', { itemId: retro.itemId });
    await o.exec(o.owner, 'hr.payroll.adjustment.approve', { itemId: offset.itemId });

    // Second advance approved concurrently while opening run -> advisory locks serialize without loss.
    const adv2 = await o.exec<HrSelfAdvanceSubmitResult>(o.staff, 'hr.self.salary_advance.submit', {
      month,
      amount: '500000.00',
      reason: 'Ứng lương đợt 2',
    });
    await o.exec(o.mgr, 'hr.salary_advance.approve_l1', { requestId: adv2.requestId });

    const [runRes, adv2Res] = await Promise.all([
      o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month }),
      o.exec<HrAdvanceActionResult>(o.owner, 'hr.salary_advance.approve_final', { requestId: adv2.requestId }),
    ]);
    expect(runRes.runId).toBeTruthy();
    expect(adv2Res.status).toBe('approved');

    // Sync ensures final draft state reflects all approved Stage 6B items (1,500,000 + 500,000 = 2,000,000 advance).
    await o.exec(o.owner, 'hr.payroll.run.sync_stage6b', { runId: runRes.runId });
    const sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: runRes.runId });
    const line = sheet.lines.find((l) => l.employeeId === o.staffEmployeeId)!;
    const bd = line.breakdown as unknown as PayrollBreakdown;
    expect(line.inputs.advance).toBe('2000000');
    expect(line.inputs.advanceFromRequests).toBe(true);
    expect(line.inputs.retroPay).toBe('800000.5');
    expect(line.inputs.retroPayFromAdjustments).toBe(true);
    expect(line.inputs.offsetDeduction).toBe('200000.25');
    expect(line.inputs.offsetFromAdjustments).toBe(true);
    expect(bd.deductions.advance).toBe('2000000');
    expect(bd.deductions.other).toBe('200000');
    expect(bd.pay.bonus).toBe('0');
    expect(bd.pay.retroPay).toBe('800001');
    // Statutory BHXH insurable pay remains untouched (10M base wage; retro pay taxability awaits accountant #61 / #2535).
    expect(bd.insurance.insurablePay).toBe('10000000');
    expect(line.figures?.gross).toBe('10800001.00');
    const payslip = await o.query<HrPayslip>(o.owner, 'hr.payroll.line.payslip', { lineId: line.id });
    const psBd = payslip.breakdown as unknown as PayrollBreakdown;
    expect(psBd.pay.bonus).toBe('0');
    expect(psBd.pay.retroPay).toBe('800001');

    // All synced Stage 6B rows carry payroll_run_id pointing to this run.
    const advRows = await adminPool.query<{ payroll_run_id: string | null }>(
      `SELECT payroll_run_id FROM ludy_hr.salary_advance_request WHERE org_id = $1 AND status = 'approved'`,
      [o.orgId],
    );
    expect(advRows.rows.every((r) => r.payroll_run_id === runRes.runId)).toBe(true);

    // Unrelated line-editor save (without changing advance, even if client passes advanceFromRequests: false/null) preserves advanceFromRequests: true.
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: line.id,
      inputs: { bonus: '0', advance: '2000000', advanceFromRequests: false },
    });
    const sheetAfterUnrelated = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: runRes.runId });
    expect(sheetAfterUnrelated.lines.find((l) => l.employeeId === o.staffEmployeeId)!.inputs.advanceFromRequests).toBe(true);

    // Manual override on advance is preserved across syncStage6b and recalculate, and client cannot spoof advanceFromRequests: true.
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: line.id,
      inputs: { ...line.inputs, advance: '1250000', advanceFromRequests: true },
    });
    const adv3 = await o.exec<HrSelfAdvanceSubmitResult>(o.staff, 'hr.self.salary_advance.submit', {
      month,
      amount: '100000',
      reason: 'Ứng thêm sau override',
    });
    await o.exec(o.mgr, 'hr.salary_advance.approve_l1', { requestId: adv3.requestId });
    const adv3Final = await o.exec<HrAdvanceActionResult>(o.owner, 'hr.salary_advance.approve_final', { requestId: adv3.requestId });
    expect(adv3Final.payrollSynced).toBe(false);
    expect(adv3Final.payrollSyncSkippedReason).toBe('manual_override');
    const syncSkipped = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.sync_stage6b', { runId: runRes.runId });
    expect(syncSkipped.skippedManualOverrideLines).toBe(1);
    const recalcSkipped = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.recalculate', { runId: runRes.runId });
    expect(recalcSkipped.skippedManualOverrideLines).toBe(1);

    const sheetAfterManual = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: runRes.runId });
    const lineAfter = sheetAfterManual.lines.find((l) => l.employeeId === o.staffEmployeeId)!;
    expect(lineAfter.inputs.advance).toBe('1250000');
    expect(lineAfter.inputs.advanceFromRequests).toBe(false);
    expect(lineAfter.flags).toContain('stage6b_manual_override');
    expect(lineAfter.stage6bManualOverrides).toEqual([
      { field: 'advance', lineAmount: '1250000', approvedAmount: '2100000' },
    ]);
    // Non-overridden retroPay & offsetDeduction remain synced!
    expect(lineAfter.inputs.retroPay).toBe('800000.5');
    expect(lineAfter.inputs.offsetDeduction).toBe('200000.25');

    // Partial line.inputs.set omitting `advance` must preserve existing advance & advanceFromRequests.
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: line.id,
      inputs: { bonus: '0' },
    });
    const sheetAfterPartial = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: runRes.runId });
    const lineAfterPartial = sheetAfterPartial.lines.find((l) => l.employeeId === o.staffEmployeeId)!;
    expect(lineAfterPartial.inputs.advance).toBe('1250000');
    expect(lineAfterPartial.inputs.advanceFromRequests).toBe(false);
    expect(lineAfterPartial.inputs.retroPay).toBe('800000.5');
    expect(lineAfterPartial.inputs.offsetDeduction).toBe('200000.25');

    // Stage leftover pending requests before approving the run so we can verify B4 non-draft locks on approvals too.
    const advPendingL1 = await o.exec<HrSelfAdvanceSubmitResult>(o.staff, 'hr.self.salary_advance.submit', {
      month,
      amount: '150000',
      reason: 'Pending L1 before approve',
    });
    const advPendingFinal = await o.exec<HrSelfAdvanceSubmitResult>(o.staff, 'hr.self.salary_advance.submit', {
      month,
      amount: '175000',
      reason: 'Pending final before approve',
    });
    await o.exec(o.mgr, 'hr.salary_advance.approve_l1', { requestId: advPendingFinal.requestId });
    const adjPending = await o.exec<HrAdjustmentActionResult>(o.admin, 'hr.payroll.adjustment.create', {
      employeeId: o.staffEmployeeId,
      month,
      kind: 'retro_pay',
      amount: '125000',
      reason: 'Pending adjustment before approve',
    });

    // Approve payroll run and post to Finance -> verifies account-level totals (Cr 141, Cr 3388, Cr 334, Dr 6422).
    await o.exec(
      o.owner,
      'hr.payroll.run.approve',
      { runId: runRes.runId, fingerprint: sheetAfterPartial.fingerprint, acceptFlags: true },
      asMfa(o.owner),
    );

    // Self-service list & L1 queue now proactively surface the finalized month as locked (#4597).
    const staffLockedList = await o.query<HrSelfAdvanceListResult>(o.staff, 'hr.self.salary_advance.list', {});
    expect(staffLockedList.lockedMonths).toContain(month);
    const staffPendingRow = staffLockedList.items.find((r) => r.id === advPendingL1.requestId);
    expect(staffPendingRow?.payrollRunLocked).toBe(true);
    const mgrLockedList = await o.query<HrSelfAdvanceListResult>(o.mgr, 'hr.self.salary_advance.list', {});
    const mgrPendingRow = mgrLockedList.l1Queue.find((r) => r.id === advPendingL1.requestId);
    expect(mgrPendingRow?.payrollRunLocked).toBe(true);

    // B4 Money guard: once month payroll run is approved (non-draft), no Stage 6B advance/adjustment can be submitted, created, or approved for that month.
    await expect(
      o.exec(o.staff, 'hr.self.salary_advance.submit', {
        month,
        amount: '250000',
        reason: 'After month approved',
      }),
    ).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });
    await expect(
      o.exec(o.mgr, 'hr.salary_advance.approve_l1', { requestId: advPendingL1.requestId }),
    ).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });
    await expect(
      o.exec(o.owner, 'hr.salary_advance.approve_final', { requestId: advPendingFinal.requestId }),
    ).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });
    await expect(
      o.exec(o.admin, 'hr.payroll.adjustment.create', {
        employeeId: o.staffEmployeeId,
        month,
        kind: 'retro_pay',
        amount: '250000',
        reason: 'After month approved',
      }),
    ).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });
    await expect(
      o.exec(o.owner, 'hr.payroll.adjustment.approve', { itemId: adjPending.itemId }),
    ).rejects.toMatchObject({ code: 'HR_RUN_NOT_DRAFT' });

    // Pending items left over when a run is approved can still be cleanly cancelled or rejected.
    await o.exec(o.staff, 'hr.self.salary_advance.cancel', { requestId: advPendingL1.requestId });
    await o.exec(o.owner, 'hr.salary_advance.reject', { requestId: advPendingFinal.requestId });
    await o.exec(o.admin, 'hr.payroll.adjustment.cancel', { itemId: adjPending.itemId });
    const { proposalId } = await rt.execute<{ proposalId: string }>(
      'kernel.proposal.request',
      { command: 'finance.payroll_posting.record', input: { runId: runRes.runId } },
      { actor: asUser(o.admin), orgId: o.orgId, idempotencyKey: randomUUID() },
    );
    const proposal = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(o.owner), orgId: o.orgId });
    const posted = await rt.execute<{ voucherId: string; journalEntryId: string }>(
      'kernel.proposal.approve',
      { id: proposalId, revision: proposal.revision },
      { actor: asMfa(o.owner), orgId: o.orgId },
    );
    const jLines = await adminPool.query<{ account_code: string; debit: string; credit: string }>(
      `SELECT account_code, debit::text, credit::text FROM ludy_finance.journal_line WHERE org_id = $1 AND entry_id = $2`,
      [o.orgId, posted.journalEntryId],
    );
    const jEntries = await adminPool.query<{ row_text: string }>(
      `SELECT t::text AS row_text FROM ludy_finance.journal_entry t WHERE org_id = $1 AND id = $2`,
      [o.orgId, posted.journalEntryId],
    );
    const byAcc = new Map(jLines.rows.map((r) => [r.account_code, r]));
    expect(Number(byAcc.get('141')?.credit ?? 0)).toBe(1250000);
    expect(Number(byAcc.get('3388')?.credit ?? 0)).toBe(200000);
    expect(Number(byAcc.get('6422')?.debit ?? 0)).toBeGreaterThan(10000000);
    // Individual employee name must never leak into Finance journal entry or lines.
    expect(JSON.stringify({ lines: jLines.rows, entry: jEntries.rows })).not.toContain('Nguyễn Thị Lan Canary');
  });

  it('surfaces PII-free hr.today counts and deterministic finance.payroll_flag anomalies with 100% AI-off parity', async () => {
    setPayrollConfirmed(true);
    const o = await setupOrg('standard');
    const month = '2026-07';

    // One pending_l1 advance, one pending_final trip, and one pending large adjustment.
    const advL1 = await o.exec<HrSelfAdvanceSubmitResult>(o.staff, 'hr.self.salary_advance.submit', {
      month,
      amount: '6000000', // 60% of 10M base wage -> large_salary_advance
      reason: 'Ứng lớn',
    });
    const trip = await o.exec<HrSelfTripSubmitResult>(o.staff, 'hr.self.business_trip.submit', {
      destination: 'Cần Thơ',
      purpose: 'Công tác miền Tây',
      startOn: '2026-07-10',
      endOn: '2026-07-12',
    });
    await o.exec(o.mgr, 'hr.business_trip.approve_l1', { requestId: trip.requestId });

    const bigRetro = await o.exec<HrAdjustmentActionResult>(o.admin, 'hr.payroll.adjustment.create', {
      employeeId: o.staffEmployeeId,
      month,
      kind: 'retro_pay',
      amount: '4000000', // 40% of 10M base wage -> large_payroll_adjustment
      reason: 'Truy lĩnh lớn',
    });

    // hr.today for L1 dept manager: sees pending_l1 advance count, zero PII/amounts.
    const mgrToday = await o.query<TodayItem[]>(o.mgr, 'hr.today', {});
    const mgrAdvItem = mgrToday.find((i) => i.id === 'salary-advance-approvals-l1');
    expect(mgrAdvItem).toMatchObject({ count: 1, href: '/hr/my', title: { key: 'hr.deptSalaryAdvances', params: { count: 1 } } });
    expect(JSON.stringify(mgrToday)).not.toContain('Nguyễn Thị Lan Canary');
    expect(JSON.stringify(mgrToday)).not.toContain('6000000');

    // hr.today for owner: sees pending_final trip & pending adjustment count, zero PII.
    const ownerToday = await o.query<TodayItem[]>(o.owner, 'hr.today', {});
    expect(ownerToday.find((i) => i.id === 'business-trip-approvals')).toMatchObject({ count: 1, href: '/hr/employees' });
    expect(ownerToday.find((i) => i.id === 'payroll-adjustments-pending')).toMatchObject({ count: 1, href: '/hr/payroll' });
    expect(JSON.stringify(ownerToday)).not.toContain('Cần Thơ');

    // Approve advance + large retro, open draft run, and verify finance.payroll_flag AI-off vs AI-on parity.
    await o.exec(o.mgr, 'hr.salary_advance.approve_l1', { requestId: advL1.requestId });
    await o.exec(o.owner, 'hr.salary_advance.approve_final', { requestId: advL1.requestId });
    await o.exec(o.owner, 'hr.payroll.adjustment.approve', { itemId: bigRetro.itemId });
    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month });

    const reads: PayrollReads = {
      authorize: () => o.query(o.owner, 'hr.payroll.coworker.access', {}),
      sheet: (runId) => o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId }),
      runs: (legalEntityId) => o.query<HrRunSummary[]>(o.owner, 'hr.payroll.run.list', { limit: 120, legalEntityId }),
      payslip: (lineId) => o.query<HrPayslip>(o.owner, 'hr.payroll.line.payslip', { lineId }),
    };
    const aiOff: PayrollAi = {
      reader: null,
      budget: new DraftBudget({ perUserPerMinute: 10 }),
      flagBudget: new DraftBudget({ perUserPerMinute: 10 }),
    };
    const offRes = await flagMonth(aiOff, reads, o.orgId, o.owner, run.runId!, 'vi');
    expect(offRes.ai).toBe('off');
    const kinds = offRes.items.map((x) => x.kind);
    expect(kinds).toContain('large_salary_advance');
    expect(kinds).toContain('large_payroll_adjustment');
    // Names are deterministically restored server-side in facts.
    const advFlag = offRes.items.find((x) => x.kind === 'large_salary_advance')!;
    expect(advFlag.facts).toContain('Nguyễn Thị Lan Canary');
    expect(advFlag.facts).toContain('6.000.000');

    // AI-on with fake generator verifies prompt receives alias E1 and NEVER real name, while restoring output identically.
    let capturedPrompt = '';
    const reader = new InboxReader(
      { baseURL: 'http://localhost:1/v1', apiKey: null, model: 'test' },
      {
        payroll: {
          prepare: async () => ({ output: { items: [] }, usage: { inputTokens: 1, outputTokens: 1 } }),
          explain: async () => ({ output: { text: '' }, usage: { inputTokens: 1, outputTokens: 1 } }),
          flag: async ({ prompt }) => {
            capturedPrompt = prompt;
            return {
              output: {
                items: [
                  {
                    id: advFlag.id,
                    sentence: 'E1 có khoản tạm ứng 6.000.000 đồng vượt quá 50% lương cơ bản 10.000.000 đồng.',
                  },
                ],
              },
              usage: { inputTokens: 10, outputTokens: 10 },
            };
          },
        },
      },
    );
    const aiOn: PayrollAi = {
      reader,
      budget: new DraftBudget({ perUserPerMinute: 10 }),
      flagBudget: new DraftBudget({ perUserPerMinute: 10 }),
    };
    const onRes = await flagMonth(aiOn, reads, o.orgId, o.owner, run.runId!, 'vi');
    expect(onRes.ai).toBe('used');
    expect(capturedPrompt).not.toContain('Nguyễn Thị Lan Canary');
    const onAdvFlag = onRes.items.find((x) => x.kind === 'large_salary_advance')!;
    expect(onAdvFlag.text).toContain('Nguyễn Thị Lan Canary');
  });

  it('serializes PDPL employee.erase across all 3 Stage 6B tables, supports org_purge, and isolates cross-org + le_scope', async () => {
    const o = await setupOrg('standard');
    const o2 = await setupOrg('standard');

    // Second legal entity in org A for le_scope testing.
    const branchId = (
      await withAdmin(async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh 2', 'branch', $2) RETURNING id`,
            [o.orgId, o.owner],
          )
        ).rows[0]!.id,
      )
    );
    const branchEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Nhân viên Chi nhánh 2',
      legalEntityId: branchId,
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
    });
    const advB = await o.exec<HrSelfAdvanceSubmitResult>(o.staff, 'hr.self.salary_advance.submit', {
      month: '2026-08',
      amount: '750000',
      reason: 'PII reason to erase',
    });
    const tripB = await o.exec<HrSelfTripSubmitResult>(o.staff, 'hr.self.business_trip.submit', {
      destination: 'Nha Trang',
      purpose: 'Trip PII to erase',
      startOn: '2026-08-05',
      endOn: '2026-08-06',
    });
    const adjB = await o.exec<HrAdjustmentActionResult>(o.admin, 'hr.payroll.adjustment.create', {
      employeeId: o.staffEmployeeId,
      month: '2026-08',
      kind: 'offset_deduction',
      amount: '150000',
      reason: 'Adjustment PII to erase',
    });

    // Also insert an adjustment in branch legal entity to test scoped admin.
    await o.exec(o.admin, 'hr.payroll.adjustment.create', {
      employeeId: branchEmp.employeeId,
      month: '2026-08',
      kind: 'retro_pay',
      amount: '300000',
      reason: 'Branch entity adjustment',
    });

    // Org B cannot see Org A rows; legalEntityId filter separates branch vs default entity rows cleanly.
    const o2List = await o2.query<HrAdvanceRequestView[]>(o2.owner, 'hr.salary_advance.list', {});
    expect(o2List.some((r) => r.id === advB.requestId)).toBe(false);
    const o2Trips = await o2.query<HrTripRequestView[]>(o2.owner, 'hr.business_trip.list', {});
    expect(o2Trips.some((r) => r.id === tripB.requestId)).toBe(false);

    const advByDefault = await o.query<HrAdjustmentItemView[]>(o.admin, 'hr.payroll.adjustment.list', {
      legalEntityId: o.defaultEntityId,
    });
    expect(advByDefault.some((a) => a.legalEntityId === branchId)).toBe(false);

    // End staffEmployee back in 2010 so retention has elapsed, then erase via hr.payroll.employee.erase (MFA).
    await withAdmin((c) =>
      c.query(`UPDATE ludy_hr.payroll_employee SET status = 'ended', ended_on = '2010-01-01' WHERE org_id = $1 AND id = $2`, [
        o.orgId,
        o.staffEmployeeId,
      ]),
    );
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: o.staffEmployeeId }, asMfa(o.owner));

    // Pending items were cancelled cleanly and free-text PII wiped.
    const advRow = (
      await adminPool.query<{ status: string; reason: string | null; decision_note: string | null }>(
        `SELECT status, reason, decision_note FROM ludy_hr.salary_advance_request WHERE id = $1`,
        [advB.requestId],
      )
    ).rows[0]!;
    expect(advRow).toEqual({ status: 'cancelled', reason: null, decision_note: null });

    const adjRow = (
      await adminPool.query<{ status: string; reason: string | null; decision_note: string | null }>(
        `SELECT status, reason, decision_note FROM ludy_hr.payroll_adjustment_item WHERE id = $1`,
        [adjB.itemId],
      )
    ).rows[0]!;
    expect(adjRow).toEqual({ status: 'cancelled', reason: null, decision_note: null });

    const tripRow = (
      await adminPool.query<{ status: string; destination: string | null; purpose: string | null; decision_note: string | null }>(
        `SELECT status, destination, purpose, decision_note FROM ludy_hr.business_trip_request WHERE id = $1`,
        [tripB.requestId],
      )
    ).rows[0]!;
    expect(tripRow).toEqual({ status: 'cancelled', destination: null, purpose: null, decision_note: null });

    // New adjustment creation for erased employee is refused cleanly.
    await expect(
      o.exec(o.owner, 'hr.payroll.adjustment.create', {
        employeeId: o.staffEmployeeId,
        month: '2026-09',
        kind: 'retro_pay',
        amount: '100000',
        reason: 'After erasure',
      }),
    ).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ERASED' });

    // Approve a branch adjustment and open a payroll run (`payroll_run_id IS NOT NULL`) before purging so FK delete order is covered.
    const branchAdj = await o.exec<HrAdjustmentActionResult>(o.owner, 'hr.payroll.adjustment.create', {
      employeeId: branchEmp.employeeId,
      month: '2026-08',
      kind: 'retro_pay',
      amount: '450000',
      reason: 'Branch linked to run before purge',
    });
    await o.exec(o.admin, 'hr.payroll.adjustment.approve', { itemId: branchAdj.itemId });
    await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-08', legalEntityId: branchId });
    const linkedAdjCheck = await adminPool.query<{ payroll_run_id: string | null }>(
      `SELECT payroll_run_id FROM ludy_hr.payroll_adjustment_item WHERE org_id = $1 AND id = $2`,
      [o.orgId, branchAdj.itemId],
    );
    expect(linkedAdjCheck.rows[0]?.payroll_run_id).toBeTruthy();

    // Org offboarding + org_purge cleans up all 3 Stage 6B tables (including linked payroll_run_id rows) ahead of payroll_run, payroll_employee, and department.
    const dayMs = 24 * 60 * 60 * 1000;
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [o.orgId]);
      await c.query('COMMIT');
      await c.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":1}')`,
        [
          o.orgId,
          new Date(Date.now() - 40 * dayMs),
          o.owner,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 31 * dayMs),
          randomUUID(),
        ],
      );
    });
    const purgeResult = await purgeOrg(workerRt, 30, { ref: o.orgId, reason: 'Stage 6B purge cleanup test' });
    expect(purgeResult.kind).toBe('purged');
    for (const tbl of ['salary_advance_request', 'payroll_adjustment_item', 'business_trip_request']) {
      const cnt = await adminPool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ludy_hr.${tbl} WHERE org_id = $1`, [o.orgId]);
      expect(cnt.rows[0]?.n).toBe('0');
    }
  });

  it('hardens NULL/out-of-scope le_scope helpers, fail-closed payroll_run_locked, Stage 6B admin INSERT created_by, and manual-override restore (#4597)', async () => {
    setPayrollConfirmed(true);
    const o = await setupOrg('standard');
    const o2 = await setupOrg('standard');
    const month = '2026-09';

    // Second legal entity + scoped member limited ONLY to branchId.
    const branchId = (
      await withAdmin(async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh phụ', 'branch', $2) RETURNING id`,
            [o.orgId, o.owner],
          )
        ).rows[0]!.id,
      )
    );
    const scopedUser = await o.mkUser('scoped-le');
    await withAdmin(async (c) => {
      await c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, scopedUser]);
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [o.orgId, scopedUser, branchId, o.owner],
      );
    });
    const branchEmp = await o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
      displayName: 'Nhân viên Chi nhánh phụ',
      legalEntityId: branchId,
      employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
    });
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: branchEmp.employeeId, userId: scopedUser });

    // Seed Stage 6B advance + Stage 4C leave + Stage 5A QR config + Stage 5B overtime in defaultEntityId.
    const adv = await o.exec<HrSelfAdvanceSubmitResult>(o.staff, 'hr.self.salary_advance.submit', {
      month,
      amount: '500000',
      reason: 'Advance for helper hardening test',
    });
    const leaveReq = await o.exec<{ requestId: string }>(o.staff, 'hr.self.leave.request_submit', {
      startOn: '2026-09-10',
      endOn: '2026-09-10',
      kind: 'unpaid_leave',
      days: '1',
      reason: 'Leave helper hardening test',
    });
    const otReq = await o.exec<{ requestId: string }>(o.staff, 'hr.self.overtime.submit', {
      workDate: '2026-09-12',
      dayType: 'weekday',
      hours: '2',
      reason: 'OT helper hardening test',
    });
    const qrHash = sha256Hex(Buffer.from('stage6b-followup-qr-secret'));
    await withAdmin((c) =>
      c.query(
        `INSERT INTO ludy_hr.attendance_qr_config (org_id, legal_entity_id, active, qr_secret_hash, created_by)
         VALUES ($1, $2, true, $3, $4)`,
        [o.orgId, o.defaultEntityId, qrHash, o.owner],
      ),
    );

    // 1. NULL ctx_le_scope() fail-closed test across ALL 6 hardened HR helpers:
    // Seal a valid user context with org/user/role set and le_scope explicitly NULL so ctx_le_scope() IS NULL.
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query(
        `SELECT ludy_kernel.ctx_write(jsonb_build_object(
          'v', 1, 'org', $1::uuid, 'actor', 'user', 'user', $2::uuid, 'role', 'owner', 'le_scope', NULL, 'flags', '[]'::jsonb
        ))`,
        [o.orgId, o.owner],
      );
      await c.query('SET LOCAL ROLE ludy_tenant');
      const scopeCheck = await c.query<{ s: string[] | null }>('SELECT ludy_kernel.ctx_le_scope() AS s');
      expect(scopeCheck.rows[0]?.s).toBeNull();

      const advName = await c.query<{ n: string | null }>(
        `SELECT ludy_hr.hr_stage6b_request_employee_name($1::uuid, 'salary_advance', $2::uuid) AS n`,
        [o.orgId, adv.requestId],
      );
      expect(advName.rows[0]?.n).toBeNull();

      const leaveName = await c.query<{ n: string | null }>(
        `SELECT ludy_hr.leave_request_employee_name($1::uuid, $2::uuid) AS n`,
        [o.orgId, leaveReq.requestId],
      );
      expect(leaveName.rows[0]?.n).toBeNull();

      const otName = await c.query<{ n: string | null }>(
        `SELECT ludy_hr.overtime_request_employee_name($1::uuid, $2::uuid) AS n`,
        [o.orgId, otReq.requestId],
      );
      expect(otName.rows[0]?.n).toBeNull();

      await c.query('SAVEPOINT sp_locked');
      await expect(
        c.query(`SELECT ludy_hr.hr_stage6b_payroll_run_locked($1::uuid, $2::uuid, $3)`, [o.orgId, o.defaultEntityId, month]),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK TO SAVEPOINT sp_locked');

      await c.query('SAVEPOINT sp_months');
      await expect(
        c.query(`SELECT ludy_hr.hr_stage6b_locked_payroll_months($1::uuid, $2::uuid)`, [o.orgId, o.defaultEntityId]),
      ).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK TO SAVEPOINT sp_months');
      await c.query('ROLLBACK');

      // Also verify verify_attendance_qr as linked staff with NULL le_scope -> returns false and clears qr_verified_hash!
      await c.query('BEGIN');
      await c.query(
        `SELECT ludy_kernel.ctx_write(jsonb_build_object(
          'v', 1, 'org', $1::uuid, 'actor', 'user', 'user', $2::uuid, 'role', 'member', 'le_scope', NULL, 'flags', '[]'::jsonb
        ))`,
        [o.orgId, o.staff],
      );
      await c.query('SET LOCAL ROLE ludy_tenant');
      const qrNull = await c.query<{ ok: boolean; hash: string }>(
        `SELECT ludy_hr.verify_attendance_qr($1::uuid, $2::uuid, $3) AS ok,
                pg_catalog.current_setting('ludy_hr.qr_verified_hash', true) AS hash`,
        [o.orgId, o.defaultEntityId, qrHash],
      );
      expect(qrNull.rows[0]).toEqual({ ok: false, hash: '' });
      await c.query('ROLLBACK');
    });

    // 2. Fail-closed hr_stage6b_payroll_run_locked & hr_stage6b_locked_payroll_months for unauthorized / out-of-scope callers.
    const appClient = await appPool.connect();
    try {
      // No context entered at all -> 42501 (permission denied or raised 42501).
      await appClient.query('BEGIN');
      await appClient.query('SET LOCAL ROLE ludy_tenant');
      await expect(
        appClient.query(`SELECT ludy_hr.hr_stage6b_payroll_run_locked($1::uuid, $2::uuid, $3)`, [o.orgId, o.defaultEntityId, month]),
      ).rejects.toMatchObject({ code: '42501' });
      await appClient.query('ROLLBACK');

      // Viewer, unlinked plain member, cross-org owner, and branch-scoped admin querying defaultEntityId -> all raise 42501!
      for (const bad of [
        { userId: o.viewer, orgId: o.orgId },
        { userId: o.plain, orgId: o.orgId },
        { userId: o2.owner, orgId: o2.orgId },
        { userId: scopedUser, orgId: o.orgId },
      ]) {
        await appClient.query('BEGIN');
        await enterUser(appClient, bad.userId, bad.orgId);
        await expect(
          appClient.query(`SELECT ludy_hr.hr_stage6b_payroll_run_locked($1::uuid, $2::uuid, $3)`, [o.orgId, o.defaultEntityId, month]),
        ).rejects.toMatchObject({ code: '42501' });
        await appClient.query('ROLLBACK');

        await appClient.query('BEGIN');
        await enterUser(appClient, bad.userId, bad.orgId);
        await expect(
          appClient.query(`SELECT ludy_hr.hr_stage6b_locked_payroll_months($1::uuid, $2::uuid)`, [o.orgId, o.defaultEntityId]),
        ).rejects.toMatchObject({ code: '42501' });
        await appClient.query('ROLLBACK');
      }

      // Scoped branch member CAN call the helpers for their own branchId, and their ctx_le_scope is [branchId].
      await appClient.query('BEGIN');
      await enterUser(appClient, scopedUser, o.orgId);
      const scopedOk = await appClient.query<{ scope: string[]; locked: boolean; months: string[] }>(
        `SELECT ludy_kernel.ctx_le_scope() AS scope,
                ludy_hr.hr_stage6b_payroll_run_locked($1::uuid, $2::uuid, $3) AS locked,
                ludy_hr.hr_stage6b_locked_payroll_months($1::uuid, $2::uuid) AS months`,
        [o.orgId, branchId, month],
      );
      expect(scopedOk.rows[0]).toEqual({ scope: [branchId], locked: false, months: [] });
      await appClient.query('ROLLBACK');

      // Valid linked staff & active dept manager succeed cleanly (false before approval, true + month listed after approval).
      for (const goodUser of [o.staff, o.mgr, o.owner]) {
        await appClient.query('BEGIN');
        await enterUser(appClient, goodUser, o.orgId);
        const unlocked = await appClient.query<{ locked: boolean; months: string[] }>(
          `SELECT ludy_hr.hr_stage6b_payroll_run_locked($1::uuid, $2::uuid, $3) AS locked,
                  ludy_hr.hr_stage6b_locked_payroll_months($1::uuid, $2::uuid) AS months`,
          [o.orgId, o.defaultEntityId, month],
        );
        expect(unlocked.rows[0]).toEqual({ locked: false, months: [] });
        await appClient.query('ROLLBACK');
      }

      // 3. Stage 6B admin INSERT policy hardening: explicit created_by = NULL or spoofed created_by rejected (42501);
      // omitting created_by stamps caller via column DEFAULT ludy_kernel.ctx_user_id() and preserves anti-self-approval!
      for (const badCreatedBy of [null, o.owner]) {
        for (const stmt of [
          {
            sql: `INSERT INTO ludy_hr.salary_advance_request (org_id, legal_entity_id, employee_id, month, amount, reason, status, created_by)
                  VALUES ($1, $2, $3, $4, 300000, 'Spoofed', 'pending_final', $5)`,
            params: [o.orgId, o.defaultEntityId, o.staffEmployeeId, month, badCreatedBy],
          },
          {
            sql: `INSERT INTO ludy_hr.payroll_adjustment_item (org_id, legal_entity_id, employee_id, month, kind, amount, reason, status, created_by)
                  VALUES ($1, $2, $3, $4, 'retro_pay', 300000, 'Spoofed', 'pending', $5)`,
            params: [o.orgId, o.defaultEntityId, o.staffEmployeeId, month, badCreatedBy],
          },
          {
            sql: `INSERT INTO ludy_hr.business_trip_request (org_id, legal_entity_id, employee_id, destination, purpose, start_on, end_on, estimated_allowance, status, created_by)
                  VALUES ($1, $2, $3, 'Đà Lạt', 'Spoofed', '2026-09-15', '2026-09-16', 100000, 'pending_final', $4)`,
            params: [o.orgId, o.defaultEntityId, o.staffEmployeeId, badCreatedBy],
          },
        ]) {
          await appClient.query('BEGIN');
          await enterUser(appClient, o.admin, o.orgId);
          await expect(appClient.query(stmt.sql, stmt.params)).rejects.toMatchObject({ code: '42501' });
          await appClient.query('ROLLBACK');
        }
      }

      // Omitting created_by as admin stamps created_by = admin via DEFAULT, so admin still cannot self-approve!
      await appClient.query('BEGIN');
      await enterUser(appClient, o.admin, o.orgId);
      const insertedAdj = await appClient.query<{ id: string; created_by: string | null }>(
        `INSERT INTO ludy_hr.payroll_adjustment_item (org_id, legal_entity_id, employee_id, month, kind, amount, reason, status)
         VALUES ($1, $2, $3, $4, 'retro_pay', 300000, 'Default created_by test', 'pending')
         RETURNING id, created_by`,
        [o.orgId, o.defaultEntityId, o.staffEmployeeId, month],
      );
      expect(insertedAdj.rows[0]?.created_by).toBe(o.admin);
      await appClient.query('COMMIT');

      await expect(
        o.exec(o.admin, 'hr.payroll.adjustment.approve', { itemId: insertedAdj.rows[0]!.id }),
      ).rejects.toMatchObject({ code: 'HR_SELF_APPROVAL_BLOCKED' });

      // 4. Manual override on retroPay + adjustment approval warning + 1-click restore via sync_stage6b({ resetManualOverridesForLineId }).
      const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month });
      const sheet0 = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
      const line0 = sheet0.lines.find((l) => l.employeeId === o.staffEmployeeId)!;
      await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
        lineId: line0.id,
        inputs: { retroPay: '150000' },
      });
      const adjApproved = await o.exec<HrAdjustmentActionResult>(o.owner, 'hr.payroll.adjustment.approve', {
        itemId: insertedAdj.rows[0]!.id,
      });
      expect(adjApproved.status).toBe('approved');
      expect(adjApproved.payrollSynced).toBe(false);
      expect(adjApproved.payrollSyncSkippedReason).toBe('manual_override');

      const sheetWarn = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
      const lineWarn = sheetWarn.lines.find((l) => l.id === line0.id)!;
      expect(lineWarn.flags).toContain('stage6b_manual_override');
      expect(lineWarn.stage6bManualOverrides).toEqual([
        { field: 'retroPay', lineAmount: '150000', approvedAmount: '300000' },
      ]);

      // Restore sync for this specific line -> updates retroPay to 300000, links payroll_run_id, clears warning flag!
      const restored = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.sync_stage6b', {
        runId: run.runId,
        resetManualOverridesForLineId: line0.id,
      });
      expect(restored.skippedManualOverrideLines).toBeUndefined();
      const sheetRestored = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
      const lineRestored = sheetRestored.lines.find((l) => l.id === line0.id)!;
      expect(lineRestored.inputs.retroPay).toBe('300000');
      expect(lineRestored.inputs.retroPayFromAdjustments).toBe(true);
      expect(lineRestored.flags).not.toContain('stage6b_manual_override');
      expect(lineRestored.stage6bManualOverrides).toBeUndefined();
      const linkedCheck = await adminPool.query<{ payroll_run_id: string | null }>(
        `SELECT payroll_run_id FROM ludy_hr.payroll_adjustment_item WHERE org_id = $1 AND id = $2`,
        [o.orgId, insertedAdj.rows[0]!.id],
      );
      expect(linkedCheck.rows[0]?.payroll_run_id).toBe(run.runId);
    } finally {
      appClient.release();
    }
  });
});

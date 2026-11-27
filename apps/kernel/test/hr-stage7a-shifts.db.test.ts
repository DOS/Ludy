// SPDX-License-Identifier: AGPL-3.0-only
// Stage 7A DB integration tests (#5216) on real PostgreSQL 17:
// 1. Shift templates (seed_defaults idempotency, CRUD, archive) and weekly roster scoping.
// 2. Strictly scoped RLS: owner/admin, active L1 dept manager (revoked when archived / cross-dept blocked),
//    linked self shifts list & swap submit/cancel, unlinked member & viewer blocked, cross-org isolation.
// 3. 1-step shift swap approval atomically updating shift_assignment (swap & open-shift cover) + DB anti-self-approval guard.
// 4. Per-log adherence + Art. 106 break-adjusted nightHours payroll rollup (no Art. 127 late fines).
// 5. Metered Ly coverage suggestions (hr.shift_coverage_suggest) with E1..En PII isolation + deterministic fallback.
// 6. PDPL erasure (hr.payroll.employee.erase), org_purge, and SECURITY DEFINER pg_proc hardening checks.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  HrAttendanceListResult,
  HrAttendanceRollupResult,
  HrDepartmentWritten,
  HrLeaveRequestActionResult,
  HrRunWritten,
  HrSelfAttendanceListResult,
  HrSelfShiftsResult,
  HrShiftAssignmentView,
  HrShiftCoverageSnapshot,
  HrShiftRosterResult,
  HrShiftSwapView,
  HrShiftTemplateSeedResult,
  HrShiftTemplateView,
  HrWritten,
} from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { hrCommands, hrQueries } from '@ludy/mod-hr';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { generateShiftCoverageBrief, type ShiftCoverageAi, type ShiftCoveragePorts } from '../src/hr-shifts-ai.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error(`missing blob ${key}`);
    return b;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

suite('HR Stage 7A shifts, weekly roster, 1-step swaps, night rollup & Ly coverage (#5216)', () => {
  const dbName = `ludy_test_hr7a_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: pg.Pool;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;
  const store = new MemoryStore();
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

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const db = createDb(appPool);
    const person = (role: string, name: string) =>
      upsertIdentity(db, { issuer: 'hr7a', subject: `${role}-${tag}`, email: `${role}-${tag}@hr7a.test`, name });
    const owner = await person('owner', 'Chủ Doanh Nghiệp');
    const admin = await person('admin', 'Quản Trị Nhân Sự');
    const manager = await person('manager', 'Trưởng Ca Cửa Hàng');
    const otherMgr = await person('othermgr', 'Trưởng Bộ Phận Kho');
    const staffA = await person('staffa', 'Nguyễn Văn An');
    const staffB = await person('staffb', 'Trần Thị Bình');
    const staffC = await person('staffc', 'Lê Minh Châu');
    const viewer = await person('viewer', 'Người Xem');

    const { orgId } = await createOrg(rt, asUser(owner), `Cty Stage 7A ${tag}`);
    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($1, $7, 'member'), ($1, $8, 'viewer')`,
      [orgId, admin, manager, otherMgr, staffA, staffB, staffC, viewer],
    );

    const exec = <O>(
      userId: string,
      name: string,
      input: unknown,
      actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId),
    ) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });

    return { orgId, owner, admin, manager, otherMgr, staffA, staffB, staffC, viewer, exec, query };
  }

  beforeAll(async () => {
    const rootPool = new pg.Client({ connectionString: ADMIN as string });
    await rootPool.connect();
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';

    adminPool = createPool({ connectionString: adminUrl, max: 2, resetOnRelease: false });
    appPool = createPool({ connectionString: appUrl.toString(), max: 4 });
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });

    const rtOpts = {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      subjectVault,
      readAuditKey: randomBytes(32),
      stepUp: 'required' as const,
    };
    rt = new Runtime(createDb(appPool), rtOpts).register({
      commands: [...kernelCommands, ...hrCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS, subjectVault }).register({
      commands: [...kernelCommands, ...hrCommands, orgPurgeCommand({ store })],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries],
    });
  }, 420_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = new pg.Client({ connectionString: ADMIN });
    await rootPool.connect();
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('covers templates, weekly roster RLS, 1-step swaps, night rollup, Ly coverage AI, PDPL erasure & org_purge', async () => {
    const o = await setupOrg();
    const o2 = await setupOrg();

    // 1. Setup departments and employees
    const { departmentId: deptStore } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Cửa hàng 1',
      payFunction: 'sales',
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptStore, managerUserId: o.manager });

    const { departmentId: deptWarehouse } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Kho',
      payFunction: 'production',
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptWarehouse, managerUserId: o.otherMgr });

    const addEmp = async (displayName: string, departmentId: string, userId: string, wage: string) => {
      const { employeeId } = await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName,
          departmentId,
          jobTitle: 'Nhân viên',
          employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: wage },
        },
        asMfa(o.owner),
      );
      await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId, userId }, asMfa(o.owner));
      return employeeId as string;
    };

    const empA = await addEmp('Nguyễn Văn An', deptStore, o.staffA, '10000000');
    const empB = await addEmp('Trần Thị Bình', deptStore, o.staffB, '10000000');
    const empC = await addEmp('Lê Minh Châu', deptWarehouse, o.staffC, '12000000');
    const empMgr = await addEmp('Trưởng Ca Cửa Hàng', deptStore, o.manager, '15000000');

    // 2. Seed default templates idempotently + custom night-break template + archive
    await expect(o.exec(o.manager, 'hr.shift.template.seed_defaults', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(o.exec(o.viewer, 'hr.shift.template.create', { code: 'V', name: 'Viewer', startMinute: 480, endMinute: 960 })).rejects.toMatchObject({
      status: 403,
    });

    const seeded1 = await o.exec<HrShiftTemplateSeedResult>(o.admin, 'hr.shift.template.seed_defaults', {});
    expect(seeded1.createdCount).toBe(4);
    expect(seeded1.templates.map((t) => t.code)).toEqual(expect.arrayContaining(['CA_SANG', 'CA_HC', 'CA_CHIEU', 'CA_DEM']));

    const seeded2 = await o.exec<HrShiftTemplateSeedResult>(o.admin, 'hr.shift.template.seed_defaults', {});
    expect(seeded2.createdCount).toBe(0);

    const tplSang = seeded1.templates.find((t) => t.code === 'CA_SANG')!;
    const tplChieu = seeded1.templates.find((t) => t.code === 'CA_CHIEU')!;
    const tplDemBreak = await o.exec<HrShiftTemplateView>(o.owner, 'hr.shift.template.create', {
      code: 'CA_TOI_60',
      name: 'Ca tối nửa đêm',
      startMinute: 18 * 60,
      endMinute: 2 * 60,
      breakMinutes: 60,
      graceLateMinutes: 15,
      graceEarlyMinutes: 15,
      crossesMidnight: true,
    });
    expect(tplDemBreak.durationMinutes).toBe(480);

    await expect(
      o.exec(o.owner, 'hr.shift.template.create', {
        code: 'CA_TOI_60',
        name: 'Trùng mã',
        startMinute: 480,
        endMinute: 960,
      }),
    ).rejects.toMatchObject({ code: 'HR_SHIFT_TEMPLATE_CODE_EXISTS', status: 409 });

    const tempTpl = await o.exec<HrShiftTemplateView>(o.admin, 'hr.shift.template.create', {
      code: 'CA_TAM',
      name: 'Ca tạm',
      startMinute: 480,
      endMinute: 960,
    });
    await o.exec(o.admin, 'hr.shift.template.archive', { templateId: tempTpl.id });

    // 3. Weekly roster management & RLS isolation
    await expect(o.query(o.staffA, 'hr.shift.roster.get', {})).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(o.query(o.viewer, 'hr.shift.roster.get', {})).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(o2.query(o2.owner, 'hr.shift.roster.get', { legalEntityId: seeded1.legalEntityId })).rejects.toMatchObject({
      status: 422,
    });

    // L1 manager can assign within deptStore, blocked on deptWarehouse
    await expect(
      o.exec(o.manager, 'hr.shift.assignment.upsert', {
        employeeId: empC,
        shiftTemplateId: tplSang.id,
        workDate: '2027-04-05',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const assignA = await o.exec<HrShiftAssignmentView>(o.manager, 'hr.shift.assignment.upsert', {
      employeeId: empA,
      shiftTemplateId: tplSang.id,
      workDate: '2027-04-05',
      note: 'Ca sáng đầu tuần',
    });
    const assignB = await o.exec<HrShiftAssignmentView>(o.manager, 'hr.shift.assignment.upsert', {
      employeeId: empB,
      shiftTemplateId: tplChieu.id,
      workDate: '2027-04-05',
    });
    const assignMgr = await o.exec<HrShiftAssignmentView>(o.admin, 'hr.shift.assignment.upsert', {
      employeeId: empMgr,
      shiftTemplateId: tplSang.id,
      workDate: '2027-04-06',
    });

    // Archive check on assignment
    await expect(
      o.exec(o.admin, 'hr.shift.assignment.upsert', {
        employeeId: empA,
        shiftTemplateId: tempTpl.id,
        workDate: '2027-04-06',
      }),
    ).rejects.toMatchObject({ code: 'HR_SHIFT_TEMPLATE_ARCHIVED', status: 409 });

    const mgrRoster = await o.query<HrShiftRosterResult>(o.manager, 'hr.shift.roster.get', { weekStart: '2027-04-05' });
    expect(mgrRoster.canManageOrgRoster).toBe(false);
    expect(mgrRoster.employees.map((e) => e.id)).not.toContain(empC);
    expect(mgrRoster.assignments.map((a) => a.id)).toContain(assignA.id);

    // 4. Self shifts & 1-step swap submit, cancel, anti-self-approval, and atomic approval
    const selfViewA = await o.query<HrSelfShiftsResult>(o.staffA, 'hr.self.shifts.list', { weekStart: '2027-04-05' });
    expect(selfViewA.assignments).toHaveLength(1);
    expect(selfViewA.peerCandidates.map((p) => p.id)).toContain(empB);

    const swapToCancel = await o.exec<HrShiftSwapView>(o.staffA, 'hr.self.shift_swap.submit', {
      requesterAssignmentId: assignA.id,
      targetEmployeeId: empB,
      reason: 'Đưa con đi khám buổi sáng',
    });
    const cancelled = await o.exec<HrShiftSwapView>(o.staffA, 'hr.self.shift_swap.cancel', {
      swapId: swapToCancel.id,
    });
    expect(cancelled.status).toBe('cancelled');

    const swapAB = await o.exec<HrShiftSwapView>(o.staffA, 'hr.self.shift_swap.submit', {
      requesterAssignmentId: assignA.id,
      targetEmployeeId: empB,
      reason: 'Đổi sang ca chiều 2027-04-05',
    });
    expect(swapAB.targetAssignmentId).toBe(assignB.id);
    expect(swapAB.requesterShiftCode).toBe('CA_SANG');
    expect(swapAB.targetShiftCode).toBe('CA_CHIEU');

    const selfViewWithSwap = await o.query<HrSelfShiftsResult>(o.staffA, 'hr.self.shifts.list', { weekStart: '2027-04-05' });
    const swapFromSelfList = selfViewWithSwap.swaps.find((s) => s.id === swapAB.id);
    expect(swapFromSelfList?.requesterShiftCode).toBe('CA_SANG');
    expect(swapFromSelfList?.targetShiftCode).toBe('CA_CHIEU');

    // Deleting a pending swap's target assignment is blocked cleanly
    await expect(
      o.exec(o.manager, 'hr.shift.assignment.delete', { assignmentId: assignB.id }),
    ).rejects.toMatchObject({ code: 'HR_SHIFT_ASSIGNMENT_IN_SWAP', status: 409 });

    // Anti-self-approval: if manager submits swap on own shift, manager cannot approve own swap (multi-owner/admin org).
    const selfSwapMgr = await o.exec<HrShiftSwapView>(o.manager, 'hr.self.shift_swap.submit', {
      requesterAssignmentId: assignMgr.id,
      targetEmployeeId: empB,
      reason: 'Nhờ Bình nhận thay ca sáng 04-06',
    });
    await expect(
      o.exec(o.manager, 'hr.shift_swap.approve', { swapId: selfSwapMgr.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Cross-dept L1 manager (otherMgr) is hidden by SELECT RLS (404); target (staffB) lacks UPDATE RLS on FOR UPDATE (404);
    // requester (staffA) passes FOR UPDATE RLS and is refused by assertCanManageDepartment (403 FORBIDDEN).
    await expect(
      o.exec(o.otherMgr, 'hr.shift_swap.approve', { swapId: swapAB.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(
      o.exec(o.staffB, 'hr.shift_swap.approve', { swapId: swapAB.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    await expect(
      o.exec(o.staffA, 'hr.shift_swap.approve', { swapId: swapAB.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Authorized L1 manager approves swapAB in 1 step -> shift_assignment rows swap templates atomically!
    const approvedAB = await o.exec<HrShiftSwapView>(o.manager, 'hr.shift_swap.approve', {
      swapId: swapAB.id,
      decisionNote: 'Đồng ý đổi ca',
    });
    expect(approvedAB.status).toBe('approved');
    expect(approvedAB.decidedBy).toBe(o.manager);

    const rosterAfterSwap = await o.query<HrShiftRosterResult>(o.admin, 'hr.shift.roster.get', { weekStart: '2027-04-05' });
    const newA = rosterAfterSwap.assignments.find((a) => a.id === assignA.id)!;
    const newB = rosterAfterSwap.assignments.find((a) => a.id === assignB.id)!;
    expect(newA.shiftCode).toBe('CA_CHIEU');
    expect(newB.shiftCode).toBe('CA_SANG');

    // Open-shift takeover approval by admin (target_assignment_id IS NULL -> assignMgr transfers to empB).
    const approvedTakeover = await o.exec<HrShiftSwapView>(o.admin, 'hr.shift_swap.approve', { swapId: selfSwapMgr.id });
    expect(approvedTakeover.status).toBe('approved');
    const rosterAfterTakeover = await o.query<HrShiftRosterResult>(o.admin, 'hr.shift.roster.get', { weekStart: '2027-04-05' });
    expect(rosterAfterTakeover.assignments.find((a) => a.id === assignMgr.id)?.employeeId).toBe(empB);

    // Deleting a non-pending (approved) historical swap's target assignment succeeds via ON DELETE SET NULL(target_assignment_id)
    const assignApr12A = await o.exec<HrShiftAssignmentView>(o.manager, 'hr.shift.assignment.upsert', {
      employeeId: empA,
      shiftTemplateId: tplSang.id,
      workDate: '2027-04-12',
    });
    const assignApr12B = await o.exec<HrShiftAssignmentView>(o.manager, 'hr.shift.assignment.upsert', {
      employeeId: empB,
      shiftTemplateId: tplChieu.id,
      workDate: '2027-04-12',
    });
    const swapApr12 = await o.exec<HrShiftSwapView>(o.staffA, 'hr.self.shift_swap.submit', {
      requesterAssignmentId: assignApr12A.id,
      targetEmployeeId: empB,
    });
    await o.exec<HrShiftSwapView>(o.manager, 'hr.shift_swap.approve', { swapId: swapApr12.id });
    const deletedHistoricalTarget = await o.exec<{ assignmentId: string; deleted: boolean }>(
      o.manager,
      'hr.shift.assignment.delete',
      { assignmentId: assignApr12B.id },
    );
    expect(deletedHistoricalTarget.deleted).toBe(true);
    const swapApr12Row = (
      await adminPool.query<{ target_assignment_id: string | null }>(
        `SELECT target_assignment_id FROM ludy_hr.shift_swap_request WHERE org_id = $1 AND id = $2`,
        [o.orgId, swapApr12.id],
      )
    ).rows[0];
    expect(swapApr12Row?.target_assignment_id).toBeNull();

    // 5. Attendance adherence & Art. 106 break-adjusted nightHours payroll rollup
    // Assign empC to CA_TOI_60 (18:00-02:00, break 60m) on 2027-04-07 and adjust log 18:00-02:00 (25m late test on another day).
    await o.exec(o.admin, 'hr.shift.assignment.upsert', {
      employeeId: empC,
      shiftTemplateId: tplDemBreak.id,
      workDate: '2027-04-07',
    });
    await o.exec(o.admin, 'hr.attendance.adjust', {
      employeeId: empC,
      workDate: '2027-04-07',
      checkedInAt: '2027-04-07T18:20:00+07:00', // 20m late (> 15m grace)
      checkedOutAt: '2027-04-08T02:00:00+07:00',
      workedMinutes: 460,
      status: 'present',
    });

    const selfAttC = await o.query<HrSelfAttendanceListResult>(o.staffC, 'hr.self.attendance.list', { month: '2027-04' });
    const logApr07 = selfAttC.logs.find((l) => l.workDate === '2027-04-07')!;
    expect(logApr07.shiftTemplateCode).toBe('CA_TOI_60');
    expect(logApr07.lateMinutes).toBe(20);
    expect(logApr07.earlyLeaveMinutes).toBe(0);
    expect(logApr07.nightMinutes).toBe(240);
    expect(selfAttC.summary.totalLateMinutes).toBe(20);

    const adminAtt = await o.query<HrAttendanceListResult>(o.admin, 'hr.attendance.list', {
      month: '2027-04',
      employeeId: empC,
    });
    expect(adminAtt.logs[0]?.shiftTemplateCode).toBe('CA_TOI_60');
    expect(adminAtt.logs[0]?.lateMinutes).toBe(20);

    const payRun = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2027-04' });
    const rollup = await o.exec<HrAttendanceRollupResult>(o.admin, 'hr.attendance.rollup_to_payroll', {
      runId: payRun.runId,
      allowIncomplete: true,
    });
    const empCRollup = rollup.rows.find((r) => r.employeeId === empC)!;
    expect(empCRollup.nightHours).toBe('4');

    const payLineRes = await adminPool.query<{ inputs: Record<string, unknown> }>(
      `SELECT inputs FROM ludy_hr.payroll_line WHERE org_id = $1 AND run_id = $2 AND employee_id = $3`,
      [o.orgId, payRun.runId, empC],
    );
    expect(payLineRes.rows[0]?.inputs.deductions).toEqual([]); // BLLĐ Art. 127: no late wage fine deductions

    // 6. Conflict detection & Ly AI coverage brief with E1..En PII isolation
    // Approve leave for empA on 2027-04-08, schedule empA on 2027-04-08, and schedule empC on 2027-04-30 (VN holiday)
    const leaveSubmitted = await o.exec<{ requestId: string }>(o.staffA, 'hr.self.leave.request_submit', {
      startOn: '2027-04-08',
      endOn: '2027-04-08',
      kind: 'unpaid_leave',
      days: '1',
      reason: 'Việc gia đình',
    });
    await o.exec<HrLeaveRequestActionResult>(o.admin, 'hr.leave_request.approve_final', {
      requestId: leaveSubmitted.requestId,
    });
    await o.exec(o.manager, 'hr.shift.assignment.upsert', {
      employeeId: empA,
      shiftTemplateId: tplSang.id,
      workDate: '2027-04-08',
    });
    // Short rest: empC worked CA_TOI_60 on 2027-04-07 ending 02:00 on 2027-04-08 -> assign CA_SANG 06:00 on 2027-04-08 (4h rest < 12h)
    await o.exec(o.admin, 'hr.shift.assignment.upsert', {
      employeeId: empC,
      shiftTemplateId: tplSang.id,
      workDate: '2027-04-08',
    });

    const ports: ShiftCoveragePorts = {
      read: (inp) => o.query<HrShiftCoverageSnapshot>(o.admin, 'hr.shift.coverage.read', inp),
      record: (legalEntityId, weekStart, aiReason, conflictCount) =>
        o.exec(o.admin, 'hr.shift.coverage.audit', { legalEntityId, weekStart, aiReason, conflictCount }).then(() => undefined),
    };

    const capturedPrompts: string[] = [];
    const mockAi: ShiftCoverageAi = {
      budget: new DraftBudget(),
      reader: {
        shiftCoverageSuggest: async (inp) => {
          const { suggestShiftCoverage } = await import('@ludy/agent');
          return suggestShiftCoverage(inp, {
            generate: async ({ prompt }) => {
              capturedPrompts.push(prompt);
              const parsed = JSON.parse(prompt) as {
                conflicts: Array<{ alias: string; workDate: string; shiftCode: string }>;
                gaps: Array<{ workDate: string; candidateAliases: Array<{ alias: string }> }>;
              };
              const target = parsed.conflicts[0]!;
              const cand = parsed.gaps[0]?.candidateAliases[0]?.alias ?? null;
              return {
                output: {
                  summary: `Tuần này có ${parsed.conflicts.length} xung đột cần xử lý cho ${target.alias}.`,
                  highlights: [`${target.alias} cần người thay vào ngày ${target.workDate}.`],
                  suggestions: [
                    {
                      workDate: target.workDate,
                      targetAlias: target.alias,
                      candidateAlias: cand,
                      note: cand ? `Gợi ý ${cand} thay ca ngày ${target.workDate}.` : `Cần kiểm tra lịch ngày ${target.workDate}.`,
                    },
                  ],
                },
              };
            },
          });
        },
      },
    };

    const briefAi = await generateShiftCoverageBrief(mockAi, ports, o.orgId, o.admin, { weekStart: '2027-04-05', lang: 'vi' });
    expect(briefAi.conflicts.map((c) => c.kind)).toEqual(expect.arrayContaining(['approved_leave', 'short_rest']));
    expect(briefAi.ai.ok).toBe(true);
    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).not.toContain('Nguyễn Văn An');
    expect(capturedPrompts[0]).not.toContain('Lê Minh Châu');
    expect(capturedPrompts[0]).not.toContain(empA);

    const briefFallback = await generateShiftCoverageBrief({ reader: null, budget: new DraftBudget() }, ports, o.orgId, o.admin, {
      weekStart: '2027-04-05',
      lang: 'vi',
    });
    expect(briefFallback.ai).toEqual({ ok: false, reason: 'off' });
    expect(briefFallback.conflicts.length).toBeGreaterThanOrEqual(2);

    // 7. Ended employee allows cleanup (reject, cancel, assignment.delete) while blocking approve/upsert/submit; PDPL erasure scrubs PII
    const assignAEndedReject = await o.exec<HrShiftAssignmentView>(o.manager, 'hr.shift.assignment.upsert', {
      employeeId: empA,
      shiftTemplateId: tplSang.id,
      workDate: '2027-04-15',
    });
    const swapEndedReject = await o.exec<HrShiftSwapView>(o.staffA, 'hr.self.shift_swap.submit', {
      requesterAssignmentId: assignAEndedReject.id,
      targetEmployeeId: empB,
    });
    const assignAEndedCancel = await o.exec<HrShiftAssignmentView>(o.manager, 'hr.shift.assignment.upsert', {
      employeeId: empA,
      shiftTemplateId: tplSang.id,
      workDate: '2027-04-16',
    });
    const swapEndedCancel = await o.exec<HrShiftSwapView>(o.staffA, 'hr.self.shift_swap.submit', {
      requesterAssignmentId: assignAEndedCancel.id,
      targetEmployeeId: empB,
    });
    const assignAEndedDelete = await o.exec<HrShiftAssignmentView>(o.manager, 'hr.shift.assignment.upsert', {
      employeeId: empA,
      shiftTemplateId: tplSang.id,
      workDate: '2027-04-17',
    });
    const pendingBeforeErase = await o.exec<HrShiftSwapView>(o.staffA, 'hr.self.shift_swap.submit', {
      requesterAssignmentId: assignA.id,
      targetEmployeeId: empB,
      reason: 'Lý do nhạy cảm cần xóa PDPL',
    });
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empA, endedOn: '2026-10-01' }, asMfa(o.owner));

    await expect(
      o.exec(o.manager, 'hr.shift_swap.approve', { swapId: swapEndedReject.id }),
    ).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ENDED', status: 409 });
    const rejectedForEnded = await o.exec<HrShiftSwapView>(o.manager, 'hr.shift_swap.reject', {
      swapId: swapEndedReject.id,
      decisionNote: 'Nhân viên đã nghỉ việc',
    });
    expect(rejectedForEnded.status).toBe('rejected');

    const cancelledForEnded = await o.exec<HrShiftSwapView>(o.staffA, 'hr.self.shift_swap.cancel', {
      swapId: swapEndedCancel.id,
    });
    expect(cancelledForEnded.status).toBe('cancelled');

    const deletedForEnded = await o.exec<{ assignmentId: string; deleted: boolean }>(
      o.manager,
      'hr.shift.assignment.delete',
      { assignmentId: assignAEndedDelete.id },
    );
    expect(deletedForEnded.deleted).toBe(true);
    const c = await adminPool.connect();
    let cCommitted = false;
    let cBroken = false;
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_hr.payroll_employee
            SET ended_on = ((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date
          WHERE id = $1`,
        [empA],
      );
      await c.query('COMMIT');
      cCommitted = true;
    } catch (err) {
      if (!cCommitted) await c.query('ROLLBACK').catch(() => { cBroken = true; });
      throw err;
    } finally {
      c.release(cBroken);
    }

    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: empA }, asMfa(o.owner));

    const erasedAssign = (
      await adminPool.query<{ note: string | null }>(`SELECT note FROM ludy_hr.shift_assignment WHERE id = $1`, [assignA.id])
    ).rows[0];
    expect(erasedAssign?.note).toBeNull();

    const erasedSwaps = (
      await adminPool.query<{ id: string; status: string; reason: string | null; decision_note: string | null }>(
        `SELECT id, status, reason, decision_note FROM ludy_hr.shift_swap_request WHERE org_id = $1 AND requester_employee_id = $2`,
        [o.orgId, empA],
      )
    ).rows;
    expect(erasedSwaps.find((r) => r.id === pendingBeforeErase.id)?.status).toBe('cancelled');
    for (const row of erasedSwaps) {
      expect(row.reason).toBeNull();
      expect(row.decision_note).toBeNull();
    }

    await expect(
      o.exec(o.owner, 'hr.shift.assignment.upsert', {
        employeeId: empA,
        shiftTemplateId: tplSang.id,
        workDate: '2027-04-09',
      }),
    ).rejects.toMatchObject({ code: 'HR_EMPLOYEE_ERASED', status: 409 });

    // Direct SQL mutation on erased shift_assignment blocked by trigger
    const sqlClient = await appPool.connect();
    try {
      await sqlClient.query('BEGIN');
      await enterUser(sqlClient, o.owner, o.orgId);
      await expect(
        sqlClient.query(`UPDATE ludy_hr.shift_assignment SET note = 'tamper' WHERE org_id = $1 AND id = $2`, [o.orgId, assignA.id]),
      ).rejects.toMatchObject({ code: '23514' });
      await sqlClient.query('ROLLBACK');
    } finally {
      sqlClient.release();
    }

    // 7b. Archiving a department revokes L1 manager shift roster access
    const { departmentId: deptArchive } = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Bộ phận Tạm',
      payFunction: 'admin',
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptArchive, managerUserId: o.otherMgr });
    const rosterBeforeArchive = await o.query<HrShiftRosterResult>(o.otherMgr, 'hr.shift.roster.get', {
      departmentId: deptArchive,
    });
    expect(rosterBeforeArchive.manageableDepartmentIds).toContain(deptArchive);
    await o.exec(o.owner, 'hr.department.archive', { departmentId: deptArchive });
    await expect(
      o.query(o.otherMgr, 'hr.shift.roster.get', { departmentId: deptArchive }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // 7c. Sole-owner OPC org allows sole owner to self-approve own swap
    const soloTag = randomUUID().slice(0, 8);
    const soloDb = createDb(appPool);
    const soloOwner = await upsertIdentity(soloDb, {
      issuer: 'hr7a',
      subject: `solo-${soloTag}`,
      email: `solo-${soloTag}@hr7a.test`,
      name: 'Chủ OPC Duy Nhất',
    });
    const soloPeer = await upsertIdentity(soloDb, {
      issuer: 'hr7a',
      subject: `solopeer-${soloTag}`,
      email: `solopeer-${soloTag}@hr7a.test`,
      name: 'Cộng sự OPC',
    });
    const { orgId: soloOrgId } = await createOrg(rt, asUser(soloOwner), `OPC Sole ${soloTag}`);
    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`,
      [soloOrgId, soloPeer],
    );
    const soloSeeded = await rt.execute<HrShiftTemplateSeedResult>(
      'hr.shift.template.seed_defaults',
      {},
      { actor: asUser(soloOwner), orgId: soloOrgId },
    );
    const { employeeId: empSoloOwner } = await rt.execute<HrWritten>(
      'hr.payroll.employee.add',
      {
        displayName: 'Chủ OPC',
        jobTitle: 'Giám đốc',
        employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '15000000' },
      },
      { actor: asMfa(soloOwner), orgId: soloOrgId },
    );
    await rt.execute(
      'hr.payroll.employee.link_member',
      { employeeId: empSoloOwner!, userId: soloOwner },
      { actor: asMfa(soloOwner), orgId: soloOrgId },
    );
    const { employeeId: empSoloPeer } = await rt.execute<HrWritten>(
      'hr.payroll.employee.add',
      {
        displayName: 'Cộng sự',
        jobTitle: 'Nhân viên',
        employment: { effectiveFrom: '2026-01-01', contractType: 'indefinite', region: 'I', baseWage: '10000000' },
      },
      { actor: asMfa(soloOwner), orgId: soloOrgId },
    );
    const soloTplSang = soloSeeded.templates.find((t) => t.code === 'CA_SANG')!;
    const soloAssign = await rt.execute<HrShiftAssignmentView>(
      'hr.shift.assignment.upsert',
      { employeeId: empSoloOwner!, shiftTemplateId: soloTplSang.id, workDate: '2027-04-14' },
      { actor: asUser(soloOwner), orgId: soloOrgId },
    );
    const soloSwap = await rt.execute<HrShiftSwapView>(
      'hr.self.shift_swap.submit',
      { requesterAssignmentId: soloAssign.id, targetEmployeeId: empSoloPeer! },
      { actor: asUser(soloOwner), orgId: soloOrgId },
    );
    const soloApproved = await rt.execute<HrShiftSwapView>(
      'hr.shift_swap.approve',
      { swapId: soloSwap.id },
      { actor: asUser(soloOwner), orgId: soloOrgId },
    );
    expect(soloApproved.status).toBe('approved');

    // 8. Verify SECURITY DEFINER & trigger pg_proc hardening
    for (const fn of [
      'ludy_hr.is_active_linked_employee(uuid, uuid)',
      'ludy_hr.shift_visible_employees(uuid, uuid)',
      'ludy_hr.lock_shift_employee_active(uuid, uuid)',
      'ludy_hr.shift_unavailable_employee_dates(uuid, uuid, date, date)',
      'ludy_hr.resolve_self_shift_swap_target(uuid, uuid, uuid, date)',
      'ludy_hr.shift_swap_assignment_labels(uuid, uuid, uuid[])',
    ]) {
      const meta = (
        await adminPool.query<{
          prosecdef: boolean;
          proconfig: string[];
          pub_exec: boolean;
          auth_reader_exec: boolean;
          tenant_exec: boolean;
        }>(
          `SELECT p.prosecdef,
                  p.proconfig,
                  pg_catalog.has_function_privilege('public', p.oid, 'EXECUTE') AS pub_exec,
                  pg_catalog.has_function_privilege('ludy_auth_reader', p.oid, 'EXECUTE') AS auth_reader_exec,
                  pg_catalog.has_function_privilege('ludy_tenant', p.oid, 'EXECUTE') AS tenant_exec
             FROM pg_catalog.pg_proc p
            WHERE p.oid = $1::pg_catalog.regprocedure`,
          [fn],
        )
      ).rows[0];
      expect(meta, fn).toEqual({
        prosecdef: true,
        proconfig: ['search_path=pg_catalog, pg_temp'],
        pub_exec: false,
        auth_reader_exec: false,
        tenant_exec: true,
      });
    }

    // 9. org_purge deletes shift_swap_request, shift_assignment, and shift_template cleanly
    const dayMs = 24 * 60 * 60 * 1000;
    const pClient = await adminPool.connect();
    let pInTx = false;
    let pBroken = false;
    try {
      await pClient.query('BEGIN');
      pInTx = true;
      await pClient.query('SET LOCAL session_replication_role = replica');
      await pClient.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [o.orgId]);
      await pClient.query('COMMIT');
      pInTx = false;
      await pClient.query(
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
    } catch (err) {
      if (pInTx) await pClient.query('ROLLBACK').catch(() => { pBroken = true; });
      throw err;
    } finally {
      pClient.release(pBroken);
    }

    const purged = await purgeOrg(workerRt, 30, { ref: o.orgId, reason: 'Stage 7A test cleanup' });
    expect(purged.kind).toBe('purged');

    for (const tbl of ['ludy_hr.shift_swap_request', 'ludy_hr.shift_assignment', 'ludy_hr.shift_template']) {
      const left = (await adminPool.query<{ c: string }>(`SELECT count(*)::text AS c FROM ${tbl} WHERE org_id = $1`, [o.orgId])).rows[0]?.c;
      expect(left, tbl).toBe('0');
    }
  });
});

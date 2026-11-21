// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end runtime verification for HR employee self-service portal & multi-level leave approval (issue #4300, Stage 4A).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PAYROLL_RULES } from '@ludy/l10n-vn';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelManifest, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  HrDepartmentView,
  HrEmployee,
  HrEmployeeSummary,
  HrLeaveRequestActionResult,
  HrLeaveRequestView,
  HrPayslip,
  HrRunSheet,
  HrRunWritten,
  HrSelfLeaveBalanceResult,
  HrSelfLeaveSubmitResult,
  HrSelfPayslipSummary,
  HrSelfProfile,
  HrWritten,
} from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey } from '@ludy/kernel-runtime';
import { hrCommands, hrManifest, hrQueries } from '../src/index.ts';

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

type PoolHandle = ReturnType<typeof createPool>;

suite('HR self-service portal & multi-level leave approval (#4300)', () => {
  const dbName = `crove_test_hr_portal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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

  async function setupOrg() {
    const tag = randomUUID().slice(0, 8);
    const db = createDb(appPool);
    const person = (role: string, name: string | null) =>
      upsertIdentity(db, {
        issuer: 'hr-portal',
        subject: `${role}-${tag}`,
        email: `${role}-${tag}@hr.test`,
        name,
      });
    const owner = await person('owner', 'Chủ Doanh Nghiệp');
    const manager = await person('manager', 'Quản Lý Bộ Phận');
    const staffA = await person('staffa', 'Nguyễn Văn An');
    const staffB = await person('staffb', 'Trần Thị Bình');
    const staffC = await person('staffc', 'Lê Minh Chi');
    const unlinked = await person('unlinked', 'Chưa Liên Kết');
    const viewer = await person('viewer', 'Người Xem');

    const created = await createOrg(rt, asUser(owner), `Cty Self Service ${tag}`);
    const orgId = created.orgId;
    await adminPool.query(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($1, $7, 'viewer')`,
      [orgId, manager, staffA, staffB, staffC, unlinked, viewer],
    );

    const exec = <O>(userId: string, name: string, input: unknown, actor: Parameters<Runtime['execute']>[2]['actor'] = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });

    return {
      orgId,
      owner,
      manager,
      staffA,
      staffB,
      staffC,
      unlinked,
      viewer,
      exec,
      query,
    };
  }

  beforeAll(async () => {
    const rootPool = createPool({ connectionString: ADMIN as string, max: 1, resetOnRelease: false });
    await rootPool.query(`CREATE DATABASE ${dbName}`);
    await rootPool.end();

    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });

    adminPool = createPool({ connectionString: adminUrl, max: 2, resetOnRelease: false });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
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
  }, 420_000);

  afterAll(async () => {
    await appPool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootPool = createPool({ connectionString: ADMIN, max: 1, resetOnRelease: false });
    await rootPool.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootPool.end();
  });

  it('supports department manager assignment, member linking, L1/final leave flow, payslips, and erasure cleanup', async () => {
    const o = await setupOrg();

    const { departmentId: deptTech } = await o.exec<{ departmentId: string }>(o.owner, 'hr.department.add', {
      name: 'Kỹ thuật',
      code: 'KT',
      payFunction: 'production',
    });

    // Department manager validation: rejects non-member and viewer, accepts active member.
    await expect(
      o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptTech, managerUserId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'HR_MEMBER_NOT_FOUND', status: 404 });
    await expect(
      o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptTech, managerUserId: o.viewer }),
    ).rejects.toMatchObject({ code: 'HR_MEMBER_ROLE_VIEWER', status: 422 });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptTech, managerUserId: o.manager });

    const depts = await o.query<HrDepartmentView[]>(o.owner, 'hr.department.list', {});
    expect(depts[0]).toMatchObject({
      id: deptTech,
      managerUserId: o.manager,
      managerName: 'Quản Lý Bộ Phận',
    });

    const hire = (displayName: string, departmentId: string | undefined, baseWage: string) =>
      o.exec<HrWritten>(o.owner, 'hr.payroll.employee.add', {
        displayName,
        ...(departmentId ? { departmentId } : {}),
        employment: {
          effectiveFrom: '2026-01-01',
          contractType: 'indefinite',
          region: 'I',
          baseWage,
        },
      });

    const empA = (await hire('Nguyễn Văn An', deptTech, '18000000')).employeeId as string;
    const empB = (await hire('Trần Thị Bình', deptTech, '16000000')).employeeId as string;
    const empC = (await hire('Lê Minh Chi', undefined, '15000000')).employeeId as string;

    // Member link validation: rejects viewer, allows 1-to-1 link, rejects duplicate link (409).
    await expect(
      o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empA, userId: o.viewer }),
    ).rejects.toMatchObject({ code: 'HR_MEMBER_ROLE_VIEWER', status: 422 });
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empA, userId: o.staffA });
    await expect(
      o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empB, userId: o.staffA }),
    ).rejects.toMatchObject({ code: 'HR_MEMBER_ALREADY_LINKED', status: 409 });

    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empB, userId: o.staffB });
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empC, userId: o.staffC });

    const empSummaries = await o.query<HrEmployeeSummary[]>(o.owner, 'hr.payroll.employee.list', { status: 'active' });
    expect(empSummaries.find((e) => e.id === empA)).toMatchObject({
      linkedUserId: o.staffA,
      linkedMemberName: 'Nguyễn Văn An',
    });
    const empDetail = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: empA });
    expect(empDetail.linkedUserId).toBe(o.staffA);
    expect(empDetail.linkedMemberName).toBe('Nguyễn Văn An');

    // Viewer cannot access self-service; unlinked member receives safe unlinked state & refusal on actions.
    await expect(o.query(o.viewer, 'hr.self.profile.get', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(o.query(o.viewer, 'hr.self.payslips.list', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const unlinkedProfile = await o.query<HrSelfProfile>(o.unlinked, 'hr.self.profile.get', {});
    expect(unlinkedProfile).toMatchObject({ linked: false, employeeId: null, managesDepartmentCount: 0 });
    const unlinkedBal = await o.query<HrSelfLeaveBalanceResult>(o.unlinked, 'hr.self.leave.balance', { year: '2026' });
    expect(unlinkedBal).toMatchObject({ linked: false, employeeId: null, balance: null, entries: [] });
    expect(await o.query<HrSelfPayslipSummary[]>(o.unlinked, 'hr.self.payslips.list', {})).toEqual([]);
    await expect(
      o.exec(o.unlinked, 'hr.self.leave.request_submit', {
        startOn: '2026-10-05',
        endOn: '2026-10-05',
        kind: 'annual_leave',
        days: '1',
      }),
    ).rejects.toMatchObject({ code: 'HR_SELF_NOT_LINKED', status: 403 });

    // Linked employee profile & unlinked L1 manager profile.
    const profileA = await o.query<HrSelfProfile>(o.staffA, 'hr.self.profile.get', {});
    expect(profileA).toMatchObject({
      linked: true,
      employeeId: empA,
      displayName: 'Nguyễn Văn An',
      departmentId: deptTech,
      departmentName: 'Kỹ thuật',
      departmentManagerName: 'Quản Lý Bộ Phận',
      hireDate: '2026-01-01',
      managesDepartmentCount: 0,
    });
    const profileMgr = await o.query<HrSelfProfile>(o.manager, 'hr.self.profile.get', {});
    expect(profileMgr).toMatchObject({
      linked: false,
      managesDepartmentCount: 1,
    });
    expect(profileMgr.managedDepartments[0]?.id).toBe(deptTech);

    // Span check on submit & single-month routing.
    await expect(
      o.exec(o.staffA, 'hr.self.leave.request_submit', {
        startOn: '2026-10-05',
        endOn: '2026-10-06',
        kind: 'annual_leave',
        days: '5',
      }),
    ).rejects.toMatchObject({ code: 'HR_LEAVE_REQUEST_DAYS_EXCEED_SPAN', status: 422 });

    // A submits 2 days -> pending_l1, 0 overlaps. B overlaps Oct 6..7 -> pending_l1, overlapCount = 1.
    const secretReasonA = 'Nghỉ việc gia đình riêng tư tại Hà Nội';
    const subA1 = await o.exec<HrSelfLeaveSubmitResult>(o.staffA, 'hr.self.leave.request_submit', {
      startOn: '2026-10-05',
      endOn: '2026-10-06',
      kind: 'annual_leave',
      days: '2',
      reason: secretReasonA,
    });
    expect(subA1.status).toBe('pending_l1');
    expect(subA1.overlapCount).toBe(0);

    const subB1 = await o.exec<HrSelfLeaveSubmitResult>(o.staffB, 'hr.self.leave.request_submit', {
      startOn: '2026-10-06',
      endOn: '2026-10-07',
      kind: 'annual_leave',
      days: '2',
    });
    expect(subB1.status).toBe('pending_l1');
    expect(subB1.overlapCount).toBe(1);

    // Cancel by wrong employee refused (404 via RLS/ownership); cancel by owner employee succeeds once.
    await expect(o.exec(o.staffA, 'hr.self.leave.request_cancel', { requestId: subB1.requestId })).rejects.toMatchObject({
      code: 'HR_LEAVE_REQUEST_NOT_FOUND',
      status: 404,
    });
    const cancelledB = await o.exec<HrLeaveRequestActionResult>(o.staffB, 'hr.self.leave.request_cancel', {
      requestId: subB1.requestId,
    });
    expect(cancelledB.status).toBe('cancelled');
    await expect(o.exec(o.staffB, 'hr.self.leave.request_cancel', { requestId: subB1.requestId })).rejects.toMatchObject({
      code: 'HR_LEAVE_REQUEST_INVALID_STATE',
      status: 409,
    });

    // Employee without department manager routes directly to pending_final.
    const subC1 = await o.exec<HrSelfLeaveSubmitResult>(o.staffC, 'hr.self.leave.request_submit', {
      startOn: '2026-10-12',
      endOn: '2026-10-12',
      kind: 'personal_paid',
      days: '1',
    });
    expect(subC1.status).toBe('pending_final');

    // Team scope for manager shows deptTech only (A & B), excludes C.
    const teamReqs = await o.query<HrLeaveRequestView[]>(o.manager, 'hr.self.leave.requests', { scope: 'team' });
    expect(teamReqs.map((r) => r.employeeName).sort()).toEqual(['Nguyễn Văn An', 'Trần Thị Bình']);

    // Regular member A cannot L1-approve B or call HR queue/final approve.
    const subB2 = await o.exec<HrSelfLeaveSubmitResult>(o.staffB, 'hr.self.leave.request_submit', {
      startOn: '2026-10-15',
      endOn: '2026-10-15',
      kind: 'unpaid_leave',
      days: '1',
    });
    await expect(
      o.exec(o.staffA, 'hr.leave_request.approve_l1', { requestId: subB2.requestId }),
    ).rejects.toMatchObject({ code: 'HR_LEAVE_REQUEST_NOT_FOUND', status: 404 });
    await expect(o.query(o.manager, 'hr.leave_request.list', {})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      o.exec(o.manager, 'hr.leave_request.approve_final', { requestId: subA1.requestId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Manager temporarily reassigned: if staffA becomes manager of deptTech, A cannot L1-self-approve or self-reject A's own request.
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptTech, managerUserId: o.staffA });
    await expect(
      o.exec(o.staffA, 'hr.leave_request.approve_l1', { requestId: subA1.requestId }),
    ).rejects.toMatchObject({ code: 'HR_LEAVE_REQUEST_SELF_APPROVAL', status: 403 });
    await expect(
      o.exec(o.staffA, 'hr.leave_request.reject', { requestId: subA1.requestId }),
    ).rejects.toMatchObject({ code: 'HR_LEAVE_REQUEST_SELF_APPROVAL', status: 403 });
    // Submitting when you manage your own department routes straight to pending_final (no deadlock).
    const selfManagedSub = await o.exec<HrSelfLeaveSubmitResult>(o.staffA, 'hr.self.leave.request_submit', {
      startOn: '2026-10-28',
      endOn: '2026-10-28',
      kind: 'annual_leave',
      days: '1',
    });
    expect(selfManagedSub.status).toBe('pending_final');
    await o.exec(o.staffA, 'hr.self.leave.request_cancel', { requestId: selfManagedSub.requestId });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptTech, managerUserId: o.manager });

    // Manager L1 approves A1 -> pending_final (does NOT write payroll_leave_entry yet), rejects B2 -> rejected.
    const l1Res = await o.exec<HrLeaveRequestActionResult>(o.manager, 'hr.leave_request.approve_l1', {
      requestId: subA1.requestId,
      note: 'Quản lý đồng ý cho nghỉ',
    });
    expect(l1Res.status).toBe('pending_final');
    expect(l1Res.payrollLeaveEntryId).toBeNull();

    const balBeforeFinal = await o.query<HrSelfLeaveBalanceResult>(o.staffA, 'hr.self.leave.balance', { year: '2026' });
    expect(balBeforeFinal.balance?.takenAnnualDays).toBe('0');

    const rejectB2 = await o.exec<HrLeaveRequestActionResult>(o.manager, 'hr.leave_request.reject', {
      requestId: subB2.requestId,
      note: 'Đang cao điểm dự án',
    });
    expect(rejectB2.status).toBe('rejected');

    // HR/Owner final approval creates approved payroll_leave_entry & updates self balance.
    const finalNote = 'HR đã kiểm tra và chốt phép';
    const finalRes1 = await o.exec<HrLeaveRequestActionResult>(o.owner, 'hr.leave_request.approve_final', {
      requestId: subA1.requestId,
      note: finalNote,
    });
    expect(finalRes1.status).toBe('approved');
    expect(finalRes1.payrollLeaveEntryId).toBeTruthy();

    const balAfter1 = await o.query<HrSelfLeaveBalanceResult>(o.staffA, 'hr.self.leave.balance', { year: '2026' });
    expect(balAfter1.balance?.takenAnnualDays).toBe('2');

    // Second request for A in the same month increments the monthly payroll_leave_entry (2 + 1.5 = 3.5).
    const subA2 = await o.exec<HrSelfLeaveSubmitResult>(o.staffA, 'hr.self.leave.request_submit', {
      startOn: '2026-10-20',
      endOn: '2026-10-21',
      kind: 'annual_leave',
      days: '1.5',
    });
    await o.exec(o.manager, 'hr.leave_request.approve_l1', { requestId: subA2.requestId });
    const finalRes2 = await o.exec<HrLeaveRequestActionResult>(o.owner, 'hr.leave_request.approve_final', {
      requestId: subA2.requestId,
    });
    expect(finalRes2.payrollLeaveEntryId).toBe(finalRes1.payrollLeaveEntryId);
    const balAfter2 = await o.query<HrSelfLeaveBalanceResult>(o.staffA, 'hr.self.leave.balance', { year: '2026' });
    expect(balAfter2.balance?.takenAnnualDays).toBe('3.5');

    // Approving beyond 31 days in a month fails cleanly without updating request status.
    await o.exec(o.owner, 'hr.payroll.leave.set', {
      employeeId: empA,
      month: '2026-11',
      kind: 'annual_leave',
      days: '30',
      approved: true,
    });
    const novReq = await o.exec<HrSelfLeaveSubmitResult>(o.staffA, 'hr.self.leave.request_submit', {
      startOn: '2026-11-10',
      endOn: '2026-11-11',
      kind: 'annual_leave',
      days: '2',
    });
    await o.exec(o.manager, 'hr.leave_request.approve_l1', { requestId: novReq.requestId });
    await expect(
      o.exec(o.owner, 'hr.leave_request.approve_final', { requestId: novReq.requestId }),
    ).rejects.toMatchObject({ code: 'HR_LEAVE_DAYS_EXCEEDS_MONTH', status: 422 });

    // HR manager queue shows all requests with statuses and names.
    const adminQueue = await o.query<HrLeaveRequestView[]>(o.owner, 'hr.leave_request.list', {});
    expect(adminQueue.find((r) => r.id === subA1.requestId)).toMatchObject({
      status: 'approved',
      l1ApproverName: 'Quản Lý Bộ Phận',
      finalActedByName: 'Chủ Doanh Nghiệp',
      decisionNote: finalNote,
    });

    // Self-service payslips: draft runs stay invisible; approved runs become visible only to owning employee.
    const draftRun = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-10' });
    const draftSheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: draftRun.runId });
    const lineA = draftSheet.lines.find((l) => l.employeeId === empA && l.kind === 'pay');
    expect(lineA).toBeTruthy();

    expect(await o.query<HrSelfPayslipSummary[]>(o.staffA, 'hr.self.payslips.list', {})).toEqual([]);
    await expect(o.query(o.staffA, 'hr.self.payslip.get', { lineId: lineA!.id })).rejects.toMatchObject({
      code: 'HR_LINE_NOT_FOUND',
      status: 404,
    });

    setRuleStatus('confirmed');
    try {
      await o.exec(o.owner, 'hr.payroll.run.approve', { runId: draftRun.runId, fingerprint: draftSheet.fingerprint, acceptFlags: true }, asMfa(o.owner));
    } finally {
      setRuleStatus('commentary');
    }
    const payslipsA = await o.query<HrSelfPayslipSummary[]>(o.staffA, 'hr.self.payslips.list', {});
    expect(payslipsA).toHaveLength(1);
    expect(payslipsA[0]).toMatchObject({ lineId: lineA!.id, month: '2026-10', status: 'approved' });
    const payslipDetailA = await o.query<HrPayslip>(o.staffA, 'hr.self.payslip.get', { lineId: lineA!.id });
    expect(payslipDetailA.employeeName).toBe('Nguyễn Văn An');
    expect(payslipDetailA.status).toBe('approved');
    await expect(o.query(o.staffC, 'hr.self.payslip.get', { lineId: lineA!.id })).rejects.toMatchObject({
      code: 'HR_LINE_NOT_FOUND',
      status: 404,
    });

    // Audit log carries no raw PII notes/reasons.
    const auditRows = await adminPool.query<{ command: string; detail: unknown }>(
      `SELECT command, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command IN ('hr.self.leave.request_submit', 'hr.leave_request.approve_final')`,
      [o.orgId],
    );
    const serializedAudit = JSON.stringify(auditRows.rows);
    expect(serializedAudit).not.toContain(secretReasonA);
    expect(serializedAudit).not.toContain(finalNote);

    // Employee erasure clears user_id linkage.
    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empC, endedOn: '2026-08-31' });
    const adminClient = await adminPool.connect();
    try {
      await adminClient.query('BEGIN');
      await adminClient.query('SET LOCAL session_replication_role = replica');
      await adminClient.query(
        `UPDATE crove_hr.payroll_employee
            SET ended_on = ((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date
          WHERE id = $1`,
        [empC],
      );
      await adminClient.query('COMMIT');
    } finally {
      adminClient.release();
    }
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: empC }, asMfa(o.owner));
    const clearedRow = await adminPool.query<{ user_id: string | null }>(
      `SELECT user_id FROM crove_hr.payroll_employee WHERE id = $1`,
      [empC],
    );
    expect(clearedRow.rows[0]?.user_id).toBeNull();
    expect((await o.query<HrSelfProfile>(o.staffC, 'hr.self.profile.get', {})).linked).toBe(false);
  });

  it('preserves L1 notes on cancel, enforces self-approval matrix, and nulls entry ref on leave delete', async () => {
    const o = await setupOrg();

    const { departmentId: deptOps } = await o.exec<{ departmentId: string }>(o.owner, 'hr.department.add', {
      name: 'Vận hành',
      code: 'VH',
      payFunction: 'admin',
    });
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptOps, managerUserId: o.manager });

    const hire = (
      userId: string,
      orgId: string,
      displayName: string,
      departmentId?: string,
    ) =>
      rt.execute<HrWritten>(
        'hr.payroll.employee.add',
        {
          displayName,
          ...(departmentId ? { departmentId } : {}),
          employment: {
            effectiveFrom: '2026-01-01',
            contractType: 'indefinite',
            region: 'I',
            baseWage: '15000000',
          },
        },
        { actor: asUser(userId), orgId },
      );

    const empStaff = (await hire(o.owner, o.orgId, 'Phạm Thị Dung', deptOps)).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empStaff, userId: o.staffA });

    // (a) Employee can cancel pending_final after L1 approves with a note, and L1 note stays intact.
    const l1Note = 'QL đã kiểm tra lịch bàn giao';
    const subCancel = await o.exec<HrSelfLeaveSubmitResult>(o.staffA, 'hr.self.leave.request_submit', {
      startOn: '2026-04-06',
      endOn: '2026-04-06',
      kind: 'annual_leave',
      days: '1.0',
      reason: 'Khám sức khỏe định kỳ',
    });
    const l1Approved = await o.exec<HrLeaveRequestActionResult>(o.manager, 'hr.leave_request.approve_l1', {
      requestId: subCancel.requestId,
      note: l1Note,
    });
    expect(l1Approved.status).toBe('pending_final');

    const cancelled = await o.exec<HrLeaveRequestActionResult>(o.staffA, 'hr.self.leave.request_cancel', {
      requestId: subCancel.requestId,
    });
    expect(cancelled.status).toBe('cancelled');

    const myRequests = await o.query<HrLeaveRequestView[]>(o.staffA, 'hr.self.leave.requests', {
      scope: 'mine',
    });
    expect(myRequests.find((r) => r.id === subCancel.requestId)).toMatchObject({
      status: 'cancelled',
      decisionNote: l1Note,
    });

    // (c) hr.payroll.leave.delete nulls payroll_leave_entry_id on leave_request while keeping status = 'approved'.
    const approvedReason = 'Nghỉ phép gia đình tháng 4';
    const approvedFinalNote = 'Đã duyệt chốt kỳ 4';
    const subApproved = await o.exec<HrSelfLeaveSubmitResult>(o.staffA, 'hr.self.leave.request_submit', {
      startOn: '2026-04-13',
      endOn: '2026-04-14',
      kind: 'annual_leave',
      days: '2.0',
      reason: approvedReason,
    });
    await o.exec(o.manager, 'hr.leave_request.approve_l1', { requestId: subApproved.requestId });
    const approved = await o.exec<HrLeaveRequestActionResult>(o.owner, 'hr.leave_request.approve_final', {
      requestId: subApproved.requestId,
      note: approvedFinalNote,
    });
    expect(approved.status).toBe('approved');
    expect(approved.payrollLeaveEntryId).toBeTruthy();

    const deletedLeave = await o.exec<{ employeeId: string; entryId: string | null; deleted: boolean }>(
      o.owner,
      'hr.payroll.leave.delete',
      { entryId: approved.payrollLeaveEntryId },
    );
    expect(deletedLeave).toMatchObject({
      employeeId: empStaff,
      entryId: approved.payrollLeaveEntryId,
      deleted: true,
    });

    const queueAfterDelete = await o.query<HrLeaveRequestView[]>(o.owner, 'hr.leave_request.list', {});
    expect(queueAfterDelete.find((r) => r.id === subApproved.requestId)).toMatchObject({
      status: 'approved',
      payrollLeaveEntryId: null,
    });

    // (b1) Admin or multi-owner cannot self-approve their own leave request on approve_final.
    const tag = randomUUID().slice(0, 8);
    const adminUser = await upsertIdentity(createDb(appPool), {
      issuer: 'hr',
      subject: `admin-${tag}`,
      email: `admin-${tag}@hr.test`,
      name: 'Quản Trị Viên',
    });
    const secondOwner = await upsertIdentity(createDb(appPool), {
      issuer: 'hr',
      subject: `owner2-${tag}`,
      email: `owner2-${tag}@hr.test`,
      name: 'Đồng Sáng Lập',
    });
    await adminPool.query(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'owner')`,
      [o.orgId, adminUser, secondOwner],
    );

    const empAdmin = (await hire(o.owner, o.orgId, 'Quản Trị Viên')).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empAdmin, userId: adminUser });
    const adminSelfReq = await rt.execute<HrSelfLeaveSubmitResult>(
      'hr.self.leave.request_submit',
      { startOn: '2026-05-04', endOn: '2026-05-04', kind: 'annual_leave', days: '1.0' },
      { actor: asUser(adminUser), orgId: o.orgId },
    );
    await expect(
      rt.execute(
        'hr.leave_request.approve_final',
        { requestId: adminSelfReq.requestId },
        { actor: asUser(adminUser), orgId: o.orgId },
      ),
    ).rejects.toMatchObject({ code: 'HR_LEAVE_REQUEST_SELF_APPROVAL', status: 403 });

    const empOwner = (await hire(o.owner, o.orgId, 'Chủ Doanh Nghiệp')).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empOwner, userId: o.owner });
    const ownerSelfReq = await o.exec<HrSelfLeaveSubmitResult>(o.owner, 'hr.self.leave.request_submit', {
      startOn: '2026-05-05',
      endOn: '2026-05-05',
      kind: 'annual_leave',
      days: '1.0',
    });
    await expect(
      o.exec(o.owner, 'hr.leave_request.approve_final', { requestId: ownerSelfReq.requestId }),
    ).rejects.toMatchObject({ code: 'HR_LEAVE_REQUEST_SELF_APPROVAL', status: 403 });

    // (b2) Sole-owner OPC org allows owner self-approval and audits selfApproved: true.
    const soleOwner = await upsertIdentity(createDb(appPool), {
      issuer: 'hr',
      subject: `sole-${tag}`,
      email: `sole-${tag}@hr.test`,
      name: 'Chủ OPC',
    });
    const { orgId: soleOrgId } = await createOrg(rt, asUser(soleOwner), `OPC ${tag}`);
    const empSole = (await hire(soleOwner, soleOrgId, 'Chủ OPC')).employeeId as string;
    await rt.execute(
      'hr.payroll.employee.link_member',
      { employeeId: empSole, userId: soleOwner },
      { actor: asUser(soleOwner), orgId: soleOrgId },
    );
    const soleReq = await rt.execute<HrSelfLeaveSubmitResult>(
      'hr.self.leave.request_submit',
      { startOn: '2026-06-08', endOn: '2026-06-08', kind: 'annual_leave', days: '1.0' },
      { actor: asUser(soleOwner), orgId: soleOrgId },
    );
    expect(soleReq.status).toBe('pending_final');

    const soleApproved = await rt.execute<HrLeaveRequestActionResult>(
      'hr.leave_request.approve_final',
      { requestId: soleReq.requestId, note: 'Chủ OPC tự duyệt' },
      { actor: asUser(soleOwner), orgId: soleOrgId },
    );
    expect(soleApproved).toMatchObject({
      requestId: soleReq.requestId,
      status: 'approved',
      payrollLeaveEntryId: expect.any(String),
    });

    const soleAudit = await adminPool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM crove_kernel.audit_event
        WHERE org_id = $1 AND command = 'hr.leave_request.approve_final'
        ORDER BY occurred_at DESC LIMIT 1`,
      [soleOrgId],
    );
    expect(soleAudit.rows[0]?.detail).toMatchObject({ selfApproved: true });

    // (d) Direct reason tampering on non-erased rows fails (42501); employee erase wipes reason + decision_note (pending and terminal) and masks selfLeaveRequests.
    const subPendingForErase = await o.exec<HrSelfLeaveSubmitResult>(o.staffA, 'hr.self.leave.request_submit', {
      startOn: '2026-04-20',
      endOn: '2026-04-20',
      kind: 'annual_leave',
      days: '1.0',
      reason: 'Lý do riêng chờ duyệt',
    });
    await expect(
      adminPool.query(`UPDATE crove_hr.leave_request SET reason = 'Tamper' WHERE id = $1`, [subPendingForErase.requestId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      adminPool.query(`UPDATE crove_hr.leave_request SET reason = 'Tamper' WHERE id = $1`, [subApproved.requestId]),
    ).rejects.toMatchObject({ code: '42501' });

    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empStaff, endedOn: '2026-08-31' });
    const adminClient = await adminPool.connect();
    try {
      await adminClient.query('BEGIN');
      await adminClient.query('SET LOCAL session_replication_role = replica');
      await adminClient.query(
        `UPDATE crove_hr.payroll_employee
            SET ended_on = ((pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - interval '10 years 1 day')::date
          WHERE id = $1`,
        [empStaff],
      );
      await adminClient.query('COMMIT');
    } finally {
      adminClient.release();
    }
    const erased = await o.exec<{ cleared: string[] }>(
      o.owner,
      'hr.payroll.employee.erase',
      { employeeId: empStaff },
      asMfa(o.owner),
    );
    expect(erased.cleared).toContain('leave request notes');

    const dbNotes = await adminPool.query<{ id: string; reason: string | null; decision_note: string | null }>(
      `SELECT id, reason, decision_note FROM crove_hr.leave_request WHERE employee_id = $1`,
      [empStaff],
    );
    expect(dbNotes.rows).toHaveLength(3);
    for (const row of dbNotes.rows) {
      expect(row.reason).toBeNull();
      expect(row.decision_note).toBeNull();
    }

    const teamAfterErase = await o.query<HrLeaveRequestView[]>(o.manager, 'hr.self.leave.requests', {
      scope: 'team',
    });
    const erasedTeamRows = teamAfterErase.filter((r) => r.employeeId === empStaff);
    expect(erasedTeamRows).toHaveLength(3);
    for (const row of erasedTeamRows) {
      expect(row.employeeName).toBe('');
      expect(row.reason).toBeNull();
      expect(row.decisionNote).toBeNull();
    }
  });
});

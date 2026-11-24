// SPDX-License-Identifier: AGPL-3.0-only
// Stage 5B DB integration tests (#4448) on real PostgreSQL 17:
// 1. Self-service onboarding checklist & owner/admin review (no direct PII overwrite, sealed bytes, RLS).
// 2. 2-level overtime (OT) requests (pending_l1 -> pending_final -> approved, anti-self-approval, Art. 107 >40h warning,
//    automatic draft payroll rollup, Art. 98 commentary blocking until #2535).
// 3. End-of-probation review (deterministic Ludy Projects completed task facts respecting private project RLS & MODULE_OFF,
//    attendance summary, metered Ly proposal draft, human-only decision).
// 4. PDPL erasure across all 3 Stage 5B tables and ludy_kernel.org_purge cleanup.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AiMeter } from '@ludy/agent';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { vietnamToday } from '@ludy/kernel-contract';
import type {
  HrAttendanceRollupResult,
  HrEmployee,
  HrOnboardingApproveResult,
  HrOnboardingSubmissionView,
  HrOvertimeActionResult,
  HrOvertimeRequestView,
  HrProbationDecideResult,
  HrProbationPreviewResult,
  HrProbationReviewView,
  HrRunSheet,
  HrRunWritten,
  HrSelfOnboardingState,
  HrSelfOnboardingSubmitResult,
  HrSelfOvertimeListResult,
  HrSelfOvertimeSubmitResult,
  HrWritten,
} from '@ludy/kernel-contract';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { PAYROLL_RULES, type PayrollBreakdown } from '@ludy/l10n-vn';
import { hrCommands, hrQueries, type HrProbationBriefSource } from '@ludy/mod-hr';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { draftProbationSummary, hrProbationAi } from '../src/hr-probation-ai.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

vi.mock('@ludy/l10n-vn', async (importOriginal) => {
  const real = await importOriginal<typeof import('@ludy/l10n-vn')>();
  return { ...real, PAYROLL_RULES: real.PAYROLL_RULES.map((row) => ({ ...row })) };
});
const setRuleStatus = (status: 'confirmed' | 'commentary') => {
  for (const row of PAYROLL_RULES) (row as { status: string }).status = status;
};

const otHoursOnLine = (line: HrRunSheet['lines'][number] | undefined): number => {
  const bd = line?.breakdown as PayrollBreakdown | null | undefined;
  return bd?.pay.overtime.reduce((sum, item) => sum + Number(item.hours), 0) ?? 0;
};

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
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

suite('HR Stage 5B onboarding, 2-level OT to payroll, and probation review (#4448)', () => {
  const dbName = `crove_test_hr5b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
      upsertIdentity(db, { issuer: 'hr5b', subject: `${role}-${tag}`, email: `${role}-${tag}@hr5b.test`, name });
    const owner = await person('owner', 'Chủ Doanh Nghiệp');
    const admin = await person('admin', 'Quản Trị Nhân Sự');
    const manager = await person('manager', 'Trưởng Phòng Kỹ Thuật');
    const staffA = await person('staffa', 'Nguyễn Văn A');
    const staffB = await person('staffb', 'Trần Thị B');
    const viewer = await person('viewer', 'Người Xem');

    const { orgId } = await createOrg(rt, asUser(owner), `Cty Stage 5B ${tag}`);
    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer')`,
      [orgId, admin, manager, staffA, staffB, viewer],
    );

    const exec = <O>(
      userId: string,
      name: string,
      input: unknown,
      actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId),
    ) => rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) =>
      rt.query<O>(name, input, { actor: asUser(userId), orgId });

    return { orgId, owner, admin, manager, staffA, staffB, viewer, exec, query };
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
      commands: [...kernelCommands, ...hrCommands, ...projectsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, ...projectsQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS, subjectVault }).register({
      commands: [...kernelCommands, ...hrCommands, ...projectsCommands, orgPurgeCommand({ store })],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, ...projectsQueries],
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

  it('reviews self-service onboarding submissions before updating employee PII and enforces strict RLS', async () => {
    const o = await setupOrg();
    const o2 = await setupOrg();
    const empA = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nguyễn Văn A',
          employment: {
            effectiveFrom: '2026-09-01',
            contractType: 'indefinite',
            region: 'I',
            baseWage: '18000000',
          },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    const empB = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Trần Thị B',
          employment: {
            effectiveFrom: '2026-09-01',
            contractType: 'indefinite',
            region: 'I',
            baseWage: '16000000',
          },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empA, userId: o.staffA }, asMfa(o.owner));
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empB, userId: o.staffB }, asMfa(o.owner));

    const first = await o.exec<HrSelfOnboardingSubmitResult>(o.staffA, 'hr.self.onboarding.submit', {
      contactConfirmed: true,
      handbookConfirmed: true,
      address: '123 Lê Lợi, Quận 1, TP.HCM',
      birthDate: '1997-04-12',
      identityNumber: '079097001234',
      bankCode: 'VCB',
      accountNumber: '123456789012',
      taxCode: '8123456789',
      insuranceNumber: '7912345679',
      note: 'Xác nhận thông tin nhận lương',
    });
    expect(first.status).toBe('pending');

    // Employee profile stays unchanged while submission is pending.
    const beforeEmp = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: empA });
    expect(beforeEmp.address).toBeNull();
    expect(beforeEmp.identityNumber).toBeNull();
    expect(beforeEmp.accountNumber).toBeNull();

    // Peer staffB and viewer cannot read staffA's submission at runtime or under raw tenant RLS.
    await expect(o.query(o.staffB, 'hr.onboarding.list', {})).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(o.query(o.viewer, 'hr.onboarding.list', {})).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      o.exec(o.staffA, 'hr.onboarding.approve', { submissionId: first.submissionId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(o2.query(o2.owner, 'hr.onboarding.list', {})).resolves.toEqual([]);

    const appClient = await appPool.connect();
    try {
      await appClient.query('BEGIN');
      await enterUser(appClient, o.staffB, o.orgId);
      const peerRows = await appClient.query(`SELECT id FROM ludy_hr.onboarding_submission WHERE org_id = $1`, [o.orgId]);
      expect(peerRows.rows).toHaveLength(0);
      await appClient.query('ROLLBACK');
    } finally {
      appClient.release();
    }

    // Reject flow keeps employee record untouched, cancel works for pending own row.
    await o.exec(o.owner, 'hr.onboarding.reject', { submissionId: first.submissionId, note: 'Thiếu số tài khoản đúng' });
    const afterReject = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: empA });
    expect(afterReject.address).toBeNull();

    const toCancel = await o.exec<HrSelfOnboardingSubmitResult>(o.staffA, 'hr.self.onboarding.submit', {
      contactConfirmed: true,
      note: 'Gửi nhầm',
    });
    await o.exec(o.staffA, 'hr.self.onboarding.cancel', { submissionId: toCancel.submissionId });

    // Owner approves submission -> copies PII & sealed bytes into payroll_employee and checklist reflects onFile.
    const approvedSub = await o.exec<HrSelfOnboardingSubmitResult>(o.staffA, 'hr.self.onboarding.submit', {
      contactConfirmed: true,
      idConfirmed: true,
      bankConfirmed: true,
      handbookConfirmed: true,
      address: '88 Nguyễn Huệ, Quận 1, TP.HCM',
      birthDate: '1997-04-12',
      identityNumber: '079097009876',
      bankCode: 'TCB',
      accountNumber: '190333444555',
      taxCode: '8001122334',
      insuranceNumber: '7900112233',
      note: 'Hồ sơ chuẩn',
    });
    const approved = await o.exec<HrOnboardingApproveResult>(
      o.owner,
      'hr.onboarding.approve',
      { submissionId: approvedSub.submissionId, note: 'Đã đối chiếu CCCD' },
      asMfa(o.owner),
    );
    expect(approved.status).toBe('approved');
    expect(approved.updatedFields).toEqual(
      expect.arrayContaining(['address', 'birthDate', 'identityNumber', 'bankCode', 'accountNumber', 'taxCode', 'insuranceNumber']),
    );

    const afterApproveEmp = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: empA });
    expect(afterApproveEmp).toMatchObject({
      address: '88 Nguyễn Huệ, Quận 1, TP.HCM',
      birthDate: '1997-04-12',
      bankCode: 'TCB',
    });
    expect(afterApproveEmp.identityNumber).toBeTruthy();
    expect(afterApproveEmp.accountNumber).toBeTruthy();
    expect(afterApproveEmp.taxCode).toBeTruthy();
    expect(afterApproveEmp.insuranceNumber).toBeTruthy();

    const selfState = await o.query<HrSelfOnboardingState>(o.staffA, 'hr.self.onboarding.get', {});
    expect(selfState.checklist).toMatchObject({
      hasAddress: true,
      hasBirthDate: true,
      hasIdentityNumber: true,
      hasBankAccount: true,
      bankCode: 'TCB',
      hasTaxCode: true,
      hasInsuranceNumber: true,
      contactConfirmed: true,
      idConfirmed: true,
      bankConfirmed: true,
      handbookConfirmed: true,
    });
    const listView = await o.query<HrOnboardingSubmissionView[]>(o.owner, 'hr.onboarding.list', {});
    expect(listView.some((row) => row.id === approvedSub.submissionId && row.status === 'approved')).toBe(true);
  });

  it('routes 2-level OT requests, blocks self-approval, auto-rolls into draft payroll, and respects commentary lock', async () => {
    const o = await setupOrg();
    const { departmentId: deptTech } = await o.exec<{ departmentId: string }>(
      o.owner,
      'hr.department.add',
      { name: 'Kỹ thuật', code: 'KT', payFunction: 'production' },
      asMfa(o.owner),
    );
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptTech, managerUserId: o.manager }, asMfa(o.owner));

    const empA = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nguyễn Văn A',
          departmentId: deptTech,
          employment: {
            effectiveFrom: '2026-09-01',
            contractType: 'indefinite',
            region: 'I',
            baseWage: '20800000',
          },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    const empAdmin = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Quản Trị Nhân Sự',
          employment: {
            effectiveFrom: '2026-09-01',
            contractType: 'indefinite',
            region: 'I',
            baseWage: '20800000',
          },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    const empLegacy = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nhân Sự Cũ',
          employment: {
            effectiveFrom: '2026-09-01',
            contractType: 'indefinite',
            region: 'I',
            baseWage: '20800000',
          },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empA, userId: o.staffA }, asMfa(o.owner));
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empAdmin, userId: o.admin }, asMfa(o.owner));
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empLegacy, userId: o.staffB }, asMfa(o.owner));

    // Staff submits 3.5h weekday OT (pending_l1, Art. 98 commentary 150%) and another large request exceeding 40h warning.
    const ot1 = await o.exec<HrSelfOvertimeSubmitResult>(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-10-10',
      hours: '3.5',
      dayType: 'weekday',
      reason: 'Tăng ca phát hành bản sửa lỗi',
    });
    expect(ot1).toMatchObject({ status: 'pending_l1', month: '2026-10', exceedsMonthlyCap: false });

    const otCap = await o.exec<HrSelfOvertimeSubmitResult>(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-10-11',
      hours: '20',
      dayType: 'weekend',
      reason: 'Kiểm tra vượt ngưỡng 40h',
    });
    expect(otCap.exceedsMonthlyCap).toBe(false);
    const otCap2 = await o.exec<HrSelfOvertimeSubmitResult>(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-10-12',
      hours: '18',
      dayType: 'weekday',
      reason: 'Vượt ngưỡng 40h/tháng',
    });
    expect(otCap2.exceedsMonthlyCap).toBe(true);
    expect(otCap2.monthHoursTotal).toBe('41.5');
    // Cancel the two large cap-test requests before payroll calculation.
    await o.exec(o.staffA, 'hr.self.overtime.cancel', { requestId: otCap.requestId });
    await o.exec(o.staffA, 'hr.self.overtime.cancel', { requestId: otCap2.requestId });

    // Anti-self-approval: staffA cannot approveL1 own OT; non-sole admin cannot approveFinal own OT; DB trigger blocks self-update too.
    await expect(o.exec(o.staffA, 'hr.overtime.approve_l1', { requestId: ot1.requestId })).rejects.toMatchObject({
      code: 'HR_LEAVE_REQUEST_SELF_APPROVAL',
      status: 403,
    });
    const adminOt = await o.exec<HrSelfOvertimeSubmitResult>(o.admin, 'hr.self.overtime.submit', {
      workDate: '2026-10-14',
      hours: '2',
      dayType: 'weekday',
    });
    expect(adminOt.status).toBe('pending_final');
    await expect(o.exec(o.admin, 'hr.overtime.approve_final', { requestId: adminOt.requestId })).rejects.toMatchObject({
      code: 'HR_LEAVE_REQUEST_SELF_APPROVAL',
      status: 403,
    });
    await expect(
      (async () => {
        const c = await appPool.connect();
        try {
          await c.query('BEGIN');
          await enterUser(c, o.staffA, o.orgId);
          await c.query(
            `UPDATE ludy_hr.overtime_request SET status = 'pending_final', l1_approver_user_id = $2 WHERE id = $1`,
            [ot1.requestId, o.staffA],
          );
          await c.query('COMMIT');
        } finally {
          await c.query('ROLLBACK').catch(() => {});
          c.release();
        }
      })(),
    ).rejects.toThrow(/self-approval/i);

    // L1 manager sees pending_l1 in teamPending, approves L1 -> pending_final; manager cannot approve_final; owner approves final.
    const mgrView = await o.query<HrSelfOvertimeListResult>(o.manager, 'hr.self.overtime.list', { month: '2026-10' });
    expect(mgrView.teamPending.some((r) => r.id === ot1.requestId)).toBe(true);
    await o.exec(o.manager, 'hr.overtime.approve_l1', { requestId: ot1.requestId, note: 'Quản lý đã duyệt L1' });
    await expect(o.exec(o.manager, 'hr.overtime.approve_final', { requestId: ot1.requestId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    const fin1 = await o.exec<HrOvertimeActionResult>(o.owner, 'hr.overtime.approve_final', {
      requestId: ot1.requestId,
      note: 'Chốt chi lương',
    });
    expect(fin1).toMatchObject({ status: 'approved', payrollRunUpdated: false });

    // Opening draft payroll run automatically picks up approved OT (3.5h weekday @ 150% commentary).
    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-10', workingDays: '26' }, asMfa(o.owner));
    const sheet1 = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const line1 = sheet1.lines.find((l) => l.employeeId === empA && l.kind === 'pay');
    expect(line1?.inputs.overtimeFromRequests).toBe(true);
    expect(otHoursOnLine(line1)).toBe(3.5);
    expect(Number(line1?.figures?.gross ?? '0')).toBeGreaterThan(20800000);

    // Approving a second OT request in the same month automatically refreshes the existing draft payroll run.
    const ot2 = await o.exec<HrSelfOvertimeSubmitResult>(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-10-18',
      hours: '2',
      dayType: 'weekend',
      reason: 'Bảo trì cuối tuần',
    });
    await o.exec(o.manager, 'hr.overtime.approve_l1', { requestId: ot2.requestId });
    const fin2 = await o.exec<HrOvertimeActionResult>(o.owner, 'hr.overtime.approve_final', { requestId: ot2.requestId });
    expect(fin2).toMatchObject({ status: 'approved', payrollRunUpdated: true });

    const sheet2 = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const line2 = sheet2.lines.find((l) => l.employeeId === empA && l.kind === 'pay');
    expect(otHoursOnLine(line2)).toBe(5.5);

    // Manual override sets overtimeFromRequests: false; sync_overtime preserves manual overrides while syncing un-overridden lines.
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: line2!.id,
      inputs: { overtime: [{ dayKind: 'normal_day', night: false, hours: '1' }] },
    });
    const afterManual = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    expect(afterManual.lines.find((l) => l.id === line2!.id)?.inputs.overtimeFromRequests).toBe(false);

    const adminFin = await o.exec<HrOvertimeActionResult>(o.owner, 'hr.overtime.approve_final', {
      requestId: adminOt.requestId,
    });
    expect(adminFin).toMatchObject({ status: 'approved', payrollRunUpdated: true });

    await o.exec(o.owner, 'hr.payroll.run.sync_overtime', { runId: run.runId });
    const afterSync = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const lineSynced = afterSync.lines.find((l) => l.id === line2!.id)!;
    const adminSynced = afterSync.lines.find((l) => l.employeeId === empAdmin && l.kind === 'pay')!;
    expect(lineSynced.inputs.overtimeFromRequests).toBe(false);
    expect(otHoursOnLine(lineSynced)).toBe(1);
    expect(adminSynced.inputs.overtimeFromRequests).toBe(true);
    expect(otHoursOnLine(adminSynced)).toBe(2);

    // Editing an unrelated field (bonus) without passing overtime preserves both manual OT and the manual flag (false).
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: line2!.id,
      inputs: { bonus: '500000' },
    });
    await o.exec(o.owner, 'hr.payroll.run.sync_overtime', { runId: run.runId });
    const afterUnrelatedEdit = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const lineAfterBonus = afterUnrelatedEdit.lines.find((l) => l.id === line2!.id)!;
    expect(lineAfterBonus.inputs.overtimeFromRequests).toBe(false);
    expect(otHoursOnLine(lineAfterBonus)).toBe(1);

    // Pre-Stage-5B legacy draft lines (overtimeFromRequests: null with non-empty manual OT) are never wiped by
    // recalculate, sync_overtime, or approving an OT request.
    const legacyLine = afterUnrelatedEdit.lines.find((l) => l.employeeId === empLegacy && l.kind === 'pay')!;
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: legacyLine.id,
      inputs: { overtime: [{ dayKind: 'normal_day', night: false, hours: '5' }] },
    });
    await adminPool.query(
      `UPDATE ludy_hr.payroll_line
          SET inputs = inputs - 'overtimeFromRequests'
        WHERE org_id = $1 AND id = $2`,
      [o.orgId, legacyLine.id],
    );
    const staffBOt = await o.exec<HrSelfOvertimeSubmitResult>(o.staffB, 'hr.self.overtime.submit', {
      workDate: '2026-10-19',
      hours: '2',
      dayType: 'weekday',
      reason: 'OT mới không được ghi đè dòng thủ công cũ',
    });
    const staffBFin = await o.exec<HrOvertimeActionResult>(o.owner, 'hr.overtime.approve_final', {
      requestId: staffBOt.requestId,
    });
    expect(staffBFin).toMatchObject({ status: 'approved', payrollRunUpdated: false });
    await o.exec(o.owner, 'hr.payroll.run.recalculate', { runId: run.runId });
    await o.exec(o.owner, 'hr.payroll.run.sync_overtime', { runId: run.runId });
    const afterLegacySheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const legacyAfter = afterLegacySheet.lines.find((l) => l.id === legacyLine.id)!;
    expect(legacyAfter.inputs.overtimeFromRequests ?? null).toBeNull();
    expect(otHoursOnLine(legacyAfter)).toBe(5);

    // Art. 98 overtime_multiples.* stays commentary until #2535: approval refuses under commentary, succeeds when confirmed.
    setRuleStatus('commentary');
    await expect(
      o.exec(o.owner, 'hr.payroll.run.approve', { runId: run.runId, fingerprint: afterLegacySheet.fingerprint, acceptFlags: true }, asMfa(o.owner)),
    ).rejects.toMatchObject({ code: 'HR_RULES_COMMENTARY', status: 422 });

    setRuleStatus('confirmed');
    try {
      await o.exec(
        o.owner,
        'hr.payroll.run.approve',
        { runId: run.runId, fingerprint: afterLegacySheet.fingerprint, acceptFlags: true },
        asMfa(o.owner),
      );
    } finally {
      setRuleStatus('commentary');
    }

    const adminQueue = await o.query<HrOvertimeRequestView[]>(o.owner, 'hr.overtime.list', { month: '2026-10' });
    expect(adminQueue.find((r) => r.id === ot2.requestId)).toMatchObject({
      multiplierPercent: 200,
      ruleStatus: 'commentary',
      ruleId: 'overtime_multiples.weekly_rest_day',
    });

    // Archived department managers cannot approve_l1 or reject pending_l1 OT requests, and new submissions skip pending_l1.
    const otArchivedCheck = await o.exec<HrSelfOvertimeSubmitResult>(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-11-20',
      hours: '1',
      dayType: 'weekday',
    });
    expect(otArchivedCheck.status).toBe('pending_l1');
    await o.exec(o.owner, 'hr.department.archive', { departmentId: deptTech }, asMfa(o.owner));
    await expect(
      o.exec(o.manager, 'hr.overtime.approve_l1', { requestId: otArchivedCheck.requestId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      o.exec(o.manager, 'hr.overtime.reject', { requestId: otArchivedCheck.requestId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const otAfterArchive = await o.exec<HrSelfOvertimeSubmitResult>(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-11-21',
      hours: '1',
      dayType: 'weekday',
    });
    expect(otAfterArchive.status).toBe('pending_final');
  });

  it('pulls visible completed Projects tasks cleanly, honors private RLS and MODULE_OFF, uses Ly draft, and erases PII on PDPL erase', async () => {
    const o = await setupOrg();
    const empA = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nguyễn Văn A',
          jobTitle: 'Kỹ sư Backend',
          employment: {
            effectiveFrom: '2026-09-01',
            contractType: 'indefinite',
            region: 'I',
            baseWage: '20000000',
            probationRoleTier: 'college_or_above',
            probationEndOn: '2026-10-30',
            probationWage: '17000000',
          },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empA, userId: o.staffA }, asMfa(o.owner));

    // Create Projects seat for staffA, 2 done tasks in an org project, and 1 done task in a private project inaccessible to owner.
    const { positionId: seatA } = await o.exec<{ positionId: string }>(
      o.owner,
      'kernel.position.create',
      { title: 'Kỹ sư Backend', module: 'projects', roleKey: 'projects.member' },
      asMfa(o.owner),
    );
    await o.exec(o.owner, 'kernel.position.assign', { id: seatA, holder: { type: 'user', userId: o.staffA } }, asMfa(o.owner));

    const { projectId: orgProjId } = await o.exec<{ projectId: string }>(o.owner, 'projects.project.create', {
      name: 'Dự án Công Khai HR',
      visibility: 'org',
    });
    const { taskId: t1 } = await o.exec<{ taskId: string }>(o.owner, 'projects.task.create', {
      projectId: orgProjId,
      title: 'Hoàn thiện tích hợp ngân hàng',
      assigneePositionId: seatA,
      status: 'done',
    });
    const { taskId: t2 } = await o.exec<{ taskId: string }>(o.owner, 'projects.task.create', {
      projectId: orgProjId,
      title: 'Viết test hóa đơn điện tử',
      assigneePositionId: seatA,
      status: 'done',
    });

    const { projectId: privProjId } = await o.exec<{ projectId: string }>(o.staffA, 'projects.project.create', {
      name: 'Dự án Riêng Tư Không Chia Sẻ',
      visibility: 'private',
      memberUserIds: [],
    });
    await o.exec<{ taskId: string }>(o.staffA, 'projects.task.create', {
      projectId: privProjId,
      title: 'Tác vụ riêng tư của nhân viên',
      assigneePositionId: seatA,
      status: 'done',
    });

    const today = vietnamToday();
    const o2 = await setupOrg();
    // Manager-only access and cross-tenant isolation: regular members and viewers cannot enumerate coworker completed tasks,
    // and another organization's owner sees 0 tasks for staffA.
    await expect(
      o.query(o.staffB, 'projects.member_completed_tasks', { userId: o.staffA, from: '2026-09-01', to: today, limit: 50 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      o.query(o.viewer, 'projects.member_completed_tasks', { userId: o.staffA, from: '2026-09-01', to: today, limit: 50 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    const otherOrgTasks = await o2.query<{ totalCount: number; tasks: Array<{ taskId: string; title: string }> }>(
      o2.owner,
      'projects.member_completed_tasks',
      { userId: o.staffA, from: '2026-09-01', to: today, limit: 50 },
    );
    expect(otherOrgTasks).toEqual({ totalCount: 0, tasks: [] });

    // Owner sees all owner-visible tasks (org + private per ADR-0056) inside hr.probation.preview.
    const preview = await o.query<HrProbationPreviewResult>(o.owner, 'hr.probation.preview', {
      employeeId: empA,
      periodStart: '2026-09-01',
      periodEnd: today,
    });
    expect(preview.projectsAvailable).toBe(true);
    expect(preview.completedTasksCount).toBe(3);
    expect(preview.completedTasks.some((t) => t.taskId === t1)).toBe(true);
    expect(preview.completedTasks.some((t) => t.taskId === t2)).toBe(true);

    // Ly draft via kernel orchestration respects AI off (100% deterministic parity) and used with meter.
    const probationPorts = {
      read: (inp: { employeeId: string; periodStart?: string; periodEnd?: string }) =>
        rt.query<HrProbationBriefSource>(
          'hr.probation.brief.read',
          { ...inp, periodStart: '2026-09-01', periodEnd: today },
          { actor: asUser(o.owner), orgId: o.orgId },
        ),
      isAiStopped: async () =>
        (await rt.query<{ aiStopped: boolean }>('hr.probation.ai_status', {}, { actor: asUser(o.owner), orgId: o.orgId }))
          .aiStopped,
      record: (inp: { employeeId: string; aiStatus: 'used' | 'off' | 'busy' | 'budget' | 'failed' | 'no_data'; completedTasksCount: number }) =>
        rt.execute('hr.probation.brief.audit', inp, { actor: asUser(o.owner), orgId: o.orgId }),
    };
    const aiOffOut = await draftProbationSummary(
      hrProbationAi(null, new DraftBudget()),
      probationPorts,
      rt,
      o.orgId,
      asUser(o.owner),
      { employeeId: empA, periodStart: '2026-09-01', periodEnd: today },
    );
    expect(aiOffOut).toMatchObject({ status: 'off', draftNote: null, preview: { completedTasksCount: 3 } });

    const meter: AiMeter = { admit: async () => {}, record: async () => {} };
    const aiOnOut = await draftProbationSummary(
      hrProbationAi(
        {
          hrProbationSummary: async () => ({
            summary: `Trong kỳ 2026-09-01 đến ${today}, P1 hoàn thành 3 công việc trong kỳ thử việc.`,
            ai: { ok: true, reason: 'ok' },
          }),
        },
        new DraftBudget(),
      ),
      probationPorts,
      rt,
      o.orgId,
      asUser(o.owner),
      { employeeId: empA, periodStart: '2026-09-01', periodEnd: today },
      meter,
    );
    expect(aiOnOut.status).toBe('used');
    expect(aiOnOut.draftNote).toContain('P1 hoàn thành 3 công việc');

    // Disabling projects module makes preview degrade cleanly to projectsAvailable: false, 0 tasks, keeping attendance summary.
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'projects', enabled: false }, asMfa(o.owner));
    const offPreview = await o.query<HrProbationPreviewResult>(o.owner, 'hr.probation.preview', {
      employeeId: empA,
      periodStart: '2026-09-01',
      periodEnd: today,
    });
    expect(offPreview.projectsAvailable).toBe(false);
    expect(offPreview.completedTasksCount).toBe(0);
    expect(offPreview.completedTasks).toEqual([]);
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'projects', enabled: true }, asMfa(o.owner));

    // Human-only probation decision stores immutable snapshots and blocks self-review.
    await expect(
      o.exec(o.staffA, 'hr.probation.decide', {
        employeeId: empA,
        periodStart: '2026-09-01',
        periodEnd: today,
        decision: 'pass',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const secretNote = 'Đạt yêu cầu kỹ thuật sau 2 tháng thử việc';
    const decided = await o.exec<HrProbationDecideResult>(o.admin, 'hr.probation.decide', {
      employeeId: empA,
      periodStart: '2026-09-01',
      periodEnd: today,
      probationEndOn: '2026-10-30',
      decision: 'pass',
      reviewNote: secretNote,
      aiDraftNote: aiOnOut.draftNote,
    });
    expect(decided.decision).toBe('pass');

    const reviews = await o.query<HrProbationReviewView[]>(o.owner, 'hr.probation.list', { employeeId: empA });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      decision: 'pass',
      completedTasksCount: 3,
      projectsAvailable: true,
      reviewNote: secretNote,
      aiDraftNote: aiOnOut.draftNote,
    });

    // Recorded probation reviews are immutable against direct non-erasure updates, while kernel.member.remove
    // triggers ON DELETE SET NULL(reviewer_user_id) cleanly without hitting the write guard.
    await expect(
      (async () => {
        const c = await appPool.connect();
        try {
          await c.query('BEGIN');
          await enterUser(c, o.owner, o.orgId);
          await c.query(`UPDATE ludy_hr.probation_review SET decision = 'extend' WHERE id = $1`, [decided.reviewId]);
          await c.query('COMMIT');
        } finally {
          await c.query('ROLLBACK').catch(() => {});
          c.release();
        }
      })(),
    ).rejects.toThrow(/immutable/i);

    await expect(o.exec(o.owner, 'kernel.member.remove', { userId: o.admin }, asMfa(o.owner))).resolves.toMatchObject({
      userId: o.admin,
    });
    const afterReviewerRemoved = (
      await adminPool.query<{ reviewer_user_id: string | null; decision: string; review_note: string | null }>(
        `SELECT reviewer_user_id, decision, review_note FROM ludy_hr.probation_review WHERE id = $1`,
        [decided.reviewId],
      )
    ).rows[0];
    expect(afterReviewerRemoved).toEqual({
      reviewer_user_id: null,
      decision: 'pass',
      review_note: secretNote,
    });

    // PDPL erasure cancels pending OT requests and wipes PII/notes/snapshots across all 3 Stage 5B tables.
    const obSub = await o.exec<HrSelfOnboardingSubmitResult>(o.staffA, 'hr.self.onboarding.submit', {
      contactConfirmed: true,
      address: '99 Hai Bà Trưng, TP.HCM',
      identityNumber: '079097005555',
      note: 'Ghi chú cá nhân cần xóa',
    });
    const otPending = await o.exec<HrSelfOvertimeSubmitResult>(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-11-05',
      hours: '1.5',
      dayType: 'weekday',
      reason: 'Lý do tăng ca cần xóa',
    });

    await o.exec(o.owner, 'hr.payroll.employee.end', { employeeId: empA, endedOn: '2026-11-10' }, asMfa(o.owner));
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
      if (!cCommitted) {
        await c.query('ROLLBACK').catch(() => {
          cBroken = true;
        });
      }
      throw err;
    } finally {
      c.release(cBroken);
    }
    await o.exec(o.owner, 'hr.payroll.employee.erase', { employeeId: empA }, asMfa(o.owner));

    const obRow = (
      await adminPool.query<{
        status: string;
        address: string | null;
        national_id_sealed: Buffer | null;
        note: string | null;
      }>(`SELECT status, address, national_id_sealed, note FROM ludy_hr.onboarding_submission WHERE id = $1`, [
        obSub.submissionId,
      ])
    ).rows[0];
    expect(obRow).toMatchObject({ status: 'cancelled', address: null, national_id_sealed: null, note: null });

    const otRow = (
      await adminPool.query<{ status: string; reason: string | null; decision_note: string | null }>(
        `SELECT status, reason, decision_note FROM ludy_hr.overtime_request WHERE id = $1`,
        [otPending.requestId],
      )
    ).rows[0];
    expect(otRow).toMatchObject({ status: 'cancelled', reason: null, decision_note: null });

    const probRow = (
      await adminPool.query<{
        completed_tasks_snapshot: unknown[];
        review_note: string | null;
        ai_draft_note: string | null;
      }>(`SELECT completed_tasks_snapshot, review_note, ai_draft_note FROM ludy_hr.probation_review WHERE id = $1`, [
        decided.reviewId,
      ])
    ).rows[0];
    expect(probRow).toMatchObject({ completed_tasks_snapshot: [], review_note: null, ai_draft_note: null });

    // org_purge deletes all rows cleanly across all 3 Stage 5B tables.
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
      if (pInTx) {
        await pClient.query('ROLLBACK').catch(() => {
          pBroken = true;
        });
      }
      throw err;
    } finally {
      pClient.release(pBroken);
    }
    const purged = await purgeOrg(workerRt, 30, { ref: o.orgId, reason: 'Stage 5B test cleanup' });
    expect(purged.kind).toBe('purged');
    for (const table of ['ludy_hr.onboarding_submission', 'ludy_hr.overtime_request', 'ludy_hr.probation_review']) {
      const left = await adminPool.query<{ cnt: number }>(
        `SELECT count(*)::int AS cnt FROM ${table} WHERE org_id = $1`,
        [o.orgId],
      );
      expect(left.rows[0]?.cnt).toBe(0);
    }
  });

  it('prevents sync_overtime, recalculate, and later OT approval from overwriting attendance-rolled OT (#4448 x #4463)', async () => {
    const o = await setupOrg();
    const empA = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Nguyễn Chấm Công',
          employment: {
            effectiveFrom: '2026-09-01',
            contractType: 'indefinite',
            region: 'I',
            baseWage: '20800000',
          },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empA, userId: o.staffA }, asMfa(o.owner));

    // 1. Approve initial 2h weekday OT request and open draft payroll run (overtimeFromRequests: true).
    const ot1 = await o.exec<HrSelfOvertimeSubmitResult>(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-10-09',
      hours: '2',
      dayType: 'weekday',
      reason: 'Tăng ca trước khi tổng hợp chấm công',
    });
    await o.exec(o.owner, 'hr.overtime.approve_final', { requestId: ot1.requestId });

    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-10', workingDays: '26' }, asMfa(o.owner));
    const initialSheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const initialLine = initialSheet.lines.find((l) => l.employeeId === empA && l.kind === 'pay');
    expect(initialLine?.inputs.overtimeFromRequests).toBe(true);
    expect(otHoursOnLine(initialLine)).toBe(2);

    // 2. Roll attendance into the draft payroll run with different OT (4h Sunday work = weekly_rest_day).
    await o.exec(o.owner, 'hr.attendance.adjust', {
      employeeId: empA,
      workDate: '2026-10-18',
      checkedInAt: '2026-10-18T09:00:00+07:00',
      checkedOutAt: '2026-10-18T13:00:00+07:00',
      workedMinutes: 240,
      status: 'adjusted',
      note: 'Chấm công làm thêm Chủ nhật',
    });
    const rollup = await o.exec<HrAttendanceRollupResult>(o.owner, 'hr.attendance.rollup_to_payroll', {
      runId: run.runId,
      allowIncomplete: false,
    });
    expect(rollup.updatedCount).toBe(1);

    const afterRollupSheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const rolledLine = afterRollupSheet.lines.find((l) => l.employeeId === empA && l.kind === 'pay');
    expect(rolledLine?.inputs.overtimeFromRequests).toBe(false);
    expect(rolledLine?.inputs.overtime).toEqual([{ dayKind: 'weekly_rest_day', night: false, hours: '4' }]);
    expect(otHoursOnLine(rolledLine)).toBe(4);
    const rolledGross = rolledLine?.figures?.gross;
    const rolledNet = rolledLine?.figures?.net;
    const rolledOvertimeLines = (rolledLine?.breakdown as PayrollBreakdown | null)?.pay.overtime;
    expect(rolledOvertimeLines?.length).toBeGreaterThan(0);

    // 3. Approve a second OT request and run both sync_overtime and recalculate: attendance-rolled OT must stay intact.
    const ot2 = await o.exec<HrSelfOvertimeSubmitResult>(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-10-20',
      hours: '3.5',
      dayType: 'weekday',
      reason: 'Đơn OT duyệt sau khi chốt chấm công',
    });
    const fin2 = await o.exec<HrOvertimeActionResult>(o.owner, 'hr.overtime.approve_final', {
      requestId: ot2.requestId,
    });
    expect(fin2).toMatchObject({ status: 'approved', payrollRunUpdated: false });

    await o.exec(o.owner, 'hr.payroll.run.sync_overtime', { runId: run.runId });
    await o.exec(o.owner, 'hr.payroll.run.recalculate', { runId: run.runId });

    const finalSheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const finalLine = finalSheet.lines.find((l) => l.employeeId === empA && l.kind === 'pay');
    expect(finalLine?.inputs.overtimeFromRequests).toBe(false);
    expect(finalLine?.inputs.overtime).toEqual([{ dayKind: 'weekly_rest_day', night: false, hours: '4' }]);
    expect(otHoursOnLine(finalLine)).toBe(4);
    expect((finalLine?.breakdown as PayrollBreakdown | null)?.pay.overtime).toEqual(rolledOvertimeLines);
    expect(finalLine?.figures?.gross).toBe(rolledGross);
    expect(finalLine?.figures?.net).toBe(rolledNet);
  });

  it('enforces RLS INSERT state restrictions for owner/admin and self L1 routing, and updates contractTermMonths when sync_overtime switches employment_id', async () => {
    const o = await setupOrg();
    const { departmentId: deptActive } = await o.exec<{ departmentId: string }>(
      o.owner,
      'hr.department.add',
      { name: 'Sản xuất', code: 'SX', payFunction: 'production' },
      asMfa(o.owner),
    );
    await o.exec(
      o.owner,
      'hr.department.set_manager',
      { departmentId: deptActive, managerUserId: o.manager },
      asMfa(o.owner),
    );
    const empWithMgr = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Trần RLS OT',
          departmentId: deptActive,
          employment: {
            effectiveFrom: '2026-09-01',
            contractType: 'indefinite',
            region: 'I',
            baseWage: '18000000',
          },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    const empNoMgr = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Lê Không Trưởng Bộ Phận',
          employment: {
            effectiveFrom: '2026-09-01',
            contractType: 'indefinite',
            region: 'I',
            baseWage: '16000000',
          },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empWithMgr, userId: o.staffA }, asMfa(o.owner));
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empNoMgr, userId: o.staffB }, asMfa(o.owner));

    // Owner/admin cannot direct-INSERT pre-approved onboarding submissions or OT requests via RLS WITH CHECK.
    const cOwner = await appPool.connect();
    try {
      await cOwner.query('BEGIN');
      await enterUser(cOwner, o.owner, o.orgId);
      await expect(
        cOwner.query(
          `INSERT INTO ludy_hr.onboarding_submission (org_id, employee_id, status, reviewed_by, reviewed_at)
           VALUES ($1, $2, 'approved', $3, now())`,
          [o.orgId, empWithMgr, o.owner],
        ),
      ).rejects.toThrow(/row-level security/i);
      await cOwner.query('ROLLBACK');

      await cOwner.query('BEGIN');
      await enterUser(cOwner, o.owner, o.orgId);
      await expect(
        cOwner.query(
          `INSERT INTO ludy_hr.overtime_request (org_id, employee_id, department_id, month, work_date, hours, day_type, status, final_acted_by, final_acted_at)
           VALUES ($1, $2, $3, '2026-10', '2026-10-12', 2, 'weekday', 'approved', $4, now())`,
          [o.orgId, empWithMgr, deptActive, o.owner],
        ),
      ).rejects.toThrow(/row-level security/i);
      await cOwner.query('ROLLBACK');
    } finally {
      await cOwner.query('ROLLBACK').catch(() => {});
      cOwner.release();
    }

    // Self-employee in active dept with non-viewer manager must insert status='pending_l1' with matching department_id.
    const cSelf = await appPool.connect();
    try {
      await cSelf.query('BEGIN');
      await enterUser(cSelf, o.staffA, o.orgId);
      await expect(
        cSelf.query(
          `INSERT INTO ludy_hr.overtime_request (org_id, employee_id, department_id, month, work_date, hours, day_type, status)
           VALUES ($1, $2, $3, '2026-10', '2026-10-13', 2, 'weekday', 'pending_final')`,
          [o.orgId, empWithMgr, deptActive],
        ),
      ).rejects.toThrow(/row-level security/i);
      await cSelf.query('ROLLBACK');

      await cSelf.query('BEGIN');
      await enterUser(cSelf, o.staffA, o.orgId);
      await expect(
        cSelf.query(
          `INSERT INTO ludy_hr.overtime_request (org_id, employee_id, department_id, month, work_date, hours, day_type, status)
           VALUES ($1, $2, NULL, '2026-10', '2026-10-13', 2, 'weekday', 'pending_final')`,
          [o.orgId, empWithMgr],
        ),
      ).rejects.toThrow(/row-level security/i);
      await cSelf.query('ROLLBACK');

      await cSelf.query('BEGIN');
      await enterUser(cSelf, o.staffA, o.orgId);
      await cSelf.query(
        `INSERT INTO ludy_hr.overtime_request (org_id, employee_id, department_id, month, work_date, hours, day_type, status, created_by)
         VALUES ($1, $2, $3, '2026-10', '2026-10-13', 2, 'weekday', 'pending_l1', $4)`,
        [o.orgId, empWithMgr, deptActive, o.staffA],
      );
      await cSelf.query('COMMIT');

      // Linked employee without active department manager cannot force 'pending_l1', while 'pending_final' succeeds.
      await cSelf.query('BEGIN');
      await enterUser(cSelf, o.staffB, o.orgId);
      await expect(
        cSelf.query(
          `INSERT INTO ludy_hr.overtime_request (org_id, employee_id, department_id, month, work_date, hours, day_type, status)
           VALUES ($1, $2, NULL, '2026-10', '2026-10-14', 2, 'weekday', 'pending_l1')`,
          [o.orgId, empNoMgr],
        ),
      ).rejects.toThrow(/row-level security/i);
      await cSelf.query('ROLLBACK');

      await cSelf.query('BEGIN');
      await enterUser(cSelf, o.staffB, o.orgId);
      await cSelf.query(
        `INSERT INTO ludy_hr.overtime_request (org_id, employee_id, department_id, month, work_date, hours, day_type, status, created_by)
         VALUES ($1, $2, NULL, '2026-10', '2026-10-14', 2, 'weekday', 'pending_final', $3)`,
        [o.orgId, empNoMgr, o.staffB],
      );
      await cSelf.query('COMMIT');
    } finally {
      await cSelf.query('ROLLBACK').catch(() => {});
      cSelf.release();
    }

    // Adding a newer fixed-term employment term and syncing OT updates contractTermMonths along with employment_id.
    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-10', workingDays: '26' }, asMfa(o.owner));
    await o.exec(
      o.owner,
      'hr.payroll.employment.add',
      {
        employeeId: empNoMgr,
        effectiveFrom: '2026-10-01',
        contractType: 'fixed_term',
        termMonths: 12,
        region: 'I',
        baseWage: '19000000',
      },
      asMfa(o.owner),
    );
    const otTerm = await o.exec<HrSelfOvertimeSubmitResult>(o.staffB, 'hr.self.overtime.submit', {
      workDate: '2026-10-16',
      hours: '1.5',
      dayType: 'weekday',
    });
    const finTerm = await o.exec<HrOvertimeActionResult>(o.owner, 'hr.overtime.approve_final', {
      requestId: otTerm.requestId,
    });
    expect(finTerm).toMatchObject({ status: 'approved', payrollRunUpdated: true });

    const syncedSheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const updatedLine = syncedSheet.lines.find((l) => l.employeeId === empNoMgr && l.kind === 'pay');
    expect(updatedLine?.inputs.contractTermMonths).toBe(12);
    expect(updatedLine?.inputs.overtimeFromRequests).toBe(true);
    expect(otHoursOnLine(updatedLine)).toBe(1.5);
  });

  it('enforces onboarding bank+account pairing, 744h OT cap, >999.99h batch splitting, server-only overtimeFromRequests, and L1 department guard (#4448)', async () => {
    const o = await setupOrg();
    const { departmentId: deptA } = await o.exec<{ departmentId: string }>(
      o.owner,
      'hr.department.add',
      { name: 'Phòng Kiểm thử OT', code: 'OTQA', payFunction: 'admin' },
      asMfa(o.owner),
    );
    await o.exec(
      o.owner,
      'hr.department.set_manager',
      { departmentId: deptA, managerUserId: o.manager },
      asMfa(o.owner),
    );
    const empA = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Trần Ngân Hàng',
          departmentId: deptA,
          bankCode: 'VCB',
          accountNumber: '001100220033',
          employment: { effectiveFrom: '2026-08-01', contractType: 'indefinite', region: 'I', baseWage: '18000000' },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    const empB = (
      await o.exec<HrWritten>(
        o.owner,
        'hr.payroll.employee.add',
        {
          displayName: 'Lê Vượt Ngưỡng',
          employment: { effectiveFrom: '2026-08-01', contractType: 'indefinite', region: 'I', baseWage: '16000000' },
        },
        asMfa(o.owner),
      )
    ).employeeId as string;
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empA, userId: o.staffA }, asMfa(o.owner));
    await o.exec(o.owner, 'hr.payroll.employee.link_member', { employeeId: empB, userId: o.staffB }, asMfa(o.owner));

    // 1. Onboarding: bankCode without accountNumber is blocked 422 on submit and defensively on approve.
    await expect(
      o.exec(o.staffA, 'hr.self.onboarding.submit', {
        bankConfirmed: true,
        bankCode: 'TCB',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });

    const { rows: [badSub] } = await adminPool.query<{ id: string }>(
      `INSERT INTO ludy_hr.onboarding_submission (org_id, employee_id, status, bank_confirmed, bank_code, created_by)
       VALUES ($1, $2, 'pending', true, 'TCB', $3)
       RETURNING id`,
      [o.orgId, empA, o.staffA],
    );
    await expect(
      o.exec(o.owner, 'hr.onboarding.approve', { submissionId: badSub!.id }, asMfa(o.owner)),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    const empAfterBadApprove = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: empA });
    expect(empAfterBadApprove).toMatchObject({ bankCode: 'VCB', accountNumber: '001100220033' });

    // 2. Overtime physical monthly cap (744h) enforced on submit and final approve; L1 manager guard enforced atomically.
    const l1TestOt = await o.exec<HrSelfOvertimeSubmitResult>(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-10-02',
      hours: '5',
      dayType: 'weekday',
    });
    expect(l1TestOt.status).toBe('pending_l1');

    // Submit 30 * 24h (720h) + 19h (total 744h exact including 5h above), then 0.5h over 744h must fail 422.
    for (let day = 1; day <= 30; day += 1) {
      const dd = String(day).padStart(2, '0');
      await o.exec(o.staffA, 'hr.self.overtime.submit', {
        workDate: `2026-10-${dd}`,
        hours: '24',
        dayType: 'weekday',
      });
    }
    await o.exec(o.staffA, 'hr.self.overtime.submit', {
      workDate: '2026-10-31',
      hours: '19',
      dayType: 'weekday',
    });
    await expect(
      o.exec(o.staffA, 'hr.self.overtime.submit', {
        workDate: '2026-10-31',
        hours: '0.5',
        dayType: 'weekday',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });

    // Removing department manager blocks L1 approval (RLS + atomic guard prevent stale manager approval).
    await o.exec(o.owner, 'hr.department.set_manager', { departmentId: deptA, managerUserId: null }, asMfa(o.owner));
    await expect(
      o.exec(o.manager, 'hr.overtime.approve_l1', { requestId: l1TestOt.requestId }),
    ).rejects.toMatchObject({ code: 'HR_OVERTIME_NOT_FOUND', status: 404 });

    // Pending request for empB + 740h already-approved direct rows => final approval rejects past 744h.
    const empBPending = await o.exec<HrSelfOvertimeSubmitResult>(o.staffB, 'hr.self.overtime.submit', {
      workDate: '2026-10-05',
      hours: '5',
      dayType: 'weekday',
    });
    await adminPool.query(
      `INSERT INTO ludy_hr.overtime_request (org_id, employee_id, month, work_date, hours, day_type, status, created_by)
       SELECT $1::uuid, $2::uuid, '2026-10', '2026-10-01'::date + ((g - 1) % 28), 24, 'weekday', 'approved', $3::uuid
       FROM generate_series(1, 30) AS g
       UNION ALL
       SELECT $1::uuid, $2::uuid, '2026-10', '2026-10-29'::date, 20, 'weekday', 'approved', $3::uuid`,
      [o.orgId, empB, o.owner],
    );
    await expect(
      o.exec(o.owner, 'hr.overtime.approve_final', { requestId: empBPending.requestId }),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });

    // 3. Direct/legacy approved OT totaling > 999.99h (740 + 340 = 1080h for empB) splits into 999.99 + 80.01
    // without aborting batch run open, and empA (clean 5h approved) still receives payroll cleanly.
    await o.exec(o.owner, 'hr.overtime.approve_final', { requestId: l1TestOt.requestId });
    await adminPool.query(
      `UPDATE ludy_hr.overtime_request
          SET status = 'cancelled'
        WHERE org_id = $1 AND employee_id = $2 AND month = '2026-10' AND id <> $3`,
      [o.orgId, empA, l1TestOt.requestId],
    );
    await adminPool.query(
      `INSERT INTO ludy_hr.overtime_request (org_id, employee_id, month, work_date, hours, day_type, status, created_by)
       SELECT $1::uuid, $2::uuid, '2026-10', '2026-10-01'::date + ((g - 1) % 28), 24, 'weekday', 'approved', $3::uuid
       FROM generate_series(1, 14) AS g
       UNION ALL
       SELECT $1::uuid, $2::uuid, '2026-10', '2026-10-30'::date, 4, 'weekday', 'approved', $3::uuid`,
      [o.orgId, empB, o.owner],
    );

    const run = await o.exec<HrRunWritten>(o.owner, 'hr.payroll.run.open', { month: '2026-10', workingDays: '26' }, asMfa(o.owner));
    const sheet = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const lineA = sheet.lines.find((l) => l.employeeId === empA && l.kind === 'pay')!;
    const lineB = sheet.lines.find((l) => l.employeeId === empB && l.kind === 'pay')!;
    expect(lineA.inputs.overtime).toEqual([{ dayKind: 'normal_day', night: false, hours: '5' }]);
    expect(lineB.inputs.overtime).toEqual([
      { dayKind: 'normal_day', night: false, hours: '999.99' },
      { dayKind: 'normal_day', night: false, hours: '80.01' },
    ]);

    // 4. Client-supplied overtimeFromRequests: true on hr.payroll.line.inputs.set is ignored by the server.
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: lineA.id,
      inputs: { overtime: [{ dayKind: 'normal_day', night: false, hours: '1' }] },
    });
    await o.exec(o.owner, 'hr.payroll.line.inputs.set', {
      lineId: lineA.id,
      inputs: { bonus: '100000', overtimeFromRequests: true },
    });
    const afterClientAttempt = await o.query<HrRunSheet>(o.owner, 'hr.payroll.run.sheet', { runId: run.runId });
    const lineAAfter = afterClientAttempt.lines.find((l) => l.id === lineA.id)!;
    expect(lineAAfter.inputs.overtimeFromRequests).toBe(false);
    expect(lineAAfter.inputs.overtime).toEqual([{ dayKind: 'normal_day', night: false, hours: '1' }]);
  });
});

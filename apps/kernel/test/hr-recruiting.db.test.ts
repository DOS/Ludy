// SPDX-License-Identifier: AGPL-3.0-only
// Stage 3 slice 3b-2 (#3425, Part of #3403): lightweight recruiting openings, candidate pipeline,
// calendar interview scheduling, 1-click hire, PDPL erasure, offboarding, and Ly screening brief on real PostgreSQL 17.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, PayrollPromptLeakError } from '@crove/agent';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import {
  HR_ERASED_NAME,
  type HrCandidateEraseResult,
  type HrCandidateHireResult,
  type HrCandidateInterviewScheduled,
  type HrCandidateView,
  type HrCandidateWritten,
  type HrDepartmentWritten,
  type HrEmployee,
  type HrInterviewSlotsResult,
  type HrOpeningView,
  type HrOpeningWritten,
  type HrRecruitingBriefResult,
} from '@crove/kernel-contract';
import { CredentialVault, DomainError, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, type BlobStore } from '@crove/kernel-runtime';
import { hrCommands, hrQueries } from '@crove/mod-hr';
import type { AuthUser } from '../src/auth.ts';
import { ConcurrencyLimiter } from '../src/concurrency.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import type { ConversationReader } from '../src/conversations-ai.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const MEMORY_STORE: BlobStore = {
  put: async () => undefined,
  get: async () => null,
  delete: async () => undefined,
  exists: async () => false,
  getBytes: async () => null,
  list: async () => [],
} as unknown as BlobStore;

suite('HR lightweight recruiting, calendar interview, 1-click hire, and Ly brief (#3425)', () => {
  const dbName = `crove_test_hrrec_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
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
    const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'hrrec', subject: `${name}-${tag}`, email: `${name}-${tag}@hr.test`, name: null });
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId, slug } = await createOrg(rt, asUser(owner), `HR Recruiting ${tag}`);
    await withAdmin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')`, [
        orgId,
        admin,
        member,
        viewer,
      ]),
    );
    const exec = <O>(userId: string, name: string, input: unknown = {}, actor: ReturnType<typeof asUser> | ReturnType<typeof asMfa> = asUser(userId)) =>
      rt.execute<O>(name, input, { actor, orgId });
    const query = <O>(userId: string, name: string, input: unknown = {}) => rt.query<O>(name, input, { actor: asUser(userId), orgId });
    return { orgId, slug, owner, admin, member, viewer, exec, query };
  }

  function makeHttp(
    o: Awaited<ReturnType<typeof org>>,
    elsewhere?: Awaited<ReturnType<typeof org>>,
    conversationReader?: ConversationReader,
  ) {
    const nowS = Math.floor(Date.now() / 1000);
    const users = new Map<string, AuthUser>([
      ...[o.owner, o.admin, o.member, o.viewer].map(
        (id) => [id, { userId: id, email: '', name: null, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: nowS }] as const,
      ),
      ...(elsewhere ? [['other-owner', { userId: elsewhere.owner, email: '', name: null, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: nowS }] as const] : []),
    ]);
    const app = createHttpApp({
      exports: new ConcurrencyLimiter({ total: 2, perKey: 2 }),
      config: loadConfig({
        DATABASE_URL: appUrl,
        AUTH_JWT_SECRET: 'test-only-jwt-secret-for-recruiting-3425',
        AUTH_ISSUER: 'test-auth',
        WEB_DIST: '/nonexistent',
        EXPORT_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      }),
      runtime: rt,
      store: MEMORY_STORE,
      authenticate: async (header) => {
        const token = String(header ?? '').replace('Bearer ', '');
        const user = users.get(token);
        if (!user) throw new DomainError('UNAUTHENTICATED', 401, 'unauthenticated');
        return user;
      },
      pool,
      aiEnabled: conversationReader !== undefined,
      ...(conversationReader ? { conversationReader } : {}),
    });
    const postBrief = async (token: string, input: unknown, slug = o.slug) => {
      const res = await app.request('/api/rpc/hr/recruiting/brief', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-crove-org': slug },
        body: JSON.stringify({ json: input }),
      });
      const raw = (await res.json().catch(() => null)) as ({ json?: HrRecruitingBriefResult } & Record<string, unknown>) | null;
      return { status: res.status, body: (raw && 'json' in raw ? raw.json : raw) as HrRecruitingBriefResult & Record<string, unknown> };
    };
    return { app, postBrief };
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
    const appConn = new URL(adminUrl);
    appConn.username = 'crove_app';
    appConn.password = 'test-app-pw';
    appUrl = appConn.toString();
    pool = createPool({ connectionString: appUrl, max: 6 });
    rt = new Runtime(createDb(pool), {
      manifests: TEST_MANIFESTS,
      subjectVault,
      readAuditKey: randomBytes(32),
      stepUp: 'required',
    }).register({
      commands: [...kernelCommands, ...hrCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (ADMIN) {
      const rootDb = new pg.Client({ connectionString: ADMIN });
      await rootDb.connect();
      await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await rootDb.end();
    }
  });

  it('manages openings, candidate transitions, calendar interview slots, double-booking conflicts, and 1-click hire atomically', async () => {
    const o = await org();

    // Optional department created cleanly; opening inherits payFunction & departmentName when linked.
    const dept = await o.exec<HrDepartmentWritten>(o.owner, 'hr.department.add', {
      name: 'Phòng Kế toán',
      code: 'FIN',
      payFunction: 'admin',
    });

    await expect(
      o.exec(o.owner, 'hr.recruiting.opening.add', {
        title: 'Kế toán trưởng',
        budgetMinWage: '25000000',
        budgetMaxWage: '20000000',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });

    const opening = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      departmentId: dept.departmentId,
      title: 'Kế toán tổng hợp',
      contractType: 'fixed_term',
      region: 'II',
      budgetMinWage: '15000000',
      budgetMaxWage: '22000000',
      requiredSkills: ['MISA', 'Excel', 'Thuế GTGT'],
    });
    expect(opening.status).toBe('open');

    const openings = await o.query<HrOpeningView[]>(o.admin, 'hr.recruiting.opening.list', { status: 'open' });
    expect(openings).toHaveLength(1);
    expect(openings[0]).toMatchObject({
      id: opening.openingId,
      departmentId: dept.departmentId,
      departmentName: 'Phòng Kế toán',
      payFunction: 'admin',
      region: 'II',
      contractType: 'fixed_term',
    });

    const candidate = await o.exec<HrCandidateWritten>(o.admin, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Nguyễn Minh Thư',
      email: 'thu@example.com',
      phone: '0909123456',
      yearsExperience: 4,
      matchedSkills: ['MISA', 'Excel'],
      expectedWage: '18000000',
      notes: 'Đã phụ trách báo cáo tài chính công ty 30 người.',
    });
    expect(candidate.stage).toBe('applied');

    // Direct 1-click hire from 'applied' without agreedWage/plannedStartOn or explicit allowDirectHire fails deterministically.
    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.hire', { candidateId: candidate.candidateId }),
    ).rejects.toMatchObject({ code: 'HR_RECRUITING_TRANSITION_REFUSED', status: 422 });

    await o.exec(o.admin, 'hr.recruiting.candidate.move_stage', { candidateId: candidate.candidateId, toStage: 'screening' });

    // Fetch open interview slots on interviewer's calendar.
    const fromIso = new Date(Date.now() + 86_400_000).toISOString();
    const toIso = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const slotsRes = await o.query<HrInterviewSlotsResult>(o.admin, 'hr.recruiting.interview_slots', {
      from: fromIso,
      to: toIso,
      durationMinutes: 45,
      maxSlots: 5,
    });
    expect(slotsRes.slots.length).toBeGreaterThan(0);
    const chosenSlot = slotsRes.slots[0]!;

    // Book interview slot on calendar -> inserts manual calendar event WITHOUT candidate PII in title, advances stage to 'interview'.
    const scheduled = await o.exec<HrCandidateInterviewScheduled>(o.admin, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: candidate.candidateId,
      startsAt: chosenSlot.startIso,
      endsAt: chosenSlot.endIso,
    });
    expect(scheduled.stage).toBe('interview');

    const calendarRow = await withAdmin(async (c) =>
      (
        await c.query<{ title: string | null; kind: string; status: string }>(
          `SELECT title, kind, status FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2`,
          [o.orgId, scheduled.eventId],
        )
      ).rows[0],
    );
    expect(calendarRow).toMatchObject({ kind: 'manual', status: 'active', title: 'Phỏng vấn: Kế toán tổng hợp' });
    expect(calendarRow?.title).not.toContain('Nguyễn Minh Thư');
    expect(calendarRow?.title).not.toContain('thu@example.com');
    expect(calendarRow?.title).not.toContain('0909123456');

    // Second candidate attempting the exact same interviewer & time slot fails 409 double booking.
    const competitor = await o.exec<HrCandidateWritten>(o.admin, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Trần Văn Hùng',
    });
    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.schedule_interview', {
        candidateId: competitor.candidateId,
        startsAt: chosenSlot.startIso,
        endsAt: chosenSlot.endIso,
      }),
    ).rejects.toMatchObject({ code: 'HR_INTERVIEW_SLOT_TAKEN', status: 409 });

    // Rescheduling first candidate to slot #2 cancels old calendar event and keeps slot #1 clean.
    const slot2 = slotsRes.slots[1]!;
    const rescheduled = await o.exec<HrCandidateInterviewScheduled>(o.admin, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: candidate.candidateId,
      startsAt: slot2.startIso,
      endsAt: slot2.endIso,
    });
    const oldStatus = await withAdmin(async (c) =>
      (await c.query<{ status: string }>(`SELECT status FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2`, [o.orgId, scheduled.eventId])).rows[0]?.status,
    );
    expect(oldStatus).toBe('cancelled');
    expect(rescheduled.eventId).not.toBe(scheduled.eventId);

    // Move to offer with agreed wage & start date, then verify fixed_term requires termMonths or contractEndOn before inserting employee.
    await o.exec(o.admin, 'hr.recruiting.candidate.move_stage', {
      candidateId: candidate.candidateId,
      toStage: 'offer',
      agreedWage: '19500000',
      plannedStartOn: '2026-12-01',
    });

    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.hire', {
        candidateId: candidate.candidateId,
      }),
    ).rejects.toMatchObject({ code: 'HR_CONTRACT_INVALID', status: 422 });
    const empCountBeforeTerm = await withAdmin(async (c) =>
      Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM crove_hr.payroll_employee WHERE org_id = $1`, [o.orgId])).rows[0]?.n ?? 0),
    );
    expect(empCountBeforeTerm).toBe(0);

    const hired = await o.exec<HrCandidateHireResult>(o.admin, 'hr.recruiting.candidate.hire', {
      candidateId: candidate.candidateId,
      termMonths: 12,
    });
    expect(hired.stage).toBe('hired');

    const employee = await o.query<HrEmployee>(o.owner, 'hr.payroll.employee.get', { employeeId: hired.employeeId });
    expect(employee).toMatchObject({
      id: hired.employeeId,
      displayName: 'Nguyễn Minh Thư',
      departmentId: dept.departmentId,
      jobTitle: 'Kế toán tổng hợp',
      employments: [
        expect.objectContaining({
          effectiveFrom: '2026-12-01',
          contractType: 'fixed_term',
          termMonths: 12,
          contractEndOn: '2027-11-30',
          region: 'II',
          payFunction: 'admin',
          baseWage: '19500000.00',
        }),
      ],
    });

    // Cancelled linked calendar event does NOT count as hasScheduledInterview in views, Ly brief, move_stage, or hire.
    const compInterview = await o.exec<HrCandidateInterviewScheduled>(o.admin, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: competitor.candidateId,
      startsAt: chosenSlot.startIso,
      endsAt: chosenSlot.endIso,
    });
    await o.exec(o.admin, 'kernel.calendar.event.cancel', { eventId: compInterview.eventId });
    const compAfterCancel = await o.query<HrCandidateView>(o.admin, 'hr.recruiting.candidate.get', { candidateId: competitor.candidateId });
    expect(compAfterCancel.interviewEventId).toBeNull();
    expect(compAfterCancel.interviewStartsAt).toBeNull();
    const compBriefRead = await o.query<{ input: { hasScheduledInterview: boolean } }>(o.admin, 'hr.recruiting.brief.read', {
      candidateId: competitor.candidateId,
      lang: 'vi',
    });
    expect(compBriefRead.input.hasScheduledInterview).toBe(false);
    await o.exec(o.admin, 'hr.recruiting.candidate.move_stage', {
      candidateId: competitor.candidateId,
      toStage: 'offer',
      agreedWage: '16000000',
      plannedStartOn: '2026-12-01',
    });
    const compMoveDetail = await withAdmin(async (c) =>
      (
        await c.query<{ detail: { warnings?: string[] } }>(
          `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'hr.recruiting.candidate.move_stage' AND target_id = $2 ORDER BY id DESC LIMIT 1`,
          [o.orgId, competitor.candidateId],
        )
      ).rows[0]?.detail,
    );
    expect(compMoveDetail?.warnings).toContain('missing_interview_before_offer');

    // Cannot hire the same candidate twice or transition away from terminal 'hired' stage.
    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.hire', { candidateId: candidate.candidateId }),
    ).rejects.toMatchObject({ code: 'HR_CANDIDATE_ALREADY_HIRED', status: 409 });
    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.move_stage', { candidateId: candidate.candidateId, toStage: 'rejected' }),
    ).rejects.toMatchObject({ code: 'HR_RECRUITING_TRANSITION_REFUSED', status: 422 });

    // Close and reopen opening checks.
    const closed = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.close', { openingId: opening.openingId });
    expect(closed.status).toBe('closed');
    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.add', { openingId: opening.openingId, displayName: 'Ứng viên muộn' }),
    ).rejects.toMatchObject({ code: 'HR_OPENING_CLOSED', status: 409 });
    const reopened = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.close', { openingId: opening.openingId, reopen: true });
    expect(reopened.status).toBe('open');
  });

  it('enforces RBAC, RLS isolation, R3 candidate erase, and kernel personal-data redaction', async () => {
    const o = await org();
    const other = await org();

    const opening = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      title: 'Nhân viên kinh doanh',
    });
    const cand = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Phạm Hoàng Long',
      email: 'long@example.com',
      phone: '0912345678',
      notes: 'Từng gọi từ số 0912345678, mức đề xuất 123456.',
    });

    // Non-managers and other org callers cannot read or write recruiting tables.
    await expect(o.query(o.member, 'hr.recruiting.opening.list', {})).rejects.toMatchObject({ status: 403 });
    await expect(o.query(o.viewer, 'hr.recruiting.candidate.get', { candidateId: cand.candidateId })).rejects.toMatchObject({ status: 403 });
    await expect(other.query(other.owner, 'hr.recruiting.candidate.get', { candidateId: cand.candidateId })).rejects.toMatchObject({ status: 404 });

    // Reject before erasing; cannot erase while still in active pipeline or without fresh MFA / owner role.
    await expect(o.exec(o.owner, 'hr.recruiting.candidate.erase', { candidateId: cand.candidateId }, asMfa(o.owner))).rejects.toMatchObject({
      code: 'HR_CANDIDATE_STILL_IN_PIPELINE',
      status: 409,
    });
    await o.exec(o.owner, 'hr.recruiting.candidate.move_stage', { candidateId: cand.candidateId, toStage: 'rejected' });
    await expect(o.exec(o.admin, 'hr.recruiting.candidate.erase', { candidateId: cand.candidateId }, asMfa(o.admin))).rejects.toMatchObject({ status: 403 });
    await expect(o.exec(o.owner, 'hr.recruiting.candidate.erase', { candidateId: cand.candidateId }, asUser(o.owner))).rejects.toMatchObject({
      code: 'STEP_UP_REQUIRED',
      status: 403,
    });

    const erased = await o.exec<HrCandidateEraseResult>(o.owner, 'hr.recruiting.candidate.erase', { candidateId: cand.candidateId }, asMfa(o.owner));
    expect(erased.candidateId).toBe(cand.candidateId);
    const afterErase = await o.query<HrCandidateView>(o.owner, 'hr.recruiting.candidate.get', { candidateId: cand.candidateId });
    expect(afterErase.displayName).toBe(HR_ERASED_NAME);
    expect(afterErase.email).toBeNull();
    expect(afterErase.phone).toBeNull();
    expect(afterErase.notes).toBeNull();
    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.edit', { candidateId: cand.candidateId, notes: 'Sửa lại' }),
    ).rejects.toMatchObject({ code: 'HR_CANDIDATE_ERASED', status: 409 });

    // Second candidate erased via kernel personalData.erase (email match & free_text redaction in notes).
    const second = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Lê Thanh Hoa',
      email: 'hoa@example.com',
      phone: '0987654321',
    });
    const bystander = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Người giới thiệu',
      notes: 'Ứng viên được giới thiệu bởi 0987654321 trong tháng này.',
    });

    const found = await o.exec<{ matches: Array<{ column: string; rows: number }> }>(o.owner, 'kernel.personal_data.find', {
      value: '0987654321',
    });
    expect(found.matches.some((m) => m.column === 'crove_hr.candidate.phone')).toBe(true);
    expect(found.matches.some((m) => m.column === 'crove_hr.candidate.notes')).toBe(true);

    await o.exec(o.owner, 'kernel.personal_data.erase', { value: '0987654321' }, asMfa(o.owner));
    const secondAfter = await o.query<HrCandidateView>(o.owner, 'hr.recruiting.candidate.get', { candidateId: second.candidateId });
    expect(secondAfter.displayName).toBe(HR_ERASED_NAME);
    expect(secondAfter.phone).toBeNull();
    const bystanderAfter = await o.query<HrCandidateView>(o.owner, 'hr.recruiting.candidate.get', { candidateId: bystander.candidateId });
    expect(bystanderAfter.notes).not.toContain('0987654321');
    expect(bystanderAfter.notes).toContain('[đã xóa]');
  });

  it('serves pseudonymized Ly screening brief to owners/admins cleanly, enforces 403 for non-admins even with AI off, and keeps PII out of prompts and audits', async () => {
    const o = await org();
    const other = await org();
    const opening = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      title: 'Chuyên viên Nhân sự',
      departmentName: 'Hành chính Nhân sự',
      budgetMinWage: '14000000',
      budgetMaxWage: '18000000',
      requiredSkills: ['BHXH', 'Chấm công', 'Hợp đồng lao động'],
    });
    const cand = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Đỗ Ngọc Lan',
      email: 'lan.do@example.com',
      phone: '0901234567',
      yearsExperience: 3,
      matchedSkills: ['BHXH', 'Chấm công'],
      expectedWage: '16000000',
      notes: 'Liên hệ lại Đỗ Ngọc Lan qua lan.do@example.com hoặc 0901234567; có kinh nghiệm tính lương.',
    });

    // 1. AI OFF: member/viewer MUST receive 403 FORBIDDEN (never 200 { ai: { ok: false, reason: 'off' } }); owner/admin gets deterministic readiness.
    const { postBrief: postOff } = makeHttp(o, other);
    expect((await postOff(o.member, { candidateId: cand.candidateId, lang: 'vi' })).status).toBe(403);
    expect((await postOff(o.viewer, { candidateId: cand.candidateId, lang: 'vi' })).status).toBe(403);
    expect((await postOff('other-owner', { candidateId: cand.candidateId, lang: 'vi' })).status).toBe(403);
    expect((await postOff('other-owner', { candidateId: cand.candidateId, lang: 'vi' }, other.slug)).status).toBe(404);

    const offOwner = await postOff(o.owner, { candidateId: cand.candidateId, lang: 'vi' });
    expect(offOwner.status).toBe(200);
    expect(offOwner.body.ai).toEqual({ ok: false, reason: 'off' });
    expect(offOwner.body.readiness).toMatchObject({
      wageComparison: 'within_budget',
      skillsMatchedCount: 2,
      skillsRequiredCount: 3,
      missingSkillsCount: 1,
    });
    expect(offOwner.body.interviewQuestions.length).toBeGreaterThan(0);

    // 2. AI ON: verify forbidden candidate PII list is passed to InboxReader.recruitingBrief and no PII reaches audit_event.
    const recruitingBriefSpy = vi.fn(async (input: { openingTitle: string; notes?: readonly string[] }, opts?: { forbidden?: readonly string[] }) => {
      expect(input.openingTitle).toBe('Chuyên viên Nhân sự');
      expect(opts?.forbidden).toEqual(expect.arrayContaining(['Đỗ Ngọc Lan', 'lan.do@example.com', '0901234567']));
      return {
        readiness: offOwner.body.readiness,
        summary: 'Ứng viên C1 phù hợp 2/3 kỹ năng và mức lương kỳ vọng trong khung dự kiến.',
        strengths: ['Kinh nghiệm 3 năm về BHXH và chấm công.'],
        risks: ['Cần kiểm tra thêm kỹ năng soạn hợp đồng lao động.'],
        interviewQuestions: ['Bạn đã xử lý quy trình tăng giảm BHXH gần nhất như thế nào?', 'Kinh nghiệm lập hợp đồng thử việc theo quy định mới?', 'Bạn dự kiến khi nào có thể bắt đầu?'],
        ai: { ok: true as const, reason: 'ok' as const },
      };
    });
    const { postBrief: postOn } = makeHttp(o, other, {
      intents: vi.fn(),
      rank: vi.fn(),
      rankCompanies: vi.fn(),
      recruitingBrief: recruitingBriefSpy,
    });
    const aiOk = await postOn(o.admin, { candidateId: cand.candidateId, lang: 'vi' });
    expect(aiOk.status).toBe(200);
    expect(aiOk.body.ai).toEqual({ ok: true, reason: 'ok' });
    expect(recruitingBriefSpy).toHaveBeenCalledTimes(1);

    // Audit rows for brief read and brief audit contain zero candidate PII.
    const auditRows = await withAdmin(async (c) =>
      (
        await c.query<{ command: string; row: string }>(
          `SELECT command, audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'hr.recruiting.%' ORDER BY id`,
          [o.orgId],
        )
      ).rows,
    );
    expect(auditRows.some((r) => r.command === 'hr.recruiting.brief.read')).toBe(true);
    expect(auditRows.some((r) => r.command === 'hr.recruiting.brief.audit')).toBe(true);
    // Sensitive candidate reads leave before_read audit rows with zero PII.
    await o.query<HrCandidateView>(o.admin, 'hr.recruiting.candidate.get', { candidateId: cand.candidateId });
    const afterCandidateRead = await withAdmin(async (c) =>
      (
        await c.query<{ command: string; row: string }>(
          `SELECT command, audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'hr.recruiting.candidate.get'`,
          [o.orgId],
        )
      ).rows,
    );
    expect(afterCandidateRead.length).toBeGreaterThanOrEqual(1);
    for (const r of [...auditRows, ...afterCandidateRead]) {
      expect(r.row).not.toContain('Đỗ Ngọc Lan');
      expect(r.row).not.toContain('lan.do@example.com');
      expect(r.row).not.toContain('0901234567');
    }

    // 3. Budget exhaustion & prompt leak refusal degrade gracefully to deterministic result.
    const { postBrief: postBudget } = makeHttp(o, other, {
      intents: vi.fn(),
      rank: vi.fn(),
      rankCompanies: vi.fn(),
      recruitingBrief: vi.fn(async () => {
        throw new AiBudgetExhaustedError('org', new Date().toISOString());
      }),
    });
    const budgetRes = await postBudget(o.owner, { candidateId: cand.candidateId, lang: 'vi' });
    expect(budgetRes.status).toBe(200);
    expect(budgetRes.body.ai).toEqual({ ok: false, reason: 'budget' });

    const { postBrief: postLeak } = makeHttp(o, other, {
      intents: vi.fn(),
      rank: vi.fn(),
      rankCompanies: vi.fn(),
      recruitingBrief: vi.fn(async () => {
        throw new PayrollPromptLeakError();
      }),
    });
    const leakRes = await postLeak(o.owner, { candidateId: cand.candidateId, lang: 'vi' });
    expect(leakRes.status).toBe(200);
    expect(leakRes.body.ai).toEqual({ ok: false, reason: 'refused' });
  });
});

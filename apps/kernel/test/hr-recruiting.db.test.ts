// SPDX-License-Identifier: AGPL-3.0-only
// Stage 3 slice 3b-2 (#3425, Part of #3403): lightweight recruiting openings, candidate pipeline,
// calendar interview scheduling, 1-click hire, PDPL erasure, offboarding, and Ly screening brief on real PostgreSQL 17.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiBudgetExhaustedError, PayrollPromptLeakError } from '@ludy/agent';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { acquireAdvisoryXactLock, advisoryLockKey, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  HR_ERASED_NAME,
  type HrCandidateEraseResult,
  type HrCandidateHireResult,
  type HrCandidateInterviewCancelled,
  type HrCandidateInterviewScheduled,
  type HrCandidateView,
  type HrCandidateWritten,
  type HrDepartmentWritten,
  type HrEmployee,
  type HrInterviewerOption,
  type HrInterviewSlotsResult,
  type HrOpeningView,
  type HrOpeningWritten,
  type HrRecruitingBriefResult,
} from '@ludy/kernel-contract';
import { CredentialVault, DomainError, Runtime, SUBJECT_WRAP_INFO, SubjectVault, parseVaultKey, type BlobStore } from '@ludy/kernel-runtime';
import { hrCommands, hrQueries } from '@ludy/mod-hr';
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

  async function org(names?: Partial<Record<'owner' | 'admin' | 'member' | 'viewer', string | null>>) {
    const tag = randomUUID().slice(0, 8);
    const person = (roleName: 'owner' | 'admin' | 'member' | 'viewer') =>
      upsertIdentity(createDb(pool), {
        issuer: 'hrrec',
        subject: `${roleName}-${tag}`,
        email: `${roleName}-${tag}@hr.test`,
        name: names?.[roleName] ?? null,
      });
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
    expect(compAfterCancel.interviewerUserId).toBeNull();
    expect(compAfterCancel.interviewerName).toBeNull();
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

    // 2. AI ON: verify notes are excluded by default (`includeNotes` omitted/false), included only when `includeNotes: true`,
    // forbidden candidate PII list is passed to InboxReader.recruitingBrief, and `include_notes` reaches audit_event without PII.
    const seenNotesByCall: Array<readonly string[]> = [];
    const recruitingBriefSpy = vi.fn(async (input: { openingTitle: string; notes?: readonly string[] }, opts?: { forbidden?: readonly string[] }) => {
      expect(input.openingTitle).toBe('Chuyên viên Nhân sự');
      expect(opts?.forbidden).toEqual(expect.arrayContaining(['Đỗ Ngọc Lan', 'lan.do@example.com', '0901234567']));
      seenNotesByCall.push([...(input.notes ?? [])]);
      return {
        readiness: { ...offOwner.body.readiness, hasNotes: (input.notes ?? []).length > 0 },
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
    expect(aiOk.body.readiness.hasNotes).toBe(false);
    expect(seenNotesByCall[0]).toEqual([]);

    const aiWithNotes = await postOn(o.admin, { candidateId: cand.candidateId, lang: 'vi', includeNotes: true });
    expect(aiWithNotes.status).toBe(200);
    expect(aiWithNotes.body.ai).toEqual({ ok: true, reason: 'ok' });
    expect(aiWithNotes.body.readiness.hasNotes).toBe(true);
    expect(seenNotesByCall[1]).toEqual(['Liên hệ lại Đỗ Ngọc Lan qua lan.do@example.com hoặc 0901234567; có kinh nghiệm tính lương.']);
    expect(recruitingBriefSpy).toHaveBeenCalledTimes(2);

    // Per-minute DraftBudget rate-limit exhaustion (12 calls/min per user on `suggestionBudget`): calls 3..12 run AI, call 13 returns 200 deterministic fallback (`rate_limited`), never 429.
    for (let i = 0; i < 10; i++) {
      const withinLimit = await postOn(o.admin, { candidateId: cand.candidateId, lang: 'vi' });
      expect(withinLimit.status).toBe(200);
      expect(withinLimit.body.ai).toEqual({ ok: true, reason: 'ok' });
    }
    expect(recruitingBriefSpy).toHaveBeenCalledTimes(12);

    const rateLimitedRes = await postOn(o.admin, { candidateId: cand.candidateId, lang: 'vi' });
    expect(rateLimitedRes.status).toBe(200);
    expect(rateLimitedRes.body.ai).toEqual({ ok: false, reason: 'rate_limited' });
    expect(rateLimitedRes.body.readiness.skillsMatchedCount).toBe(2);
    expect(recruitingBriefSpy).toHaveBeenCalledTimes(12);

    // Audit rows for brief read and brief audit record include_notes & rate_limited and contain zero candidate PII.
    const auditRows = await withAdmin(async (c) =>
      (
        await c.query<{ command: string; detail: Record<string, unknown>; row: string }>(
          `SELECT command, detail, audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'hr.recruiting.%' ORDER BY id`,
          [o.orgId],
        )
      ).rows,
    );
    expect(auditRows.some((r) => r.command === 'hr.recruiting.brief.read' && r.detail?.include_notes === 'false')).toBe(true);
    expect(auditRows.some((r) => r.command === 'hr.recruiting.brief.read' && r.detail?.include_notes === 'true')).toBe(true);
    expect(auditRows.some((r) => r.command === 'hr.recruiting.brief.audit' && r.detail?.include_notes === false && r.detail?.aiReason === 'ok')).toBe(true);
    expect(auditRows.some((r) => r.command === 'hr.recruiting.brief.audit' && r.detail?.include_notes === true && r.detail?.aiReason === 'ok')).toBe(true);
    expect(auditRows.some((r) => r.command === 'hr.recruiting.brief.audit' && r.detail?.aiReason === 'rate_limited')).toBe(true);
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

  it('paginates >200 candidates deterministically without duplicates or gaps even across microsecond/same-timestamp ties (#3447 Item 1)', async () => {
    const o = await org();
    const opening = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      title: 'Nhân viên Chăm sóc Khách hàng',
    });

    // Seed 205 candidates cleanly via SQL under admin connection (including microsecond & identical-timestamp clusters)
    // so the test completes in milliseconds while stressing keyset cursor tie-breaking on `(updated_at, id)`.
    const insertedIds = await withAdmin(async (c) => {
      const entityRow = await c.query<{ legal_entity_id: string }>(
        `SELECT legal_entity_id FROM crove_hr.job_opening WHERE org_id = $1 AND id = $2`,
        [o.orgId, opening.openingId],
      );
      const legalEntityId = entityRow.rows[0]!.legal_entity_id;
      const res = await c.query<{ id: string }>(
        `INSERT INTO crove_hr.candidate (
           org_id, legal_entity_id, opening_id, display_name, stage, created_by, created_at, updated_at
         )
         SELECT
           $1::uuid,
           $2::uuid,
           $3::uuid,
           'Ứng viên #' || g::text,
           'applied',
           $4::uuid,
           '2026-11-17T08:00:00.000000Z'::timestamptz + ((g / 5) * interval '1 millisecond') + ((g % 5) * interval '200 microseconds'),
           '2026-11-17T08:00:00.000000Z'::timestamptz + ((g / 5) * interval '1 millisecond') + ((g % 3) * interval '250 microseconds')
         FROM pg_catalog.generate_series(1, 205) AS g
         RETURNING id`,
        [o.orgId, legalEntityId, opening.openingId, o.owner],
      );
      return res.rows.map((r) => r.id);
    });
    expect(insertedIds).toHaveLength(205);

    // Default limit is 200: page 1 returns 200, page 2 via cursor returns remaining 5, page 3 via cursor returns [].
    const defaultPage1 = await o.query<HrCandidateView[]>(o.owner, 'hr.recruiting.candidate.list', {
      openingId: opening.openingId,
    });
    expect(defaultPage1).toHaveLength(200);
    const defaultPage2 = await o.query<HrCandidateView[]>(o.owner, 'hr.recruiting.candidate.list', {
      openingId: opening.openingId,
      cursor: defaultPage1.at(-1)!.id,
    });
    expect(defaultPage2).toHaveLength(5);
    const defaultPage3 = await o.query<HrCandidateView[]>(o.owner, 'hr.recruiting.candidate.list', {
      openingId: opening.openingId,
      cursor: defaultPage2.at(-1)!.id,
    });
    expect(defaultPage3).toEqual([]);

    const allDefaultIds = [...defaultPage1, ...defaultPage2].map((r) => r.id);
    expect(new Set(allDefaultIds).size).toBe(205);
    expect(new Set(allDefaultIds)).toEqual(new Set(insertedIds));

    // Also walk in smaller 50-row pages and verify identical deterministic ordering with zero duplicates or gaps.
    const pagedIds: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await o.query<HrCandidateView[]>(o.admin, 'hr.recruiting.candidate.list', {
        openingId: opening.openingId,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      pagedIds.push(...page.map((r) => r.id));
      if (page.length < 50) break;
      cursor = page.at(-1)!.id;
    }
    expect(pagedIds).toEqual(allDefaultIds);

    // Unknown or cross-org cursor returns [] without leaking anything.
    const other = await org();
    const otherCand = await other.exec<HrCandidateWritten>(other.owner, 'hr.recruiting.candidate.add', { displayName: 'Ứng viên công ty khác' });
    const crossCursorPage = await o.query<HrCandidateView[]>(o.owner, 'hr.recruiting.candidate.list', {
      openingId: opening.openingId,
      cursor: otherCand.candidateId,
    });
    expect(crossCursorPage).toEqual([]);
  });

  it('auto-cancels active calendar interviews on reject and erase, allows cross-manager reschedule/reject, and serializes advisory locks (#3447 Items 3, 4, 5)', async () => {
    const o = await org();
    const opening = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      title: 'Kỹ sư Phần mềm',
      contractType: 'indefinite',
      region: 'I',
    });

    const fromIso = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const toIso = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const ownerSlots = await o.query<HrInterviewSlotsResult>(o.owner, 'hr.recruiting.interview_slots', {
      from: fromIso,
      to: toIso,
      durationMinutes: 45,
      maxSlots: 6,
    });
    expect(ownerSlots.slots.length).toBeGreaterThanOrEqual(4);

    // Case A (Item 5): Owner schedules candidate #1's interview, then Admin reschedules onto Admin's calendar and later rejects.
    const cand1 = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Trần Quốc Bảo',
    });
    const ownerBooked1 = await o.exec<HrCandidateInterviewScheduled>(o.owner, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: cand1.candidateId,
      startsAt: ownerSlots.slots[0]!.startIso,
      endsAt: ownerSlots.slots[0]!.endIso,
    });

    // Personal calendar.event.cancel by Admin on Owner's personal event is 404 (not Admin's own calendar),
    // whereas recruiting schedule_interview by Admin cleanly cancels Owner's linked recruiting invite and rebooks on Admin's calendar.
    await expect(o.exec(o.admin, 'kernel.calendar.event.cancel', { eventId: ownerBooked1.eventId })).rejects.toMatchObject({ status: 404 });

    const adminRescheduled1 = await o.exec<HrCandidateInterviewScheduled>(o.admin, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: cand1.candidateId,
      startsAt: ownerSlots.slots[1]!.startIso,
      endsAt: ownerSlots.slots[1]!.endIso,
    });
    expect(adminRescheduled1.eventId).not.toBe(ownerBooked1.eventId);

    const oldOwnerEvent = await withAdmin(async (c) =>
      (
        await c.query<{ status: string; cancelled_by: string | null }>(
          `SELECT status, cancelled_by FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2`,
          [o.orgId, ownerBooked1.eventId],
        )
      ).rows[0],
    );
    expect(oldOwnerEvent).toEqual({ status: 'cancelled', cancelled_by: o.admin });

    // Case B (Item 3 & Item 5): Owner schedules candidate #2's interview, then Admin moves candidate #2 to 'rejected' -> Owner's invite auto-cancels!
    const cand2 = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Lê Minh Khôi',
    });
    const ownerBooked2 = await o.exec<HrCandidateInterviewScheduled>(o.owner, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: cand2.candidateId,
      startsAt: ownerSlots.slots[2]!.startIso,
      endsAt: ownerSlots.slots[2]!.endIso,
    });

    await o.exec(o.admin, 'hr.recruiting.candidate.move_stage', {
      candidateId: cand2.candidateId,
      toStage: 'rejected',
    });

    const rejectedEvent = await withAdmin(async (c) =>
      (
        await c.query<{ status: string; cancelled_by: string | null }>(
          `SELECT status, cancelled_by FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2`,
          [o.orgId, ownerBooked2.eventId],
        )
      ).rows[0],
    );
    expect(rejectedEvent).toEqual({ status: 'cancelled', cancelled_by: o.admin });

    const cand2AfterReject = await o.query<HrCandidateView>(o.owner, 'hr.recruiting.candidate.get', { candidateId: cand2.candidateId });
    expect(cand2AfterReject.stage).toBe('rejected');
    expect(cand2AfterReject.interviewEventId).toBeNull();
    expect(cand2AfterReject.interviewStartsAt).toBeNull();
    expect(cand2AfterReject.interviewEndsAt).toBeNull();
    expect(cand2AfterReject.interviewerUserId).toBeNull();
    expect(cand2AfterReject.interviewerName).toBeNull();

    // Case C (Item 3): Candidate #3 has an active future interview, is direct-hired, and then erased -> active calendar event auto-cancels on erase!
    const cand3 = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Vũ Thị Mai',
    });
    const ownerBooked3 = await o.exec<HrCandidateInterviewScheduled>(o.owner, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: cand3.candidateId,
      startsAt: ownerSlots.slots[3]!.startIso,
      endsAt: ownerSlots.slots[3]!.endIso,
    });
    await o.exec<HrCandidateHireResult>(o.owner, 'hr.recruiting.candidate.hire', {
      candidateId: cand3.candidateId,
      effectiveFrom: '2026-12-01',
      baseWage: '22000000',
      allowDirectHire: true,
    });
    // Before erase, the interview event on a hired candidate was still active.
    const beforeEraseStatus = await withAdmin(async (c) =>
      (await c.query<{ status: string }>(`SELECT status FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2`, [o.orgId, ownerBooked3.eventId])).rows[0]?.status,
    );
    expect(beforeEraseStatus).toBe('active');

    await o.exec<HrCandidateEraseResult>(o.owner, 'hr.recruiting.candidate.erase', { candidateId: cand3.candidateId }, asMfa(o.owner));
    const afterEraseEvent = await withAdmin(async (c) =>
      (
        await c.query<{ status: string; cancelled_by: string | null }>(
          `SELECT status, cancelled_by FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2`,
          [o.orgId, ownerBooked3.eventId],
        )
      ).rows[0],
    );
    expect(afterEraseEvent).toEqual({ status: 'cancelled', cancelled_by: o.owner });

    const eraseAuditDetail = await withAdmin(async (c) =>
      (
        await c.query<{ detail: { cancelledInterviewEventId?: string | null } }>(
          `SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'hr.recruiting.candidate.erase' AND target_id = $2 ORDER BY id DESC LIMIT 1`,
          [o.orgId, cand3.candidateId],
        )
      ).rows[0]?.detail,
    );
    expect(eraseAuditDetail?.cancelledInterviewEventId).toBe(ownerBooked3.eventId);

    // Case D (Item 4): Shared `acquireAdvisoryXactLock` serializes two concurrent transactions on the same key while allowing distinct keys concurrently.
    const db = createDb(pool);
    const sameKey = advisoryLockKey('crove_hr.interview', o.orgId, o.owner);
    const otherKey = advisoryLockKey('crove_hr.interview', o.orgId, o.admin);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstLocked!: () => void;
    const firstAcquired = new Promise<void>((resolve) => {
      firstLocked = resolve;
    });

    const tx1 = db.transaction().execute(async (trx) => {
      await acquireAdvisoryXactLock(trx, sameKey);
      order.push('tx1:acquired');
      firstLocked();
      await firstGate;
      order.push('tx1:releasing');
    });

    await firstAcquired;

    const tx2 = db.transaction().execute(async (trx) => {
      await acquireAdvisoryXactLock(trx, sameKey);
      order.push('tx2:acquired');
    });

    // Different key acquires and finishes while tx1 still holds `sameKey`.
    await db.transaction().execute(async (trx) => {
      await acquireAdvisoryXactLock(trx, otherKey);
      order.push('tx3-other-key:acquired');
    });
    expect(order).toEqual(['tx1:acquired', 'tx3-other-key:acquired']);

    releaseFirst();
    await Promise.all([tx1, tx2]);
    expect(order).toEqual(['tx1:acquired', 'tx3-other-key:acquired', 'tx1:releasing', 'tx2:acquired']);
  });

  it('refuses ordinary recruiting commands and queries when hr is switched off while allowing owner PDPL candidate.erase (#3447 Item 2)', async () => {
    const o = await org();
    const opening = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      title: 'Trưởng nhóm Kinh doanh',
      contractType: 'indefinite',
      region: 'I',
    });

    const fromIso = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const toIso = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const slots = await o.query<HrInterviewSlotsResult>(o.owner, 'hr.recruiting.interview_slots', {
      from: fromIso,
      to: toIso,
      durationMinutes: 45,
      maxSlots: 4,
    });
    expect(slots.slots.length).toBeGreaterThanOrEqual(1);

    const hiredWithInterview = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Ngô Minh Quân',
      email: 'quan.ngo@example.com',
      phone: '0100000001',
      notes: 'Ứng viên kỹ thuật, liên hệ 0100000001.',
    });
    const booked = await o.exec<HrCandidateInterviewScheduled>(o.owner, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: hiredWithInterview.candidateId,
      startsAt: slots.slots[0]!.startIso,
      endsAt: slots.slots[0]!.endIso,
    });
    await o.exec<HrCandidateHireResult>(o.owner, 'hr.recruiting.candidate.hire', {
      candidateId: hiredWithInterview.candidateId,
      effectiveFrom: '2026-12-01',
      baseWage: '24000000',
      allowDirectHire: true,
    });

    const rejectedCand = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Bùi Thu Hà',
      email: 'ha.bui@example.com',
      phone: '0100000002',
      notes: 'Hồ sơ lưu sau phỏng vấn.',
    });
    await o.exec(o.owner, 'hr.recruiting.candidate.move_stage', {
      candidateId: rejectedCand.candidateId,
      toStage: 'rejected',
    });

    const activePipelineCand = await o.exec<HrCandidateWritten>(o.owner, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Đặng Quốc Tuấn',
    });

    // Switch off HR for this org (ADR-0053).
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'hr', enabled: false });

    const moduleOff = { code: 'MODULE_OFF', status: 404, details: { module: 'hr' } };

    // Ordinary recruiting queries and Ly brief RPC are refused while HR is off.
    await expect(o.query(o.owner, 'hr.recruiting.opening.list', {})).rejects.toMatchObject(moduleOff);
    await expect(o.query(o.owner, 'hr.recruiting.candidate.list', {})).rejects.toMatchObject(moduleOff);
    await expect(o.query(o.owner, 'hr.recruiting.candidate.get', { candidateId: rejectedCand.candidateId })).rejects.toMatchObject(moduleOff);
    await expect(o.query(o.owner, 'hr.recruiting.interviewers.list', {})).rejects.toMatchObject(moduleOff);
    await expect(o.query(o.owner, 'hr.recruiting.interview_slots', { from: fromIso, to: toIso })).rejects.toMatchObject(moduleOff);
    await expect(o.query(o.owner, 'hr.recruiting.brief.read', { candidateId: rejectedCand.candidateId, lang: 'vi' })).rejects.toMatchObject(moduleOff);
    const { postBrief } = makeHttp(o);
    expect((await postBrief(o.owner, { candidateId: rejectedCand.candidateId, lang: 'vi' })).status).toBe(404);

    // Ordinary recruiting commands are refused while HR is off.
    await expect(o.exec(o.owner, 'hr.recruiting.opening.add', { title: 'Vị trí mới' })).rejects.toMatchObject(moduleOff);
    await expect(o.exec(o.owner, 'hr.recruiting.candidate.add', { displayName: 'Ứng viên mới' })).rejects.toMatchObject(moduleOff);
    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.edit', { candidateId: activePipelineCand.candidateId, notes: 'Không được sửa khi tắt app' }),
    ).rejects.toMatchObject(moduleOff);
    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.move_stage', { candidateId: activePipelineCand.candidateId, toStage: 'rejected' }),
    ).rejects.toMatchObject(moduleOff);
    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.schedule_interview', {
        candidateId: activePipelineCand.candidateId,
        startsAt: slots.slots[0]!.startIso,
        endsAt: slots.slots[0]!.endIso,
      }),
    ).rejects.toMatchObject(moduleOff);
    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.cancel_interview', { candidateId: activePipelineCand.candidateId }),
    ).rejects.toMatchObject(moduleOff);
    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.hire', {
        candidateId: activePipelineCand.candidateId,
        effectiveFrom: '2026-12-01',
        baseWage: '15000000',
        allowDirectHire: true,
      }),
    ).rejects.toMatchObject(moduleOff);

    // `hr.recruiting.candidate.erase` (`runsWhenOff`) still enforces owner-only RBAC, fresh MFA (`aal2`), and terminal-stage checks while HR is off.
    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.erase', { candidateId: rejectedCand.candidateId }, asMfa(o.admin)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.erase', { candidateId: rejectedCand.candidateId }, asUser(o.owner)),
    ).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED', status: 403 });
    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.erase', { candidateId: activePipelineCand.candidateId }, asMfa(o.owner)),
    ).rejects.toMatchObject({ code: 'HR_CANDIDATE_STILL_IN_PIPELINE', status: 409 });

    // Owner with fresh MFA (`aal2`) erases both terminal candidates cleanly while HR is off, auto-cancelling the active linked interview.
    const erasedHired = await o.exec<HrCandidateEraseResult>(
      o.owner,
      'hr.recruiting.candidate.erase',
      { candidateId: hiredWithInterview.candidateId },
      asMfa(o.owner),
    );
    expect(erasedHired.candidateId).toBe(hiredWithInterview.candidateId);

    const erasedRejected = await o.exec<HrCandidateEraseResult>(
      o.owner,
      'hr.recruiting.candidate.erase',
      { candidateId: rejectedCand.candidateId },
      asMfa(o.owner),
    );
    expect(erasedRejected.candidateId).toBe(rejectedCand.candidateId);

    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.erase', { candidateId: rejectedCand.candidateId }, asMfa(o.owner)),
    ).rejects.toMatchObject({ code: 'HR_CANDIDATE_ERASED', status: 409 });

    // Verify directly in PostgreSQL while HR remains off: PII cleared, interview link cleared, calendar_event cancelled, audit PII-free.
    const dbState = await withAdmin(async (c) => {
      const candRows = (
        await c.query<{
          id: string;
          display_name: string;
          email: string | null;
          phone: string | null;
          notes: string | null;
          interview_event_id: string | null;
          interview_starts_at: Date | null;
          interview_ends_at: Date | null;
          erased_at: Date | null;
        }>(
          `SELECT id, display_name, email, phone, notes, interview_event_id, interview_starts_at, interview_ends_at, erased_at
           FROM crove_hr.candidate
           WHERE org_id = $1 AND id = ANY($2::uuid[])`,
          [o.orgId, [hiredWithInterview.candidateId, rejectedCand.candidateId]],
        )
      ).rows;
      const eventRow = (
        await c.query<{ status: string; cancelled_by: string | null }>(
          `SELECT status, cancelled_by FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2`,
          [o.orgId, booked.eventId],
        )
      ).rows[0];
      const auditRow = (
        await c.query<{ detail: { cancelledInterviewEventId?: string | null }; row: string }>(
          `SELECT detail, audit_event::text AS row
           FROM crove_kernel.audit_event
           WHERE org_id = $1 AND command = 'hr.recruiting.candidate.erase' AND target_id = $2
           ORDER BY id DESC LIMIT 1`,
          [o.orgId, hiredWithInterview.candidateId],
        )
      ).rows[0];
      return { candRows, eventRow, auditRow };
    });

    expect(dbState.candRows).toHaveLength(2);
    for (const row of dbState.candRows) {
      expect(row.display_name).toBe(HR_ERASED_NAME);
      expect(row.email).toBeNull();
      expect(row.phone).toBeNull();
      expect(row.notes).toBeNull();
      expect(row.interview_event_id).toBeNull();
      expect(row.interview_starts_at).toBeNull();
      expect(row.interview_ends_at).toBeNull();
      expect(row.erased_at).not.toBeNull();
    }
    expect(dbState.eventRow).toEqual({ status: 'cancelled', cancelled_by: o.owner });
    expect(dbState.auditRow?.detail.cancelledInterviewEventId).toBe(booked.eventId);
    expect(dbState.auditRow?.row).not.toContain('Ngô Minh Quân');
    expect(dbState.auditRow?.row).not.toContain('quan.ngo@example.com');
    expect(dbState.auditRow?.row).not.toContain('0100000001');

    // Re-enabling HR restores reads and surfaces the erased view cleanly.
    await o.exec(o.owner, 'kernel.org.set_app', { module: 'hr', enabled: true });
    const restoredView = await o.query<HrCandidateView>(o.owner, 'hr.recruiting.candidate.get', {
      candidateId: hiredWithInterview.candidateId,
    });
    expect(restoredView.displayName).toBe(HR_ERASED_NAME);
    expect(restoredView.email).toBeNull();
    expect(restoredView.phone).toBeNull();
    expect(restoredView.notes).toBeNull();
    expect(restoredView.interviewEventId).toBeNull();
    expect(restoredView.interviewerUserId).toBeNull();
    expect(restoredView.interviewerName).toBeNull();
    expect(restoredView.erasedAt).not.toBeNull();
  });

  it('lists eligible interviewers (excluding viewers), checks target interviewer availability/double-booking, switches interviewers on reschedule, and cancels interview without changing stage (#4299)', async () => {
    const o = await org({
      owner: 'Chủ Doanh Nghiệp',
      admin: 'Quản Lý Nhân Sự',
      member: 'Trưởng Nhóm Kỹ Thuật',
      viewer: 'Người Chỉ Xem',
    });
    const other = await org({ owner: 'Chủ Công Ty Khác' });

    // Also add a second member with `name: null` to verify email fallback in crove_kernel.member_profiles enrichment.
    const memberEmailFallback = await upsertIdentity(createDb(pool), {
      issuer: 'hrrec',
      subject: `member-noname-${randomUUID().slice(0, 8)}`,
      email: 'no-name-member@hr.test',
      name: null,
    });
    await withAdmin((c) =>
      c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, memberEmailFallback]),
    );

    // 1. `hr.recruiting.interviewers.list`: managers-only, returns owner/admin/member with profile names, excludes viewer and other org.
    await expect(o.query(o.member, 'hr.recruiting.interviewers.list', {})).rejects.toMatchObject({ status: 403 });
    await expect(o.query(o.viewer, 'hr.recruiting.interviewers.list', {})).rejects.toMatchObject({ status: 403 });

    const interviewers = await o.query<HrInterviewerOption[]>(o.admin, 'hr.recruiting.interviewers.list', {});
    expect(interviewers).toEqual(
      expect.arrayContaining([
        { userId: o.owner, displayName: 'Chủ Doanh Nghiệp', role: 'owner' },
        { userId: o.admin, displayName: 'Quản Lý Nhân Sự', role: 'admin' },
        { userId: o.member, displayName: 'Trưởng Nhóm Kỹ Thuật', role: 'member' },
        { userId: memberEmailFallback, displayName: 'no-name-member@hr.test', role: 'member' },
      ]),
    );
    expect(interviewers.some((i) => i.userId === o.viewer)).toBe(false);
    expect(interviewers.some((i) => i.userId === other.owner)).toBe(false);

    // 2. Rejects viewer and cross-org member on both `interview_slots` and `schedule_interview` with 422 HR_INTERVIEWER_INVALID.
    const opening = await o.exec<HrOpeningWritten>(o.owner, 'hr.recruiting.opening.add', {
      title: 'Kỹ sư Backend',
      contractType: 'indefinite',
      region: 'I',
    });
    const cand1 = await o.exec<HrCandidateWritten>(o.admin, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Nguyễn Hữu Phước',
      email: 'phuoc@example.com',
      phone: '0900000003',
    });
    const cand2 = await o.exec<HrCandidateWritten>(o.admin, 'hr.recruiting.candidate.add', {
      openingId: opening.openingId,
      displayName: 'Đào Ngọc Ánh',
    });

    const fromIso = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const toIso = new Date(Date.now() + 14 * 86_400_000).toISOString();
    const baseMemberSlots = await o.query<HrInterviewSlotsResult>(o.admin, 'hr.recruiting.interview_slots', {
      interviewerUserId: o.member,
      from: fromIso,
      to: toIso,
      durationMinutes: 45,
      maxSlots: 8,
    });
    expect(baseMemberSlots.slots.length).toBeGreaterThanOrEqual(4);
    const slot0 = baseMemberSlots.slots[0]!;
    const slot1 = baseMemberSlots.slots[1]!;
    const slot2 = baseMemberSlots.slots[2]!;

    await expect(
      o.query(o.admin, 'hr.recruiting.interview_slots', { interviewerUserId: o.viewer, from: fromIso, to: toIso }),
    ).rejects.toMatchObject({ code: 'HR_INTERVIEWER_INVALID', status: 422 });
    await expect(
      o.query(o.admin, 'hr.recruiting.interview_slots', { interviewerUserId: other.owner, from: fromIso, to: toIso }),
    ).rejects.toMatchObject({ code: 'HR_INTERVIEWER_INVALID', status: 422 });
    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.schedule_interview', {
        candidateId: cand1.candidateId,
        interviewerUserId: o.viewer,
        startsAt: slot0.startIso,
        endsAt: slot0.endIso,
      }),
    ).rejects.toMatchObject({ code: 'HR_INTERVIEWER_INVALID', status: 422 });
    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.schedule_interview', {
        candidateId: cand1.candidateId,
        interviewerUserId: other.owner,
        startsAt: slot0.startIso,
        endsAt: slot0.endIso,
      }),
    ).rejects.toMatchObject({ code: 'HR_INTERVIEWER_INVALID', status: 422 });

    // 3. Checks target interviewer's OWN working hours and busy events (not caller's).
    // Save custom working hours for member while admin keeps default unsaved hours, then put a busy event on
    // owner's calendar at slot0 and on member's calendar at slot1; querying member's slots reads member's saved
    // hours and skips slot1 while still offering slot0.
    await o.exec(o.member, 'kernel.calendar.hours.save', {
      timeZone: 'Asia/Ho_Chi_Minh',
      windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: 8 * 60, end: 17 * 60 })),
    });
    const adminDefaultSlots = await o.query<HrInterviewSlotsResult>(o.admin, 'hr.recruiting.interview_slots', {
      from: fromIso,
      to: toIso,
      durationMinutes: 45,
      maxSlots: 8,
    });
    expect(adminDefaultSlots.hoursSaved).toBe(false);

    await o.exec(o.owner, 'kernel.calendar.event.add', {
      startsAt: slot0.startIso,
      endsAt: slot0.endIso,
      timeZone: 'Asia/Ho_Chi_Minh',
      title: 'Họp riêng chủ doanh nghiệp',
      kind: 'manual',
    });
    await o.exec(o.member, 'kernel.calendar.event.add', {
      startsAt: slot1.startIso,
      endsAt: slot1.endIso,
      timeZone: 'Asia/Ho_Chi_Minh',
      title: 'Việc bận kỹ thuật',
      kind: 'manual',
    });

    const memberSlotsWithBusy = await o.query<HrInterviewSlotsResult>(o.admin, 'hr.recruiting.interview_slots', {
      interviewerUserId: o.member,
      from: fromIso,
      to: toIso,
      durationMinutes: 45,
      maxSlots: 8,
    });
    expect(memberSlotsWithBusy.hoursSaved).toBe(true);
    expect(memberSlotsWithBusy.slots.some((s) => s.startIso === slot0.startIso)).toBe(true);
    expect(memberSlotsWithBusy.slots.some((s) => s.startIso === slot1.startIso)).toBe(false);

    // Book cand1 on member's calendar at slot0 (even though owner is busy at slot0).
    const bookedMember = await o.exec<HrCandidateInterviewScheduled>(o.admin, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: cand1.candidateId,
      interviewerUserId: o.member,
      startsAt: slot0.startIso,
      endsAt: slot0.endIso,
    });
    expect(bookedMember.interviewerUserId).toBe(o.member);
    expect(bookedMember.stage).toBe('interview');

    const memberEventRow = await withAdmin(async (c) =>
      (
        await c.query<{ user_id: string; created_by: string; title: string | null; status: string }>(
          `SELECT user_id, created_by, title, status FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2`,
          [o.orgId, bookedMember.eventId],
        )
      ).rows[0],
    );
    expect(memberEventRow).toEqual({
      user_id: o.member,
      created_by: o.admin,
      title: 'Phỏng vấn: Kỹ sư Backend',
      status: 'active',
    });
    expect(memberEventRow?.title).not.toContain('Nguyễn Hữu Phước');

    const cand1View = await o.query<HrCandidateView>(o.owner, 'hr.recruiting.candidate.get', { candidateId: cand1.candidateId });
    expect(cand1View.interviewerUserId).toBe(o.member);
    expect(cand1View.interviewerName).toBe('Trưởng Nhóm Kỹ Thuật');

    const candList = await o.query<HrCandidateView[]>(o.owner, 'hr.recruiting.candidate.list', { openingId: opening.openingId });
    const cand1Listed = candList.find((c) => c.id === cand1.candidateId);
    expect(cand1Listed?.interviewerUserId).toBe(o.member);
    expect(cand1Listed?.interviewerName).toBe('Trưởng Nhóm Kỹ Thuật');

    // Double-booking the same member at slot0 fails 409, while booking admin at slot0 succeeds.
    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.schedule_interview', {
        candidateId: cand2.candidateId,
        interviewerUserId: o.member,
        startsAt: slot0.startIso,
        endsAt: slot0.endIso,
      }),
    ).rejects.toMatchObject({ code: 'HR_INTERVIEW_SLOT_TAKEN', status: 409 });

    // Also verify booking member at member's own busy slot1 fails 409.
    await expect(
      o.exec(o.admin, 'hr.recruiting.candidate.schedule_interview', {
        candidateId: cand2.candidateId,
        interviewerUserId: o.member,
        startsAt: slot1.startIso,
        endsAt: slot1.endIso,
      }),
    ).rejects.toMatchObject({ code: 'HR_INTERVIEW_SLOT_TAKEN', status: 409 });

    const bookedAdminSameTime = await o.exec<HrCandidateInterviewScheduled>(o.admin, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: cand2.candidateId,
      interviewerUserId: o.admin,
      startsAt: slot0.startIso,
      endsAt: slot0.endIso,
    });
    expect(bookedAdminSameTime.interviewerUserId).toBe(o.admin);

    // 4. Switching interviewer on reschedule cancels old interviewer's event and frees old interviewer's slot.
    const switchedToAdmin = await o.exec<HrCandidateInterviewScheduled>(o.admin, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: cand1.candidateId,
      interviewerUserId: o.admin,
      startsAt: slot2.startIso,
      endsAt: slot2.endIso,
    });
    expect(switchedToAdmin.interviewerUserId).toBe(o.admin);
    expect(switchedToAdmin.eventId).not.toBe(bookedMember.eventId);

    const oldMemberEvent = await withAdmin(async (c) =>
      (
        await c.query<{ status: string; cancelled_by: string | null }>(
          `SELECT status, cancelled_by FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2`,
          [o.orgId, bookedMember.eventId],
        )
      ).rows[0],
    );
    expect(oldMemberEvent).toEqual({ status: 'cancelled', cancelled_by: o.admin });

    const memberSlotsAfterSwitch = await o.query<HrInterviewSlotsResult>(o.admin, 'hr.recruiting.interview_slots', {
      interviewerUserId: o.member,
      from: fromIso,
      to: toIso,
      durationMinutes: 45,
      maxSlots: 8,
    });
    expect(memberSlotsAfterSwitch.slots.some((s) => s.startIso === slot0.startIso)).toBe(true);

    // Rescheduling on the SAME interviewer (admin) overlapping slot2 works via exceptEventId.
    const shiftedStart = new Date(Date.parse(slot2.startIso) + 15 * 60_000).toISOString();
    const shiftedEnd = new Date(Date.parse(slot2.endIso) + 15 * 60_000).toISOString();
    const sameInterviewerOverlap = await o.exec<HrCandidateInterviewScheduled>(o.admin, 'hr.recruiting.candidate.schedule_interview', {
      candidateId: cand1.candidateId,
      interviewerUserId: o.admin,
      startsAt: shiftedStart,
      endsAt: shiftedEnd,
    });
    expect(sameInterviewerOverlap.interviewerUserId).toBe(o.admin);
    expect(sameInterviewerOverlap.eventId).not.toBe(switchedToAdmin.eventId);

    // 5. Standalone cancel (`hr.recruiting.candidate.cancel_interview`): RBAC/cross-org checks, frees slot, preserves 'interview' stage.
    await expect(
      o.exec(o.member, 'hr.recruiting.candidate.cancel_interview', { candidateId: cand1.candidateId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      o.exec(o.viewer, 'hr.recruiting.candidate.cancel_interview', { candidateId: cand1.candidateId }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      other.exec(other.owner, 'hr.recruiting.candidate.cancel_interview', { candidateId: cand1.candidateId }),
    ).rejects.toMatchObject({ code: 'HR_CANDIDATE_NOT_FOUND', status: 404 });

    const cancelled = await o.exec<HrCandidateInterviewCancelled>(o.owner, 'hr.recruiting.candidate.cancel_interview', {
      candidateId: cand1.candidateId,
    });
    expect(cancelled).toEqual({
      candidateId: cand1.candidateId,
      cancelledEventId: sameInterviewerOverlap.eventId,
      stage: 'interview',
    });

    const cancelledEventRow = await withAdmin(async (c) =>
      (
        await c.query<{ status: string; cancelled_by: string | null }>(
          `SELECT status, cancelled_by FROM crove_kernel.calendar_event WHERE org_id = $1 AND id = $2`,
          [o.orgId, sameInterviewerOverlap.eventId],
        )
      ).rows[0],
    );
    expect(cancelledEventRow).toEqual({ status: 'cancelled', cancelled_by: o.owner });

    const cand1AfterCancel = await o.query<HrCandidateView>(o.owner, 'hr.recruiting.candidate.get', { candidateId: cand1.candidateId });
    expect(cand1AfterCancel.stage).toBe('interview');
    expect(cand1AfterCancel.interviewEventId).toBeNull();
    expect(cand1AfterCancel.interviewStartsAt).toBeNull();
    expect(cand1AfterCancel.interviewEndsAt).toBeNull();
    expect(cand1AfterCancel.interviewerUserId).toBeNull();
    expect(cand1AfterCancel.interviewerName).toBeNull();

    const briefAfterCancel = await o.query<{ input: { hasScheduledInterview: boolean } }>(o.owner, 'hr.recruiting.brief.read', {
      candidateId: cand1.candidateId,
      lang: 'vi',
    });
    expect(briefAfterCancel.input.hasScheduledInterview).toBe(false);

    // Repeating cancel_interview is idempotent and audit keeps IDs only without PII.
    const repeatedCancel = await o.exec<HrCandidateInterviewCancelled>(o.owner, 'hr.recruiting.candidate.cancel_interview', {
      candidateId: cand1.candidateId,
    });
    expect(repeatedCancel).toEqual({
      candidateId: cand1.candidateId,
      cancelledEventId: null,
      stage: 'interview',
    });

    const cancelAudit = await withAdmin(async (c) =>
      (
        await c.query<{ outcome: string; detail: Record<string, unknown>; row: string }>(
          `SELECT outcome, detail, audit_event::text AS row
           FROM crove_kernel.audit_event
           WHERE org_id = $1 AND command = 'hr.recruiting.candidate.cancel_interview' AND target_id = $2
             AND outcome = 'ok'
           ORDER BY id ASC`,
          [o.orgId, cand1.candidateId],
        )
      ).rows,
    );
    expect(cancelAudit.length).toBe(2);
    expect(cancelAudit[0]?.detail).toMatchObject({
      candidateId: cand1.candidateId,
      stage: 'interview',
      cancelledEventId: sameInterviewerOverlap.eventId,
      interviewerUserId: o.admin,
    });
    for (const row of cancelAudit) {
      expect(row.row).not.toContain('Nguyễn Hữu Phước');
      expect(row.row).not.toContain('phuoc@example.com');
      expect(row.row).not.toContain('0900000003');
    }

    // Erased candidate rejects cancel_interview cleanly with 409 HR_CANDIDATE_ERASED.
    await o.exec(o.owner, 'hr.recruiting.candidate.move_stage', { candidateId: cand1.candidateId, toStage: 'rejected' });
    await o.exec(o.owner, 'hr.recruiting.candidate.erase', { candidateId: cand1.candidateId }, asMfa(o.owner));
    await expect(
      o.exec(o.owner, 'hr.recruiting.candidate.cancel_interview', { candidateId: cand1.candidateId }),
    ).rejects.toMatchObject({ code: 'HR_CANDIDATE_ERASED', status: 409 });
  });
});

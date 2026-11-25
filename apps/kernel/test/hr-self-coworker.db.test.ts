// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for HR Stage 6A self-service request drafting (`hr.request_draft`)
// and cited HR policy Q&A (`hr.policy_qa`) (#4526):
// - AI-off deterministic parity (never inserts or mutates leave_request / overtime_request)
// - RBAC: owner / admin / linked member allowed; viewer (403 FORBIDDEN) & unlinked member (403 HR_SELF_NOT_LINKED) denied
// - Strict caller-scoped `notes.*` RLS: peer member private notes and owner private notes excluded; cross-org isolated
// - Graceful `notes` disabled (`org_app_on(org_id, 'notes') = false`) fallback with 0 LLM calls
// - Metered AI (`hr.request_draft` & `hr.policy_qa`), kill-switch & budget-exhausted fallback, citation grounding
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InboxReader, metered } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import type {
  HrSelfPolicyQaResult,
  HrSelfRequestDraftResult,
  HrWritten,
  NoteWritten,
} from '@ludy/kernel-contract';
import {
  CredentialVault,
  Runtime,
  SUBJECT_WRAP_INFO,
  SubjectVault,
  parseVaultKey,
  sha256Hex,
  type BlobStore,
} from '@ludy/kernel-runtime';
import { hrCommands, hrQueries } from '@ludy/mod-hr';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_SIGNING_KEY = 'test-only-jwt-key-for-hr-stage6a-self-coworker-0123456789abcdef';
const ISSUER = 'ludy-hr-6a-test';

class MemoryStore implements BlobStore {
  readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const found = this.blobs.get(key);
    if (!found) throw new Error(`missing blob: ${key}`);
    return found;
  }
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const suite = ADMIN ? describe : describe.skip;

suite('HR Stage 6A self-service request drafting & cited policy Q&A (#4526)', () => {
  const dbName = `ludy_test_hr6a_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let appAiOff: ReturnType<typeof createHttpApp>;
  let appAiOn: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const subjectVault = new SubjectVault(
    new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]).deriveKeys(SUBJECT_WRAP_INFO),
  );

  const capturedQaPrompts: string[] = [];
  let nextQaMode: 'grounded' | 'rogue_citation' = 'grounded';
  let rogueForeignNoteId: string = randomUUID();

  const makeAccount = (name: string): Account => ({
    subject: `${name}-${randomUUID()}`,
    email: `${name}-${randomUUID().slice(0, 6)}@hr6a.test`,
    session: randomUUID(),
    userId: '',
  });

  const owner1 = makeAccount('owner1');
  const admin1 = makeAccount('admin1');
  const staffA = makeAccount('staffa');
  const staffB = makeAccount('staffb');
  const unlinked1 = makeAccount('unlinked1');
  const viewer1 = makeAccount('viewer1');
  const owner2 = makeAccount('owner2');
  const staff2 = makeAccount('staff2');

  let org1 = { slug: '', orgId: '' };
  let org2 = { slug: '', orgId: '' };

  async function tokenFor(who: Account, opts: { mfa?: boolean } = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      role: 'authenticated',
      email: who.email,
      session_id: who.session,
      aal: opts.mfa ? 'aal2' : 'aal1',
      is_anonymous: false,
      ...(opts.mfa ? { amr: [{ method: 'totp', timestamp: now }] } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(new TextEncoder().encode(JWT_SIGNING_KEY));
  }

  async function rpc(
    app: ReturnType<typeof createHttpApp>,
    path: string,
    who: Account,
    input: unknown,
    orgSlug: string | null,
    opts: { mfa?: boolean } = {},
  ) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await tokenFor(who, opts)}`,
      'content-type': 'application/json',
    };
    if (orgSlug) headers['x-ludy-org'] = orgSlug;
    const res = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { raw: text };
    }
    const payload = (parsed.json ?? parsed) as Record<string, unknown>;
    return { status: res.status, body: payload };
  }

  beforeAll(async () => {
    const rootClient = new pg.Client({ connectionString: ADMIN as string });
    await rootClient.connect();
    await rootClient.query(`CREATE DATABASE ${dbName}`);
    await rootClient.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';

    adminPool = createPool({ connectionString: adminUrl, max: 2, resetOnRelease: false });
    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    db = createDb(pool);

    const kernelCmds = buildKernelCommands({ shippedModules: AVAILABLE_MODULES });
    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      subjectVault,
      readAuditKey: randomBytes(32),
      stepUp: 'required',
    }).register({
      commands: [...kernelCmds, ...hrCommands, ...notesCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...hrQueries, ...notesQueries],
    });

    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: JWT_SIGNING_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const authenticate = createAuthenticator(config, db);

    appAiOff = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: false });

    const fakeReader = new InboxReader(
      { baseURL: 'https://model.example/v1', apiKey: 'test', model: 'test-model' },
      {
        hrRequestDraft: async () => {
          const m = await metered('hr.request_draft', async () => ({
            output: {
              kind: 'leave' as const,
              startOn: '2026-11-27',
              endOn: '2026-11-27',
              leaveKind: 'annual_leave' as const,
              days: '0.5',
              halfDaySession: 'afternoon' as const,
              workDate: null,
              hours: null,
              dayType: null,
              isNight: null,
              destination: null,
              reason: 'Nghỉ phép chiều thứ 6',
            },
            usage: { inputTokens: 120, outputTokens: 45 },
          }));
          return { output: m.output, usage: { inputTokens: 120, outputTokens: 45 } };
        },
        hrPolicyQa: async ({ prompt }) => {
          capturedQaPrompts.push(prompt);
          const m = await metered('hr.policy_qa', async () => ({
            output:
              nextQaMode === 'rogue_citation'
                ? {
                    answer: 'Nhân viên được nghỉ 12 ngày phép năm.',
                    citations: [{ noteId: rogueForeignNoteId, quoteExcerpt: '12 ngày phép năm' }],
                  }
                : {
                    answer: 'Nhân viên chính thức được hưởng 12 ngày phép năm có lương.',
                    citations: [
                      {
                        noteId: org1SharedLeaveNoteId,
                        quoteExcerpt: 'Nhân viên chính thức được hưởng 12 ngày phép năm có lương',
                      },
                    ],
                  },
            usage: { inputTokens: 200, outputTokens: 60 },
          }));
          return { output: m.output, usage: { inputTokens: 200, outputTokens: 60 } };
        },
      },
    );

    appAiOn = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: true,
      conversationReader: fakeReader,
      aiPrice: { inputPerMTok: '1.00', outputPerMTok: '2.00' },
    });

    for (const who of [owner1, admin1, staffA, staffB, unlinked1, viewer1, owner2, staff2]) {
      const me = await rpc(appAiOff, 'me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const c1 = await rpc(appAiOff, 'org/create', owner1, { name: 'HR 6A Org 1', idempotencyKey: randomUUID() }, null);
    expect(c1.status).toBe(200);
    org1 = { slug: String(c1.body.slug), orgId: String(c1.body.orgId) };

    const c2 = await rpc(appAiOff, 'org/create', owner2, { name: 'HR 6A Org 2', idempotencyKey: randomUUID() }, null);
    expect(c2.status).toBe(200);
    org2 = { slug: String(c2.body.slug), orgId: String(c2.body.orgId) };

    await adminPool.query(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'viewer'), ($7, $8, 'member')`,
      [org1.orgId, admin1.userId, staffA.userId, staffB.userId, unlinked1.userId, viewer1.userId, org2.orgId, staff2.userId],
    );

    const addAndLink = async (orgId: string, actorUserId: string, who: Account, name: string, wage: string) => {
      const added = await runtime.execute<HrWritten>(
        'hr.payroll.employee.add',
        {
          displayName: name,
          employment: { effectiveFrom: '2026-09-01', contractType: 'indefinite', region: 'I', baseWage: wage },
        },
        {
          actor: { type: 'user', userId: actorUserId, aal: 'aal2', sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) },
          orgId,
        },
      );
      await runtime.execute(
        'hr.payroll.employee.link_member',
        { employeeId: added.employeeId, userId: who.userId },
        {
          actor: { type: 'user', userId: actorUserId, aal: 'aal2', sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) },
          orgId,
        },
      );
    };

    await addAndLink(org1.orgId, owner1.userId, staffA, 'Nguyễn Văn An', '20000000');
    await addAndLink(org1.orgId, owner1.userId, staffB, 'Trần Thị Bình', '35000000');
    await addAndLink(org2.orgId, owner2.userId, staff2, 'Lê Văn Org2', '42000000');
  }, 420_000);

  let org1SharedLeaveNoteId = '';

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
    if (!ADMIN) return;
    const rootClient = new pg.Client({ connectionString: ADMIN });
    await rootClient.connect();
    await rootClient.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootClient.end();
  });

  it('enforces RBAC, zero-mutation request drafting, caller-scoped Notes RLS, notes_off, cross-org isolation, and AI metering', async () => {
    // Seed shared & private notes in Org 1 and Org 2.
    const sharedLeave = await runtime.execute<NoteWritten>(
      'notes.note.create',
      {
        title: 'Chính sách nghỉ phép năm',
        body: 'Nhân viên chính thức được hưởng 12 ngày phép năm có lương mỗi năm. Nghỉ buổi chiều tính 0.5 ngày.',
        tags: ['hr', 'nghi-phep'],
        visibility: 'org',
      },
      { actor: { type: 'user', userId: owner1.userId, aal: 'aal1', sessionId: owner1.session }, orgId: org1.orgId },
    );
    org1SharedLeaveNoteId = sharedLeave.noteId;

    await runtime.execute<NoteWritten>(
      'notes.note.create',
      {
        title: 'Quy định làm thêm giờ OT',
        body: 'Làm thêm giờ ngày thường 150%, ngày nghỉ tuần 200%, ngày lễ 300%.',
        tags: ['hr', 'ot'],
        visibility: 'org',
      },
      { actor: { type: 'user', userId: admin1.userId, aal: 'aal1', sessionId: admin1.session }, orgId: org1.orgId },
    );

    const peerPrivateNote = await runtime.execute<NoteWritten>(
      'notes.note.create',
      {
        title: 'Ghi chú nghỉ phép bí mật của Bình',
        body: 'Bình xin nghỉ phép bí mật để phỏng vấn nơi khác. SECRET_PEER_TOKEN_991.',
        tags: ['private'],
        visibility: 'private',
      },
      { actor: { type: 'user', userId: staffB.userId, aal: 'aal1', sessionId: staffB.session }, orgId: org1.orgId },
    );

    const ownerPrivateNote = await runtime.execute<NoteWritten>(
      'notes.note.create',
      {
        title: 'Ghi chú riêng của giám đốc về phép năm',
        body: 'Ghi chú riêng của chủ doanh nghiệp OWNER_SECRET_772.',
        tags: ['private'],
        visibility: 'private',
      },
      { actor: { type: 'user', userId: owner1.userId, aal: 'aal1', sessionId: owner1.session }, orgId: org1.orgId },
    );

    const org2Note = await runtime.execute<NoteWritten>(
      'notes.note.create',
      {
        title: 'Org2 Chính sách nghỉ phép riêng',
        body: 'Org2 cho phép 25 ngày phép năm ORG2_SECRET_883.',
        tags: ['hr'],
        visibility: 'org',
      },
      { actor: { type: 'user', userId: owner2.userId, aal: 'aal1', sessionId: owner2.session }, orgId: org2.orgId },
    );
    rogueForeignNoteId = org2Note.noteId;

    // 1. RBAC: viewer (403 FORBIDDEN) & unlinked member (403 HR_SELF_NOT_LINKED) denied on both endpoints.
    for (const actor of [viewer1]) {
      expect((await rpc(appAiOff, 'hr/self/requestDraft', actor, { text: 'xin nghi phep ngay mai' }, org1.slug)).status).toBe(403);
      expect((await rpc(appAiOff, 'hr/self/policyQa', actor, { question: 'Nghỉ phép năm?' }, org1.slug)).status).toBe(403);
    }
    const unlinkedDraft = await rpc(appAiOff, 'hr/self/requestDraft', unlinked1, { text: 'xin nghi phep ngay mai' }, org1.slug);
    expect(unlinkedDraft.status).toBe(403);
    expect(unlinkedDraft.body.code).toBe('HR_SELF_NOT_LINKED');
    const unlinkedQa = await rpc(appAiOff, 'hr/self/policyQa', unlinked1, { question: 'Nghỉ phép năm?' }, org1.slug);
    expect(unlinkedQa.status).toBe(403);
    expect(unlinkedQa.body.code).toBe('HR_SELF_NOT_LINKED');

    // 2. AI-off deterministic request drafting for linked member, owner, admin; 0 DB mutations.
    const leaveDraftRes = await rpc(
      appAiOff,
      'hr/self/requestDraft',
      staffA,
      { text: 'xin nghi phep chieu thu 6', lang: 'vi', referenceDate: '2026-11-23' },
      org1.slug,
    );
    expect(leaveDraftRes.status).toBe(200);
    expect(leaveDraftRes.body as unknown as HrSelfRequestDraftResult).toMatchObject({
      aiStatus: 'off',
      source: 'deterministic',
      tainted: true,
      draft: { kind: 'leave', startOn: '2026-11-27', endOn: '2026-11-27', leaveKind: 'annual_leave', days: '0.5' },
    });

    const otDraftRes = await rpc(
      appAiOff,
      'hr/self/requestDraft',
      staffA,
      { text: 'dang ky OT thu 7 3 gio', lang: 'vi', referenceDate: '2026-11-23' },
      org1.slug,
    );
    expect(otDraftRes.status).toBe(200);
    expect(otDraftRes.body as unknown as HrSelfRequestDraftResult).toMatchObject({
      aiStatus: 'off',
      source: 'deterministic',
      tainted: true,
      draft: { kind: 'overtime', workDate: '2026-11-28', hours: '3', dayType: 'weekday' },
    });

    const tripDraftRes = await rpc(
      appAiOff,
      'hr/self/requestDraft',
      owner1,
      { text: 'di cong tac Da Nang 2 ngay', lang: 'vi', referenceDate: '2026-11-23' },
      org1.slug,
    );
    expect(tripDraftRes.status).toBe(200);
    expect((tripDraftRes.body as unknown as HrSelfRequestDraftResult).draft.kind).toBe('business_trip_unsupported');

    const { rows: dbCounts } = await adminPool.query<{ leave_cnt: string; ot_cnt: string }>(
      `SELECT
         (SELECT count(*) FROM ludy_hr.leave_request WHERE org_id = $1) AS leave_cnt,
         (SELECT count(*) FROM ludy_hr.overtime_request WHERE org_id = $1) AS ot_cnt`,
      [org1.orgId],
    );
    expect(dbCounts[0]).toEqual({ leave_cnt: '0', ot_cnt: '0' });

    // 3. AI-off deterministic Policy Q&A: strict RLS + private note exclusion + cross-org isolation.
    const qaOff = await rpc(
      appAiOff,
      'hr/self/policyQa',
      staffA,
      { question: 'Chính sách nghỉ phép năm bao nhiêu ngày?', lang: 'vi' },
      org1.slug,
    );
    expect(qaOff.status).toBe(200);
    const qaOffData = qaOff.body as unknown as HrSelfPolicyQaResult;
    expect(qaOffData.notesAvailable).toBe(true);
    expect(qaOffData.aiStatus).toBe('off');
    expect(qaOffData.tainted).toBe(false);
    expect(qaOffData.answer).toBeNull();
    expect(qaOffData.matches[0]?.noteId).toBe(org1SharedLeaveNoteId);
    expect(qaOffData.matches.every((m) => m.visibility === 'org')).toBe(true);
    const serializedQaOff = JSON.stringify(qaOffData);
    expect(serializedQaOff).not.toContain(peerPrivateNote.noteId);
    expect(serializedQaOff).not.toContain(ownerPrivateNote.noteId);
    expect(serializedQaOff).not.toContain(org2Note.noteId);
    expect(serializedQaOff).not.toContain('SECRET_PEER_TOKEN_991');
    expect(serializedQaOff).not.toContain('OWNER_SECRET_772');
    expect(serializedQaOff).not.toContain('ORG2_SECRET_883');

    // Cross-org isolation: Org 2 member sees ONLY Org 2 shared note.
    const qaOrg2 = await rpc(
      appAiOff,
      'hr/self/policyQa',
      staff2,
      { question: 'Chính sách nghỉ phép năm?', lang: 'vi' },
      org2.slug,
    );
    expect(qaOrg2.status).toBe(200);
    expect((qaOrg2.body as unknown as HrSelfPolicyQaResult).matches.map((m) => m.noteId)).toEqual([org2Note.noteId]);

    // 4. AI-on metered requests & citation grounding (never leaking peer private notes or employee PII).
    const aiDraftOn = await rpc(
      appAiOn,
      'hr/self/requestDraft',
      staffA,
      { text: 'xin nghi phep chieu thu 6', lang: 'vi', referenceDate: '2026-11-23' },
      org1.slug,
    );
    expect(aiDraftOn.status).toBe(200);
    expect(aiDraftOn.body).toMatchObject({ aiStatus: 'used', source: 'ai', tainted: true });

    const aiQaOn = await rpc(
      appAiOn,
      'hr/self/policyQa',
      staffA,
      { question: 'Chính sách nghỉ phép năm bao nhiêu ngày?', lang: 'vi' },
      org1.slug,
    );
    expect(aiQaOn.status).toBe(200);
    const aiQaData = aiQaOn.body as unknown as HrSelfPolicyQaResult;
    expect(aiQaData.aiStatus).toBe('used');
    expect(aiQaData.tainted).toBe(true);
    expect(aiQaData.citations.map((c) => c.noteId)).toEqual([org1SharedLeaveNoteId]);
    expect(capturedQaPrompts.join('\n')).not.toContain('SECRET_PEER_TOKEN_991');
    expect(capturedQaPrompts.join('\n')).not.toContain('OWNER_SECRET_772');
    expect(capturedQaPrompts.join('\n')).not.toContain('35000000');

    // Rogue foreign citation returned by model is stripped/refused cleanly.
    nextQaMode = 'rogue_citation';
    const rogueRes = await rpc(
      appAiOn,
      'hr/self/policyQa',
      admin1,
      { question: 'Chính sách nghỉ phép năm?', lang: 'vi' },
      org1.slug,
    );
    expect(rogueRes.status).toBe(200);
    expect((rogueRes.body as unknown as HrSelfPolicyQaResult)).toMatchObject({
      notesAvailable: true,
      aiStatus: 'refused',
      tainted: false,
      answer: null,
    });
    expect((rogueRes.body as unknown as HrSelfPolicyQaResult).matches[0]?.noteId).toBe(org1SharedLeaveNoteId);
    expect((rogueRes.body as unknown as HrSelfPolicyQaResult).citations.map((c) => c.noteId)).not.toContain(
      rogueForeignNoteId,
    );
    expect((rogueRes.body as unknown as HrSelfPolicyQaResult).citations[0]?.noteId).toBe(org1SharedLeaveNoteId);
    nextQaMode = 'grounded';

    // Verify AI usage ledger recorded both `hr.request_draft` and `hr.policy_qa` under `hr`.
    const { rows: usageRows } = await adminPool.query<{ feature: string; module: string; calls: string }>(
      `SELECT feature, module, count(*)::text AS calls
         FROM ludy_kernel.org_usage
        WHERE org_id = $1
          AND metric = 'ai_cost'
          AND feature IN ('hr.request_draft', 'hr.policy_qa')
        GROUP BY feature, module
        ORDER BY feature`,
      [org1.orgId],
    );
    expect(usageRows).toEqual([
      { feature: 'hr.policy_qa', module: 'hr', calls: '2' },
      { feature: 'hr.request_draft', module: 'hr', calls: '1' },
    ]);

    // 5. Notes app disabled (`org_app_on(org_id, 'notes') = false`) returns clean `notes_off` without calling LLM.
    const callsBeforeNotesOff = capturedQaPrompts.length;
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'notes', enabled: false },
      { actor: { type: 'user', userId: owner1.userId, aal: 'aal2', sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) }, orgId: org1.orgId },
    );
    const notesOffRes = await rpc(
      appAiOn,
      'hr/self/policyQa',
      staffA,
      { question: 'Chính sách nghỉ phép năm?', lang: 'vi' },
      org1.slug,
    );
    expect(notesOffRes.status).toBe(200);
    expect(notesOffRes.body).toEqual({
      notesAvailable: false,
      aiStatus: 'notes_off',
      tainted: false,
      answer: null,
      citations: [],
      matches: [],
    });
    expect(capturedQaPrompts.length).toBe(callsBeforeNotesOff);

    // Re-enable notes and verify kill switch + exhausted budget degrade gracefully.
    await runtime.execute(
      'kernel.org.set_app',
      { module: 'notes', enabled: true },
      { actor: { type: 'user', userId: owner1.userId, aal: 'aal2', sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) }, orgId: org1.orgId },
    );
    await adminPool.query(
      `INSERT INTO ludy_kernel.kill_switch (org_id, scope, target, reason, engaged_by)
       VALUES ($1, 'module', 'hr', 'test pause', $2)`,
      [org1.orgId, owner1.userId],
    );
    const killedQa = await rpc(
      appAiOn,
      'hr/self/policyQa',
      staffA,
      { question: 'Chính sách nghỉ phép năm?', lang: 'vi' },
      org1.slug,
    );
    expect(killedQa.status).toBe(200);
    expect(killedQa.body).toMatchObject({ notesAvailable: true, aiStatus: 'off', answer: null });

    await adminPool.query(
      `UPDATE ludy_kernel.kill_switch
          SET released_at = now(), released_by = $2
        WHERE org_id = $1 AND released_at IS NULL`,
      [org1.orgId, owner1.userId],
    );
    await adminPool.query(
      `INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, hard_stop, updated_by)
       VALUES ($1, 'org', '*', 0.000001, true, $2)
       ON CONFLICT (org_id, scope, target) DO UPDATE SET monthly_limit = 0.000001, hard_stop = true`,
      [org1.orgId, owner1.userId],
    );
    const budgetedQa = await rpc(
      appAiOn,
      'hr/self/policyQa',
      staffA,
      { question: 'Chính sách nghỉ phép năm?', lang: 'vi' },
      org1.slug,
    );
    expect(budgetedQa.status).toBe(200);
    expect(budgetedQa.body).toMatchObject({ notesAvailable: true, aiStatus: 'budget', answer: null });
  });
});

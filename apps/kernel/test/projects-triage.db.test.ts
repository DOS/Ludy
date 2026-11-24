// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration suite for Issue #4493 Slice 2:
// Projects Triage Inbox, Vy AI (`projects.triage_assist`), MCP (`projects.mcp.triage_summary`),
// #2604 private-project non-linking, cross-module read checks, PDPL find/erase, offboarding export, and org_purge.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import type {
  ConversationEvent,
  ProjectTriageAcceptResult,
  ProjectTriageAssistResult,
  ProjectTriageItem,
  ProjectTriageListResult,
} from '@ludy/kernel-contract';
import { Runtime, type BlobStore } from '@ludy/kernel-runtime';
import { InboxReader } from '@ludy/agent';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { projectsCommands, projectsQueries, type ProjectTriageAssistSource } from '@ludy/mod-projects';
import { DraftBudget } from '../src/ai-draft-limit.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { orgPurgeCommand, runOrgPurge } from '../src/org-purge.ts';
import { prepareProjectTriageAssist, projectTriageAi } from '../src/project-triage-ai.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const JWT_SECRET = 'test-only-jwt-key-projects-triage-4493-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

const SYSTEM = { type: 'system' as const, component: 'triage-test' };
const shipped = ['projects', 'meetings', 'notes', 'crm', 'finance', 'hr', 'sign', 'ads', 'social'] as const;

suite('Projects Triage Inbox Slice 2 (#4493)', () => {
  const dbName = `crove_test_triage_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool | undefined;
  let workerPool: pg.Pool | undefined;
  let workerDb!: Db;
  let runtime!: Runtime;
  let workerRuntime!: Runtime;
  let httpApp!: ReturnType<typeof createHttpApp>;
  let spyAssistCalls = 0;

  let orgId = '';
  let orgSlug = '';
  let ownerUserId = '';
  let memberUserId = '';
  let outsiderUserId = '';
  let viewerUserId = '';
  let ownerPosId = '';
  let memberPosId = '';
  let outsiderPosId = '';
  let orgProjectId = '';
  let privateProjectId = '';
  let activeCycleId = '';
  let publicRoadmapBoardId = '';
  let publicSubmissionItemId = '';
  let privateRoadmapTestItemId = '';
  let dmConversationId = '';
  let attendeesMeetingId = '';
  let orgMeetingId = '';
  let mcpCompanyGrantId = '';
  let mcpMemberGrantId = '';

  const asOwner = () => ({ type: 'user' as const, userId: ownerUserId, sessionId: randomUUID(), aal: 'aal1' as const });
  const asOwnerMfa = () => ({ type: 'user' as const, userId: ownerUserId, sessionId: randomUUID(), aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });
  const asMember = () => ({ type: 'user' as const, userId: memberUserId, sessionId: randomUUID(), aal: 'aal1' as const });
  const asOutsider = () => ({ type: 'user' as const, userId: outsiderUserId, sessionId: randomUUID(), aal: 'aal1' as const });
  const asViewer = () => ({ type: 'user' as const, userId: viewerUserId, sessionId: randomUUID(), aal: 'aal1' as const });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'triage-app-pw', ludy_worker: 'triage-worker-pw' });

    const login = (u: string, pw: string) => {
      const url = new URL(adminUrl);
      url.username = u;
      url.password = pw;
      return url.toString();
    };

    appPool = createPool({ connectionString: login('ludy_app', 'triage-app-pw'), max: 6 });
    workerPool = createPool({ connectionString: login('ludy_worker', 'triage-worker-pw'), max: 3 });

    const appDb = createDb(appPool);
    workerDb = createDb(workerPool);

    const moduleDeps = {
      inboundDomain: null,
      apps: { shipped, deployment: shipped, entitlements: async () => ['full'] },
    };

    const noopStore: BlobStore = {
      put: async () => 'gen',
      get: async () => new Uint8Array(),
      delete: async () => undefined,
    };

    const appUrl = login('ludy_app', 'triage-app-pw');
    runtime = new Runtime(appDb, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'off' })
      .register({ commands: [...kernelCommands, ...meetingsCommands, ...projectsCommands], queries: [...kernelQueries(moduleDeps), ...meetingsQueries, ...projectsQueries] });

    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS })
      .register({ commands: [...kernelCommands, orgPurgeCommand({ store: noopStore }), ...meetingsCommands, ...projectsCommands], queries: [...kernelQueries(moduleDeps), ...meetingsQueries, ...projectsQueries] });

    const httpConfig = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: JWT_SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const spyReader = new InboxReader(
      { baseURL: 'http://127.0.0.1:0', model: 'mock', apiKey: null },
      {
        projectTriageAssist: async () => {
          spyAssistCalls += 1;
          return {
            output: {
              recommendedPriority: 'high',
              suggestedAssigneePositionId: memberPosId,
              suggestedCycleId: activeCycleId,
              duplicateTaskId: null,
              reason: 'Nên giao Kỹ sư chính xử lý trong chu kỳ hiện tại.',
            },
            usage: { inputTokens: 80, outputTokens: 25 },
          };
        },
      },
    );
    httpApp = createHttpApp({
      config: httpConfig,
      runtime,
      store: noopStore,
      authenticate: createAuthenticator(httpConfig, appDb),
      pool: appPool,
      aiEnabled: true,
      conversationReader: spyReader,
      billing: { entitlements: async () => ['full'] },
    });

    ownerUserId = await upsertIdentity(appDb, { issuer: ISSUER, subject: 'tr-owner', email: 'owner-tr@example.test', name: 'Anh Minh Triage' });
    memberUserId = await upsertIdentity(appDb, { issuer: ISSUER, subject: 'tr-member', email: 'member-tr@example.test', name: 'Chị Lan Triage' });
    outsiderUserId = await upsertIdentity(appDb, { issuer: ISSUER, subject: 'tr-outsider', email: 'outsider-tr@example.test', name: 'Ngoài dự án' });
    viewerUserId = await upsertIdentity(appDb, { issuer: ISSUER, subject: 'tr-viewer', email: 'viewer-tr@example.test', name: 'Người xem' });

    const org = await createOrg(runtime, asOwner(), 'Cong ty Triage SME');
    orgId = org.orgId;
    orgSlug = org.slug;

    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')
         ON CONFLICT DO NOTHING`,
        [orgId, memberUserId, outsiderUserId, viewerUserId],
      );
      mcpCompanyGrantId = randomUUID();
      mcpMemberGrantId = randomUUID();
      await c.query(
        `INSERT INTO ludy_kernel.agent_grant
           (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, revoked_at, created_by, kind, member_id)
         VALUES
           ($1, $2, $3, $4, 'Claude Triage Read', 'triage.example.com', ARRAY['ludy.read'], $5, now(), now() + interval '30 days', NULL, $3, 'company', NULL),
           ($1, $6, $7, $8, 'Member Triage Read', 'triage-m.example.com', ARRAY['ludy.read'], $9, now(), now() + interval '30 days', NULL, $7, 'member', $7)`,
        [
          orgId,
          mcpCompanyGrantId,
          ownerUserId,
          `triage-mcp-owner-${mcpCompanyGrantId}`,
          `oauth-${mcpCompanyGrantId}`,
          mcpMemberGrantId,
          memberUserId,
          `triage-mcp-member-${mcpMemberGrantId}`,
          `oauth-${mcpMemberGrantId}`,
        ],
      );
    });

    await admin(async (c) => {
      const p1 = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.position (org_id, title, module, role_key, holder_user_id) VALUES ($1, 'Giám đốc', 'kernel', 'owner', $2) RETURNING id`,
        [orgId, ownerUserId],
      );
      ownerPosId = p1.rows[0]!.id;
      const p2 = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.position (org_id, title, module, role_key, holder_user_id) VALUES ($1, 'Kỹ sư chính', 'kernel', 'member', $2) RETURNING id`,
        [orgId, memberUserId],
      );
      memberPosId = p2.rows[0]!.id;
      const p3 = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.position (org_id, title, module, role_key, holder_user_id) VALUES ($1, 'Vị trí ngoài dự án', 'kernel', 'member', $2) RETURNING id`,
        [orgId, outsiderUserId],
      );
      outsiderPosId = p3.rows[0]!.id;
    });

    orgProjectId = (
      await runtime.execute<{ projectId: string }>(
        'projects.project.create',
        { name: 'Dự án Công khai', memberUserIds: [ownerUserId, memberUserId] },
        { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
      )
    ).projectId;

    privateProjectId = (
      await runtime.execute<{ projectId: string }>(
        'projects.project.create',
        { name: 'Dự án Mật', visibility: 'private', memberUserIds: [ownerUserId] },
        { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
      )
    ).projectId;

    activeCycleId = (
      await runtime.execute<{ cycle: { id: string } }>(
        'projects.cycle.create',
        { projectId: orgProjectId, name: 'Tuần Triage 1' },
        { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
      )
    ).cycle.id;
    await runtime.execute(
      'projects.cycle.start',
      { projectId: orgProjectId, cycleId: activeCycleId },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );

    const boardRes = await runtime.execute<{ board: { id: string } }>(
      'projects.roadmap.board.create',
      { title: 'Lộ trình Công khai', slug: 'public-ideas', projectId: orgProjectId, enabled: true },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    publicRoadmapBoardId = boardRes.board.id;

    const rmInternal = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: publicRoadmapBoardId, publicTitle: 'Ý tưởng lộ trình công khai', publicSummary: 'Tóm tắt lộ trình' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    publicSubmissionItemId = rmInternal.item.id;
    // Flip one item to public_submission so we verify forced taint + private non-linking.
    const rmPriv = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: publicRoadmapBoardId, publicTitle: 'Đề xuất khách hàng bên ngoài', publicSummary: 'Cần xuất Excel' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    privateRoadmapTestItemId = rmPriv.item.id;
    await admin(async (c) => {
      await c.query(
        `UPDATE ludy_projects.roadmap_item
            SET source = 'public_submission', tainted = true
          WHERE org_id = $1 AND id IN ($2, $3)`,
        [orgId, publicSubmissionItemId, privateRoadmapTestItemId],
      );
    });

    // Seed a direct conversation (owned by memberUserId, restricted from unrelated members if private DM) & an attendees meeting.
    const connId = randomUUID();
    await admin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by)
         VALUES ($1, $2, 'sandbox', $3, 'Kênh Zalo', $4)`,
        [orgId, connId, `acct-${randomUUID().slice(0, 8)}`, ownerUserId],
      );
    });
    const events: ConversationEvent[] = [
      {
        kind: 'direct',
        threadId: 'tr-dm-1',
        messageId: 'tr-m-1',
        direction: 'in',
        contact: { id: 'cust-1', name: 'Khách Bình' },
        text: 'Anh Minh kiểm tra lại đơn gấp.',
        at: '2026-11-18T08:00:00.000Z',
      },
    ];
    await workerRuntime.execute('kernel.conversation.ingest', { connectionId: connId, events }, { actor: SYSTEM, orgId });
    await admin(async (c) => {
      const convRows = await c.query<{ id: string }>(
        `SELECT id FROM ludy_kernel.conversation WHERE org_id = $1 AND external_thread_id = 'tr-dm-1'`,
        [orgId],
      );
      dmConversationId = convRows.rows[0]!.id;
      await c.query(
        `UPDATE ludy_kernel.conversation SET assignee_user_id = $3 WHERE org_id = $1 AND id = $2`,
        [orgId, dmConversationId, ownerUserId],
      );
    });

    attendeesMeetingId = (
      await runtime.execute<{ meetingId: string }>(
        'meetings.meeting.create',
        { title: 'Họp mật khách VIP', consentMethod: 'told_at_start', visibility: 'attendees' },
        { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
      )
    ).meetingId;

    orgMeetingId = (
      await runtime.execute<{ meetingId: string }>(
        'meetings.meeting.create',
        { title: 'Họp toàn công ty quý 4', consentMethod: 'told_at_start', visibility: 'org' },
        { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
      )
    ).meetingId;
    await runtime.execute(
      'meetings.summary.save',
      { meetingId: orgMeetingId, summary: 'Tóm tắt họp toàn công ty', decisions: ['Duyệt triage'] },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'meetings.result.publish',
      { meetingId: orgMeetingId, confirmed: true },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
  }, 60_000);

  async function callAssistRpc(subject: string, email: string, itemId: string): Promise<{ status: number; body: ProjectTriageAssistResult }> {
    const token = await new SignJWT({
      role: 'authenticated',
      email,
      session_id: randomUUID(),
      aal: 'aal1',
      is_anonymous: false,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(JWT_SECRET));
    const response = await httpApp.request('/api/rpc/projects/triage/assist', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-crove-org': orgSlug,
      },
      body: JSON.stringify({ json: { itemId, language: 'vi' } }),
    });
    const parsed = (await response.json()) as { json?: ProjectTriageAssistResult } & ProjectTriageAssistResult;
    return { status: response.status, body: ('json' in parsed && parsed.json ? parsed.json : parsed) as ProjectTriageAssistResult };
  }

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (ADMIN) {
      const root = new pg.Client({ connectionString: ADMIN });
      await root.connect();
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await root.end();
    }
  });

  it('enforces create validation, cross-module source readability, and taint propagation', async () => {
    // Viewer refused with 403.
    await expect(
      runtime.execute(
        'projects.triage.create',
        { projectId: orgProjectId, sourceType: 'manual', sourceId: null, title: 'Không được phép' },
        { actor: asViewer(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Invalid (manual, sourceId) pair refused.
    await expect(
      runtime.execute(
        'projects.triage.create',
        { projectId: orgProjectId, sourceType: 'manual', sourceId: randomUUID(), title: 'Sai cặp' },
        { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ status: 422 });

    // Non-attendee cannot ingest someone else's attendees-only meeting into triage.
    await expect(
      runtime.execute(
        'projects.triage.create',
        { projectId: orgProjectId, sourceType: 'meetings.meeting', sourceId: attendeesMeetingId, title: 'Đọc lén họp' },
        { actor: asMember(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'MEETING_NOT_FOUND', status: 404 });

    // Owner CAN create triage items from attendees meeting & conversation (forced tainted = true).
    const fromMeeting = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'meetings.meeting', sourceId: attendeesMeetingId, title: 'Việc từ cuộc họp', priority: 'high' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    expect(fromMeeting.item.tainted).toBe(true);
    expect(fromMeeting.item.sourceType).toBe('meetings.meeting');

    const fromConv = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'kernel.conversation', sourceId: dmConversationId, title: 'Hỏi từ Khách Bình', priority: 'urgent' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    expect(fromConv.item.tainted).toBe(true);
    expect(fromConv.item.sourceType).toBe('kernel.conversation');

    // Manual item defaults tainted: false.
    const manual = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'manual', sourceId: null, title: 'Mục thủ công nội bộ', description: 'Ghi chú Anh Minh' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    expect(manual.item.tainted).toBe(false);
  });

  it('supports accept (canonical lock order, member seat guard, non-private roadmap link), merge, snooze/reopen, decline, and terminal guards', async () => {
    // 1. Accept roadmap item on public project -> creates tainted task, attaches to project + cycle, sets linked_task_id.
    const rmTriage = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'roadmap.item', sourceId: publicSubmissionItemId, title: 'Khách yêu cầu tích hợp hóa đơn', priority: 'high' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    expect(rmTriage.item.tainted).toBe(true);

    // Assigning outsider seat (not in project_member) must fail with 422 and roll back atomically!
    const beforeRejectCounts = await admin(async (c) => {
      const pt = (
        await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ludy_projects.project_task WHERE org_id = $1 AND project_id = $2`, [orgId, orgProjectId])
      ).rows[0]!;
      const lt = (
        await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ludy_kernel.task WHERE org_id = $1 AND source_ref = $2::jsonb`, [
          orgId,
          JSON.stringify({ type: 'projects.roadmap_item', id: publicSubmissionItemId }),
        ])
      ).rows[0]!;
      return { projectTasks: Number(pt.n), linkedTasks: Number(lt.n) };
    });

    await expect(
      runtime.execute(
        'projects.triage.accept',
        { itemId: rmTriage.item.id, assigneePositionId: outsiderPosId },
        { actor: asMember(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });

    await admin(async (c) => {
      const pti = (
        await c.query<{ status: string; accepted_task_id: string | null }>(
          `SELECT status, accepted_task_id FROM ludy_projects.project_triage_item WHERE org_id = $1 AND id = $2`,
          [orgId, rmTriage.item.id],
        )
      ).rows[0]!;
      expect(pti).toEqual({ status: 'pending', accepted_task_id: null });

      const pt = (
        await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ludy_projects.project_task WHERE org_id = $1 AND project_id = $2`, [orgId, orgProjectId])
      ).rows[0]!;
      const lt = (
        await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ludy_kernel.task WHERE org_id = $1 AND source_ref = $2::jsonb`, [
          orgId,
          JSON.stringify({ type: 'projects.roadmap_item', id: publicSubmissionItemId }),
        ])
      ).rows[0]!;
      expect(Number(pt.n)).toBe(beforeRejectCounts.projectTasks);
      expect(Number(lt.n)).toBe(beforeRejectCounts.linkedTasks);
    });

    // Valid accept with member seat + cycle.
    const accepted = await runtime.execute<ProjectTriageAcceptResult>(
      'projects.triage.accept',
      { itemId: rmTriage.item.id, assigneePositionId: memberPosId, cycleId: activeCycleId, priority: 'urgent' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    expect(accepted.item.status).toBe('accepted');
    expect(accepted.item.acceptedTaskId).toBe(accepted.taskId);

    await admin(async (c) => {
      const taskRow = (await c.query<{ tainted: boolean; source_ref: { type: string; id: string } }>(`SELECT tainted, source_ref FROM ludy_kernel.task WHERE org_id = $1 AND id = $2`, [orgId, accepted.taskId])).rows[0]!;
      expect(taskRow.tainted).toBe(true);
      expect(taskRow.source_ref).toEqual({ type: 'projects.roadmap_item', id: publicSubmissionItemId });

      const rmRow = (await c.query<{ linked_task_id: string | null }>(`SELECT linked_task_id FROM ludy_projects.roadmap_item WHERE org_id = $1 AND id = $2`, [orgId, publicSubmissionItemId])).rows[0]!;
      expect(rmRow.linked_task_id).toBe(accepted.taskId);
    });

    // Double accept -> 409 TRIAGE_ALREADY_RESOLVED; Reopen terminal accepted -> 409 TRIAGE_TERMINAL_STATE.
    await expect(
      runtime.execute('projects.triage.accept', { itemId: rmTriage.item.id }, { actor: asMember(), orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'TRIAGE_ALREADY_RESOLVED', status: 409 });
    await expect(
      runtime.execute('projects.triage.reopen', { itemId: rmTriage.item.id }, { actor: asMember(), orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'TRIAGE_TERMINAL_STATE', status: 409 });

    // 2. Accept roadmap item inside PRIVATE project -> MUST NOT set public roadmap_item.linked_task_id (#2604)!
    const privRmTriage = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: privateProjectId, sourceType: 'roadmap.item', sourceId: privateRoadmapTestItemId, title: 'Xử lý bí mật', priority: 'high' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const privAccepted = await runtime.execute<ProjectTriageAcceptResult>(
      'projects.triage.accept',
      { itemId: privRmTriage.item.id, assigneePositionId: ownerPosId },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    expect(privAccepted.item.status).toBe('accepted');
    await admin(async (c) => {
      const rmRow = (await c.query<{ linked_task_id: string | null }>(`SELECT linked_task_id FROM ludy_projects.roadmap_item WHERE org_id = $1 AND id = $2`, [orgId, privateRoadmapTestItemId])).rows[0]!;
      expect(rmRow.linked_task_id).toBeNull();
    });

    // 3. Merge into existing project task; reject task from another project; reject terminal reopen.
    const toMerge = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'manual', sourceId: null, title: 'Việc trùng cần gộp' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      runtime.execute(
        'projects.triage.merge',
        { itemId: toMerge.item.id, targetTaskId: privAccepted.taskId },
        { actor: asMember(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });

    const merged = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.merge',
      { itemId: toMerge.item.id, targetTaskId: accepted.taskId },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    expect(merged.item.status).toBe('merged');
    expect(merged.item.mergedIntoTaskId).toBe(accepted.taskId);
    await expect(
      runtime.execute('projects.triage.reopen', { itemId: toMerge.item.id }, { actor: asMember(), orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'TRIAGE_TERMINAL_STATE', status: 409 });

    // 4. Snooze (past time rejected 422), Reopen snoozed, Decline (reason), Reopen declined.
    const snoozable = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'manual', sourceId: null, title: 'Mục tạm ẩn rồi mở lại' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      runtime.execute(
        'projects.triage.snooze',
        { itemId: snoozable.item.id, snoozedUntil: '2020-01-01T00:00:00.000Z' },
        { actor: asMember(), orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SNOOZE_TIME', status: 422 });

    const futureIso = new Date(Date.now() + 2 * 3600_000).toISOString();
    const snoozed = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.snooze',
      { itemId: snoozable.item.id, snoozedUntil: futureIso },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    expect(snoozed.item.status).toBe('snoozed');
    expect(snoozed.item.snoozeElapsed).toBe(false);

    // Move snoozed_until into the past to verify snoozeElapsed flag & count.
    await admin(async (c) => {
      await c.query(
        `UPDATE ludy_projects.project_triage_item SET snoozed_until = now() - interval '5 minutes' WHERE org_id = $1 AND id = $2`,
        [orgId, snoozable.item.id],
      );
    });
    const listElapsed = await runtime.query<ProjectTriageListResult>(
      'projects.triage.list',
      { projectId: orgProjectId, statuses: ['snoozed'] },
      { actor: asMember(), orgId },
    );
    expect(listElapsed.counts.snoozeElapsed).toBe(1);
    expect(listElapsed.items.find((i) => i.id === snoozable.item.id)?.snoozeElapsed).toBe(true);

    const declined = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.decline',
      { itemId: snoozable.item.id, declineReason: 'Anh Minh xác nhận chưa cần làm' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    expect(declined.item.status).toBe('declined');
    expect(declined.item.declineReason).toBe('Anh Minh xác nhận chưa cần làm');

    const reopened = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.reopen',
      { itemId: snoozable.item.id },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    expect(reopened.item.status).toBe('pending');
    expect(reopened.item.declineReason).toBeNull();
    expect(reopened.item.snoozedUntil).toBeNull();
  });

  it('enforces roadmap_item -> project lock ordering and archived/concurrent project guards on accept (#4631)', async () => {
    const waitForLock = async () => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const locked = await admin(async (c) => {
          const { rows } = await c.query<{ cnt: number }>(
            `SELECT count(*)::int AS cnt
               FROM pg_catalog.pg_stat_activity
              WHERE datname = pg_catalog.current_database()
                AND wait_event_type = 'Lock'
                AND pid <> pg_catalog.pg_backend_pid()`,
          );
          return (rows[0]?.cnt ?? 0) > 0;
        });
        if (locked) return true;
        await new Promise((r) => setTimeout(r, 15));
      }
      return false;
    };

    // 1. Archived project rejects projects.triage.accept on a roadmap-sourced item without creating a task or setting linked_task_id.
    const archProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Dự án lưu trữ kiểm thử accept', memberUserIds: [ownerUserId, memberUserId] },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const archRmItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: publicRoadmapBoardId, publicTitle: 'Ý tưởng dự án sắp lưu trữ' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const archTriage = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: archProj.projectId, sourceType: 'roadmap.item', sourceId: archRmItem.item.id, title: 'Triage trước khi lưu trữ' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute('projects.project.archive', { projectId: archProj.projectId }, { actor: asOwner(), orgId, idempotencyKey: randomUUID() });
    await expect(
      runtime.execute('projects.triage.accept', { itemId: archTriage.item.id }, { actor: asMember(), orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED', status: 409 });
    await admin(async (c) => {
      const rm = (await c.query<{ linked_task_id: string | null }>(`SELECT linked_task_id FROM ludy_projects.roadmap_item WHERE org_id = $1 AND id = $2`, [orgId, archRmItem.item.id])).rows[0]!;
      expect(rm.linked_task_id).toBeNull();
      const tasks = (
        await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ludy_kernel.task WHERE org_id = $1 AND source_ref = $2::jsonb`, [
          orgId,
          JSON.stringify({ type: 'projects.roadmap_item', id: archRmItem.item.id }),
        ])
      ).rows[0]!;
      expect(Number(tasks.n)).toBe(0);
    });

    // 2. Lock-order proof: while Tx A holds roadmap_item FOR UPDATE, projects.triage.accept waits on roadmap_item BEFORE acquiring project FOR SHARE.
    const lockProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Dự án kiểm tra thứ tự khóa', memberUserIds: [ownerUserId, memberUserId] },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const lockRmItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: publicRoadmapBoardId, publicTitle: 'Ý tưởng kiểm tra thứ tự khóa' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const lockTriage = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: lockProj.projectId, sourceType: 'roadmap.item', sourceId: lockRmItem.item.id, title: 'Triage kiểm tra thứ tự khóa' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );

    const cLockA = await appPool!.connect();
    const cLockProbe = await appPool!.connect();
    let acceptLockOutcome: Promise<{ ok: true; value: ProjectTriageAcceptResult } | { ok: false; err: unknown }> | undefined;
    try {
      await cLockA.query('BEGIN');
      await enterUser(cLockA, ownerUserId, orgId);
      await cLockA.query('SET LOCAL ROLE ludy_tenant');
      await cLockA.query(`UPDATE ludy_projects.roadmap_item SET public_title = public_title WHERE org_id = $1 AND id = $2`, [
        orgId,
        lockRmItem.item.id,
      ]);

      acceptLockOutcome = runtime
        .execute<ProjectTriageAcceptResult>(
          'projects.triage.accept',
          { itemId: lockTriage.item.id, assigneePositionId: memberPosId },
          { actor: asMember(), orgId, idempotencyKey: randomUUID() },
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, err }),
        );
      expect(await waitForLock()).toBe(true);

      // Because projectTriageAccept locks roadmap_item ahead of project FOR SHARE, project row is still unlocked here.
      await cLockProbe.query('BEGIN');
      await enterUser(cLockProbe, ownerUserId, orgId);
      await cLockProbe.query('SET LOCAL ROLE ludy_tenant');
      const probe = await cLockProbe.query<{ id: string }>(
        `SELECT id FROM ludy_projects.project WHERE org_id = $1 AND id = $2 FOR UPDATE NOWAIT`,
        [orgId, lockProj.projectId],
      );
      expect(probe.rows.map((r) => r.id)).toEqual([lockProj.projectId]);
      await cLockProbe.query('ROLLBACK');

      await cLockA.query('COMMIT');
    } catch (err) {
      await cLockA.query('ROLLBACK').catch(() => {});
      await cLockProbe.query('ROLLBACK').catch(() => {});
      await acceptLockOutcome;
      throw err;
    } finally {
      cLockA.release();
      cLockProbe.release();
    }
    const lockResult = await acceptLockOutcome!;
    if (!lockResult.ok) throw lockResult.err;
    const lockAccepted = lockResult.value;
    expect(lockAccepted.item.status).toBe('accepted');
    await admin(async (c) => {
      const rm = (await c.query<{ linked_task_id: string | null }>(`SELECT linked_task_id FROM ludy_projects.roadmap_item WHERE org_id = $1 AND id = $2`, [orgId, lockRmItem.item.id])).rows[0]!;
      expect(rm.linked_task_id).toBe(lockAccepted.taskId);
    });

    // 3. Concurrent archive during projects.triage.accept blocks on project FOR SHARE, then rejects 409 PROJECT_ARCHIVED with full rollback.
    const raceArchProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Dự án đua lưu trữ', memberUserIds: [ownerUserId, memberUserId] },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceArchRmItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: publicRoadmapBoardId, publicTitle: 'Ý tưởng đua lưu trữ' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const raceArchTriage = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: raceArchProj.projectId, sourceType: 'roadmap.item', sourceId: raceArchRmItem.item.id, title: 'Triage đua lưu trữ' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    const cArch = await appPool!.connect();
    let archOutcome: Promise<{ ok: true; value: ProjectTriageAcceptResult } | { ok: false; err: unknown }> | undefined;
    try {
      await cArch.query('BEGIN');
      await enterUser(cArch, ownerUserId, orgId);
      await cArch.query('SET LOCAL ROLE ludy_tenant');
      await cArch.query(`UPDATE ludy_projects.project SET status = 'archived' WHERE org_id = $1 AND id = $2`, [
        orgId,
        raceArchProj.projectId,
      ]);

      archOutcome = runtime
        .execute<ProjectTriageAcceptResult>(
          'projects.triage.accept',
          { itemId: raceArchTriage.item.id },
          { actor: asMember(), orgId, idempotencyKey: randomUUID() },
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, err }),
        );
      expect(await waitForLock()).toBe(true);
      await cArch.query('COMMIT');
    } catch (err) {
      await cArch.query('ROLLBACK').catch(() => {});
      await archOutcome;
      throw err;
    } finally {
      cArch.release();
    }
    expect(await archOutcome).toMatchObject({ ok: false, err: { code: 'PROJECT_ARCHIVED', status: 409 } });
    await admin(async (c) => {
      const pti = (await c.query<{ status: string; accepted_task_id: string | null }>(`SELECT status, accepted_task_id FROM ludy_projects.project_triage_item WHERE org_id = $1 AND id = $2`, [orgId, raceArchTriage.item.id])).rows[0]!;
      expect(pti).toEqual({ status: 'pending', accepted_task_id: null });
      const rm = (await c.query<{ linked_task_id: string | null }>(`SELECT linked_task_id FROM ludy_projects.roadmap_item WHERE org_id = $1 AND id = $2`, [orgId, raceArchRmItem.item.id])).rows[0]!;
      expect(rm.linked_task_id).toBeNull();
    });

    // 4. Concurrent org -> private flip during projects.triage.accept sees visibility = 'private' after FOR SHARE and skips setting roadmap_item.linked_task_id.
    const racePrivProj = await runtime.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Dự án đua chuyển riêng tư', memberUserIds: [ownerUserId, memberUserId] },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const racePrivRmItem = await runtime.execute<{ item: { id: string } }>(
      'projects.roadmap.item.create',
      { boardId: publicRoadmapBoardId, publicTitle: 'Ý tưởng đua riêng tư' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const racePrivTriage = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: racePrivProj.projectId, sourceType: 'roadmap.item', sourceId: racePrivRmItem.item.id, title: 'Triage đua riêng tư' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    const cPriv = await appPool!.connect();
    let privOutcome: Promise<{ ok: true; value: ProjectTriageAcceptResult } | { ok: false; err: unknown }> | undefined;
    try {
      await cPriv.query('BEGIN');
      await enterUser(cPriv, ownerUserId, orgId);
      await cPriv.query('SET LOCAL ROLE ludy_tenant');
      await cPriv.query(`UPDATE ludy_projects.project SET visibility = 'private' WHERE org_id = $1 AND id = $2`, [
        orgId,
        racePrivProj.projectId,
      ]);

      privOutcome = runtime
        .execute<ProjectTriageAcceptResult>(
          'projects.triage.accept',
          { itemId: racePrivTriage.item.id },
          { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (err: unknown) => ({ ok: false as const, err }),
        );
      expect(await waitForLock()).toBe(true);
      await cPriv.query('COMMIT');
    } catch (err) {
      await cPriv.query('ROLLBACK').catch(() => {});
      await privOutcome;
      throw err;
    } finally {
      cPriv.release();
    }
    const privResult = await privOutcome!;
    if (!privResult.ok) throw privResult.err;
    const privRaceAccepted = privResult.value;
    expect(privRaceAccepted.item.status).toBe('accepted');
    await admin(async (c) => {
      const rm = (await c.query<{ linked_task_id: string | null }>(`SELECT linked_task_id FROM ludy_projects.roadmap_item WHERE org_id = $1 AND id = $2`, [orgId, racePrivRmItem.item.id])).rows[0]!;
      expect(rm.linked_task_id).toBeNull();
    });
  });

  it('supports MCP triage_summary workflow, private-project exclusion, and decline_reason omission standalone', async () => {
    // Self-contained seed so this test passes standalone (-t).
    const mcpRm = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'roadmap.item', sourceId: publicSubmissionItemId, title: 'MCP roadmap item standalone', priority: 'high' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const mcpDeclined = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'manual', sourceId: null, title: 'MCP declined standalone' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.triage.decline',
      { itemId: mcpDeclined.item.id, declineReason: 'Lý do nội bộ tuyệt đối không lộ qua MCP' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const mcpPrivate = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: privateProjectId, sourceType: 'manual', sourceId: null, title: 'MCP private project hidden' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const mcpOrgMeet = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'meetings.meeting', sourceId: orgMeetingId, title: 'MCP org published meeting' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const mcpAttMeet = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'meetings.meeting', sourceId: attendeesMeetingId, title: 'MCP attendees meeting hidden' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );

    const mcpCompanyActor = {
      type: 'user' as const,
      userId: ownerUserId,
      aal: 'aal1' as const,
      mcp: { grantId: mcpCompanyGrantId, clientId: `triage-mcp-owner-${mcpCompanyGrantId}`, clientName: 'Claude Triage Read', scopes: ['ludy.read'], kind: 'company' as const },
    };
    const mcpMemberActor = {
      type: 'user' as const,
      userId: memberUserId,
      aal: 'aal1' as const,
      mcp: { grantId: mcpMemberGrantId, clientId: `triage-mcp-member-${mcpMemberGrantId}`, clientName: 'Member Triage Read', scopes: ['ludy.read'], kind: 'member' as const },
    };

    // Member grant rejected (enter_mcp_member_context / requireCompanyGrantor).
    await expect(
      runtime.query('projects.mcp.triage_summary', {}, { actor: mcpMemberActor, orgId }),
    ).rejects.toMatchObject({ status: 401 });

    // Private project rejected with 404.
    await expect(
      runtime.query('projects.mcp.triage_summary', { projectId: privateProjectId }, { actor: mcpCompanyActor, orgId }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });

    const summary = await runtime.query<{
      counts: { pending: number; snoozed: number; accepted: number; merged: number; declined: number; tainted: number };
      items: Array<{ id: string; projectId: string; declineReason?: unknown; sourceTrust: string; tainted: boolean }>;
    }>('projects.mcp.triage_summary', {}, { actor: mcpCompanyActor, orgId });

    const returnedIds = new Set(summary.items.map((i) => i.id));
    expect(returnedIds.has(mcpRm.item.id)).toBe(true);
    expect(returnedIds.has(mcpDeclined.item.id)).toBe(true);
    expect(returnedIds.has(mcpOrgMeet.item.id)).toBe(true);
    expect(returnedIds.has(mcpPrivate.item.id)).toBe(false);
    expect(returnedIds.has(mcpAttMeet.item.id)).toBe(false);
    expect(summary.items.every((i) => i.projectId !== privateProjectId)).toBe(true);
    expect(summary.items.every((i) => !('declineReason' in i))).toBe(true);
    expect(JSON.stringify(summary)).not.toContain('Lý do nội bộ tuyệt đối không lộ qua MCP');
    expect(summary.items.some((i) => i.id === mcpRm.item.id && i.tainted && i.sourceTrust === 'external')).toBe(true);
    expect(summary.items.some((i) => i.id === mcpDeclined.item.id && !i.tainted && i.sourceTrust === 'internal')).toBe(true);
  });

  it('supports Vy AI triage_assist with AI-off parity, valid proposal, and unsafe/hallucinated refusal', async () => {
    const itemRes = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'manual', sourceId: null, title: 'Tối ưu xuất báo cáo quý' },
      { actor: asMember(), orgId, idempotencyKey: randomUUID() },
    );
    const source = await runtime.query<ProjectTriageAssistSource>(
      'projects.triage_assist_source',
      { itemId: itemRes.item.id },
      { actor: asMember(), orgId },
    );
    expect(source.candidates.seats.some((s) => s.positionId === memberPosId)).toBe(true);
    expect(source.candidates.cycles.some((c) => c.cycleId === activeCycleId)).toBe(true);

    // 1. AI off -> returns { ai: 'off', proposal: null } while core triage remains operational.
    const offRes = await prepareProjectTriageAssist(projectTriageAi(null, new DraftBudget()), orgId, memberUserId, source, 'vi');
    expect(offRes).toEqual({ ai: 'off', proposal: null });

    // 2. Valid proposal from allowlisted seat & cycle; also confirm outsider cannot query private triage items.
    await expect(
      runtime.query('projects.triage.list', { projectId: privateProjectId }, { actor: asOutsider(), orgId }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });

    const goodReader = new InboxReader(
      { baseURL: 'http://127.0.0.1:0', model: 'mock', apiKey: null },
      {
        projectTriageAssist: async () => ({
          output: {
            recommendedPriority: 'high',
            suggestedAssigneePositionId: memberPosId,
            suggestedCycleId: activeCycleId,
            duplicateTaskId: null,
            reason: 'Nên giao Kỹ sư chính xử lý trong Tuần Triage 1.',
          },
          usage: { inputTokens: 120, outputTokens: 40 },
        }),
      },
    );
    const goodRes = await prepareProjectTriageAssist(
      projectTriageAi(goodReader, new DraftBudget()),
      orgId,
      memberUserId,
      source,
      'vi',
    );
    expect(goodRes.ai).toBe('used');
    expect(goodRes.proposal).toMatchObject({
      recommendedPriority: 'high',
      suggestedAssigneePositionId: memberPosId,
      suggestedCycleId: activeCycleId,
    });

    // 3. Hallucinated UUID refused cleanly.
    const badReader = new InboxReader(
      { baseURL: 'http://127.0.0.1:0', model: 'mock', apiKey: null },
      {
        projectTriageAssist: async () => ({
          output: {
            recommendedPriority: 'urgent',
            suggestedAssigneePositionId: randomUUID(),
            suggestedCycleId: null,
            duplicateTaskId: null,
            reason: 'Giao người ngoài.',
          },
        }),
      },
    );
    const refusedRes = await prepareProjectTriageAssist(
      projectTriageAi(badReader, new DraftBudget()),
      orgId,
      memberUserId,
      source,
      'vi',
    );
    expect(refusedRes).toEqual({ ai: 'refused', proposal: null });

    // 4. ADR-0041 §8: conversation items honor kernel.conversation.auto_draft_set = false via HTTP RPC.
    const convTriage = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      {
        projectId: orgProjectId,
        sourceType: 'kernel.conversation',
        sourceId: dmConversationId,
        title: 'Khách hỏi kiểm tra đơn hàng',
        description: 'Nội dung hội thoại nhạy cảm không được gửi khi auto_draft tắt.',
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const baselineCalls = spyAssistCalls;
    await runtime.execute(
      'kernel.conversation.auto_draft_set',
      { autoDraft: false },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    try {
      const blockedConv = await callAssistRpc('tr-owner', 'owner-tr@example.test', convTriage.item.id);
      expect(blockedConv.status).toBe(200);
      expect(blockedConv.body).toEqual({ ai: 'off', proposal: null });
      expect(spyAssistCalls).toBe(baselineCalls);

      // Manual item still works even with conversation auto_draft = false.
      const manualAllowed = await callAssistRpc('tr-owner', 'owner-tr@example.test', itemRes.item.id);
      expect(manualAllowed.status).toBe(200);
      expect(manualAllowed.body.ai).toBe('used');
      expect(spyAssistCalls).toBe(baselineCalls + 1);
    } finally {
      await runtime.execute(
        'kernel.conversation.auto_draft_set',
        { autoDraft: true },
        { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
      );
    }

    const enabledConv = await callAssistRpc('tr-owner', 'owner-tr@example.test', convTriage.item.id);
    expect(enabledConv.status).toBe(200);
    expect(enabledConv.body.ai).toBe('used');
    expect(spyAssistCalls).toBe(baselineCalls + 2);
  });

  it('covers PDPL find/erase (with accept lock-order parity), ADR-0047 offboarding export filtering, and org_purge cleanup standalone', async () => {
    const pdplEmail = 'minh.triage.pdpl@example.test';
    const pdplAcceptEmail = 'accept.after.erase@example.test';
    // Decline one item mentioning a PDPL probe email so title, description, and decline_reason are exercised.
    const pdItem = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      {
        projectId: orgProjectId,
        sourceType: 'manual',
        sourceId: null,
        title: `Duyệt ngân sách cho ${pdplEmail}`,
        description: `Liên hệ ${pdplEmail} tại phòng tài chính.`,
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.triage.decline',
      { itemId: pdItem.item.id, declineReason: `Yêu cầu từ ${pdplEmail} chuyển quý sau` },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );

    // Seed an item mentioning pdplAcceptEmail, erase it BEFORE accept, then accept and verify the created task carries NO erased PII!
    const preEraseAcceptItem = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      {
        projectId: orgProjectId,
        sourceType: 'manual',
        sourceId: null,
        title: `Hồ sơ ${pdplAcceptEmail} cần duyệt`,
        description: `Chi tiết liên hệ ${pdplAcceptEmail}`,
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );

    // Self-contained roadmap, conversation, org-meeting (exportable), and attendees-only meeting (excluded) rows.
    await runtime.execute(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'roadmap.item', sourceId: publicSubmissionItemId, title: 'Roadmap export row standalone' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'projects.triage.create',
      { projectId: orgProjectId, sourceType: 'kernel.conversation', sourceId: dmConversationId, title: 'Conversation export row standalone' },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );

    // ADR-0047 §2/§7: seed one org-meeting triage item (must export) and one attendees-only meeting triage item (must stay out).
    const orgMeetingTriage = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      {
        projectId: orgProjectId,
        sourceType: 'meetings.meeting',
        sourceId: orgMeetingId,
        title: 'Mục từ họp toàn công ty được xuất',
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    const attendeesMeetingTriage = await runtime.execute<{ item: ProjectTriageItem }>(
      'projects.triage.create',
      {
        projectId: orgProjectId,
        sourceType: 'meetings.meeting',
        sourceId: attendeesMeetingId,
        title: 'Mục mật từ họp attendees không được xuất',
      },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );

    const found = await runtime.execute<{ matches: Array<{ column: string; rowId: string }> }>(
      'kernel.personal_data.find',
      { value: pdplEmail },
      { actor: asOwner(), orgId },
    );
    expect(found.matches.some((m) => m.column === 'ludy_projects.project_triage_item.title' && m.rowId === pdItem.item.id)).toBe(true);
    expect(found.matches.some((m) => m.column === 'ludy_projects.project_triage_item.description' && m.rowId === pdItem.item.id)).toBe(true);
    expect(found.matches.some((m) => m.column === 'ludy_projects.project_triage_item.decline_reason' && m.rowId === pdItem.item.id)).toBe(true);

    const erased = await runtime.execute<{ erased: Array<{ column: string; rows: number }> }>(
      'kernel.personal_data.erase',
      { value: pdplEmail },
      { actor: asOwnerMfa(), orgId, idempotencyKey: randomUUID() },
    );
    expect(erased.erased.some((e) => e.column === 'ludy_projects.project_triage_item.title' && e.rows >= 1)).toBe(true);
    expect(erased.erased.some((e) => e.column === 'ludy_projects.project_triage_item.description' && e.rows >= 1)).toBe(true);
    expect(erased.erased.some((e) => e.column === 'ludy_projects.project_triage_item.decline_reason' && e.rows >= 1)).toBe(true);

    // Erase pdplAcceptEmail before accepting preEraseAcceptItem -> subsequent projects.triage.accept creates a redacted task.
    await runtime.execute(
      'kernel.personal_data.erase',
      { value: pdplAcceptEmail },
      { actor: asOwnerMfa(), orgId, idempotencyKey: randomUUID() },
    );
    const acceptedAfterErase = await runtime.execute<ProjectTriageAcceptResult>(
      'projects.triage.accept',
      { itemId: preEraseAcceptItem.item.id },
      { actor: asOwner(), orgId, idempotencyKey: randomUUID() },
    );
    await admin(async (c) => {
      const taskRow = (
        await c.query<{ title: string; description: string | null }>(
          `SELECT title, description FROM ludy_kernel.task WHERE org_id = $1 AND id = $2`,
          [orgId, acceptedAfterErase.taskId],
        )
      ).rows[0]!;
      expect(taskRow.title).not.toContain(pdplAcceptEmail);
      expect(taskRow.description ?? '').not.toContain(pdplAcceptEmail);
      expect(taskRow.title).toContain('[đã xóa]');
    });

    // Offboarding snapshot stream includes projects.project_triage_item but excludes attendees-only meeting rows.
    const exportedRows: Array<{ id: string; source_type: string; source_id: string | null }> = [];
    await workerRuntime.stream(
      'kernel.org.export.snapshot',
      { table: 'projects.project_triage_item' },
      { actor: { type: 'system', component: 'test' }, orgId },
      async (chunk: unknown) => {
        const batch = chunk as { lines?: string[] };
        for (const line of batch.lines ?? []) {
          exportedRows.push(JSON.parse(line) as { id: string; source_type: string; source_id: string | null });
        }
      },
    );
    const exportedIds = new Set(exportedRows.map((r) => r.id));
    expect(exportedIds.has(orgMeetingTriage.item.id)).toBe(true);
    expect(exportedIds.has(pdItem.item.id)).toBe(true);
    expect(exportedRows.some((r) => r.source_type === 'roadmap.item')).toBe(true);
    expect(exportedRows.some((r) => r.source_type === 'kernel.conversation')).toBe(true);
    expect(exportedIds.has(attendeesMeetingTriage.item.id)).toBe(false);
    expect(exportedRows.some((r) => r.source_type === 'meetings.meeting' && r.source_id === attendeesMeetingId)).toBe(false);

    // Org purge deletes all project_triage_item rows ahead of project_task and project cleanly.
    await admin(async (c) => {
      const dayMs = 24 * 60 * 60 * 1000;
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE ludy_kernel.tenant SET status = 'offboarding' WHERE org_id = $1`, [orgId]);
      await c.query('COMMIT');
      await c.query(
        `INSERT INTO ludy_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, input_sha256, detail)
         VALUES ($1, $2, 'user', $3, 'kernel.org.offboard', $4, 'ok', $5, '{}'),
                ($1, $6, 'system', NULL, 'kernel.org.export.record', $7, 'ok', $5, '{"format":"crove.org-export.v2","file_count":0}')`,
        [
          orgId,
          new Date(Date.now() - 40 * dayMs),
          ownerUserId,
          randomUUID(),
          '0'.repeat(64),
          new Date(Date.now() - 31 * dayMs),
          randomUUID(),
        ],
      );
    });
    const purgeCode = await runOrgPurge(
      { runtime: workerRuntime, minDays: 30, log: () => undefined, error: () => undefined },
      [orgSlug, '--reason', 'triage test purge'],
    );
    expect(purgeCode).toBe(0);

    await admin(async (c) => {
      const counts = (
        await c.query<{ t: string; p: string }>(
          `SELECT (SELECT count(*) FROM ludy_projects.project_triage_item WHERE org_id = $1)::text AS t,
                  (SELECT count(*) FROM ludy_projects.project WHERE org_id = $1)::text AS p`,
          [orgId],
        )
      ).rows[0]!;
      expect(counts).toEqual({ t: '0', p: '0' });
    });
  });
});

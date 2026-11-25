// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration tests for Ludy eSign Slice 3b (#3812):
//   - ludy_sign.envelope source_kind = 'project_acceptance' constraint + sign.envelope.by_source org isolation
//   - os.sign.acceptance.draft_summary end-to-end HTTP oRPC: 100% AI-off parity, no_tasks, metered 'sign.acceptance_draft'
//     usage recording under module 'sign', kill-switch stop, AI budget exhaustion, viewer 403, cross-org 404,
//     and le_scope entity-restricted completed task isolation.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InboxReader } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { buildKernelCommands, kernelQueries } from '@ludy/kernel';
import { Runtime, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { signCommands, signManifest, signQueries } from '@ludy/mod-sign';
import { memberMeter } from '../src/ai-meter.ts';
import { createAuthenticator } from '../src/auth.ts';
import { AVAILABLE_MODULES, loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const TEST_HMAC_KEY = 'x'.repeat(32);
const ISSUER = 'crove-auth';
const AI_PRICE = { inputPerMTok: '3', outputPerMTok: '15' };

const acceptancePdfFixture = (tag: string) =>
  Uint8Array.from(
    Buffer.from(
      `%PDF-1.4\n% acceptance-${tag}\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n`,
      'utf8',
    ),
  );

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

suite('eSign Slice 3b project acceptance handoff & Vy draft summary on PostgreSQL (#3812)', () => {
  const dbName = `ludy_test_sign_acceptance_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let runtime: Runtime;
  let appAiOn: ReturnType<typeof createHttpApp>;
  let appAiOff: ReturnType<typeof createHttpApp>;
  let appWithoutSign: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();

  const owner: Account = { subject: randomUUID(), email: 'owner@example.com', session: randomUUID(), userId: '' };
  const member: Account = { subject: randomUUID(), email: 'member@example.com', session: randomUUID(), userId: '' };
  const limitedMember: Account = { subject: randomUUID(), email: 'limited@example.com', session: randomUUID(), userId: '' };
  const viewer: Account = { subject: randomUUID(), email: 'viewer@example.com', session: randomUUID(), userId: '' };
  const outsider: Account = { subject: randomUUID(), email: 'outsider@example.com', session: randomUUID(), userId: '' };

  let org = { slug: '', orgId: '' };
  let otherOrg = { slug: '', orgId: '' };

  const asMfa = (who: Account) => ({
    type: 'user' as const,
    userId: who.userId,
    sessionId: who.session,
    aal: 'aal2' as const,
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account, options: { mfa?: boolean } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const mfa = options.mfa ? { aal: 'aal2', amr: [{ method: 'totp', timestamp: now }] } : {};
    return new SignJWT({
      role: 'authenticated',
      email: who.email,
      session_id: who.session,
      aal: 'aal1',
      is_anonymous: false,
      ...mfa,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(TEST_HMAC_KEY));
  }

  async function rpc(
    targetApp: ReturnType<typeof createHttpApp>,
    path: string,
    who: Account,
    input: unknown,
    slug: string | null = org.slug,
  ) {
    const response = await targetApp.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(who)}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-crove-org': slug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> };
  }

  async function uploadPdf(who: Account, bytes: Uint8Array, filename: string, slug = org.slug) {
    const form = new FormData();
    form.append('file', new File([Buffer.from(bytes)], filename, { type: 'application/pdf' }));
    form.append('purpose', 'sign_document');
    const res = await appAiOn.request('/api/files', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(who)}`, 'x-crove-org': slug },
      body: form,
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const appUrlObj = new URL(adminUrl);
    appUrlObj.username = 'ludy_app';
    appUrlObj.password = 'test-app-pw';
    const appUrl = appUrlObj.toString();

    pool = createPool({ connectionString: appUrl, max: 6 });
    db = createDb(pool);

    const kernelCmds = buildKernelCommands({ shippedModules: AVAILABLE_MODULES });
    const sharedQueries = [...kernelQueries({ inboundDomain: null }), ...projectsQueries, ...signQueries];
    runtime = new Runtime(db, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [...kernelCmds, ...projectsCommands, ...signCommands],
      queries: sharedQueries,
    });

    const rtWithoutSign = new Runtime(db, {
      manifests: TEST_MANIFESTS.filter((m) => m !== signManifest.tables),
      sessions: createSessionStatusSource('off'),
      stepUp: 'required',
    }).register({
      commands: [
        ...buildKernelCommands({ shippedModules: AVAILABLE_MODULES.filter((m) => m !== 'sign') }),
        ...projectsCommands,
      ],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });

    const config = loadConfig({
      DATABASE_URL: appUrl,
      AUTH_JWT_SECRET: TEST_HMAC_KEY,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const authenticate = createAuthenticator(config, db);
    const conversationReader = new InboxReader({
      baseURL: 'http://model.invalid/v1',
      apiKey: null,
      model: 'test-vy',
      maxRetries: 0,
    });

    appAiOn = createHttpApp({
      config,
      runtime,
      store,
      authenticate,
      pool,
      aiEnabled: true,
      conversationReader,
      aiMeter: (actor) => memberMeter(runtime, actor, { price: AI_PRICE }),
    });
    appAiOff = createHttpApp({ config, runtime, store, authenticate, pool, aiEnabled: false });
    appWithoutSign = createHttpApp({ config, runtime: rtWithoutSign, store, authenticate, pool, aiEnabled: false });

    for (const who of [owner, member, limitedMember, viewer, outsider]) {
      const me = await rpc(appAiOn, 'me/get', who, undefined, null);
      expect(me.status).toBe(200);
      who.userId = String(me.body.userId);
    }

    const created = await rpc(appAiOn, 'org/create', owner, { name: 'Công ty Nghiệm Thu Số', idempotencyKey: randomUUID() }, null);
    expect(created.status).toBe(200);
    org = { slug: String(created.body.slug), orgId: String(created.body.orgId) };

    for (const [who, role] of [
      [member, 'member'],
      [limitedMember, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const invite = await appAiOn.request('/api/rpc/org/invite', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await tokenFor(owner, { mfa: true })}`,
          'content-type': 'application/json',
          'x-crove-org': org.slug,
        },
        body: JSON.stringify({ json: { email: who.email, role } }),
      });
      expect(invite.status).toBe(200);
      const body = ((await invite.json()) as { json: { acceptPath: string } }).json;
      expect((await rpc(appAiOn, 'invites/accept', who, { token: body.acceptPath.split('#')[1] }, null)).status).toBe(200);
    }

    const other = await rpc(appAiOn, 'org/create', outsider, { name: 'Công ty Khác', idempotencyKey: randomUUID() }, null);
    expect(other.status).toBe(200);
    otherOrg = { slug: String(other.body.slug), orgId: String(other.body.orgId) };
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('creates source_kind = project_acceptance envelopes, resolves sign/envelope/by_source per org, and enforces CHECK constraint', async () => {
    const projRes = await rpc(appAiOn, 'projects/create', member, {
      name: 'Triển khai ERP Cửa Hàng Hoa',
      idempotencyKey: randomUUID(),
    });
    expect(projRes.status, JSON.stringify(projRes.body)).toBe(200);
    const projectId = String(projRes.body.projectId);

    const pdfBytes = acceptancePdfFixture('erp-cua-hang-hoa');
    const uploaded = await uploadPdf(member, pdfBytes, 'bien-ban-nghiem-thu.pdf');
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(200);
    const fileId = ((uploaded.body?.files as Array<{ fileId: string }>) ?? [])[0]?.fileId as string;

    const envRes = await rpc(appAiOn, 'sign/envelope/create', member, {
      title: 'Biên bản nghiệm thu - Triển khai ERP Cửa Hàng Hoa',
      sourceKind: 'project_acceptance',
      sourceId: projectId,
      sourceFileId: fileId,
      idempotencyKey: randomUUID(),
    });
    expect(envRes.status, JSON.stringify(envRes.body)).toBe(200);
    const envelopeId = String(envRes.body.envelopeId);

    const bySource = await rpc(appAiOn, 'sign/envelope/by_source', member, {
      sourceKind: 'project_acceptance',
      sourceIds: [projectId],
    });
    expect(bySource.status).toBe(200);
    expect(bySource.body.items).toMatchObject([
      {
        sourceId: projectId,
        envelopeId,
        status: 'draft',
      },
    ]);

    // Cross-org isolation: otherOrg sees zero envelopes for org's projectId.
    const otherBySource = await rpc(
      appAiOn,
      'sign/envelope/by_source',
      outsider,
      { sourceKind: 'project_acceptance', sourceIds: [projectId] },
      otherOrg.slug,
    );
    expect(otherBySource.status).toBe(200);
    expect(otherBySource.body.items).toEqual([]);

    // SQL CHECK constraint still rejects unknown source_kind values.
    await expect(
      admin((c) =>
        c.query(
          `UPDATE ludy_sign.envelope SET source_kind = 'unknown_kind' WHERE org_id = $1 AND id = $2`,
          [org.orgId, envelopeId],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('handles os.sign.acceptance.draft_summary across AI-off, no_tasks, metered used, le_scope, kill-switch, budget, viewer 403, and MODULE_OFF', async () => {
    // 1. MODULE_OFF returns 404 when sign is not installed.
    const modOff = await rpc(appWithoutSign, 'sign/acceptance/draft_summary', member, { projectId: randomUUID() });
    expect(modOff.status).toBe(404);

    // 2. Create project with 1 todo task first -> no_tasks when AI is on, off when AI is off.
    const projRes = await rpc(appAiOn, 'projects/create', owner, {
      name: 'Website Nội Thất Minh Long',
      memberUserIds: [member.userId, limitedMember.userId, viewer.userId],
      idempotencyKey: randomUUID(),
    });
    expect(projRes.status).toBe(200);
    const projectId = String(projRes.body.projectId);

    const todoTask = await rpc(appAiOn, 'projects/createTask', owner, {
      projectId,
      title: 'Công việc chưa hoàn thành không được đưa vào biên bản',
      assigneePositionId: null,
      idempotencyKey: randomUUID(),
    });
    expect(todoTask.status).toBe(200);

    const noTasksRes = await rpc(appAiOn, 'sign/acceptance/draft_summary', member, { projectId });
    expect(noTasksRes.status).toBe(200);
    expect(noTasksRes.body).toEqual({ status: 'no_tasks', bullets: [] });

    // Add 3 completed tasks in default legal entity + 1 completed task in restricted branchB entity.
    const doneIds: string[] = [];
    for (const title of [
      'Thiết kế giao diện danh mục sản phẩm nội thất',
      'Tích hợp đặt lịch tư vấn showroom trực tuyến',
      'Bàn giao tài khoản quản trị và hướng dẫn biên tập bài viết',
    ]) {
      const createdTask = await rpc(appAiOn, 'projects/createTask', owner, {
        projectId,
        title,
        assigneePositionId: null,
        idempotencyKey: randomUUID(),
      });
      expect(createdTask.status).toBe(200);
      const tid = String(createdTask.body.taskId);
      doneIds.push(tid);
      await runtime.execute(
        'kernel.task.set_status',
        { id: tid, status: 'done' },
        { actor: asMfa(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
      );
    }

    // Create a second legal entity (branchB) and restrict limitedMember to defaultEntity only.
    const branchBTaskTitle = 'Hạng mục riêng chi nhánh Đà Nẵng';
    const branchBTaskId = await admin(async (c) => {
      const defRow = await c.query<{ id: string }>(
        `SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default = true`,
        [org.orgId],
      );
      const defaultEntityId = defRow.rows[0]?.id as string;
      const insertedB = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.legal_entity (org_id, name, is_default, created_by) VALUES ($1, 'Chi nhánh Đà Nẵng', false, $2) RETURNING id`,
        [org.orgId, owner.userId],
      );
      const branchBId = insertedB.rows[0]?.id as string;
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, limitedMember.userId, defaultEntityId, owner.userId],
      );
      const insertedTask = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.task (org_id, title, status, source, created_by_type, legal_entity_id)
         VALUES ($1, $2, 'done', 'human', 'user', $3) RETURNING id`,
        [org.orgId, branchBTaskTitle, branchBId],
      );
      const tId = insertedTask.rows[0]?.id as string;
      await c.query(
        `INSERT INTO ludy_projects.project_task (org_id, project_id, task_id) VALUES ($1, $2, $3)`,
        [org.orgId, projectId, tId],
      );
      return tId;
    });
    expect(branchBTaskId).toBeTruthy();

    // 3. AI-off server returns status = 'off' with empty bullets (100% AI-off parity).
    const aiOffRes = await rpc(appAiOff, 'sign/acceptance/draft_summary', member, { projectId });
    expect(aiOffRes.status).toBe(200);
    expect(aiOffRes.body).toEqual({ status: 'off', bullets: [] });

    // 4. Viewer role is rejected with 403 FORBIDDEN; cross-org outsider gets 404 NOT_FOUND.
    const viewerRes = await rpc(appAiOn, 'sign/acceptance/draft_summary', viewer, { projectId });
    expect(viewerRes.status).toBe(403);

    const outsiderRes = await rpc(appAiOn, 'sign/acceptance/draft_summary', outsider, { projectId }, otherOrg.slug);
    expect(outsiderRes.status).toBe(404);

    // 5. Metered Vy call as entity-restricted limitedMember: prompt must NOT contain todo task OR branchB task!
    let capturedPrompt = '';
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedPrompt = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-db-test',
          object: 'chat.completion',
          created: 1,
          model: 'test-vy',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  bullets: [
                    { text: 'Hoàn thiện giao diện danh mục sản phẩm nội thất', taskIds: [doneIds[0]] },
                    { text: 'Tích hợp đặt lịch tư vấn showroom trực tuyến', taskIds: [doneIds[1]] },
                    { text: 'Bàn giao tài khoản quản trị và hướng dẫn biên tập', taskIds: [doneIds[2]] },
                  ],
                }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const usedRes = await rpc(appAiOn, 'sign/acceptance/draft_summary', limitedMember, { projectId, language: 'vi' });
    expect(usedRes.status, JSON.stringify(usedRes.body)).toBe(200);
    expect(usedRes.body).toEqual({
      status: 'used',
      bullets: [
        { text: 'Hoàn thiện giao diện danh mục sản phẩm nội thất', taskIds: [doneIds[0]], proposedByAi: true },
        { text: 'Tích hợp đặt lịch tư vấn showroom trực tuyến', taskIds: [doneIds[1]], proposedByAi: true },
        { text: 'Bàn giao tài khoản quản trị và hướng dẫn biên tập', taskIds: [doneIds[2]], proposedByAi: true },
      ],
    });
    expect(capturedPrompt).not.toContain('Công việc chưa hoàn thành');
    expect(capturedPrompt).not.toContain(branchBTaskTitle);
    expect(capturedPrompt).not.toContain(branchBTaskId);

    // Verify usage ledger recorded feature = 'sign.acceptance_draft' and module = 'sign'.
    const usageRows = await admin(async (c) =>
      (
        await c.query<{ feature: string; module: string; input_tokens: number; output_tokens: number }>(
          `SELECT feature, module, input_tokens, output_tokens
             FROM ludy_kernel.org_usage
            WHERE org_id = $1 AND metric = 'ai_cost'`,
          [org.orgId],
        )
      ).rows,
    );
    expect(usageRows).toEqual([
      {
        feature: 'sign.acceptance_draft',
        module: 'sign',
        input_tokens: 1000,
        output_tokens: 100,
      },
    ]);

    // 6. Exhausted AI budget (previous call spent 0.0045; setting monthlyLimit to 0.004 marks budget exhausted).
    await runtime.execute(
      'kernel.agent.budget.set',
      { scope: 'module', target: 'sign', monthlyLimit: '0.004' },
      { actor: asMfa(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    fetchMock.mockClear();
    const budgetRes = await rpc(appAiOn, 'sign/acceptance/draft_summary', member, { projectId });
    expect(budgetRes.status).toBe(200);
    expect(budgetRes.body).toEqual({ status: 'budget', bullets: [] });
    expect(fetchMock).not.toHaveBeenCalled();

    // Raise budget and trip module kill-switch -> returns status = 'off' with zero model calls.
    await runtime.execute(
      'kernel.agent.budget.set',
      { scope: 'module', target: 'sign', monthlyLimit: '10' },
      { actor: asMfa(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await runtime.execute(
      'kernel.agent.kill_switch.engage',
      { scope: 'module', target: 'sign', reason: 'Pause sign AI for audit' },
      { actor: asMfa(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const stoppedRes = await rpc(appAiOn, 'sign/acceptance/draft_summary', member, { projectId });
    expect(stoppedRes.status).toBe(200);
    expect(stoppedRes.body).toEqual({ status: 'off', bullets: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

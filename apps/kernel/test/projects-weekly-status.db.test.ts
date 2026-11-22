// SPDX-License-Identifier: AGPL-3.0-only
// Integration tests for Vy's weekly status of a project on PostgreSQL 17 (projects P6, #2597):
// 1) Deterministic counts (doneThisWeek, overdue, waiting, dueNextWeek) & visible task titles/comments via POST /api/rpc/projects/weeklyStatus.
// 2) le_scope isolation: restricted member never gets hidden-entity counts, titles or comments in output or AI prompt, while hiddenByEntityCount matches.
// 3) Private & shared crove_notes.note rows are NEVER read and never appear in deterministic output or the AI prompt.
// 4) Strict summaryNumbersOutside refusal when Vy invents an outside number, while counts remain intact.
// 5) Kill switches (projects module, org, global ai), hard-stop AI budget, AI off, viewer role, CROVE_MODULES 404, ADR-0053 org app gate, and zero DB writes.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { InboxReader } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries } from '@ludy/kernel';
import { CredentialVault, LocalDiskStore, Runtime, parseVaultKey } from '@ludy/kernel-runtime';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { createAuthenticator } from '../src/auth.ts';
import { memberMeter } from '../src/ai-meter.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-projects-weekly-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

interface Account {
  subject: string;
  email: string;
  session: string;
  userId: string;
}

const newAccount = (tag: string): Account => ({
  subject: `sub-${tag}-${randomUUID()}`,
  email: `${tag}-${randomUUID().slice(0, 8)}@weekly.test`,
  session: randomUUID(),
  userId: '',
});

const completion = (sentences: readonly string[]) => ({
  id: 'cmp-1',
  object: 'chat.completion',
  created: 1,
  model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ sentences }) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
});

suite('projects.weeklyStatus on PostgreSQL 17 (#2597)', () => {
  const dbName = `crove_test_proj_weekly_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let dir = '';

  const owner = newAccount('owner');
  const branchMember = newAccount('branch');
  const viewer = newAccount('viewer');
  const outsider = newAccount('outsider');

  let org = { orgId: '', slug: '' };
  let otherOrg = { orgId: '', slug: '' };
  let apps: {
    on: ReturnType<typeof createHttpApp>;
    off: ReturnType<typeof createHttpApp>;
    noProjects: ReturnType<typeof createHttpApp>;
  };

  let projectId = '';

  const asUser = (userId: string, sessionId = randomUUID()) => ({ type: 'user' as const, userId, sessionId, aal: 'aal1' as const });

  async function withAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function tokenFor(who: Account): Promise<string> {
    return new SignJWT({ role: 'authenticated', email: who.email, session_id: who.session, aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(who.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(
    path: string,
    who: Account | null,
    input: unknown,
    options: { slug?: string | null; app?: keyof typeof apps } = {},
  ) {
    const slug = options.slug === undefined ? org.slug : options.slug;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (who) headers.authorization = `Bearer ${await tokenFor(who)}`;
    if (slug) headers['x-crove-org'] = slug;
    const response = await apps[options.app ?? 'on'].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, any> };
  }

  function stubModel(sentences: readonly string[]) {
    const prompts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
        prompts.push(String(init?.body ?? ''));
        return new Response(JSON.stringify(completion(sentences)), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    return prompts;
  }

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    db = createDb(pool);

    dir = await mkdtemp(join(tmpdir(), 'crove-proj-weekly-'));
    const store = new LocalDiskStore(dir);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...projectsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    const noProjectsRt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: kernelCommands,
      queries: kernelQueries({ inboundDomain: null }),
    });

    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const reader = new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
    const meterFor = (actor: Parameters<typeof memberMeter>[1]) =>
      memberMeter(rt, actor, { price: { inputPerMTok: '100', outputPerMTok: '200' } });

    apps = {
      on: createHttpApp({
        config,
        runtime: rt,
        store,
        authenticate: createAuthenticator(config, db),
        pool,
        aiEnabled: true,
        aiMeter: meterFor,
        conversationReader: reader,
        channels: { broker: vault, sandbox: false },
      }),
      off: createHttpApp({
        config,
        runtime: rt,
        store,
        authenticate: createAuthenticator(config, db),
        pool,
        aiEnabled: false,
        aiMeter: meterFor,
        channels: { broker: vault, sandbox: false },
      }),
      noProjects: createHttpApp({
        config,
        runtime: noProjectsRt,
        store,
        authenticate: createAuthenticator(config, db),
        pool,
        aiEnabled: true,
        aiMeter: meterFor,
        conversationReader: reader,
        channels: { broker: vault, sandbox: false },
      }),
    };

    for (const acc of [owner, branchMember, viewer, outsider]) {
      const me = await rpc('me/get', acc, undefined, { slug: null });
      expect(me.status).toBe(200);
      acc.userId = me.body.userId as string;
    }

    const createdOrg = await createOrg(rt, asUser(owner.userId), 'Công ty Tuần');
    const createdOther = await createOrg(rt, asUser(outsider.userId), 'Công ty Khác');
    org = { orgId: createdOrg.orgId, slug: createdOrg.slug };
    otherOrg = { orgId: createdOther.orgId, slug: createdOther.slug };

    let defaultEntityId = '';
    let branchEntityId = '';
    let privateNoteId = '';
    let sharedNoteId = '';
    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`,
        [org.orgId, branchMember.userId, viewer.userId],
      );
      defaultEntityId = (
        await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [org.orgId])
      ).rows[0]!.id;
      branchEntityId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by)
           VALUES ($1, 'Chi nhánh Hà Nội', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]!.id;
      // Scope branchMember strictly to branchEntityId so defaultEntityId tasks are hidden by le_scope RLS.
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, branchMember.userId, branchEntityId, owner.userId],
      );

      // Private & shared notes that MUST NEVER be read or leaked by projects.weeklyStatus, even when linked to the project or its task.
      const noteRows = await c.query<{ id: string; visibility: string }>(
        `INSERT INTO crove_notes.note (org_id, author_user_id, visibility, title, body)
         VALUES
           ($1, $2, 'private', 'Secret Private Note 777', 'Nội dung bí mật 777 không được đọc'),
           ($1, $2, 'org', 'Shared Team Note 888', 'Ghi chú chung 888 không liên quan')
         RETURNING id, visibility`,
        [org.orgId, owner.userId],
      );
      privateNoteId = noteRows.rows.find((r) => r.visibility === 'private')!.id;
      sharedNoteId = noteRows.rows.find((r) => r.visibility === 'org')!.id;
    });

    const createdProject = await rt.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Quyết toán Quý 4' },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    projectId = createdProject.projectId;

    let oldDoneId = '';
    await withAdmin(async (c) => {
      const insertTask = async (
        title: string,
        status: string,
        entityId: string,
        dueOffsetSql: string | null,
        updatedOffsetSql = '0 days',
      ) => {
        const res = await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, status, source, created_by_type, legal_entity_id, due, created_at, updated_at)
           VALUES (
             $1,
             $2,
             $3,
             'human',
             'user',
             $4,
             CASE WHEN $5::text IS NULL THEN NULL ELSE pg_catalog.now() + $5::interval END,
             pg_catalog.now() - interval '15 days',
             pg_catalog.now() - $6::interval
           )
           RETURNING id`,
          [org.orgId, title, status, entityId, dueOffsetSql, updatedOffsetSql],
        );
        const taskId = res.rows[0]!.id;
        await c.query(
          `INSERT INTO crove_projects.project_task (org_id, project_id, task_id, added_by)
           VALUES ($1, $2, $3, $4)`,
          [org.orgId, projectId, taskId, owner.userId],
        );
        return taskId;
      };

      // Visible to branchMember (branchEntityId): 1 done this week, 1 overdue, 1 waiting, 1 due next week, 1 old done, 1 cancelled.
      const doneBranch = await insertTask('Chốt bảng lương chi nhánh', 'done', branchEntityId, '-1 day', '2 days');
      await insertTask('Gửi tờ khai thuế 15', 'in_progress', branchEntityId, '-2 days');
      await insertTask('Chờ khách xác nhận biên bản', 'waiting', branchEntityId, null);
      await insertTask('Đối chiếu công nợ tuần tới', 'todo', branchEntityId, '3 days');
      oldDoneId = await insertTask('Việc xong từ tháng trước', 'done', branchEntityId, '-20 days', '12 days');
      await insertTask('Việc đã hủy bỏ', 'cancelled', branchEntityId, '2 days');

      // Record kernel.task.set_status audit events matching actual completion times: doneBranch 2 days ago, oldDone 12 days ago.
      await c.query(
        `INSERT INTO crove_kernel.audit_event (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
         VALUES
           ($1, pg_catalog.now() - interval '2 days', 'user', $2, 'kernel.task.set_status', $3, 'ok', 'kernel.task', $4::uuid, repeat('a', 64), jsonb_build_object('task', $4::text, 'status', 'done')),
           ($1, pg_catalog.now() - interval '12 days', 'user', $2, 'kernel.task.set_status', $5, 'ok', 'kernel.task', $6::uuid, repeat('b', 64), jsonb_build_object('task', $6::text, 'status', 'done'))`,
        [org.orgId, owner.userId, randomUUID(), doneBranch, randomUUID(), oldDoneId],
      );

      await c.query(
        `INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type, author_id, tainted, created_at)
         VALUES
           ($1, $2, 'Đã bàn giao bảng lương sạch', 'user', $3, false, pg_catalog.now() - interval '2 hours'),
           ($1, $2, 'Nội dung tainted không nên đưa làm trích dẫn chính', 'user', $3, true, pg_catalog.now() - interval '1 hour')`,
        [org.orgId, doneBranch, owner.userId],
      );

      // Link both the private note (to the project) and the shared note (to doneBranch task) via crove_notes.link (#2595).
      await c.query(
        `INSERT INTO crove_notes.link (org_id, note_id, target_type, target_id, task_id, created_by)
         VALUES
           ($1, $2, 'projects.project', $3, NULL, $5),
           ($1, $4, 'kernel.task', $6, $6, $5)`,
        [org.orgId, privateNoteId, projectId, sharedNoteId, owner.userId, doneBranch],
      );

      // Hidden from branchMember (defaultEntityId): 1 overdue + 1 waiting.
      const hiddenOverdue = await insertTask('Bí mật đơn vị A quá hạn', 'todo', defaultEntityId, '-1 day');
      await insertTask('Bí mật đơn vị A đang chờ', 'waiting', defaultEntityId, null);
      await c.query(
        `INSERT INTO crove_kernel.task_comment (org_id, task_id, body, author_type, author_id, tainted)
         VALUES ($1, $2, 'Bình luận bí mật A', 'user', $3, false)`,
        [org.orgId, hiddenOverdue, owner.userId],
      );
    });

    // Simulate editing the title of last month's completed task today via kernel.task.update (bumping updated_at to now):
    // doneThisWeek must NOT recount it because its transition to 'done' was 12 days ago.
    await rt.execute(
      'kernel.task.update',
      { id: oldDoneId, title: 'Việc xong từ tháng trước đã sửa tên' },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await withAdmin(async (c) => {
      await c.query(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = engaged_by WHERE org_id = $1 AND released_at IS NULL`, [org.orgId]);
      await c.query(`DELETE FROM crove_kernel.budget_policy WHERE org_id = $1`, [org.orgId]);
      await c.query(`SELECT crove_kernel.global_kill_switch_set('ai', false, 'test', 'reset')`);
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (ADMIN) {
      const root = new pg.Client({ connectionString: ADMIN });
      await root.connect();
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await root.end();
    }
  });

  it('computes exact counts, reads tasks/comments only (never notes), meters projects.weekly_status, and writes nothing', async () => {
    const prompts = stubModel([
      'Tuần này dự án Quyết toán Quý 4 đã xong 1 việc là Chốt bảng lương chi nhánh.',
      'Hiện có 2 việc quá hạn và 2 việc đang chờ cần xử lý sớm.',
      'Trong tuần tới có 1 việc đến hạn là Đối chiếu công nợ tuần tới.',
    ]);

    const snapshot = async () =>
      withAdmin(async (c) => ({
        projects: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_projects.project WHERE org_id = $1', [org.orgId])).rows[0]!.n),
        projectTasks: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_projects.project_task WHERE org_id = $1', [org.orgId])).rows[0]!.n),
        tasks: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.task WHERE org_id = $1', [org.orgId])).rows[0]!.n),
        notes: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_notes.note WHERE org_id = $1', [org.orgId])).rows[0]!.n),
        mails: Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.mail_message WHERE org_id = $1', [org.orgId])).rows[0]!.n),
      }));

    const before = await snapshot();
    const res = await rpc('projects/weeklyStatus', owner, { projectId, language: 'vi' });
    const after = await snapshot();

    expect(res.status).toBe(200);
    expect(res.body.ai).toBe('used');
    expect(res.body.window.timeZone).toBe('Asia/Ho_Chi_Minh');
    expect(res.body.window.nextFrom > res.body.window.to).toBe(true);
    const prevSpanDays = Math.round((Date.parse(`${res.body.window.to}T00:00:00Z`) - Date.parse(`${res.body.window.from}T00:00:00Z`)) / 86_400_000) + 1;
    const nextSpanDays = Math.round((Date.parse(`${res.body.window.nextTo}T00:00:00Z`) - Date.parse(`${res.body.window.nextFrom}T00:00:00Z`)) / 86_400_000) + 1;
    expect(prevSpanDays).toBe(7);
    expect(nextSpanDays).toBe(7);
    expect(res.body.counts).toEqual({
      totalVisible: 7,
      doneThisWeek: 1,
      overdue: 2,
      waiting: 2,
      dueNextWeek: 1,
    });
    expect(res.body.hiddenByEntityCount).toBe(0);
    expect(res.body.sentences).toHaveLength(3);
    expect(res.body.tasks.doneThisWeek[0]).toMatchObject({
      title: 'Chốt bảng lương chi nhánh',
      tainted: false,
      commentCount: 2,
      latestComment: 'Đã bàn giao bảng lương sạch',
    });

    // Verify private and shared notes are NEVER included in response or AI prompt.
    expect(prompts).toHaveLength(1);
    const promptBody = prompts[0]!;
    expect(promptBody).toContain('Chốt bảng lương chi nhánh');
    expect(promptBody).toContain('Đã bàn giao bảng lương sạch');
    expect(promptBody).not.toContain('Secret Private Note 777');
    expect(promptBody).not.toContain('Shared Team Note 888');
    expect(promptBody).not.toContain('Nội dung bí mật 777');
    expect(promptBody).not.toContain('Nội dung tainted');
    expect(JSON.stringify(res.body)).not.toContain('Secret Private Note 777');
    expect(JSON.stringify(res.body)).not.toContain('Shared Team Note 888');
    expect(JSON.stringify(res.body)).not.toContain('Việc xong từ tháng trước');

    // Verify nothing was created/stored in project, tasks, notes, or mail.
    expect(after).toEqual(before);

    // Verify usage recorded in crove_kernel.org_usage under feature projects.weekly_status.
    const usageRows = await withAdmin(async (c) =>
      (
        await c.query<{ feature: string; module: string; input_tokens: number; output_tokens: number }>(
          `SELECT feature, module, input_tokens, output_tokens FROM crove_kernel.org_usage WHERE org_id = $1 AND feature = 'projects.weekly_status'`,
          [org.orgId],
        )
      ).rows,
    );
    expect(usageRows).toEqual([{ feature: 'projects.weekly_status', module: 'projects', input_tokens: 120, output_tokens: 60 }]);
  });

  it('enforces le_scope isolation in both deterministic counts and AI prompt while reporting hiddenByEntityCount', async () => {
    const prompts = stubModel([
      'Tuần này dự án Quyết toán Quý 4 hoàn thành 1 việc là Chốt bảng lương chi nhánh.',
      'Hiện có 1 việc quá hạn là Gửi tờ khai thuế 15 và 1 việc đang chờ.',
      'Tuần tới có 1 việc đến hạn là Đối chiếu công nợ tuần tới.',
    ]);

    const res = await rpc('projects/weeklyStatus', branchMember, { projectId, language: 'vi' });
    expect(res.status).toBe(200);
    expect(res.body.ai).toBe('used');
    expect(res.body.counts).toEqual({
      totalVisible: 5,
      doneThisWeek: 1,
      overdue: 1,
      waiting: 1,
      dueNextWeek: 1,
    });
    expect(res.body.hiddenByEntityCount).toBe(2);

    const payloadJson = JSON.stringify(res.body);
    expect(payloadJson).toContain('Gửi tờ khai thuế 15');
    expect(payloadJson).not.toContain('Bí mật đơn vị A');
    expect(payloadJson).not.toContain('Bình luận bí mật A');

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Overdue open tasks: 1');
    expect(prompts[0]).not.toContain('Bí mật đơn vị A');
    expect(prompts[0]).not.toContain('Bình luận bí mật A');
    expect(prompts[0]).not.toContain('Secret Private Note 777');
    expect(prompts[0]).not.toContain('Shared Team Note 888');
  });

  it('refuses Vy output via summaryNumbersOutside when any outside number appears while still returning counts', async () => {
    stubModel([
      'Tuần này dự án đã đạt 99% tiến độ với 1 việc hoàn thành.',
      'Hiện có 2 việc quá hạn và 2 việc đang chờ.',
      'Tuần tới có 1 việc đến hạn.',
    ]);

    const res = await rpc('projects/weeklyStatus', owner, { projectId, language: 'vi' });
    expect(res.status).toBe(200);
    expect(res.body.ai).toBe('refused');
    expect(res.body.sentences).toEqual([]);
    expect(res.body.counts).toEqual({
      totalVisible: 7,
      doneThisWeek: 1,
      overdue: 2,
      waiting: 2,
      dueNextWeek: 1,
    });
  });

  it('degrades without calling the model on AI off, viewer role, kill switches, and budget exhaustion', async () => {
    const prompts = stubModel([
      'Tuần này hoàn thành 1 việc.',
      'Có 2 việc quá hạn và 2 việc đang chờ.',
      'Tuần tới có 1 việc đến hạn.',
    ]);

    // 1. Deployment AI off
    const offRes = await rpc('projects/weeklyStatus', owner, { projectId }, { app: 'off' });
    expect(offRes.status).toBe(200);
    expect(offRes.body.ai).toBe('off');
    expect(offRes.body.sentences).toEqual([]);
    expect(offRes.body.counts.overdue).toBe(2);
    expect(prompts).toHaveLength(0);

    // 2. Viewer role
    const viewerRes = await rpc('projects/weeklyStatus', viewer, { projectId });
    expect(viewerRes.status).toBe(200);
    expect(viewerRes.body.ai).toBe('forbidden');
    expect(viewerRes.body.counts.doneThisWeek).toBe(1);
    expect(prompts).toHaveLength(0);

    // 3. Projects module kill switch
    await withAdmin((c) =>
      c.query(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'module', 'projects', $2)`, [org.orgId, owner.userId]),
    );
    const modPaused = await rpc('projects/weeklyStatus', owner, { projectId });
    expect(modPaused.status).toBe(200);
    expect(modPaused.body.ai).toBe('paused');
    expect(modPaused.body.counts.waiting).toBe(2);
    expect(prompts).toHaveLength(0);

    // 4. Org kill switch
    await withAdmin(async (c) => {
      await c.query(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = engaged_by WHERE org_id = $1 AND released_at IS NULL`, [org.orgId]);
      await c.query(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, 'org', '*', $2)`, [org.orgId, owner.userId]);
    });
    const orgPaused = await rpc('projects/weeklyStatus', owner, { projectId });
    expect(orgPaused.status).toBe(200);
    expect(orgPaused.body.ai).toBe('paused');
    expect(prompts).toHaveLength(0);

    // 5. Global AI kill switch
    await withAdmin(async (c) => {
      await c.query(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = engaged_by WHERE org_id = $1 AND released_at IS NULL`, [org.orgId]);
      await c.query(`SELECT crove_kernel.global_kill_switch_set('ai', true, 'test', 'pause ai')`);
    });
    const globalPaused = await rpc('projects/weeklyStatus', owner, { projectId });
    expect(globalPaused.status).toBe(200);
    expect(globalPaused.body.ai).toBe('paused');
    expect(prompts).toHaveLength(0);

    // 6. Hard-stop AI budget on projects
    await withAdmin(async (c) => {
      await c.query(`SELECT crove_kernel.global_kill_switch_set('ai', false, 'test', 'resume ai')`);
      await c.query(
        `INSERT INTO crove_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by)
         VALUES ($1, 'module', 'projects', 0, 80, true, $2)`,
        [org.orgId, owner.userId],
      );
    });
    const budgetRes = await rpc('projects/weeklyStatus', owner, { projectId });
    expect(budgetRes.status).toBe(200);
    expect(budgetRes.body.ai).toBe('budget');
    expect(budgetRes.body.counts.dueNextWeek).toBe(1);
    expect(prompts).toHaveLength(0);
  });

  it('enforces unauthenticated 401, cross-org 404, CROVE_MODULES 404, and ADR-0053 per-org app gate', async () => {
    const unauth = await rpc('projects/weeklyStatus', null, { projectId });
    expect(unauth.status).toBe(401);

    const crossOrg = await rpc('projects/weeklyStatus', outsider, { projectId }, { slug: otherOrg.slug });
    expect(crossOrg.status).toBe(404);

    const noMod = await rpc('projects/weeklyStatus', owner, { projectId }, { app: 'noProjects' });
    expect(noMod.status).toBe(404);

    // ADR-0053: disable projects for org -> denied; re-enable -> succeeds.
    await rt.execute(
      'kernel.org.set_app',
      { module: 'projects', enabled: false },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const gateClosed = await rpc('projects/weeklyStatus', owner, { projectId });
    expect(gateClosed.status).toBe(404);

    await rt.execute(
      'kernel.org.set_app',
      { module: 'projects', enabled: true },
      { actor: asUser(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const gateOpen = await rpc('projects/weeklyStatus', owner, { projectId }, { app: 'off' });
    expect(gateOpen.status).toBe(200);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Real PostgreSQL 17 integration tests for project templates and recurring tasks (#2607):
// 1) Built-in starter templates + custom org templates + atomic create_from_template with shifted due dates.
// 2) le_scope isolation when saving a project as an org-visible template (hidden entity tasks never copied).
// 3) is_template isolation from projects list/get/board/today/weekly_status + DB triggers preventing live tasks on templates.
// 4) Weekly & monthly (including monthDay: -1) task recurrence, until/times limits, idempotent worker sweep, agent wakeup.
// 5) Org app-off gating (CROVE / org.app.set), cross-org isolation, viewer/agent blocks, HTTP RPC parity, and PDPL find/erase.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type {
  PersonalDataErasure,
  PersonalDataResult,
  ProjectBoard,
  ProjectCreateFromTemplateResult,
  ProjectListResult,
  ProjectTaskRecurrenceView,
  ProjectTemplateListResult,
} from '@ludy/kernel-contract';
import { Runtime, type AgentActor, type BlobStore, sha256Hex } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { sweepProjectsRecurring } from '../src/projects-recurring-worker.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-projects-2607-0123456789';
const ISSUER = 'crove-auth';
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

suite('projects templates & recurring tasks on PostgreSQL (#2607)', () => {
  const dbName = `ludy_test_proj2607_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let workerRt: Runtime;
  let app: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  async function newPerson(tag: string) {
    const subject = randomUUID();
    const email = `${tag}-${randomUUID().slice(0, 8)}@proj2607.test`;
    const userId = await upsertIdentity(db, { issuer: ISSUER, subject, email, name: `User ${tag}` });
    return { subject, email, userId };
  }

  async function tokenFor(person: { subject: string; email: string }) {
    return new SignJWT({ role: 'authenticated', email: person.email, session_id: randomUUID(), aal: 'aal1', is_anonymous: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(person.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(
    path: string,
    person: { subject: string; email: string },
    input: unknown,
    orgSlug?: string,
  ) {
    const response = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(person)}`,
        'content-type': 'application/json',
        ...(orgSlug ? { 'x-crove-org': orgSlug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: response.status, body: (body && 'json' in body ? body.json : body) as Record<string, unknown> | null };
  }

  const exec = <T>(userId: string, orgId: string, command: string, input: unknown) =>
    rt.execute<T>(command, input, { actor: asUser(userId), orgId, idempotencyKey: randomUUID() });

  const query = <T>(userId: string, orgId: string, name: string, input: unknown = {}) =>
    rt.query<T>(name, input, { actor: asUser(userId), orgId });

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
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const wUrl = new URL(adminUrl);
    wUrl.username = 'ludy_worker';
    wUrl.password = 'test-worker-pw';

    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    workerPool = createPool({ connectionString: wUrl.toString(), max: 2 });
    db = createDb(pool);
    workerDb = createDb(workerPool);

    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const rtOpts = { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' as const };
    rt = new Runtime(db, rtOpts).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    workerRt = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    app = createHttpApp({
      config,
      runtime: rt,
      store,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('creates a project atomically from a starter template with shifted due dates and HTTP RPC parity', async () => {
    const owner = await newPerson('tpl-owner');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Hoàng Anh');

    const tplRes = await rpc('projects/listTemplates', owner, { language: 'vi' }, org.slug);
    expect(tplRes.status).toBe(200);
    const listed = tplRes.body as unknown as ProjectTemplateListResult;
    expect(listed.templates.filter((t) => t.source === 'builtin')).toHaveLength(3);
    expect(listed.canWrite).toBe(true);

    const createdRes = await rpc(
      'projects/createFromTemplate',
      owner,
      {
        builtinKey: 'monthly-close',
        name: 'Khóa sổ T12/2026',
        startDate: '2026-12-01',
        timeZone: 'Asia/Ho_Chi_Minh',
        language: 'vi',
        idempotencyKey: randomUUID(),
      },
      org.slug,
    );
    expect(createdRes.status).toBe(200);
    const created = createdRes.body as unknown as ProjectCreateFromTemplateResult;
    expect(created.taskIds).toHaveLength(5);

    const board = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId: created.projectId });
    expect(board.project.name).toBe('Khóa sổ T12/2026');
    expect(board.tasks).toHaveLength(5);
    // monthly-close offsets: +1, +3, +4, +5, +7 from 2026-12-01 (Asia/Ho_Chi_Minh -> 2026-12-02 23:59+07:00 = 2026-12-02T16:59:00Z).
    expect(board.tasks[0]?.due).toBe('2026-12-02T16:59:00.000Z');
    expect(board.tasks[4]?.due).toBe('2026-12-08T16:59:00.000Z');
  });

  it('saves custom templates scoped by caller le_scope, enforces archive & 50-task limit, and isolates is_template rows', async () => {
    const owner = await newPerson('le-tpl-owner');
    const branchMember = await newPerson('le-tpl-member');
    const viewer = await newPerson('le-tpl-viewer');
    const orgBPerson = await newPerson('other-org');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Bắc Nam');
    const orgB = await createOrg(rt, asUser(orgBPerson.userId), 'Công ty Khác');

    for (const [person, role] of [
      [branchMember, 'member'],
      [viewer, 'viewer'],
    ] as const) {
      const inv = await rt.execute<{ acceptPath: string }>(
        'kernel.member.invite.create',
        { email: person.email, role },
        { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
      );
      await rt.executeOrgless(
        'kernel.member.invite.accept',
        { token: inv.acceptPath.split('#')[1] },
        { actor: asUser(person.userId) },
      );
    }

    let defaultEntityId = '';
    let branchEntityId = '';
    await withAdmin(async (c) => {
      defaultEntityId = (
        await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [org.orgId])
      ).rows[0]?.id as string;
      branchEntityId = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh HCM', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, branchMember.userId, branchEntityId, owner.userId],
      );
    });

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án đa chi nhánh',
    });

    let hqTaskId = '';
    let hcmTaskId = '';
    let hcmAiTaskId = '';
    await withAdmin(async (c) => {
      hqTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, due)
           VALUES ($1, 'Số liệu bí mật trụ sở chính', 'human', 'user', $2, '2026-12-01T16:59:00.000Z') RETURNING id`,
          [org.orgId, defaultEntityId],
        )
      ).rows[0]?.id as string;
      hcmTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, due)
           VALUES ($1, 'Kiểm kê kho HCM', 'human', 'user', $2, '2026-12-04T16:59:00.000Z') RETURNING id`,
          [org.orgId, branchEntityId],
        )
      ).rows[0]?.id as string;
      hcmAiTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, due, tainted)
           VALUES ($1, 'Đề xuất AI tại HCM', 'human', 'user', $2, '2026-12-05T16:59:00.000Z', true) RETURNING id`,
          [org.orgId, branchEntityId],
        )
      ).rows[0]?.id as string;
    });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: hqTaskId });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: hcmTaskId });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: hcmAiTaskId });

    // Branch member snapshots project: HQ task outside branchMember's le_scope MUST NOT leak into org template,
    // while tainted AI-proposed tasks preserve `tainted: true` across snapshot and create_from_template!
    const snap = await exec<{ templateId: string; taskCount: number }>(
      branchMember.userId,
      org.orgId,
      'projects.template.create',
      {
        name: 'Mẫu chi nhánh HCM',
        description: 'Snapshot theo phạm vi pháp nhân',
        sourceProjectId: projectId,
        timeZone: 'Asia/Ho_Chi_Minh',
      },
    );
    expect(snap.taskCount).toBe(2);

    const listRes = await query<ProjectTemplateListResult>(owner.userId, org.orgId, 'projects.template.list', {});
    const saved = listRes.templates.find((t) => t.id === snap.templateId);
    expect(saved?.tasks.map((t) => t.title)).toEqual(['Kiểm kê kho HCM', 'Đề xuất AI tại HCM']);
    expect(saved?.tasks.map((t) => t.title)).not.toContain('Số liệu bí mật trụ sở chính');
    expect(saved?.tasks.find((t) => t.title === 'Đề xuất AI tại HCM')?.tainted).toBe(true);

    const clonedFromSnap = await exec<ProjectCreateFromTemplateResult>(
      owner.userId,
      org.orgId,
      'projects.project.create_from_template',
      {
        templateId: snap.templateId,
        name: 'Bản sao HCM',
        startDate: '2026-12-10',
        timeZone: 'Asia/Ho_Chi_Minh',
      },
    );
    expect(clonedFromSnap.taskIds).toHaveLength(2);
    await withAdmin(async (c) => {
      const clonedTasks = await c.query<{ title: string; tainted: boolean }>(
        `SELECT title, tainted FROM ludy_kernel.task WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [org.orgId, clonedFromSnap.taskIds],
      );
      expect(clonedTasks.rows.find((r) => r.title === 'Kiểm kê kho HCM')?.tainted).toBe(false);
      expect(clonedTasks.rows.find((r) => r.title === 'Đề xuất AI tại HCM')?.tainted).toBe(true);
    });

    // Cross-org isolation and viewer block.
    const orgBTemplates = await query<ProjectTemplateListResult>(orgBPerson.userId, orgB.orgId, 'projects.template.list', {});
    expect(orgBTemplates.templates.some((t) => t.id === snap.templateId)).toBe(false);
    await expect(
      exec(viewer.userId, org.orgId, 'projects.template.create', {
        name: 'Viewer blocked',
        tasks: [{ title: 'T1' }],
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Template rows never leak into projects.project.list / get / board / today / weekly_status_source.
    const projectList = await query<ProjectListResult>(owner.userId, org.orgId, 'projects.project.list');
    expect(projectList.projects.some((p) => p.id === snap.templateId)).toBe(false);
    await expect(query(owner.userId, org.orgId, 'projects.project.get', { id: snap.templateId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(query(owner.userId, org.orgId, 'projects.board', { projectId: snap.templateId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    });
    await expect(
      query(owner.userId, org.orgId, 'projects.weekly_status_source', { projectId: snap.templateId }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    // DB trigger prevents attaching live project_task rows onto a template or flipping a project with tasks to template.
    await withAdmin(async (c) => {
      await expect(
        c.query(
          `INSERT INTO ludy_projects.project_task (org_id, project_id, task_id) VALUES ($1, $2, $3)`,
          [org.orgId, snap.templateId, hcmTaskId],
        ),
      ).rejects.toThrow(/PROJECT_TASK_ON_TEMPLATE/);
      await expect(
        c.query(`UPDATE ludy_projects.project SET is_template = true WHERE org_id = $1 AND id = $2`, [
          org.orgId,
          projectId,
        ]),
      ).rejects.toThrow(/PROJECT_TEMPLATE_HAS_TASKS/);
    });

    // Reject > 50 tasks cleanly.
    const fiftyOne = Array.from({ length: 51 }, (_, i) => ({ title: `Task ${i + 1}` }));
    await expect(
      exec(owner.userId, org.orgId, 'projects.template.create', { name: 'Too many', tasks: fiftyOne }),
    ).rejects.toThrow();

    // Archive template hides it from active list and blocks create_from_template.
    await exec(branchMember.userId, org.orgId, 'projects.template.archive', { templateId: snap.templateId });
    const afterArchive = await query<ProjectTemplateListResult>(owner.userId, org.orgId, 'projects.template.list', {});
    expect(afterArchive.templates.some((t) => t.id === snap.templateId)).toBe(false);
    await expect(
      exec(owner.userId, org.orgId, 'projects.project.create_from_template', { templateId: snap.templateId }),
    ).rejects.toMatchObject({ code: 'PROJECT_TEMPLATE_ARCHIVED' });
  });

  it('advances weekly & monthly (-1) recurring tasks idempotently via worker sweep, enforces caps, and wakes agent seats', async () => {
    const owner = await newPerson('rec-owner');
    const viewer = await newPerson('rec-viewer');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Định kỳ');

    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: viewer.email, role: 'viewer' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless(
      'kernel.member.invite.accept',
      { token: inv.acceptPath.split('#')[1] },
      { actor: asUser(viewer.userId) },
    );

    const installed = await rt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán AI' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Báo cáo tháng',
    });

    // Source task with historical due date (2026-09-30 Asia/Ho_Chi_Minh) so monthly -1 next occurrence (2026-10-31) is <= real now().
    const { taskId: monthlyTaskId } = await exec<{ taskId: string }>(
      owner.userId,
      org.orgId,
      'projects.task.create',
      {
        projectId,
        title: 'Đối chiếu cuối tháng',
        description: 'Kiểm tra sổ 111/112',
        assigneePositionId: installed.positionId,
        due: '2026-09-30T16:59:00.000Z',
      },
    );

    await expect(
      exec(viewer.userId, org.orgId, 'projects.task.recurrence.set', {
        projectId,
        taskId: monthlyTaskId,
        recurrence: { cadence: 'monthly', interval: 1, monthDay: -1, timeZone: 'Asia/Ho_Chi_Minh', times: 2 },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const setRes = await rpc(
      'projects/setTaskRecurrence',
      owner,
      {
        projectId,
        taskId: monthlyTaskId,
        recurrence: { cadence: 'monthly', interval: 1, monthDay: -1, timeZone: 'Asia/Ho_Chi_Minh', times: 2 },
        idempotencyKey: randomUUID(),
      },
      org.slug,
    );
    expect(setRes.status).toBe(200);
    const setView = setRes.body as unknown as ProjectTaskRecurrenceView;
    expect(setView.recurrence?.monthDay).toBe(-1);
    expect(setView.recurrenceNextAt).toBe('2026-10-30T17:00:00.000Z'); // 2026-10-31 00:00 +07:00

    // While source task is open, worker sweep creates nothing.
    expect(await sweepProjectsRecurring({ runtime: workerRt, workerDb })).toBe(0);

    // Close source task -> sweep creates Copy 1 (due 2026-10-31 23:59 +07:00), count=1, next=2026-11-30 00:00 +07:00.
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', { id: monthlyTaskId, status: 'done' });
    expect(await sweepProjectsRecurring({ runtime: workerRt, workerDb })).toBe(1);

    // Immediate second sweep while Copy 1 is still open produces 0 duplicates!
    expect(await sweepProjectsRecurring({ runtime: workerRt, workerDb })).toBe(0);

    const board1 = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    const copy1 = board1.tasks.find((t) => t.recurrenceSourceTaskId === monthlyTaskId);
    expect(copy1).toBeDefined();
    expect(copy1?.title).toBe('Đối chiếu cuối tháng');
    expect(copy1?.description).toBe('Kiểm tra sổ 111/112');
    expect(copy1?.assigneePositionId).toBe(installed.positionId);
    expect(copy1?.due).toBe('2026-10-31T16:59:00.000Z');

    // Setting recurrence on an automatically spawned copy is refused.
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.recurrence.set', {
        projectId,
        taskId: copy1!.id,
        recurrence: { cadence: 'weekly', interval: 1, weekday: 1, timeZone: 'Asia/Ho_Chi_Minh' },
      }),
    ).rejects.toMatchObject({ code: 'RECURRENCE_COPY_FORBIDDEN' });

    // Agent wakeup was queued for assigned AI seat.
    await withAdmin(async (c) => {
      const wake = await c.query<{ count: string }>(
        `SELECT pg_catalog.count(*)::text AS count FROM ludy_kernel.agent_wakeup WHERE org_id = $1 AND agent_id = $2`,
        [org.orgId, installed.agentId],
      );
      expect(Number(wake.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    });

    // Complete Copy 1 -> backdate/verify Copy 2 (due 2026-11-30 23:59 +07:00) spawns if <= now() or force clock check via advance.
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', { id: copy1!.id, status: 'done' });
    // Ensure Copy 2's next_at (2026-11-30) triggers if test runs before 2026-11-30: test advance directly or move source recurrence_next_at back in SQL for past simulation.
    await withAdmin(async (c) => {
      await c.query(
        `UPDATE ludy_projects.project_task SET recurrence_next_at = pg_catalog.now() - interval '1 minute' WHERE org_id = $1 AND task_id = $2`,
        [org.orgId, monthlyTaskId],
      );
    });
    expect(await sweepProjectsRecurring({ runtime: workerRt, workerDb })).toBe(1);

    // Since times: 2 was reached after 2nd generated copy, the series ended (recurrence = null, next_at = null).
    const viewAfterCap = await query<ProjectTaskRecurrenceView | null>(
      owner.userId,
      org.orgId,
      'projects.task.recurrence.get',
      { taskId: monthlyTaskId },
    );
    expect(viewAfterCap?.recurrence).toBeNull();
    expect(viewAfterCap?.recurrenceCount).toBe(2);

    // Turning projects app OFF prevents sweepProjectsRecurring from running on that org.
    const { taskId: weeklyTaskId } = await exec<{ taskId: string }>(
      owner.userId,
      org.orgId,
      'projects.task.create',
      {
        projectId,
        title: 'Họp giao ban tuần',
        assigneePositionId: null,
        due: '2026-10-05T16:59:00.000Z',
      },
    );
    await exec(owner.userId, org.orgId, 'projects.task.recurrence.set', {
      projectId,
      taskId: weeklyTaskId,
      recurrence: { cadence: 'weekly', interval: 1, weekday: 1, timeZone: 'Asia/Ho_Chi_Minh' },
    });
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', { id: weeklyTaskId, status: 'done' });
    await rt.execute(
      'kernel.org.set_app',
      { module: 'projects', enabled: false },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(await sweepProjectsRecurring({ runtime: workerRt, workerDb })).toBe(0);

    // Turn projects back ON -> weekly sweep creates occurrence and projects.recurring.advanced dispatches TASK_ASSIGNED notice to owner.
    await rt.execute(
      'kernel.org.set_app',
      { module: 'projects', enabled: true },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(await sweepProjectsRecurring({ runtime: workerRt, workerDb })).toBe(1);

    let weeklyAdvancedEventId = '';
    let weeklyCopyId = '';
    await withAdmin(async (c) => {
      const ev = await c.query<{ id: string; payload: { taskId?: string; positionId?: string | null } }>(
        `SELECT id, payload FROM ludy_kernel.outbox_event
         WHERE org_id = $1 AND type = 'projects.recurring.advanced' AND payload ->> 'sourceTaskId' = $2
         ORDER BY created_at DESC LIMIT 1`,
        [org.orgId, weeklyTaskId],
      );
      weeklyAdvancedEventId = ev.rows[0]?.id as string;
      weeklyCopyId = ev.rows[0]?.payload.taskId as string;
      expect(ev.rows[0]?.payload.positionId).toBeNull();
    });
    await workerRt.execute(
      'kernel.notification.dispatch',
      { eventId: weeklyAdvancedEventId },
      { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
    );
    const notices = await query<{ items: Array<{ kind: string; subjectId: string | null }> }>(
      owner.userId,
      org.orgId,
      'kernel.notification.list',
      {},
    );
    expect(notices.items.some((n) => n.kind === 'kernel.task_assigned' && n.subjectId === weeklyCopyId)).toBe(true);

    // Recurring task on AI coworker whose own module is OFF keeps pending agent_wakeup without emitting wakeAgentId.
    const { taskId: offAppTaskId } = await exec<{ taskId: string }>(
      owner.userId,
      org.orgId,
      'projects.task.create',
      {
        projectId,
        title: 'Đối soát khi Tạm tắt Kế toán',
        assigneePositionId: installed.positionId,
        due: '2026-10-05T16:59:00.000Z',
      },
    );
    await exec(owner.userId, org.orgId, 'projects.task.recurrence.set', {
      projectId,
      taskId: offAppTaskId,
      recurrence: { cadence: 'weekly', interval: 1, weekday: 1, timeZone: 'Asia/Ho_Chi_Minh' },
    });
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', { id: offAppTaskId, status: 'done' });
    await rt.execute(
      'kernel.org.set_app',
      { module: 'finance', enabled: false },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(await sweepProjectsRecurring({ runtime: workerRt, workerDb })).toBe(1);
    await withAdmin(async (c) => {
      const ev = await c.query<{ payload: { wakeAgentId?: string } }>(
        `SELECT payload FROM ludy_kernel.outbox_event
         WHERE org_id = $1 AND type = 'projects.recurring.advanced' AND payload ->> 'sourceTaskId' = $2
         ORDER BY created_at DESC LIMIT 1`,
        [org.orgId, offAppTaskId],
      );
      expect(ev.rows[0]?.payload.wakeAgentId).toBeUndefined();
    });
    await rt.execute(
      'kernel.org.set_app',
      { module: 'finance', enabled: true },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    // Clear recurrence stops further occurrences.
    const cleared = await exec<{ cleared: boolean }>(owner.userId, org.orgId, 'projects.task.recurrence.clear', {
      projectId,
      taskId: weeklyTaskId,
    });
    expect(cleared.cleared).toBe(true);
    expect(await sweepProjectsRecurring({ runtime: workerRt, workerDb })).toBe(0);

    // Agent run is blocked from calling template/recurrence commands and from writing ludy_projects directly.
    await exec(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Wake for agent guard',
      assigneePositionId: installed.positionId,
    });
    const started = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
    );
    expect(started.runId).toBeTruthy();
    const agentActor: AgentActor = {
      type: 'agent',
      agentId: installed.agentId,
      runId: started.runId!,
    };
    await expect(
      rt.execute(
        'projects.template.create',
        { name: 'Agent blocked', tasks: [{ title: 'A' }] },
        { actor: agentActor, orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      rt.execute(
        'projects.task.recurrence.set',
        { projectId, taskId: weeklyTaskId, recurrence: { cadence: 'weekly', interval: 1, weekday: 1, timeZone: 'Asia/Ho_Chi_Minh' } },
        { actor: agentActor, orgId: org.orgId },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('finds and erases personal data inside project template_tasks under PDPL while preserving validity', async () => {
    const owner = await newPerson('pdpl-tpl-owner');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty PDPL');

    const { templateId } = await exec<{ templateId: string }>(owner.userId, org.orgId, 'projects.template.create', {
      name: 'Quy trình chuẩn',
      tasks: [
        {
          title: 'Gọi anh Bình 0901234567 xác nhận',
          description: 'Gửi hợp đồng qua binh@example.com trước thứ 6',
          dueOffsetDays: 2,
        },
      ],
    });

    const foundEmail = await rt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: 'binh@example.com' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    expect(foundEmail.matches.some((m) => m.column === 'ludy_projects.project.template_tasks' && m.rowId === templateId)).toBe(true);

    const foundPhone = await rt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: '0901234567' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    expect(foundPhone.matches.some((m) => m.column === 'ludy_projects.project.template_tasks' && m.rowId === templateId)).toBe(true);

    const erasedEmail = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: 'binh@example.com' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(erasedEmail.erased.some((e) => e.column === 'ludy_projects.project.template_tasks' && e.rows === 1)).toBe(true);

    const erasedPhone = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: '0901234567' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(erasedPhone.erased.some((e) => e.column === 'ludy_projects.project.template_tasks' && e.rows === 1)).toBe(true);

    const afterEmail = await rt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: 'binh@example.com' },
      { actor: asUser(owner.userId), orgId: org.orgId },
    );
    expect(afterEmail.matches).toHaveLength(0);

    const templatesAfter = await query<ProjectTemplateListResult>(owner.userId, org.orgId, 'projects.template.list', {});
    const redacted = templatesAfter.templates.find((t) => t.id === templateId);
    expect(redacted?.tasks[0]?.title).toContain('[đã xóa]');
    expect(redacted?.tasks[0]?.description).toContain('[đã xóa]');
    expect(redacted?.tasks[0]?.dueOffsetDays).toBe(2);
  });

  it('aborts recurring advance cleanly when assignee_position_id changes concurrently before project lock and succeeds on retry', async () => {
    const owner = await newPerson('rec-lock-owner');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Khóa Song Song');
    const { positionId: seatId } = await rt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán kiểm tra khóa' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án kiểm tra thứ tự khóa',
    });
    const { taskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Công việc đổi vị trí phụ trách đồng thời',
      assigneePositionId: seatId,
      due: '2026-10-05T16:59:00.000Z',
    });
    await exec(owner.userId, org.orgId, 'projects.task.recurrence.set', {
      projectId,
      taskId,
      recurrence: { cadence: 'weekly', interval: 1, weekday: 1, timeZone: 'Asia/Ho_Chi_Minh' },
    });
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', { id: taskId, status: 'done' });

    const lockClient = new pg.Client({ connectionString: adminUrl });
    await lockClient.connect();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query(
        'SELECT id FROM ludy_projects.project WHERE org_id = $1 AND id = $2 FOR UPDATE',
        [org.orgId, projectId],
      );

      // Concurrent worker advance pre-reads assignee_position_id = seatId, locks position FOR SHARE,
      // then blocks waiting for ludy_projects.project FOR SHARE.
      const advancePromise = workerRt.execute<{ createdTaskId: string | null; seriesEnded: boolean; reason: string }>(
        'projects.recurring.advance',
        { projectId, taskId },
        { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
      );

      const blockerPid = (await lockClient.query<{ pid: number }>('SELECT pg_catalog.pg_backend_pid() AS pid')).rows[0]
        ?.pid;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await withAdmin(async (obs) => {
          const r = await obs.query<{ count: string }>(
            `SELECT pg_catalog.count(*)::text AS count
             FROM pg_catalog.pg_stat_activity
             WHERE datname = $1 AND wait_event_type = 'Lock' AND $2 = ANY(pg_catalog.pg_blocking_pids(pid))`,
            [dbName, blockerPid],
          );
          return Number(r.rows[0]?.count ?? 0);
        });
        if (waiting > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // Clear assignee concurrently before advance acquires the project/task locks.
      await lockClient.query(
        'UPDATE ludy_kernel.task SET assignee_position_id = NULL WHERE org_id = $1 AND id = $2',
        [org.orgId, taskId],
      );
      await lockClient.query('COMMIT');

      const firstAttempt = await advancePromise;
      expect(firstAttempt).toEqual({ createdTaskId: null, seriesEnded: false, reason: 'assignee_changed' });
    } catch (err) {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      await lockClient.end();
    }

    // Subsequent retry picks up the updated unassigned seat cleanly without creating duplicates.
    const retried = await workerRt.execute<{ createdTaskId: string | null; seriesEnded: boolean; reason: string }>(
      'projects.recurring.advance',
      { projectId, taskId },
      { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
    );
    expect(retried.reason).toBe('advanced');
    expect(retried.createdTaskId).toBeTruthy();

    const board = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    const copy = board.tasks.find((t) => t.id === retried.createdTaskId);
    expect(copy?.assigneePositionId).toBeNull();
  });
});

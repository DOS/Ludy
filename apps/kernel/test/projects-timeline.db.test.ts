// SPDX-License-Identifier: AGPL-3.0-only
// Projects timeline and Gantt view (#2599) on a real PostgreSQL 17:
// 1) projects.task.set_dates atomically writes ludy_projects.project_task.start_on and ludy_kernel.task.due,
//    supports partial updates and null clearing, and validates startOn <= vietnamDate(due).
// 2) Enforces 409 TASK_CHECKED_OUT while an AI agent run holds an active lease, and succeeds once released.
// 3) Enforces viewer, agent, cross-org, and archived-project guards.
// 4) projects.timeline computes dependency edges, conflicts (start_on & due fallback), deterministic critical path,
//    tainted preservation (#4422), le_scope isolation + hiddenByEntityCount, and LIMIT 200 truncation.
// 5) Exposes ORPC HTTP /api/rpc/projects/timeline and /api/rpc/projects/setTaskDates (404 when module absent).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { ProjectBoard, ProjectTimeline } from '@ludy/kernel-contract';
import { Runtime, type AgentActor, type BlobStore, sha256Hex } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-projects-timeline-0123456789';
const ISSUER = 'crove-auth';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
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

suite('projects timeline & set_dates (#2599) on PostgreSQL 17', () => {
  const dbName = `ludy_test_timeline_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerRt: Runtime;
  let apps: Record<'full' | 'withoutProjects', ReturnType<typeof createHttpApp>>;
  const store = new MemoryStore();

  const asUser = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal1' as const,
    sessionId: randomUUID(),
  });
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
    const email = `${tag}-${randomUUID().slice(0, 8)}@timeline.test`;
    const userId = await upsertIdentity(db, { issuer: ISSUER, subject, email, name: `User ${tag}` });
    return { subject, email, userId };
  }

  async function tokenFor(person: { subject: string; email: string }) {
    return new SignJWT({
      role: 'authenticated',
      email: person.email,
      session_id: randomUUID(),
      aal: 'aal1',
      is_anonymous: false,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(person.subject)
      .setIssuer(ISSUER)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
  }

  async function rpc(
    appName: keyof typeof apps,
    path: string,
    person: { subject: string; email: string },
    input: unknown,
    orgSlug?: string,
  ) {
    const response = await apps[appName].request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await tokenFor(person)}`,
        'content-type': 'application/json',
        ...(orgSlug ? { 'x-crove-org': orgSlug } : {}),
      },
      body: JSON.stringify(input === undefined ? {} : { json: input }),
    });
    const body = (await response.json().catch(() => null)) as
      | ({ json?: unknown } & Record<string, unknown>)
      | null;
    return {
      status: response.status,
      body: (body && 'json' in body ? body.json : body) as Record<string, unknown> | null,
    };
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

    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const rtOpts = {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required' as const,
    };
    rt = new Runtime(db, rtOpts).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    const withoutProjects = new Runtime(db, { ...rtOpts, absentModules: ['projects'] }).register({
      commands: kernelCommands,
      queries: kernelQueries({ inboundDomain: null }),
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    const makeApp = (runtime: Runtime) =>
      createHttpApp({
        config,
        runtime,
        store,
        authenticate: createAuthenticator(config, db),
        pool,
        aiEnabled: false,
      });
    apps = { full: makeApp(rt), withoutProjects: makeApp(withoutProjects) };
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

  it('persists start_on and due atomically, supports partial updates and clearing, and enforces Vietnam date-range checks', async () => {
    const owner = await newPerson('dates-owner');
    const org = await createOrg(rt, asUser(owner.userId), 'Timeline Dates Co');

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Triển khai Gantt Q1',
    });

    // Rejects inverted range on projects.task.create too
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.create', {
        projectId,
        title: 'Lịch ngược',
        assigneePositionId: null,
        startOn: '2027-03-20',
        due: '2027-03-19T16:59:59.000Z',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE_RANGE', status: 422 });

    const { taskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Lập bảng cân đối',
      assigneePositionId: null,
      startOn: '2027-03-10',
      due: '2027-03-15T16:59:00.000Z', // 2027-03-15 23:59 in Asia/Ho_Chi_Minh
    });

    // Verify persisted startOn in projects.board and projects.timeline
    const board = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(board.tasks[0]?.startOn).toBe('2027-03-10');

    // Vietnam UTC+7 midnight boundary check: 2027-03-15T16:59:59Z is 2027-03-15 23:59:59 ICT -> invalid when startOn is 2027-03-16
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.set_dates', {
        projectId,
        taskId,
        startOn: '2027-03-16',
        due: '2027-03-15T16:59:59.000Z',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE_RANGE', status: 422 });

    // 2027-03-15T17:00:00Z is 2027-03-16 00:00:00 ICT -> valid same-day range
    await exec(owner.userId, org.orgId, 'projects.task.set_dates', {
      projectId,
      taskId,
      startOn: '2027-03-16',
      due: '2027-03-15T17:00:00.000Z',
    });

    // Partial update: move only due later while preserving startOn = '2027-03-16'
    await exec(owner.userId, org.orgId, 'projects.task.set_dates', {
      projectId,
      taskId,
      due: '2027-03-22T16:59:00.000Z',
    });

    // Partial update: setting startOn past existing due fails with 422
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.set_dates', {
        projectId,
        taskId,
        startOn: '2027-03-23',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_DATE_RANGE', status: 422 });

    let timeline = await query<ProjectTimeline>(owner.userId, org.orgId, 'projects.timeline', { projectId });
    expect(timeline.tasks[0]?.startOn).toBe('2027-03-16');
    expect(timeline.tasks[0]?.due).toBe('2027-03-22T16:59:00.000Z');

    // Clear both dates explicitly with null
    await exec(owner.userId, org.orgId, 'projects.task.set_dates', {
      projectId,
      taskId,
      startOn: null,
      due: null,
    });
    timeline = await query<ProjectTimeline>(owner.userId, org.orgId, 'projects.timeline', { projectId });
    expect(timeline.tasks[0]?.startOn).toBeNull();
    expect(timeline.tasks[0]?.due).toBeNull();
  });

  it('refuses date mutations with TASK_CHECKED_OUT while an agent lease is active and enforces role/org/archive guards', async () => {
    const owner = await newPerson('guard-owner');
    const viewer = await newPerson('guard-viewer');
    const outsider = await newPerson('guard-outsider');

    const org = await createOrg(rt, asUser(owner.userId), 'Timeline Guard Co');
    const otherOrg = await createOrg(rt, asUser(outsider.userId), 'Other Org');
    expect(otherOrg.orgId).not.toBe(org.orgId);

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

    const { agentId, positionId } = await rt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán trưởng Timeline' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Kiểm soát khóa Gantt',
    });
    const { taskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Đối chiếu sổ phụ',
      assigneePositionId: positionId,
    });

    // Viewer can read timeline with canWrite = false, cannot edit dates
    const viewerTimeline = await query<ProjectTimeline>(viewer.userId, org.orgId, 'projects.timeline', { projectId });
    expect(viewerTimeline.project.canWrite).toBe(false);
    await expect(
      exec(viewer.userId, org.orgId, 'projects.task.set_dates', {
        projectId,
        taskId,
        startOn: '2027-03-10',
      }),
    ).rejects.toMatchObject({ status: 403 });

    // Cross-org outsider is denied
    await expect(
      query(outsider.userId, otherOrg.orgId, 'projects.timeline', { projectId }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    // Agent run checkout lease refuses human date change with 409 TASK_CHECKED_OUT; agents cannot invoke set_dates either
    const started = await workerRt.execute<{ runId: string }>(
      'kernel.agent.run.start',
      { agentId },
      { actor: SYSTEM, orgId: org.orgId },
    );
    const agentActor: AgentActor = { type: 'agent', agentId, runId: started.runId };
    await workerRt.execute('kernel.task.checkout', { id: taskId }, { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() });

    await expect(
      workerRt.execute(
        'projects.task.set_dates',
        { projectId, taskId, startOn: '2027-03-11' },
        { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      exec(owner.userId, org.orgId, 'projects.task.set_dates', {
        projectId,
        taskId,
        startOn: '2027-03-11',
      }),
    ).rejects.toMatchObject({ code: 'TASK_CHECKED_OUT', status: 409 });

    // Releasing lease allows update
    await workerRt.execute(
      'kernel.agent.run.finish',
      { runId: started.runId, outcome: 'succeeded' },
      { actor: SYSTEM, orgId: org.orgId },
    );
    await exec(owner.userId, org.orgId, 'projects.task.set_dates', {
      projectId,
      taskId,
      startOn: '2027-03-11',
    });

    // Archiving project blocks further set_dates
    await exec(owner.userId, org.orgId, 'projects.project.archive', { projectId });
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.set_dates', {
        projectId,
        taskId,
        startOn: '2027-03-12',
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED', status: 409 });
  });

  it('computes conflicts, critical path, tainted flag, le_scope isolation, HTTP RPC, and truncation at LIMIT 200', async () => {
    const owner = await newPerson('graph-owner');
    const branchUser = await newPerson('graph-branch');
    const org = await createOrg(rt, asUser(owner.userId), 'Gantt Graph Co');

    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: branchUser.email, role: 'member' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless(
      'kernel.member.invite.accept',
      { token: inv.acceptPath.split('#')[1] },
      { actor: asUser(branchUser.userId) },
    );

    let defaultEntityId = '';
    let branchEntityId = '';
    await withAdmin(async (c) => {
      defaultEntityId = (
        await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [org.orgId])
      ).rows[0]?.id as string;
      branchEntityId = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Hà Nội', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, branchUser.userId, branchEntityId, owner.userId],
      );
    });

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Báo cáo tài chính',
    });

    // Tainted task + dependency chain: A -> B -> C -> D (hidden default entity)
    const { taskId: taskA } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Bước A \u202Etainted',
      assigneePositionId: null,
      due: '2027-03-18T16:59:00.000Z',
    });
    await withAdmin((c) =>
      c.query(`UPDATE ludy_kernel.task SET tainted = true WHERE org_id = $1 AND id = $2`, [org.orgId, taskA]),
    );
    await exec(owner.userId, org.orgId, 'projects.task.set_dates', {
      projectId,
      taskId: taskA,
      startOn: '2027-03-10',
    });

    const { taskId: taskB } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Bước B',
      assigneePositionId: null,
      startOn: '2027-03-16', // Starts BEFORE taskA due 2027-03-18 -> conflict!
      due: '2027-03-22T16:59:00.000Z',
    });

    const { taskId: taskC } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Bước C (chỉ có hạn)',
      assigneePositionId: null,
      due: '2027-03-20T16:59:00.000Z', // No startOn; due 2027-03-20 < taskB due 2027-03-22 -> fallback due conflict!
    });

    // Hidden default-entity task D linked to taskB
    let hiddenTaskD = '';
    await withAdmin(async (c) => {
      hiddenTaskD = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, due)
           VALUES ($1, 'Việc mật trụ sở', 'human', 'user', $2, '2027-03-28T16:59:00.000Z') RETURNING id`,
          [org.orgId, defaultEntityId],
        )
      ).rows[0]?.id as string;
    });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: hiddenTaskD });

    await exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: taskA, blockedTaskId: taskB });
    await exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: taskB, blockedTaskId: taskC });
    await exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: taskC, blockedTaskId: hiddenTaskD });

    const ownerTimeline = await query<ProjectTimeline>(owner.userId, org.orgId, 'projects.timeline', { projectId });
    expect(ownerTimeline.hiddenByEntityCount).toBe(0);
    expect(ownerTimeline.cycles).toEqual([]);
    expect(ownerTimeline.tasks.find((t) => t.id === taskA)?.tainted).toBe(true);
    expect(ownerTimeline.criticalPathLength).toBe(4);
    expect(ownerTimeline.criticalPathTaskIds).toEqual([taskA, taskB, taskC, hiddenTaskD]);
    expect(ownerTimeline.conflicts.map((c) => [c.blockerTaskId, c.blockedTaskId, c.blockedField])).toEqual(
      expect.arrayContaining([
        [taskA, taskB, 'start_on'],
        [taskB, taskC, 'due'],
      ]),
    );

    // Branch-scoped member sees hiddenByEntityCount = 1, excludes hiddenTaskD and edge taskC->hiddenTaskD, and gets TASK_NOT_FOUND on set_dates(hiddenTaskD)
    const scopedTimeline = await query<ProjectTimeline>(branchUser.userId, org.orgId, 'projects.timeline', { projectId });
    expect(scopedTimeline.hiddenByEntityCount).toBe(1);
    expect(scopedTimeline.tasks.map((t) => t.id)).not.toContain(hiddenTaskD);
    expect(scopedTimeline.edges.every((e) => e.blockedTaskId !== hiddenTaskD && e.blockerTaskId !== hiddenTaskD)).toBe(true);
    expect(scopedTimeline.criticalPathTaskIds).toEqual([taskA, taskB, taskC]);
    expect(scopedTimeline.criticalPathLength).toBe(3);

    await expect(
      exec(branchUser.userId, org.orgId, 'projects.task.set_dates', {
        projectId,
        taskId: hiddenTaskD,
        startOn: '2027-03-19',
      }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });

    // ORPC HTTP /api/rpc/projects/setTaskDates and /api/rpc/projects/timeline work when module is active, 404 when absent
    const httpSet = await rpc(
      'full',
      'projects/setTaskDates',
      owner,
      {
        projectId,
        taskId: taskC,
        startOn: '2027-03-23',
        due: '2027-03-25T16:59:00.000Z',
        idempotencyKey: randomUUID(),
      },
      org.slug,
    );
    expect(httpSet.status).toBe(200);

    const httpTimeline = await rpc('full', 'projects/timeline', owner, { projectId }, org.slug);
    expect(httpTimeline.status).toBe(200);
    expect((httpTimeline.body as { tasks: Array<{ id: string; startOn: string | null }> }).tasks.find((t) => t.id === taskC)?.startOn).toBe('2027-03-23');

    const absentRes = await rpc('withoutProjects', 'projects/timeline', owner, { projectId }, org.slug);
    expect(absentRes.status).toBe(404);

    // Bounding check: insert 205 tasks into a dedicated project and verify LIMIT 200 truncation
    const { projectId: bigProjectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án lớn > 200 việc',
    });
    await withAdmin(async (c) => {
      await c.query(
        `WITH inserted AS (
           INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type)
           SELECT $1, 'Việc #' || g, 'human', 'user'
           FROM generate_series(1, 205) AS g
           RETURNING id
         )
         INSERT INTO ludy_projects.project_task (org_id, project_id, task_id, sort_key)
         SELECT $1, $2, id, lpad((row_number() OVER ())::text, 6, '0')
         FROM inserted`,
        [org.orgId, bigProjectId],
      );
    });
    const bigTimeline = await query<ProjectTimeline>(owner.userId, org.orgId, 'projects.timeline', {
      projectId: bigProjectId,
    });
    expect(bigTimeline.tasks).toHaveLength(200);
    expect(bigTimeline.truncated).toBe(true);
    expect(bigTimeline.totalVisible).toBe(205);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Project task dependencies (issue #2601, docs/plan/projects-v2.md section 4.3, ADR-0056 section 3) on real PostgreSQL 17:
// 1) Direct cycle (A->B->A), transitive cycle (A->B->C->A), self-loop (A->A) reject with 422 DEPENDENCY_CYCLE; diamond DAG succeeds.
// 2) Concurrent projects.dependency.add serialized by project FOR UPDATE lock never closes a cycle race.
// 3) Cross-project FK refusal, duplicate 409 DEPENDENCY_ALREADY_EXISTS, graph caps (20/task, 500/project).
// 4) Isolated from ludy_kernel.task.parent_task_id and request_depth (ADR-0029 agent delegation unchanged).
// 5) Agent/viewer write refusal, tenant/legal-entity isolation, ON DELETE CASCADE on project_task removal & org_purge + offboarding.
// 6) Deterministic board openBlockerCount/blockingCount, projects.today bottleneck items, and projects.weekly_status bottlenecks (AI off & on).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { InboxReader } from '@ludy/agent';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  EXPORT_TABLE_NAMES,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
} from '@ludy/kernel';
import {
  PROJECT_DEPENDENCIES_MAX,
  TASK_DEPENDENCIES_MAX,
  type ProjectBoard,
  type ProjectDependencyAddResult,
  type ProjectDependencyListResult,
  type ProjectWeeklyStatus,
} from '@ludy/kernel-contract';
import { Runtime, type AgentActor, type BlobStore, sha256Hex } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { memberMeter } from '../src/ai-meter.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { ExportSealer, exportAad } from '../src/export-seal.ts';
import { createHttpApp } from '../src/http.ts';
import { runOrgExport } from '../src/org-export.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-projects-deps-0123456789';
const ISSUER = 'crove-auth';
const DAY = 24 * 60 * 60 * 1000;
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

suite('project task dependencies on PostgreSQL (#2601)', () => {
  const dbName = `crove_test_proj_deps_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerRt: Runtime;
  let appAiOff: ReturnType<typeof createHttpApp>;
  let appAiOn: ReturnType<typeof createHttpApp>;
  const store = new MemoryStore();
  const sealer = new ExportSealer(randomBytes(32));

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
    const email = `${tag}-${randomUUID().slice(0, 8)}@deps.test`;
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
    app: ReturnType<typeof createHttpApp>,
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

  const exec = <T>(userId: string, orgId: string, command: string, input: unknown, key = randomUUID()) =>
    rt.execute<T>(command, input, { actor: asUser(userId), orgId, idempotencyKey: key });

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
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';

    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    db = createDb(pool);

    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands, orgPurgeCommand({ store })],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    const reader = new InboxReader({ baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 });
    const meterFor = (actor: Parameters<typeof memberMeter>[1]) =>
      memberMeter(rt, actor, { price: { inputPerMTok: '100', outputPerMTok: '200' } });
    appAiOff = createHttpApp({ config, runtime: rt, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
    appAiOn = createHttpApp({
      config,
      runtime: rt,
      store,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: true,
      aiMeter: meterFor,
      conversationReader: reader,
    });
  }, 120_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await pool?.end();
    await workerPool?.end();
    if (ADMIN) {
      const root = new pg.Client({ connectionString: ADMIN });
      await root.connect();
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await root.end();
    }
  });

  it('enforces DAG cycle detection (self, direct, transitive, diamond, concurrent race), duplicate conflicts, cross-project checks, and keeps parent_task_id untouched', async () => {
    const owner = await newPerson('owner-dag');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty DAG');
    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án A',
    });
    const { projectId: otherProjectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án B',
    });

    const createTask = async (title: string, pId = projectId) =>
      (
        await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
          projectId: pId,
          title,
          assigneePositionId: null,
        })
      ).taskId;

    const a = await createTask('Task A');
    const b = await createTask('Task B');
    const c = await createTask('Task C');
    const d = await createTask('Task D');
    const outside = await createTask('Other Project Task', otherProjectId);

    // Self-loop rejects with 422 DEPENDENCY_CYCLE (not CHECK violation).
    await expect(
      exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: a, blockedTaskId: a }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE', status: 422 });

    // Cross-project refusal in command and SQL composite FK refusal directly in Postgres.
    await expect(
      exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: a, blockedTaskId: outside }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_TASK_NOT_IN_PROJECT', status: 404 });
    await withAdmin(async (client) => {
      await expect(
        client.query(
          `INSERT INTO ludy_projects.task_dependency (org_id, project_id, blocker_task_id, blocked_task_id)
           VALUES ($1, $2, $3, $4)`,
          [org.orgId, projectId, a, outside],
        ),
      ).rejects.toThrow();
    });

    // A -> B -> C
    const addKey = randomUUID();
    const first = await exec<ProjectDependencyAddResult>(
      owner.userId,
      org.orgId,
      'projects.dependency.add',
      { projectId, blockerTaskId: a, blockedTaskId: b },
      addKey,
    );
    // Same idempotency key replays cleanly.
    await expect(
      exec<ProjectDependencyAddResult>(
        owner.userId,
        org.orgId,
        'projects.dependency.add',
        { projectId, blockerTaskId: a, blockedTaskId: b },
        addKey,
      ),
    ).resolves.toEqual(first);
    // Different idempotency key for duplicate edge fails with 409.
    await expect(
      exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: a, blockedTaskId: b }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_ALREADY_EXISTS', status: 409 });

    // Direct 2-cycle B -> A rejected cleanly.
    await expect(
      exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: b, blockedTaskId: a }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_CYCLE', status: 422 });

    await exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: b, blockedTaskId: c });

    // Transitive cycle C -> A rejected with 422 DEPENDENCY_CYCLE.
    const httpCycle = await rpc(
      appAiOff,
      'projects/addDependency',
      owner,
      { projectId, blockerTaskId: c, blockedTaskId: a, idempotencyKey: randomUUID() },
      org.slug,
    );
    expect(httpCycle.status).toBe(422);

    // Diamond DAG: A -> D and B -> D succeeds without false cycle errors.
    await exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: a, blockedTaskId: d });
    await exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: b, blockedTaskId: d });

    // Concurrent race test: C -> D vs D -> C fired concurrently under project FOR UPDATE lock.
    const raceResults = await Promise.allSettled([
      exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: c, blockedTaskId: d }),
      exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: d, blockedTaskId: c }),
    ]);
    const fulfilled = raceResults.filter((r) => r.status === 'fulfilled');
    const rejected = raceResults.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: 'DEPENDENCY_CYCLE', status: 422 });

    // Confirm ludy_kernel.task.parent_task_id and request_depth stayed strictly untouched on every task.
    await withAdmin(async (client) => {
      const { rows } = await client.query<{ id: string; parent_task_id: string | null; request_depth: number }>(
        `SELECT id, parent_task_id, request_depth FROM ludy_kernel.task WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [org.orgId, [a, b, c, d]],
      );
      expect(rows).toHaveLength(4);
      for (const r of rows) {
        expect(r.parent_task_id).toBeNull();
        expect(r.request_depth).toBe(0);
      }
    });

    // Cascade when task is removed from project via projects.task.remove.
    const listedBefore = await query<ProjectDependencyListResult>(owner.userId, org.orgId, 'projects.dependency.list', {
      projectId,
      taskId: c,
    });
    expect(listedBefore.edges.length).toBeGreaterThanOrEqual(1);
    await exec(owner.userId, org.orgId, 'projects.task.remove', { projectId, taskId: c });
    const listedAfter = await query<ProjectDependencyListResult>(owner.userId, org.orgId, 'projects.dependency.list', {
      projectId,
    });
    expect(listedAfter.edges.some((e) => e.blockerTaskId === c || e.blockedTaskId === c)).toBe(false);
  });

  it('enforces per-task (20) and per-project (500) caps, viewer/agent write refusal, and tenant + le_scope isolation', async () => {
    const owner = await newPerson('owner-cap');
    const viewer = await newPerson('viewer-cap');
    const branchMember = await newPerson('branch-cap');
    const outsider = await newPerson('outsider-cap');

    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Giới hạn');
    const otherOrg = await createOrg(rt, asUser(outsider.userId), 'Công ty Ngoài');
    void otherOrg;

    let branchEntityId = '';
    let defaultEntityId = '';
    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'viewer'), ($1, $3, 'member')`,
        [org.orgId, viewer.userId, branchMember.userId],
      );
      defaultEntityId = (
        await c.query<{ id: string }>(`SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default`, [org.orgId])
      ).rows[0]!.id;
      branchEntityId = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by)
           VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]!.id;
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, branchMember.userId, branchEntityId, owner.userId],
      );
    });

    const installed = await rt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán AI' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await exec(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Wake agent',
      assigneePositionId: installed.positionId,
    });
    const started = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
    );
    expect(started.runId).toBeTruthy();
    const agentActor: AgentActor = { type: 'agent', agentId: installed.agentId, runId: started.runId as string };

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án Cap',
    });

    const createRawTask = async (title: string, entityId: string) =>
      withAdmin(async (c) => {
        const tId = (
          await c.query<{ id: string }>(
            `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
             VALUES ($1, $2, 'human', 'user', $3) RETURNING id`,
            [org.orgId, title, entityId],
          )
        ).rows[0]!.id;
        await c.query(
          `INSERT INTO ludy_projects.project_task (org_id, project_id, task_id, added_by)
           VALUES ($1, $2, $3, $4)`,
          [org.orgId, projectId, tId, owner.userId],
        );
        return tId;
      });

    const hub = await createRawTask('Hub task', branchEntityId);
    const defaultHidden = await createRawTask('Headquarters secret', defaultEntityId);
    const branchTarget = await createRawTask('Branch target', branchEntityId);

    // Per-task cap = 20: add 20 tasks blocking hub -> 21st rejects with 422 DEPENDENCY_LIMIT_REACHED.
    const spokes: string[] = [];
    for (let i = 0; i < TASK_DEPENDENCIES_MAX + 1; i++) {
      spokes.push(await createRawTask(`Spoke ${i}`, branchEntityId));
    }
    for (let i = 0; i < TASK_DEPENDENCIES_MAX; i++) {
      await exec(owner.userId, org.orgId, 'projects.dependency.add', {
        projectId,
        blockerTaskId: spokes[i]!,
        blockedTaskId: hub,
      });
    }
    await expect(
      exec(owner.userId, org.orgId, 'projects.dependency.add', {
        projectId,
        blockerTaskId: spokes[TASK_DEPENDENCIES_MAX]!,
        blockedTaskId: hub,
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_LIMIT_REACHED', status: 422 });

    // Viewer can list, cannot add/remove.
    const viewerList = await query<ProjectDependencyListResult>(viewer.userId, org.orgId, 'projects.dependency.list', {
      projectId,
    });
    expect(viewerList.edges).toHaveLength(TASK_DEPENDENCIES_MAX);
    await expect(
      exec(viewer.userId, org.orgId, 'projects.dependency.add', {
        projectId,
        blockerTaskId: branchTarget,
        blockedTaskId: defaultHidden,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Agent actor refused on dependency mutations & queries.
    await expect(
      rt.execute(
        'projects.dependency.add',
        { projectId, blockerTaskId: branchTarget, blockedTaskId: defaultHidden },
        { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      rt.query('projects.dependency.list', { projectId }, { actor: agentActor, orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // le_scope: edge touching headquarters task is hidden from branchMember, and branchMember cannot add or delete it.
    const hiddenEdge = await exec<ProjectDependencyAddResult>(owner.userId, org.orgId, 'projects.dependency.add', {
      projectId,
      blockerTaskId: defaultHidden,
      blockedTaskId: branchTarget,
    });
    const branchList = await query<ProjectDependencyListResult>(branchMember.userId, org.orgId, 'projects.dependency.list', {
      projectId,
    });
    expect(branchList.edges.some((e) => e.id === hiddenEdge.dependencyId)).toBe(false);
    await expect(
      exec(branchMember.userId, org.orgId, 'projects.dependency.remove', {
        projectId,
        dependencyId: hiddenEdge.dependencyId,
      }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });

    // Outsider cannot read or write (non-member returns NOT_A_MEMBER; cross-org returns PROJECT_NOT_FOUND).
    await expect(
      query(outsider.userId, org.orgId, 'projects.dependency.list', { projectId }),
    ).rejects.toMatchObject({ code: 'NOT_A_MEMBER' });
    await expect(
      query(outsider.userId, otherOrg.orgId, 'projects.dependency.list', { projectId }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    // Per-project cap = 500 on a second project cleanly hits 422 DEPENDENCY_LIMIT_REACHED.
    const { projectId: capProjectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án 500',
    });
    let capExtraA = '';
    let capExtraB = '';
    await withAdmin(async (c) => {
      // Create 502 tasks: 0..500 form a 500-edge chain (<=2 edges each), while 501 stays disconnected.
      const capTaskIds: string[] = [];
      for (let i = 0; i < PROJECT_DEPENDENCIES_MAX + 2; i++) {
        const id = randomUUID();
        capTaskIds.push(id);
        await c.query(
          `INSERT INTO ludy_kernel.task (org_id, id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, $2, $3, 'human', 'user', $4)`,
          [org.orgId, id, `Chain ${i}`, defaultEntityId],
        );
        await c.query(
          `INSERT INTO ludy_projects.project_task (org_id, project_id, task_id, added_by)
           VALUES ($1, $2, $3, $4)`,
          [org.orgId, capProjectId, id, owner.userId],
        );
      }
      const blockers = capTaskIds.slice(0, PROJECT_DEPENDENCIES_MAX);
      const blockeds = capTaskIds.slice(1, PROJECT_DEPENDENCIES_MAX + 1);
      await c.query(
        `INSERT INTO ludy_projects.task_dependency (org_id, project_id, blocker_task_id, blocked_task_id)
         SELECT $1, $2, b.blocker, b.blocked
           FROM unnest($3::uuid[], $4::uuid[]) AS b(blocker, blocked)`,
        [org.orgId, capProjectId, blockers, blockeds],
      );
      capExtraA = capTaskIds[PROJECT_DEPENDENCIES_MAX + 1]!;
      capExtraB = capTaskIds[0]!;
    });
    const capBoard = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId: capProjectId });
    expect(capBoard.totalVisible).toBeGreaterThan(0);
    await expect(
      exec(owner.userId, org.orgId, 'projects.dependency.add', {
        projectId: capProjectId,
        blockerTaskId: capExtraA,
        blockedTaskId: capExtraB,
      }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_LIMIT_REACHED', status: 422 });
  });

  it('computes board openBlockerCount/blockingCount, Today bottleneck items, weeklyStatus bottlenecks (AI off & on), and exports + purges cleanly', async () => {
    const owner = await newPerson('owner-ui-ai');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Điểm nghẽn');
    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án Ra mắt',
    });

    const createTask = async (title: string) =>
      (
        await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
          projectId,
          title,
          assigneePositionId: null,
        })
      ).taskId;

    const blocker = await createTask('Chốt hợp đồng khung');
    const blocked1 = await createTask('Phát hành báo giá');
    const blocked2 = await createTask('Đặt cọc nhà cung cấp');

    await exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: blocker, blockedTaskId: blocked1 });
    await exec(owner.userId, org.orgId, 'projects.dependency.add', { projectId, blockerTaskId: blocker, blockedTaskId: blocked2 });

    // Board counts before completing blocker.
    const boardBefore = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(boardBefore.tasks.find((t) => t.id === blocker)).toMatchObject({ openBlockerCount: 0, blockingCount: 2 });
    expect(boardBefore.tasks.find((t) => t.id === blocked1)).toMatchObject({ openBlockerCount: 1, blockingCount: 0 });
    expect(boardBefore.tasks.find((t) => t.id === blocked2)).toMatchObject({ openBlockerCount: 1, blockingCount: 0 });

    // projects.today surfaces deterministic bottleneck blocker with zero free text.
    const todayItems = await query<Array<{ id: string; title: { key: string; params: Record<string, unknown> } }>>(
      owner.userId,
      org.orgId,
      'projects.today',
      {},
    );
    expect(todayItems).toContainEqual(
      expect.objectContaining({
        id: `bottleneck:${blocker}`,
        title: { key: 'projects.blockingTasks', params: { count: 2 } },
      }),
    );
    expect(JSON.stringify(todayItems)).not.toContain('Chốt hợp đồng khung');

    // Weekly status returns deterministic bottlenecks even with AI off.
    const weeklyOff = await rpc(appAiOff, 'projects/weeklyStatus', owner, { projectId, language: 'vi' }, org.slug);
    expect(weeklyOff.status).toBe(200);
    const bodyOff = weeklyOff.body as unknown as ProjectWeeklyStatus;
    expect(bodyOff.ai).toBe('off');
    expect(bodyOff.bottlenecks).toEqual([
      expect.objectContaining({ id: blocker, title: 'Chốt hợp đồng khung', blockedCount: 2 }),
    ]);

    // Weekly status with AI on grounds blockedCount = 2 cleanly.
    const prompts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: { body?: string }) => {
        const req = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ role: string; content: string }> };
        const userMsg = req.messages?.find((m) => m.role === 'user')?.content ?? '';
        prompts.push(userMsg);
        return new Response(
          JSON.stringify({
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1,
            model: 'test',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: JSON.stringify({
                    sentences: [
                      'Dự án hiện có 3 việc hiển thị và chưa hoàn thành việc nào trong tuần.',
                      'Điểm nghẽn cần gỡ sớm là Chốt hợp đồng khung đang chặn 2 việc mở.',
                      'Hãy xử lý việc chặn này trước để các bước tiếp theo chạy đúng tiến độ.',
                    ],
                  }),
                },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const weeklyOn = await rpc(appAiOn, 'projects/weeklyStatus', owner, { projectId, language: 'vi' }, org.slug);
    expect(weeklyOn.status).toBe(200);
    const bodyOn = weeklyOn.body as unknown as ProjectWeeklyStatus;
    expect(bodyOn.ai).toBe('used');
    expect(bodyOn.sentences.join(' ')).toContain('2');
    expect(prompts[0]).toContain('Chốt hợp đồng khung');

    // Completing blocker clears openBlockerCount and removes Today bottleneck.
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', { id: blocker, status: 'done' });
    const boardAfter = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(boardAfter.tasks.find((t) => t.id === blocked1)?.openBlockerCount).toBe(0);
    expect(boardAfter.tasks.find((t) => t.id === blocker)?.blockingCount).toBe(0);
    const todayAfter = await query<Array<{ id: string }>>(owner.userId, org.orgId, 'projects.today', {});
    expect(todayAfter.some((i) => i.id === `bottleneck:${blocker}`)).toBe(false);

    // Offboarding export & org_purge cover ludy_projects.task_dependency.
    expect(EXPORT_TABLE_NAMES).toContain('projects.task_dependency');
    const generatedAt = new Date(Date.now() - 35 * DAY);
    const exported = await runOrgExport({ runtime: workerRt, store, sealer, retentionDays: 40 }, org.orgId, {
      now: () => generatedAt,
    });
    const depPart = exported.parts.find((p) => p.table === 'projects.task_dependency')!;
    expect(depPart).toBeDefined();
    expect(depPart.rows).toBe(2);
    const raw = await store.get(depPart.key);
    const decodedRows = new TextDecoder()
      .decode(sealer.open(raw, exportAad(org.orgId, depPart), 'aes-256-gcm'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(decodedRows).toHaveLength(2);

    await rt.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.userId), orgId: org.orgId });
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE ludy_kernel.audit_event
            SET occurred_at = $1
          WHERE org_id = $2 AND command IN ('kernel.org.offboard', 'kernel.org.export.record')`,
        [new Date(Date.now() - 32 * DAY), org.orgId],
      );
      await c.query('COMMIT');
    });

    const purged = await purgeOrg(workerRt, 30, { ref: org.orgId, reason: 'projects-deps-test' });
    expect(purged).toMatchObject({ kind: 'purged', orgId: org.orgId });

    const left = await withAdmin(async (c) =>
      Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ludy_projects.task_dependency WHERE org_id = $1`, [org.orgId])).rows[0]!.n),
    );
    expect(left).toBe(0);
  });
});

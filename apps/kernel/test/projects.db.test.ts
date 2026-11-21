// SPDX-License-Identifier: AGPL-3.0-only
// Projects module (ADR-0048, docs/plan/projects.md step P2, #2591) on a real PostgreSQL 17:
// 1) Solo owner creates a project, creates/adds 5 tasks with zero chart setup, drags one to Done.
// 2) Another org's member reads and changes nothing.
// 3) Agent contexts are refused on commands and direct writes to all three crove_projects tables.
// 4) Entity-limited members (le_scope) read the project but not another entity's task, and board counts hidden tasks.
// 5) Org export includes crove_projects tables; PDPL erase redacts project PII; org_purge removes projects before tasks.
// 6) Omitting projects from CROVE_MODULES returns 404 on /api/rpc/projects/* while kernel tasks work unchanged.
// 7) Member removal clears owner_user_id and lets org owners manage; archived/duplicate/role guards hold.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import {
  EXPORT_TABLE_NAMES,
  createOrg,
  kernelCommands,
  kernelQueries,
  upsertIdentity,
  type OrgExportView,
} from '@ludy/kernel';
import type {
  PersonalDataErasure,
  PersonalDataResult,
  ProjectBoard,
  ProjectCandidateTask,
  ProjectDetail,
  ProjectListResult,
} from '@ludy/kernel-contract';
import { Runtime, type AgentActor, type BlobStore, sha256Hex } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
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
const SECRET = 'test-only-jwt-secret-for-projects-p2-0123456789';
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

suite('projects module on PostgreSQL (#2591)', () => {
  const dbName = `crove_test_projects_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerRt: Runtime;
  let apps: Record<'full' | 'withoutProjects', ReturnType<typeof createHttpApp>>;
  const store = new MemoryStore();
  const exportKeyBytes = randomBytes(32);
  const sealer = new ExportSealer(exportKeyBytes);

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
    const email = `${tag}-${randomUUID().slice(0, 8)}@projects.test`;
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    const wUrl = new URL(adminUrl);
    wUrl.username = 'crove_worker';
    wUrl.password = 'test-worker-pw';
    workerUrl = wUrl.toString();

    pool = createPool({ connectionString: appUrl.toString(), max: 4 });
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    db = createDb(pool);

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
    const withoutProjects = new Runtime(db, { ...rtOpts, absentModules: ['projects'] }).register({
      commands: kernelCommands,
      queries: kernelQueries({ inboundDomain: null }),
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS })
      .register({
        commands: [...kernelCommands, ...projectsCommands, ...financeCommands, orgPurgeCommand({ store })],
        queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
      });
    const makeApp = (runtime: Runtime) =>
      createHttpApp({ config, runtime, store, authenticate: createAuthenticator(config, db), pool, aiEnabled: false });
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

  it('solo owner creates a project, adds 5 tasks with no setup, orders by due then created, and sets one to done (AC 1 & 9)', async () => {
    const owner = await newPerson('solo-owner');
    const org = await createOrg(rt, asUser(owner.userId), 'Hộ kinh doanh Minh');

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Khai thuế quý IV',
      description: 'Tổng hợp chứng từ trước 20/01',
    });

    // Attach 1 pre-existing root task + create 4 tasks directly inside the project.
    const { taskId: existingTaskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Kiểm tra sổ ngân hàng',
      assigneePositionId: null,
      due: '2026-11-25T00:00:00.000Z',
    });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: existingTaskId });

    const specs = [
      { title: 'Thu thập hóa đơn đầu vào', due: '2026-11-10T00:00:00.000Z' },
      { title: 'Đối chiếu công nợ', due: '2026-11-15T00:00:00.000Z' },
      { title: 'Nộp tờ khai GTGT' },
      { title: 'Lưu bản PDF hồ sơ', status: 'in_progress' as const },
    ];
    const createdIds: string[] = [];
    for (const spec of specs) {
      const { taskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
        projectId,
        title: spec.title,
        assigneePositionId: null,
        ...(spec.due ? { due: spec.due } : {}),
        ...(spec.status ? { status: spec.status } : {}),
      });
      createdIds.push(taskId);
    }

    // Move first task to Done (equivalent to board drag calling kernel.task.setStatus).
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', {
      id: createdIds[0],
      status: 'done',
    });

    const board = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(board.project).toMatchObject({
      id: projectId,
      name: 'Khai thuế quý IV',
      status: 'active',
      ownerUserId: owner.userId,
      canManage: true,
      canWrite: true,
    });
    expect(board.tasks).toHaveLength(5);
    expect(board.hiddenByEntityCount).toBe(0);
    // Due dates come first ascending, followed by NULL due tasks ordered by creation.
    expect(board.tasks.slice(0, 3).map((t) => t.title)).toEqual([
      'Thu thập hóa đơn đầu vào',
      'Đối chiếu công nợ',
      'Kiểm tra sổ ngân hàng',
    ]);
    expect(board.tasks.find((t) => t.id === createdIds[0])?.status).toBe('done');
    expect(board.tasks.find((t) => t.id === createdIds[3])?.status).toBe('in_progress');

    // Summary counts update cleanly on list query.
    const listed = await query<ProjectListResult>(owner.userId, org.orgId, 'projects.project.list');
    expect(listed.projects).toHaveLength(1);
    expect(listed.projects[0]).toMatchObject({
      id: projectId,
      openTaskCount: 4,
      doneTaskCount: 1,
      memberCount: 1,
    });

    // Same-project add is idempotent; assigning to a second project is refused cleanly.
    const { projectId: secondProjectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án khác',
    });
    await expect(exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: existingTaskId })).resolves.toEqual({
      projectId,
      taskId: existingTaskId,
      added: false,
    });
    await expect(exec(owner.userId, org.orgId, 'projects.task.add', { projectId: secondProjectId, taskId: existingTaskId })).rejects.toMatchObject({
      code: 'TASK_ALREADY_IN_PROJECT',
    });

    // Project task never appears in unassigned candidate list, while unlinked tasks do.
    const { taskId: freeTaskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Việc chưa gán dự án',
      assigneePositionId: null,
    });
    const candidates = await query<ProjectCandidateTask[]>(owner.userId, org.orgId, 'projects.unassigned_tasks', {});
    expect(candidates.map((c) => c.id)).toContain(freeTaskId);
    expect(candidates.map((c) => c.id)).not.toContain(existingTaskId);
  });

  it('enforces cross-org isolation, role permissions, archive lock, and owner removal fallback (AC 2)', async () => {
    const ownerA = await newPerson('orgA-owner');
    const memberA = await newPerson('orgA-member');
    const viewerA = await newPerson('orgA-viewer');
    const ownerB = await newPerson('orgB-owner');

    const orgA = await createOrg(rt, asUser(ownerA.userId), 'Công ty Alpha');
    const orgB = await createOrg(rt, asUser(ownerB.userId), 'Công ty Beta');

    for (const [person, role] of [
      [memberA, 'member'],
      [viewerA, 'viewer'],
    ] as const) {
      const inv = await rt.execute<{ acceptPath: string }>(
        'kernel.member.invite.create',
        { email: person.email, role },
        { actor: asMfa(ownerA.userId), orgId: orgA.orgId, idempotencyKey: randomUUID() },
      );
      await rt.executeOrgless('kernel.member.invite.accept', { token: inv.acceptPath.split('#')[1] }, { actor: asUser(person.userId) });
    }

    const { projectId } = await exec<{ projectId: string }>(memberA.userId, orgA.orgId, 'projects.project.create', {
      name: 'Chiến dịch nội bộ',
      ownerUserId: memberA.userId,
    });

    // Cross-org member reads nothing and gets PROJECT_NOT_FOUND on targeted RPCs.
    const listB = await query<ProjectListResult>(ownerB.userId, orgB.orgId, 'projects.project.list');
    expect(listB.projects).toEqual([]);
    await expect(query(ownerB.userId, orgB.orgId, 'projects.project.get', { id: projectId })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    await expect(query(ownerB.userId, orgB.orgId, 'projects.board', { projectId })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    // Viewer reads board & list but cannot write.
    const viewerList = await query<ProjectListResult>(viewerA.userId, orgA.orgId, 'projects.project.list');
    expect(viewerList.canWrite).toBe(false);
    expect(viewerList.projects).toHaveLength(1);
    const viewerBoard = await query<ProjectBoard>(viewerA.userId, orgA.orgId, 'projects.board', { projectId });
    expect(viewerBoard.project.canWrite).toBe(false);
    await expect(exec(viewerA.userId, orgA.orgId, 'projects.project.create', { name: 'Blocked' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(exec(viewerA.userId, orgA.orgId, 'projects.task.create', { projectId, title: 'Blocked', assigneePositionId: null })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    // Cannot assign a viewer as project owner.
    await expect(exec(ownerA.userId, orgA.orgId, 'projects.project.set_owner', { projectId, ownerUserId: viewerA.userId })).rejects.toMatchObject({
      code: 'PROJECT_OWNER_FORBIDDEN',
    });

    // Project owner (memberA) adds org ownerA and removes them later; non-owner member cannot manage owner-only changes if transferred.
    await exec(memberA.userId, orgA.orgId, 'projects.member.add', { projectId, userId: ownerA.userId });
    await exec(memberA.userId, orgA.orgId, 'projects.project.update', { projectId, name: 'Chiến dịch Q4', description: 'Đổi tên' });
    await exec(memberA.userId, orgA.orgId, 'projects.project.set_status', { projectId, status: 'on_hold' });

    // Removing the project's owner from the org drops project_member and sets owner_user_id = NULL so org owners still manage.
    await rt.execute('kernel.member.remove', { userId: memberA.userId }, { actor: asMfa(ownerA.userId), orgId: orgA.orgId });
    const afterRemove = await query<ProjectDetail>(ownerA.userId, orgA.orgId, 'projects.project.get', { id: projectId });
    expect(afterRemove.ownerUserId).toBeNull();
    expect(afterRemove.canManage).toBe(true);

    // Archiving freezes edits with PROJECT_ARCHIVED.
    await exec(ownerA.userId, orgA.orgId, 'projects.project.archive', { projectId });
    await expect(exec(ownerA.userId, orgA.orgId, 'projects.project.update', { projectId, name: 'After archive' })).rejects.toMatchObject({
      code: 'PROJECT_ARCHIVED',
    });
    await expect(exec(ownerA.userId, orgA.orgId, 'projects.task.create', { projectId, title: 'Late task', assigneePositionId: null })).rejects.toMatchObject({
      code: 'PROJECT_ARCHIVED',
    });
  });

  it('refuses agent contexts on commands and direct writes across all three crove_projects tables (AC 3)', async () => {
    const owner = await newPerson('agent-owner');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty AI');
    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', { name: 'Agent Guard' });
    const { taskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Seed task',
      assigneePositionId: null,
    });

    // Install an active agent + create a task assigned to its seat to queue a wake-up, then start a run so enter_agent_context is real.
    const installed = await rt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán AI' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await exec(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Wake agent for guard test',
      assigneePositionId: installed.positionId,
    });
    const started = await workerRt.execute<{ runId: string | null; reason?: string }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
    );
    expect(started).toMatchObject({ runId: expect.any(String) });
    const agentActor: AgentActor = { type: 'agent', agentId: installed.agentId, runId: started.runId as string };

    // Runtime rejects every projects.* command from an agent actor.
    await expect(
      rt.execute('projects.project.create', { name: 'By agent' }, { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      rt.execute('projects.task.create', { projectId, title: 'By agent', assigneePositionId: null }, { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Direct SQL inside crove_worker agent context cannot INSERT into any crove_projects.* table.
    const statements: Array<[string, unknown[]]> = [
      ['INSERT INTO crove_projects.project (org_id, name, created_by) VALUES ($1, $2, $3)', [org.orgId, 'Direct', owner.userId]],
      ['INSERT INTO crove_projects.project_member (org_id, project_id, user_id) VALUES ($1, $2, $3)', [org.orgId, projectId, owner.userId]],
      ['INSERT INTO crove_projects.project_task (org_id, project_id, task_id, added_by) VALUES ($1, $2, $3, $4)', [org.orgId, projectId, taskId, owner.userId]],
    ];
    for (const [sqlText, params] of statements) {
      const c = new pg.Client({ connectionString: workerUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [org.orgId, agentActor.agentId, agentActor.runId]);
        await expect(c.query(sqlText, params)).rejects.toThrow(/AGENT_FORBIDDEN|row-level security|permission denied/);
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        await c.end();
      }
    }
  });

  it('scopes tasks by legal entity (le_scope) while keeping project visible and reporting hiddenByEntityCount (AC 4)', async () => {
    const owner = await newPerson('le-owner');
    const branchAccountant = await newPerson('le-accountant');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Đa pháp nhân');

    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: branchAccountant.email, role: 'member' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless('kernel.member.invite.accept', { token: inv.acceptPath.split('#')[1] }, { actor: asUser(branchAccountant.userId) });

    let defaultEntityId = '';
    let branchEntityId = '';
    await withAdmin(async (c) => {
      defaultEntityId = (
        await c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [org.orgId])
      ).rows[0]?.id as string;
      branchEntityId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Đà Nẵng', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, branchAccountant.userId, branchEntityId, owner.userId],
      );
    });

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Kiểm toán liên chi nhánh',
    });
    // Seed tasks with explicit entity tags directly at insert (legal_entity_id is immutable on UPDATE), then attach to project.
    let defaultTaskId = '';
    let unattachedHiddenTaskId = '';
    let branchTaskId = '';
    await withAdmin(async (c) => {
      defaultTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Bút toán trụ sở chính', 'human', 'user', $2) RETURNING id`,
          [org.orgId, defaultEntityId],
        )
      ).rows[0]?.id as string;
      unattachedHiddenTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Bút toán trụ sở chưa gắn', 'human', 'user', $2) RETURNING id`,
          [org.orgId, defaultEntityId],
        )
      ).rows[0]?.id as string;
      branchTaskId = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Bút toán chi nhánh Đà Nẵng', 'human', 'user', $2) RETURNING id`,
          [org.orgId, branchEntityId],
        )
      ).rows[0]?.id as string;
    });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: defaultTaskId });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: branchTaskId });
    const { taskId: orgWideTaskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Việc chung toàn công ty',
      assigneePositionId: null,
    });

    const ownerBoard = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(ownerBoard.tasks).toHaveLength(3);
    expect(ownerBoard.hiddenByEntityCount).toBe(0);

    const scopedBoard = await query<ProjectBoard>(branchAccountant.userId, org.orgId, 'projects.board', { projectId });
    expect(scopedBoard.project.id).toBe(projectId);
    expect(scopedBoard.tasks.map((t) => t.id).sort()).toEqual([branchTaskId, orgWideTaskId].sort());
    expect(scopedBoard.tasks.map((t) => t.title)).not.toContain('Bút toán trụ sở chính');
    expect(scopedBoard.totalVisible).toBe(2);
    expect(scopedBoard.hiddenByEntityCount).toBe(1);

    // Scoped member gets identical TASK_NOT_FOUND whether the hidden task is linked to the project or not.
    await expect(exec(branchAccountant.userId, org.orgId, 'projects.task.remove', { projectId, taskId: defaultTaskId })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(exec(branchAccountant.userId, org.orgId, 'projects.task.remove', { projectId, taskId: unattachedHiddenTaskId })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  it('includes projects in org export, redacts PII on PDPL erase, and purges projects before tasks cleanly (AC 5)', async () => {
    const owner = await newPerson('purge-owner');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Lưu trữ');
    const targetEmail = 'person.alpha@projects.test';

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: `Hồ sơ của ${targetEmail}`,
      description: `Liên hệ ${targetEmail}`,
    });
    const { taskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Dọn dẹp hồ sơ',
      assigneePositionId: null,
    });

    // PDPL lookup finds both name and description, and erase redacts them.
    const found = await rt.execute<PersonalDataResult>('kernel.personal_data.find', { value: targetEmail }, { actor: asUser(owner.userId), orgId: org.orgId });
    expect(found.matches.map((m) => m.column)).toEqual(
      expect.arrayContaining(['crove_projects.project.name', 'crove_projects.project.description']),
    );
    const erased = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: targetEmail },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    expect(erased.erased.some((r) => r.column === 'crove_projects.project.name' && r.rows === 1)).toBe(true);
    expect(erased.erased.some((r) => r.column === 'crove_projects.project.description' && r.rows === 1)).toBe(true);

    // Org export includes all three projects.* tables.
    expect(EXPORT_TABLE_NAMES).toEqual(expect.arrayContaining(['projects.project', 'projects.project_member', 'projects.project_task']));
    const generatedAt = new Date(Date.now() - 35 * DAY);
    const record = await runOrgExport({ runtime: workerRt, store, sealer, retentionDays: 40 }, org.orgId, { now: () => generatedAt });
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const readExportRows = async (tableName: string) => {
      const part = record.parts.find((p) => p.table === tableName)!;
      expect(part).toBeDefined();
      const raw = await store.get(part.key);
      return decode(sealer.open(raw, exportAad(org.orgId, part), 'aes-256-gcm'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    };
    expect(await readExportRows('projects.project')).toHaveLength(1);
    expect(await readExportRows('projects.project_member')).toHaveLength(1);
    expect(await readExportRows('projects.project_task')).toEqual([expect.objectContaining({ project_id: projectId, task_id: taskId })]);

    const exportView = await query<OrgExportView>(owner.userId, org.orgId, 'kernel.org.export.get');
    expect(exportView.export?.tables.find((t) => t.table === 'projects.project')?.rows).toBe(1);

    // PDPL erase on a 200-char project name whose +2 redaction expansion to 8-char '[đã xóa]' truncates right after whitespace must btrim cleanly (#2591 review).
    const shortEmail = 'a@test';
    const edgeName = `${shortEmail} ${'x'.repeat(200 - shortEmail.length - 4)} yy`;
    expect(edgeName).toHaveLength(200);
    const { projectId: edgeProjectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: edgeName,
    });
    const { positionId: archivedSeatId } = await rt.execute<{ positionId: string }>(
      'kernel.position.create',
      { title: 'Vị trí cũ', module: 'projects', roleKey: 'project_lead' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await exec(owner.userId, org.orgId, 'projects.task.create', {
      projectId: edgeProjectId,
      title: 'Việc gắn vị trí sắp lưu trữ',
      assigneePositionId: archivedSeatId,
    });
    await rt.execute(
      'kernel.position.update',
      { id: archivedSeatId, status: 'archived' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: shortEmail },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const edgeBoard = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId: edgeProjectId });
    expect(edgeBoard.project.name).toBe(`[đã xóa] ${'x'.repeat(190)}`);
    expect(edgeBoard.project.name.length).toBeLessThanOrEqual(200);
    expect(edgeBoard.project.name).toBe(edgeBoard.project.name.trim());
    expect(edgeBoard.seats.find((s) => s.id === archivedSeatId)).toMatchObject({ id: archivedSeatId, status: 'archived', title: 'Vị trí cũ' });

    // Offboard and backdate audit events so org_purge closes & purges the org, deleting projects before tasks.
    await rt.execute('kernel.org.offboard', { confirmSlug: org.slug }, { actor: asMfa(owner.userId), orgId: org.orgId });
    await withAdmin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(
        `UPDATE crove_kernel.audit_event
         SET occurred_at = $1
         WHERE org_id = $2 AND command IN ('kernel.org.offboard', 'kernel.org.export.record')`,
        [new Date(Date.now() - 32 * DAY), org.orgId],
      );
      await c.query('COMMIT');
    });
    const purged = await purgeOrg(workerRt, 30, { ref: org.orgId, reason: 'projects-p2-test' });
    expect(purged).toMatchObject({ kind: 'purged', orgId: org.orgId });

    await withAdmin(async (c) => {
      for (const tbl of ['crove_projects.project', 'crove_projects.project_member', 'crove_projects.project_task', 'crove_kernel.task']) {
        const { rows } = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tbl} WHERE org_id = $1`, [org.orgId]);
        expect(rows[0]?.n, tbl).toBe('0');
      }
    });
  });

  it('answers 404 on /api/rpc/projects/* when projects module is off while kernel tasks keep working (AC 6)', async () => {
    const owner = await newPerson('rpc-owner');
    const created = await rpc('full', 'org/create', owner, { name: 'Công ty Công tắc', idempotencyKey: randomUUID() });
    expect(created.status).toBe(200);
    const orgSlug = String(created.body?.slug);

    expect((await rpc('full', 'projects/list', owner, {}, orgSlug)).status).toBe(200);

    // Without projects in CROVE_MODULES: every projects RPC returns 404, while kernel tasks still create and list.
    expect((await rpc('withoutProjects', 'projects/list', owner, {}, orgSlug)).status).toBe(404);
    expect((await rpc('withoutProjects', 'projects/create', owner, { name: 'Off', idempotencyKey: randomUUID() }, orgSlug)).status).toBe(404);
    expect((await rpc('withoutProjects', 'projects/board', owner, { projectId: randomUUID() }, orgSlug)).status).toBe(404);

    const createdTask = await rpc('withoutProjects', 'tasks/create', owner, {
      title: 'Việc không bật Dự án',
      assigneePositionId: null,
      idempotencyKey: randomUUID(),
    }, orgSlug);
    expect(createdTask.status).toBe(200);
    const listedTasks = await rpc('withoutProjects', 'tasks/list', owner, {}, orgSlug);
    expect(listedTasks.status).toBe(200);
    expect(listedTasks.body).toEqual(expect.arrayContaining([expect.objectContaining({ title: 'Việc không bật Dự án' })]));
  });
});

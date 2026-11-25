// SPDX-License-Identifier: AGPL-3.0-only
// Self-contained PostgreSQL 17 security invariants for @ludy/mod-projects (#3445, follow-up from #2610 / PR #3438):
//   1) projects.task.reorder: writer RBAC, archive guard, project membership, private-project visibility, le_scope, and ctx.agent refusal
//   2) projects.board & projects.*: cross-org isolation, viewer read-only RBAC, private-project isolation, le_scope + hiddenByEntityCount, archive lock
//   3) ctx.agent boundary across projects commands/queries and direct SQL writes to ludy_projects.* tables
//   4) kernel.task.list / kernel.task.get: caller le_scope, cross-org isolation, and ctx.agent taint/position/saved-view filter boundaries
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelManifest, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { FilterAst, ProjectBoard, ProjectDetail, ProjectListResult } from '@ludy/kernel-contract';
import { Runtime, type AgentActor } from '@ludy/kernel-runtime';
import { projectsCommands, projectsManifest, projectsQueries } from '../../src/index.ts';

type Pool = ReturnType<typeof createPool>;
interface QueryClient {
  query: Pool['query'];
}

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface TaskListRow {
  id: string;
  title: string;
  status: string;
  assigneePositionId: string | null;
  tainted: boolean;
}

suite('projects RBAC, le_scope, archive-guard, and ctx.agent invariants (#3445)', () => {
  const dbName = `crove_test_proj_inv_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminPool: Pool | undefined;
  let appPool: Pool | undefined;
  let workerPool: Pool | undefined;
  let db: Db;
  let rt: Runtime;
  let workerRt: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (c: QueryClient) => Promise<T>): Promise<T> {
    const client = await adminPool!.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async function newPerson(tag: string) {
    const email = `${tag}-${randomUUID().slice(0, 8)}@projects-inv.test`;
    const userId = await upsertIdentity(db, { issuer: 'crove-auth', subject: randomUUID(), email, name: `User ${tag}` });
    return { email, userId };
  }

  async function inviteAndAccept(ownerId: string, orgId: string, email: string, userId: string, role: 'admin' | 'member' | 'viewer') {
    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email, role },
      { actor: asMfa(ownerId), orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless('kernel.member.invite.accept', { token: inv.acceptPath.split('#')[1] }, { actor: asUser(userId) });
  }

  async function seedLiveAgentRun(opts: {
    orgId: string;
    createdBy: string;
    tainted?: boolean;
    leScope?: readonly string[];
  }): Promise<{ agentId: string; positionId: string; runId: string; actor: AgentActor }> {
    const agentId = randomUUID();
    const positionId = randomUUID();
    const runId = randomUUID();
    const leScope = opts.leScope ? [...opts.leScope] : ['*'];
    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO ludy_kernel.agent (org_id, id, template_key, display_name, kind, max_risk, status, created_by)
         VALUES ($1, $2, 'finance.chief_accountant', $3, 'org_chart', 'R1', 'active', $4)`,
        [opts.orgId, agentId, `Agent-${agentId.slice(0, 8)}`, opts.createdBy],
      );
      await c.query(
        `INSERT INTO ludy_kernel.position (org_id, id, title, module, role_key, holder_agent_id, le_scope, status)
         VALUES ($1, $2, 'Kế toán trưởng (AI)', 'finance', 'finance.chief_accountant', $3, $4::text[], 'active')`,
        [opts.orgId, positionId, agentId, leScope],
      );
      await c.query(
        `INSERT INTO ludy_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at)
         VALUES ($1, $2, $3, 'finance', 'running', $4, now(), now() + interval '30 minutes')`,
        [opts.orgId, runId, agentId, opts.tainted ?? false],
      );
    });
    return {
      agentId,
      positionId,
      runId,
      actor: { type: 'agent', agentId, runId },
    };
  }

  const exec = <T>(userId: string, orgId: string, command: string, input: unknown) =>
    rt.execute<T>(command, input, { actor: asUser(userId), orgId, idempotencyKey: randomUUID() });

  const query = <T>(userId: string, orgId: string, name: string, input: unknown = {}) =>
    rt.query<T>(name, input, { actor: asUser(userId), orgId });

  beforeAll(async () => {
    const root = createPool({ connectionString: ADMIN as string, max: 1 });
    try {
      await root.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await root.end();
    }

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    const adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'proj-inv-app-pw', ludy_worker: 'proj-inv-worker-pw' });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'proj-inv-app-pw';
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'proj-inv-worker-pw';

    adminPool = createPool({ connectionString: adminUrl, max: 2 });
    appPool = createPool({ connectionString: appUrl.toString(), max: 6 });
    workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });

    const manifests = [kernelManifest.tables, projectsManifest.tables];
    db = createDb(appPool);
    rt = new Runtime(db, { manifests, stepUp: 'required' }).register({
      commands: [...kernelCommands, ...projectsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests }).register({
      commands: [...kernelCommands, ...projectsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([appPool?.end(), workerPool?.end(), adminPool?.end()]);
    if (!ADMIN) return;
    const root = createPool({ connectionString: ADMIN, max: 1 });
    try {
      await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    } finally {
      await root.end();
    }
  });

  it('enforces writer role, archive guard, project membership, private visibility, and le_scope on projects.task.reorder', async () => {
    const owner = await newPerson('reorder-owner');
    const admin = await newPerson('reorder-admin');
    const viewer = await newPerson('reorder-viewer');
    const branchMember = await newPerson('reorder-branch');
    const outsider = await newPerson('reorder-outsider');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Bảo mật Sắp xếp');
    const otherOrg = await createOrg(rt, asUser(outsider.userId), 'Công ty Khác');

    await inviteAndAccept(owner.userId, org.orgId, admin.email, admin.userId, 'admin');
    await inviteAndAccept(owner.userId, org.orgId, viewer.email, viewer.userId, 'viewer');
    await inviteAndAccept(owner.userId, org.orgId, branchMember.email, branchMember.userId, 'member');

    let leA = '';
    let leB = '';
    let tA1 = '';
    let tA2 = '';
    let tB = '';
    await withAdmin(async (c) => {
      leA = (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [org.orgId])).rows[0]
        ?.id as string;
      leB = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh B', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, branchMember.userId, leA, owner.userId],
      );
      tA1 = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Việc A1', 'human', 'user', $2) RETURNING id`,
          [org.orgId, leA],
        )
      ).rows[0]?.id as string;
      tA2 = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Việc A2', 'human', 'user', $2) RETURNING id`,
          [org.orgId, leA],
        )
      ).rows[0]?.id as string;
      tB = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Việc B bí mật', 'human', 'user', $2) RETURNING id`,
          [org.orgId, leB],
        )
      ).rows[0]?.id as string;
    });

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', { name: 'Dự án LE' });
    const { projectId: otherProjectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án khác',
    });
    const { taskId: tOtherProj } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId: otherProjectId,
      title: 'Việc dự án 2',
      assigneePositionId: null,
    });

    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: tA1 });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: tB });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: tA2 });

    // Viewer cannot reorder (403 FORBIDDEN).
    await expect(
      exec(viewer.userId, org.orgId, 'projects.task.reorder', { projectId, taskId: tA2, place: 'before', anchorId: tA1 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Live ctx.agent cannot reorder on either workerRt (authorizeAgent refusal) or appRt (worker-only entry).
    const seededAgent = await seedLiveAgentRun({ orgId: org.orgId, createdBy: owner.userId });
    await expect(
      workerRt.execute(
        'projects.task.reorder',
        { projectId, taskId: tA2, place: 'before', anchorId: tA1 },
        { actor: seededAgent.actor, orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      rt.execute(
        'projects.task.reorder',
        { projectId, taskId: tA2, place: 'before', anchorId: tA1 },
        { actor: seededAgent.actor, orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ status: 403 });

    // Cross-org, self-anchor, and wrong-project task are rejected.
    await expect(
      exec(outsider.userId, otherOrg.orgId, 'projects.task.reorder', { projectId, taskId: tA2, place: 'before', anchorId: tA1 }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.reorder', { projectId, taskId: tA1, place: 'before', anchorId: tA1 }),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.reorder', { projectId, taskId: tA1, place: 'before', anchorId: tOtherProj }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });

    // le_scope: branchMember cannot see or reorder against tB, but CAN reorder visible tA2 before tA1.
    await expect(
      exec(branchMember.userId, org.orgId, 'projects.task.reorder', { projectId, taskId: tB, place: 'before', anchorId: tA1 }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });
    await expect(
      exec(branchMember.userId, org.orgId, 'projects.task.reorder', { projectId, taskId: tA1, place: 'after', anchorId: tB }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });

    await exec(branchMember.userId, org.orgId, 'projects.task.reorder', { projectId, taskId: tA2, place: 'before', anchorId: tA1 });
    const branchBoard = await query<ProjectBoard>(branchMember.userId, org.orgId, 'projects.board', { projectId });
    expect(branchBoard.hiddenByEntityCount).toBe(1);
    expect(branchBoard.tasks.map((t) => t.title)).toEqual(['Việc A2', 'Việc A1']);

    // Owner still sees all three tasks including hidden tB.
    const ownerBoard = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(ownerBoard.tasks.map((t) => t.id)).toContain(tB);

    // Private project reorder: non-member member gets opaque PROJECT_NOT_FOUND, while admin can reorder.
    const { projectId: privateProjectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án riêng tư',
      visibility: 'private',
    });
    const { taskId: pTask1 } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId: privateProjectId,
      title: 'Riêng tư 1',
      assigneePositionId: null,
    });
    const { taskId: pTask2 } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId: privateProjectId,
      title: 'Riêng tư 2',
      assigneePositionId: null,
    });
    await expect(
      exec(branchMember.userId, org.orgId, 'projects.task.reorder', {
        projectId: privateProjectId,
        taskId: pTask2,
        place: 'before',
        anchorId: pTask1,
      }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });
    await exec(admin.userId, org.orgId, 'projects.task.reorder', {
      projectId: privateProjectId,
      taskId: pTask2,
      place: 'before',
      anchorId: pTask1,
    });

    // Archived project blocks reorder.
    await exec(owner.userId, org.orgId, 'projects.project.archive', { projectId });
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.reorder', { projectId, taskId: tA1, place: 'before', anchorId: tA2 }),
    ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED', status: 409 });
  });

  it('enforces cross-org isolation, RBAC, private visibility, archive lock, and le_scope on projects.board and projects commands', async () => {
    const owner = await newPerson('board-owner');
    const admin = await newPerson('board-admin');
    const member = await newPerson('board-member');
    const branchMember = await newPerson('board-branch');
    const viewer = await newPerson('board-viewer');
    const outsider = await newPerson('board-outsider');

    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Bảng dự án');
    const otherOrg = await createOrg(rt, asUser(outsider.userId), 'Công ty Ngoài');

    await inviteAndAccept(owner.userId, org.orgId, admin.email, admin.userId, 'admin');
    await inviteAndAccept(owner.userId, org.orgId, member.email, member.userId, 'member');
    await inviteAndAccept(owner.userId, org.orgId, branchMember.email, branchMember.userId, 'member');
    await inviteAndAccept(owner.userId, org.orgId, viewer.email, viewer.userId, 'viewer');

    let leA = '';
    let leB = '';
    let tLeA = '';
    let tLeBAttached = '';
    let tLeBUnattached = '';
    await withAdmin(async (c) => {
      leA = (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [org.orgId])).rows[0]
        ?.id as string;
      leB = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh HCM', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, branchMember.userId, leA, owner.userId],
      );
      tLeA = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Việc trụ sở', 'human', 'user', $2) RETURNING id`,
          [org.orgId, leA],
        )
      ).rows[0]?.id as string;
      tLeBAttached = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Việc chi nhánh gắn dự án', 'human', 'user', $2) RETURNING id`,
          [org.orgId, leB],
        )
      ).rows[0]?.id as string;
      tLeBUnattached = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Việc chi nhánh chưa gắn', 'human', 'user', $2) RETURNING id`,
          [org.orgId, leB],
        )
      ).rows[0]?.id as string;
    });

    const { projectId } = await exec<{ projectId: string }>(member.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án chung',
      ownerUserId: member.userId,
    });
    const { taskId: orgWideTaskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Việc toàn công ty',
      assigneePositionId: null,
    });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: tLeA });
    await exec(owner.userId, org.orgId, 'projects.task.add', { projectId, taskId: tLeBAttached });

    const { projectId: privateProjectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án mật',
      visibility: 'private',
    });

    // Cross-org isolation.
    const outsiderList = await query<ProjectListResult>(outsider.userId, otherOrg.orgId, 'projects.project.list');
    expect(outsiderList.projects).toEqual([]);
    await expect(query(outsider.userId, otherOrg.orgId, 'projects.project.get', { id: projectId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    await expect(query(outsider.userId, otherOrg.orgId, 'projects.board', { projectId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    await expect(
      exec(outsider.userId, otherOrg.orgId, 'projects.task.remove', { projectId, taskId: tLeA }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND', status: 404 });

    // Viewer RBAC: read-only on org project, blocked from all writes, and cannot be made project owner.
    const viewerList = await query<ProjectListResult>(viewer.userId, org.orgId, 'projects.project.list');
    expect(viewerList.canWrite).toBe(false);
    expect(viewerList.projects.map((p) => p.id)).toEqual([projectId]);
    const viewerBoard = await query<ProjectBoard>(viewer.userId, org.orgId, 'projects.board', { projectId });
    expect(viewerBoard.project.canWrite).toBe(false);
    expect(viewerBoard.project.canManage).toBe(false);
    await expect(exec(viewer.userId, org.orgId, 'projects.project.create', { name: 'Blocked' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(
      exec(viewer.userId, org.orgId, 'projects.task.create', { projectId, title: 'Blocked', assigneePositionId: null }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(exec(viewer.userId, org.orgId, 'projects.task.remove', { projectId, taskId: tLeA })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(exec(viewer.userId, org.orgId, 'projects.project.archive', { projectId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    await expect(
      exec(owner.userId, org.orgId, 'projects.project.set_owner', { projectId, ownerUserId: viewer.userId }),
    ).rejects.toMatchObject({ code: 'PROJECT_OWNER_FORBIDDEN' });

    // Non-owner member cannot manage project metadata, members, or archive status (owner of project is `member`).
    await expect(
      exec(branchMember.userId, org.orgId, 'projects.project.update', { projectId, name: 'Unauthorized rename' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      exec(branchMember.userId, org.orgId, 'projects.member.add', { projectId, userId: branchMember.userId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(exec(branchMember.userId, org.orgId, 'projects.project.archive', { projectId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });

    // Non-member (even writer member) cannot list or read private project; added member and org admin can.
    const memberList = await query<ProjectListResult>(member.userId, org.orgId, 'projects.project.list');
    expect(memberList.projects.map((p) => p.id)).toEqual([projectId]);
    await expect(query(member.userId, org.orgId, 'projects.project.get', { id: privateProjectId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    await expect(query(member.userId, org.orgId, 'projects.board', { projectId: privateProjectId })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    const adminPrivateBoard = await query<ProjectBoard>(admin.userId, org.orgId, 'projects.board', { projectId: privateProjectId });
    expect(adminPrivateBoard.project.id).toBe(privateProjectId);

    // le_scope on projects.board (including with FilterAst) and identical 404 oracle on projects.task.remove.
    const ownerBoard = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId });
    expect(ownerBoard.tasks).toHaveLength(3);
    expect(ownerBoard.hiddenByEntityCount).toBe(0);

    const branchBoard = await query<ProjectBoard>(branchMember.userId, org.orgId, 'projects.board', {
      projectId,
      filters: { v: 1, all: [{ field: 'search', op: 'contains', value: 'chi nhánh' }] } satisfies FilterAst,
    });
    expect(branchBoard.tasks).toEqual([]);
    expect(branchBoard.hiddenByEntityCount).toBe(1);

    const branchBoardAll = await query<ProjectBoard>(branchMember.userId, org.orgId, 'projects.board', { projectId });
    expect(branchBoardAll.tasks.map((t) => t.id).sort()).toEqual([orgWideTaskId, tLeA].sort());
    expect(branchBoardAll.totalVisible).toBe(2);
    expect(branchBoardAll.hiddenByEntityCount).toBe(1);

    await expect(
      exec(branchMember.userId, org.orgId, 'projects.task.remove', { projectId, taskId: tLeBAttached }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });
    await expect(
      exec(branchMember.userId, org.orgId, 'projects.task.remove', { projectId, taskId: tLeBUnattached }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });

    // Archive guard freezes mutations.
    await exec(owner.userId, org.orgId, 'projects.project.archive', { projectId });
    const archivedDetail = await query<ProjectDetail>(owner.userId, org.orgId, 'projects.project.get', { id: projectId });
    expect(archivedDetail.canWrite).toBe(false);
    await expect(
      exec(owner.userId, org.orgId, 'projects.project.update', { projectId, name: 'After archive' }),
    ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED', status: 409 });
    await expect(
      exec(owner.userId, org.orgId, 'projects.task.create', { projectId, title: 'Late task', assigneePositionId: null }),
    ).rejects.toMatchObject({ code: 'PROJECT_ARCHIVED', status: 409 });
    await expect(exec(owner.userId, org.orgId, 'projects.task.remove', { projectId, taskId: tLeA })).rejects.toMatchObject({
      code: 'PROJECT_ARCHIVED',
      status: 409,
    });
  });

  it('refuses ctx.agent across projects commands, queries, and direct ludy_projects SQL writes', async () => {
    const owner = await newPerson('agent-guard-owner');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Giới hạn AI');
    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', { name: 'Agent Guard' });
    const { taskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Việc mẫu',
      assigneePositionId: null,
    });
    const { taskId: attachedTaskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Việc trong dự án',
      assigneePositionId: null,
    });

    const { actor: agentActor } = await seedLiveAgentRun({ orgId: org.orgId, createdBy: owner.userId });

    // Catalog-wide invariant: no projects.* command or query opens ctx.agent or ctx.memberVy access.
    expect(projectsCommands.filter((c) => c.agent !== undefined || c.memberVy !== undefined)).toEqual([]);
    expect(projectsQueries.filter((q) => q.agent !== undefined || q.memberVy !== undefined)).toEqual([]);

    // Every projects.* command & query rejects an active agent actor inside workerRt (real enter_agent_context).
    await expect(
      workerRt.execute('projects.project.create', { name: 'By agent' }, { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      workerRt.execute(
        'projects.task.create',
        { projectId, title: 'By agent', assigneePositionId: null },
        { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      workerRt.execute(
        'projects.task.add',
        { projectId, taskId },
        { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      workerRt.execute(
        'projects.task.remove',
        { projectId, taskId: attachedTaskId },
        { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      workerRt.execute(
        'projects.project.update',
        { projectId, name: 'Tampered' },
        { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    for (const [qName, qInput] of [
      ['projects.project.list', {}],
      ['projects.project.get', { id: projectId }],
      ['projects.board', { projectId }],
      ['projects.unassigned_tasks', {}],
      ['projects.task_projects', { taskIds: [attachedTaskId] }],
    ] as const) {
      await expect(workerRt.query(qName, qInput, { actor: agentActor, orgId: org.orgId })).rejects.toMatchObject({
        code: 'FORBIDDEN',
        status: 403,
      });
    }

    // Direct SQL inside ludy_worker enter_agent_context fails closed on INSERT, UPDATE, and DELETE on ludy_projects.*.
    const statements: Array<[string, unknown[]]> = [
      ['INSERT INTO ludy_projects.project (org_id, name, created_by) VALUES ($1, $2, $3)', [org.orgId, 'Direct', owner.userId]],
      ['INSERT INTO ludy_projects.project_member (org_id, project_id, user_id) VALUES ($1, $2, $3)', [org.orgId, projectId, owner.userId]],
      ['INSERT INTO ludy_projects.project_task (org_id, project_id, task_id, added_by) VALUES ($1, $2, $3, $4)', [org.orgId, projectId, taskId, owner.userId]],
      ['INSERT INTO ludy_projects.project_column (org_id, project_id, name, task_status, sort_key) VALUES ($1, $2, $3, $4, $5)', [org.orgId, projectId, 'Hack', 'todo', 'a0']],
      ['UPDATE ludy_projects.project SET name = $3 WHERE org_id = $1 AND id = $2', [org.orgId, projectId, 'Hijacked']],
      ['DELETE FROM ludy_projects.project_task WHERE org_id = $1 AND project_id = $2', [org.orgId, projectId]],
    ];
    for (const [sqlText, params] of statements) {
      const c = await workerPool!.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT ludy_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [org.orgId, agentActor.agentId, agentActor.runId]);
        await expect(c.query(sqlText, params)).rejects.toMatchObject({ code: '42501', message: 'AGENT_FORBIDDEN' });
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    }
  });

  it('enforces kernel.task.list and kernel.task.get caller le_scope, cross-org, and ctx.agent boundaries', async () => {
    const owner = await newPerson('task-owner');
    const branchMember = await newPerson('task-branch');
    const outsider = await newPerson('task-outsider');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty ranh giới Việc');
    const otherOrg = await createOrg(rt, asUser(outsider.userId), 'Công ty Ngoài Việc');

    await inviteAndAccept(owner.userId, org.orgId, branchMember.email, branchMember.userId, 'member');

    let leA = '';
    let leB = '';
    await withAdmin(async (c) => {
      leA = (await c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [org.orgId])).rows[0]
        ?.id as string;
      leB = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh Miền Trung', 'branch', $2) RETURNING id`,
          [org.orgId, owner.userId],
        )
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [org.orgId, branchMember.userId, leA, owner.userId],
      );
    });

    const { positionId: posOther } = await rt.execute<{ positionId: string }>(
      'kernel.position.create',
      { title: 'Trưởng nhóm', module: 'projects', roleKey: 'member' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const cleanAgent = await seedLiveAgentRun({ orgId: org.orgId, createdBy: owner.userId, tainted: false, leScope: [leA] });
    const taintedAgent = await seedLiveAgentRun({ orgId: org.orgId, createdBy: owner.userId, tainted: true, leScope: [leA] });

    let tAgentClean = '';
    let tAgentTainted = '';
    let tAgentHiddenLe = '';
    let tOtherSeat = '';
    let tUnassigned = '';
    let tOrgWide = '';
    let tTaintedSeatTainted = '';
    await withAdmin(async (c) => {
      tAgentClean = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, assignee_position_id, tainted)
           VALUES ($1, 'Việc sạch của AI', 'human', 'user', $2, $3, false) RETURNING id`,
          [org.orgId, leA, cleanAgent.positionId],
        )
      ).rows[0]?.id as string;
      tAgentTainted = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, assignee_position_id, tainted)
           VALUES ($1, 'Việc AI nhiễm bẩn', 'human', 'user', $2, $3, true) RETURNING id`,
          [org.orgId, leA, cleanAgent.positionId],
        )
      ).rows[0]?.id as string;
      tAgentHiddenLe = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, assignee_position_id, tainted)
           VALUES ($1, 'Việc chi nhánh khác của AI', 'human', 'user', $2, $3, false) RETURNING id`,
          [org.orgId, leB, cleanAgent.positionId],
        )
      ).rows[0]?.id as string;
      tOtherSeat = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, assignee_position_id, tainted)
           VALUES ($1, 'Việc ghế khác', 'human', 'user', $2, $3, false) RETURNING id`,
          [org.orgId, leA, posOther],
        )
      ).rows[0]?.id as string;
      tUnassigned = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, assignee_position_id, tainted)
           VALUES ($1, 'Việc chưa giao', 'human', 'user', $2, NULL, false) RETURNING id`,
          [org.orgId, leA],
        )
      ).rows[0]?.id as string;
      tOrgWide = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, assignee_position_id, tainted)
           VALUES ($1, 'Việc chung toàn công ty', 'human', 'user', NULL, NULL, false) RETURNING id`,
          [org.orgId],
        )
      ).rows[0]?.id as string;
      const taintedRows = await c.query<{ id: string; tainted: boolean }>(
        `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id, assignee_position_id, tainted)
         VALUES ($1, 'Việc sạch ghế bẩn', 'human', 'user', $2, $3, false),
                ($1, 'Việc bẩn ghế bẩn', 'human', 'user', $2, $3, true)
         RETURNING id, tainted`,
        [org.orgId, leA, taintedAgent.positionId],
      );
      tTaintedSeatTainted = taintedRows.rows.find((r) => r.tainted)?.id as string;
    });

    // Untainted agent run sees ONLY untainted tasks assigned to its own position within its le_scope,
    // never tainted tasks, unassigned tasks, other seats, or other legal entities even when saved-view filters or positionId ask for them.
    const cleanDefault = await workerRt.query<{ tasks: TaskListRow[] }>('kernel.task.list', {}, { actor: cleanAgent.actor, orgId: org.orgId });
    expect(cleanDefault.tasks.map((t) => t.id)).toEqual([tAgentClean]);

    const cleanTaintedFilter = await workerRt.query<{ tasks: TaskListRow[] }>(
      'kernel.task.list',
      { filters: { v: 1, all: [{ field: 'tainted', op: 'is', value: true }] } satisfies FilterAst },
      { actor: cleanAgent.actor, orgId: org.orgId },
    );
    expect(cleanTaintedFilter.tasks).toEqual([]);

    const cleanUnassignedFilter = await workerRt.query<{ tasks: TaskListRow[] }>(
      'kernel.task.list',
      { filters: { v: 1, all: [{ field: 'assignee', op: 'is_empty' }] } satisfies FilterAst },
      { actor: cleanAgent.actor, orgId: org.orgId },
    );
    expect(cleanUnassignedFilter.tasks).toEqual([]);

    const cleanOtherSeatAttempt = await workerRt.query<{ tasks: TaskListRow[] }>(
      'kernel.task.list',
      { positionId: posOther },
      { actor: cleanAgent.actor, orgId: org.orgId },
    );
    expect(cleanOtherSeatAttempt.tasks).toEqual([expect.objectContaining({ id: tAgentClean })]);

    const cleanGetOwn = await workerRt.query<{ task: { id: string } }>(
      'kernel.task.get',
      { id: tAgentClean },
      { actor: cleanAgent.actor, orgId: org.orgId },
    );
    expect(cleanGetOwn.task.id).toBe(tAgentClean);
    for (const forbiddenTaskId of [tAgentTainted, tAgentHiddenLe, tOtherSeat, tUnassigned]) {
      await expect(
        workerRt.query('kernel.task.get', { id: forbiddenTaskId }, { actor: cleanAgent.actor, orgId: org.orgId }),
      ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });
    }

    // Tainted agent run sees tainted tasks on its own seat, still never other seats or unassigned tasks.
    const taintedList = await workerRt.query<{ tasks: TaskListRow[] }>(
      'kernel.task.list',
      { positionId: posOther },
      { actor: taintedAgent.actor, orgId: org.orgId },
    );
    expect(taintedList.tasks).toHaveLength(2);
    expect(taintedList.tasks.every((t) => t.assigneePositionId === taintedAgent.positionId)).toBe(true);
    const taintedGetOwn = await workerRt.query<{ task: { id: string } }>(
      'kernel.task.get',
      { id: tTaintedSeatTainted },
      { actor: taintedAgent.actor, orgId: org.orgId },
    );
    expect(taintedGetOwn.task.id).toBe(tTaintedSeatTainted);
    await expect(
      workerRt.query('kernel.task.get', { id: tOtherSeat }, { actor: taintedAgent.actor, orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'TASK_NOT_FOUND', status: 404 });

    // Caller le_scope on kernel.task.list and kernel.task.get: branchMember sees leA + org-wide, never leB.
    const branchTasks = await query<{ tasks: TaskListRow[] }>(branchMember.userId, org.orgId, 'kernel.task.list', {
      filters: { v: 1, all: [{ field: 'search', op: 'contains', value: 'việc' }] } satisfies FilterAst,
    });
    const branchIds = new Set(branchTasks.tasks.map((t) => t.id));
    expect(branchIds.has(tAgentClean)).toBe(true);
    expect(branchIds.has(tOtherSeat)).toBe(true);
    expect(branchIds.has(tUnassigned)).toBe(true);
    expect(branchIds.has(tOrgWide)).toBe(true);
    expect(branchIds.has(tAgentHiddenLe)).toBe(false);
    await expect(query(branchMember.userId, org.orgId, 'kernel.task.get', { id: tAgentHiddenLe })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      status: 404,
    });

    const ownerTasks = await query<{ tasks: TaskListRow[] }>(owner.userId, org.orgId, 'kernel.task.list', {});
    expect(ownerTasks.tasks.map((t) => t.id)).toContain(tAgentHiddenLe);
    const ownerGetHidden = await query<{ task: { id: string } }>(owner.userId, org.orgId, 'kernel.task.get', { id: tAgentHiddenLe });
    expect(ownerGetHidden.task.id).toBe(tAgentHiddenLe);

    // Cross-org isolation on kernel.task.list and kernel.task.get.
    const outsiderTasks = await query<{ tasks: TaskListRow[] }>(outsider.userId, otherOrg.orgId, 'kernel.task.list', {});
    expect(outsiderTasks.tasks).toEqual([]);
    await expect(query(outsider.userId, otherOrg.orgId, 'kernel.task.get', { id: tAgentClean })).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
      status: 404,
    });
  });
});

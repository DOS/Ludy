// SPDX-License-Identifier: AGPL-3.0-only
// Security invariants for task checklists (#2606):
// 1) Agents cannot mutate crove_kernel.task.checklist (AGENT_TASK_FIELD) or inject checklist steps on insert
//    (task_before_insert forces checklist = '[]'::jsonb).
// 2) Viewers cannot mutate checklists (403 FORBIDDEN); cross-org and legal-entity (le_scope) boundaries hide tasks
//    and their checklists across kernel.task.get, projects.board, and direct SQL.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { ProjectBoard } from '@ludy/kernel-contract';
import { Runtime, type AgentActor } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { enterUser } from './fixtures/context-token.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ISSUER = 'crove-auth-invariant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

suite('invariant (#2606): task checklist agent guardrails, cross-org RLS and le_scope', () => {
  const dbName = `crove_inv_checklist_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let appRt: Runtime;
  let workerRt: Runtime;

  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const, sessionId: randomUUID() });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: adminUrl }, dbIds);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function inUserContext<T>(userId: string, orgId: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: appUrl }, dbIds);
    await c.connect();
    try {
      await c.query('BEGIN');
      await enterUser(c, userId, orgId);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  async function inAgentContext<T>(orgId: string, actor: AgentActor, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = createDbClient({ connectionString: workerUrl }, dbIds);
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, actor.agentId, actor.runId]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }

  const newPerson = async (tag: string) => {
    const email = `${tag}-${randomUUID().slice(0, 8)}@inv-checklist.test`;
    const userId = await upsertIdentity(db, { issuer: ISSUER, subject: randomUUID(), email, name: `User ${tag}` });
    return { userId, email };
  };

  const exec = <T>(userId: string, orgId: string, command: string, input: unknown) =>
    appRt.execute<T>(command, input, { actor: asUser(userId), orgId, idempotencyKey: randomUUID() });

  const query = <T>(userId: string, orgId: string, name: string, input: unknown = {}) =>
    appRt.query<T>(name, input, { actor: asUser(userId), orgId });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);

    const uApp = new URL(adminUrl);
    uApp.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    uApp.password = 'test-app-pw';
    appUrl = uApp.toString();

    const uWorker = new URL(adminUrl);
    uWorker.username = dbIds ? dbIds.roleName('crove_worker') : 'crove_worker';
    uWorker.password = 'test-worker-pw';
    workerUrl = uWorker.toString();

    const appPool = createDbPool({ connectionString: appUrl, max: 4 }, dbIds);
    const workerPool = createDbPool({ connectionString: workerUrl, max: 4 }, dbIds);
    pools.push(appPool, workerPool);
    db = createDb(appPool);

    const opts = { manifests: TEST_MANIFESTS, entitlements: async () => ['full'] };
    const commands = [...kernelCommands, ...financeCommands, ...projectsCommands];
    const queries = [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...projectsQueries];
    appRt = new Runtime(db, opts).register({ commands, queries });
    workerRt = new Runtime(createDb(workerPool), opts).register({ commands, queries });
  }, 600_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('prevents agents from modifying checklist on update (AGENT_TASK_FIELD) or smuggling steps on insert', async () => {
    const owner = await newPerson('inv-agent-owner');
    const org = await createOrg(appRt, asUser(owner.userId), 'Invariant Agent Co');

    const installed = await appRt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Kế toán trưởng AI' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const { taskId } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'kernel.task.create', {
      title: 'Kiểm tra guard tác tử trên checklist',
      assigneePositionId: installed.positionId,
      checklist: [{ text: 'Bước gốc', done: false }],
    });

    const started = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: SYSTEM, orgId: org.orgId },
    );
    expect(started.runId).toBeTruthy();
    const actor: AgentActor = { type: 'agent', agentId: installed.agentId, runId: started.runId as string };

    await workerRt.execute('kernel.task.checkout', { id: taskId }, { actor, orgId: org.orgId, idempotencyKey: randomUUID() });

    await expect(
      inAgentContext(org.orgId, actor, (c) =>
        c.query(`UPDATE crove_kernel.task SET checklist = '[{"text":"Hack","done":true}]'::jsonb WHERE org_id = $1 AND id = $2`, [org.orgId, taskId]),
      ),
    ).rejects.toMatchObject({ code: '42501', message: 'AGENT_TASK_FIELD' });

    const escalationChecklist = await inAgentContext(org.orgId, actor, async (c) => {
      const { rows } = await c.query<{ checklist: unknown }>(
        `INSERT INTO crove_kernel.task (org_id, title, kind, assignee_position_id, parent_task_id, source, created_by_type, checklist)
         VALUES ($1, 'Xin ý kiến chủ sở hữu', 'escalation', NULL, $2, 'agent', 'agent', '[{"text":"Không được phép","done":false}]'::jsonb)
         RETURNING checklist`,
        [org.orgId, taskId],
      );
      return rows[0]?.checklist;
    });
    expect(escalationChecklist).toEqual([]);
  });

  it('enforces viewer denial, cross-org RLS and legal-entity (le_scope) boundaries on task checklists', async () => {
    const ownerA = await newPerson('inv-owner-a');
    const limitedA = await newPerson('inv-limited-a');
    const viewerA = await newPerson('inv-viewer-a');
    const ownerB = await newPerson('inv-owner-b');

    const orgA = await createOrg(appRt, asUser(ownerA.userId), 'Org A Checklist');
    const orgB = await createOrg(appRt, asUser(ownerB.userId), 'Org B Checklist');

    const entityB = await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`,
        [orgA.orgId, limitedA.userId, viewerA.userId],
      );
      const entities = await c.query<{ id: string }>(
        `SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 ORDER BY is_default DESC`,
        [orgA.orgId],
      );
      const defaultEntity = entities.rows[0]!.id;
      const insertedB = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh B', 'branch', $2) RETURNING id`,
        [orgA.orgId, ownerA.userId],
      );
      const branchB = insertedB.rows[0]!.id;
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [orgA.orgId, limitedA.userId, defaultEntity, ownerA.userId],
      );
      return branchB;
    });

    const { projectId } = await exec<{ projectId: string }>(ownerA.userId, orgA.orgId, 'projects.project.create', {
      name: 'Dự án phân quyền',
      memberUserIds: [limitedA.userId, viewerA.userId],
    });
    const taskInB = await withAdmin(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, legal_entity_id, checklist)
         VALUES ($1, 'Việc chi nhánh B', 'human', 'user', $2, '[{"text":"Bí mật chi nhánh B","done":false}]'::jsonb)
         RETURNING id`,
        [orgA.orgId, entityB],
      );
      return rows[0]!.id;
    });
    await exec(ownerA.userId, orgA.orgId, 'projects.task.add', { projectId, taskId: taskInB });

    await expect(
      exec(viewerA.userId, orgA.orgId, 'kernel.task.update', { id: taskInB, checklist: [] }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(query(ownerB.userId, orgB.orgId, 'kernel.task.get', { id: taskInB })).rejects.toMatchObject({ status: 404 });
    const crossRows = await inUserContext(ownerB.userId, orgB.orgId, (c) =>
      c.query(`SELECT id, checklist FROM crove_kernel.task WHERE id = $1`, [taskInB]),
    );
    expect(crossRows.rows).toHaveLength(0);

    await expect(query(limitedA.userId, orgA.orgId, 'kernel.task.get', { id: taskInB })).rejects.toMatchObject({ status: 404 });
    const limitedBoard = await query<ProjectBoard>(limitedA.userId, orgA.orgId, 'projects.board', { projectId });
    expect(limitedBoard.tasks.some((t) => t.id === taskInB)).toBe(false);
    const leSql = await inUserContext(limitedA.userId, orgA.orgId, (c) =>
      c.query(`SELECT id FROM crove_kernel.task WHERE org_id = $1 AND id = $2`, [orgA.orgId, taskInB]),
    );
    expect(leSql.rows).toHaveLength(0);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Security invariant suite for Issue #4821 (task.completed_by & done_at trigger + constraint guardrails):
// 1) User SQL inside enterUser cannot spoof completed_by on INSERT or UPDATE, nor retain completed_by on non-done status.
// 2) Non-done INSERT coerces completed_by to NULL via task_before_insert; bypassed triggers hit task_completed_by_done_only CHECK.
// 3) Agent direct SQL cannot write completed_by (AGENT_TASK_FIELD), and agent completion stamps done_at with completed_by = NULL.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { vietnamToday, type ProjectMemberCompletedTasksResult } from '@ludy/kernel-contract';
import { Runtime, type AgentActor } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { enterUser } from './fixtures/context-token.ts';
import {
  createDbClient,
  createDbPool,
  resolveDbIdentifiers,
  setActiveRolePasswords,
  type DbIdentifiers,
} from './fixtures/db-identifiers.ts';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const ISSUER = 'crove-auth-invariant';
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;

suite('task.completed_by security invariants (#4821)', () => {
  const dbName = `ludy_inv_done_by_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const pools: pg.Pool[] = [];
  let adminUrl = '';
  let workerUrl = '';
  let dbIds!: DbIdentifiers;
  let appPool!: pg.Pool;
  let db!: Db;
  let appRt!: Runtime;
  let workerRt!: Runtime;

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

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN as string });
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
    uApp.username = dbIds.roleName('crove_app');
    uApp.password = 'test-app-pw';
    const uWorker = new URL(adminUrl);
    uWorker.username = dbIds.roleName('crove_worker');
    uWorker.password = 'test-worker-pw';
    workerUrl = uWorker.toString();

    appPool = createDbPool({ connectionString: uApp.toString(), max: 4 }, dbIds);
    const workerPool = createDbPool({ connectionString: workerUrl, max: 2 }, dbIds);
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

  it('prevents user and agent spoofing of completed_by and enforces task_completed_by_done_only', async () => {
    const owner = await upsertIdentity(db, {
      issuer: ISSUER,
      subject: `owner-${randomUUID()}`,
      email: `owner-${randomUUID().slice(0, 8)}@inv.test`,
      name: 'Owner Inv',
    });
    const staffA = await upsertIdentity(db, {
      issuer: ISSUER,
      subject: `staff-a-${randomUUID()}`,
      email: `staffa-${randomUUID().slice(0, 8)}@inv.test`,
      name: 'Staff A Inv',
    });
    const staffB = await upsertIdentity(db, {
      issuer: ISSUER,
      subject: `staff-b-${randomUUID()}`,
      email: `staffb-${randomUUID().slice(0, 8)}@inv.test`,
      name: 'Staff B Inv',
    });
    const viewer = await upsertIdentity(db, {
      issuer: ISSUER,
      subject: `viewer-${randomUUID()}`,
      email: `viewer-${randomUUID().slice(0, 8)}@inv.test`,
      name: 'Viewer Inv',
    });
    const otherOwner = await upsertIdentity(db, {
      issuer: ISSUER,
      subject: `other-owner-${randomUUID()}`,
      email: `other-${randomUUID().slice(0, 8)}@inv.test`,
      name: 'Other Owner Inv',
    });

    const org = await createOrg(appRt, asUser(owner), 'Cong ty Invariant Completed By');
    const otherOrg = await createOrg(appRt, asUser(otherOwner), 'Cong ty Khac Inv');
    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
        [org.orgId, staffA, staffB, viewer],
      );
    });

    // 1. User SQL inside sealed context cannot spoof completed_by on INSERT or UPDATE,
    // and non-done status forces completed_by = NULL & done_at = NULL.
    const appClient = await appPool.connect();
    try {
      await appClient.query('BEGIN');
      await enterUser(appClient, staffA, org.orgId);

      const spoofDoneIns = await appClient.query<{ id: string; completed_by: string | null; done_at: Date | null }>(
        `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, status, completed_by)
         VALUES ($1, 'Spoofed done insert', 'human', 'user', 'done', $2)
         RETURNING id, completed_by, done_at`,
        [org.orgId, staffB],
      );
      expect(spoofDoneIns.rows[0]?.completed_by).toBe(staffA);
      expect(spoofDoneIns.rows[0]?.done_at).not.toBeNull();

      const spoofDoneUpd = await appClient.query<{ completed_by: string | null }>(
        `UPDATE crove_kernel.task
            SET completed_by = $1
          WHERE org_id = $2 AND id = $3
          RETURNING completed_by`,
        [staffB, org.orgId, spoofDoneIns.rows[0]!.id],
      );
      expect(spoofDoneUpd.rows[0]?.completed_by).toBe(staffA);

      const reopenUpd = await appClient.query<{ completed_by: string | null; done_at: Date | null }>(
        `UPDATE crove_kernel.task
            SET status = 'todo', completed_by = $1
          WHERE org_id = $2 AND id = $3
          RETURNING completed_by, done_at`,
        [staffB, org.orgId, spoofDoneIns.rows[0]!.id],
      );
      expect(reopenUpd.rows[0]).toEqual({ completed_by: null, done_at: null });

      const spoofTodoIns = await appClient.query<{ completed_by: string | null; done_at: Date | null }>(
        `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, status, completed_by)
         VALUES ($1, 'Non-done with spoofed completed_by', 'human', 'user', 'todo', $2)
         RETURNING completed_by, done_at`,
        [org.orgId, staffA],
      );
      expect(spoofTodoIns.rows[0]).toEqual({ completed_by: null, done_at: null });

      await appClient.query('ROLLBACK');
    } finally {
      appClient.release();
    }

    // 2. Superuser non-done INSERT triggers coerce completed_by to NULL; bypassing triggers hits CHECK constraint.
    await withAdmin(async (c) => {
      const coerced = await c.query<{ completed_by: string | null; done_at: Date | null }>(
        `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, status, completed_by)
         VALUES ($1, 'Admin non-done coerced', 'human', 'user', 'todo', $2)
         RETURNING completed_by, done_at`,
        [org.orgId, staffA],
      );
      expect(coerced.rows[0]).toEqual({ completed_by: null, done_at: null });

      await c.query('BEGIN');
      try {
        await c.query('ALTER TABLE crove_kernel.task DISABLE TRIGGER task_before_insert');
        await expect(
          c.query(
            `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, status, completed_by)
             VALUES ($1, 'Bypass trigger insert', 'human', 'user', 'todo', $2)`,
            [org.orgId, staffA],
          ),
        ).rejects.toThrow(/task_completed_by_done_only/);
      } finally {
        await c.query('ROLLBACK');
      }

      const validDone = await c.query<{ id: string }>(
        `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, status, done_at, completed_by)
         VALUES ($1, 'Done with completer', 'human', 'user', 'done', pg_catalog.now(), $2)
         RETURNING id`,
        [org.orgId, staffA],
      );
      await c.query('BEGIN');
      try {
        await c.query('ALTER TABLE crove_kernel.task DISABLE TRIGGER task_before_update');
        await expect(
          c.query(`UPDATE crove_kernel.task SET status = 'in_progress' WHERE org_id = $1 AND id = $2`, [org.orgId, validDone.rows[0]!.id]),
        ).rejects.toThrow(/task_completed_by_done_only/);
      } finally {
        await c.query('ROLLBACK');
      }
    });

    // 3. Agent completion via kernel.task.set_status sets done_at with completed_by = NULL,
    // and direct agent SQL writing completed_by raises AGENT_TASK_FIELD.
    const installed = await appRt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Ke toan AI Guard' },
      { actor: asMfa(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const { taskId: tAgentDone } = await appRt.execute<{ taskId: string }>(
      'kernel.task.create',
      { title: 'Agent complete with lease', assigneePositionId: installed.positionId },
      { actor: asUser(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const { taskId: tAgentGuard } = await appRt.execute<{ taskId: string }>(
      'kernel.task.create',
      { title: 'Agent field guard', assigneePositionId: installed.positionId },
      { actor: asUser(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const started = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: SYSTEM, orgId: org.orgId },
    );
    expect(started.runId).toEqual(expect.any(String));
    const agentActor: AgentActor = { type: 'agent', agentId: installed.agentId, runId: started.runId as string };

    const leaseDone = await workerRt.execute<{ fence: string }>(
      'kernel.task.checkout',
      { id: tAgentDone },
      { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await workerRt.execute(
      'kernel.task.set_status',
      { id: tAgentDone, fence: leaseDone.fence, status: 'done' },
      { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    await workerRt.execute(
      'kernel.task.checkout',
      { id: tAgentGuard },
      { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const workerClient = createDbClient({ connectionString: workerUrl }, dbIds);
    await workerClient.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [
        org.orgId,
        agentActor.agentId,
        agentActor.runId,
      ]);
      await expect(
        workerClient.query('UPDATE crove_kernel.task SET completed_by = $1 WHERE id = $2', [owner, tAgentGuard]),
      ).rejects.toThrow(/AGENT_TASK_FIELD/);
    } finally {
      await workerClient.query('ROLLBACK').catch(() => {});
      await workerClient.end();
    }

    await workerRt.execute(
      'kernel.agent.run.finish',
      { runId: agentActor.runId, outcome: 'succeeded' },
      { actor: SYSTEM, orgId: org.orgId },
    );

    await withAdmin(async (c) => {
      const { rows } = await c.query<{ status: string; completed_by: string | null; done_at: Date | null }>(
        'SELECT status, completed_by, done_at FROM crove_kernel.task WHERE org_id = $1 AND id = $2',
        [org.orgId, tAgentDone],
      );
      expect(rows[0]?.status).toBe('done');
      expect(rows[0]?.completed_by).toBeNull();
      expect(rows[0]?.done_at).not.toBeNull();
    });

    // 4. NULL-context / definer / superuser immutability on already-done rows (#4821):
    // neither completed_by nor done_at can be rewritten when OLD.status = 'done' and NEW.status = 'done'.
    const runDateStart = vietnamToday();
    const { projectId } = await appRt.execute<{ projectId: string }>(
      'projects.project.create',
      { name: 'Du an Invariant RBAC', visibility: 'org' },
      { actor: asUser(owner), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const { taskId: tDoneImmutable } = await appRt.execute<{ taskId: string }>(
      'projects.task.create',
      { projectId, title: 'Completed in org', assigneePositionId: null, status: 'done' },
      { actor: asUser(staffA), orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    const noCtxClient = await appPool.connect();
    try {
      const noCtxUpd = await noCtxClient.query(
        `UPDATE crove_kernel.task
            SET completed_by = $1, done_at = '2026-01-01T00:00:00.000Z'
          WHERE org_id = $2 AND id = $3`,
        [staffB, org.orgId, tDoneImmutable],
      );
      expect(noCtxUpd.rowCount).toBe(0);
    } finally {
      noCtxClient.release();
    }

    await withAdmin(async (c) => {
      const before = (
        await c.query<{ completed_by: string | null; done_at: Date }>(
          'SELECT completed_by, done_at FROM crove_kernel.task WHERE org_id = $1 AND id = $2',
          [org.orgId, tDoneImmutable],
        )
      ).rows[0]!;
      expect(before.completed_by).toBe(staffA);

      const after = (
        await c.query<{ completed_by: string | null; done_at: Date }>(
          `UPDATE crove_kernel.task
              SET completed_by = $1, done_at = '2026-01-01T00:00:00.000Z'
            WHERE org_id = $2 AND id = $3
            RETURNING completed_by, done_at`,
          [staffB, org.orgId, tDoneImmutable],
        )
      ).rows[0]!;
      expect(after.completed_by).toBe(staffA);
      expect(after.done_at.getTime()).toBe(before.done_at.getTime());
    });

    // 5. projects.member_completed_tasks enforces MANAGERS RBAC (owner/admin only) and org isolation.

    const runWindow = { from: runDateStart, to: vietnamToday() };
    const managerRead = await appRt.query<ProjectMemberCompletedTasksResult>(
      'projects.member_completed_tasks',
      { userId: staffA, ...runWindow },
      { actor: asUser(owner), orgId: org.orgId },
    );
    expect(managerRead.totalCount).toBe(1);

    await expect(
      appRt.query('projects.member_completed_tasks', { userId: staffA, ...runWindow }, { actor: asUser(staffA), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      appRt.query('projects.member_completed_tasks', { userId: staffA, ...runWindow }, { actor: asUser(viewer), orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      workerRt.query('projects.member_completed_tasks', { userId: staffA, ...runWindow }, { actor: SYSTEM, orgId: org.orgId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    const crossOrgRead = await appRt.query<ProjectMemberCompletedTasksResult>(
      'projects.member_completed_tasks',
      { userId: staffA, ...runWindow },
      { actor: asUser(otherOwner), orgId: otherOrg.orgId },
    );
    expect(crossOrgRead).toEqual({ totalCount: 0, tasks: [] });
  });
});

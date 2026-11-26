// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL 17 integration suite for Issue #4821:
// 1) completed_by and done_at stamped across kernel.task.set_status, projects.task.create,
//    projects.task.move_column, projects.column.delete, and projects.triage.accept (including unassigned tasks).
// 2) Attribution survives seat reassignment, assigneePositionId changes, and unrelated task edits.
// 3) Reopen clears completed_by and done_at; re-completion attributes the new completer; cancelled clears both.
// 4) Date window filtering uses done_at in Asia/Ho_Chi_Minh rather than updated_at.
// 5) Historical legacy rows (done_at IS NOT NULL, completed_by IS NULL) and agent completions are deterministically excluded.
// 6) Template-task guard (PROJECT_TASK_ON_TEMPLATE), private visibility for managers,
//    two-transaction concurrency order, and non-destructive migration 20270328000000 / 20270328020000 idempotency.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  vietnamToday,
  type ProjectColumnDeleteResult,
  type ProjectColumnInitDefaultsResult,
  type ProjectColumnMutateResult,
  type ProjectMemberCompletedTasksResult,
  type ProjectTaskMoveColumnResult,
  type ProjectTriageAcceptResult,
  type ProjectTriageItem,
} from '@ludy/kernel-contract';
import { Runtime, type AgentActor } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { createSessionStatusSource } from '../src/sessions.ts';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ISSUER = 'ludy-auth';
const suite = ADMIN ? describe : describe.skip;

suite('projects.member_completed_tasks completed_by and done_at (#4821)', () => {
  const dbName = `ludy_test_done_by_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let appDb: Db;
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

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function newPerson(tag: string) {
    const subject = randomUUID();
    const email = `${tag}-${randomUUID().slice(0, 8)}@completed-by.test`;
    const userId = await upsertIdentity(appDb, { issuer: ISSUER, subject, email, name: `User ${tag}` });
    return { subject, email, userId };
  }

  const exec = <T>(userId: string, orgId: string, command: string, input: unknown) =>
    rt.execute<T>(command, input, { actor: asUser(userId), orgId, idempotencyKey: randomUUID() });

  const execMfa = <T>(userId: string, orgId: string, command: string, input: unknown) =>
    rt.execute<T>(command, input, { actor: asMfa(userId), orgId, idempotencyKey: randomUUID() });

  const query = <T>(userId: string, orgId: string, name: string, input: unknown) =>
    rt.query<T>(name, input, { actor: asUser(userId), orgId });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN as string });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();

    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();

    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appUrl = login('ludy_app', 'test-app-pw');
    const workerUrl = login('ludy_worker', 'test-worker-pw');

    appPool = createPool({ connectionString: appUrl, max: 6 });
    workerPool = createPool({ connectionString: workerUrl, max: 3 });
    appDb = createDb(appPool);

    const moduleDeps = { inboundDomain: null };
    rt = new Runtime(appDb, {
      manifests: TEST_MANIFESTS,
      sessions: createSessionStatusSource('off'),
      stepUp: 'required' as const,
    }).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries(moduleDeps), ...projectsQueries],
    });

    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries(moduleDeps), ...projectsQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('tracks completed_by across writers, survives seat changes, clears on reopen, filters by done_at, and preserves legacy rows', async () => {
    const runDateStart = vietnamToday();
    const runWindow = () => ({ from: runDateStart, to: vietnamToday() });
    const owner = await newPerson('owner');
    const adminUser = await newPerson('admin');
    const staffA = await newPerson('staff-a');
    const staffB = await newPerson('staff-b');

    const org = await createOrg(rt, asUser(owner.userId), 'Cong ty Completed By');

    for (const person of [
      { person: adminUser, role: 'admin' },
      { person: staffA, role: 'member' },
      { person: staffB, role: 'member' },
    ] as const) {
      const inv = await execMfa<{ acceptPath: string }>(owner.userId, org.orgId, 'kernel.member.invite.create', {
        email: person.person.email,
        role: person.role,
      });
      await rt.executeOrgless(
        'kernel.member.invite.accept',
        { token: inv.acceptPath.split('#')[1] },
        { actor: asUser(person.person.userId) },
      );
    }

    const { positionId: seatA } = await execMfa<{ positionId: string }>(owner.userId, org.orgId, 'kernel.position.create', {
      title: 'Ky su A',
      module: 'projects',
      roleKey: 'projects.member',
    });
    const { positionId: seatB } = await execMfa<{ positionId: string }>(owner.userId, org.orgId, 'kernel.position.create', {
      title: 'Ky su B',
      module: 'projects',
      roleKey: 'projects.member',
    });
    await execMfa(owner.userId, org.orgId, 'kernel.position.assign', { id: seatA, holder: { type: 'user', userId: staffA.userId } });
    await execMfa(owner.userId, org.orgId, 'kernel.position.assign', { id: seatB, holder: { type: 'user', userId: staffB.userId } });

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Du an Chinh',
      visibility: 'org',
      memberUserIds: [owner.userId, adminUser.userId, staffA.userId, staffB.userId],
    });
    const initCols = await exec<ProjectColumnInitDefaultsResult>(owner.userId, org.orgId, 'projects.column.init_defaults', {
      projectId,
      language: 'vi',
    });
    const inProgressCol = initCols.columns.find((c) => c.taskStatus === 'in_progress')!;
    const doneCol = initCols.columns.find((c) => c.taskStatus === 'done')!;

    // Separate project owned by staffA so staffA can invoke projects.column.delete (assertCanManage).
    const { projectId: staffManagedProjectId } = await exec<{ projectId: string }>(staffA.userId, org.orgId, 'projects.project.create', {
      name: 'Du an do staffA phu trach',
      visibility: 'org',
      memberUserIds: [owner.userId, staffA.userId, staffB.userId],
    });
    const staffInitCols = await exec<ProjectColumnInitDefaultsResult>(staffA.userId, org.orgId, 'projects.column.init_defaults', {
      projectId: staffManagedProjectId,
      language: 'vi',
    });
    const staffDoneCol = staffInitCols.columns.find((c) => c.taskStatus === 'done')!;
    const { column: extraReviewCol } = await exec<ProjectColumnMutateResult>(staffA.userId, org.orgId, 'projects.column.create', {
      projectId: staffManagedProjectId,
      name: 'Cho xoa tam',
      taskStatus: 'in_review',
    });

    // 1. All user completion writers stamp completed_by = acting user and done_at:
    // (a) projects.task.create with status: 'done' (unassigned task included).
    const { taskId: tCreateDone } = await exec<{ taskId: string }>(staffA.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Tao va xong ngay khong nguoi phu trach',
      assigneePositionId: null,
      status: 'done',
    });

    // (b) kernel.task.set_status done by staffA on task assigned to seatB (must credit staffA, not seatB holder).
    const { taskId: tSetStatus } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Hoan thanh ho ghe B',
      assigneePositionId: seatB,
    });
    await exec(staffA.userId, org.orgId, 'kernel.task.set_status', { id: tSetStatus, status: 'done' });

    // (c) projects.task.move_column into done column.
    const { taskId: tMoveCol } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Keo cot xong',
      assigneePositionId: seatA,
      columnId: inProgressCol.id,
    });
    const movedDone = await exec<ProjectTaskMoveColumnResult>(staffA.userId, org.orgId, 'projects.task.move_column', {
      projectId,
      taskId: tMoveCol,
      columnId: doneCol.id,
    });
    expect(movedDone.status).toBe('done');

    // (d) projects.column.delete moving task into done fallback column.
    const { taskId: tColDelete } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId: staffManagedProjectId,
      title: 'Chuyen sang xong khi xoa cot',
      assigneePositionId: seatA,
      columnId: extraReviewCol.id,
    });
    const colDeleted = await exec<ProjectColumnDeleteResult>(staffA.userId, org.orgId, 'projects.column.delete', {
      projectId: staffManagedProjectId,
      columnId: extraReviewCol.id,
      fallbackColumnId: staffDoneCol.id,
    });
    expect(colDeleted.deletedColumnId).toBe(extraReviewCol.id);

    // (e) projects.triage.accept straight into done column.
    const { item: triageItem } = await exec<{ item: ProjectTriageItem }>(owner.userId, org.orgId, 'projects.triage.create', {
      projectId,
      sourceType: 'manual',
      title: 'Duyet triage xong ngay',
    });
    const acceptedDone = await exec<ProjectTriageAcceptResult>(staffA.userId, org.orgId, 'projects.triage.accept', {
      itemId: triageItem.id,
      columnId: doneCol.id,
      assigneePositionId: seatA,
    });
    const tTriageDone = acceptedDone.taskId;

    // Duplicate 'done' transition by another actor must preserve original completed_by and done_at.
    const beforeDup = await withAdmin(async (c) => {
      const { rows } = await c.query<{ completed_by: string | null; done_at: Date | null }>(
        'SELECT completed_by, done_at FROM ludy_kernel.task WHERE org_id = $1 AND id = $2',
        [org.orgId, tSetStatus],
      );
      return rows[0]!;
    });
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', { id: tSetStatus, status: 'done' });
    const afterDup = await withAdmin(async (c) => {
      const { rows } = await c.query<{ completed_by: string | null; done_at: Date | null }>(
        'SELECT completed_by, done_at FROM ludy_kernel.task WHERE org_id = $1 AND id = $2',
        [org.orgId, tSetStatus],
      );
      return rows[0]!;
    });
    expect(afterDup.completed_by).toBe(staffA.userId);
    expect(afterDup.done_at?.toISOString()).toBe(beforeDup.done_at?.toISOString());

    const initialList = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffA.userId,
      ...runWindow(),
    });
    expect(initialList.totalCount).toBe(5);
    expect(initialList.tasks.map((t) => t.taskId).sort()).toEqual(
      [tCreateDone, tSetStatus, tMoveCol, tColDelete, tTriageDone].sort(),
    );

    const staffBInitial = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffB.userId,
      ...runWindow(),
    });
    expect(staffBInitial.totalCount).toBe(0);

    // 2. Attribution survives seat reassignment, task assigneePositionId change, and unrelated edits.
    await execMfa(owner.userId, org.orgId, 'kernel.position.assign', { id: seatA, holder: { type: 'user', userId: staffB.userId } });
    await execMfa(owner.userId, org.orgId, 'kernel.position.assign', { id: seatB, holder: null });
    await exec(owner.userId, org.orgId, 'kernel.task.update', {
      id: tMoveCol,
      title: 'Keo cot xong (da sua tieu de)',
      assigneePositionId: null,
    });

    const afterReassign = await query<ProjectMemberCompletedTasksResult>(adminUser.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffA.userId,
      ...runWindow(),
    });
    expect(afterReassign.totalCount).toBe(5);
    expect(afterReassign.tasks.find((t) => t.taskId === tMoveCol)?.title).toBe('Keo cot xong (da sua tieu de)');

    const staffBAfterReassign = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffB.userId,
      ...runWindow(),
    });
    expect(staffBAfterReassign.totalCount).toBe(0);

    // 3. Reopen clears completed_by and done_at; re-completion credits new actor; cancelled clears both.
    await exec(owner.userId, org.orgId, 'projects.task.move_column', {
      projectId,
      taskId: tMoveCol,
      columnId: inProgressCol.id,
    });
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', { id: tTriageDone, status: 'cancelled' });
    await withAdmin(async (c) => {
      const { rows } = await c.query<{ id: string; status: string; completed_by: string | null; done_at: Date | null }>(
        'SELECT id, status, completed_by, done_at FROM ludy_kernel.task WHERE org_id = $1 AND id = ANY($2::uuid[])',
        [org.orgId, [tMoveCol, tTriageDone]],
      );
      for (const r of rows) {
        expect(r.completed_by).toBeNull();
        expect(r.done_at).toBeNull();
      }
    });

    // staffB re-completes tMoveCol -> attributed to staffB now, no longer staffA.
    await exec(staffB.userId, org.orgId, 'kernel.task.set_status', { id: tMoveCol, status: 'done' });
    const staffAAfterReopen = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffA.userId,
      ...runWindow(),
    });
    expect(staffAAfterReopen.totalCount).toBe(3);
    expect(staffAAfterReopen.tasks.map((t) => t.taskId).sort()).toEqual([tCreateDone, tSetStatus, tColDelete].sort());

    const staffBAfterRecomplete = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffB.userId,
      ...runWindow(),
    });
    expect(staffBAfterRecomplete.totalCount).toBe(1);
    expect(staffBAfterRecomplete.tasks[0]?.taskId).toBe(tMoveCol);

    // 4. Date range filters on done_at in Asia/Ho_Chi_Minh, unaffected by subsequent updated_at bumps.
    // 2026-10-09T17:00:00.000Z === 2026-10-10 00:00:00+07 (inclusive lower bound of 2026-10-10).
    // 2026-10-10T16:59:59.999Z === 2026-10-10 23:59:59.999+07 (inside 2026-10-10).
    // 2026-10-09T16:59:59.999Z === 2026-10-09 23:59:59.999+07 (before 2026-10-10).
    // 2026-10-10T17:00:00.000Z === 2026-10-11 00:00:00+07 (exclusive upper bound of 2026-10-10).
    const { taskId: tOct10Start } = await exec<{ taskId: string }>(staffA.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Moc 00:00 VN ngay 10/10',
      assigneePositionId: null,
      status: 'done',
    });
    const { taskId: tOct10End } = await exec<{ taskId: string }>(staffA.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Moc 23:59 VN ngay 10/10',
      assigneePositionId: null,
      status: 'done',
    });
    const { taskId: tOct09Late } = await exec<{ taskId: string }>(staffA.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Moc 23:59 VN ngay 09/10',
      assigneePositionId: null,
      status: 'done',
    });
    const { taskId: tOct11Start } = await exec<{ taskId: string }>(staffA.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Moc 00:00 VN ngay 11/10',
      assigneePositionId: null,
      status: 'done',
    });
    await withAdmin(async (c) => {
      await c.query(`UPDATE ludy_kernel.task SET done_at = '2026-10-09T17:00:00.000Z' WHERE org_id = $1 AND id = $2`, [org.orgId, tOct10Start]);
      await c.query(`UPDATE ludy_kernel.task SET done_at = '2026-10-10T16:59:59.999Z' WHERE org_id = $1 AND id = $2`, [org.orgId, tOct10End]);
      await c.query(`UPDATE ludy_kernel.task SET done_at = '2026-10-09T16:59:59.999Z' WHERE org_id = $1 AND id = $2`, [org.orgId, tOct09Late]);
      await c.query(`UPDATE ludy_kernel.task SET done_at = '2026-10-10T17:00:00.000Z' WHERE org_id = $1 AND id = $2`, [org.orgId, tOct11Start]);
    });

    // Bump updated_at to NOW on historical tasks; today's range must not include them, 2026-10-10 must keep only exact window.
    await exec(owner.userId, org.orgId, 'kernel.task.update', { id: tOct10Start, description: 'Cap nhat sau khi xong' });
    await exec(owner.userId, org.orgId, 'kernel.task.update', { id: tOct09Late, description: 'Cap nhat sau ngay 09/10' });

    const oct10 = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffA.userId,
      from: '2026-10-10',
      to: '2026-10-10',
    });
    expect(oct10.totalCount).toBe(2);
    expect(oct10.tasks.map((t) => ({ id: t.taskId, completedAt: t.completedAt }))).toEqual([
      { id: tOct10End, completedAt: '2026-10-10T16:59:59.999Z' },
      { id: tOct10Start, completedAt: '2026-10-09T17:00:00.000Z' },
    ]);

    const todayAfterBumps = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffA.userId,
      ...runWindow(),
    });
    expect(todayAfterBumps.totalCount).toBe(3);

    // Limit still returns accurate totalCount.
    const limitedOct10 = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffA.userId,
      from: '2026-10-10',
      to: '2026-10-10',
      limit: 1,
    });
    expect(limitedOct10.totalCount).toBe(2);
    expect(limitedOct10.tasks).toHaveLength(1);
    expect(limitedOct10.tasks[0]?.taskId).toBe(tOct10End);

    // 5. Historical unattributable rows (done_at IS NOT NULL, completed_by IS NULL) and agent completions are excluded.
    await execMfa(owner.userId, org.orgId, 'kernel.position.assign', { id: seatA, holder: { type: 'user', userId: staffA.userId } });
    await withAdmin(async (c) => {
      const legacy = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, assignee_position_id, status, done_at, completed_by)
         VALUES ($1, 'Legacy done without completed_by', 'human', 'user', $2, 'done', '2026-10-10T05:00:00.000Z', NULL)
         RETURNING id`,
        [org.orgId, seatA],
      );
      await c.query(
        `INSERT INTO ludy_projects.project_task (org_id, project_id, task_id, added_by)
         VALUES ($1, $2, $3, $4)`,
        [org.orgId, projectId, legacy.rows[0]!.id, owner.userId],
      );
    });

    const installed = await execMfa<{ agentId: string; positionId: string }>(owner.userId, org.orgId, 'kernel.agent.template.install', {
      templateKey: 'finance.chief_accountant',
      displayName: 'Ke toan AI',
    });
    const { taskId: tAgentDone } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Agent hoan thanh task',
      assigneePositionId: installed.positionId,
    });
    const started = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
    );
    expect(started.runId).toEqual(expect.any(String));
    const agentActor: AgentActor = { type: 'agent', agentId: installed.agentId, runId: started.runId as string };

    const checkedOut = await workerRt.execute<{ fence: string }>(
      'kernel.task.checkout',
      { id: tAgentDone },
      { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await workerRt.execute(
      'kernel.task.set_status',
      { id: tAgentDone, fence: checkedOut.fence, status: 'done' },
      { actor: agentActor, orgId: org.orgId, idempotencyKey: randomUUID() },
    );

    await workerRt.execute(
      'kernel.agent.run.finish',
      { runId: agentActor.runId, outcome: 'succeeded' },
      { actor: { type: 'system', component: 'test' }, orgId: org.orgId },
    );

    await withAdmin(async (c) => {
      const { rows } = await c.query<{ completed_by: string | null; done_at: Date | null }>(
        'SELECT completed_by, done_at FROM ludy_kernel.task WHERE org_id = $1 AND id = $2',
        [org.orgId, tAgentDone],
      );
      expect(rows[0]?.completed_by).toBeNull();
      expect(rows[0]?.done_at).not.toBeNull();
    });

    // Neither the legacy NULL-actor row nor the agent task is included for staffA or owner.
    const oct10AfterLegacy = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffA.userId,
      from: '2026-10-10',
      to: '2026-10-10',
    });
    expect(oct10AfterLegacy.totalCount).toBe(2);
    const ownerToday = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: owner.userId,
      ...runWindow(),
    });
    expect(ownerToday.tasks.some((t) => t.taskId === tAgentDone)).toBe(false);

    // 6. Template project cannot attach real project_task rows (PROJECT_TASK_ON_TEMPLATE),
    // and private project completions stay visible to managers.
    await withAdmin(async (c) => {
      const tplProj = await c.query<{ id: string }>(
        `INSERT INTO ludy_projects.project (org_id, name, created_by, is_template)
         VALUES ($1, 'Mau du an', $2, true)
         RETURNING id`,
        [org.orgId, owner.userId],
      );
      const tplTask = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, status, done_at, completed_by)
         VALUES ($1, 'Task trong mau', 'human', 'user', 'done', pg_catalog.now(), $2)
         RETURNING id`,
        [org.orgId, staffA.userId],
      );
      await expect(
        c.query(
          `INSERT INTO ludy_projects.project_task (org_id, project_id, task_id, added_by)
           VALUES ($1, $2, $3, $4)`,
          [org.orgId, tplProj.rows[0]!.id, tplTask.rows[0]!.id, owner.userId],
        ),
      ).rejects.toThrow(/PROJECT_TASK_ON_TEMPLATE/);
    });

    // Private project completed task IS visible to org owner/admin (MANAGERS bypass private project filter).
    const { projectId: privProjectId } = await exec<{ projectId: string }>(staffA.userId, org.orgId, 'projects.project.create', {
      name: 'Du an Rieng Tu',
      visibility: 'private',
      memberUserIds: [],
    });
    const { taskId: tPrivDone } = await exec<{ taskId: string }>(staffA.userId, org.orgId, 'projects.task.create', {
      projectId: privProjectId,
      title: 'Xong trong du an rieng tu',
      assigneePositionId: null,
      status: 'done',
    });

    const afterTemplateAndPriv = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffA.userId,
      ...runWindow(),
    });
    expect(afterTemplateAndPriv.totalCount).toBe(4);
    expect(afterTemplateAndPriv.tasks.some((t) => t.taskId === tPrivDone)).toBe(true);
    expect(afterTemplateAndPriv.tasks.some((t) => t.title === 'Task trong mau')).toBe(false);

    // 7. Two concurrent transactions with start order reversed from write order + non-destructive migration idempotency:
    // - live trigger credits tx B (first to transition row to done), even though tx A started earlier;
    // - re-running 20270328000000 and 20270328020000 keeps pre-existing done rows (completed_by IS NULL) non-destructively
    //   at NULL without inferring from seat holder or ambiguous audit_event timestamps, preserving done_at, updated_at, and revision.
    const { taskId: tConcurrent } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Tranh chap hai giao dich',
      assigneePositionId: seatA,
    });
    const clientA = await appPool.connect();
    const clientB = await appPool.connect();
    let txBNowIso = '';
    try {
      await clientA.query('BEGIN');
      await enterUser(clientA, staffA.userId, org.orgId);
      const { rows: aTimeRows } = await clientA.query<{ now: Date }>('SELECT pg_catalog.now() AS now');
      await new Promise((resolve) => setTimeout(resolve, 20));

      await clientB.query('BEGIN');
      await enterUser(clientB, staffB.userId, org.orgId);
      const { rows: bTimeRows } = await clientB.query<{ now: Date }>('SELECT pg_catalog.now() AS now');
      expect(bTimeRows[0]!.now.getTime()).toBeGreaterThan(aTimeRows[0]!.now.getTime());
      txBNowIso = bTimeRows[0]!.now.toISOString();

      await clientB.query(`UPDATE ludy_kernel.task SET status = 'done' WHERE org_id = $1 AND id = $2`, [org.orgId, tConcurrent]);
      await clientB.query('COMMIT');

      await clientA.query(`UPDATE ludy_kernel.task SET status = 'done' WHERE org_id = $1 AND id = $2`, [org.orgId, tConcurrent]);
      await clientA.query('COMMIT');
    } catch (err) {
      await clientB.query('ROLLBACK').catch(() => {});
      await clientA.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      clientB.release();
      clientA.release();
    }

    await withAdmin(async (c) => {
      const { rows } = await c.query<{ completed_by: string | null; done_at: Date }>(
        'SELECT completed_by, done_at FROM ludy_kernel.task WHERE org_id = $1 AND id = $2',
        [org.orgId, tConcurrent],
      );
      expect(rows[0]?.completed_by).toBe(staffB.userId);
      expect(rows[0]?.done_at.toISOString()).toBe(txBNowIso);
    });

    const ddlMigrationSql = readFileSync(
      fileURLToPath(new URL('../../../supabase/migrations/20270328000000_ludy_kernel_task_completed_by.sql', import.meta.url)),
      'utf8',
    );
    const validateMigrationSql = readFileSync(
      fileURLToPath(new URL('../../../supabase/migrations/20270328020000_ludy_kernel_task_completed_by_validate.sql', import.meta.url)),
      'utf8',
    );
    await withAdmin(async (c) => {
      const legacy = await c.query<{ id: string }>(
        `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, assignee_position_id, status, done_at, completed_by, updated_at)
         VALUES ($1, 'Pre-migration legacy row', 'human', 'user', $2, 'done', '2026-09-01T02:00:00.000Z', NULL, '2026-09-01T02:00:00.000Z')
         RETURNING id`,
        [org.orgId, seatA],
      );
      const legacyId = legacy.rows[0]!.id;
      await c.query(
        `INSERT INTO ludy_projects.project_task (org_id, project_id, task_id, added_by)
         VALUES ($1, $2, $3, $4)`,
        [org.orgId, projectId, legacyId, owner.userId],
      );
      await c.query(
        `INSERT INTO ludy_kernel.audit_event
           (org_id, occurred_at, actor_type, actor_id, command, command_id, outcome, target_type, target_id, input_sha256, detail)
         VALUES ($1, '2026-09-01T02:00:00.000Z', 'user', $2, 'kernel.task.set_status', $3, 'ok', 'kernel.task', $4, $5, '{"status":"done"}'::jsonb)`,
        [org.orgId, staffA.userId, randomUUID(), legacyId, '0'.repeat(64)],
      );

      await c.query('BEGIN');
      await c.query(ddlMigrationSql);
      await c.query('COMMIT');

      await c.query('BEGIN');
      await c.query(validateMigrationSql);
      await c.query('COMMIT');

      const { rows } = await c.query<{ completed_by: string | null; done_at: Date; updated_at: Date; revision: number }>(
        `SELECT completed_by, done_at, updated_at, revision
           FROM ludy_kernel.task
          WHERE org_id = $1 AND id = $2`,
        [org.orgId, legacyId],
      );
      expect(rows[0]?.completed_by).toBeNull();
      expect(rows[0]?.done_at.toISOString()).toBe('2026-09-01T02:00:00.000Z');
      expect(rows[0]?.updated_at.toISOString()).toBe('2026-09-01T02:00:00.000Z');
      expect(rows[0]?.revision).toBe(1);
    });

    const septLegacy = await query<ProjectMemberCompletedTasksResult>(owner.userId, org.orgId, 'projects.member_completed_tasks', {
      userId: staffA.userId,
      from: '2026-09-01',
      to: '2026-09-10',
    });
    expect(septLegacy).toEqual({ totalCount: 0, tasks: [] });
  });
});

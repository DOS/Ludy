// SPDX-License-Identifier: AGPL-3.0-only
// Manual project board ordering (projects.task.reorder) and kernel.task saved-view filters/sort on PostgreSQL 17 (#2610).
// RBAC, le_scope, archive-guard, and ctx.agent security invariants live in modules/projects/test/invariant/ (#3445).
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import {
  REBALANCE_AT,
  type FilterAst,
  type ProjectBoard,
  type SavedView,
  type SavedViewSort,
} from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const suite = ADMIN ? describe : describe.skip;

interface TaskListRow {
  id: string;
  title: string;
  status: string;
  assigneePositionId: string | null;
  tainted: boolean;
  due: string | null;
  createdAt: string;
}

suite('project board ordering and kernel.task saved views on PostgreSQL (#2610)', () => {
  const dbName = `ludy_test_proj_order_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;

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
    const email = `${tag}-${randomUUID().slice(0, 8)}@projects.test`;
    const userId = await upsertIdentity(db, { issuer: 'ludy-auth', subject: randomUUID(), email, name: `User ${tag}` });
    return { email, userId };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw' });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';

    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, stepUp: 'required' }).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('reorders project tasks before/after, lazily initializes sort_key, appends new tasks NULLS LAST, and rebalances past REBALANCE_AT', async () => {
    const owner = await newPerson('order-owner');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Sắp xếp');
    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Sprint Q4',
    });

    // Default initial order: due ASC NULLS LAST, created_at ASC, id ASC.
    const dueEarly = new Date(Date.now() + 1 * DAY).toISOString();
    const dueMid = new Date(Date.now() + 3 * DAY).toISOString();
    const dueLate = new Date(Date.now() + 6 * DAY).toISOString();
    const { taskId: tMid } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'T2 Mid',
      assigneePositionId: null,
      due: dueMid,
    });
    const { taskId: tNoDue } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'T4 NoDue',
      assigneePositionId: null,
    });
    const { taskId: tEarly } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'T1 Early',
      assigneePositionId: null,
      due: dueEarly,
    });
    const { taskId: tLate } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'T3 Late',
      assigneePositionId: null,
      due: dueLate,
    });

    const boardTitles = async (sort?: SavedViewSort | null) =>
      (await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId, ...(sort !== undefined ? { sort } : {}) })).tasks.map(
        (t) => t.title,
      );

    expect(await boardTitles()).toEqual(['T1 Early', 'T2 Mid', 'T3 Late', 'T4 NoDue']);

    // Lazy init: move T4 NoDue before T1 Early. Result: T4, T1, T2, T3.
    const moved = await exec<{ projectId: string; taskId: string }>(owner.userId, org.orgId, 'projects.task.reorder', {
      projectId,
      taskId: tNoDue,
      place: 'before',
      anchorId: tEarly,
    });
    expect(moved).toEqual({ projectId, taskId: tNoDue });
    expect(await boardTitles()).toEqual(['T4 NoDue', 'T1 Early', 'T2 Mid', 'T3 Late']);

    // Every existing row now has a non-null sort_key.
    const keysAfterInit = await withAdmin((c) =>
      c.query<{ sort_key: string | null }>('SELECT sort_key FROM ludy_projects.project_task WHERE project_id = $1', [projectId]),
    );
    expect(keysAfterInit.rows.every((r) => r.sort_key !== null)).toBe(true);

    // Move T1 Early after T3 Late -> T4, T2, T3, T1.
    await exec(owner.userId, org.orgId, 'projects.task.reorder', {
      projectId,
      taskId: tEarly,
      place: 'after',
      anchorId: tLate,
    });
    expect(await boardTitles()).toEqual(['T4 NoDue', 'T2 Mid', 'T3 Late', 'T1 Early']);

    // Add a new task later (sort_key stays NULL -> appears last under NULLS LAST), then reorder T3 before T2.
    await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'T5 AddedLater',
      assigneePositionId: null,
      due: dueEarly,
    });
    expect(await boardTitles()).toEqual(['T4 NoDue', 'T2 Mid', 'T3 Late', 'T1 Early', 'T5 AddedLater']);
    await exec(owner.userId, org.orgId, 'projects.task.reorder', {
      projectId,
      taskId: tLate,
      place: 'before',
      anchorId: tMid,
    });
    expect(await boardTitles()).toEqual(['T4 NoDue', 'T3 Late', 'T2 Mid', 'T1 Early', 'T5 AddedLater']);

    // Custom sort overrides sort_key without mutating it.
    expect(await boardTitles({ field: 'title', dir: 'desc' })).toEqual([
      'T5 AddedLater',
      'T4 NoDue',
      'T3 Late',
      'T2 Mid',
      'T1 Early',
    ]);
    expect(await boardTitles(null)).toEqual(['T4 NoDue', 'T3 Late', 'T2 Mid', 'T1 Early', 'T5 AddedLater']);

    // Force 60 (REBALANCE_AT + 12) sequential midpoint insertions past REBALANCE_AT (48) into the T4..T3 gap so rebalance triggers cleanly.
    let frontId = tNoDue;
    let secondId = tLate;
    for (let i = 0; i < REBALANCE_AT + 12; i++) {
      const mover = i % 2 === 0 ? secondId : frontId;
      const anchor = i % 2 === 0 ? frontId : secondId;
      await exec(owner.userId, org.orgId, 'projects.task.reorder', {
        projectId,
        taskId: mover,
        place: 'before',
        anchorId: anchor,
      });
      [frontId, secondId] = [mover, anchor];
    }
    const keysAfterStress = await withAdmin((c) =>
      c.query<{ sort_key: string }>('SELECT sort_key FROM ludy_projects.project_task WHERE project_id = $1 ORDER BY sort_key ASC NULLS LAST', [
        projectId,
      ]),
    );
    expect(keysAfterStress.rows.every((r) => r.sort_key.length <= REBALANCE_AT)).toBe(true);
    expect(new Set(keysAfterStress.rows.map((r) => r.sort_key)).size).toBe(5);

    // Concurrent reorders under project lock produce valid distinct keys and preserve all tasks.
    await Promise.all([
      exec(owner.userId, org.orgId, 'projects.task.reorder', { projectId, taskId: tMid, place: 'before', anchorId: tEarly }),
      exec(owner.userId, org.orgId, 'projects.task.reorder', { projectId, taskId: tLate, place: 'after', anchorId: tEarly }),
    ]);
    const finalOrder = await boardTitles();
    expect(new Set(finalOrder)).toEqual(new Set(['T1 Early', 'T2 Mid', 'T3 Late', 'T4 NoDue', 'T5 AddedLater']));
    expect(finalOrder).toHaveLength(5);
  });

  it('wires kernel.task saved views into kernel.task.list, projects.board, and saved_view commands', async () => {
    const owner = await newPerson('sv-owner');
    const member = await newPerson('sv-member');
    const org = await createOrg(rt, asUser(owner.userId), 'Công ty Bộ lọc');
    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: member.email, role: 'member' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless('kernel.member.invite.accept', { token: inv.acceptPath.split('#')[1] }, { actor: asUser(member.userId) });

    const { positionId: posOwner } = await rt.execute<{ positionId: string }>(
      'kernel.position.create',
      { title: 'Giám đốc', module: 'projects', roleKey: 'owner' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.execute(
      'kernel.position.assign',
      { id: posOwner, holder: { type: 'user', userId: owner.userId } },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const { positionId: posMember } = await rt.execute<{ positionId: string }>(
      'kernel.position.create',
      { title: 'Kế toán', module: 'projects', roleKey: 'member' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    await rt.execute(
      'kernel.position.assign',
      { id: posMember, holder: { type: 'user', userId: member.userId } },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const installedAgent = await rt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Vy Dự án' },
      { actor: asMfa(owner.userId), orgId: org.orgId, idempotencyKey: randomUUID() },
    );
    const posAgent = installedAgent.positionId;

    const { projectId } = await exec<{ projectId: string }>(owner.userId, org.orgId, 'projects.project.create', {
      name: 'Công việc tổng hợp',
    });

    const pastDue = new Date(Date.now() - 2 * DAY).toISOString();
    const soonDue = new Date(Date.now() + 2 * DAY).toISOString();

    const { taskId: tClean } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Khai thuế Nguyễn 50%',
      assigneePositionId: posMember,
      due: soonDue,
      status: 'in_progress',
    });
    const { taskId: tTainted } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Đề xuất AI quá hạn',
      assigneePositionId: posAgent,
      due: pastDue,
      status: 'todo',
    });
    const { taskId: tUnassigned } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Việc chưa giao',
      assigneePositionId: null,
      status: 'waiting',
    });
    const { taskId: tCancelled } = await exec<{ taskId: string }>(owner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Việc đã hủy',
      assigneePositionId: posOwner,
      due: pastDue,
      status: 'done',
    });

    // Mark tTainted as tainted (like an AI proposal) and tCancelled as cancelled via task status update.
    await exec(owner.userId, org.orgId, 'kernel.task.set_status', { id: tCancelled, status: 'cancelled' });
    await withAdmin((c) => c.query('UPDATE ludy_kernel.task SET tainted = true WHERE id = $1', [tTainted]));

    // 1) Save & list a shared kernel.task saved view isolating AI-proposed (tainted) tasks.
    const savedTainted: FilterAst = { v: 1, all: [{ field: 'tainted', op: 'is', value: true }] };
    const { viewId } = await exec<{ viewId: string }>(owner.userId, org.orgId, 'kernel.saved_view.save', {
      scope: 'kernel.task',
      name: 'AI đề xuất',
      filters: savedTainted,
      sort: { field: 'due', dir: 'asc' },
      shared: true,
    });
    const memberViews = await query<SavedView[]>(member.userId, org.orgId, 'kernel.saved_view.list', { scope: 'kernel.task' });
    expect(memberViews.find((v) => v.id === viewId)?.filters).toEqual(savedTainted);

    // 2) Both kernel.task.list and projects.board honor filters & sort.
    const taintedListed = await query<{ tasks: TaskListRow[] }>(member.userId, org.orgId, 'kernel.task.list', { filters: savedTainted });
    expect(taintedListed.tasks.map((t) => t.id)).toEqual([tTainted]);

    const taintedBoard = await query<ProjectBoard>(member.userId, org.orgId, 'projects.board', { projectId, filters: savedTainted });
    expect(taintedBoard.tasks.map((t) => t.id)).toEqual([tTainted]);

    // Default board omits cancelled unless status filter or includeCancelled asks for it.
    expect((await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', { projectId })).tasks.map((t) => t.id)).not.toContain(
      tCancelled,
    );
    const cancelledBoard = await query<ProjectBoard>(owner.userId, org.orgId, 'projects.board', {
      projectId,
      filters: { v: 1, all: [{ field: 'status', op: 'is', value: 'cancelled' }] },
    });
    expect(cancelledBoard.tasks.map((t) => t.id)).toEqual([tCancelled]);

    // Vietnamese folding + literal '%' search + overdue + within_next_days + assignee is_me (owner vs member).
    const folded = await query<{ tasks: TaskListRow[] }>(owner.userId, org.orgId, 'kernel.task.list', {
      filters: { v: 1, all: [{ field: 'search', op: 'contains', value: 'nguyen 50%' }] },
    });
    expect(folded.tasks.map((t) => t.id)).toEqual([tClean]);

    const overdue = await query<{ tasks: TaskListRow[] }>(owner.userId, org.orgId, 'kernel.task.list', {
      filters: { v: 1, all: [{ field: 'due', op: 'overdue' }] },
    });
    expect(overdue.tasks.map((t) => t.id)).toEqual([tTainted]);

    const memberMine = await query<{ tasks: TaskListRow[] }>(member.userId, org.orgId, 'kernel.task.list', {
      filters: { v: 1, all: [{ field: 'assignee', op: 'is_me' }] },
    });
    expect(memberMine.tasks.map((t) => t.id)).toEqual([tClean]);

    const ownerMine = await query<{ tasks: TaskListRow[] }>(owner.userId, org.orgId, 'kernel.task.list', {
      filters: { v: 1, all: [{ field: 'assignee', op: 'is_me' }] },
    });
    expect(new Set(ownerMine.tasks.map((t) => t.id))).toEqual(new Set([tUnassigned, tCancelled]));

    // Validation fails cleanly with 422 even if board status is [].
    await expect(
      query(owner.userId, org.orgId, 'projects.board', {
        projectId,
        status: [],
        filters: { v: 1, all: [{ field: 'color', op: 'is', value: 'red' }] },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
    await expect(
      query(owner.userId, org.orgId, 'kernel.task.list', {
        sort: { field: 'priority', dir: 'asc' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION', status: 422 });
  });
});

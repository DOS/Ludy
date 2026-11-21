// SPDX-License-Identifier: AGPL-3.0-only
// Projects P3 integration tests on PostgreSQL 17 (issue #2593, docs/plan/projects.md §4.3 & §9 P3, ADR-0048, ADR-0053):
// 1) Member with tasks across 3 projects sees all tasks in notes.my_work with each { id, name }, plus unassigned tasks
//    with project: null, and filters properly to one project or 'none'.
// 2) Legal-entity scope (le_scope) isolation holds for both notes.my_work and projects.task_projects.
// 3) No-seat hint signal: member/admin without an active seat in a multi-member team org gets noSeatHint: true;
//    solo owner, team owner, viewer, and seated member get noSeatHint: false.
// 4) Graceful degradation when projects is omitted from CROVE_MODULES OR turned off per org (ADR-0053 MODULE_OFF /
//    entitlements): notes.my_work succeeds with projectsAvailable: false and project: null, while projects RPC returns
//    404 MODULE_OFF; turning projects back on restores project chips immediately.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { MyWork, ProjectTaskProjectEntry, TodoWritten } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { notesCommands, notesQueries } from '@ludy/mod-notes';
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-projects-p3-0123456789';
const ISSUER = 'crove-auth';
const suite = ADMIN ? describe : describe.skip;

suite('projects P3: my tasks across projects on PostgreSQL (#2593)', () => {
  const dbName = `crove_test_proj_p3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let db: Db;
  let fullRt: Runtime;
  let noProjectsRt: Runtime;
  let unentitledRt: Runtime;
  let fullApp: ReturnType<typeof createHttpApp>;
  let noProjectsApp: ReturnType<typeof createHttpApp>;
  let unentitledApp: ReturnType<typeof createHttpApp>;

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
    const email = `${tag}-${randomUUID().slice(0, 8)}@projects-p3.test`;
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

  const exec = <T>(userId: string, orgId: string, command: string, input: unknown, rt = fullRt) =>
    rt.execute<T>(command, input, { actor: asUser(userId), orgId, idempotencyKey: randomUUID() });

  const query = <T>(userId: string, orgId: string, name: string, input: unknown = {}, rt = fullRt) =>
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw' });

    const uApp = new URL(adminUrl);
    uApp.username = 'crove_app';
    uApp.password = 'test-app-pw';
    const appPool = createPool({ connectionString: uApp.toString(), max: 4 });
    pools.push(appPool);
    db = createDb(appPool);

    const config = loadConfig({
      DATABASE_URL: uApp.toString(),
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
      entitlements: async () => ['full'],
    };
    const kernelCmds = kernelCommands;
    const kernelQrys = kernelQueries({ inboundDomain: null });

    fullRt = new Runtime(db, rtOpts).register({
      commands: [...kernelCmds, ...notesCommands, ...projectsCommands],
      queries: [...kernelQrys, ...notesQueries, ...projectsQueries],
    });
    noProjectsRt = new Runtime(db, { ...rtOpts, absentModules: ['projects'] }).register({
      commands: [...kernelCmds, ...notesCommands],
      queries: [...kernelQrys, ...notesQueries],
    });
    unentitledRt = new Runtime(db, { ...rtOpts, entitlements: async () => ['notes'] }).register({
      commands: [...kernelCmds, ...notesCommands, ...projectsCommands],
      queries: [...kernelQrys, ...notesQueries, ...projectsQueries],
    });
    const makeApp = (runtime: Runtime) =>
      createHttpApp({
        config,
        runtime,
        store: { put: async () => '', get: async () => new Uint8Array(), delete: async () => {} },
        authenticate: createAuthenticator(config, db),
        pool: appPool,
        aiEnabled: false,
      });
    fullApp = makeApp(fullRt);
    noProjectsApp = makeApp(noProjectsRt);
    unentitledApp = makeApp(unentitledRt);
  }, 300_000);

  afterAll(async () => {
    for (const p of pools) await p.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists member tasks across 3 projects in notes.my_work with project names, supports filtering, and enforces le_scope', async () => {
    const owner = await newPerson('owner');
    const member = await newPerson('member');
    const otherMember = await newPerson('other');
    const limitedMember = await newPerson('limited');

    const { orgId, slug } = await createOrg(fullRt, asUser(owner.userId), 'P3 Team Org');

    const ids = await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`,
        [orgId, member.userId, otherMember.userId, limitedMember.userId],
      );
      const entities = await c.query<{ id: string }>(
        `SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 ORDER BY is_default DESC`,
        [orgId],
      );
      const entityA = entities.rows[0]?.id as string;
      const entityB = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh B', 'branch', $2) RETURNING id`,
          [orgId, owner.userId],
        )
      ).rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [orgId, limitedMember.userId, entityA, owner.userId],
      );

      const addSeat = async (title: string, holder: string, leScope: string[]) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO crove_kernel.position (org_id, title, module, role_key, holder_user_id, status, le_scope)
             VALUES ($1, $2, 'kernel', 'staff', $3, 'active', $4::text[]) RETURNING id`,
            [orgId, title, holder, leScope],
          )
        ).rows[0]?.id as string;

      return {
        entityA,
        entityB,
        seatMember: await addSeat('Kế toán', member.userId, ['*']),
        seatOther: await addSeat('Kho', otherMember.userId, ['*']),
        seatLimited: await addSeat('Kế toán CN A', limitedMember.userId, [entityA]),
      };
    });

    // Create 3 projects.
    const { projectId: pAlpha } = await exec<{ projectId: string }>(owner.userId, orgId, 'projects.project.create', { name: 'Alpha Tax' });
    const { projectId: pBeta } = await exec<{ projectId: string }>(owner.userId, orgId, 'projects.project.create', { name: 'Beta Launch' });
    const { projectId: pGamma } = await exec<{ projectId: string }>(owner.userId, orgId, 'projects.project.create', { name: 'Gamma Audit' });

    // Create open tasks for member across 3 projects + 1 unassigned + 1 done + 1 belonging to another seat.
    const { taskId: tAlpha } = await exec<{ taskId: string }>(owner.userId, orgId, 'projects.task.create', {
      projectId: pAlpha,
      title: 'Alpha task',
      assigneePositionId: ids.seatMember,
      due: '2026-11-18T10:00:00.000Z',
    });
    const { taskId: tBeta } = await exec<{ taskId: string }>(owner.userId, orgId, 'projects.task.create', {
      projectId: pBeta,
      title: 'Beta task',
      assigneePositionId: ids.seatMember,
      due: '2026-11-19T10:00:00.000Z',
    });
    const { taskId: tGamma } = await exec<{ taskId: string }>(owner.userId, orgId, 'projects.task.create', {
      projectId: pGamma,
      title: 'Gamma task',
      assigneePositionId: ids.seatMember,
      due: '2026-11-20T10:00:00.000Z',
    });
    const { taskId: tUnassigned } = await exec<{ taskId: string }>(owner.userId, orgId, 'kernel.task.create', {
      title: 'No project task',
      assigneePositionId: ids.seatMember,
    });
    const { taskId: tDone } = await exec<{ taskId: string }>(owner.userId, orgId, 'projects.task.create', {
      projectId: pAlpha,
      title: 'Done Alpha task',
      assigneePositionId: ids.seatMember,
      status: 'done',
    });
    const { taskId: tOther } = await exec<{ taskId: string }>(owner.userId, orgId, 'projects.task.create', {
      projectId: pAlpha,
      title: 'Other seat task',
      assigneePositionId: ids.seatOther,
    });

    // Personal private to-do for member.
    const { todoId } = await exec<TodoWritten>(member.userId, orgId, 'notes.todo.create', {
      title: 'Private reminder',
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    // 1. notes.my_work shows all open tasks across the 3 projects + unassigned task + private to-do.
    const work = await query<MyWork>(member.userId, orgId, 'notes.my_work', { timeZone: 'Asia/Ho_Chi_Minh' });
    expect(work.projectsAvailable).toBe(true);
    expect(work.noSeatHint).toBe(false);
    expect(work.todos.map((t) => t.id)).toEqual([todoId]);
    expect(work.tasks.map((t) => [t.id, t.project])).toEqual([
      [tAlpha, { id: pAlpha, name: 'Alpha Tax' }],
      [tBeta, { id: pBeta, name: 'Beta Launch' }],
      [tGamma, { id: pGamma, name: 'Gamma Audit' }],
      [tUnassigned, null],
    ]);
    expect(JSON.stringify(work)).not.toContain(tDone);
    expect(JSON.stringify(work)).not.toContain(tOther);

    // 2. Filtering notes.my_work by projectId and by 'none'.
    const onlyBeta = await query<MyWork>(member.userId, orgId, 'notes.my_work', { timeZone: 'Asia/Ho_Chi_Minh', projectId: pBeta });
    expect(onlyBeta.todos).toEqual([]);
    expect(onlyBeta.tasks.map((t) => t.id)).toEqual([tBeta]);

    const onlyNone = await query<MyWork>(member.userId, orgId, 'notes.my_work', { timeZone: 'Asia/Ho_Chi_Minh', projectId: 'none' });
    expect(onlyNone.todos).toEqual([]);
    expect(onlyNone.tasks.map((t) => t.id)).toEqual([tUnassigned]);

    // 3. projects.task_projects via HTTP RPC resolves batch task -> project mappings for Tasks screen.
    const rpcRes = await rpc(fullApp, 'projects/taskProjects', member, { taskIds: [tAlpha, tBeta, tGamma, tUnassigned] }, slug);
    expect(rpcRes.status).toBe(200);
    const mapped = rpcRes.body as unknown as ProjectTaskProjectEntry[];
    expect(mapped.sort((a, b) => a.taskId.localeCompare(b.taskId))).toEqual(
      [
        { taskId: tAlpha, project: { id: pAlpha, name: 'Alpha Tax' } },
        { taskId: tBeta, project: { id: pBeta, name: 'Beta Launch' } },
        { taskId: tGamma, project: { id: pGamma, name: 'Gamma Audit' } },
      ].sort((a, b) => a.taskId.localeCompare(b.taskId)),
    );

    // 4. le_scope isolation: limitedMember sees task in entityA, never task in entityB (even via direct task_projects lookup).
    const { taskIdA, taskIdB } = await withAdmin(async (c) => {
      const a = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, legal_entity_id, assignee_position_id)
           VALUES ($1, 'Entity A Task', 'human', 'user', $2, $3) RETURNING id`,
          [orgId, ids.entityA, ids.seatLimited],
        )
      ).rows[0]?.id as string;
      const b = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.task (org_id, title, source, created_by_type, legal_entity_id, assignee_position_id)
           VALUES ($1, 'Entity B Secret Task', 'human', 'user', $2, $3) RETURNING id`,
          [orgId, ids.entityB, ids.seatMember],
        )
      ).rows[0]?.id as string;
      return { taskIdA: a, taskIdB: b };
    });
    await exec(owner.userId, orgId, 'projects.task.add', { projectId: pAlpha, taskId: taskIdA });
    await exec(owner.userId, orgId, 'projects.task.add', { projectId: pGamma, taskId: taskIdB });

    const limitedWork = await query<MyWork>(limitedMember.userId, orgId, 'notes.my_work', { timeZone: 'Asia/Ho_Chi_Minh' });
    expect(limitedWork.tasks.map((t) => [t.id, t.project?.id])).toEqual([[taskIdA, pAlpha]]);
    expect(JSON.stringify(limitedWork)).not.toContain(taskIdB);

    const limitedLookup = await query<ProjectTaskProjectEntry[]>(limitedMember.userId, orgId, 'projects.task_projects', {
      taskIds: [taskIdA, taskIdB],
    });
    expect(limitedLookup).toEqual([{ taskId: taskIdA, project: { id: pAlpha, name: 'Alpha Tax' } }]);
  });

  it('computes noSeatHint accurately for solo owner vs unseated team members vs seated members', async () => {
    // 1. Solo owner (1-member org, no seats) -> noSeatHint: false.
    const soloOwner = await newPerson('solo');
    const { orgId: soloOrgId } = await createOrg(fullRt, asUser(soloOwner.userId), 'Solo Company');
    const soloWork = await query<MyWork>(soloOwner.userId, soloOrgId, 'notes.my_work', {});
    expect(soloWork.noSeatHint).toBe(false);

    // 2. Team org with owner, member (no seat), admin (no seat), member (archived seat only), and viewer.
    const teamOwner = await newPerson('team-owner');
    const unseatedMember = await newPerson('unseated-member');
    const unseatedAdmin = await newPerson('unseated-admin');
    const archivedSeatMember = await newPerson('archived-seat');
    const viewer = await newPerson('viewer');
    const { orgId: teamOrgId } = await createOrg(fullRt, asUser(teamOwner.userId), 'Team Company');

    await withAdmin(async (c) => {
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role)
         VALUES ($1, $2, 'member'), ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'viewer')`,
        [teamOrgId, unseatedMember.userId, unseatedAdmin.userId, archivedSeatMember.userId, viewer.userId],
      );
      await c.query(
        `INSERT INTO crove_kernel.position (org_id, title, module, role_key, holder_user_id, status)
         VALUES ($1, 'Old Seat', 'kernel', 'staff', $2, 'archived')`,
        [teamOrgId, archivedSeatMember.userId],
      );
    });

    expect((await query<MyWork>(unseatedMember.userId, teamOrgId, 'notes.my_work', {})).noSeatHint).toBe(true);
    expect((await query<MyWork>(unseatedAdmin.userId, teamOrgId, 'notes.my_work', {})).noSeatHint).toBe(true);
    expect((await query<MyWork>(archivedSeatMember.userId, teamOrgId, 'notes.my_work', {})).noSeatHint).toBe(true);
    expect((await query<MyWork>(teamOwner.userId, teamOrgId, 'notes.my_work', {})).noSeatHint).toBe(false);
    expect((await query<MyWork>(viewer.userId, teamOrgId, 'notes.my_work', {})).noSeatHint).toBe(false);

    // 3. Owner creates an active seat and assigns it to unseatedMember -> noSeatHint becomes false.
    const { positionId } = await fullRt.execute<{ positionId: string }>(
      'kernel.position.create',
      { title: 'Salesperson', module: 'kernel', roleKey: 'staff' },
      { actor: asMfa(teamOwner.userId), orgId: teamOrgId, idempotencyKey: randomUUID() },
    );
    await fullRt.execute(
      'kernel.position.assign',
      { id: positionId, holder: { type: 'user', userId: unseatedMember.userId } },
      { actor: asMfa(teamOwner.userId), orgId: teamOrgId, idempotencyKey: randomUUID() },
    );
    expect((await query<MyWork>(unseatedMember.userId, teamOrgId, 'notes.my_work', {})).noSeatHint).toBe(false);
  });

  it('degrades smoothly when projects is omitted from CROVE_MODULES, turned off per org (apps_off), or unentitled', async () => {
    const owner = await newPerson('off-owner');
    const member = await newPerson('off-member');
    const { orgId, slug } = await createOrg(fullRt, asUser(owner.userId), 'Toggle Org');

    const seatId = await withAdmin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgId, member.userId]);
      return (
        await c.query<{ id: string }>(
          `INSERT INTO crove_kernel.position (org_id, title, module, role_key, holder_user_id, status)
           VALUES ($1, 'Staff', 'kernel', 'staff', $2, 'active') RETURNING id`,
          [orgId, member.userId],
        )
      ).rows[0]?.id as string;
    });

    const { projectId } = await exec<{ projectId: string }>(owner.userId, orgId, 'projects.project.create', { name: 'Alpha' });
    const { taskId } = await exec<{ taskId: string }>(owner.userId, orgId, 'projects.task.create', {
      projectId,
      title: 'Check receipts',
      assigneePositionId: seatId,
    });

    // Baseline: projects enabled everywhere.
    const onWork = await query<MyWork>(member.userId, orgId, 'notes.my_work', {});
    expect(onWork.projectsAvailable).toBe(true);
    expect(onWork.tasks.map((t) => [t.id, t.project])).toEqual([[taskId, { id: projectId, name: 'Alpha' }]]);

    // 1. Omitting projects from CROVE_MODULES (absentModules: ['projects']).
    const absentWork = await query<MyWork>(member.userId, orgId, 'notes.my_work', {}, noProjectsRt);
    expect(absentWork.projectsAvailable).toBe(false);
    expect(absentWork.tasks.map((t) => [t.id, t.project])).toEqual([[taskId, null]]);
    const absentRpc = await rpc(noProjectsApp, 'projects/taskProjects', member, { taskIds: [taskId] }, slug);
    expect(absentRpc.status).toBe(404);

    // 2. ADR-0053 per-org apps_off (kernel.org.set_app enabled: false).
    await exec(owner.userId, orgId, 'kernel.org.set_app', { module: 'projects', enabled: false });
    const offWork = await query<MyWork>(member.userId, orgId, 'notes.my_work', {});
    expect(offWork.projectsAvailable).toBe(false);
    expect(offWork.tasks.map((t) => [t.id, t.project])).toEqual([[taskId, null]]);

    const offRpc = await rpc(fullApp, 'projects/taskProjects', member, { taskIds: [taskId] }, slug);
    expect(offRpc.status).toBe(404);
    expect(offRpc.body).toMatchObject({ code: 'MODULE_OFF' });
    const offListRpc = await rpc(fullApp, 'projects/list', member, {}, slug);
    expect(offListRpc.status).toBe(404);
    expect(offListRpc.body).toMatchObject({ code: 'MODULE_OFF' });

    // Re-enabling restores project mapping cleanly.
    await exec(owner.userId, orgId, 'kernel.org.set_app', { module: 'projects', enabled: true });
    const restoredWork = await query<MyWork>(member.userId, orgId, 'notes.my_work', {});
    expect(restoredWork.projectsAvailable).toBe(true);
    expect(restoredWork.tasks.map((t) => [t.id, t.project])).toEqual([[taskId, { id: projectId, name: 'Alpha' }]]);

    // 3. ADR-0053 unentitled org (entitlements omit 'projects').
    const unentitledWork = await query<MyWork>(member.userId, orgId, 'notes.my_work', {}, unentitledRt);
    expect(unentitledWork.projectsAvailable).toBe(false);
    expect(unentitledWork.tasks.map((t) => [t.id, t.project])).toEqual([[taskId, null]]);
    const unentitledRpc = await rpc(unentitledApp, 'projects/taskProjects', member, { taskIds: [taskId] }, slug);
    expect(unentitledRpc.status).toBe(404);
    expect(unentitledRpc.body).toMatchObject({ code: 'MODULE_OFF' });
  });
});

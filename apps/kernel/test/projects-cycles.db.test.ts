// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL integration tests for Projects v2 Sprints / Cycles, Story points, Burndown/Velocity,
// carryover atomicity, RBAC, agent refusal, PDPL erasure, offboarding export coverage, org_purge, and Vy Cycle Summary (#4361).
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SignJWT } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import type {
  PersonalDataErasure,
  PersonalDataResult,
  ProjectBoard,
  ProjectCycleCompleteResult,
  ProjectCycleListResult,
  ProjectCycleMetrics,
  ProjectCycleMutateResult,
  ProjectCycleSummary,
  ProjectDetail,
} from '@ludy/kernel-contract';
import { CredentialVault, LocalDiskStore, Runtime, type AgentActor, parseVaultKey } from '@ludy/kernel-runtime';
import { financeCommands } from '@ludy/mod-finance';
import { projectsCommands, projectsQueries, type ProjectCycleSummarySource } from '@ludy/mod-projects';
import { memberMeter } from '../src/ai-meter.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { ExportSealer, exportAad } from '../src/export-seal.ts';
import { createHttpApp } from '../src/http.ts';
import { runOrgExport } from '../src/org-export.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { contextToken } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const SECRET = 'test-only-jwt-secret-for-projects-cycles-0123456789';
const ISSUER = 'crove-auth';
const DAY = 24 * 60 * 60 * 1000;
const suite = ADMIN ? describe : describe.skip;

const asUser = (userId: string) => ({
  type: 'user' as const,
  userId,
  email: `${userId}@example.com`,
  aal: 'aal1' as const,
  sessionId: randomUUID(),
});
const asMfa = (userId: string) => ({
  type: 'user' as const,
  userId,
  email: `${userId}@example.com`,
  aal: 'aal2' as const,
  sessionId: randomUUID(),
  mfaAt: Math.floor(Date.now() / 1000),
});

interface Person {
  subject: string;
  email: string;
  userId: string;
}

suite('Projects v2 Cycles & Story Points on PostgreSQL (#4361)', () => {
  let dbName = '';
  let adminUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let workerRt: Runtime;
  let dir = '';
  let store: LocalDiskStore;
  let appOn: ReturnType<typeof createHttpApp>;
  let appOff: ReturnType<typeof createHttpApp>;
  let lastPromptSeen = '';

  let owner: Person;
  let member: Person;
  let viewer: Person;
  let outsider: Person;
  let orgId = '';
  let orgSlug = '';
  let otherOrgId = '';

  const token = (person: Person) =>
    new SignJWT({
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

  async function postRpc<T>(app: ReturnType<typeof createHttpApp>, person: Person, path: string, body: unknown, slug = orgSlug) {
    const jwt = await token(person);
    const res = await app.request(`/api/rpc/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${jwt}`,
        'content-type': 'application/json',
        ...(slug ? { 'x-crove-org': slug } : {}),
      },
      body: JSON.stringify(body === undefined ? {} : { json: body }),
    });
    const parsed = (await res.json().catch(() => null)) as ({ json?: unknown } & Record<string, unknown>) | null;
    return { status: res.status, body: (parsed && 'json' in parsed ? parsed.json : parsed) as T };
  }

  const exec = <O = unknown>(userId: string, targetOrgId: string, name: string, input: unknown) =>
    rt.execute<O>(name, input, { actor: asUser(userId), orgId: targetOrgId, idempotencyKey: randomUUID() });

  const query = <O = unknown>(userId: string, targetOrgId: string, name: string, input: unknown) =>
    rt.query<O>(name, input, { actor: asUser(userId), orgId: targetOrgId });

  async function newPerson(tag: string): Promise<Person> {
    const subject = randomUUID();
    const email = `${tag}-${randomUUID().slice(0, 8)}@cycles.test`;
    const userId = await upsertIdentity(db, { issuer: ISSUER, subject, email, name: `User ${tag}` });
    return { subject, email, userId };
  }

  beforeAll(async () => {
    dbName = `ludy_test_cycles_${Date.now()}_${randomBytes(3).toString('hex')}`;
    const setup = new pg.Client({ connectionString: ADMIN });
    await setup.connect();
    try {
      await setup.query(`CREATE DATABASE ${dbName}`);
    } finally {
      await setup.end();
    }
    const u = new URL(ADMIN!);
    u.pathname = `/${dbName}`;
    adminUrl = u.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const wUrl = new URL(adminUrl);
    wUrl.username = 'ludy_worker';
    wUrl.password = 'test-worker-pw';
    workerUrl = wUrl.toString();

    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    db = createDb(pool);
    dir = await mkdtemp(join(tmpdir(), 'crove-proj-cycles-'));
    store = new LocalDiskStore(dir);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...projectsCommands, ...financeCommands, orgPurgeCommand({ store })],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });

    const config = loadConfig({
      DATABASE_URL: appUrl.toString(),
      AUTH_JWT_SECRET: SECRET,
      AUTH_ISSUER: ISSUER,
      AUTH_SESSION_CHECK: 'off',
      MIGRATIONS_DIR: MIGRATIONS,
      WEB_DIST: '/nonexistent',
    });
    const vault = new CredentialVault([parseVaultKey(randomBytes(32).toString('base64'))]);
    const reader = new InboxReader(
      { baseURL: 'http://model.invalid/v1', apiKey: null, model: 'test', maxRetries: 0 },
      {
        projectCycleSummary: async ({ prompt }) => {
          lastPromptSeen = prompt;
          return {
            output: {
              sentences: [
                'Chu kỳ 1 đã hoàn thành 1 việc với 5 điểm.',
                'Không còn việc dở dang nào trong chu kỳ này.',
                'Tốc độ trung bình hiện tại đạt 5 điểm mỗi chu kỳ.',
              ],
            },
            usage: { inputTokens: 20, outputTokens: 15 },
          };
        },
      },
    );
    const meterFor = (actor: Parameters<typeof memberMeter>[1]) =>
      memberMeter(rt, actor, { price: { inputPerMTok: '100', outputPerMTok: '200' } });

    appOn = createHttpApp({
      config,
      runtime: rt,
      store,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: true,
      aiMeter: meterFor,
      conversationReader: reader,
      channels: { broker: vault, sandbox: false },
    });
    appOff = createHttpApp({
      config,
      runtime: rt,
      store,
      authenticate: createAuthenticator(config, db),
      pool,
      aiEnabled: false,
      aiMeter: meterFor,
      channels: { broker: vault, sandbox: false },
    });

    owner = await newPerson('cycles-owner');
    member = await newPerson('cycles-member');
    viewer = await newPerson('cycles-viewer');
    outsider = await newPerson('cycles-outsider');

    const orgA = await createOrg(rt, asUser(owner.userId), 'Cycles Org A');
    orgId = orgA.orgId;
    orgSlug = orgA.slug;
    const orgB = await createOrg(rt, asUser(outsider.userId), 'Cycles Org B');
    otherOrgId = orgB.orgId;

    const adminClient = new pg.Client({ connectionString: adminUrl });
    await adminClient.connect();
    try {
      await adminClient.query(
        `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES
         ($1, $2, 'member'), ($1, $3, 'viewer')`,
        [orgId, member.userId, viewer.userId],
      );
    } finally {
      await adminClient.end();
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await workerPool?.end().catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (dbName && ADMIN) {
      const cleanup = new pg.Client({ connectionString: ADMIN });
      await cleanup.connect();
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      } finally {
        await cleanup.end();
      }
    }
  });

  it('supports opt-in cycles, single active cycle, carryover atomicity, RBAC/agent refusal, PDPL erasure, org_purge, and Vy privacy', async () => {
    const { projectId } = await exec<{ projectId: string }>(owner.userId, orgId, 'projects.project.create', {
      name: 'Dự án Sprint chính',
    });

    const detail = await query<ProjectDetail>(owner.userId, orgId, 'projects.project.get', { id: projectId });
    expect(detail.cyclesEnabled).toBe(false);
    expect(detail.cycleDurationWeeks).toBe(2);
    expect(detail.pointsEnabled).toBe(false);

    // Member cannot toggle settings; agent context cannot run cycle/point commands or write project_cycle directly.
    await expect(
      exec(member.userId, orgId, 'projects.project.update', { projectId, cyclesEnabled: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const installed = await rt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Cycle Bot' },
      { actor: asMfa(owner.userId), orgId, idempotencyKey: randomUUID() },
    );
    await exec(owner.userId, orgId, 'kernel.task.create', {
      title: 'Wake agent for cycle guard test',
      assigneePositionId: installed.positionId,
    });
    const started = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: { type: 'system', component: 'test' }, orgId },
    );
    expect(started).toMatchObject({ runId: expect.any(String) });
    const agentActor: AgentActor = { type: 'agent', agentId: installed.agentId, runId: started.runId as string };

    await expect(
      rt.execute(
        'projects.cycle.create',
        { projectId, name: 'Agent Sprint' },
        { actor: agentActor, orgId, idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const workerClient = new pg.Client({ connectionString: workerUrl });
    await workerClient.connect();
    try {
      await workerClient.query('BEGIN');
      await workerClient.query('SELECT ludy_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agentActor.agentId, agentActor.runId]);
      await expect(
        workerClient.query(
          `INSERT INTO ludy_projects.project_cycle (org_id, project_id, number, name, starts_on, ends_on, created_by)
           VALUES ($1, $2, 99, 'Direct Agent Cycle', '2027-03-01', '2027-03-14', $3)`,
          [orgId, projectId, owner.userId],
        ),
      ).rejects.toThrow(/AGENT_FORBIDDEN|row-level security|permission denied/);
    } finally {
      await workerClient.query('ROLLBACK').catch(() => {});
      await workerClient.end();
    }

    await exec(owner.userId, orgId, 'projects.project.update', {
      projectId,
      cyclesEnabled: true,
      cycleDurationWeeks: 2,
      pointsEnabled: true,
    });

    const piiEmail = 'minh.cycles@example.com';
    const { cycle: s1 } = await exec<ProjectCycleMutateResult>(owner.userId, orgId, 'projects.cycle.create', {
      projectId,
      name: `Sprint 1 - ${piiEmail}`,
      goal: `Chốt hợp đồng cho ${piiEmail}`,
      startsOn: '2027-02-01',
      endsOn: '2027-02-14',
    });
    const { cycle: s2 } = await exec<ProjectCycleMutateResult>(owner.userId, orgId, 'projects.cycle.create', {
      projectId,
      name: 'Sprint 2',
    });
    expect(s1.number).toBe(1);
    expect(s2.number).toBe(2);
    expect(s2.startsOn).toBe('2027-02-15');

    await exec(owner.userId, orgId, 'projects.cycle.start', { projectId, cycleId: s1.id });
    await expect(
      exec(owner.userId, orgId, 'projects.cycle.start', { projectId, cycleId: s2.id }),
    ).rejects.toMatchObject({ code: 'ACTIVE_CYCLE_EXISTS', status: 409 });

    await expect(
      exec(owner.userId, orgId, 'projects.cycle.delete', { projectId, cycleId: s1.id }),
    ).rejects.toMatchObject({ code: 'CYCLE_NOT_UPCOMING' });

    const { taskId: tDone } = await exec<{ taskId: string }>(member.userId, orgId, 'projects.task.create', {
      projectId,
      title: 'Hoàn thành API thanh toán',
      assigneePositionId: null,
      status: 'done',
      cycleId: s1.id,
      storyPoints: 5,
    });
    const { taskId: tOpen } = await exec<{ taskId: string }>(member.userId, orgId, 'projects.task.create', {
      projectId,
      title: 'Kiểm thử luồng',
      assigneePositionId: null,
      status: 'in_progress',
    });
    await exec(member.userId, orgId, 'projects.task.set_cycle', { projectId, taskId: tOpen, cycleId: s1.id });
    await exec(member.userId, orgId, 'projects.task.set_points', { projectId, taskId: tOpen, storyPoints: 8 });

    await expect(
      exec(viewer.userId, orgId, 'projects.task.set_points', { projectId, taskId: tOpen, storyPoints: 3 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      exec(viewer.userId, orgId, 'projects.cycle.create', { projectId, name: 'Viewer Sprint' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const metrics = await query<ProjectCycleMetrics>(viewer.userId, orgId, 'projects.cycle.metrics', { projectId });
    expect(metrics.selectedCycle?.id).toBe(s1.id);
    expect(metrics.burndown).toHaveLength(14);
    expect(metrics.burndown[0]?.idealRemainingPoints).toBe(13);

    const activeBoard = await query<ProjectBoard>(viewer.userId, orgId, 'projects.board', {
      projectId,
      cycleFilter: { mode: 'active' },
    });
    expect(activeBoard.tasks.map((t) => t.id).sort()).toEqual([tDone, tOpen].sort());

    await expect(
      exec(owner.userId, orgId, 'projects.cycle.complete', {
        projectId,
        cycleId: s1.id,
        carryover: { mode: 'none' },
      }),
    ).rejects.toMatchObject({ code: 'CYCLE_OPEN_TASKS_EXIST', status: 409 });

    const doneRes = await exec<ProjectCycleCompleteResult>(owner.userId, orgId, 'projects.cycle.complete', {
      projectId,
      cycleId: s1.id,
      carryover: { mode: 'cycle', targetCycleId: s2.id },
    });
    expect(doneRes.cycle.status).toBe('completed');
    expect(doneRes.carriedOverCount).toBe(1);
    expect(doneRes.targetCycleId).toBe(s2.id);
    expect(doneRes.cycle.totalTasks).toBe(2);
    expect(doneRes.cycle.openTasks).toBe(1);
    expect(doneRes.cycle.doneTasks).toBe(1);
    expect(doneRes.cycle.totalPoints).toBe(13);
    expect(doneRes.cycle.donePoints).toBe(5);

    await expect(
      exec(owner.userId, orgId, 'projects.task.set_cycle', { projectId, taskId: tOpen, cycleId: s1.id }),
    ).rejects.toMatchObject({ code: 'CYCLE_COMPLETED' });

    const postMetrics = await query<ProjectCycleMetrics>(owner.userId, orgId, 'projects.cycle.metrics', { projectId });
    expect(postMetrics.velocity).toHaveLength(1);
    expect(postMetrics.velocity[0]?.completedTasks).toBe(1);
    expect(postMetrics.velocity[0]?.totalTasks).toBe(2);
    expect(postMetrics.velocity[0]?.completedPoints).toBe(5);
    expect(postMetrics.velocity[0]?.committedPoints).toBe(13);

    // Delete upcoming cycle clears task assignment back to backlog, and test update / filter / points 0 / toggle-off preservation.
    const { cycle: s3 } = await exec<ProjectCycleMutateResult>(owner.userId, orgId, 'projects.cycle.create', {
      projectId,
      name: 'Sprint 3 temp',
    });
    const { cycle: s3Updated } = await exec<ProjectCycleMutateResult>(owner.userId, orgId, 'projects.cycle.update', {
      projectId,
      cycleId: s3.id,
      name: 'Sprint 3 updated',
      goal: 'Updated goal',
    });
    expect(s3Updated.name).toBe('Sprint 3 updated');
    await exec(owner.userId, orgId, 'projects.task.set_cycle', { projectId, taskId: tOpen, cycleId: s3.id });
    const upcomingBoard = await query<ProjectBoard>(viewer.userId, orgId, 'projects.board', {
      projectId,
      cycleFilter: { mode: 'upcoming' },
    });
    expect(upcomingBoard.tasks.some((t) => t.id === tOpen)).toBe(true);

    await exec(owner.userId, orgId, 'projects.cycle.delete', { projectId, cycleId: s3.id });
    const backlogBoard = await query<ProjectBoard>(viewer.userId, orgId, 'projects.board', {
      projectId,
      cycleFilter: { mode: 'backlog' },
    });
    expect(backlogBoard.tasks.find((t) => t.id === tOpen)?.cycleId).toBeNull();

    // Clear cycle assignment explicitly & allow 0 story points end-to-end.
    await exec(member.userId, orgId, 'projects.task.set_cycle', { projectId, taskId: tOpen, cycleId: s2.id });
    await exec(member.userId, orgId, 'projects.task.set_cycle', { projectId, taskId: tOpen, cycleId: null });
    const clearedPts = await exec<{ storyPoints: number | null }>(member.userId, orgId, 'projects.task.set_points', {
      projectId,
      taskId: tOpen,
      storyPoints: 0,
    });
    expect(clearedPts.storyPoints).toBe(0);

    // Toggling cyclesEnabled / pointsEnabled off preserves historical cycle & velocity rows.
    await exec(owner.userId, orgId, 'projects.project.update', {
      projectId,
      cyclesEnabled: false,
      pointsEnabled: false,
    });
    const preservedCycles = await query<ProjectCycleListResult>(viewer.userId, orgId, 'projects.cycle.list', { projectId });
    expect(preservedCycles.cycles.some((c) => c.id === s1.id)).toBe(true);
    await exec(owner.userId, orgId, 'projects.project.update', {
      projectId,
      cyclesEnabled: true,
      pointsEnabled: true,
    });

    // Cross-org isolation.
    await expect(
      query<ProjectCycleListResult>(outsider.userId, otherOrgId, 'projects.cycle.list', { projectId }),
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    // Export coverage & PDPL personal-data find/erase on cycle name & goal.
    expect(EXPORT_TABLE_NAMES).toEqual(
      expect.arrayContaining([
        'projects.project_cycle',
        'projects.project_cycle_snapshot',
        'projects.project_cycle_task_history',
      ]),
    );
    const found = await rt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: piiEmail },
      { actor: asUser(owner.userId), orgId, idempotencyKey: randomUUID() },
    );
    expect(found.matches.map((m) => m.column)).toEqual(
      expect.arrayContaining(['ludy_projects.project_cycle.name', 'ludy_projects.project_cycle.goal']),
    );
    const erased = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: piiEmail },
      { actor: asMfa(owner.userId), orgId, idempotencyKey: randomUUID() },
    );
    expect(erased.erased.some((r) => r.column === 'ludy_projects.project_cycle.name' && r.rows === 1)).toBe(true);
    expect(erased.erased.some((r) => r.column === 'ludy_projects.project_cycle.goal' && r.rows === 1)).toBe(true);

    // Vy cycle summary never reads ludy_notes and degrades gracefully when AI is off.
    const adminClient = new pg.Client({ connectionString: adminUrl });
    await adminClient.connect();
    try {
      await adminClient.query(
        `INSERT INTO ludy_notes.note (org_id, author_user_id, visibility, title, body)
         VALUES ($1, $2, 'org', 'TOP_SECRET_NOTE_999', 'Secret note text TOP_SECRET_NOTE_999')`,
        [orgId, owner.userId],
      );
    } finally {
      await adminClient.end();
    }

    const summaryOn = await postRpc<ProjectCycleSummary>(appOn, owner, 'projects/cycleSummary', {
      projectId,
      cycleId: s1.id,
      language: 'vi',
    });
    expect(summaryOn.status).toBe(200);
    expect(summaryOn.body.ai).toBe('used');
    expect(summaryOn.body.sentences).toHaveLength(3);
    expect(lastPromptSeen).not.toContain('TOP_SECRET_NOTE_999');

    const summaryOff = await postRpc<ProjectCycleSummary>(appOff, owner, 'projects/cycleSummary', {
      projectId,
      cycleId: s1.id,
      language: 'vi',
    });
    expect(summaryOff.status).toBe(200);
    expect(summaryOff.body.ai).toBe('off');
    expect(summaryOff.body.metrics.velocity).toHaveLength(1);

    // Agent checkout holds an active lease: set_cycle and set_points reject with 409 TASK_CHECKED_OUT
    // until the agent transitions status with its active fence and releases the lease.
    const { taskId: tBot } = await exec<{ taskId: string }>(owner.userId, orgId, 'projects.task.create', {
      projectId,
      title: 'Tác vụ bot kiểm tra TASK_CHECKED_OUT',
      assigneePositionId: installed.positionId,
    });
    const checkedOut = await workerRt.execute<{ fence: string }>(
      'kernel.task.checkout',
      { id: tBot },
      { actor: agentActor, orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      exec(member.userId, orgId, 'projects.task.set_cycle', { projectId, taskId: tBot, cycleId: s2.id }),
    ).rejects.toMatchObject({ code: 'TASK_CHECKED_OUT', status: 409 });
    await expect(
      exec(member.userId, orgId, 'projects.task.set_points', { projectId, taskId: tBot, storyPoints: 3 }),
    ).rejects.toMatchObject({ code: 'TASK_CHECKED_OUT', status: 409 });

    await workerRt.execute(
      'kernel.task.set_status',
      { id: tBot, status: 'done', fence: checkedOut.fence },
      { actor: agentActor, orgId, idempotencyKey: randomUUID() },
    );
    const botDoneCheck = await new pg.Client({ connectionString: adminUrl });
    await botDoneCheck.connect();
    try {
      const { rows: botDoneRows } = await botDoneCheck.query<{ done_at: Date | null }>(
        'SELECT done_at FROM ludy_kernel.task WHERE org_id = $1 AND id = $2',
        [orgId, tBot],
      );
      expect(botDoneRows[0]?.done_at).not.toBeNull();
    } finally {
      await botDoneCheck.end();
    }
    await exec(member.userId, orgId, 'projects.task.set_cycle', { projectId, taskId: tBot, cycleId: s2.id });
    await exec(member.userId, orgId, 'projects.task.set_points', { projectId, taskId: tBot, storyPoints: 3 });

    // Export, offboard, and backdate audit events so ludy_kernel.org_purge deletes ludy_projects cycle/history/snapshot rows cleanly.
    const sealer = new ExportSealer(randomBytes(32));
    const generatedAt = new Date(Date.now() - 35 * DAY);
    const exported = await runOrgExport({ runtime: workerRt, store, sealer, retentionDays: 40 }, orgId, {
      now: () => generatedAt,
    });
    expect(exported.parts.some((p) => p.table === 'projects.project_cycle_snapshot')).toBe(true);
    expect(exported.parts.some((p) => p.table === 'projects.project_cycle_task_history')).toBe(true);
    const cyclePart = exported.parts.find((p) => p.table === 'projects.project_cycle');
    expect(cyclePart).toBeDefined();
    if (!cyclePart) throw new Error('missing projects.project_cycle export part');
    const rawCycles = await store.get(cyclePart.key);
    const decodedCycles = new TextDecoder()
      .decode(sealer.open(rawCycles, exportAad(orgId, cyclePart), 'aes-256-gcm'))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string });
    expect(decodedCycles.map((r) => r.id)).toEqual(expect.arrayContaining([s1.id, s2.id]));
    await rt.execute('kernel.org.offboard', { confirmSlug: orgSlug }, { actor: asMfa(owner.userId), orgId });
    const purgeAdmin = new pg.Client({ connectionString: adminUrl });
    await purgeAdmin.connect();
    try {
      await purgeAdmin.query('BEGIN');
      await purgeAdmin.query('SET LOCAL session_replication_role = replica');
      await purgeAdmin.query(
        `UPDATE ludy_kernel.audit_event
         SET occurred_at = $1
         WHERE org_id = $2 AND command IN ('kernel.org.offboard', 'kernel.org.export.record')`,
        [new Date(Date.now() - 32 * DAY), orgId],
      );
      await purgeAdmin.query('COMMIT');
    } finally {
      await purgeAdmin.end();
    }
    const purged = await purgeOrg(workerRt, 30, { ref: orgId, reason: 'projects-cycles-test' });
    expect(purged).toMatchObject({ kind: 'purged', orgId });

    const verifyAdmin = new pg.Client({ connectionString: adminUrl });
    await verifyAdmin.connect();
    try {
      const { rows } = await verifyAdmin.query<{
        cycles: string;
        snapshots: string;
        histories: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM ludy_projects.project_cycle WHERE org_id = $1) AS cycles,
           (SELECT count(*)::text FROM ludy_projects.project_cycle_snapshot WHERE org_id = $1) AS snapshots,
           (SELECT count(*)::text FROM ludy_projects.project_cycle_task_history WHERE org_id = $1) AS histories`,
        [orgId],
      );
      expect(rows[0]).toEqual({ cycles: '0', snapshots: '0', histories: '0' });
    } finally {
      await verifyAdmin.end();
    }
  });

  it('refuses cycle delete and complete on checked-out agent leases (409 TASK_CHECKED_OUT) and le_scope hidden tasks (403 FORBIDDEN)', async () => {
    const guardOwner = await newPerson('cycle-guard-owner');
    const branchManager = await newPerson('cycle-branch-mgr');
    const guardOrg = await createOrg(rt, asUser(guardOwner.userId), 'Cycle Guards Org');

    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: branchManager.email, role: 'member' },
      { actor: asMfa(guardOwner.userId), orgId: guardOrg.orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless(
      'kernel.member.invite.accept',
      { token: inv.acceptPath.split('#')[1] },
      { actor: asUser(branchManager.userId) },
    );

    const installed = await rt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', displayName: 'Cycle Guard Bot' },
      { actor: asMfa(guardOwner.userId), orgId: guardOrg.orgId, idempotencyKey: randomUUID() },
    );

    let defaultEntityId = '';
    let branchEntityId = '';
    let hiddenUpcomingTaskId = '';
    let hiddenActiveTaskId = '';
    const guardAdmin = new pg.Client({ connectionString: adminUrl });
    await guardAdmin.connect();
    try {
      defaultEntityId = (
        await guardAdmin.query<{ id: string }>(
          'SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default',
          [guardOrg.orgId],
        )
      ).rows[0]?.id as string;
      branchEntityId = (
        await guardAdmin.query<{ id: string }>(
          `INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by)
           VALUES ($1, 'Chi nhánh Guard', 'branch', $2) RETURNING id`,
          [guardOrg.orgId, guardOwner.userId],
        )
      ).rows[0]?.id as string;
      await guardAdmin.query(
        `INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by)
         VALUES ($1, $2, 'external_accountant', $3, $4)`,
        [guardOrg.orgId, branchManager.userId, branchEntityId, guardOwner.userId],
      );
      hiddenUpcomingTaskId = (
        await guardAdmin.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Việc trụ sở ẩn upcoming', 'human', 'user', $2) RETURNING id`,
          [guardOrg.orgId, defaultEntityId],
        )
      ).rows[0]?.id as string;
      hiddenActiveTaskId = (
        await guardAdmin.query<{ id: string }>(
          `INSERT INTO ludy_kernel.task (org_id, title, source, created_by_type, legal_entity_id)
           VALUES ($1, 'Việc trụ sở ẩn active', 'human', 'user', $2) RETURNING id`,
          [guardOrg.orgId, defaultEntityId],
        )
      ).rows[0]?.id as string;
    } finally {
      await guardAdmin.end();
    }

    const { projectId } = await exec<{ projectId: string }>(guardOwner.userId, guardOrg.orgId, 'projects.project.create', {
      name: 'Dự án kiểm tra guard',
      ownerUserId: branchManager.userId,
    });
    await exec(guardOwner.userId, guardOrg.orgId, 'projects.project.update', {
      projectId,
      cyclesEnabled: true,
    });

    const { cycle: upcomingLe } = await exec<ProjectCycleMutateResult>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.cycle.create',
      { projectId, name: 'LE Upcoming' },
    );
    const { cycle: activeLe } = await exec<ProjectCycleMutateResult>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.cycle.create',
      { projectId, name: 'LE Active' },
    );
    await exec(guardOwner.userId, guardOrg.orgId, 'projects.cycle.start', { projectId, cycleId: activeLe.id });

    await exec(guardOwner.userId, guardOrg.orgId, 'projects.task.add', { projectId, taskId: hiddenUpcomingTaskId });
    await exec(guardOwner.userId, guardOrg.orgId, 'projects.task.set_cycle', {
      projectId,
      taskId: hiddenUpcomingTaskId,
      cycleId: upcomingLe.id,
    });
    await exec(guardOwner.userId, guardOrg.orgId, 'projects.task.add', { projectId, taskId: hiddenActiveTaskId });
    await exec(guardOwner.userId, guardOrg.orgId, 'projects.task.set_cycle', {
      projectId,
      taskId: hiddenActiveTaskId,
      cycleId: activeLe.id,
    });

    // Entity-scoped project manager gets 403 FORBIDDEN rather than detaching/closing le_scope-hidden tasks.
    await expect(
      exec(branchManager.userId, guardOrg.orgId, 'projects.cycle.delete', { projectId, cycleId: upcomingLe.id }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    await expect(
      exec(branchManager.userId, guardOrg.orgId, 'projects.cycle.complete', {
        projectId,
        cycleId: activeLe.id,
        carryover: { mode: 'backlog' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });

    // Unrestricted owner can delete upcoming and complete active cleanly once visible.
    await exec(guardOwner.userId, guardOrg.orgId, 'projects.cycle.delete', { projectId, cycleId: upcomingLe.id });
    const completedHiddenRes = await exec<ProjectCycleCompleteResult>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.cycle.complete',
      { projectId, cycleId: activeLe.id, carryover: { mode: 'backlog' } },
    );
    expect(completedHiddenRes.cycle.status).toBe('completed');
    expect(completedHiddenRes.carriedOverCount).toBe(1);

    // Restricted le_scope caller cannot see hidden-entity snapshot points/counts in completed cycles.
    const restrictedCompletedMetrics = await query<ProjectCycleMetrics>(
      branchManager.userId,
      guardOrg.orgId,
      'projects.cycle.metrics',
      { projectId, cycleId: activeLe.id },
    );
    expect(restrictedCompletedMetrics.hiddenByEntityCount).toBe(1);
    expect(restrictedCompletedMetrics.selectedCycle?.totalTasks).toBe(0);
    expect(restrictedCompletedMetrics.selectedCycle?.totalPoints).toBe(0);
    expect(restrictedCompletedMetrics.velocity).toEqual([
      expect.objectContaining({
        cycleId: activeLe.id,
        totalTasks: 0,
        committedPoints: 0,
        completedTasks: 0,
        completedPoints: 0,
      }),
    ]);

    // Checked-out lease tests for cycle.delete (all tasks) and cycle.complete (open tasks).
    const { cycle: leaseUpcoming } = await exec<ProjectCycleMutateResult>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.cycle.create',
      { projectId, name: 'Lease Upcoming' },
    );
    const { cycle: leaseActive } = await exec<ProjectCycleMutateResult>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.cycle.create',
      { projectId, name: 'Lease Active' },
    );
    await exec(guardOwner.userId, guardOrg.orgId, 'projects.cycle.start', { projectId, cycleId: leaseActive.id });

    const { taskId: tLeaseUp } = await exec<{ taskId: string }>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.task.create',
      {
        projectId,
        title: 'Task đang checkout trong cycle sắp tới',
        assigneePositionId: installed.positionId,
        cycleId: leaseUpcoming.id,
      },
    );
    const { taskId: tLeaseAct } = await exec<{ taskId: string }>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.task.create',
      {
        projectId,
        title: 'Task đang checkout trong cycle đang chạy',
        assigneePositionId: installed.positionId,
        cycleId: leaseActive.id,
      },
    );

    const startedRun = await workerRt.execute<{ runId: string | null }>(
      'kernel.agent.run.start',
      { agentId: installed.agentId },
      { actor: { type: 'system', component: 'test' }, orgId: guardOrg.orgId },
    );
    const agentActor: AgentActor = {
      type: 'agent',
      agentId: installed.agentId,
      runId: startedRun.runId as string,
    };

    const upCheckout = await workerRt.execute<{ fence: string }>(
      'kernel.task.checkout',
      { id: tLeaseUp },
      { actor: agentActor, orgId: guardOrg.orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      exec(guardOwner.userId, guardOrg.orgId, 'projects.cycle.delete', { projectId, cycleId: leaseUpcoming.id }),
    ).rejects.toMatchObject({ code: 'TASK_CHECKED_OUT', status: 409 });

    await workerRt.execute(
      'kernel.task.set_status',
      { id: tLeaseUp, status: 'in_review', fence: upCheckout.fence },
      { actor: agentActor, orgId: guardOrg.orgId, idempotencyKey: randomUUID() },
    );
    await exec(guardOwner.userId, guardOrg.orgId, 'projects.cycle.delete', { projectId, cycleId: leaseUpcoming.id });

    const actCheckout = await workerRt.execute<{ fence: string }>(
      'kernel.task.checkout',
      { id: tLeaseAct },
      { actor: agentActor, orgId: guardOrg.orgId, idempotencyKey: randomUUID() },
    );
    await expect(
      exec(guardOwner.userId, guardOrg.orgId, 'projects.cycle.complete', {
        projectId,
        cycleId: leaseActive.id,
        carryover: { mode: 'backlog' },
      }),
    ).rejects.toMatchObject({ code: 'TASK_CHECKED_OUT', status: 409 });

    await workerRt.execute(
      'kernel.task.set_status',
      { id: tLeaseAct, status: 'in_review', fence: actCheckout.fence },
      { actor: agentActor, orgId: guardOrg.orgId, idempotencyKey: randomUUID() },
    );
    const completeAfterRelease = await exec<ProjectCycleCompleteResult>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.cycle.complete',
      { projectId, cycleId: leaseActive.id, carryover: { mode: 'backlog' } },
    );
    expect(completeAfterRelease.cycle.status).toBe('completed');
    expect(completeAfterRelease.carriedOverCount).toBe(1);

    // mode='none' succeeds with zero unfinished tasks, and cycle_summary_source filters tainted tasks in SQL.
    const { cycle: cleanCycle } = await exec<ProjectCycleMutateResult>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.cycle.create',
      { projectId, name: 'Clean Completed Cycle' },
    );
    await exec(guardOwner.userId, guardOrg.orgId, 'projects.cycle.start', { projectId, cycleId: cleanCycle.id });
    const { taskId: cleanTaskId } = await exec<{ taskId: string }>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.task.create',
      {
        projectId,
        title: 'Clean finished task for summary',
        assigneePositionId: null,
        status: 'done',
        cycleId: cleanCycle.id,
      },
    );
    const { taskId: taintedTaskId } = await exec<{ taskId: string }>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.task.create',
      {
        projectId,
        title: 'Tainted AI title ignored by Vy source',
        assigneePositionId: null,
        status: 'done',
        cycleId: cleanCycle.id,
      },
    );
    const taintAdmin = new pg.Client({ connectionString: adminUrl });
    await taintAdmin.connect();
    try {
      await taintAdmin.query(`UPDATE ludy_kernel.task SET tainted = true WHERE org_id = $1 AND id = $2`, [
        guardOrg.orgId,
        taintedTaskId,
      ]);
    } finally {
      await taintAdmin.end();
    }

    const sourceWithTaint = await query<ProjectCycleSummarySource>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.cycle_summary_source',
      { projectId, cycleId: cleanCycle.id },
    );
    expect(sourceWithTaint.tasks.map((t) => t.id)).toEqual([cleanTaskId]);

    const noneCompleteRes = await exec<ProjectCycleCompleteResult>(
      guardOwner.userId,
      guardOrg.orgId,
      'projects.cycle.complete',
      { projectId, cycleId: cleanCycle.id, carryover: { mode: 'none' } },
    );
    expect(noneCompleteRes.cycle.status).toBe('completed');
    expect(noneCompleteRes.carriedOverCount).toBe(0);
  });

  it('tracks done_at immutability, multi-day cycle history burndown, immutable close snapshots, and private-project isolation (#4431)', async () => {
    const pOwner = await newPerson('snap-owner');
    const pMember = await newPerson('snap-member');
    const pNonMember = await newPerson('snap-nonmember');
    const snapOrg = await createOrg(rt, asUser(pOwner.userId), 'Snapshot Burndown Org');

    for (const person of [pMember, pNonMember]) {
      const inv = await rt.execute<{ acceptPath: string }>(
        'kernel.member.invite.create',
        { email: person.email, role: 'member' },
        { actor: asMfa(pOwner.userId), orgId: snapOrg.orgId, idempotencyKey: randomUUID() },
      );
      await rt.executeOrgless(
        'kernel.member.invite.accept',
        { token: inv.acceptPath.split('#')[1] },
        { actor: asUser(person.userId) },
      );
    }

    const { projectId } = await exec<{ projectId: string }>(pOwner.userId, snapOrg.orgId, 'projects.project.create', {
      name: 'Dự án snapshot & lịch sử chu kỳ',
      visibility: 'private',
      memberUserIds: [pMember.userId],
    });
    await exec(pOwner.userId, snapOrg.orgId, 'projects.project.update', {
      projectId,
      cyclesEnabled: true,
      pointsEnabled: true,
    });

    const vnDate = (offsetDays: number): string =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(Date.now() + offsetDays * DAY));

    const d0 = vnDate(-3);
    const d1 = vnDate(-2);
    const d2 = vnDate(-1);
    const d3 = vnDate(0);
    const d4 = vnDate(1);
    const vnMorning = (day: string) => new Date(`${day}T02:00:00.000Z`);

    const { cycle: sprint1 } = await exec<ProjectCycleMutateResult>(
      pOwner.userId,
      snapOrg.orgId,
      'projects.cycle.create',
      {
        projectId,
        name: 'Sprint Lịch sử 1',
        startsOn: d0,
        endsOn: d4,
      },
    );
    const { cycle: sprint2 } = await exec<ProjectCycleMutateResult>(
      pOwner.userId,
      snapOrg.orgId,
      'projects.cycle.create',
      {
        projectId,
        name: 'Sprint Lịch sử 2',
      },
    );
    await exec(pOwner.userId, snapOrg.orgId, 'projects.cycle.start', { projectId, cycleId: sprint1.id });

    const { taskId: tDone } = await exec<{ taskId: string }>(pOwner.userId, snapOrg.orgId, 'projects.task.create', {
      projectId,
      title: 'Tác vụ hoàn thành sớm',
      assigneePositionId: null,
      status: 'todo',
      cycleId: sprint1.id,
      storyPoints: 5,
    });
    const { taskId: tReassigned } = await exec<{ taskId: string }>(pOwner.userId, snapOrg.orgId, 'projects.task.create', {
      projectId,
      title: 'Tác vụ chuyển ra giữa kỳ',
      assigneePositionId: null,
      status: 'todo',
      cycleId: sprint1.id,
      storyPoints: 3,
    });
    const { taskId: tRemoved } = await exec<{ taskId: string }>(pOwner.userId, snapOrg.orgId, 'projects.task.create', {
      projectId,
      title: 'Tác vụ gỡ khỏi dự án giữa kỳ',
      assigneePositionId: null,
      status: 'todo',
      cycleId: sprint1.id,
      storyPoints: 2,
    });
    const { taskId: tCarry } = await exec<{ taskId: string }>(pOwner.userId, snapOrg.orgId, 'projects.task.create', {
      projectId,
      title: 'Tác vụ chưa xong carry over',
      assigneePositionId: null,
      status: 'in_progress',
      cycleId: sprint1.id,
      storyPoints: 8,
    });

    // Complete tDone, then verify non-status edits keep done_at unchanged and reopen clears done_at.
    await exec(pMember.userId, snapOrg.orgId, 'kernel.task.set_status', { id: tDone, status: 'done' });
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows: doneRows1 } = await admin.query<{ done_at: Date | null }>(
        'SELECT done_at FROM ludy_kernel.task WHERE org_id = $1 AND id = $2',
        [snapOrg.orgId, tDone],
      );
      expect(doneRows1[0]?.done_at).not.toBeNull();
      const stampedDoneAt = doneRows1[0]?.done_at as Date;

      await exec(pMember.userId, snapOrg.orgId, 'kernel.task.update', {
        id: tDone,
        title: 'Tác vụ hoàn thành sớm (đã sửa tiêu đề)',
        description: 'Mô tả cập nhật sau khi xong',
      });
      const { rows: doneRows2 } = await admin.query<{ done_at: Date | null; updated_at: Date }>(
        'SELECT done_at, updated_at FROM ludy_kernel.task WHERE org_id = $1 AND id = $2',
        [snapOrg.orgId, tDone],
      );
      expect(doneRows2[0]?.done_at?.getTime()).toBe(stampedDoneAt.getTime());
      expect(doneRows2[0]?.updated_at.getTime()).toBeGreaterThanOrEqual(stampedDoneAt.getTime());

      // Reopen clears done_at, re-complete stamps new done_at, then backdate to d1 before editing title on d3.
      await exec(pMember.userId, snapOrg.orgId, 'kernel.task.set_status', { id: tDone, status: 'in_progress' });
      const { rows: reopenedRows } = await admin.query<{ done_at: Date | null }>(
        'SELECT done_at FROM ludy_kernel.task WHERE org_id = $1 AND id = $2',
        [snapOrg.orgId, tDone],
      );
      expect(reopenedRows[0]?.done_at).toBeNull();

      await exec(pMember.userId, snapOrg.orgId, 'kernel.task.set_status', { id: tDone, status: 'done' });
      await admin.query(
        'UPDATE ludy_kernel.task SET created_at = $1, done_at = $2 WHERE org_id = $3 AND id = $4',
        [vnMorning(d0), vnMorning(d1), snapOrg.orgId, tDone],
      );
      // Unrelated edit right now (d3) must keep done_at on d1 and keep burndown on d1!
      await exec(pMember.userId, snapOrg.orgId, 'kernel.task.update', {
        id: tDone,
        title: 'Tác vụ giữ nguyên ngày done d1',
      });
      const { rows: afterEditRows } = await admin.query<{ done_at: Date }>(
        'SELECT done_at FROM ludy_kernel.task WHERE org_id = $1 AND id = $2',
        [snapOrg.orgId, tDone],
      );
      expect(afterEditRows[0]?.done_at.toISOString()).toBe(vnMorning(d1).toISOString());

      // Mid-sprint reassignment (d2) and project removal (d1).
      await exec(pMember.userId, snapOrg.orgId, 'projects.task.set_cycle', {
        projectId,
        taskId: tReassigned,
        cycleId: null,
      });
      await exec(pMember.userId, snapOrg.orgId, 'projects.task.remove', {
        projectId,
        taskId: tRemoved,
      });

      await admin.query(
        'UPDATE ludy_kernel.task SET created_at = $1 WHERE org_id = $2 AND id = ANY($3::uuid[])',
        [vnMorning(d0), snapOrg.orgId, [tReassigned, tRemoved, tCarry]],
      );
      await admin.query(
        'UPDATE ludy_projects.project_cycle_task_history SET joined_at = $1 WHERE org_id = $2 AND cycle_id = $3',
        [vnMorning(d0), snapOrg.orgId, sprint1.id],
      );
      await admin.query(
        `UPDATE ludy_projects.project_cycle_task_history
            SET left_at = $1
          WHERE org_id = $2 AND cycle_id = $3 AND task_id = $4 AND left_reason = 'reassigned'`,
        [vnMorning(d2), snapOrg.orgId, sprint1.id, tReassigned],
      );
      const { rows: removedHistory } = await admin.query<{ left_reason: string | null }>(
        `UPDATE ludy_projects.project_cycle_task_history
            SET left_at = $1
          WHERE org_id = $2 AND cycle_id = $3 AND task_id = $4
          RETURNING left_reason`,
        [vnMorning(d1), snapOrg.orgId, sprint1.id, tRemoved],
      );
      expect(removedHistory[0]?.left_reason).toBe('removed_from_project');

      // Agent cannot forge done_at via raw update under agent context (and cannot complete without run).
      const installed = await rt.execute<{ agentId: string; positionId: string }>(
        'kernel.agent.template.install',
        { templateKey: 'finance.chief_accountant', displayName: 'Done Guard Bot' },
        { actor: asMfa(pOwner.userId), orgId: snapOrg.orgId, idempotencyKey: randomUUID() },
      );
      const { taskId: tBotGuard } = await exec<{ taskId: string }>(pOwner.userId, snapOrg.orgId, 'projects.task.create', {
        projectId,
        title: 'Tác vụ kiểm tra agent guard done_at',
        assigneePositionId: installed.positionId,
      });
      const started = await workerRt.execute<{ runId: string | null }>(
        'kernel.agent.run.start',
        { agentId: installed.agentId },
        { actor: { type: 'system', component: 'test' }, orgId: snapOrg.orgId },
      );
      expect(started.runId).toBeTruthy();
      const agentClient = await workerPool.connect();
      try {
        await agentClient.query('BEGIN');
        await agentClient.query('SELECT ludy_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [
          snapOrg.orgId,
          installed.agentId,
          started.runId,
        ]);
        await expect(
          agentClient.query('UPDATE ludy_kernel.task SET done_at = $1 WHERE org_id = $2 AND id = $3', [
            vnMorning(d0),
            snapOrg.orgId,
            tBotGuard,
          ]),
        ).rejects.toMatchObject({ code: '42501', message: 'AGENT_TASK_FIELD' });
      } finally {
        await agentClient.query('ROLLBACK').catch(() => undefined);
        agentClient.release();
      }
      await workerRt.execute(
        'kernel.agent.run.finish',
        { runId: started.runId as string, outcome: 'succeeded' },
        { actor: { type: 'system', component: 'test' }, orgId: snapOrg.orgId },
      );

      // Complete sprint1 with carryover to sprint2.
      const closed = await exec<ProjectCycleCompleteResult>(pOwner.userId, snapOrg.orgId, 'projects.cycle.complete', {
        projectId,
        cycleId: sprint1.id,
        carryover: { mode: 'cycle', targetCycleId: sprint2.id },
      });
      expect(closed.cycle.totalTasks).toBe(2);
      expect(closed.cycle.doneTasks).toBe(1);
      expect(closed.cycle.openTasks).toBe(1);
      expect(closed.cycle.totalPoints).toBe(13);
      expect(closed.cycle.donePoints).toBe(5);

      const { rows: snapRows } = await admin.query<{
        task_id: string;
        task_status: string;
        story_points: number | null;
        carried_over: boolean;
      }>(
        'SELECT task_id, task_status, story_points, carried_over FROM ludy_projects.project_cycle_snapshot WHERE org_id = $1 AND cycle_id = $2 ORDER BY task_id',
        [snapOrg.orgId, sprint1.id],
      );
      expect(snapRows).toHaveLength(2);
      expect(snapRows.find((r) => r.task_id === tCarry)).toMatchObject({
        task_status: 'in_progress',
        story_points: 8,
        carried_over: true,
      });
      expect(snapRows.find((r) => r.task_id === tDone)).toMatchObject({
        task_status: 'done',
        story_points: 5,
        carried_over: false,
      });

      const { rows: carryHistory } = await admin.query<{ left_reason: string | null }>(
        'SELECT left_reason FROM ludy_projects.project_cycle_task_history WHERE org_id = $1 AND cycle_id = $2 AND task_id = $3',
        [snapOrg.orgId, sprint1.id, tCarry],
      );
      expect(carryHistory[0]?.left_reason).toBe('carryover');

      // Now mutate tCarry points and complete it in sprint2, and reopen tDone + change tDone points on sprint1.
      // Sprint 1 snapshot metrics, velocity, burndown, history points, and cycle_summary_source must stay 100% immutable!
      await exec(pMember.userId, snapOrg.orgId, 'projects.task.set_points', {
        projectId,
        taskId: tCarry,
        storyPoints: 21,
      });
      await exec(pMember.userId, snapOrg.orgId, 'kernel.task.set_status', { id: tCarry, status: 'done' });
      await exec(pMember.userId, snapOrg.orgId, 'kernel.task.set_status', { id: tDone, status: 'in_progress' });
      await exec(pMember.userId, snapOrg.orgId, 'projects.task.set_points', {
        projectId,
        taskId: tDone,
        storyPoints: 34,
      });

      const { rows: tDoneHistAfter } = await admin.query<{ story_points: number | null }>(
        'SELECT story_points FROM ludy_projects.project_cycle_task_history WHERE org_id = $1 AND cycle_id = $2 AND task_id = $3',
        [snapOrg.orgId, sprint1.id, tDone],
      );
      expect(tDoneHistAfter[0]?.story_points).toBe(5);

      const afterMutationsMetrics = await query<ProjectCycleMetrics>(
        pMember.userId,
        snapOrg.orgId,
        'projects.cycle.metrics',
        { projectId, cycleId: sprint1.id },
      );
      expect(afterMutationsMetrics.selectedCycle?.totalTasks).toBe(2);
      expect(afterMutationsMetrics.selectedCycle?.doneTasks).toBe(1);
      expect(afterMutationsMetrics.selectedCycle?.totalPoints).toBe(13);
      expect(afterMutationsMetrics.selectedCycle?.donePoints).toBe(5);
      expect(afterMutationsMetrics.velocity).toEqual([
        expect.objectContaining({
          cycleId: sprint1.id,
          totalTasks: 2,
          completedTasks: 1,
          committedPoints: 13,
          completedPoints: 5,
        }),
      ]);

      // d0: tDone(5) + tCarry(8) + tReassigned(3) + tRemoved(2) = 18 pts, 4 tasks
      // d1: tDone burned down, tRemoved removed = 8 + 3 = 11 pts, 2 tasks
      // d2: tReassigned left = 8 pts, 1 task (tCarry)
      // d3 (closedOn): tCarry carryover stays remaining = 8 pts, 1 task
      // d4 (future after closedOn): null
      expect(afterMutationsMetrics.burndown.map((p) => [p.date, p.remainingTasks, p.remainingPoints])).toEqual([
        [d0, 4, 18],
        [d1, 2, 11],
        [d2, 1, 8],
        [d3, 1, 8],
        [d4, null, null],
      ]);

      const sourceAfterReopen = await query<ProjectCycleSummarySource>(
        pMember.userId,
        snapOrg.orgId,
        'projects.cycle_summary_source',
        { projectId, cycleId: sprint1.id },
      );
      expect(sourceAfterReopen.tasks.find((t) => t.id === tDone)?.status).toBe('done');
      expect(sourceAfterReopen.tasks.find((t) => t.id === tCarry)?.status).toBe('in_progress');

      // Private-project isolation: non-member sees 0 rows directly in both tables and gets PROJECT_NOT_FOUND in queries.
      await expect(
        query<ProjectCycleMetrics>(pNonMember.userId, snapOrg.orgId, 'projects.cycle.metrics', {
          projectId,
          cycleId: sprint1.id,
        }),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

      const tenantClient = await pool.connect();
      try {
        await tenantClient.query('BEGIN');
        await tenantClient.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
          snapOrg.orgId,
          contextToken(pNonMember.userId, snapOrg.orgId),
        ]);
        const { rows: hiddenHist } = await tenantClient.query(
          'SELECT id FROM ludy_projects.project_cycle_task_history WHERE org_id = $1 AND cycle_id = $2',
          [snapOrg.orgId, sprint1.id],
        );
        const { rows: hiddenSnap } = await tenantClient.query(
          'SELECT id FROM ludy_projects.project_cycle_snapshot WHERE org_id = $1 AND cycle_id = $2',
          [snapOrg.orgId, sprint1.id],
        );
        expect(hiddenHist).toHaveLength(0);
        expect(hiddenSnap).toHaveLength(0);
      } finally {
        await tenantClient.query('ROLLBACK').catch(() => undefined);
        tenantClient.release();
      }
    } finally {
      await admin.end();
    }
  });

  it('allows direct project delete cascade under ludy_tenant while preserving task removal history on intact projects (#4678)', async () => {
    const delOwner = await newPerson('del-guard-owner');
    const delMember = await newPerson('del-guard-member');
    const delOrg = await createOrg(rt, asUser(delOwner.userId), 'Delete Guard Org');

    const inv = await rt.execute<{ acceptPath: string }>(
      'kernel.member.invite.create',
      { email: delMember.email, role: 'member' },
      { actor: asMfa(delOwner.userId), orgId: delOrg.orgId, idempotencyKey: randomUUID() },
    );
    await rt.executeOrgless(
      'kernel.member.invite.accept',
      { token: inv.acceptPath.split('#')[1] },
      { actor: asUser(delMember.userId) },
    );

    const { projectId: orgProjectId } = await exec<{ projectId: string }>(
      delOwner.userId,
      delOrg.orgId,
      'projects.project.create',
      { name: 'Dự án kiểm tra xóa trực tiếp' },
    );
    await exec(delOwner.userId, delOrg.orgId, 'projects.project.update', {
      projectId: orgProjectId,
      cyclesEnabled: true,
      pointsEnabled: true,
    });
    const { cycle: orgCycle } = await exec<ProjectCycleMutateResult>(
      delOwner.userId,
      delOrg.orgId,
      'projects.cycle.create',
      { projectId: orgProjectId, name: 'Cycle xóa dự án' },
    );
    await exec(delOwner.userId, delOrg.orgId, 'projects.cycle.start', {
      projectId: orgProjectId,
      cycleId: orgCycle.id,
    });

    const { taskId: tRemove } = await exec<{ taskId: string }>(delOwner.userId, delOrg.orgId, 'projects.task.create', {
      projectId: orgProjectId,
      title: 'Việc bị gỡ khỏi dự án còn nguyên',
      assigneePositionId: null,
      cycleId: orgCycle.id,
      storyPoints: 3,
    });
    const { taskId: tCascade } = await exec<{ taskId: string }>(delOwner.userId, delOrg.orgId, 'projects.task.create', {
      projectId: orgProjectId,
      title: 'Việc còn trong chu kỳ khi xóa dự án',
      assigneePositionId: null,
      cycleId: orgCycle.id,
      storyPoints: 5,
    });

    // Removing a task while the parent project remains intact must still close the open history row.
    await exec(delOwner.userId, delOrg.orgId, 'projects.task.remove', {
      projectId: orgProjectId,
      taskId: tRemove,
    });

    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows: removedRows } = await admin.query<{
        left_at: Date | null;
        left_reason: string | null;
      }>(
        `SELECT left_at, left_reason
           FROM ludy_projects.project_cycle_task_history
          WHERE org_id = $1 AND project_id = $2 AND cycle_id = $3 AND task_id = $4`,
        [delOrg.orgId, orgProjectId, orgCycle.id, tRemove],
      );
      expect(removedRows).toHaveLength(1);
      expect(removedRows[0]?.left_reason).toBe('removed_from_project');
      expect(removedRows[0]?.left_at).not.toBeNull();

      const { rows: openRows } = await admin.query<{ left_at: Date | null }>(
        `SELECT left_at
           FROM ludy_projects.project_cycle_task_history
          WHERE org_id = $1 AND project_id = $2 AND cycle_id = $3 AND task_id = $4`,
        [delOrg.orgId, orgProjectId, orgCycle.id, tCascade],
      );
      expect(openRows).toHaveLength(1);
      expect(openRows[0]?.left_at).toBeNull();

      // Also verify direct delete of a private project as an org owner (private-bypass actor, non-member).
      const { projectId: privateProjectId } = await exec<{ projectId: string }>(
        delMember.userId,
        delOrg.orgId,
        'projects.project.create',
        { name: 'Dự án riêng tư của thành viên', visibility: 'private' },
      );
      await exec(delMember.userId, delOrg.orgId, 'projects.project.update', {
        projectId: privateProjectId,
        cyclesEnabled: true,
        pointsEnabled: true,
      });
      const { cycle: privateCycle } = await exec<ProjectCycleMutateResult>(
        delMember.userId,
        delOrg.orgId,
        'projects.cycle.create',
        { projectId: privateProjectId, name: 'Cycle riêng tư' },
      );
      await exec(delMember.userId, delOrg.orgId, 'projects.cycle.start', {
        projectId: privateProjectId,
        cycleId: privateCycle.id,
      });
      await exec(delMember.userId, delOrg.orgId, 'projects.task.create', {
        projectId: privateProjectId,
        title: 'Việc trong dự án riêng tư',
        assigneePositionId: null,
        cycleId: privateCycle.id,
        storyPoints: 8,
      });

      const tenantClient = await pool.connect();
      try {
        for (const targetProjectId of [orgProjectId, privateProjectId]) {
          await tenantClient.query('BEGIN');
          await tenantClient.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [
            delOrg.orgId,
            contextToken(delOwner.userId, delOrg.orgId),
          ]);
          const delRes = await tenantClient.query(
            'DELETE FROM ludy_projects.project WHERE org_id = $1 AND id = $2',
            [delOrg.orgId, targetProjectId],
          );
          expect(delRes.rowCount).toBe(1);
          await tenantClient.query('COMMIT');
        }
      } catch (err) {
        await tenantClient.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        tenantClient.release();
      }

      const { rows: remaining } = await admin.query<{
        projects: string;
        project_tasks: string;
        histories: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM ludy_projects.project WHERE org_id = $1 AND id = ANY($2::uuid[])) AS projects,
           (SELECT count(*)::text FROM ludy_projects.project_task WHERE org_id = $1 AND project_id = ANY($2::uuid[])) AS project_tasks,
           (SELECT count(*)::text FROM ludy_projects.project_cycle_task_history WHERE org_id = $1 AND project_id = ANY($2::uuid[])) AS histories`,
        [delOrg.orgId, [orgProjectId, privateProjectId]],
      );
      expect(remaining[0]).toEqual({ projects: '0', project_tasks: '0', histories: '0' });
    } finally {
      await admin.end();
    }
  });

  it('distinguishes cycle close carryover from post-close set_cycle reassignment and guards project DELETE (#4689, #4678)', async () => {
    const pOwner = await newPerson('postclose-owner');
    const org = await createOrg(rt, asUser(pOwner.userId), 'Post-Close History Org');

    const { projectId } = await exec<{ projectId: string }>(pOwner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án kiểm tra post-close left_reason',
      visibility: 'org',
    });
    await exec(pOwner.userId, org.orgId, 'projects.project.update', {
      projectId,
      cyclesEnabled: true,
      pointsEnabled: true,
    });

    const { cycle: cycle1 } = await exec<ProjectCycleMutateResult>(pOwner.userId, org.orgId, 'projects.cycle.create', {
      projectId,
      name: 'Chu kỳ 1',
    });
    const { cycle: cycle2 } = await exec<ProjectCycleMutateResult>(pOwner.userId, org.orgId, 'projects.cycle.create', {
      projectId,
      name: 'Chu kỳ 2',
    });
    await exec(pOwner.userId, org.orgId, 'projects.cycle.start', { projectId, cycleId: cycle1.id });

    const { taskId: openTaskId } = await exec<{ taskId: string }>(pOwner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Việc mở carry over',
      assigneePositionId: null,
      status: 'in_progress',
      cycleId: cycle1.id,
      storyPoints: 5,
    });
    const { taskId: doneTaskId } = await exec<{ taskId: string }>(pOwner.userId, org.orgId, 'projects.task.create', {
      projectId,
      title: 'Việc đã xong chuyển sau khi đóng',
      assigneePositionId: null,
      status: 'done',
      cycleId: cycle1.id,
      storyPoints: 3,
    });

    const closed = await exec<ProjectCycleCompleteResult>(pOwner.userId, org.orgId, 'projects.cycle.complete', {
      projectId,
      cycleId: cycle1.id,
      carryover: { mode: 'cycle', targetCycleId: cycle2.id },
    });
    expect(closed.carriedOverCount).toBe(1);

    // Move doneTaskId out of completed cycle1 via projects.task.set_cycle AFTER cycle1 is closed:
    // left_reason must be 'reassigned' (not 'carryover'), while openTaskId stays 'carryover'.
    await exec(pOwner.userId, org.orgId, 'projects.task.set_cycle', {
      projectId,
      taskId: doneTaskId,
      cycleId: cycle2.id,
    });

    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      const { rows: histRows } = await admin.query<{ task_id: string; left_reason: string | null }>(
        `SELECT task_id, left_reason
           FROM ludy_projects.project_cycle_task_history
          WHERE org_id = $1 AND project_id = $2 AND cycle_id = $3
          ORDER BY task_id`,
        [org.orgId, projectId, cycle1.id],
      );
      expect(histRows.find((r) => r.task_id === openTaskId)?.left_reason).toBe('carryover');
      expect(histRows.find((r) => r.task_id === doneTaskId)?.left_reason).toBe('reassigned');

      // Moving doneTaskId again into backlog from cycle2 (active/upcoming) also records 'reassigned'.
      await exec(pOwner.userId, org.orgId, 'projects.task.set_cycle', {
        projectId,
        taskId: doneTaskId,
        cycleId: null,
      });
      const { rows: cycle2Hist } = await admin.query<{ left_reason: string | null }>(
        `SELECT left_reason
           FROM ludy_projects.project_cycle_task_history
          WHERE org_id = $1 AND project_id = $2 AND cycle_id = $3 AND task_id = $4`,
        [org.orgId, projectId, cycle2.id, doneTaskId],
      );
      expect(cycle2Hist[0]?.left_reason).toBe('reassigned');
    } finally {
      await admin.end();
    }

    // #4678 DELETE guard: deleting a project under system + ludy_tenant cascades project_task cleanly.
    const delProj = await exec<{ projectId: string }>(pOwner.userId, org.orgId, 'projects.project.create', {
      name: 'Dự án kiểm tra DELETE cascade',
      visibility: 'private',
    });
    await exec(pOwner.userId, org.orgId, 'projects.project.update', {
      projectId: delProj.projectId,
      cyclesEnabled: true,
    });
    const { cycle: delCycle } = await exec<ProjectCycleMutateResult>(pOwner.userId, org.orgId, 'projects.cycle.create', {
      projectId: delProj.projectId,
      name: 'Cycle xóa',
    });
    await exec(pOwner.userId, org.orgId, 'projects.task.create', {
      projectId: delProj.projectId,
      title: 'Việc trong dự án bị xóa',
      assigneePositionId: null,
      cycleId: delCycle.id,
    });

    const sysClient = await workerPool.connect();
    try {
      await sysClient.query('BEGIN');
      await sysClient.query('SELECT ludy_kernel.enter_system_context($1::uuid)', [org.orgId]);
      await sysClient.query('SET LOCAL ROLE ludy_tenant');
      const deleted = await sysClient.query<{ id: string }>(
        'DELETE FROM ludy_projects.project WHERE org_id = $1 AND id = $2 RETURNING id',
        [org.orgId, delProj.projectId],
      );
      expect(deleted.rows.map((r) => r.id)).toEqual([delProj.projectId]);
      await sysClient.query('COMMIT');
    } catch (err) {
      await sysClient.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      sysClient.release();
    }
  });
});

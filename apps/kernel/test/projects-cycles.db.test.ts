// SPDX-License-Identifier: AGPL-3.0-only
// PostgreSQL integration tests for Projects v2 Sprints / Cycles, Story points, Burndown/Velocity,
// carryover atomicity, RBAC, agent refusal, PDPL erasure, offboarding export coverage, org_purge, and Vy Cycle Summary (#4361).
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
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
import { projectsCommands, projectsQueries } from '@ludy/mod-projects';
import { memberMeter } from '../src/ai-meter.ts';
import { createAuthenticator } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import { createHttpApp } from '../src/http.ts';
import { orgPurgeCommand, purgeOrg } from '../src/org-purge.ts';
import { createSessionStatusSource } from '../src/sessions.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
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
    dbName = `crove_test_cycles_${Date.now()}_${randomBytes(3).toString('hex')}`;
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });

    const appUrl = new URL(adminUrl);
    appUrl.username = 'crove_app';
    appUrl.password = 'test-app-pw';
    const wUrl = new URL(adminUrl);
    wUrl.username = 'crove_worker';
    wUrl.password = 'test-worker-pw';
    workerUrl = wUrl.toString();

    pool = createPool({ connectionString: appUrl.toString(), max: 6 });
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    db = createDb(pool);
    dir = await mkdtemp(join(tmpdir(), 'crove-proj-cycles-'));
    const store = new LocalDiskStore(dir);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS, sessions: createSessionStatusSource('off'), stepUp: 'required' }).register({
      commands: [...kernelCommands, ...projectsCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...projectsQueries],
    });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...projectsCommands, orgPurgeCommand({ store })],
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
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES
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
      await workerClient.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agentActor.agentId, agentActor.runId]);
      await expect(
        workerClient.query(
          `INSERT INTO crove_projects.project_cycle (org_id, project_id, number, name, starts_on, ends_on, created_by)
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

    const doneRes = await exec<ProjectCycleCompleteResult>(owner.userId, orgId, 'projects.cycle.complete', {
      projectId,
      cycleId: s1.id,
      carryover: { mode: 'cycle', targetCycleId: s2.id },
    });
    expect(doneRes.cycle.status).toBe('completed');
    expect(doneRes.carriedOverCount).toBe(1);
    expect(doneRes.targetCycleId).toBe(s2.id);

    await expect(
      exec(owner.userId, orgId, 'projects.task.set_cycle', { projectId, taskId: tOpen, cycleId: s1.id }),
    ).rejects.toMatchObject({ code: 'CYCLE_COMPLETED' });

    const postMetrics = await query<ProjectCycleMetrics>(owner.userId, orgId, 'projects.cycle.metrics', { projectId });
    expect(postMetrics.velocity).toHaveLength(1);
    expect(postMetrics.velocity[0]?.completedTasks).toBe(1);
    expect(postMetrics.velocity[0]?.completedPoints).toBe(5);

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
    expect(EXPORT_TABLE_NAMES).toContain('projects.project_cycle');
    const found = await rt.execute<PersonalDataResult>(
      'kernel.personal_data.find',
      { value: piiEmail },
      { actor: asUser(owner.userId), orgId, idempotencyKey: randomUUID() },
    );
    expect(found.matches.map((m) => m.column)).toEqual(
      expect.arrayContaining(['crove_projects.project_cycle.name', 'crove_projects.project_cycle.goal']),
    );
    const erased = await rt.execute<PersonalDataErasure>(
      'kernel.personal_data.erase',
      { value: piiEmail },
      { actor: asMfa(owner.userId), orgId, idempotencyKey: randomUUID() },
    );
    expect(erased.erased.some((r) => r.column === 'crove_projects.project_cycle.name' && r.rows === 1)).toBe(true);
    expect(erased.erased.some((r) => r.column === 'crove_projects.project_cycle.goal' && r.rows === 1)).toBe(true);

    // Vy cycle summary never reads crove_notes and degrades gracefully when AI is off.
    const adminClient = new pg.Client({ connectionString: adminUrl });
    await adminClient.connect();
    try {
      await adminClient.query(
        `INSERT INTO crove_notes.note (org_id, author_user_id, visibility, title, body)
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

    // Offboard and backdate audit events so crove_kernel.org_purge deletes crove_projects.project_cycle rows cleanly.
    await rt.execute('kernel.org.offboard', { confirmSlug: orgSlug }, { actor: asMfa(owner.userId), orgId });
    const purgeAdmin = new pg.Client({ connectionString: adminUrl });
    await purgeAdmin.connect();
    try {
      await purgeAdmin.query('BEGIN');
      await purgeAdmin.query('SET LOCAL session_replication_role = replica');
      await purgeAdmin.query(
        `UPDATE crove_kernel.audit_event
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
      const { rows } = await verifyAdmin.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM crove_projects.project_cycle WHERE org_id = $1',
        [orgId],
      );
      expect(rows[0]?.n).toBe('0');
    } finally {
      await verifyAdmin.end();
    }
  });
});

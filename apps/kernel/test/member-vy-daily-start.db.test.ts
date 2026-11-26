// SPDX-License-Identifier: AGPL-3.0-only
// System-started daily runs for member-scoped Vy (#5073, ADR-0049 decisions 1 and 6):
//   kernel.member_vy.run.start_daily  worker-only R1 command starting meetings.brief_daily without superseding
//                                     an active run (VY_RUN_BUSY) and without touching click-only features.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, memberVyRuntime } from '@ludy/kernel-runtime';
import { meetingsCommands, meetingsQueries } from '@ludy/mod-meetings';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'meetings.brief_daily' };

suite('kernel.member_vy.run.start_daily (#5073)', () => {
  const dbName = `ludy_test_vy_daily_start_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let app: Runtime;
  let worker: Runtime;
  let kernelOnlyWorker: Runtime;
  const users = { owner: '', alice: '', bob: '', viewer: '', outsider: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({
    type: 'user' as const,
    userId,
    aal: 'aal2' as const,
    sessionId: randomUUID(),
    mfaAt: Math.floor(Date.now() / 1000),
  });
  const startDaily = (userId: string, feature = 'meetings.brief_daily', subjectId?: string) =>
    worker.execute<{ agentId: string; runId: string; resultId: string; expiresAt: string }>(
      'kernel.member_vy.run.start_daily',
      subjectId ? { userId, feature, subjectId } : { userId, feature },
      { actor: SYSTEM, orgId },
    );
  const sqlAdmin = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(text, values)).rows;
    } finally {
      await c.end();
    }
  };
  const refuses = (p: Promise<unknown>) => p.then(() => null, (err: { code?: string }) => err.code ?? 'ERR');

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appPool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    const workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 4 });
    pools.push(appPool, workerPool);
    const appDb = createDb(appPool);
    const workerDb = createDb(workerPool);
    app = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...meetingsQueries],
    });
    worker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...meetingsCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...meetingsQueries],
    });
    kernelOnlyWorker = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' })],
    });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(appDb, {
        issuer: 'vy-daily-start',
        subject: key,
        email: `${key}@vy-daily-start.test`,
        name: null,
      });
    }
    orgId = (await createOrg(app, asUser(users.owner), 'Daily brief org')).orgId;
    await sqlAdmin(
      `INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role)
       VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'viewer')`,
      [orgId, users.alice, users.bob, users.viewer],
    );
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('rejects non-system callers, click-only features, unready modules, inactive tenants, and ineligible members', async () => {
    expect(
      await refuses(
        app.execute(
          'kernel.member_vy.run.start_daily',
          { userId: users.alice, feature: 'meetings.brief_daily' },
          { actor: asUser(users.owner), orgId },
        ),
      ),
    ).toBe('FORBIDDEN');

    for (const clickFeature of ['meetings.brief', 'notes.summary', 'meetings.transcribe']) {
      expect(await refuses(startDaily(users.alice, clickFeature)), clickFeature).toBe('VALIDATION');
    }

    expect(
      await refuses(
        app.execute(
          'kernel.member_vy.run.start',
          { feature: 'meetings.brief_daily', subjectType: 'meeting', subjectId: randomUUID() },
          { actor: asUser(users.alice), orgId },
        ),
      ),
      'user click start rejects system-startable feature',
    ).toBe('VALIDATION');

    expect(
      await refuses(
        kernelOnlyWorker.execute(
          'kernel.member_vy.run.start_daily',
          { userId: users.alice, feature: 'meetings.brief_daily' },
          { actor: SYSTEM, orgId },
        ),
      ),
      'module not installed in deployment',
    ).toBe('MODULE_OFF');

    await app.execute('kernel.org.set_app', { module: 'meetings', enabled: false }, { actor: asUser(users.owner), orgId });
    try {
      expect(await refuses(startDaily(users.alice)), 'meetings app disabled for org').toBe('MODULE_OFF');
    } finally {
      await app.execute('kernel.org.set_app', { module: 'meetings', enabled: true }, { actor: asUser(users.owner), orgId });
    }

    const offboarded = await createOrg(app, asUser(users.owner), 'Daily brief offboarded');
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [
      offboarded.orgId,
      users.alice,
    ]);
    await app.execute(
      'kernel.org.offboard',
      { confirmSlug: offboarded.slug },
      { actor: asMfa(users.owner), orgId: offboarded.orgId },
    );
    expect(
      await refuses(
        worker.execute(
          'kernel.member_vy.run.start_daily',
          { userId: users.alice, feature: 'meetings.brief_daily' },
          { actor: SYSTEM, orgId: offboarded.orgId },
        ),
      ),
      'inactive tenant',
    ).toBe('TENANT_NOT_ACTIVE');

    expect(await refuses(startDaily(users.outsider)), 'non-member').toBe('VY_NOT_ALLOWED');
    expect(await refuses(startDaily(users.viewer)), 'viewer without vy.use').toBe('VY_NOT_ALLOWED');

    await app.execute(
      'kernel.member.permission.set',
      { userId: users.alice, permission: 'vy.use', allowed: false },
      { actor: asUser(users.owner), orgId },
    );
    try {
      expect(await refuses(startDaily(users.alice)), 'member with vy.use denied').toBe('VY_NOT_ALLOWED');
    } finally {
      await app.execute(
        'kernel.member.permission.set',
        { userId: users.alice, permission: 'vy.use', allowed: null },
        { actor: asUser(users.owner), orgId },
      );
    }

    await sqlAdmin(`UPDATE ludy_kernel.user_account SET disabled_at = now() WHERE id = $1`, [users.alice]);
    try {
      expect(await refuses(startDaily(users.alice)), 'disabled user account').toBe('VY_NOT_ALLOWED');
    } finally {
      await sqlAdmin(`UPDATE ludy_kernel.user_account SET disabled_at = NULL WHERE id = $1`, [users.alice]);
    }

    const orgSwitch = await app.execute<{ killSwitchId: string }>(
      'kernel.agent.kill_switch.engage',
      { scope: 'org', target: '*' },
      { actor: asUser(users.owner), orgId },
    );
    try {
      expect(await refuses(startDaily(users.alice)), 'org kill switch').toBe('AI_BUDGET_EXHAUSTED');
    } finally {
      await app.execute('kernel.agent.kill_switch.release', { id: orgSwitch.killSwitchId }, { actor: asMfa(users.owner), orgId });
    }

    const modSwitch = await app.execute<{ killSwitchId: string }>(
      'kernel.agent.kill_switch.engage',
      { scope: 'module', target: 'meetings' },
      { actor: asUser(users.owner), orgId },
    );
    try {
      expect(await refuses(startDaily(users.alice)), 'meetings module kill switch').toBe('AI_BUDGET_EXHAUSTED');
    } finally {
      await app.execute('kernel.agent.kill_switch.release', { id: modSwitch.killSwitchId }, { actor: asMfa(users.owner), orgId });
    }

    await sqlAdmin(`SELECT ludy_kernel.global_kill_switch_set('ai', true, 'test', 'test')`);
    try {
      expect(await refuses(startDaily(users.alice)), 'global ai kill switch').toBe('AI_BUDGET_EXHAUSTED');
    } finally {
      await sqlAdmin(`SELECT ludy_kernel.global_kill_switch_set('ai', false, 'test', 'test')`);
    }

    await sqlAdmin(
      `INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by)
       VALUES ($1, 'org', '*', 0, 80, true, $2)`,
      [orgId, users.owner],
    );
    try {
      expect(await refuses(startDaily(users.alice)), 'spent hard-stop org budget').toBe('AI_BUDGET_EXHAUSTED');
    } finally {
      await sqlAdmin(`DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1`, [orgId]);
    }
  });

  it('starts a single live daily run without cancelling active click runs, skips via VY_RUN_BUSY, and completes cleanly', async () => {
    const clickRun = await app.execute<{ runId: string }>(
      'kernel.member_vy.run.start',
      { feature: 'meetings.brief', subjectType: 'meeting', subjectId: randomUUID() },
      { actor: asUser(users.alice), orgId },
    );

    const subjectId = randomUUID();
    const daily = await startDaily(users.alice, 'meetings.brief_daily', subjectId);
    expect(daily.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(daily.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(daily.resultId).toMatch(/^[0-9a-f-]{36}$/);

    // Second start on active daily run refuses with VY_RUN_BUSY and leaves both the daily run and the click brief running.
    expect(await refuses(startDaily(users.alice))).toBe('VY_RUN_BUSY');
    const runs = await sqlAdmin<{ id: string; feature: string; module: string; status: string }>(
      `SELECT id, feature, module, status FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY feature`,
      [orgId, [clickRun.runId, daily.runId]],
    );
    expect(runs).toEqual([
      { id: clickRun.runId, feature: 'meetings.brief', module: 'meetings', status: 'running' },
      { id: daily.runId, feature: 'meetings.brief_daily', module: 'meetings', status: 'running' },
    ]);

    // Member reads their own running result row; owner does not see it.
    expect(await app.query('kernel.member_vy.result.get', { runId: daily.runId }, { actor: asUser(users.alice), orgId })).toMatchObject({
      status: 'running',
      body: null,
      privateRead: true,
      tainted: true,
    });
    expect(await refuses(app.query('kernel.member_vy.result.get', { runId: daily.runId }, { actor: asUser(users.owner), orgId }))).toBe(
      'RESULT_NOT_FOUND',
    );

    // Worker enters member_vy context directly with returned daily.agentId, enforces counts-only bodies, and finishes the run.
    await expect(
      memberVyRuntime(worker, orgId, { agentId: daily.agentId, runId: daily.runId }).execute('kernel.member_vy.result.store', {
        runId: daily.runId,
        outcome: { status: 'ready', body: 'Hop luc 9h voi khach A.' },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(
      memberVyRuntime(worker, orgId, { agentId: daily.agentId, runId: daily.runId }).execute('kernel.member_vy.result.store', {
        runId: daily.runId,
        outcome: { status: 'ready', body: JSON.stringify({ acme_secret_meeting: 1 }) },
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await memberVyRuntime(worker, orgId, { agentId: daily.agentId, runId: daily.runId }).execute('kernel.member_vy.result.store', {
      runId: daily.runId,
      outcome: { status: 'ready', body: JSON.stringify({ meetings: 2, lines: 4 }) },
    });
    const closed = await worker.execute<{ closed: boolean }>(
      'kernel.member_vy.run.finish',
      { runId: daily.runId, errorCode: null },
      { actor: SYSTEM, orgId },
    );
    expect(closed).toEqual({ closed: true });
    expect(
      (await sqlAdmin<{ status: string }>(`SELECT status FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2`, [orgId, daily.runId]))[0]?.status,
    ).toBe('succeeded');

    // Failing an un-stored running daily run via member_vy.run.finish (UPDATE in system context) succeeds cleanly.
    const failedRun = await startDaily(users.alice);
    const failedClosed = await worker.execute<{ closed: boolean }>(
      'kernel.member_vy.run.finish',
      { runId: failedRun.runId, errorCode: 'AI_STOPPED' },
      { actor: SYSTEM, orgId },
    );
    expect(failedClosed).toEqual({ closed: true });
    expect(
      (await sqlAdmin<{ status: string }>(`SELECT status FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND id = $2`, [orgId, failedRun.resultId]))[0]?.status,
    ).toBe('failed');

    // Also verify finishing an un-stored click run (meetings.summary) as failed in system context still succeeds.
    const clickFail = await app.execute<{ runId: string; resultId: string }>(
      'kernel.member_vy.run.start',
      { feature: 'meetings.summary', subjectType: 'meeting', subjectId: randomUUID() },
      { actor: asUser(users.alice), orgId },
    );
    const clickClosed = await worker.execute<{ closed: boolean }>(
      'kernel.member_vy.run.finish',
      { runId: clickFail.runId, errorCode: 'AI_STOPPED' },
      { actor: SYSTEM, orgId },
    );
    expect(clickClosed).toEqual({ closed: true });
    expect(
      (await sqlAdmin<{ status: string }>(`SELECT status FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND id = $2`, [orgId, clickFail.resultId]))[0]?.status,
    ).toBe('failed');

    const expireRun = async (runId: string, reopen = false) => {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(
          `UPDATE ludy_kernel.ai_run
           SET started_at = now() - interval '2 hours',
               expires_at = now() - interval '1 hour'${reopen ? `, status = 'running', finished_at = NULL, error = NULL` : ''}
           WHERE org_id = $1 AND id = $2`,
          [orgId, runId],
        );
        await c.query('COMMIT');
      } catch (err) {
        await c.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        await c.end();
      }
    };

    // An expired running daily run left behind by a crashed worker is closed automatically so the next day's run is not stuck on VY_RUN_BUSY.
    const staleRun = await startDaily(users.alice);
    await expireRun(staleRun.runId);
    const recoveredRun = await startDaily(users.alice);
    expect(recoveredRun.runId).not.toBe(staleRun.runId);
    expect(
      (await sqlAdmin<{ status: string; error: string | null }>(`SELECT status, error FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2`, [orgId, staleRun.runId]))[0],
    ).toEqual({ status: 'failed', error: 'AGENT_RUN_NOT_LIVE' });
    expect(
      (await sqlAdmin<{ status: string; error_code: string | null }>(`SELECT status, error_code FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND id = $2`, [orgId, staleRun.resultId]))[0],
    ).toEqual({ status: 'failed', error_code: 'AGENT_RUN_NOT_LIVE' });
    await worker.execute('kernel.member_vy.run.finish', { runId: recoveredRun.runId, errorCode: 'AI_STOPPED' }, { actor: SYSTEM, orgId });

    // An expired daily run whose result was already stored failed keeps its original result error_code while closing ai_run as failed.
    const staleFailed = await startDaily(users.alice);
    await memberVyRuntime(worker, orgId, { agentId: staleFailed.agentId, runId: staleFailed.runId }).execute('kernel.member_vy.result.store', {
      runId: staleFailed.runId,
      outcome: { status: 'failed', errorCode: 'BRIEF_TIMEOUT' },
    });
    await expireRun(staleFailed.runId, true);
    const afterFailed = await startDaily(users.alice);
    expect(
      (await sqlAdmin<{ status: string; error: string | null }>(`SELECT status, error FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2`, [orgId, staleFailed.runId]))[0],
    ).toEqual({ status: 'failed', error: 'AGENT_RUN_NOT_LIVE' });
    expect(
      (await sqlAdmin<{ status: string; error_code: string | null }>(`SELECT status, error_code FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND id = $2`, [orgId, staleFailed.resultId]))[0],
    ).toEqual({ status: 'failed', error_code: 'BRIEF_TIMEOUT' });
    await worker.execute('kernel.member_vy.run.finish', { runId: afterFailed.runId, errorCode: 'AI_STOPPED' }, { actor: SYSTEM, orgId });

    // An expired daily run whose ready result was already stored closes as succeeded (#3058) without losing the stored counts.
    const staleReady = await startDaily(users.alice);
    await memberVyRuntime(worker, orgId, { agentId: staleReady.agentId, runId: staleReady.runId }).execute('kernel.member_vy.result.store', {
      runId: staleReady.runId,
      outcome: { status: 'ready', body: JSON.stringify({ meetings: 1, lines: 2 }) },
    });
    // Re-open the ai_run row as running+expired (simulating worker crash right after result.store, before run.finish).
    await expireRun(staleReady.runId, true);
    const nextAfterReady = await startDaily(users.alice);
    expect(nextAfterReady.runId).not.toBe(staleReady.runId);
    expect(
      (await sqlAdmin<{ status: string }>(`SELECT status FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2`, [orgId, staleReady.runId]))[0]?.status,
    ).toBe('succeeded');
    await worker.execute('kernel.member_vy.run.finish', { runId: nextAfterReady.runId, errorCode: 'AI_STOPPED' }, { actor: SYSTEM, orgId });

    // Agent-level kill switch refuses daily start for that member without touching other members.
    const agentSwitch = await app.execute<{ killSwitchId: string }>(
      'kernel.agent.kill_switch.engage',
      { scope: 'agent', target: daily.agentId },
      { actor: asUser(users.owner), orgId },
    );
    try {
      expect(await refuses(startDaily(users.alice)), 'agent kill switch').toBe('AI_BUDGET_EXHAUSTED');
    } finally {
      await app.execute('kernel.agent.kill_switch.release', { id: agentSwitch.killSwitchId }, { actor: asMfa(users.owner), orgId });
    }

    // Paused member_vy agent is rejected for future daily starts.
    await sqlAdmin(`UPDATE ludy_kernel.agent SET status = 'paused' WHERE org_id = $1 AND id = $2`, [orgId, daily.agentId]);
    try {
      expect(await refuses(startDaily(users.alice)), 'paused member_vy agent').toBe('VY_NOT_ALLOWED');
    } finally {
      await sqlAdmin(`UPDATE ludy_kernel.agent SET status = 'active' WHERE org_id = $1 AND id = $2`, [orgId, daily.agentId]);
    }
  });

  it('creates one member_vy agent cleanly when click start and system daily start race for a new member', async () => {
    const [clickRes, dailyRes] = await Promise.all([
      app.execute<{ runId: string }>(
        'kernel.member_vy.run.start',
        { feature: 'meetings.brief', subjectType: 'meeting', subjectId: randomUUID() },
        { actor: asUser(users.bob), orgId },
      ),
      startDaily(users.bob),
    ]);
    expect(clickRes.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(dailyRes.runId).toMatch(/^[0-9a-f-]{36}$/);
    const agents = await sqlAdmin<{ id: string }>(
      `SELECT id FROM ludy_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`,
      [orgId, users.bob],
    );
    expect(agents).toHaveLength(1);
  });
});

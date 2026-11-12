// SPDX-License-Identifier: AGPL-3.0-only
// A run whose result is already stored `ready` is closed as succeeded, never cancelled or superseded (#3058, ADR-0049). A background run's text is stored in one transaction and the
// worker's run.finish closes the run in another, so in between the run reads `running` beside a `ready` result. A new start of the same feature, a kill switch, a removal and a loss
// of vy.use (member_vy_runs_cancel) used to cancel it all the same, leaving a cancelled run beside a ready result; now they close it as succeeded (with the result's private_read carried
// over, as the finish does), cancel every other run as before, and a run that never gets its finish (a dead worker) no longer blocks its feature. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('a run beside a ready result is closed as succeeded (#3058)', () => {
  const dbName = `crove_test_vy_ready_gap_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  let worker: Runtime;
  const users = { owner: '', alice: '', bob: '', carol: '', dave: '', erin: '', frank: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const exec = <T>(who: string, name: string, input: unknown) => runtime.execute<T>(name, input, { actor: asUser(who), orgId });
  const start = (who: string, feature: string) =>
    exec<{ runId: string; resultId: string }>(who, 'kernel.member_vy.run.start', { feature, subjectType: feature.startsWith('meetings.') ? 'meeting' : 'note', subjectId: randomUUID() });
  const finish = (runId: string) => worker.execute<{ closed: boolean }>('kernel.member_vy.run.finish', { runId, errorCode: null }, { actor: { type: 'system', component: 'test.ready-gap' }, orgId });
  const sqlAdmin = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(text, values)).rows;
    } finally {
      await c.end();
    }
  };
  const run = async (runId: string) => (await sqlAdmin<{ status: string; error: string | null; private_read: boolean }>('SELECT status, error, private_read FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2', [orgId, runId]))[0];
  const result = async (runId: string) => (await sqlAdmin<{ status: string; error_code: string | null }>('SELECT status, error_code FROM crove_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2', [orgId, runId]))[0];
  // The gap of a background run: its text is stored (ready) and the worker has not closed the run yet.
  const storedNotClosed = (runId: string, privateRead = true) =>
    sqlAdmin(`UPDATE crove_kernel.member_vy_result SET status = 'ready', body = 'x', private_read = $3 WHERE org_id = $1 AND run_id = $2`, [orgId, runId, privateRead]);

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
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    const appPool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 6 });
    const workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 3 });
    pools.push(appPool, workerPool);
    const build = (db: ReturnType<typeof createDb>) => new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    runtime = build(createDb(appPool));
    worker = build(createDb(workerPool));
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(createDb(appPool), { issuer: 'vy-ready-gap', subject: key, email: `${key}@vy-ready-gap.test`, name: null });
    }
    orgId = (await createOrg(runtime, asUser(users.owner), 'Vy ready gap')).orgId;
    await sqlAdmin(
      `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member'), ($1, $7, 'member')`,
      [orgId, users.alice, users.bob, users.carol, users.dave, users.erin, users.frank],
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

  it('a new start of the same feature closes a run whose text is stored as succeeded, carries private_read over, and is not blocked when the worker never closes it', async () => {
    const first = await start(users.alice, 'meetings.transcribe');
    await storedNotClosed(first.runId, true);
    expect(await run(first.runId)).toMatchObject({ status: 'running', private_read: false });
    // No finish ever comes (a dead worker): the next start of the feature still goes through, and the old run is recorded as it should be.
    const second = await start(users.alice, 'meetings.transcribe');
    expect(await run(first.runId)).toEqual({ status: 'succeeded', error: null, private_read: true });
    expect(await result(first.runId)).toEqual({ status: 'ready', error_code: null });
    expect(await run(second.runId)).toMatchObject({ status: 'running', error: null });
    // The finish that arrives after finds nothing to close.
    expect(await finish(first.runId)).toEqual({ closed: false });
    expect(await run(first.runId)).toMatchObject({ status: 'succeeded' });
  });

  it('writes nothing else when it closes a stored run: the usage was counted at call time and is neither added nor removed, and no run row is left open', async () => {
    const usage = async (who: string) => Number((await sqlAdmin<{ n: string; total: string }>(`SELECT count(*)::text AS n, COALESCE(sum(amount), 0)::text AS total FROM crove_kernel.org_usage u JOIN crove_kernel.agent a ON a.org_id = u.org_id AND a.id = u.agent_id WHERE u.org_id = $1 AND a.member_user_id = $2`, [orgId, who]))[0]?.n);
    const stored = await start(users.alice, 'meetings.transcribe');
    // The meter records each model call when it is made (kernel.member_vy.meter.record), long before the run is closed.
    await exec(users.alice, 'kernel.member_vy.meter.record', { feature: 'meetings.transcribe', inputTokens: 0, outputTokens: 0, cost: '0.250000' });
    await storedNotClosed(stored.runId);
    const before = await usage(users.alice);
    expect(before).toBeGreaterThan(0);
    await start(users.alice, 'meetings.transcribe');
    expect(await run(stored.runId)).toMatchObject({ status: 'succeeded' });
    expect(await usage(users.alice), 'closing a run adds and removes no usage').toBe(before);
    // The same for the other path.
    const next = await start(users.alice, 'meetings.transcribe');
    await storedNotClosed(next.runId);
    await exec(users.owner, 'kernel.member.permission.set', { userId: users.alice, permission: 'vy.use', allowed: false });
    await exec(users.owner, 'kernel.member.permission.set', { userId: users.alice, permission: 'vy.use', allowed: null });
    expect(await run(next.runId)).toMatchObject({ status: 'succeeded' });
    expect(await usage(users.alice)).toBe(before);
  });

  it('a new start still supersedes a run whose result is running, and leaves a stored run of another feature alone', async () => {
    const stuck = await start(users.bob, 'notes.summary');
    const other = await start(users.bob, 'meetings.summary');
    await storedNotClosed(other.runId);
    const next = await start(users.bob, 'notes.summary');
    expect(await run(stuck.runId)).toMatchObject({ status: 'cancelled', error: 'RUN_SUPERSEDED' });
    expect(await run(next.runId)).toMatchObject({ status: 'running' });
    expect(await run(other.runId), 'another feature is not touched').toMatchObject({ status: 'running', error: null });
    expect(await result(other.runId)).toEqual({ status: 'ready', error_code: null });
  });

  it('supersedes a run whose result failed, and leaves that result as it was', async () => {
    const failedRun = await start(users.carol, 'notes.todo_suggest');
    await sqlAdmin(`UPDATE crove_kernel.member_vy_result SET status = 'failed', error_code = 'MODEL_FAILED' WHERE org_id = $1 AND run_id = $2`, [orgId, failedRun.runId]);
    await start(users.carol, 'notes.todo_suggest');
    expect(await run(failedRun.runId)).toMatchObject({ status: 'cancelled', error: 'RUN_SUPERSEDED' });
    expect(await result(failedRun.runId)).toEqual({ status: 'failed', error_code: 'MODEL_FAILED' });
  });

  it('closes a stored run as succeeded and cancels the others when vy.use is denied, a kill switch is engaged and the member is removed, and the finish after finds nothing', async () => {
    // `wholeMember`: the trigger ends every run of the member (a module kill switch ends only that module's runs, so the notes run is left running).
    const check = async (who: string, trigger: () => Promise<unknown>, wholeMember = true) => {
      const stored = await start(who, 'meetings.transcribe');
      const other = await start(who, 'meetings.summary');
      const failed = await start(who, 'notes.summary');
      await storedNotClosed(stored.runId, true);
      await sqlAdmin(`UPDATE crove_kernel.member_vy_result SET status = 'failed', error_code = 'MODEL_FAILED' WHERE org_id = $1 AND run_id = $2`, [orgId, failed.runId]);
      await trigger();
      expect(await run(stored.runId), 'the stored run').toMatchObject({ status: 'succeeded', error: null, private_read: true });
      expect(await result(stored.runId)).toEqual({ status: 'ready', error_code: null });
      expect(await run(other.runId), 'a run still working').toMatchObject({ status: 'cancelled' });
      expect(await result(other.runId)).toEqual({ status: 'failed', error_code: 'RUN_CANCELLED' });
      expect(await run(failed.runId), 'a run whose result failed').toMatchObject({ status: wholeMember ? 'cancelled' : 'running' });
      expect(await finish(stored.runId)).toEqual({ closed: false });
      expect(await run(stored.runId)).toMatchObject({ status: 'succeeded' });
    };
    await check(users.carol, async () => {
      await exec(users.owner, 'kernel.member.permission.set', { userId: users.carol, permission: 'vy.use', allowed: false });
      await exec(users.owner, 'kernel.member.permission.set', { userId: users.carol, permission: 'vy.use', allowed: null });
    });
    await check(users.dave, async () => {
      const engaged = await exec<{ killSwitchId: string; stoppedRuns: number }>(users.owner, 'kernel.agent.kill_switch.engage', { scope: 'module', target: 'meetings' });
      await runtime.execute('kernel.agent.kill_switch.release', { id: engaged.killSwitchId }, { actor: asMfa(users.owner), orgId });
    }, false);
    await check(users.erin, () => runtime.execute('kernel.member.remove', { userId: users.erin }, { actor: asMfa(users.owner), orgId }));
  });

  it('counts only the runs it cancelled: a kill switch over one stored and one working run reports one', async () => {
    const stored = await start(users.frank, 'meetings.transcribe');
    const working = await start(users.frank, 'meetings.summary');
    await storedNotClosed(stored.runId);
    // Every other live run of the org is ended first, so the count is this member's alone.
    await sqlAdmin(`UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE org_id = $1 AND status = 'running' AND id NOT IN ($2, $3)`, [orgId, stored.runId, working.runId]);
    const engaged = await exec<{ killSwitchId: string; stoppedRuns: number }>(users.owner, 'kernel.agent.kill_switch.engage', { scope: 'module', target: 'meetings' });
    expect(engaged.stoppedRuns).toBe(1);
    await runtime.execute('kernel.agent.kill_switch.release', { id: engaged.killSwitchId }, { actor: asMfa(users.owner), orgId });
    expect(await run(stored.runId)).toMatchObject({ status: 'succeeded' });
    expect(await run(working.runId)).toMatchObject({ status: 'cancelled' });
  });

  it('a cancel racing the worker\'s finish ends consistent: the run succeeded, the result ready, no error from either side', async () => {
    for (let round = 0; round < 4; round += 1) {
      const who = round % 2 === 0 ? users.alice : users.bob;
      const stored = await start(who, 'meetings.transcribe');
      await storedNotClosed(stored.runId);
      const settled = await Promise.allSettled([
        finish(stored.runId),
        exec(users.owner, 'kernel.member.permission.set', { userId: who, permission: 'vy.use', allowed: false }),
      ]);
      await exec(users.owner, 'kernel.member.permission.set', { userId: who, permission: 'vy.use', allowed: null });
      expect(settled.map((s) => s.status), `round ${round}`).toEqual(['fulfilled', 'fulfilled']);
      expect(await run(stored.runId), `round ${round}`).toMatchObject({ status: 'succeeded', error: null });
      expect(await result(stored.runId), `round ${round}`).toEqual({ status: 'ready', error_code: null });
    }
  });
});

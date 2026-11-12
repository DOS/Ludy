// SPDX-License-Identifier: AGPL-3.0-only
// One live Vy run per member per feature (#3029, ADR-0049 decision 1 amended 2026-11-12, owner decision of the same day): another use of Vy no longer cancels a transcription that is
// still running; a second start of the SAME feature still supersedes the first; every live run of a member ends together on a deny of vy.use, a kill switch and a removal; the budget
// counts every run; and a race between two starts of one feature leaves one run and a clear code (VY_RUN_BUSY). The database rules (the two partial unique indexes and the two binds)
// are pinned in test/invariant/member-vy-run-feature.db.test.ts. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { MEMBER_VY_FEATURES, createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const FEATURES = Object.keys(MEMBER_VY_FEATURES);

suite('one live Vy run per member per feature (#3029)', () => {
  const dbName = `crove_test_vy_per_feature_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users = { owner: '', alice: '', bob: '', carol: '', dave: '', erin: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const exec = <T>(who: string, name: string, input: unknown) => runtime.execute<T>(name, input, { actor: asUser(who), orgId });
  const start = (who: string, feature: string, subjectId = randomUUID()) =>
    exec<{ runId: string; resultId: string; expiresAt: string }>(who, 'kernel.member_vy.run.start', { feature, subjectType: feature.startsWith('meetings.') ? 'meeting' : 'note', subjectId });
  const store = (who: string, runId: string, outcome: unknown) => exec<{ stored: boolean; status: string }>(who, 'kernel.member_vy.result.store', { runId, outcome });
  const sqlAdmin = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return (await c.query<T>(text, values)).rows;
    } finally {
      await c.end();
    }
  };
  const run = async (runId: string) => (await sqlAdmin<{ status: string; error: string | null; feature: string | null }>('SELECT status, error, feature FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2', [orgId, runId]))[0];
  const result = async (runId: string) => (await sqlAdmin<{ status: string; error_code: string | null }>('SELECT status, error_code FROM crove_kernel.member_vy_result WHERE org_id = $1 AND run_id = $2', [orgId, runId]))[0];
  const liveOf = async (who: string) =>
    (await sqlAdmin<{ feature: string }>(
      `SELECT r.feature FROM crove_kernel.ai_run r JOIN crove_kernel.agent a ON a.org_id = r.org_id AND a.id = r.agent_id WHERE r.org_id = $1 AND a.member_user_id = $2 AND r.status = 'running' ORDER BY r.feature`,
      [orgId, who],
    )).map((r) => r.feature);

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 12 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'vy-per-feature', subject: key, email: `${key}@vy-per-feature.test`, name: null });
    }
    orgId = (await createOrg(runtime, asUser(users.owner), 'Vy theo tính năng')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'member'), ($1, $6, 'member')`, [
      orgId,
      users.alice,
      users.bob,
      users.carol,
      users.dave,
      users.erin,
    ]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('keeps a transcription running while the same member starts and finishes a summary and a note run', async () => {
    const meeting = randomUUID();
    const transcribe = await start(users.alice, 'meetings.transcribe', meeting);
    const summary = await start(users.alice, 'meetings.summary', randomUUID());
    const note = await start(users.alice, 'notes.summary');
    expect(await run(transcribe.runId)).toMatchObject({ status: 'running', feature: 'meetings.transcribe', error: null });
    expect(await liveOf(users.alice)).toEqual(['meetings.summary', 'meetings.transcribe', 'notes.summary']);
    expect(await store(users.alice, summary.runId, { status: 'ready', body: 'Tóm tắt' })).toMatchObject({ stored: true });
    expect(await store(users.alice, note.runId, { status: 'failed', errorCode: 'MODEL_FAILED' })).toMatchObject({ stored: false });
    // The transcription and its result row are untouched by the other two finishing.
    expect(await run(transcribe.runId)).toMatchObject({ status: 'running', error: null });
    expect(await result(transcribe.runId)).toMatchObject({ status: 'running', error_code: null });
    expect(await run(summary.runId)).toMatchObject({ status: 'succeeded' });
    // It can still store its own text.
    expect(await store(users.alice, transcribe.runId, { status: 'ready', body: 'Bản ghi lời' })).toMatchObject({ stored: true });
    expect(await run(transcribe.runId)).toMatchObject({ status: 'succeeded' });
  });

  it('still supersedes a running run of the SAME feature, and only that one', async () => {
    const other = await start(users.bob, 'meetings.transcribe');
    const first = await start(users.bob, 'notes.summary');
    const second = await start(users.bob, 'notes.summary');
    expect(await run(first.runId)).toMatchObject({ status: 'cancelled', error: 'RUN_SUPERSEDED' });
    expect(await run(second.runId)).toMatchObject({ status: 'running' });
    expect(await run(other.runId), 'a run of another feature is not touched').toMatchObject({ status: 'running', error: null });
    expect(await liveOf(users.bob)).toEqual(['meetings.transcribe', 'notes.summary']);
    // Another member is never touched either.
    expect(await liveOf(users.carol)).toEqual([]);
  });

  it('bounds a member at one live run per declared feature, whatever the starts', async () => {
    for (let round = 0; round < 2; round++) for (const feature of FEATURES) await start(users.carol, feature);
    expect(await liveOf(users.carol)).toEqual([...FEATURES].sort());
    expect(FEATURES.length, 'the declared member-mode features, and no per-member cap beyond them (ADR-0049 decision 1)').toBe(4);
  });

  it('ends every live run of the member, whichever the feature, when vy.use is denied, a kill switch is engaged and the member is removed', async () => {
    const both = async (who: string) => {
      const a = await start(who, 'meetings.transcribe');
      const b = await start(who, 'meetings.summary');
      return [a.runId, b.runId];
    };
    const expectEnded = async (ids: string[], reason?: string) => {
      for (const id of ids) {
        expect(await run(id), `run ${id}`).toMatchObject({ status: 'cancelled', ...(reason ? { error: reason } : {}) });
        expect(await result(id)).toMatchObject({ status: 'failed', error_code: 'RUN_CANCELLED' });
      }
    };
    // vy.use denied.
    const dave = await both(users.dave);
    await exec(users.owner, 'kernel.member.permission.set', { userId: users.dave, permission: 'vy.use', allowed: false });
    await expectEnded(dave);
    await exec(users.owner, 'kernel.member.permission.set', { userId: users.dave, permission: 'vy.use', allowed: null });
    // A kill switch (module 'meetings': both features meter under it).
    const erin = await both(users.erin);
    const engaged = await exec<{ killSwitchId: string; stoppedRuns: number }>(users.owner, 'kernel.agent.kill_switch.engage', { scope: 'module', target: 'meetings' });
    expect(engaged.stoppedRuns).toBeGreaterThanOrEqual(2);
    await expectEnded(erin);
    await runtime.execute('kernel.agent.kill_switch.release', { id: engaged.killSwitchId }, { actor: asMfa(users.owner), orgId });
    // The removal of the member.
    const alice = await both(users.alice);
    await runtime.execute('kernel.member.remove', { userId: users.alice }, { actor: asMfa(users.owner), orgId });
    await expectEnded(alice);
    expect(await liveOf(users.alice)).toEqual([]);
  });

  it('counts every run in the budget: the spend of a live transcription stops a start of another feature once it reaches the hard stop', async () => {
    const live = await start(users.bob, 'meetings.transcribe');
    // The transcription's own spend, recorded as the meter does; no other spend exists in this org this month.
    await exec(users.bob, 'kernel.member_vy.meter.record', { feature: 'meetings.transcribe', inputTokens: 1000, outputTokens: 100, cost: '0.500000' });
    const policy = (limit: string) =>
      sqlAdmin(`INSERT INTO crove_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by) VALUES ($1, 'org', '*', $2, 80, true, $3)`, [orgId, limit, users.owner]);
    try {
      await sqlAdmin('DELETE FROM crove_kernel.budget_policy WHERE org_id = $1', [orgId]);
      await policy('0.400000');
      await expect(start(users.bob, 'meetings.summary')).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });
      await expect(start(users.bob, 'notes.summary')).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });
      expect(await run(live.runId), 'the refused starts changed nothing about the live run').toMatchObject({ status: 'running' });
      // A limit above the spend lets the same start through while the transcription is live.
      await sqlAdmin('DELETE FROM crove_kernel.budget_policy WHERE org_id = $1', [orgId]);
      await policy('1.000000');
      expect(await start(users.bob, 'meetings.summary')).toMatchObject({ runId: expect.any(String) });
      expect(await run(live.runId)).toMatchObject({ status: 'running' });
    } finally {
      await sqlAdmin('DELETE FROM crove_kernel.budget_policy WHERE org_id = $1', [orgId]);
    }
  });

  it('answers VY_RUN_BUSY, never two running runs, when a start of the same feature loses a race', async () => {
    // Held open: another start of the feature has made its run and not yet committed (the supersede of the start below cannot see it).
    await start(users.carol, 'notes.todo_suggest');
    const agent = (await sqlAdmin<{ id: string }>(`SELECT id FROM crove_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`, [orgId, users.carol]))[0]?.id;
    await sqlAdmin(`UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE org_id = $1 AND agent_id = $2 AND status = 'running' AND feature = 'notes.todo_suggest'`, [orgId, agent]);
    const holder = new pg.Client({ connectionString: adminUrl });
    await holder.connect();
    const winner = randomUUID();
    try {
      await holder.query('BEGIN');
      // The triggers are set aside: this seeds the committed state of the winning start by hand, as the superuser.
      await holder.query('SET LOCAL session_replication_role = replica');
      await holder.query(
        `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, feature, status, tainted, started_at, expires_at) VALUES ($1, $2, $3, 'notes', 'notes.todo_suggest', 'running', true, now(), now() + interval '30 minutes')`,
        [orgId, winner, agent],
      );
      const racing = start(users.carol, 'notes.todo_suggest').then(
        () => 'started',
        (error: { code?: string }) => error.code ?? 'error',
      );
      // The start is stuck on the unique index until the winner commits: wait until a backend of this database is seen waiting on a lock.
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = (await sqlAdmin(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`)).length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(waiting, 'the start is waiting for the winner').toBe(true);
      await holder.query('COMMIT');
      expect(await racing, 'the loser is told to try again').toBe('VY_RUN_BUSY');
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }
    expect((await liveOf(users.carol)).filter((f) => f === 'notes.todo_suggest')).toHaveLength(1);
    expect(await run(winner)).toMatchObject({ status: 'running' });
    // Asked again, the start supersedes the winner as any later start does.
    const later = await start(users.carol, 'notes.todo_suggest');
    expect(await run(winner)).toMatchObject({ status: 'cancelled', error: 'RUN_SUPERSEDED' });
    expect(await run(later.runId)).toMatchObject({ status: 'running' });
  });

  it('leaves at most one running run per feature when many starts of one feature arrive together', async () => {
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => start(users.dave, 'notes.summary')));
    for (const s of settled) if (s.status === 'rejected') expect((s.reason as { code?: string }).code).toBe('VY_RUN_BUSY');
    expect(settled.some((s) => s.status === 'fulfilled')).toBe(true);
    expect((await liveOf(users.dave)).filter((f) => f === 'notes.summary')).toHaveLength(1);
  });
});

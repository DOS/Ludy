// SPDX-License-Identifier: AGPL-3.0-only
// The commands of Vy working for one member (ADR-0049 stage A, issue #2782): a run is started and its text stored only through the
// member's own commands; vy.use, the kill switches, the budget and a removal are checked at every step; the meter's two doors derive the
// agent; nothing private reaches an audit row. The invariants of who may read what are in test/invariant/member-vy-private.db.test.ts.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AiBudgetExhaustedError, metered, withAiScope } from '@ludy/agent';
import { createDb, createPool } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { memberMeter } from '../src/ai-meter.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET = 'Tóm tắt riêng: khách đề nghị giảm giá 12%';

suite('member Vy commands (ADR-0049 stage A slice 3)', () => {
  const dbName = `ludy_test_member_vy_cmd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users = { owner: '', admin: '', alice: '', bob: '', viewer: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const exec = <T>(who: string, name: string, input: unknown) => runtime.execute<T>(name, input, { actor: asUser(who), orgId });
  const query = <T>(who: string, name: string, input: unknown) => runtime.query<T>(name, input, { actor: asUser(who), orgId });
  const start = (who: string, feature = 'notes.todo_plan') => exec<{ runId: string; resultId: string; expiresAt: string }>(who, 'kernel.member_vy.run.start', { feature, subjectType: 'member', subjectId: randomUUID() });
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
  const runStatus = async (runId: string) => (await sqlAdmin<{ status: string }>('SELECT status FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2', [orgId, runId]))[0]?.status;
  const resetRuns = () => sqlAdmin(`UPDATE ludy_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE org_id = $1 AND status = 'running'`, [orgId]);

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
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'member-vy-cmd', subject: key, email: `${key}@member-vy-cmd.test`, name: null });
    }
    orgId = (await createOrg(runtime, asUser(users.owner), 'Vy lệnh')).orgId;
    await sqlAdmin(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`, [orgId, users.admin, users.alice, users.bob, users.viewer]);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('starts a run for the member: their own Vy once, one run, one result in status running', async () => {
    const first = await start(users.alice);
    expect(await runStatus(first.runId)).toBe('running');
    const second = await start(users.alice);
    expect(await runStatus(first.runId), 'the next start closes an abandoned run of the same member').toBe('cancelled');
    expect(await runStatus(second.runId)).toBe('running');
    const agents = await sqlAdmin(`SELECT id FROM ludy_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`, [orgId, users.alice]);
    expect(agents, 'one Vy per member').toHaveLength(1);
    const got = await query<{ status: string; privateRead: boolean; tainted: boolean }>(users.alice, 'kernel.member_vy.result.get', { runId: second.runId });
    expect(got).toMatchObject({ status: 'running', privateRead: true, tainted: true });
    await expect(query(users.bob, 'kernel.member_vy.result.get', { runId: second.runId }), 'another member reading it').rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });
    await expect(exec(users.alice, 'kernel.member_vy.run.start', { feature: 'finance.invoice_extract', subjectType: 'member', subjectId: randomUUID() }), 'a feature that is not a member-Vy feature').rejects.toThrow();
  });

  it('stores the text through the one command, tainted and private, with nothing of it in the audit trail', async () => {
    await resetRuns();
    const run = await start(users.alice);
    expect(await store(users.alice, run.runId, { status: 'ready', body: SECRET, sourceRevision: 3 })).toEqual({ stored: true, status: 'ready' });
    expect(await runStatus(run.runId)).toBe('succeeded');
    expect(await query(users.alice, 'kernel.member_vy.result.get', { runId: run.runId })).toMatchObject({ status: 'ready', body: SECRET, sourceRevision: 3, privateRead: true, tainted: true });
    expect((await sqlAdmin<{ private_read: boolean }>('SELECT private_read FROM ludy_kernel.ai_run WHERE org_id = $1 AND id = $2', [orgId, run.runId]))[0]?.private_read).toBe(true);
    await expect(store(users.alice, run.runId, { status: 'ready', body: 'lần hai' }), 'a second store of the same run').rejects.toMatchObject({ code: 'VY_RUN_NOT_LIVE' });
    // The audit trail, the activity feed and the outbox never carry the text (decision 4).
    for (const table of ['audit_event', 'activity', 'outbox_event']) {
      const rows = await sqlAdmin<{ t: string }>(`SELECT row_to_json(x)::text AS t FROM ludy_kernel.${table} x WHERE org_id = $1`, [orgId]);
      expect(rows.filter((r) => r.t.includes('giảm giá')), `${table} holds none of the text`).toEqual([]);
    }
    const audited = await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member_vy.result.store'`, [orgId]);
    expect(Number(audited[0]?.n)).toBeGreaterThan(0);
  });

  it('refuses to store another member\'s run, an unknown run and a run that is not live', async () => {
    await resetRuns();
    const run = await start(users.alice);
    await expect(store(users.bob, run.runId, { status: 'ready', body: 'x' })).rejects.toMatchObject({ code: 'VY_RUN_NOT_LIVE' });
    await expect(store(users.alice, randomUUID(), { status: 'ready', body: 'x' })).rejects.toMatchObject({ code: 'VY_RUN_NOT_LIVE' });
    // Triggers off for this one statement: the 4-hour bound (#2856) forbids moving the start of a member_vy run, and an expired run needs both moved (CHECK expires_at > started_at).
    await sqlAdmin(`SET LOCAL session_replication_role = replica; UPDATE ludy_kernel.ai_run SET expires_at = now() - interval '1 minute', started_at = now() - interval '1 hour' WHERE org_id = '${orgId}' AND id = '${run.runId}'`);
    await expect(store(users.alice, run.runId, { status: 'ready', body: 'x' }), 'an expired run').rejects.toMatchObject({ code: 'VY_RUN_NOT_LIVE' });
    // A failed run stores a fixed code and no text.
    await resetRuns();
    const failing = await start(users.alice);
    expect(await store(users.alice, failing.runId, { status: 'failed', errorCode: 'MODEL_ERROR' })).toEqual({ stored: false, status: 'failed' });
    expect(await query(users.alice, 'kernel.member_vy.result.get', { runId: failing.runId })).toMatchObject({ status: 'failed', errorCode: 'MODEL_ERROR', body: null });
  });

  // #2822: the store of an accepted result of a finished run is refused: the run closed when it stored, so a second store (a replay, a late retry) finds no live run.
  it('refuses to store again into the accepted result of a finished run', async () => {
    await resetRuns();
    const run = await start(users.alice);
    expect(await store(users.alice, run.runId, { status: 'ready', body: 'Bản đầu' })).toEqual({ stored: true, status: 'ready' });
    expect(await runStatus(run.runId), 'the member\'s own store closes the run').toBe('succeeded');
    // The member accepts it (the taint goes): as the superuser here, outside any context.
    await sqlAdmin(`UPDATE ludy_kernel.member_vy_result SET tainted = false WHERE org_id = $1 AND run_id = $2`, [orgId, run.runId]);
    await expect(store(users.alice, run.runId, { status: 'ready', body: 'Bản thay' })).rejects.toMatchObject({ code: 'VY_RUN_NOT_LIVE' });
    const after = await query<{ body: string | null; tainted: boolean }>(users.alice, 'kernel.member_vy.result.get', { runId: run.runId });
    expect(after).toMatchObject({ body: 'Bản đầu', tainted: false });
  });

  it('asks vy.use at the start and the store, and a viewer holds it only through a grant', async () => {
    await resetRuns();
    await expect(start(users.viewer)).rejects.toMatchObject({ code: 'VY_NOT_ALLOWED' });
    await exec(users.owner, 'kernel.member.permission.set', { userId: users.viewer, permission: 'vy.use', allowed: true });
    const viewerRun = await start(users.viewer);
    expect(await store(users.viewer, viewerRun.runId, { status: 'ready', body: 'của người xem' })).toMatchObject({ stored: true });
    // A deny while a run is live ends the run, and its late text is refused.
    await resetRuns();
    const live = await start(users.bob);
    await exec(users.owner, 'kernel.member.permission.set', { userId: users.bob, permission: 'vy.use', allowed: false });
    expect(await runStatus(live.runId), 'the live run ended with the permission').toBe('cancelled');
    await expect(store(users.bob, live.runId, { status: 'ready', body: 'muộn' })).rejects.toMatchObject({ code: 'VY_NOT_ALLOWED' });
    await expect(start(users.bob)).rejects.toMatchObject({ code: 'VY_NOT_ALLOWED' });
    await exec(users.owner, 'kernel.member.permission.set', { userId: users.bob, permission: 'vy.use', allowed: null });
  });

  it('stops at an org kill switch and at a spent budget, and a switch engaged mid-run discards the late text', async () => {
    await resetRuns();
    const live = await start(users.alice);
    const engaged = await exec<{ killSwitchId: string; stoppedRuns: number }>(users.owner, 'kernel.agent.kill_switch.engage', { scope: 'org', target: '*' });
    expect(engaged.stoppedRuns, 'the owner\'s command ends the member\'s live run through the definer').toBeGreaterThan(0);
    expect(await runStatus(live.runId)).toBe('cancelled');
    await expect(start(users.alice)).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });
    expect(await query(users.alice, 'kernel.member_vy.meter.check', { feature: 'notes.summary' })).toMatchObject({ allowed: false, scope: 'org' });
    await runtime.execute('kernel.agent.kill_switch.release', { id: engaged.killSwitchId }, { actor: asMfa(users.owner), orgId });
    // A module switch engaged between the start and the store: the store marks the result failed and keeps no text.
    await resetRuns();
    const run = await start(users.alice);
    const moduleSwitch = await exec<{ killSwitchId: string; stoppedRuns: number }>(users.owner, 'kernel.agent.kill_switch.engage', { scope: 'module', target: 'notes' });
    expect(moduleSwitch.stoppedRuns, 'a module switch ends the runs metered under the module').toBeGreaterThan(0);
    // The run was ended by the switch; a store that still reached the database (a model call that finished in flight, its run revived here) meets the switch itself.
    await sqlAdmin(`UPDATE ludy_kernel.ai_run SET status = 'running', finished_at = NULL, error = NULL WHERE org_id = $1 AND id = $2`, [orgId, run.runId]);
    await sqlAdmin(`UPDATE ludy_kernel.member_vy_result SET status = 'running', error_code = NULL WHERE org_id = $1 AND run_id = $2`, [orgId, run.runId]);
    expect(await store(users.alice, run.runId, { status: 'ready', body: SECRET })).toEqual({ stored: false, status: 'failed' });
    expect(await query(users.alice, 'kernel.member_vy.result.get', { runId: run.runId })).toMatchObject({ status: 'failed', errorCode: 'AI_STOPPED', body: null });
    await expect(start(users.alice)).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });
    await runtime.execute('kernel.agent.kill_switch.release', { id: moduleSwitch.killSwitchId }, { actor: asMfa(users.owner), orgId });
    // A spent hard-stop budget of the org.
    await sqlAdmin(`INSERT INTO ludy_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by) VALUES ($1, 'org', '*', 0, 80, true, $2)`, [orgId, users.owner]);
    await expect(start(users.alice)).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });
    await sqlAdmin(`DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1`, [orgId]);
    await resetRuns();
    expect(await start(users.alice)).toMatchObject({ runId: expect.any(String) });
  });

  it('ends a member\'s live run when they are removed, and purges nothing before the 30 days', async () => {
    await resetRuns();
    const live = await start(users.bob);
    await store(users.bob, live.runId, { status: 'ready', body: 'của Bob' });
    const second = await start(users.bob);
    const rowsOf = async () => (await sqlAdmin<{ n: string }>('SELECT count(*)::text AS n FROM ludy_kernel.member_vy_result WHERE org_id = $1 AND member_user_id = $2', [orgId, users.bob]))[0]?.n;
    const before = await rowsOf();
    await runtime.execute('kernel.member.remove', { userId: users.bob }, { actor: asMfa(users.owner), orgId });
    expect(await runStatus(second.runId)).toBe('cancelled');
    expect(await rowsOf(), 'the rows stay for the 30 days').toBe(before);
  });

  it('discards the text of a store that races a cancel, and neither blocks the other for good', async () => {
    await resetRuns();
    const run = await start(users.alice);
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    // A cancel by the owner, held open: it has ended the run and the result and not yet committed.
    const cancel = new pg.Client({ connectionString: url.toString() });
    await cancel.connect();
    try {
      await cancel.query('BEGIN');
      await cancel.query('SELECT ludy_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users.owner, orgId)]);
      const ended = await cancel.query<{ n: string }>(`SELECT ludy_kernel.member_vy_runs_cancel(NULL, $1::uuid, NULL, 'TEST') AS n`, [users.alice]);
      expect(ended.rows[0]?.n).toBe('1');
      // The store checks the run while the cancel holds it: it waits for the row, then sees the run ended.
      const racing = store(users.alice, run.runId, { status: 'ready', body: SECRET });
      const settled = racing.then(() => 'stored', (error: { code?: string }) => error.code ?? 'error');
      await new Promise((resolve) => setTimeout(resolve, 400));
      await cancel.query('COMMIT');
      expect(await settled, 'the late text is refused').toBe('VY_RUN_NOT_LIVE');
    } finally {
      await cancel.query('ROLLBACK').catch(() => {});
      await cancel.end();
    }
    expect(await runStatus(run.runId)).toBe('cancelled');
    expect(await query(users.alice, 'kernel.member_vy.result.get', { runId: run.runId })).toMatchObject({ status: 'failed', errorCode: 'RUN_CANCELLED', body: null });
  });

  it('derives the agent of the meter\'s doors from the member, and keeps the spend as figures', async () => {
    await resetRuns();
    await start(users.alice);
    const own = (await sqlAdmin<{ id: string }>(`SELECT id FROM ludy_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`, [orgId, users.alice]))[0]?.id;
    expect(await query(users.alice, 'kernel.member_vy.meter.check', { feature: 'notes.summary' })).toEqual({ allowed: true });
    expect(await exec(users.alice, 'kernel.member_vy.meter.record', { feature: 'notes.summary', inputTokens: 120, outputTokens: 30, cost: '0.000150' })).toEqual({ recorded: true });
    const usage = await sqlAdmin<{ agent_id: string; module: string; feature: string }>(`SELECT agent_id, module, feature FROM ludy_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost' AND feature = 'notes.summary'`, [orgId]);
    expect(usage).toEqual([{ agent_id: own, module: 'notes', feature: 'notes.summary' }]);
    // The input has no agent field: one a caller adds is dropped, and the spend still goes to the member's own Vy.
    const other = (await sqlAdmin<{ id: string }>(`SELECT id FROM ludy_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id <> $2 LIMIT 1`, [orgId, users.alice]))[0]?.id ?? randomUUID();
    await exec(users.alice, 'kernel.member_vy.meter.record', { feature: 'notes.summary', inputTokens: 1, outputTokens: 1, cost: '0', agentId: other });
    expect(await sqlAdmin(`SELECT 1 FROM ludy_kernel.org_usage WHERE org_id = $1 AND agent_id = $2`, [orgId, other])).toHaveLength(0);
  });

  it('keeps what Vy remembers about the member to the member, who writes and deletes it', async () => {
    const saved = await exec<{ id: string }>(users.alice, 'kernel.member_vy.memory.save', { body: 'Gọi khách là anh' });
    expect(await query(users.alice, 'kernel.member_vy.memory.list', {})).toMatchObject({ entries: [{ id: saved.id, body: 'Gọi khách là anh' }] });
    expect(await query(users.owner, 'kernel.member_vy.memory.list', {}), 'an owner sees none of it').toEqual({ entries: [] });
    await expect(exec(users.owner, 'kernel.member_vy.memory.save', { id: saved.id, body: 'đổi hộ' })).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
    expect(await exec(users.alice, 'kernel.member_vy.memory.save', { id: saved.id, body: 'Gọi khách là chị' })).toEqual({ id: saved.id });
    expect(await exec(users.owner, 'kernel.member_vy.memory.delete', { id: saved.id }), 'another member deleting it').toEqual({ deleted: false });
    expect(await exec(users.alice, 'kernel.member_vy.memory.delete', { id: saved.id })).toEqual({ deleted: true });
  });

  // #2941: a feature that must not cut off a paid run, or that shows a run's state, asks the kernel instead of reading the private result rows. Both read the caller's own rows.
  it('answers whether the caller has a live run, from their own rows only', async () => {
    const subjectId = randomUUID();
    expect(await query(users.admin, 'kernel.member_vy.run.live', { feature: 'notes.organize' }), 'nothing yet').toEqual({ live: false });
    const run = await exec<{ runId: string }>(users.admin, 'kernel.member_vy.run.start', { feature: 'notes.organize', subjectType: 'member', subjectId });
    expect(await query(users.admin, 'kernel.member_vy.run.live', { feature: 'notes.organize' })).toEqual({ live: true });
    expect(await query(users.admin, 'kernel.member_vy.run.live', { feature: 'notes.organize', subjectId })).toEqual({ live: true });
    expect(await query(users.admin, 'kernel.member_vy.run.live', { feature: 'notes.organize', subjectId: randomUUID() }), 'another subject').toEqual({ live: false });
    expect(await query(users.admin, 'kernel.member_vy.run.live', { feature: 'notes.todo_plan' }), 'another feature').toEqual({ live: false });
    expect(await query(users.owner, 'kernel.member_vy.run.live', { feature: 'notes.organize', subjectId }), 'another member\'s run is invisible').toEqual({ live: false });
    await sqlAdmin(`UPDATE ludy_kernel.ai_run SET status = 'cancelled', finished_at = now(), error = 'RUN_CANCELLED' WHERE org_id = $1 AND id = $2`, [orgId, run.runId]);
    expect(await query(users.admin, 'kernel.member_vy.run.live', { feature: 'notes.organize' }), 'a run that ended').toEqual({ live: false });
  });

  it('answers the state of the caller\'s latest run for a subject, and nothing else of it', async () => {
    const subjectId = randomUUID();
    expect(await query(users.admin, 'kernel.member_vy.run.latest', { feature: 'notes.organize', subjectType: 'member', subjectId }), 'no run').toBeNull();
    const run = await exec<{ runId: string }>(users.admin, 'kernel.member_vy.run.start', { feature: 'notes.organize', subjectType: 'member', subjectId });
    const latest = await query<Record<string, unknown>>(users.admin, 'kernel.member_vy.run.latest', { feature: 'notes.organize', subjectType: 'member', subjectId });
    expect(Object.keys(latest ?? {}).sort(), 'only the run id, the state, the error word and the expiry').toEqual(['errorCode', 'expiresAt', 'runId', 'state']);
    expect(latest).toMatchObject({ runId: run.runId, state: 'running', errorCode: null });
    expect(await query(users.owner, 'kernel.member_vy.run.latest', { feature: 'notes.organize', subjectType: 'member', subjectId }), 'another member sees nothing of it').toBeNull();
    expect(await query(users.admin, 'kernel.member_vy.run.latest', { feature: 'notes.organize', subjectType: 'member', subjectId: randomUUID() }), 'another subject').toBeNull();
    // A run that ended while its result stayed running shows as failed with the fixed word RUN_ENDED, never as running for ever.
    await sqlAdmin(`UPDATE ludy_kernel.ai_run SET status = 'cancelled', finished_at = now(), error = 'RUN_CANCELLED' WHERE org_id = $1 AND id = $2`, [orgId, run.runId]);
    const ended = await query<Record<string, unknown>>(users.admin, 'kernel.member_vy.run.latest', { feature: 'notes.organize', subjectType: 'member', subjectId });
    expect(ended).toMatchObject({ runId: run.runId, state: 'failed', errorCode: 'RUN_ENDED' });
  });

  // #2951: the two run queries are a person's own view of their own runs. A non-user caller (the system actor) is refused, whatever the input.
  it('refuses a non-user caller on the two run queries', async () => {
    const system = { type: 'system' as const, component: 'kernel.member_vy' };
    const refusals: unknown[] = [];
    for (const [name, input] of [
      ['kernel.member_vy.run.live', { feature: 'notes.organize' }],
      ['kernel.member_vy.run.latest', { feature: 'notes.organize', subjectType: 'member', subjectId: randomUUID() }],
    ] as const) {
      refusals.push(await runtime.query(name, input, { actor: system, orgId }).then(() => 'ANSWERED', (error: { code?: string }) => error.code));
    }
    expect(refusals).toEqual(['FORBIDDEN', 'FORBIDDEN']);
    // They declare no memberVy access, so the runtime refuses them to the member's own background Vy too (a declared one is the only door into a member-mode context).
    const declared = kernelQueries({ inboundDomain: 'in.test' }).filter((q) => q.name === 'kernel.member_vy.run.live' || q.name === 'kernel.member_vy.run.latest');
    expect(declared.map((q) => q.name).sort()).toEqual(['kernel.member_vy.run.latest', 'kernel.member_vy.run.live']);
    for (const q of declared) expect((q as { memberVy?: unknown }).memberVy ?? null, q.name).toBeNull();
  });

  it('keeps member-Vy hard-stop monthly caps strict under concurrent metered() calls and releases failed calls (#3979)', async () => {
    await resetRuns();
    const run = await start(users.alice);
    const own = (await sqlAdmin<{ id: string }>(`SELECT id FROM ludy_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`, [orgId, users.alice]))[0]?.id;
    expect(own).toBeTruthy();

    await sqlAdmin(`DELETE FROM ludy_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost'`, [orgId]);
    await sqlAdmin(`DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1`, [orgId]);
    // Set an org hard-stop cap of 0.009500: two 0.004500 calls fit, the third is rejected.
    await runtime.execute('kernel.agent.budget.set', { scope: 'org', target: '*', monthlyLimit: '0.009500' }, { actor: asMfa(users.owner), orgId });

    const price = { inputPerMTok: '3', outputPerMTok: '15' };
    const usage = { inputTokens: 1000, outputTokens: 100 };
    const baseMeter = memberMeter(runtime, asUser(users.alice), { price });

    let inFlight = 0;
    let admitted = 0;
    let rejectedCount = 0;
    let released = false;
    let releaseHold!: () => void;
    const holdOpen = new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
    let resolveAllDecided!: () => void;
    let rejectAllDecided!: (reason?: unknown) => void;
    const allDecided = new Promise<void>((resolve, reject) => {
      resolveAllDecided = resolve;
      rejectAllDecided = reject;
    });
    const checkDecided = () => {
      if (admitted + rejectedCount === 4 && inFlight + rejectedCount === 4) {
        resolveAllDecided();
      }
    };

    const settledPromise = Promise.allSettled(
      Array.from({ length: 4 }, () => {
        let rejectedInAdmit = false;
        const meter: typeof baseMeter = {
          admit: async (call) => {
            try {
              const reservationId = await baseMeter.admit(call);
              admitted += 1;
              checkDecided();
              return reservationId;
            } catch (error) {
              rejectedInAdmit = true;
              rejectedCount += 1;
              checkDecided();
              throw error;
            }
          },
          record: (call, used, reservationId) => baseMeter.record(call, used, reservationId),
          ...(baseMeter.release ? { release: (call, reservationId) => baseMeter.release!(call, reservationId) } : {}),
        };
        return withAiScope({ orgId, memberRunId: run.runId, meter }, () =>
          metered(
            'notes.summary',
            async () => {
              inFlight += 1;
              checkDecided();
              await holdOpen;
              return { usage };
            },
            undefined,
            usage,
          ),
        ).catch((error) => {
          if (!released && !rejectedInAdmit) {
            rejectAllDecided(error);
          }
          throw error;
        });
      }),
    );

    let settled: PromiseSettledResult<unknown>[];
    try {
      await allDecided;
      expect(admitted).toBe(2);
      expect(rejectedCount).toBe(2);
      expect(inFlight).toBe(2);
    } finally {
      released = true;
      releaseHold();
      settled = await settledPromise;
    }

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(2);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(AiBudgetExhaustedError);

    expect(await sqlAdmin(`SELECT 1 FROM ludy_kernel.ai_budget_reservation WHERE org_id = $1`, [orgId])).toHaveLength(0);

    // A failed call releases its hold immediately; another member cannot release Alice's reservation.
    await sqlAdmin(`DELETE FROM ludy_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost'`, [orgId]);
    await expect(
      withAiScope({ orgId, memberRunId: run.runId, meter: baseMeter }, () =>
        metered(
          'notes.summary',
          async () => {
            throw new Error('vy provider failed');
          },
          undefined,
          usage,
        ),
      ),
    ).rejects.toThrow('vy provider failed');
    expect(await sqlAdmin(`SELECT 1 FROM ludy_kernel.ai_budget_reservation WHERE org_id = $1`, [orgId])).toHaveLength(0);

    const held = await exec<{ allowed: true; reservationId: string }>(users.alice, 'kernel.member_vy.meter.reserve', {
      feature: 'notes.summary',
      projectedCost: '0.004500',
    });
    expect(held.allowed).toBe(true);
    // Another member cannot release Alice's reservation.
    expect(await exec(users.owner, 'kernel.member_vy.meter.release', { reservationId: held.reservationId })).toEqual({ released: false });
    expect(await exec(users.alice, 'kernel.member_vy.meter.release', { reservationId: held.reservationId })).toEqual({ released: true });
    await sqlAdmin(`DELETE FROM ludy_kernel.budget_policy WHERE org_id = $1`, [orgId]);
  });

  it('prevents cross-actor, viewer, and null-agent reservation deletion IDORs and enforces active member_vy agent (B1)', async () => {
    await resetRuns();
    // Ensure Alice has an active member_vy agent, while users.owner has no member_vy agent row.
    await start(users.alice);
    const aliceAgent = (await sqlAdmin<{ id: string }>(`SELECT id FROM ludy_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`, [orgId, users.alice]))[0]?.id;
    expect(aliceAgent).toBeTruthy();

    // Users without a member_vy agent cannot reserve via member_vy.meter.reserve.
    await expect(exec(users.owner, 'kernel.member_vy.meter.reserve', { feature: 'notes.summary', projectedCost: '0.001000' })).rejects.toMatchObject({ code: 'VY_NOT_ALLOWED' });

    // Create three distinct holds: Alice's member_vy hold, Alice's non-Vy member hold (agent_id NULL), and a system hold (actor_user_id NULL).
    const aliceVyHold = await exec<{ allowed: true; reservationId: string }>(users.alice, 'kernel.member_vy.meter.reserve', {
      feature: 'notes.summary',
      projectedCost: '0.001000',
    });
    const aliceMemberHold = await exec<{ allowed: true; reservationId: string }>(users.alice, 'kernel.ai.budget.reserve_member', {
      module: 'social',
      agentId: null,
      feature: 'social.draft',
      projectedCost: '0.001000',
    });
    const appUrl = new URL(adminUrl);
    appUrl.username = 'ludy_app';
    appUrl.password = 'test-app-pw';
    const appPool = createPool({ connectionString: appUrl.toString(), max: 1 });
    const workerUrl = new URL(adminUrl);
    workerUrl.username = 'ludy_worker';
    workerUrl.password = 'test-worker-pw';
    const workerPool = createPool({ connectionString: workerUrl.toString(), max: 2 });
    const workerRuntime = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands],
      queries: [...kernelQueries({ inboundDomain: 'in.test' })],
    });
    try {
      const viewerEmail = `viewer-no-agent-${randomUUID().slice(0, 8)}@vy.test`;
      const viewerNoAgent = await upsertIdentity(createDb(appPool), {
        issuer: 'test',
        subject: randomUUID(),
        email: viewerEmail,
        name: 'Viewer Without Vy',
      });
      const viewerInvite = await runtime.execute<{ acceptPath: string }>(
        'kernel.member.invite.create',
        { email: viewerEmail, role: 'viewer' },
        { actor: asMfa(users.owner), orgId },
      );
      await runtime.executeOrgless(
        'kernel.member.invite.accept',
        { token: viewerInvite.acceptPath.split('#')[1] ?? '' },
        { actor: asUser(viewerNoAgent) },
      );

      const systemHold = await workerRuntime.execute<{ allowed: true; reservationId: string }>(
        'kernel.ai.budget.reserve',
        { module: 'social', agentId: null, feature: 'social.draft', projectedCost: '0.001000' },
        { actor: { type: 'system', component: 'test' }, orgId },
      );
      expect(aliceVyHold.allowed && aliceMemberHold.allowed && systemHold.allowed).toBe(true);

      // 1) A viewer (no vy.use, no member_vy agent) cannot reserve via member_vy.meter.reserve and cannot release any foreign/agent_id-IS-NULL hold via member_vy.meter.release.
      await expect(exec(viewerNoAgent, 'kernel.member_vy.meter.reserve', { feature: 'notes.summary', projectedCost: '0.001000' })).rejects.toMatchObject({ code: 'VY_NOT_ALLOWED' });
      expect(await exec(viewerNoAgent, 'kernel.member_vy.meter.release', { reservationId: aliceMemberHold.reservationId })).toEqual({ released: false });
      expect(await exec(viewerNoAgent, 'kernel.member_vy.meter.release', { reservationId: systemHold.reservationId })).toEqual({ released: false });
      expect(await exec(viewerNoAgent, 'kernel.member_vy.meter.release', { reservationId: aliceVyHold.reservationId })).toEqual({ released: false });

      // 2) An owner with vy.use but no member_vy agent returns { released: false } without touching agent_id IS NULL holds.
      expect(await exec(users.owner, 'kernel.member_vy.meter.release', { reservationId: aliceMemberHold.reservationId })).toEqual({ released: false });
      expect(await exec(users.owner, 'kernel.member_vy.meter.release', { reservationId: systemHold.reservationId })).toEqual({ released: false });
      expect(await exec(users.owner, 'kernel.member_vy.meter.release', { reservationId: aliceVyHold.reservationId })).toEqual({ released: false });

      // 3) Another member cannot release or settle Alice's member_vy hold, Alice's non-Vy hold, or a system hold via *_member.
      for (const id of [aliceVyHold.reservationId, aliceMemberHold.reservationId, systemHold.reservationId]) {
        expect(await exec(users.owner, 'kernel.ai.budget.release_member', { reservationId: id })).toEqual({ released: false });
        await exec(users.owner, 'kernel.ai.usage.record_member', {
          feature: 'social.draft',
          module: 'social',
          agentId: null,
          inputTokens: 1,
          outputTokens: 1,
          cost: '0',
          reservationId: id,
        });
      }

      // 4) Even Alice herself cannot cross-release her member_vy hold via release_member (requires agent_id IS NULL) or vice versa.
      expect(await exec(users.alice, 'kernel.ai.budget.release_member', { reservationId: aliceVyHold.reservationId })).toEqual({ released: false });
      expect(await exec(users.alice, 'kernel.member_vy.meter.release', { reservationId: aliceMemberHold.reservationId })).toEqual({ released: false });

      // All three holds are still intact.
      const intact = await sqlAdmin<{ id: string }>(
        `SELECT id FROM ludy_kernel.ai_budget_reservation WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [orgId, [aliceVyHold.reservationId, aliceMemberHold.reservationId, systemHold.reservationId]],
      );
      expect(intact).toHaveLength(3);

      // 5) Paused member_vy agent cannot reserve via member_vy.meter.reserve.
      await sqlAdmin(`UPDATE ludy_kernel.agent SET status = 'paused' WHERE org_id = $1 AND id = $2`, [orgId, aliceAgent]);
      await expect(exec(users.alice, 'kernel.member_vy.meter.reserve', { feature: 'notes.summary', projectedCost: '0.001000' })).rejects.toMatchObject({ code: 'VY_NOT_ALLOWED' });
      await sqlAdmin(`UPDATE ludy_kernel.agent SET status = 'active' WHERE org_id = $1 AND id = $2`, [orgId, aliceAgent]);

      // Clean up each hold exclusively through its matching authority.
      expect(await exec(users.alice, 'kernel.member_vy.meter.release', { reservationId: aliceVyHold.reservationId })).toEqual({ released: true });
      expect(await exec(users.alice, 'kernel.ai.budget.release_member', { reservationId: aliceMemberHold.reservationId })).toEqual({ released: true });
      expect(
        await workerRuntime.execute('kernel.ai.budget.release', { reservationId: systemHold.reservationId }, { actor: { type: 'system', component: 'test' }, orgId }),
      ).toEqual({ released: true });

      // 6) Mid-flight vy.use revocation blocks new reserves but still lets the owning member release their own in-flight hold (while others still cannot).
      const revokedHold = await exec<{ allowed: true; reservationId: string }>(users.alice, 'kernel.member_vy.meter.reserve', {
        feature: 'notes.summary',
        projectedCost: '0.001000',
      });
      await exec(users.owner, 'kernel.member.permission.set', { userId: users.alice, permission: 'vy.use', allowed: false });
      try {
        await expect(exec(users.alice, 'kernel.member_vy.meter.reserve', { feature: 'notes.summary', projectedCost: '0.001000' })).rejects.toMatchObject({ code: 'VY_NOT_ALLOWED' });
        expect(await exec(users.owner, 'kernel.member_vy.meter.release', { reservationId: revokedHold.reservationId })).toEqual({ released: false });
        expect(await exec(users.alice, 'kernel.member_vy.meter.release', { reservationId: revokedHold.reservationId })).toEqual({ released: true });
      } finally {
        await exec(users.owner, 'kernel.member.permission.set', { userId: users.alice, permission: 'vy.use', allowed: null });
      }
    } finally {
      await Promise.all([appPool.end(), workerPool.end()]);
    }
  });
});

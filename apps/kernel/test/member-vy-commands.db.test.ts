// SPDX-License-Identifier: AGPL-3.0-only
// The commands of Vy working for one member (ADR-0049 stage A, issue #2782): a run is started and its text stored only through the
// member's own commands; vy.use, the kill switches, the budget and a removal are checked at every step; the meter's two doors derive the
// agent; nothing private reaches an audit row. The invariants of who may read what are in test/invariant/member-vy-private.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET = 'Tóm tắt riêng: khách đề nghị giảm giá 12%';

suite('member Vy commands (ADR-0049 stage A slice 3)', () => {
  const dbName = `crove_test_member_vy_cmd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users = { owner: '', admin: '', alice: '', bob: '', viewer: '' };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });
  const exec = <T>(who: string, name: string, input: unknown) => runtime.execute<T>(name, input, { actor: asUser(who), orgId });
  const query = <T>(who: string, name: string, input: unknown) => runtime.query<T>(name, input, { actor: asUser(who), orgId });
  const start = (who: string, feature = 'notes.summary') => exec<{ runId: string; resultId: string; expiresAt: string }>(who, 'kernel.member_vy.run.start', { feature, subjectType: 'note', subjectId: randomUUID() });
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
  const runStatus = async (runId: string) => (await sqlAdmin<{ status: string }>('SELECT status FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2', [orgId, runId]))[0]?.status;
  const resetRuns = () => sqlAdmin(`UPDATE crove_kernel.ai_run SET status = 'cancelled', finished_at = now() WHERE org_id = $1 AND status = 'running'`, [orgId]);

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
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'member-vy-cmd', subject: key, email: `${key}@member-vy-cmd.test`, name: null });
    }
    orgId = (await createOrg(runtime, asUser(users.owner), 'Vy lệnh')).orgId;
    await sqlAdmin(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer')`, [orgId, users.admin, users.alice, users.bob, users.viewer]);
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
    const agents = await sqlAdmin(`SELECT id FROM crove_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`, [orgId, users.alice]);
    expect(agents, 'one Vy per member').toHaveLength(1);
    const got = await query<{ status: string; privateRead: boolean; tainted: boolean }>(users.alice, 'kernel.member_vy.result.get', { runId: second.runId });
    expect(got).toMatchObject({ status: 'running', privateRead: true, tainted: true });
    await expect(query(users.bob, 'kernel.member_vy.result.get', { runId: second.runId }), 'another member reading it').rejects.toMatchObject({ code: 'RESULT_NOT_FOUND' });
    await expect(exec(users.alice, 'kernel.member_vy.run.start', { feature: 'finance.invoice_extract', subjectType: 'note', subjectId: randomUUID() }), 'a feature that is not a member-Vy feature').rejects.toThrow();
  });

  it('stores the text through the one command, tainted and private, with nothing of it in the audit trail', async () => {
    await resetRuns();
    const run = await start(users.alice);
    expect(await store(users.alice, run.runId, { status: 'ready', body: SECRET, sourceRevision: 3 })).toEqual({ stored: true, status: 'ready' });
    expect(await runStatus(run.runId)).toBe('succeeded');
    expect(await query(users.alice, 'kernel.member_vy.result.get', { runId: run.runId })).toMatchObject({ status: 'ready', body: SECRET, sourceRevision: 3, privateRead: true, tainted: true });
    expect((await sqlAdmin<{ private_read: boolean }>('SELECT private_read FROM crove_kernel.ai_run WHERE org_id = $1 AND id = $2', [orgId, run.runId]))[0]?.private_read).toBe(true);
    await expect(store(users.alice, run.runId, { status: 'ready', body: 'lần hai' }), 'a second store of the same run').rejects.toMatchObject({ code: 'VY_RUN_NOT_LIVE' });
    // The audit trail, the activity feed and the outbox never carry the text (decision 4).
    for (const table of ['audit_event', 'activity', 'outbox_event']) {
      const rows = await sqlAdmin<{ t: string }>(`SELECT row_to_json(x)::text AS t FROM crove_kernel.${table} x WHERE org_id = $1`, [orgId]);
      expect(rows.filter((r) => r.t.includes('giảm giá')), `${table} holds none of the text`).toEqual([]);
    }
    const audited = await sqlAdmin<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member_vy.result.store'`, [orgId]);
    expect(Number(audited[0]?.n)).toBeGreaterThan(0);
  });

  it('refuses to store another member\'s run, an unknown run and a run that is not live', async () => {
    await resetRuns();
    const run = await start(users.alice);
    await expect(store(users.bob, run.runId, { status: 'ready', body: 'x' })).rejects.toMatchObject({ code: 'VY_RUN_NOT_LIVE' });
    await expect(store(users.alice, randomUUID(), { status: 'ready', body: 'x' })).rejects.toMatchObject({ code: 'VY_RUN_NOT_LIVE' });
    // Triggers off for this one statement: the 4-hour bound (#2856) forbids moving the start of a member_vy run, and an expired run needs both moved (CHECK expires_at > started_at).
    await sqlAdmin(`SET LOCAL session_replication_role = replica; UPDATE crove_kernel.ai_run SET expires_at = now() - interval '1 minute', started_at = now() - interval '1 hour' WHERE org_id = '${orgId}' AND id = '${run.runId}'`);
    await expect(store(users.alice, run.runId, { status: 'ready', body: 'x' }), 'an expired run').rejects.toMatchObject({ code: 'VY_RUN_NOT_LIVE' });
    // A failed run stores a fixed code and no text.
    await resetRuns();
    const failing = await start(users.alice);
    expect(await store(users.alice, failing.runId, { status: 'failed', errorCode: 'MODEL_ERROR' })).toEqual({ stored: false, status: 'failed' });
    expect(await query(users.alice, 'kernel.member_vy.result.get', { runId: failing.runId })).toMatchObject({ status: 'failed', errorCode: 'MODEL_ERROR', body: null });
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
    await sqlAdmin(`UPDATE crove_kernel.ai_run SET status = 'running', finished_at = NULL, error = NULL WHERE org_id = $1 AND id = $2`, [orgId, run.runId]);
    await sqlAdmin(`UPDATE crove_kernel.member_vy_result SET status = 'running', error_code = NULL WHERE org_id = $1 AND run_id = $2`, [orgId, run.runId]);
    expect(await store(users.alice, run.runId, { status: 'ready', body: SECRET })).toEqual({ stored: false, status: 'failed' });
    expect(await query(users.alice, 'kernel.member_vy.result.get', { runId: run.runId })).toMatchObject({ status: 'failed', errorCode: 'AI_STOPPED', body: null });
    await expect(start(users.alice)).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });
    await runtime.execute('kernel.agent.kill_switch.release', { id: moduleSwitch.killSwitchId }, { actor: asMfa(users.owner), orgId });
    // A spent hard-stop budget of the org.
    await sqlAdmin(`INSERT INTO crove_kernel.budget_policy (org_id, scope, target, monthly_limit, warn_percent, hard_stop, updated_by) VALUES ($1, 'org', '*', 0, 80, true, $2)`, [orgId, users.owner]);
    await expect(start(users.alice)).rejects.toMatchObject({ code: 'AI_BUDGET_EXHAUSTED' });
    await sqlAdmin(`DELETE FROM crove_kernel.budget_policy WHERE org_id = $1`, [orgId]);
    await resetRuns();
    expect(await start(users.alice)).toMatchObject({ runId: expect.any(String) });
  });

  it('ends a member\'s live run when they are removed, and purges nothing before the 30 days', async () => {
    await resetRuns();
    const live = await start(users.bob);
    await store(users.bob, live.runId, { status: 'ready', body: 'của Bob' });
    const second = await start(users.bob);
    const rowsOf = async () => (await sqlAdmin<{ n: string }>('SELECT count(*)::text AS n FROM crove_kernel.member_vy_result WHERE org_id = $1 AND member_user_id = $2', [orgId, users.bob]))[0]?.n;
    const before = await rowsOf();
    await runtime.execute('kernel.member.remove', { userId: users.bob }, { actor: asMfa(users.owner), orgId });
    expect(await runStatus(second.runId)).toBe('cancelled');
    expect(await rowsOf(), 'the rows stay for the 30 days').toBe(before);
  });

  it('discards the text of a store that races a cancel, and neither blocks the other for good', async () => {
    await resetRuns();
    const run = await start(users.alice);
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    // A cancel by the owner, held open: it has ended the run and the result and not yet committed.
    const cancel = new pg.Client({ connectionString: url.toString() });
    await cancel.connect();
    try {
      await cancel.query('BEGIN');
      await cancel.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(users.owner, orgId)]);
      const ended = await cancel.query<{ n: string }>(`SELECT crove_kernel.member_vy_runs_cancel(NULL, $1::uuid, NULL, 'TEST') AS n`, [users.alice]);
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
    const own = (await sqlAdmin<{ id: string }>(`SELECT id FROM crove_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id = $2`, [orgId, users.alice]))[0]?.id;
    expect(await query(users.alice, 'kernel.member_vy.meter.check', { feature: 'notes.summary' })).toEqual({ allowed: true });
    expect(await exec(users.alice, 'kernel.member_vy.meter.record', { feature: 'notes.summary', inputTokens: 120, outputTokens: 30, cost: '0.000150' })).toEqual({ recorded: true });
    const usage = await sqlAdmin<{ agent_id: string; module: string; feature: string }>(`SELECT agent_id, module, feature FROM crove_kernel.org_usage WHERE org_id = $1 AND metric = 'ai_cost' AND feature = 'notes.summary'`, [orgId]);
    expect(usage).toEqual([{ agent_id: own, module: 'notes', feature: 'notes.summary' }]);
    // The input has no agent field: one a caller adds is dropped, and the spend still goes to the member's own Vy.
    const other = (await sqlAdmin<{ id: string }>(`SELECT id FROM crove_kernel.agent WHERE org_id = $1 AND kind = 'member_vy' AND member_user_id <> $2 LIMIT 1`, [orgId, users.alice]))[0]?.id ?? randomUUID();
    await exec(users.alice, 'kernel.member_vy.meter.record', { feature: 'notes.summary', inputTokens: 1, outputTokens: 1, cost: '0', agentId: other });
    expect(await sqlAdmin(`SELECT 1 FROM crove_kernel.org_usage WHERE org_id = $1 AND agent_id = $2`, [orgId, other])).toHaveLength(0);
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
});

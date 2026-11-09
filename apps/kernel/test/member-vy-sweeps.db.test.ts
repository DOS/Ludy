// SPDX-License-Identifier: AGPL-3.0-only
// The daily sweeps of a member's private Vy data (ADR-0049 decision 3, #2822): results past their expires_at (every batch of 1,000, not one), and the results
// and memory of a former member after 30 days, independent of Notes. The definers themselves are in member-vy-core.db.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { sweepMemberVyFormerMembers, sweepMemberVyResults } from '../src/member-vy-worker.ts';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('member Vy sweeps (ADR-0049 decision 3, #2822)', () => {
  const dbName = `crove_test_member_vy_sweeps_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let apiRuntime: Runtime;
  let workerRuntime: Runtime;
  let workerDb: ReturnType<typeof createDb>;
  const users = { owner: '', member: '', gone: '', recent: '', old: '' };
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }));
  // The rows of the worker login outside every context, as the sweeps ask for them.
  const asWorker = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) => {
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      return await c.query<T>(text, values);
    } finally {
      await c.end();
    }
  };
  const count = (table: 'member_vy_result' | 'member_vy_memory', user?: string) =>
    admin(async (c) => Number((await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.${table} WHERE org_id = $1${user ? ' AND member_user_id = $2' : ''}`, user ? [orgId, user] : [orgId])).rows[0]?.n));

  // A member's Vy agent, a run, a result (live or expired) and a memory entry, seeded as the superuser with the binding set aside.
  async function seed(userId: string, expired: boolean) {
    await admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      const agentId = randomUUID();
      const runId = randomUUID();
      await c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`, [orgId, agentId, userId]);
      await c.query(`INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at, finished_at) VALUES ($1, $2, $3, 'notes', 'succeeded', true, now() - interval '2 hours', now() - interval '1 hour', now() - interval '90 minutes')`, [orgId, runId, agentId]);
      await c.query(
        `INSERT INTO crove_kernel.member_vy_result (org_id, id, member_user_id, run_id, feature, subject_type, subject_id, status, body, created_at, expires_at)
         VALUES ($1, $2, $3, $4, 'notes.summary', 'note', $5, 'ready', 'Tóm tắt riêng', ${expired ? "now() - interval '30 days', now() - interval '1 day'" : "now(), now() + interval '30 days'"})`,
        [orgId, randomUUID(), userId, runId, randomUUID()],
      );
      await c.query(`INSERT INTO crove_kernel.member_vy_memory (org_id, id, member_user_id, body) VALUES ($1, $2, $3, 'Gọi khách là anh')`, [orgId, randomUUID(), userId]);
    });
  }

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
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    const appPool = createPool({ connectionString: appUrl, max: 4 });
    const workerPool = createPool({ connectionString: workerUrl, max: 4 });
    pools.push(appPool, workerPool);
    const registered = { commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] };
    const appDb = createDb(appPool);
    workerDb = createDb(workerPool);
    apiRuntime = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register(registered);
    workerRuntime = new Runtime(workerDb, { manifests: TEST_MANIFESTS }).register(registered);
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(appDb, { issuer: 'member-vy-sweeps', subject: key, email: `${key}@member-vy-sweeps.test`, name: null });
    }
    orgId = (await createOrg(apiRuntime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Vy dọn')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member'), ($1, $4, 'member')`, [orgId, users.member, users.recent, users.old]));
    // Two members removed through the command: one now, one 31 days ago by the audit trail (append-only, so its trigger is set aside for the statement).
    for (const user of [users.recent, users.old]) await apiRuntime.execute('kernel.member.remove', { userId: user }, { actor: asMfa(users.owner), orgId });
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '31 days' WHERE org_id = $1 AND command = 'kernel.member.remove' AND target_id = $2`, [orgId, users.old]);
      await c.query('COMMIT');
    });
    // The active member (an expired result and a live one is made below), a former member with no removal in the audit trail, the two removed ones.
    await seed(users.member, true);
    await seed(users.gone, false);
    await seed(users.recent, false);
    await seed(users.old, false);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers the lists to the worker login outside every context, and to no other login or context', async () => {
    const asApp = new pg.Client({ connectionString: appUrl });
    await asApp.connect();
    try {
      for (const call of ['SELECT * FROM crove_kernel.member_vy_results_due(10)', 'SELECT * FROM crove_kernel.member_vy_former_members_due(10)']) {
        expect(await outcome(asApp.query(call)), `the app login: ${call}`).toMatchObject({ ok: false, code: '42501' });
      }
    } finally {
      await asApp.end();
    }
    // The worker login inside a system context is refused by the definer itself.
    const c = new pg.Client({ connectionString: workerUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
      for (const call of ['SELECT * FROM crove_kernel.member_vy_results_due(10)', 'SELECT * FROM crove_kernel.member_vy_former_members_due(10)']) {
        await c.query('SAVEPOINT s');
        const refused = await outcome(c.query(call));
        await c.query('ROLLBACK TO SAVEPOINT s');
        expect(refused, `a worker in a system context: ${call}`).toMatchObject({ ok: false, code: '42501', message: expect.stringContaining('MEMBER_VY_WORKER_ONLY') });
      }
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
    expect((await asWorker('SELECT * FROM crove_kernel.member_vy_results_due(10)')).rows, 'the worker outside a context').toEqual([{ org_id: orgId }]);
    expect((await asWorker(`SELECT * FROM crove_kernel.member_vy_results_due(10, '${orgId}'::uuid)`)).rows, 'keyset paging: nothing is due after this org id').toEqual([]);
  });

  it('removes the expired results of an org past the first batch of 1,000, and leaves the live ones and the memory', async () => {
    // 1,500 more expired results (the foreign key to the run is set aside, as for the other seeds), so one batch is not enough.
    await admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      await c.query(
        `INSERT INTO crove_kernel.member_vy_result (org_id, member_user_id, run_id, feature, subject_type, subject_id, status, created_at, expires_at)
         SELECT $1, $2, gen_random_uuid(), 'notes.summary', 'note', gen_random_uuid(), 'running', now() - interval '30 days', now() - interval '1 day' FROM generate_series(1, 1500)`,
        [orgId, users.member],
      );
    });
    const live = await count('member_vy_result', users.gone);
    const memoryBefore = await count('member_vy_memory');
    expect(await count('member_vy_result', users.member), 'the member holds 1,501 expired results').toBe(1501);
    expect(await sweepMemberVyResults({ runtime: workerRuntime, workerDb })).toBe(1501);
    expect(await count('member_vy_result', users.member), 'none of the member left').toBe(0);
    expect(await count('member_vy_result', users.gone), 'a live result stays').toBe(live);
    expect(await count('member_vy_memory'), 'no memory entry is touched by the expiry').toBe(memoryBefore);
    expect((await asWorker('SELECT * FROM crove_kernel.member_vy_results_due(10)')).rows, 'no org is due now').toEqual([]);
    expect(await sweepMemberVyResults({ runtime: workerRuntime, workerDb }), 'a second pass has nothing to do').toBe(0);
  });

  it('lists the former members with whether their removal is recorded, recorded first, and never a member or a removal younger than 30 days', async () => {
    const due = (await asWorker<{ org_id: string; user_id: string; recorded: boolean }>('SELECT * FROM crove_kernel.member_vy_former_members_due(10)')).rows;
    expect(due, 'a recorded removal older than 30 days first, then one with no removal in the audit trail').toEqual([
      { org_id: orgId, user_id: users.old, recorded: true },
      { org_id: orgId, user_id: users.gone, recorded: false },
    ]);
  });

  it('purges a recorded former member and keeps the rest: a member, a removal younger than 30 days, and a membership that ended with no recorded removal', async () => {
    const rowsOf = async (user: string) => (await count('member_vy_result', user)) + (await count('member_vy_memory', user));
    const before = { old: await rowsOf(users.old), gone: await rowsOf(users.gone), recent: await rowsOf(users.recent), member: await rowsOf(users.member) };
    expect(before.old, 'a result and a memory entry').toBe(2);
    expect(await sweepMemberVyFormerMembers({ runtime: workerRuntime, workerDb }), 'what the pass removed').toBe(before.old);
    expect(await rowsOf(users.old), 'the recorded former member is purged').toBe(0);
    expect(await rowsOf(users.gone), 'no recorded removal: kept').toBe(before.gone);
    expect(await rowsOf(users.recent), 'removed less than 30 days ago: kept').toBe(before.recent);
    expect(await rowsOf(users.member), 'a member: kept').toBe(before.member);
    expect(await sweepMemberVyFormerMembers({ runtime: workerRuntime, workerDb }), 'a second pass has nothing to do').toBe(0);
    // The purge itself, asked for a member, answers nothing: the definer refuses it.
    const memberPurge = await workerRuntime.execute<{ removed: number }>('kernel.vy_data.member_data.purge', { userId: users.member }, { actor: { type: 'system', component: 'kernel.member_vy' }, orgId });
    expect(memberPurge.removed, 'a member is never purged').toBe(0);
    expect(await rowsOf(users.member), 'the member still holds their rows').toBe(before.member);
  });

  it('maps no RPC route to the sweep commands (the router names each command it exposes)', () => {
    const router = readFileSync(fileURLToPath(new URL('../src/rpc.ts', import.meta.url)), 'utf8');
    expect(router.includes('kernel.vy_data.'), 'apps/kernel/src/rpc.ts names a kernel.vy_data command').toBe(false);
  });

  it('refuses the sweep commands to a user and to an input with extra keys', async () => {
    await expect(apiRuntime.execute('kernel.vy_data.results.expire', {}, { actor: asMfa(users.owner), orgId })).rejects.toBeDefined();
    await expect(apiRuntime.execute('kernel.vy_data.member_data.purge', { userId: users.old }, { actor: asMfa(users.owner), orgId })).rejects.toBeDefined();
    await expect(workerRuntime.execute('kernel.vy_data.results.expire', { orgId }, { actor: { type: 'system', component: 'kernel.member_vy' }, orgId })).rejects.toBeDefined();
  });
});

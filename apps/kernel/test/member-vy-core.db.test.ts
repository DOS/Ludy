// SPDX-License-Identifier: AGPL-3.0-only
// The database core of Vy working for one member (ADR-0049 stage A slice 1, issue #2755): the expiry and the removal
// purge of a member's results and memory, the counts an owner sees before removing a member, and the template that no
// owner installs into the chart. The invariants of who reads what are in test/invariant/member-vy-private.db.test.ts.
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

suite('member Vy database core (ADR-0049 stage A slice 1)', () => {
  const dbName = `crove_test_member_vy_core_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let runtime: Runtime;
  const users = { owner: '', admin: '', member: '', gone: '', recent: '', old: '' };
  const agents: Record<string, string> = { member: '', gone: '' };
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
  // Runs fn as a login role in a context, rolled back at the end.
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const asUser = (userId: string) => (c: pg.Client) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
  const asSystem = (c: pg.Client) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]);
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { message: string }) => ({ ok: false as const, message: error.message }));

  // A member's Vy agent, a run and a result and a memory entry, seeded as the superuser with the binding set aside.
  async function seed(userId: string, key: string, expired: boolean) {
    await admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      const agentId = randomUUID();
      const runId = randomUUID();
      agents[key] = agentId;
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
  const rows = (table: string) => admin(async (c) => (await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM crove_kernel.${table}`)).rows[0]?.n);

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
    const pool = createPool({ connectionString: appUrl, max: 4 });
    pools.push(pool);
    const db = createDb(pool);
    runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' })] });
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(db, { issuer: 'member-vy-core', subject: key, email: `${key}@member-vy-core.test`, name: null });
    }
    orgId = (await createOrg(runtime, { type: 'user', userId: users.owner, aal: 'aal1' }, 'Vy lõi')).orgId;
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')`, [orgId, users.admin, users.member]));
    await seed(users.member, 'member', true);
    // A former member: no tenant_member row.
    await seed(users.gone, 'gone', false);
    // Two members removed through the command: one now, one 31 days ago by the audit trail.
    await admin((c) => c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, users.recent, users.old]));
    for (const user of [users.recent, users.old]) await runtime.execute('kernel.member.remove', { userId: user }, { actor: asMfa(users.owner), orgId });
    // The audit trail is append-only, so its trigger is set aside for this statement.
    await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE crove_kernel.audit_event SET occurred_at = occurred_at - interval '31 days' WHERE org_id = $1 AND command = 'kernel.member.remove' AND target_id = $2`, [orgId, users.old]);
      await c.query('COMMIT');
    });
    await seed(users.recent, 'recent', false);
    await seed(users.old, 'old', false);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('counts results and memory per member for an owner or admin, ids and numbers only, and refuses a member', async () => {
    for (const who of [users.owner, users.admin]) {
      const out = await inContext(appUrl, asUser(who), (c) => c.query('SELECT * FROM crove_kernel.member_vy_private_counts()'));
      expect(out.rows.map((r) => [r.member_user_id, r.results, r.memories]).sort()).toEqual(
        [[users.gone, '1', '1'], [users.member, '1', '1'], [users.recent, '1', '1'], [users.old, '1', '1']].sort(),
      );
      expect(Object.keys(out.fields.reduce((o, f) => ({ ...o, [f.name]: 1 }), {}))).toEqual(['org_id', 'member_user_id', 'results', 'memories']);
    }
    const refused = await outcome(inContext(appUrl, asUser(users.member), (c) => c.query('SELECT * FROM crove_kernel.member_vy_private_counts()')));
    expect(refused.ok, 'a plain member asking for the counts').toBe(false);
  });

  it('lets only the worker in the system context expire results, and removes the expired ones alone', async () => {
    for (const [url, enter, name] of [
      [appUrl, asUser(users.owner), 'the API login in a user context'],
      [workerUrl, asUser(users.owner), 'the worker in a user context'],
    ] as const) {
      const refused = await outcome(inContext(url, enter, (c) => c.query('SELECT crove_kernel.member_vy_results_expire(100)')));
      expect(refused.ok, name).toBe(false);
    }
    const expired = await inContext(workerUrl, asSystem, async (c) => {
      const out = await c.query<{ n: string }>('SELECT crove_kernel.member_vy_results_expire(100) AS n');
      await c.query('COMMIT');
      return out.rows[0]?.n;
    });
    expect(expired).toBe('1');
    expect(await rows('member_vy_result'), 'the expired one is gone, the other three stay').toBe('3');
  });

  it('purges a former member\'s results and memory at once, and nothing of a member who is back', async () => {
    const wrongOrg = await outcome(inContext(workerUrl, asSystem, (c) => c.query('SELECT crove_kernel.member_vy_member_data_purge($1::uuid, $2::uuid)', [randomUUID(), users.gone])));
    expect(wrongOrg.ok, 'another org id').toBe(false);
    const present = await inContext(workerUrl, asSystem, (c) => c.query<{ n: string }>('SELECT crove_kernel.member_vy_member_data_purge($1::uuid, $2::uuid) AS n', [orgId, users.member]));
    expect(present.rows[0]?.n, 'a member who is still in the org').toBe('0');
    const purged = await inContext(workerUrl, asSystem, async (c) => {
      const out = await c.query<{ n: string }>('SELECT crove_kernel.member_vy_member_data_purge($1::uuid, $2::uuid) AS n', [orgId, users.gone]);
      await c.query('COMMIT');
      return out.rows[0]?.n;
    });
    expect(purged).toBe('2');
    // The audit trail's 30 days: a member removed now keeps everything, one removed 31 days ago loses it.
    const purgeOf = (user: string) =>
      inContext(workerUrl, asSystem, async (c) => {
        const out = await c.query<{ n: string }>('SELECT crove_kernel.member_vy_member_data_purge($1::uuid, $2::uuid) AS n', [orgId, user]);
        await c.query('COMMIT');
        return out.rows[0]?.n;
      });
    expect(await purgeOf(users.recent), 'removed less than 30 days ago').toBe('0');
    expect(await purgeOf(users.old), 'removed 31 days ago').toBe('2');
  });

  it('holds the membership lock until the purge ends, so a re-add waits or is seen', async () => {
    const holder = new pg.Client({ connectionString: workerUrl });
    await holder.connect();
    const other = new pg.Client({ connectionString: adminUrl });
    await other.connect();
    try {
      await holder.query('BEGIN');
      await asSystem(holder);
      await holder.query('SELECT crove_kernel.member_vy_member_data_purge($1::uuid, $2::uuid)', [orgId, users.gone]);
      await other.query(`SET lock_timeout = '500ms'`);
      const waited = await outcome(other.query('SELECT crove_kernel.membership_lock($1::uuid, $2::uuid)', [orgId, users.gone]));
      expect(waited, 'a re-add taking the membership lock while the purge runs').toMatchObject({ ok: false });
      expect(waited.ok ? '' : waited.message).toMatch(/lock timeout/);
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
      await other.end();
    }
  });

  it('never installs the template of a member\'s own Vy into the chart', async () => {
    const out = await outcome(runtime.execute('kernel.agent.template.install', { templateKey: 'kernel.member_vy', reportsTo: null }, { actor: { type: 'user', userId: users.owner, aal: 'aal2', sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) }, orgId }));
    expect(out.ok).toBe(false);
    expect(out.ok ? '' : out.message).toMatch(/TEMPLATE_NOT_FOUND|Không có mẫu/);
  });

  it('never moves a run to another agent, and answers agent_member_of for the context\'s org only', async () => {
    const moved = await outcome(admin((c) => c.query('UPDATE crove_kernel.ai_run SET agent_id = $2 WHERE org_id = $1 AND agent_id = $3', [orgId, agents.gone, agents.member])));
    expect(moved.ok, 'a run moved to another agent').toBe(false);
    const own = await inContext(appUrl, asUser(users.owner), (c) => c.query<{ m: string | null }>('SELECT crove_kernel.agent_member_of($1::uuid, $2::uuid) AS m', [orgId, agents.member]));
    expect(own.rows[0]?.m).toBe(users.member);
    const foreign = await inContext(appUrl, asUser(users.owner), (c) => c.query<{ m: string | null }>('SELECT crove_kernel.agent_member_of($1::uuid, $2::uuid) AS m', [randomUUID(), agents.member]));
    expect(foreign.rows[0]?.m, 'another org id').toBeNull();
  });
});

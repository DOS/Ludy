// SPDX-License-Identifier: AGPL-3.0-only
// The member-scoped background context (ADR-0049 stage B, #2756): what the entry refuses beyond the invariant suite's cases
// (kill switches, a spent budget), the seal it writes (R1 at most, the member's role and entity scope, no position), and that
// no stream hint carries a member's Vy run or result. The invariant suite holds the binding and write cases.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('member-scoped background context', () => {
  const dbName = `crove_test_member_vy_ctx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let owner = '';
  let member = '';
  let limited = '';
  let branch = '';
  const vy: Record<string, { agentId: string; runId: string }> = {};

  async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }
  async function inContext<T>(url: string, enter: (c: pg.Client) => Promise<unknown>, fn: (c: pg.Client) => Promise<T>, commit = false): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
      await c.query('BEGIN');
      await enter(c);
      const out = await fn(c);
      if (commit) await c.query('COMMIT');
      return out;
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.end();
    }
  }
  const enter = (who: string) =>
    inContext(workerUrl, (c) => c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, vy[who]?.agentId, vy[who]?.runId]), async (c) =>
      JSON.parse((await c.query<{ ctx: string }>(`SELECT current_setting('crove.ctx') AS ctx`)).rows[0]?.ctx as string) as Record<string, unknown>,
    );
  const refusal = (who: string) => enter(who).then(() => 'entered', (e: { message: string }) => e.message);

  async function makeVy(user: string): Promise<{ agentId: string; runId: string }> {
    return inContext(
      appUrl,
      (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(user, orgId)]),
      async (c) => {
        const agentId = randomUUID();
        const runId = randomUUID();
        await c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`, [orgId, agentId, user]);
        await c.query(`INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, feature, status, tainted, started_at, expires_at) VALUES ($1, $2, $3, 'notes', 'notes.summary', 'running', true, now(), now() + interval '30 minutes')`, [orgId, runId, agentId]);
        return { agentId, runId };
      },
      true,
    );
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
    const pool = createPool({ connectionString: appUrl, max: 2 });
    pools.push(pool);
    const db = createDb(pool);
    const runtime = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [] });
    owner = await upsertIdentity(db, { issuer: 'member-vy-ctx', subject: 'owner', email: 'owner@member-vy-ctx.test', name: null });
    member = await upsertIdentity(db, { issuer: 'member-vy-ctx', subject: 'member', email: 'member@member-vy-ctx.test', name: null });
    limited = await upsertIdentity(db, { issuer: 'member-vy-ctx', subject: 'limited', email: 'limited@member-vy-ctx.test', name: null });
    orgId = (await createOrg(runtime, { type: 'user', userId: owner, aal: 'aal1' }, 'Vy nền')).orgId;
    await admin(async (c) => {
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner])).rows[0]?.id as string;
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [orgId, member, limited]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [orgId, limited, branch, owner]);
    });
    vy.member = await makeVy(member);
    vy.limited = await makeVy(limited);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('seals the member, R1 at most, no position, and the member\'s own entity scope', async () => {
    const whole = await enter('member');
    expect(whole).toMatchObject({ actor: 'agent', user: null, kind: 'member_vy', member, agent: vy.member?.agentId, run: vy.member?.runId, position: null, role: 'member', le_scope: ['*'], flags: [] });
    expect(['R0', 'R1']).toContain(whole.max_risk);
    // An entity-limited member's Vy sees only those entities.
    const scoped = await enter('limited');
    expect(scoped).toMatchObject({ kind: 'member_vy', member: limited, le_scope: [branch] });
  });

  it('refuses the entry under an org, module or agent kill switch and under the operator\'s global switch, and enters again once released', async () => {
    const engage = (scope: string, target: string) =>
      admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_kernel.kill_switch (org_id, scope, target, engaged_by) VALUES ($1, $2, $3, $4) RETURNING id`, [orgId, scope, target, owner])).rows[0]?.id as string);
    const release = (id: string) => admin((c) => c.query(`UPDATE crove_kernel.kill_switch SET released_at = now(), released_by = $2 WHERE org_id = $1 AND id = $3`, [orgId, owner, id]));
    for (const [scope, target] of [['org', '*'], ['module', 'notes'], ['agent', vy.member?.agentId as string]] as const) {
      const id = await engage(scope, target);
      expect(await refusal('member'), `a ${scope} kill switch`).toMatch(/KILL_SWITCH_ON/);
      await release(id);
      expect(await refusal('member'), `after releasing the ${scope} switch`).toBe('entered');
    }
    // A switch for another module or another agent stops nothing.
    const other = await engage('module', 'finance');
    expect(await refusal('member'), 'a switch for another module').toBe('entered');
    await release(other);
  });

  it('refuses the entry once a hard-stop budget is spent', async () => {
    const id = await admin(async (c) => (await c.query<{ id: string }>(`INSERT INTO crove_kernel.budget_policy (org_id, scope, target, monthly_limit, updated_by) VALUES ($1, 'org', '*', 0, $2) RETURNING id`, [orgId, owner])).rows[0]?.id as string);
    try {
      expect(await refusal('member')).toMatch(/BUDGET_EXHAUSTED/);
    } finally {
      await admin((c) => c.query(`DELETE FROM crove_kernel.budget_policy WHERE org_id = $1 AND id = $2`, [orgId, id]));
    }
    expect(await refusal('member')).toBe('entered');
  });

  it('sends no stream hint for a Vy run, a result or a memory', async () => {
    const { rows } = await admin((c) =>
      c.query<{ t: string }>(
        `SELECT t.tgrelid::regclass::text AS t FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
         WHERE NOT t.tgisinternal AND p.proname = 'stream_notify' AND t.tgrelid::regclass::text IN ('crove_kernel.ai_run', 'crove_kernel.member_vy_result', 'crove_kernel.member_vy_memory', 'crove_kernel.agent')`,
      ),
    );
    // A hint for these tables would have to name the member as its recipient, as the notes hints do; none exists, so none leaks.
    expect(rows.map((r) => r.t)).toEqual([]);
  });
});

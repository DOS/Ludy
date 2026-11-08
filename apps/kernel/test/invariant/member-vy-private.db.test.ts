// SPDX-License-Identifier: AGPL-3.0-only
// Vy working for one member, stage A step (a) (ADR-0049 decision 7, issue #2754): what a member's results and memory,
// the member's own Vy agent, its runs and the permission vy.use must hold from the day they exist. Every table, column
// and function that stage A adds is looked up first and its cases run only when it exists, so this file passes on a
// database that has none of them (no it.skip: the invariant job fails on a skipped test) and pins the behavior the
// feature PR must meet. The negative cases hold unconditionally: no member-mode context can be entered before stage B,
// and an org-chart agent context never reads or writes what belongs to a member. Part of the invariant suite; it
// imports package code under test, never helpers from outside test/invariant/. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, upsertIdentity, kernelQueries } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const SYSTEM = { type: 'system' as const, component: 'kernel.agent' };
const suite = ADMIN ? describe : describe.skip;
// The text a member's private note and Vy's answer to it must never reach anyone else with.
const SECRET = 'Tóm tắt riêng: khách đề nghị giảm giá 12%';
// The department roles that grant vy.use (ADR-0049 decision 10) and the one that does not.
const VY_ROLES = ['finance.chief_accountant', 'finance.accountant', 'external_accountant', 'crm.sales', 'desk.agent', 'hr.manager'];

suite('Vy working for one member, stage A invariants (ADR-0049, #2754)', () => {
  const dbName = `crove_test_member_vy_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let branch = '';
  const users = { owner: '', admin: '', author: '', member: '', viewer: '', limited: '' };
  let agent = { agentId: '', runId: '' };
  // What the database has of stage A, looked up once in beforeAll.
  const has = { results: false, memory: false, override: false, kind: false, permission: false, memberEntry: false };
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
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

  interface Actor {
    name: string;
    url: () => string;
    enter: (c: pg.Client) => Promise<unknown>;
  }
  // Runs fn as a login role in a context, rolled back unless commit is set.
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
  const member = (name: string, userId: () => string): Actor => ({
    name,
    url: () => appUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId(), orgId)]),
  });
  const system: Actor = { name: 'the system context', url: () => workerUrl, enter: (c) => c.query('SELECT crove_kernel.enter_system_context($1::uuid)', [orgId]) };
  const agentActor: Actor = {
    name: 'an org-chart agent context',
    url: () => workerUrl,
    enter: (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId]),
  };
  const author = member('the member', () => users.author);
  // Everyone but the member whose Vy it is.
  const others: Actor[] = [
    member('another member', () => users.member),
    member('an owner', () => users.owner),
    member('an admin', () => users.admin),
    member('a viewer', () => users.viewer),
    member('a member limited to a branch', () => users.limited),
    agentActor,
    system,
  ];
  const run = <T>(actor: Actor, fn: (c: pg.Client) => Promise<T>) => inContext(actor.url(), actor.enter, fn);
  const outcome = <T>(p: Promise<T>) => p.then((value) => ({ ok: true as const, value }), (error: { code?: string; message: string }) => ({ ok: false as const, code: error.code ?? '', message: error.message }));
  const permitted = async (user: string, permission: string) =>
    (await admin((c) => c.query<{ ok: boolean }>('SELECT crove_kernel.member_has_permission($1::uuid, $2::uuid, $3::text) AS ok', [orgId, user, permission]))).rows[0]?.ok;

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
    const runtimeFor = (url: string) => {
      const pool = createPool({ connectionString: url, max: 4 });
      pools.push(pool);
      const db = createDb(pool);
      return { db, runtime: new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: 'in.test' }), ...financeQueries] }) };
    };
    const api = runtimeFor(appUrl);
    const worker = runtimeFor(workerUrl).runtime;
    for (const key of Object.keys(users) as Array<keyof typeof users>) {
      users[key] = await upsertIdentity(api.db, { issuer: 'member-vy', subject: key, email: `${key}@member-vy.test`, name: null });
    }
    orgId = (await createOrg(api.runtime, asUser(users.owner), 'Vy riêng')).orgId;
    await admin(async (c) => {
      branch = (await c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, users.owner]))
        .rows[0]?.id as string;
      await c.query(
        `INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'member'), ($1, $5, 'viewer'), ($1, $6, 'member')`,
        [orgId, users.admin, users.author, users.member, users.viewer, users.limited],
      );
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [
        orgId,
        users.limited,
        branch,
        users.owner,
      ]);
      const found = await c.query<{ r: string; w: boolean }>(`
        SELECT 'results' AS r, to_regclass('crove_kernel.member_vy_result') IS NOT NULL AS w
        UNION ALL SELECT 'memory', to_regclass('crove_kernel.member_vy_memory') IS NOT NULL
        UNION ALL SELECT 'override', to_regclass('crove_kernel.member_permission_override') IS NOT NULL
        UNION ALL SELECT 'kind', EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'crove_kernel.agent'::regclass AND attname = 'kind' AND NOT attisdropped)
        UNION ALL SELECT 'permission', to_regprocedure('crove_kernel.member_has_permission(uuid,uuid,text)') IS NOT NULL
        UNION ALL SELECT 'memberEntry', to_regprocedure('crove_kernel.enter_member_vy_context(uuid,uuid,uuid)') IS NOT NULL`);
      for (const row of found.rows) has[row.r as keyof typeof has] = row.w;
    });
    const installed = await api.runtime.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: asMfa(users.owner), orgId },
    );
    await api.runtime.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: installed.positionId }, { actor: asUser(users.owner), orgId });
    const started = await worker.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId: installed.agentId }, { actor: SYSTEM, orgId });
    agent = { agentId: installed.agentId, runId: started.runId as string };
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // Unconditional: before stage B no member-mode context exists, and from then on only the worker login enters it.
  it('has no member-mode context before stage B, and only the worker enters it after', async () => {
    const { rows } = await admin((c) => c.query<{ n: string }>(`SELECT p.oid::regprocedure::text AS n FROM pg_proc p WHERE p.pronamespace = 'crove_kernel'::regnamespace AND p.proname LIKE 'enter\\_member\\_vy%'`));
    expect(rows.map((r) => r.n), 'enter_member_vy_context arrives with stage B, with its own invariant step first').toEqual(has.memberEntry ? ['crove_kernel.enter_member_vy_context(uuid,uuid,uuid)'] : []);
    if (!has.memberEntry) return;
    // The same ids that a worker would pass: the API login, the system and an org-chart agent context all refuse them.
    for (const actor of [author, ...others.filter((o) => o !== system)]) {
      const entered = await outcome(run(actor, (c) => c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId])));
      expect(entered.ok, `${actor.name} entering a member-mode context`).toBe(false);
    }
    // An org-chart agent is refused by it: it is no member's Vy.
    const refused = await outcome(inContext(workerUrl, async () => {}, (c) => c.query('SELECT crove_kernel.enter_member_vy_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agent.agentId, agent.runId])));
    expect(refused.ok, 'a worker entering a member-mode context for an org-chart agent').toBe(false);
  });

  it('keeps every member-mode function pinned and out of PUBLIC reach', async () => {
    // Every function named for member Vy, and every SECURITY DEFINER anywhere whose body reads the member-keyed tables.
    const { rows } = await admin((c) =>
      c.query<{ fn: string; definer: boolean; config: string[] | null; public_exec: boolean; tenant_exec: boolean }>(
        `SELECT p.oid::regprocedure::text AS fn, p.prosecdef AS definer, p.proconfig AS config,
                has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec,
                has_function_privilege('crove_tenant', p.oid, 'EXECUTE') AS tenant_exec
         FROM pg_proc p
         WHERE p.proname LIKE '%member\\_vy%' OR p.proname = 'member_has_permission'
            OR (p.prosecdef AND p.prosrc ~ 'member_vy_(result|memory)')`,
      ),
    );
    // The permission function has one signature, so the guarded cases below cannot go quiet on a renamed one; override and permission arrive together.
    const permFns = rows.filter((f) => f.fn.startsWith('crove_kernel.member_has_permission(')).map((f) => f.fn);
    expect(permFns, 'member_has_permission has exactly the signature the cases call').toEqual(has.permission ? ['crove_kernel.member_has_permission(uuid,uuid,text)'] : []);
    expect(has.permission, 'member_has_permission and member_permission_override arrive together').toBe(has.override);
    for (const f of rows) {
      // A function that decides who holds a permission is no definer once the tenant role may call it: it would answer for any org.
      if (f.fn.startsWith('crove_kernel.member_has_permission(') && f.tenant_exec) expect(f.definer, `${f.fn} is executable by the tenant role, so it is not a SECURITY DEFINER`).toBe(false);
      expect(f.config, `${f.fn} sets search_path to pg_catalog, pg_temp`).toContain('search_path=pg_catalog, pg_temp');
      expect(f.public_exec, `${f.fn} is not executable by PUBLIC`).toBe(false);
      // A definer that touches member text is never callable by the tenant role (the worker login reaches it in the system context), except the permission reader and the counts (an owner or admin's removal warning: ids and numbers, never text).
      if (f.definer && !/member_vy_private_counts/.test(f.fn)) expect(f.tenant_exec, `${f.fn} is not executable by the tenant role`).toBe(false);
    }
  });

  // From here on, only what exists: the member's rows. Seeded as the superuser (RLS and the binding triggers are set aside for the setup).
  describe('the member-keyed tables', () => {
    const ids = { result: randomUUID(), memory: randomUUID(), subject: randomUUID() };
    beforeAll(async () => {
      if (!has.results || !has.memory) return;
      await admin(async (c) => {
        // The run behind the result is the member's own Vy run when the agent kind exists (seeded with the binding triggers set aside), an org-chart agent's before.
        let agentId = agent.agentId;
        if (has.kind) {
          await c.query('SET session_replication_role = replica');
          agentId = randomUUID();
          await c.query(
            `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
            [orgId, agentId, users.author],
          );
        }
        await c.query(
          `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at, finished_at)
           VALUES ($1, $2, $3, 'notes', 'succeeded', true, now() - interval '10 minutes', now() - interval '5 minutes', now() - interval '6 minutes')`,
          [orgId, ids.subject, agentId],
        );
        await c.query('SET session_replication_role = DEFAULT');
        await c.query(
          `INSERT INTO crove_kernel.member_vy_result (org_id, id, member_user_id, run_id, feature, subject_type, subject_id, status, body, tainted, private_read, expires_at)
           VALUES ($1, $2, $3, $4, 'notes.summary', 'note', $5, 'ready', $6, true, true, now() + interval '30 days')`,
          [orgId, ids.result, users.author, ids.subject, randomUUID(), SECRET],
        );
        await c.query(`INSERT INTO crove_kernel.member_vy_memory (org_id, id, member_user_id, body) VALUES ($1, $2, $3, 'Tóm tắt ngắn')`, [orgId, ids.memory, users.author]);
      });
    });

    it('shows the member their own result and memory', async () => {
      if (!has.results || !has.memory) return;
      const seen = await run(author, async (c) => ({
        results: (await c.query<{ id: string }>('SELECT id FROM crove_kernel.member_vy_result')).rows.map((r) => r.id),
        memory: (await c.query<{ id: string }>('SELECT id FROM crove_kernel.member_vy_memory')).rows.map((r) => r.id),
      }));
      expect(seen).toEqual({ results: [ids.result], memory: [ids.memory] });
    });

    it('lets no other member, owner, admin, viewer, entity-limited member, org-chart agent or the system read a result or a memory', async () => {
      if (!has.results || !has.memory) return;
      for (const actor of others) {
        const seen = await run(actor, async (c) => ({
          results: (await c.query('SELECT id FROM crove_kernel.member_vy_result')).rowCount,
          byId: (await c.query('SELECT body FROM crove_kernel.member_vy_result WHERE id = $1', [ids.result])).rowCount,
          memory: (await c.query('SELECT id FROM crove_kernel.member_vy_memory')).rowCount,
          memoryById: (await c.query('SELECT body FROM crove_kernel.member_vy_memory WHERE id = $1', [ids.memory])).rowCount,
        }));
        expect(seen, `${actor.name}'s reads`).toEqual({ results: 0, byId: 0, memory: 0, memoryById: 0 });
      }
    });

    it('lets no one else change, delete or write a row for the member', async () => {
      if (!has.results || !has.memory) return;
      for (const actor of others) {
        const changes = await run(actor, async (c) => {
          const update = await outcome(c.query(`UPDATE crove_kernel.member_vy_result SET body = 'đổi' WHERE id = $1`, [ids.result]));
          await c.query('ROLLBACK');
          await c.query('BEGIN');
          await actor.enter(c);
          const remove = await outcome(c.query('DELETE FROM crove_kernel.member_vy_memory WHERE id = $1', [ids.memory]));
          await c.query('ROLLBACK');
          await c.query('BEGIN');
          await actor.enter(c);
          const insert = await outcome(
            c.query(`INSERT INTO crove_kernel.member_vy_memory (org_id, id, member_user_id, body) VALUES ($1, $2, $3, 'Ghi hộ người khác')`, [orgId, randomUUID(), users.author]),
          );
          return { update, remove, insert };
        });
        // An update or a delete sees no row; an insert for another member's name is refused (privilege or policy), never accepted.
        const touched = (r: { ok: boolean; value?: unknown }) => (r.ok ? ((r.value as pg.QueryResult).rowCount ?? 0) : 0);
        expect(touched(changes.update), `${actor.name} updating the result`).toBe(0);
        expect(touched(changes.remove), `${actor.name} deleting the memory`).toBe(0);
        expect(changes.insert, `${actor.name} writing a memory for the member`).toMatchObject({ ok: false, code: '42501' });
      }
      // Positive control: the member writes their own memory in the same shape, so the refusals above are about who writes, not the shape.
      const own = await outcome(
        run(author, (c) => c.query(`INSERT INTO crove_kernel.member_vy_memory (org_id, id, member_user_id, body) VALUES ($1, $2, $3, 'Gọi khách là anh')`, [orgId, randomUUID(), users.author])),
      );
      expect(own.ok, 'the member writing their own memory').toBe(true);
      const kept = await admin((c) => c.query('SELECT id FROM crove_kernel.member_vy_memory WHERE id = $1', [ids.memory]));
      expect(kept.rowCount, 'the memory is untouched').toBe(1);
      const after = await admin((c) => c.query<{ body: string }>('SELECT body FROM crove_kernel.member_vy_result WHERE id = $1', [ids.result]));
      expect(after.rows[0]?.body, 'the result is untouched').toBe(SECRET);
    });
  });

  // private_read goes from false to true and never back, on the result and on the run (ADR-0049 decision 4 and ruling 3).
  describe('the private-read flag', () => {
    it('is never cleared by the member, and false to true is allowed', async () => {
      if (!has.results) return;
      const rid = randomUUID();
      await admin(async (c) => {
        await c.query('SET session_replication_role = replica');
        const runId = randomUUID();
        const agentId = randomUUID();
        if (has.kind) {
          await c.query(
            `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`,
            [orgId, agentId, users.limited],
          );
        }
        await c.query(
          `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at, finished_at)
           VALUES ($1, $2, $3, 'notes', 'succeeded', true, now() - interval '10 minutes', now() - interval '5 minutes', now() - interval '6 minutes')`,
          [orgId, runId, has.kind ? agentId : agent.agentId],
        );
        await c.query(
          `INSERT INTO crove_kernel.member_vy_result (org_id, id, member_user_id, run_id, feature, subject_type, subject_id, status, body, tainted, private_read, expires_at)
           VALUES ($1, $2, $3, $4, 'notes.summary', 'note', $5, 'ready', 'Ghi chú', true, false, now() + interval '30 days')`,
          [orgId, rid, users.limited, runId, randomUUID()],
        );
        await c.query('SET session_replication_role = DEFAULT');
      });
      const limited = member('a member limited to a branch', () => users.limited);
      const raise = await outcome(run(limited, (c) => c.query('UPDATE crove_kernel.member_vy_result SET private_read = true WHERE id = $1', [rid])));
      expect(raise.ok, 'the member raising the flag (positive control)').toBe(true);
      const result = await outcome(
        inContext(limited.url(), limited.enter, async (c) => {
          await c.query('UPDATE crove_kernel.member_vy_result SET private_read = true WHERE id = $1', [rid]);
          const clear = await outcome(c.query('UPDATE crove_kernel.member_vy_result SET private_read = false WHERE id = $1', [rid]));
          return clear;
        }),
      );
      expect(result.ok && result.value.ok, 'the member clearing the flag').toBe(false);
      // The run's own flag, when the column exists: the trigger holds for any writer.
      const column = await admin((c) => c.query(`SELECT 1 FROM pg_attribute WHERE attrelid = 'crove_kernel.ai_run'::regclass AND attname = 'private_read' AND NOT attisdropped`));
      if (column.rowCount) {
        const cleared = await admin(async (c) => {
          await c.query('UPDATE crove_kernel.ai_run SET private_read = true WHERE org_id = $1 AND id = $2', [orgId, agent.runId]);
          return outcome(c.query('UPDATE crove_kernel.ai_run SET private_read = false WHERE org_id = $1 AND id = $2', [orgId, agent.runId]));
        });
        expect(cleared.ok, 'anyone clearing the flag of a run').toBe(false);
      }
    });
  });

  describe('the member_vy agent and its runs', () => {
    // A member's own agent, inserted in their own user context and committed, so the worker login can be asked to enter it.
    const insertAgent = (actor: Actor, memberUser: string, template = 'kernel.member_vy') =>
      outcome(
        inContext(
          actor.url(),
          actor.enter,
          (c) =>
            c.query(
              `INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, $3, 'Vy', 'member_vy', $4, $5) RETURNING id`,
              [orgId, randomUUID(), template, memberUser, memberUser],
            ),
          false,
        ),
      );

    it('inserts a member_vy agent only for the member in their own context, with the fixed template', async () => {
      if (!has.kind) return;
      expect((await insertAgent(author, users.author)).ok, 'the member for themselves').toBe(true);
      for (const actor of [member('another member', () => users.member), member('an owner', () => users.owner), member('an admin', () => users.admin)]) {
        expect((await insertAgent(actor, users.author)).ok, `${actor.name} making the member's Vy`).toBe(false);
      }
      expect((await insertAgent(author, users.member)).ok, 'the member naming another member').toBe(false);
      expect((await insertAgent(author, users.author, 'finance.chief_accountant')).ok, 'an org-chart template').toBe(false);
      for (const actor of [agentActor, system]) {
        expect((await insertAgent(actor, users.author)).ok, `${actor.name} making a member's Vy`).toBe(false);
      }
    });

    it('never turns an org-chart agent into a member_vy one, or the reverse, and keeps one per member', async () => {
      if (!has.kind) return;
      const retag = await outcome(admin((c) => c.query(`UPDATE crove_kernel.agent SET kind = 'member_vy', member_user_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, agent.agentId, users.author])));
      expect(retag.ok, 'an org-chart agent turned into a member_vy one').toBe(false);
      // kind and member_user_id never change after insert; one agent per (org, member): committed in the member's own context.
      const committed = await outcome(
        inContext(
          author.url(),
          author.enter,
          async (c) => {
            const id = randomUUID();
            await c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`, [orgId, id, users.author]);
            const second = await outcome(
              c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy hai', 'member_vy', $3, $3)`, [orgId, randomUUID(), users.author]),
            );
            await c.query('ROLLBACK');
            await c.query('BEGIN');
            await author.enter(c);
            await c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`, [orgId, id, users.author]);
            const flip = await outcome(c.query(`UPDATE crove_kernel.agent SET kind = 'org_chart' WHERE org_id = $1 AND id = $2`, [orgId, id]));
            await c.query('ROLLBACK');
            await c.query('BEGIN');
            await author.enter(c);
            await c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`, [orgId, id, users.author]);
            const move = await outcome(c.query(`UPDATE crove_kernel.agent SET member_user_id = $3 WHERE org_id = $1 AND id = $2`, [orgId, id, users.member]));
            return { second, flip, move };
          },
          false,
        ),
      );
      expect(committed.ok).toBe(true);
      if (!committed.ok) return;
      expect(committed.value.second.ok, 'a second Vy for the same member').toBe(false);
      expect(committed.value.flip.ok, 'changing kind after insert').toBe(false);
      expect(committed.value.move.ok, 'changing member_user_id after insert').toBe(false);
    });

    it('lets a member_vy agent hold no seat, enter no org-chart context, and keeps its runs to its member', async () => {
      if (!has.kind) return;
      // Committed, so the worker login can be asked to enter the agent and the readers can look for its run.
      const made = await outcome(
        inContext(
          author.url(),
          author.enter,
          async (c) => {
            const agentId = randomUUID();
            const runId = randomUUID();
            await c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`, [orgId, agentId, users.author]);
            await c.query(
              `INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at) VALUES ($1, $2, $3, 'notes', 'running', true, now(), now() + interval '30 minutes')`,
              [orgId, runId, agentId],
            );
            return { agentId, runId };
          },
          true,
        ),
      );
      expect(made.ok, 'the member starting their own Vy and a run').toBe(true);
      if (!made.ok) return;
      const { agentId, runId } = made.value;
      try {
        // enter_agent_context refuses it: it is no org-chart agent (ADR-0049 decision 1).
        const entered = await outcome(inContext(workerUrl, async () => {}, (c) => c.query('SELECT crove_kernel.enter_agent_context($1::uuid, $2::uuid, $3::uuid)', [orgId, agentId, runId])));
        expect(entered.ok, 'enter_agent_context for a member_vy agent').toBe(false);
        // Not merely "no seat": a member_vy agent has none by design, so the refusal must come from its kind.
        expect(entered.ok ? '' : entered.message, 'refused for its kind, not for lacking a position').not.toMatch(/AGENT_NO_POSITION/);
        // A run of the member's Vy is read by that member alone: no owner, admin, member, viewer, agent or system.
        const mine = await run(author, async (c) => (await c.query('SELECT id FROM crove_kernel.ai_run WHERE id = $1', [runId])).rowCount);
        expect(mine, 'the member reading their run').toBe(1);
        for (const actor of others) {
          const seen = await run(actor, async (c) => (await c.query('SELECT id FROM crove_kernel.ai_run WHERE id = $1', [runId])).rowCount);
          expect(seen, `${actor.name} reading the member's run`).toBe(0);
        }
        // A run of a member_vy agent is inserted only in that member's context.
        for (const actor of [member('an owner', () => users.owner), member('an admin', () => users.admin), member('another member', () => users.member), member('a viewer', () => users.viewer), agentActor, system]) {
          const forged = await outcome(
            inContext(actor.url(), actor.enter, (c) =>
              c.query(`INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at) VALUES ($1, $2, $3, 'notes', 'running', true, now(), now() + interval '30 minutes')`, [orgId, randomUUID(), agentId]),
            ),
          );
          expect(forged.ok, `${actor.name} writing a run for the member's Vy`).toBe(false);
        }
        // position refuses a member_vy agent as its holder (an org-chart agent holds one seat, position_agent_uq, so the refusal must be named by the kind guard, not that index).
        const seat = await outcome(
          admin((c) => c.query(`INSERT INTO crove_kernel."position" (org_id, id, title, module, role_key, holder_agent_id) VALUES ($1, $2, 'Ghế thử', 'finance', 'finance.chief_accountant', $3)`, [orgId, randomUUID(), agentId])),
        );
        expect(seat.ok, 'a member_vy agent holding a seat').toBe(false);
        expect(seat.ok ? '' : seat.message, 'refused by the kind guard, not by a unique index').not.toMatch(/position_agent_uq|duplicate key/);
      } finally {
        await admin(async (c) => {
          await c.query('SET session_replication_role = replica');
          await c.query('DELETE FROM crove_kernel.ai_run WHERE org_id = $1 AND agent_id = $2', [orgId, agentId]);
          await c.query('DELETE FROM crove_kernel.agent WHERE org_id = $1 AND id = $2', [orgId, agentId]);
        });
      }
    });
  });

  // The permission vy.use (ADR-0049 decision 10): one resolution for every caller.
  describe('the permission vy.use', () => {
    it('gives owners, admins and members vy.use and a viewer none by default, and a deny beats the default', async () => {
      if (!has.permission) return;
      for (const [user, expected] of [
        [users.owner, true],
        [users.admin, true],
        [users.author, true],
        [users.viewer, false],
      ] as const) {
        expect(await permitted(user, 'vy.use'), `default for ${user === users.viewer ? 'a viewer' : 'a member'}`).toBe(expected);
      }
      if (!has.override) return;
      await admin((c) => c.query(`INSERT INTO crove_kernel.member_permission_override (org_id, id, user_id, permission, allowed, set_by) VALUES ($1, $2, $3, 'vy.use', false, $4)`, [orgId, randomUUID(), users.member, users.owner]));
      try {
        expect(await permitted(users.member, 'vy.use'), 'a member with a deny').toBe(false);
        // A deny beats a role that grants it too, and an entity-scoped role still counts for vy.use (the permission has no entity meaning).
        expect(await permitted(users.limited, 'vy.use'), 'a member whose only role is limited to one entity').toBe(true);
        await admin((c) => c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'crm.sales', $3)`, [orgId, users.member, users.owner]));
        expect(await permitted(users.member, 'vy.use'), 'a deny against a granting role').toBe(false);
      } finally {
        await admin((c) => c.query(`DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2 AND role_key = 'crm.sales'`, [orgId, users.member]));
        await admin((c) => c.query(`DELETE FROM crove_kernel.member_permission_override WHERE org_id = $1 AND user_id = $2`, [orgId, users.member]));
      }
    });

    it('lets a viewer hold vy.use through a grant or a department role and no other permission, and finance.viewer grants none', async () => {
      if (!has.permission) return;
      const viewerRoles = async (roles: string[]) => {
        const out: Record<string, boolean | undefined> = {};
        for (const role of roles) {
          await admin((c) => c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, $3, $4)`, [orgId, users.viewer, role, users.owner]));
          try {
            out[role] = await permitted(users.viewer, 'vy.use');
          } finally {
            await admin((c) => c.query(`DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2 AND role_key = $3`, [orgId, users.viewer, role]));
          }
        }
        return out;
      };
      // A role that grants vy.use and a real permission gives a viewer vy.use and nothing else.
      await admin((c) => c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'finance.chief_accountant', $3)`, [orgId, users.viewer, users.owner]));
      try {
        expect(await permitted(users.viewer, 'vy.use'), 'a viewer with a department role').toBe(true);
        expect(await permitted(users.viewer, 'finance.period.unlock'), 'the same viewer, the role\'s other permission').toBe(false);
      } finally {
        await admin((c) => c.query(`DELETE FROM crove_kernel.role_assignment WHERE org_id = $1 AND user_id = $2`, [orgId, users.viewer]));
      }
      expect(await viewerRoles([...VY_ROLES, 'finance.viewer'])).toEqual({ ...Object.fromEntries(VY_ROLES.map((r) => [r, true])), 'finance.viewer': false });
      // A viewer holds no other permission, whatever a grant says.
      if (has.override) {
        await admin((c) => c.query(`INSERT INTO crove_kernel.member_permission_override (org_id, id, user_id, permission, allowed, set_by) VALUES ($1, $2, $3, 'vy.use', true, $4)`, [orgId, randomUUID(), users.viewer, users.owner]));
        try {
          expect(await permitted(users.viewer, 'vy.use'), 'a viewer with a grant of vy.use').toBe(true);
          expect(await permitted(users.viewer, 'finance.period.unlock'), 'the same viewer, a permission no grant of vy.use gives').toBe(false);
        } finally {
          await admin((c) => c.query(`DELETE FROM crove_kernel.member_permission_override WHERE org_id = $1 AND user_id = $2`, [orgId, users.viewer]));
        }
      }
    });

    it('answers no permission to the system or an org-chart agent context through ctx_has_permission', async () => {
      // Unconditional: neither holds a permission today, and vy.use must not change that.
      for (const actor of [system, agentActor]) {
        const held = await run(actor, async (c) => (await c.query<{ ok: boolean | null }>(`SELECT crove_kernel.ctx_has_permission('vy.use') AS ok`)).rows[0]?.ok);
        expect(held === true, `${actor.name} holding vy.use`).toBe(false);
      }
    });
  });

  // The store command of stage A is the only writer of what Vy produced (decision 0, the stage A write boundary).
  it('declares the member_vy commands at R0 or R1 only, the store command among them, and none with memberVy before stage B', () => {
    const mine = kernelCommands.filter((c) => c.name.startsWith('kernel.member_vy.'));
    for (const c of mine) expect(['R0', 'R1'], `${c.name} risk`).toContain(c.risk);
    const store = kernelCommands.find((c) => c.name === 'kernel.member_vy.result.store');
    if (store) expect(['R0', 'R1'], 'the store command risk').toContain(store.risk);
    // No command outside the kernel.member_vy namespace is declared for a member-mode run before stage B.
    for (const c of kernelCommands) expect('memberVy' in c && (c as { memberVy?: unknown }).memberVy, `${c.name} declares memberVy before stage B`).toBeFalsy();
  });
});

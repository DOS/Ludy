// SPDX-License-Identifier: AGPL-3.0-only
// The runtime side of Vy in member mode (ADR-0049, #2756): the member-scoped agent actor enters through enter_member_vy_context, a command or
// query runs for it only when it declares memberVy and its `access` also admits the member's base role, R0 or R1 only, and the rows the
// runtime writes for it pass the write guard. The database cases are in test/invariant/member-vy-background.db.test.ts.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, upsertIdentity } from '@crove/kernel';
import { Runtime, defineCommand, defineQuery, memberVyRuntime, type CommandDef, type QueryDef } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './invariant/fixtures/manifests.ts';
import { contextToken } from './invariant/fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ALL = ['owner', 'admin', 'member', 'viewer'] as const;

const cmd = (name: string, def: Partial<CommandDef<unknown, unknown>>, handler: CommandDef<unknown, unknown>['handler']): CommandDef<unknown, unknown> =>
  defineCommand({ sideEffect: 'none', name, input: z.object({}), risk: 'R1', access: ALL, writes: [], handler, ...def }) as CommandDef<unknown, unknown>;
const memberVy = { taint: 'propagate' as const };
const COMMANDS = [
  cmd('kernel.member_vy.t_whoami', { memberVy }, async (ctx) => ({ actor: ctx.actor, member: ctx.memberVy, agent: ctx.agent, role: ctx.role })),
  cmd('kernel.member_vy.t_undeclared', { risk: 'R0' }, async () => ({ ok: true })),
  cmd('kernel.member_vy.t_owner_only', { access: ['owner'], memberVy }, async () => ({ ok: true })),
  cmd('kernel.member_vy.t_members_only', { access: ['owner', 'admin', 'member'], memberVy }, async () => ({ ok: true })),
  cmd('kernel.member_vy.t_audit_ids', { memberVy }, async (ctx) => {
    ctx.audit({ resultId: randomUUID(), status: 'ready', bodyLength: 3 });
    return { ok: true };
  }),
  cmd('kernel.member_vy.t_audit_text', { memberVy }, async (ctx) => {
    ctx.audit({ summary: 'Tóm tắt riêng: khách đề nghị giảm giá 12%' });
    return { ok: true };
  }),
];
const query = (name: string, def: Partial<QueryDef<unknown, unknown>>): QueryDef<unknown, unknown> =>
  defineQuery({ name, input: z.object({}), access: ALL, handler: async (ctx) => ({ member: ctx.memberVy?.memberUserId ?? null }), ...def }) as QueryDef<unknown, unknown>;
const QUERIES = [query('kernel.member_vy.t_q', { memberVy: {} }), query('kernel.member_vy.t_q_undeclared', {})];

suite('member-scoped agent actor in the runtime', () => {
  const dbName = `crove_test_member_vy_rt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  const pools: pg.Pool[] = [];
  let orgId = '';
  let owner = '';
  let worker: Runtime;
  const users: Record<string, string> = {};
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
  async function makeVy(user: string): Promise<{ agentId: string; runId: string }> {
    const c = new pg.Client({ connectionString: appUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(user, orgId)]);
      const agentId = randomUUID();
      const runId = randomUUID();
      await c.query(`INSERT INTO crove_kernel.agent (org_id, id, template_key, display_name, kind, member_user_id, created_by) VALUES ($1, $2, 'kernel.member_vy', 'Vy', 'member_vy', $3, $3)`, [orgId, agentId, user]);
      await c.query(`INSERT INTO crove_kernel.ai_run (org_id, id, agent_id, module, status, tainted, started_at, expires_at) VALUES ($1, $2, $3, 'notes', 'running', true, now(), now() + interval '30 minutes')`, [orgId, runId, agentId]);
      await c.query('COMMIT');
      return { agentId, runId };
    } finally {
      await c.end();
    }
  }
  const run = (who: string) => memberVyRuntime(worker, orgId, vy[who] as { agentId: string; runId: string });

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
    const appPool = createPool({ connectionString: appUrl, max: 2 });
    const workerPool = createPool({ connectionString: workerUrl, max: 4 });
    pools.push(appPool, workerPool);
    const appDb = createDb(appPool);
    worker = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands: COMMANDS, queries: QUERIES });
    const app = new Runtime(appDb, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands], queries: [] });
    for (const key of ['owner', 'member', 'viewer']) {
      users[key] = await upsertIdentity(appDb, { issuer: 'member-vy-rt', subject: key, email: `${key}@member-vy-rt.test`, name: null });
    }
    owner = users.owner as string;
    orgId = (await createOrg(app, { type: 'user', userId: owner, aal: 'aal1' }, 'Vy runtime')).orgId;
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')`, [orgId, users.member, users.viewer]);
      // A viewer holds vy.use only through a grant (ADR-0049 decision 10).
      await c.query(`INSERT INTO crove_kernel.member_permission_override (org_id, user_id, permission, allowed, set_by) VALUES ($1, $2, 'vy.use', true, $3)`, [orgId, users.viewer, owner]);
    });
    vy.member = await makeVy(users.member as string);
    vy.viewer = await makeVy(users.viewer as string);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('runs a declared command as the member-scoped actor, with the member\'s grant and no org-chart grant', async () => {
    const facade = run('member');
    expect(Object.isFrozen(facade)).toBe(true);
    expect(Object.keys(facade).sort()).toEqual(['agentId', 'execute', 'orgId', 'query', 'runId']);
    const out = await facade.execute<{ actor: unknown; member: Record<string, unknown>; agent: unknown; role: unknown }>('kernel.member_vy.t_whoami', {});
    expect(out.actor).toEqual({ type: 'agent', agentId: vy.member?.agentId, runId: vy.member?.runId, memberVy: true });
    expect(out.agent, 'no org-chart grant').toBeNull();
    expect(out.role, 'no user role either').toBeNull();
    expect(out.member).toMatchObject({ memberUserId: users.member, role: 'member', module: 'notes', tainted: true });
    expect(['R0', 'R1']).toContain(out.member.maxRisk);
  });

  it('refuses a command that does not declare memberVy, one whose access leaves the member\'s role out, and a viewer on a members-only one', async () => {
    const refused = (p: Promise<unknown>) => p.then(() => 'ran', (e: { code?: string; details?: { rule?: string } }) => `${e.code}:${e.details?.rule}`);
    expect(await refused(run('member').execute('kernel.member_vy.t_undeclared', {})), 'no declaration').toBe('FORBIDDEN:member_vy_access');
    expect(await refused(run('member').execute('kernel.member_vy.t_owner_only', {})), 'a member on an owner-only command').toBe('FORBIDDEN:member_vy_role');
    expect(await refused(run('member').execute('kernel.member_vy.t_members_only', {})), 'a member on a members command').toBe('ran');
    // A viewer who was given vy.use runs no command a viewer cannot run.
    expect(await refused(run('viewer').execute('kernel.member_vy.t_members_only', {})), 'a viewer on a members-only command').toBe('FORBIDDEN:member_vy_role');
    expect(await refused(run('viewer').execute('kernel.member_vy.t_whoami', {})), 'a viewer on a command open to viewers').toBe('ran');
  });

  it('reads only a query that declares memberVy', async () => {
    expect(await run('member').query('kernel.member_vy.t_q', {})).toEqual({ member: users.member });
    await expect(run('member').query('kernel.member_vy.t_q_undeclared', {})).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'member_vy_access' } });
  });

  it('refuses at registration a memberVy command at R2 or with a system access, and a memberVy query with a system access', () => {
    const db = createDb(pools[0] as pg.Pool);
    const make = () => new Runtime(db, { manifests: TEST_MANIFESTS });
    expect(() => make().register({ commands: [cmd('kernel.member_vy.t_r2', { risk: 'R2', memberVy }, async () => ({}))] })).toThrow(/R0 or R1/);
    expect(() => make().register({ commands: [cmd('kernel.member_vy.t_sys', { access: 'system', memberVy }, async () => ({}))] })).toThrow(/role list/);
    expect(() => make().register({ commands: [cmd('kernel.member_vy.t_nowrites', { writes: undefined as never, memberVy }, async () => ({}))] })).toThrow(/declares its writes/);
    expect(() => make().register({ queries: [query('kernel.member_vy.t_qsys', { access: 'system', memberVy: {} })] })).toThrow(/role list/);
  });

  it('writes the audit row of a member-mode command with ids, enums and numbers, and refuses one with text', async () => {
    await run('member').execute('kernel.member_vy.t_audit_ids', {});
    const rows = await admin((c) => c.query<{ actor_type: string; actor_id: string; detail: Record<string, unknown> }>(`SELECT actor_type, actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member_vy.t_audit_ids' AND outcome = 'ok'`, [orgId]));
    expect(rows.rows[0]).toMatchObject({ actor_type: 'agent', actor_id: vy.member?.agentId, detail: { agentRun: vy.member?.runId, status: 'ready', bodyLength: 3 } });
    // Text in the detail is refused by the write guard, so the command fails and no row of it is kept.
    await expect(run('member').execute('kernel.member_vy.t_audit_text', {})).rejects.toBeDefined();
    const text = await admin((c) => c.query(`SELECT 1 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.member_vy.t_audit_text' AND outcome = 'ok'`, [orgId]));
    expect(text.rowCount).toBe(0);
  });

  it('is refused by the database for a wrong flag, a member who left and another org', async () => {
    const plain = { type: 'agent' as const, agentId: vy.member?.agentId as string, runId: vy.member?.runId as string };
    // A member's Vy through the org-chart entry (the flag left off), and an unknown agent through the member entry.
    await expect(worker.execute('kernel.member_vy.t_whoami', {}, { actor: plain, orgId })).rejects.toBeDefined();
    await expect(worker.execute('kernel.member_vy.t_whoami', {}, { actor: { ...plain, agentId: randomUUID(), memberVy: true }, orgId })).rejects.toBeDefined();
    // The member's agent named in another org.
    await expect(worker.execute('kernel.member_vy.t_whoami', {}, { actor: { ...plain, memberVy: true }, orgId: randomUUID() })).rejects.toBeDefined();
    // A removed member's run enters no more.
    await admin((c) => c.query(`DELETE FROM crove_kernel.member_permission_override WHERE org_id = $1 AND user_id = $2`, [orgId, users.viewer]));
    await expect(run('viewer').execute('kernel.member_vy.t_whoami', {})).rejects.toBeDefined();
  });
});

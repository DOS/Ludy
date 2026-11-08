// SPDX-License-Identifier: AGPL-3.0-only
// Sensitive queries (#2639, plan section 4.4 "Query", ADR-0046 point 4) on a real PostgreSQL 17: a query declared `sensitive` commits an
// audit row of the read in its own transaction BEFORE its handler runs, a failed audit write stops the read (it fails closed), a caller
// who may not read leaves no row, no value reaches the row, and ctx.query refuses the query because a nested read could not be audited first.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { DomainError, Runtime, defineCommand, defineQuery, type AgentActor, type CommandDef, type QueryDef } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A plain phrase, so no secret scanner takes it for a key; the tests look for it in every audit row.
const CANARY = 'salary canary phrase';
const SYSTEM = { type: 'system' as const, component: 't2639-worker' };

suite('sensitive queries on PostgreSQL (#2639)', () => {
  const dbName = `crove_test_sensitive_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  // The same queries with no audit key configured.
  let keylessRt: Runtime;
  let workerRt: Runtime;
  // What each probe handler saw, per org and query: how many audit rows of its own name were already committed, seen from another connection, when it ran.
  const seen = new Map<string, number[]>();
  const ran = new Map<string, number>();
  const key = (orgId: string, name: string) => `${orgId}:${name}`;
  const ranCount = (orgId: string, name: string) => ran.get(key(orgId, name)) ?? 0;

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  const committedRows = (orgId: string, name: string) =>
    withAdmin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2', [orgId, name])).rows[0]?.n));

  // Records that the handler ran and how many rows of its own audit were committed when it started.
  async function observe(name: string, input: unknown): Promise<void> {
    const { orgId } = input as { orgId: string };
    ran.set(key(orgId, name), ranCount(orgId, name) + 1);
    const list = seen.get(key(orgId, name)) ?? [];
    list.push(await committedRows(orgId, name));
    seen.set(key(orgId, name), list);
  }

  const probe = (name: string, access: QueryDef['access'], over: Partial<QueryDef<unknown, unknown>> = {}) =>
    defineQuery({
      name,
      input: z.object({ orgId: z.uuid(), note: z.string().optional(), recordId: z.uuid().optional() }),
      access,
      sensitive: true,
      handler: async (_ctx, input) => {
        await observe(name, input);
        return { rows: 1 };
      },
      ...over,
    }) as QueryDef<unknown, unknown>;

  const QUERIES = {
    owner: probe('t2639.owner_read', ['owner'], {
      agent: { roles: 'any' },
      target: (input) => {
        const recordId = (input as { recordId?: string }).recordId;
        return recordId ? { type: 't2639.record', id: recordId } : null;
      },
    }),
    boom: probe('t2639.boom', ['owner'], {
      handler: async (_ctx, input) => {
        await observe('t2639.boom', input);
        throw new Error('the read fails after its audit');
      },
    }),
    gated: probe('t2639.gated', ['owner']),
    streamed: probe('t2639.streamed', ['owner'], {
      stream: true,
      handler: async (_ctx, input, sink) => {
        await observe('t2639.streamed', input);
        await sink?.({ batch: 1 });
        return { rows: 1 };
      },
    }),
    badTarget: probe('t2639.bad_target', ['owner'], { target: () => ({ type: 'Not a type!', id: randomUUID() }) }),
    plain: defineQuery({ name: 't2639.plain', input: z.object({}), access: ['owner', 'admin', 'member'], handler: async () => ({ ok: true }) }) as QueryDef<unknown, unknown>,
    // A query that tries to read a sensitive one inside its own transaction.
    nested: defineQuery({ name: 't2639.nested', input: z.object({ orgId: z.uuid() }), access: ['owner'], handler: async (ctx, input) => ctx.query('t2639.owner_read', input) }) as QueryDef<unknown, unknown>,
  };

  // A command that tries to read a sensitive query inside its own transaction.
  const NESTED_COMMAND = defineCommand({
    name: 't2639.nested_command',
    input: z.object({ orgId: z.uuid() }),
    risk: 'R1',
    sideEffect: 'none',
    access: ['owner'],
    writes: [],
    handler: async (ctx, input) => ctx.query('t2639.owner_read', input),
  }) as CommandDef<unknown, unknown>;

  const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@sensitive.test`, name: null });
  const user = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const mfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: '7e1c2b4a-5d6f-4a8b-9c0d-1e2f3a4b5c6d', mfaAt: Math.floor(Date.now() / 1000) });

  async function org() {
    const owner = await person('owner');
    const member = await person('member');
    const outsider = await person('outsider');
    const { orgId } = await createOrg(rt, user(owner), `Sensitive ${randomUUID().slice(0, 6)}`);
    await withAdmin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    return { orgId, owner, member, outsider };
  }

  // A live agent of the org (the template and the run, the way agents.db.test.ts makes them).
  async function liveAgent(orgId: string, ownerId: string): Promise<AgentActor> {
    const { agentId, positionId } = await rt.execute<{ agentId: string; positionId: string }>(
      'kernel.agent.template.install',
      { templateKey: 'finance.chief_accountant', reportsTo: null },
      { actor: mfa(ownerId), orgId, idempotencyKey: randomUUID() },
    );
    await rt.execute('kernel.task.create', { title: 'Việc thử', assigneePositionId: positionId }, { actor: user(ownerId), orgId, idempotencyKey: randomUUID() });
    const started = await workerRt.execute<{ runId: string | null }>('kernel.agent.run.start', { agentId }, { actor: { type: 'system', component: 'kernel.agent' }, orgId, idempotencyKey: randomUUID() });
    if (!started.runId) throw new Error('no run');
    return { type: 'agent', agentId, runId: started.runId };
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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    appUrl = url.toString();
    pool = createPool({ connectionString: url.toString(), max: 4 });
    const queries = [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...Object.values(QUERIES)];
    const commands = [...kernelCommands, ...financeCommands];
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, readAuditKey: randomBytes(32) }).register({ commands: [...commands, NESTED_COMMAND], queries });
    keylessRt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...commands, NESTED_COMMAND], queries });
    // The system and agent contexts are entered by the worker's login role only.
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: url.toString(), max: 2 });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands: [...commands, NESTED_COMMAND], queries });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('commits the audit row before the handler reads, and writes one row naming the query, the actor, the record and the hash of the input', async () => {
    const o = await org();
    const recordId = randomUUID();
    expect(await rt.query('t2639.owner_read', { orgId: o.orgId, recordId }, { actor: user(o.owner), orgId: o.orgId })).toEqual({ rows: 1 });
    // The handler, from another connection, already saw its own row committed.
    expect(seen.get(key(o.orgId, 't2639.owner_read'))).toEqual([1]);
    const rows = await withAdmin(
      async (c) =>
        (
          await c.query<{ actor_type: string; actor_id: string; outcome: string; detail: Record<string, unknown>; input_sha256: string; target_type: string | null; target_id: string | null }>(
            "SELECT actor_type, actor_id, outcome, detail, input_sha256, target_type, target_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 't2639.owner_read'",
            [o.orgId],
          )
        ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'user', actor_id: o.owner, outcome: 'ok', detail: { read: 'sensitive', stage: 'before_read' }, target_type: 't2639.record', target_id: recordId });
    // An HMAC under the key of the environment, never the plain hash of the input.
    expect(rows[0]?.input_sha256).toMatch(/^h1:[0-9a-f]{64}$/);
  });

  it('writes one row per read, so two reads leave two rows', async () => {
    const o = await org();
    await rt.query('t2639.owner_read', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId });
    await rt.query('t2639.owner_read', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId });
    expect(await committedRows(o.orgId, 't2639.owner_read')).toBe(2);
  });

  it('keeps the row when the read itself fails afterwards', async () => {
    const o = await org();
    await expect(rt.query('t2639.boom', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId })).rejects.toBeInstanceOf(DomainError);
    expect(seen.get(key(o.orgId, 't2639.boom'))).toEqual([1]);
    expect(await committedRows(o.orgId, 't2639.boom')).toBe(1);
  });

  it('leaves no row, and never runs the handler, for a caller the query does not admit', async () => {
    const o = await org();
    // A member without the role, and someone who is not a member at all.
    await expect(rt.query('t2639.gated', { orgId: o.orgId }, { actor: user(o.member), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(rt.query('t2639.gated', { orgId: o.orgId }, { actor: user(o.outsider), orgId: o.orgId })).rejects.toBeInstanceOf(DomainError);
    expect(ranCount(o.orgId, 't2639.gated')).toBe(0);
    expect(await committedRows(o.orgId, 't2639.gated')).toBe(0);
  });

  it('notes a refusal of an established member in security_event (the query and the code only), once, and writes no audit row', async () => {
    const o = await org();
    const events = (caller: string) =>
      withAdmin(async (c) => (await c.query<{ command: string; code: string; target_org: string; refusals: string }>('SELECT command, code, target_org, refusals FROM crove_kernel.security_event WHERE caller = $1', [caller])).rows);
    await expect(rt.query('t2639.gated', { orgId: o.orgId, note: CANARY }, { actor: user(o.member), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const rows = await events(`user:${o.member}`);
    expect(rows).toEqual([{ command: 't2639.gated', code: 'FORBIDDEN', target_org: o.orgId, refusals: '1' }]);
    expect(JSON.stringify(rows)).not.toContain(CANARY);
    expect(await committedRows(o.orgId, 't2639.gated')).toBe(0);
  });

  it('stores no hash, not a plain one, when no audit key is configured', async () => {
    const o = await org();
    await keylessRt.query('t2639.owner_read', { orgId: o.orgId, note: 'low entropy' }, { actor: user(o.owner), orgId: o.orgId });
    const rows = await withAdmin(async (c) => (await c.query<{ input_sha256: string }>("SELECT input_sha256 FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 't2639.owner_read'", [o.orgId])).rows);
    expect(rows).toEqual([{ input_sha256: 'none' }]);
  });

  it('refuses a sensitive query for an agent and for the system, with no row and no run of the handler', async () => {
    const o = await org();
    const agent = await liveAgent(o.orgId, o.owner);
    await expect(workerRt.query('t2639.owner_read', { orgId: o.orgId }, { actor: agent, orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'sensitive_user_only' } });
    await expect(workerRt.query('t2639.owner_read', { orgId: o.orgId }, { actor: SYSTEM, orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'sensitive_user_only' } });
    expect(ranCount(o.orgId, 't2639.owner_read')).toBe(0);
    expect(await committedRows(o.orgId, 't2639.owner_read')).toBe(0);
    // The agent's refusal is a security event of its caller; the system's is not noted (system actors never are).
    const noted = await withAdmin(async (c) => (await c.query<{ code: string }>('SELECT code FROM crove_kernel.security_event WHERE caller = $1 AND command = $2', [`agent:${agent.agentId}`, 't2639.owner_read'])).rows);
    expect(noted).toEqual([{ code: 'FORBIDDEN' }]);
  });

  it('fails closed: with the audit write refused, the handler does not run and nothing is read', async () => {
    const o = await org();
    await withAdmin((c) =>
      c.query(`
        CREATE FUNCTION public.t2639_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit refused' USING ERRCODE = '55000'; END $$;
        CREATE TRIGGER t2639_refuse BEFORE INSERT ON crove_kernel.audit_event FOR EACH ROW WHEN (NEW.command = 't2639.owner_read') EXECUTE FUNCTION public.t2639_refuse_audit();`),
    );
    try {
      await expect(rt.query('t2639.owner_read', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId })).rejects.toBeInstanceOf(DomainError);
      expect(ranCount(o.orgId, 't2639.owner_read')).toBe(0);
      expect(await committedRows(o.orgId, 't2639.owner_read')).toBe(0);
    } finally {
      await withAdmin((c) => c.query('DROP TRIGGER t2639_refuse ON crove_kernel.audit_event; DROP FUNCTION public.t2639_refuse_audit()'));
    }
  });

  it('writes one audit row when a stream starts, not one per batch', async () => {
    const o = await org();
    const batches: unknown[] = [];
    await rt.stream('t2639.streamed', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId }, async (b) => {
      batches.push(b);
      await expect(committedRows(o.orgId, 't2639.streamed')).resolves.toBe(1);
    });
    expect(batches).toEqual([{ batch: 1 }]);
    expect(seen.get(key(o.orgId, 't2639.streamed'))).toEqual([1]);
    expect(await committedRows(o.orgId, 't2639.streamed')).toBe(1);
  });

  it('refuses a streamed sensitive query on the plain path before any audit', async () => {
    const o = await org();
    await expect(rt.query('t2639.streamed', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'STREAM_ONLY' });
    expect(await committedRows(o.orgId, 't2639.streamed')).toBe(0);
  });

  it('refuses a sensitive query inside another query (ctx.query), where its audit could not be committed first', async () => {
    const o = await org();
    await expect(rt.query('t2639.nested', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'SENSITIVE_ONLY' });
    expect(ranCount(o.orgId, 't2639.owner_read')).toBe(0);
    expect(await committedRows(o.orgId, 't2639.owner_read')).toBe(0);
  });

  it('writes no row for an ordinary query, and carries no value of a sensitive one', async () => {
    const o = await org();
    await rt.query('t2639.plain', {}, { actor: user(o.owner), orgId: o.orgId });
    expect(await committedRows(o.orgId, 't2639.plain')).toBe(0);
    await rt.query('t2639.owner_read', { orgId: o.orgId, note: CANARY }, { actor: user(o.owner), orgId: o.orgId });
    const text = await withAdmin(async (c) =>
      (await c.query<{ row: string }>("SELECT audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 't2639.owner_read'", [o.orgId])).rows.map((r) => r.row).join('\n'),
    );
    expect(text).not.toContain(CANARY);
  });
  it('refuses a sensitive query reached by ctx.query from a command', async () => {
    const o = await org();
    await expect(rt.execute('t2639.nested_command', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'SENSITIVE_ONLY' });
    expect(ranCount(o.orgId, 't2639.owner_read')).toBe(0);
    expect(await committedRows(o.orgId, 't2639.owner_read')).toBe(0);
  });

  it('leaves the pre-membership security event of a caller who is no member as it was: one row, once', async () => {
    const o = await org();
    await expect(rt.query('t2639.gated', { orgId: o.orgId }, { actor: user(o.outsider), orgId: o.orgId })).rejects.toBeInstanceOf(DomainError);
    const rows = await withAdmin(async (c) => (await c.query<{ command: string; code: string; target_org: string; refusals: string }>('SELECT command, code, target_org, refusals FROM crove_kernel.security_event WHERE caller = $1', [`user:${o.outsider}`])).rows);
    expect(rows).toEqual([{ command: 't2639.gated', code: 'NOT_A_MEMBER', target_org: o.orgId, refusals: '1' }]);
  });

  it('notes a refused read after the audit transaction is closed, so a refused caller never holds a connection while waiting for another', async () => {
    const o = await org();
    // One connection for the cell and the control plane together, as a single-cell deployment has: a refusal noted inside the audit transaction would wait for a second one for ever.
    const single = createPool({ connectionString: appUrl, max: 1 });
    try {
      const alone = new Runtime(createDb(single), { manifests: TEST_MANIFESTS, readAuditKey: randomBytes(32) }).register({ commands: [...kernelCommands, NESTED_COMMAND], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...Object.values(QUERIES)] });
      const outcome = await Promise.race([
        alone.query('t2639.gated', { orgId: o.orgId }, { actor: user(o.member), orgId: o.orgId }).then(
          () => 'answered',
          (error: unknown) => (error as { code?: string }).code ?? 'error',
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve('stalled'), 8000)),
      ]);
      expect(outcome).toBe('FORBIDDEN');
    } finally {
      await single.end();
    }
    const noted = await withAdmin(async (c) => (await c.query<{ code: string }>('SELECT code FROM crove_kernel.security_event WHERE caller = $1 AND command = $2', [`user:${o.member}`, 't2639.gated'])).rows);
    expect(noted).toEqual([{ code: 'FORBIDDEN' }]);
  });

  it('refuses a target type that is not a name, with no row and no run of the handler', async () => {
    const o = await org();
    await expect(rt.query('t2639.bad_target', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId })).rejects.toBeInstanceOf(DomainError);
    expect(ranCount(o.orgId, 't2639.bad_target')).toBe(0);
    expect(await committedRows(o.orgId, 't2639.bad_target')).toBe(0);
  });
});

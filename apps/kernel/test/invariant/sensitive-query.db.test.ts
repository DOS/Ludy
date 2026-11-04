// SPDX-License-Identifier: AGPL-3.0-only
// Sensitive queries (#2639, plan section 4.4 "Query", ADR-0046 point 4) on a real PostgreSQL 17: a query declared `sensitive` commits an
// audit row of the read in its own transaction BEFORE its handler runs, a failed audit write stops the read (it fails closed), a caller
// who may not read leaves no row, no value reaches the row, and ctx.query refuses the query because a nested read could not be audited first.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { DomainError, Runtime, defineQuery, type AgentActor, type QueryDef } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET = 'canary-salary-8123456';
const SYSTEM = { type: 'system' as const, component: 't2639-worker' };

suite('sensitive queries on PostgreSQL (#2639)', () => {
  const dbName = `crove_test_sensitive_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
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
    system: probe('t2639.system_read', 'system'),
    streamed: probe('t2639.streamed', ['owner'], {
      stream: true,
      handler: async (_ctx, input, sink) => {
        await observe('t2639.streamed', input);
        await sink?.({ batch: 1 });
        return { rows: 1 };
      },
    }),
    plain: defineQuery({ name: 't2639.plain', input: z.object({}), access: ['owner', 'admin', 'member'], handler: async () => ({ ok: true }) }) as QueryDef<unknown, unknown>,
    // A query that tries to read a sensitive one inside its own transaction.
    nested: defineQuery({ name: 't2639.nested', input: z.object({ orgId: z.uuid() }), access: ['owner'], handler: async (ctx, input) => ctx.query('t2639.owner_read', input) }) as QueryDef<unknown, unknown>,
  };

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
    pool = createPool({ connectionString: url.toString(), max: 4 });
    const queries = [...kernelQueries({ inboundDomain: null }), ...financeQueries, ...Object.values(QUERIES)];
    const commands = [...kernelCommands, ...financeCommands];
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands, queries });
    // The system and agent contexts are entered by the worker's login role only.
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: url.toString(), max: 2 });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands, queries });
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
    expect(rows[0]?.input_sha256).toMatch(/^(k1:)?[0-9a-f]{64}$/);
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
    // A member without the role, someone who is not a member at all, and a user on a query only the system may run.
    await expect(rt.query('t2639.gated', { orgId: o.orgId }, { actor: user(o.member), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(rt.query('t2639.gated', { orgId: o.orgId }, { actor: user(o.outsider), orgId: o.orgId })).rejects.toBeInstanceOf(DomainError);
    await expect(rt.query('t2639.system_read', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ranCount(o.orgId, 't2639.gated')).toBe(0);
    expect(ranCount(o.orgId, 't2639.system_read')).toBe(0);
    expect(await committedRows(o.orgId, 't2639.gated')).toBe(0);
    expect(await committedRows(o.orgId, 't2639.system_read')).toBe(0);
  });

  it('does not note an established member refused by the role as a pre-membership security event', async () => {
    const o = await org();
    const count = () => withAdmin(async (c) => Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM crove_kernel.security_event')).rows[0]?.n));
    const before = await count();
    await expect(rt.query('t2639.gated', { orgId: o.orgId }, { actor: user(o.member), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await count()).toBe(before);
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

  it('audits a system actor with its component, an agent with its run, and a streamed read as well', async () => {
    const o = await org();
    const rows = (name: string) =>
      withAdmin(async (c) => (await c.query<{ actor_type: string; actor_id: string | null; detail: Record<string, unknown> }>('SELECT actor_type, actor_id, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2', [o.orgId, name])).rows);
    await workerRt.query('t2639.system_read', { orgId: o.orgId }, { actor: SYSTEM, orgId: o.orgId });
    // The database stamps the worker process on a system row (workerInstance).
    const system = await rows('t2639.system_read');
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ actor_type: 'system', detail: { component: 't2639-worker', read: 'sensitive' } });
    const agent = await liveAgent(o.orgId, o.owner);
    await workerRt.query('t2639.owner_read', { orgId: o.orgId }, { actor: agent, orgId: o.orgId });
    const agentRows = await rows('t2639.owner_read');
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0]).toMatchObject({ actor_type: 'agent', actor_id: agent.agentId, detail: { agentRun: agent.runId, read: 'sensitive' } });
    expect(seen.get(key(o.orgId, 't2639.owner_read'))).toEqual([1]);
    const batches: unknown[] = [];
    await rt.stream('t2639.streamed', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId }, async (b) => void batches.push(b));
    expect(batches).toEqual([{ batch: 1 }]);
    expect(seen.get(key(o.orgId, 't2639.streamed'))).toEqual([1]);
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
    await rt.query('t2639.owner_read', { orgId: o.orgId, note: SECRET }, { actor: user(o.owner), orgId: o.orgId });
    const text = await withAdmin(async (c) =>
      (await c.query<{ row: string }>("SELECT audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 't2639.owner_read'", [o.orgId])).rows.map((r) => r.row).join('\n'),
    );
    expect(text).not.toContain(SECRET);
  });
});

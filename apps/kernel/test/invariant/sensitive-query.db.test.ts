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
import { DomainError, Runtime, defineQuery, type QueryDef } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const SECRET = 'canary-salary-8123456';

suite('sensitive queries on PostgreSQL (#2639)', () => {
  const dbName = `crove_test_sensitive_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let workerRt: Runtime;
  // What each probe handler saw: how many audit rows of its own name were already committed when it ran.
  const seen: Record<string, number[]> = {};
  const ran: Record<string, number> = {};

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

  // A query whose handler records how many rows of its own audit were committed, seen from another connection, when it started.
  const probe = (name: string, access: QueryDef['access'], over: Partial<QueryDef<unknown, unknown>> = {}) =>
    defineQuery({
      name,
      input: z.object({ orgId: z.uuid(), note: z.string().optional() }),
      access,
      sensitive: true,
      handler: async (_ctx, input) => {
        const { orgId } = input as { orgId: string };
        ran[name] = (ran[name] ?? 0) + 1;
        (seen[name] ??= []).push(await committedRows(orgId, name));
        return { rows: 1 };
      },
      ...over,
    }) as QueryDef<unknown, unknown>;

  const QUERIES = {
    owner: probe('t2639.owner_read', ['owner']),
    boom: probe('t2639.boom', ['owner'], {
      handler: async (_ctx, input) => {
        const { orgId } = input as { orgId: string };
        ran['t2639.boom'] = (ran['t2639.boom'] ?? 0) + 1;
        (seen['t2639.boom'] ??= []).push(await committedRows(orgId, 't2639.boom'));
        throw new Error('the read fails after its audit');
      },
    }),
    gated: probe('t2639.gated', ['owner']),
    system: probe('t2639.system_read', 'system'),
    streamed: probe('t2639.streamed', ['owner'], {
      stream: true,
      handler: async (_ctx, input, sink) => {
        const { orgId } = input as { orgId: string };
        ran['t2639.streamed'] = (ran['t2639.streamed'] ?? 0) + 1;
        (seen['t2639.streamed'] ??= []).push(await committedRows(orgId, 't2639.streamed'));
        await sink?.({ batch: 1 });
        return { rows: 1 };
      },
    }),
    plain: defineQuery({
      name: 't2639.plain',
      input: z.object({}),
      access: ['owner', 'admin', 'member'],
      handler: async () => ({ ok: true }),
    }) as QueryDef<unknown, unknown>,
    // A query that tries to read a sensitive one inside its own transaction.
    nested: defineQuery({
      name: 't2639.nested',
      input: z.object({ orgId: z.uuid() }),
      access: ['owner'],
      handler: async (ctx, input) => ctx.query('t2639.owner_read', input),
    }) as QueryDef<unknown, unknown>,
  };

  const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@sensitive.test`, name: null });
  const user = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function org() {
    const owner = await person('owner');
    const member = await person('member');
    const { orgId } = await createOrg(rt, user(owner), `Sensitive ${randomUUID().slice(0, 6)}`);
    await withAdmin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]));
    return { orgId, owner, member };
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
    const queries = [...kernelQueries({ inboundDomain: null }), ...Object.values(QUERIES)];
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries });
    // The system context is entered by the worker's login role only.
    url.username = 'crove_worker';
    url.password = 'test-worker-pw';
    workerPool = createPool({ connectionString: url.toString(), max: 2 });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries });
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

  it('commits the audit row before the handler reads, and writes one row naming the query, the actor and the hash of the input', async () => {
    const o = await org();
    expect(await rt.query('t2639.owner_read', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId })).toEqual({ rows: 1 });
    // The handler, from another connection, already saw its own row committed.
    expect(seen['t2639.owner_read']).toEqual([1]);
    const rows = await withAdmin(async (c) =>
      (await c.query<{ actor_type: string; actor_id: string; outcome: string; detail: Record<string, unknown>; input_sha256: string; target_id: string | null }>(
        "SELECT actor_type, actor_id, outcome, detail, input_sha256, target_id FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 't2639.owner_read'",
        [o.orgId],
      )).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor_type: 'user', actor_id: o.owner, outcome: 'ok', detail: { read: 'sensitive' }, target_id: null });
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
    expect(seen['t2639.boom']).toEqual([1]);
    expect(await committedRows(o.orgId, 't2639.boom')).toBe(1);
  });

  it('leaves no row, and never runs the handler, for a caller the query does not admit', async () => {
    const o = await org();
    const before = ran['t2639.gated'] ?? 0;
    await expect(rt.query('t2639.gated', { orgId: o.orgId }, { actor: user(o.member), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ran['t2639.gated'] ?? 0).toBe(before);
    expect(await committedRows(o.orgId, 't2639.gated')).toBe(0);
  });

  it('fails closed: with the audit write refused, the handler does not run and nothing is read', async () => {
    const o = await org();
    await withAdmin((c) =>
      c.query(`
        CREATE FUNCTION public.t2639_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit refused' USING ERRCODE = '55000'; END $$;
        CREATE TRIGGER t2639_refuse BEFORE INSERT ON crove_kernel.audit_event FOR EACH ROW WHEN (NEW.command = 't2639.owner_read') EXECUTE FUNCTION public.t2639_refuse_audit();`),
    );
    try {
      const before = ran['t2639.owner_read'] ?? 0;
      await expect(rt.query('t2639.owner_read', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'INTERNAL' });
      expect(ran['t2639.owner_read'] ?? 0).toBe(before);
      expect(await committedRows(o.orgId, 't2639.owner_read')).toBe(0);
    } finally {
      await withAdmin((c) => c.query('DROP TRIGGER t2639_refuse ON crove_kernel.audit_event; DROP FUNCTION public.t2639_refuse_audit()'));
    }
  });

  it('audits a system actor with its component, and a streamed read as well', async () => {
    const o = await org();
    await workerRt.query('t2639.system_read', { orgId: o.orgId }, { actor: { type: 'system', component: 't2639-worker' }, orgId: o.orgId });
    const system = await withAdmin(async (c) => (await c.query<{ actor_type: string; detail: Record<string, unknown> }>("SELECT actor_type, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 't2639.system_read'", [o.orgId])).rows);
    // The database stamps the worker process on a system row (workerInstance).
    expect(system).toHaveLength(1);
    expect(system[0]).toMatchObject({ actor_type: 'system', detail: { component: 't2639-worker', read: 'sensitive' } });
    const batches: unknown[] = [];
    await rt.stream('t2639.streamed', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId }, async (b) => void batches.push(b));
    expect(batches).toEqual([{ batch: 1 }]);
    expect(seen['t2639.streamed']).toEqual([1]);
  });

  it('refuses a sensitive query inside another query (ctx.query), where its audit could not be committed first', async () => {
    const o = await org();
    await expect(rt.query('t2639.nested', { orgId: o.orgId }, { actor: user(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'SENSITIVE_ONLY' });
    expect(await committedRows(o.orgId, 't2639.owner_read')).toBe(0);
  });

  it('writes no row for an ordinary query, and carries no value of a sensitive one', async () => {
    const o = await org();
    await rt.query('t2639.plain', {}, { actor: user(o.owner), orgId: o.orgId });
    expect(await committedRows(o.orgId, 't2639.plain')).toBe(0);
    await rt.query('t2639.owner_read', { orgId: o.orgId, note: SECRET }, { actor: user(o.owner), orgId: o.orgId });
    const text = await withAdmin(async (c) => (await c.query<{ row: string }>("SELECT audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 't2639.owner_read'", [o.orgId])).rows.map((r) => r.row).join('\n'));
    expect(text).not.toContain(SECRET);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Sealed input (#2666, ADR-0017, the security precondition of #2530) on a real PostgreSQL 17: a command that declares `sealedInput` leaves its sealed values in
// no record of its own. They are masked before the audit hash and the idempotency hash are made, the output, ctx.audit, ctx.emit and ctx.activity refuse them,
// a statement's parameters refuse them, an error loses them, a nested command must declare them, and a canary identity number is found in no column of any
// crove_* table (the outbox, the job tables, activity, security_event, proposal and idempotency_key included) after the runs. A command that runs from a
// proposal cannot declare it.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
// Part of the invariant suite: CI runs this file from the base branch on protected-path PRs (AGENTS.md).
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { DomainError, Runtime, defineCommand, type CommandDef } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A personal number as a person types it, and its digits alone: both are searched for in the whole database.
const NUMBER = '079 123 456 789';
const DIGITS = '079123456789';
const OTHER = '012 987 654 321';

const input = z.object({ name: z.string(), idNumber: z.string(), dependents: z.array(z.object({ taxCode: z.string(), name: z.string() })).default([]) });
const base = { risk: 'R1' as const, sideEffect: 'none' as const, access: ['owner' as const], writes: [] };
const SEALED = ['idNumber', 'dependents[].taxCode'];

suite('sealed input on PostgreSQL (#2666)', () => {
  const dbName = `crove_test_sealed_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  const seen: Record<string, string[]> = {};

  const command = (name: string, handler: CommandDef<unknown, unknown>['handler'], over: Partial<CommandDef<unknown, unknown>> = {}) =>
    defineCommand({ name, input, ...base, sealedInput: SEALED, handler, ...over }) as CommandDef<unknown, unknown>;

  const COMMANDS = [
    command('t2666.ok', async (ctx, i) => {
      const value = i as z.infer<typeof input>;
      // The handler gets the real value.
      (seen['t2666.ok'] ??= []).push(value.idNumber);
      return { length: value.idNumber.length, dependents: value.dependents.map((d) => d.taxCode.length) };
    }),
    command('t2666.echo', async (_ctx, i) => ({ number: (i as z.infer<typeof input>).idNumber })),
    command('t2666.echo_digits', async (_ctx, i) => ({ number: (i as z.infer<typeof input>).idNumber.replace(/\D/g, '') })),
    command('t2666.audit', async (ctx, i) => {
      ctx.audit({ note: (i as z.infer<typeof input>).idNumber });
      return {};
    }),
    command('t2666.emit', async (ctx, i) => {
      await ctx.emit('t2666.thing', { note: (i as z.infer<typeof input>).idNumber });
      return {};
    }),
    command('t2666.activity', async (ctx, i) => {
      await ctx.activity('kernel.party', randomUUID(), 'note', `Số ${(i as z.infer<typeof input>).idNumber}`);
      return {};
    }),
    command('t2666.statement', async (ctx, i) => {
      await sql`SELECT ${(i as z.infer<typeof input>).idNumber}::text AS value`.execute(ctx.trx);
      return {};
    }),
    command('t2666.fail', async (_ctx, i) => {
      const value = (i as z.infer<typeof input>).idNumber;
      throw new DomainError('T2666_FAILED', 422, `Sai số ${value}`, { idNumber: value, field: 'idNumber' });
    }),
    command('t2666.fail_plain', async (_ctx, i) => {
      throw new Error(`could not store ${(i as z.infer<typeof input>).idNumber}`);
    }),
    command('t2666.parent', async (ctx, i) => ctx.run('t2666.child', { name: 'child', idNumber: (i as z.infer<typeof input>).idNumber })),
    command('t2666.child', async () => ({ ok: true })),
    defineCommand({ name: 't2666.child_undeclared', input, ...base, handler: async () => ({ ok: true }) }) as CommandDef<unknown, unknown>,
    command('t2666.parent_undeclared', async (ctx, i) => ctx.run('t2666.child_undeclared', { name: 'child', idNumber: (i as z.infer<typeof input>).idNumber })),
    // A command with no sealed input: unchanged.
    defineCommand({ name: 't2666.plain', input: z.object({ note: z.string() }), ...base, handler: async (_ctx, i) => ({ note: (i as { note: string }).note }) }) as CommandDef<unknown, unknown>,
  ];

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  // Every column of the crove schemas that can hold text or bytes, searched for the number as typed and for its digits: the places it is found.
  const hits = () =>
    withAdmin(async (c) => {
      const cols = (
        await c.query<{ s: string; t: string; c: string; type: string }>(
          `SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c, c.data_type AS type
           FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
           WHERE c.table_schema LIKE 'crove\\_%' AND c.data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'bytea', 'ARRAY', 'USER-DEFINED')`,
        )
      ).rows;
      const found: string[] = [];
      for (const { s, t, c: col, type } of cols) {
        for (const needle of [NUMBER, DIGITS]) {
          const expr = type === 'bytea' ? `position(convert_to($1, 'UTF8') in "${col}") > 0` : `"${col}"::text LIKE '%' || $1 || '%'`;
          const { rowCount } = await c.query(`SELECT 1 FROM "${s}"."${t}" WHERE ${expr} LIMIT 1`, [needle]);
          if (rowCount) found.push(`${s}.${t}.${col}`);
        }
      }
      return [...new Set(found)];
    });

  const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@sealed.test`, name: null });
  const user = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function org() {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, user(owner), `Sealed ${randomUUID().slice(0, 6)}`);
    const run = (name: string, body: unknown, key = randomUUID()) => rt.execute(name, body, { actor: user(owner), orgId, idempotencyKey: key });
    const hashes = (name: string) =>
      withAdmin(async (c) => (await c.query<{ h: string }>('SELECT input_sha256 AS h FROM crove_kernel.audit_event WHERE org_id = $1 AND command = $2 ORDER BY id', [orgId, name])).rows.map((r) => r.h));
    return { orgId, owner, run, hashes };
  }

  const body = (idNumber = NUMBER) => ({ name: 'Person', idNumber, dependents: [{ taxCode: DIGITS, name: 'Child' }] });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const url = new URL(ADMIN as string);
    url.pathname = `/${dbName}`;
    adminUrl = url.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...COMMANDS], queries: kernelQueries({ inboundDomain: null }) });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives the handler the real value, and keeps it out of the audit hash: two runs that differ only in the sealed values hash alike', async () => {
    const o = await org();
    expect(await o.run('t2666.ok', body())).toEqual({ length: NUMBER.length, dependents: [DIGITS.length] });
    expect(seen['t2666.ok']).toEqual([NUMBER]);
    await o.run('t2666.ok', { name: 'Person', idNumber: OTHER, dependents: [{ taxCode: '555555555555', name: 'Child' }] });
    const [first, second] = await o.hashes('t2666.ok');
    expect(first).toBeDefined();
    expect(first).toBe(second);
    // A real field still moves the hash.
    await o.run('t2666.ok', { name: 'Someone else', idNumber: NUMBER, dependents: [] });
    expect((await o.hashes('t2666.ok'))[2]).not.toBe(first);
  });

  it('keeps it out of the idempotency hash and the stored response, and replays under one key', async () => {
    const o = await org();
    const key = randomUUID();
    const answer = await o.run('t2666.ok', body(), key);
    expect(await o.run('t2666.ok', body(), key)).toEqual(answer);
    const rows = await withAdmin(async (c) => (await c.query<{ request_sha256: string; response: unknown }>('SELECT request_sha256, response FROM crove_kernel.idempotency_key WHERE org_id = $1 AND command = $2', [o.orgId, 't2666.ok'])).rows);
    expect(rows).toHaveLength(1);
    // The same key with other sealed values is the same request (the masked hash is equal): it replays the first answer.
    expect(await o.run('t2666.ok', body(OTHER), key)).toEqual(answer);
  });

  it('refuses a command whose output, audit detail, event, activity or statement carries a sealed value, and commits nothing of it', async () => {
    const o = await org();
    for (const name of ['t2666.echo', 't2666.echo_digits', 't2666.audit', 't2666.emit', 't2666.activity', 't2666.statement']) {
      await expect(o.run(name, body()), name).rejects.toThrow();
      expect(await o.hashes(name), `${name} wrote an ok audit row`).toEqual([]);
    }
  });

  it('answers a failure without the value in its message or its details, and logs nothing of it', async () => {
    const o = await org();
    const refused = await o.run('t2666.fail', body()).then(
      () => null,
      (error: unknown) => error as DomainError,
    );
    expect(refused).toBeInstanceOf(DomainError);
    expect(refused?.code).toBe('T2666_FAILED');
    expect(JSON.stringify({ message: refused?.message, details: refused?.details })).not.toContain(DIGITS);
    expect(JSON.stringify({ message: refused?.message, details: refused?.details })).not.toContain(NUMBER);
    const plain = await o.run('t2666.fail_plain', body()).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(plain).not.toBeNull();
    expect(plain?.message).not.toContain(NUMBER);
  });

  it('makes a nested command declare the sealed values it is given, and masks its row too', async () => {
    const o = await org();
    await expect(o.run('t2666.parent_undeclared', body())).rejects.toThrow();
    await o.run('t2666.parent', body());
    const [parent] = await o.hashes('t2666.parent');
    const [child] = await o.hashes('t2666.child');
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
  });

  it('finds the number, as typed and as digits, in no column of any crove table after all of it, and after a refused run', async () => {
    const o = await org();
    for (const name of ['t2666.ok', 't2666.parent']) await o.run(name, body());
    for (const name of ['t2666.echo', 't2666.audit', 't2666.emit', 't2666.activity', 't2666.statement', 't2666.fail', 't2666.fail_plain', 't2666.parent_undeclared']) {
      await o.run(name, body()).catch(() => undefined);
    }
    expect(await hits()).toEqual([]);
  });

  it('leaves a command with no sealed input as it was', async () => {
    const o = await org();
    expect(await o.run('t2666.plain', { note: 'hello' })).toEqual({ note: 'hello' });
  });

  it('refuses at registration a sealedInput on a command that runs from a proposal, an empty list, and a path that is not a path', () => {
    const fresh = () => new Runtime(createDb(pool), { manifests: TEST_MANIFESTS });
    const proposal = defineCommand({ name: 't2666.proposal', input, risk: 'R1', sideEffect: 'none', access: 'proposal', writes: [], sealedInput: SEALED, handler: async () => ({}) }) as CommandDef<unknown, unknown>;
    expect(() => fresh().register({ commands: [proposal] })).toThrow(/proposal/);
    for (const sealedInput of [[], ['id number'], ['a..b'], ['[]'], 'idNumber' as unknown as string[]]) {
      expect(() => fresh().register({ commands: [command('t2666.bad', async () => ({}), { sealedInput })] }), JSON.stringify(sealedInput)).toThrow(/sealedInput/);
    }
  });
});

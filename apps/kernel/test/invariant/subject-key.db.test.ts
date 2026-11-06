// SPDX-License-Identifier: AGPL-3.0-only
// Per-subject keys (#2640, ADR-0017, ADR-0046 point 4) on a real PostgreSQL 17: a value sealed under a person's key sits in a row that cannot change
// (an audit fact), and shredding the person's key makes it unreadable while the row stays byte for byte as it was. No login role reads or writes
// crove_kernel.subject_key; its three definers refuse every context but a user's, each for the org in context only; a sealed value opens only for
// its org, subject and place; a key sealed before a rotation still opens while the old credential key is kept.
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
import { CredentialVault, DomainError, Runtime, SUBJECT_WRAP_INFO, SubjectVault, defineCommand, defineQuery, parseVaultKey, type CommandDef, type QueryDef } from '@crove/kernel-runtime';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { contextToken } from './fixtures/context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// A plain phrase, so no secret scanner takes it for a key; the tests search the whole database for it.
const CANARY = 'identity canary phrase';
const PLACE = 'crove_hr.payroll_employee.national_id';
const ROLES = ['crove_app', 'crove_worker', 'crove_tenant', 'crove_definer_tenant', 'crove_auth_reader'];
const DEFINERS = ['subject_key_ensure(uuid, text, text, bytea)', 'subject_key_wrapped(uuid[])', 'subject_key_shred(text[])'];

suite('per-subject keys on PostgreSQL (#2640)', () => {
  const dbName = `crove_test_subject_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let workerUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let keylessRt: Runtime;
  let workerPool: pg.Pool;
  let workerRt: Runtime;
  const rootOld = parseVaultKey(randomBytes(32).toString('base64'));
  const rootNew = parseVaultKey(randomBytes(32).toString('base64'));
  const vaultOf = (...roots: (typeof rootOld)[]) => new SubjectVault(new CredentialVault(roots).deriveKeys(SUBJECT_WRAP_INFO));
  const clients: pg.Client[] = [];

  // A test-only command that seals a value for a subject and keeps the sealed text in its own audit fact: an append-only row that holds a personal value.
  const SEAL = defineCommand({
    name: 't2640.seal',
    input: z.object({ ref: z.string(), value: z.string(), place: z.string().optional() }),
    risk: 'R1',
    sideEffect: 'none',
    access: ['owner', 'admin', 'member'],
    writes: [],
    handler: async (ctx, input) => {
      const sealed = await ctx.seal(input.ref, input.place ?? PLACE, input.value);
      ctx.audit({ sealed });
      return { sealed };
    },
  }) as CommandDef<unknown, unknown>;
  const OPEN = defineQuery({
    name: 't2640.open',
    input: z.object({ sealed: z.string(), place: z.string().optional(), ref: z.string() }),
    access: ['owner', 'admin', 'member', 'viewer'],
    sensitive: true,
    handler: async (ctx, input) => ctx.open(input.sealed, input.place ?? PLACE, input.ref),
  }) as QueryDef<unknown, unknown>;
  // The same call from a query that is not sensitive, and from a command: refused, so a value never reaches an answer without its audited read.
  const OPEN_PLAIN = defineQuery({
    name: 't2640.open_plain',
    input: z.object({ sealed: z.string(), ref: z.string() }),
    access: ['owner'],
    handler: async (ctx, input) => ctx.open(input.sealed, PLACE, input.ref),
  }) as QueryDef<unknown, unknown>;
  const OPEN_IN_COMMAND = defineCommand({
    name: 't2640.open_in_command',
    input: z.object({ sealed: z.string(), ref: z.string() }),
    risk: 'R1',
    sideEffect: 'none',
    access: ['owner'],
    writes: [],
    handler: async (ctx, input) => ({ value: await ctx.open(input.sealed, PLACE, input.ref) }),
  }) as CommandDef<unknown, unknown>;
  // The same two steps for the system, which must be refused them.
  const SEAL_AS_SYSTEM = defineCommand({
    name: 't2640.seal_as_system',
    input: z.object({ ref: z.string() }),
    risk: 'R1',
    sideEffect: 'none',
    access: 'system',
    writes: [],
    handler: async (ctx, input) => ({ sealed: await ctx.seal(input.ref, PLACE, CANARY) }),
  }) as CommandDef<unknown, unknown>;
  const OPEN_AS_SYSTEM = defineQuery({
    name: 't2640.open_as_system',
    input: z.object({ sealed: z.string(), ref: z.string() }),
    access: 'system',
    sensitive: true,
    handler: async (ctx, input) => ctx.open(input.sealed, PLACE, input.ref),
  }) as QueryDef<unknown, unknown>;

  async function withAdmin<T>(fn: (admin: pg.Client) => Promise<T>): Promise<T> {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  }

  async function connect(url: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    clients.push(client);
    return client;
  }

  // Runs fn as the API login in the user's sealed context of the org; rolls back, or commits when asked (a shred is real only when committed).
  async function inUserContext<T>(userId: string, orgId: string, fn: (c: pg.Client) => Promise<T>, commit = false): Promise<T> {
    const app = await connect(appUrl);
    await app.query('BEGIN');
    try {
      await app.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [orgId, contextToken(userId, orgId)]);
      const result = await fn(app);
      await app.query(commit ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      await app.query('ROLLBACK');
      throw error;
    }
  }

  const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@subject.test`, name: null });
  const user = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function org() {
    const owner = await person('owner');
    const admin = await person('admin');
    const member = await person('member');
    const viewer = await person('viewer');
    const { orgId } = await createOrg(rt, user(owner), `Subject ${randomUUID().slice(0, 6)}`);
    await withAdmin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, admin, member, viewer]),
    );
    const seal = (actor: string, ref: string, value = CANARY, place?: string) =>
      rt.execute<{ sealed: string }>('t2640.seal', { ref, value, ...(place ? { place } : {}) }, { actor: user(actor), orgId, idempotencyKey: randomUUID() });
    const refOf = async (sealed: string) => {
      const subject = sealed.split(':')[2] ?? '';
      if (!/^[0-9a-f-]{36}$/.test(subject)) return 'employee:none';
      const rows = await withAdmin(async (c) => (await c.query<{ ref: string }>('SELECT ref FROM crove_kernel.subject_key WHERE id = $1::uuid', [subject])).rows);
      // A subject with no key row (shredded, or another org's): any well-formed ref, the answer is erased whatever it is.
      return rows[0]?.ref ?? 'employee:none';
    };
    const open = async (actor: string, sealed: string, place?: string, runtime = rt, ref?: string) =>
      runtime.query('t2640.open', { sealed, ref: ref ?? (await refOf(sealed)), ...(place ? { place } : {}) }, { actor: user(actor), orgId });
    return { orgId, owner, admin, member, viewer, seal, open };
  }

  // Every column of the crove schemas that can hold text or bytes, searched for the canary: the places it is found, none expected.
  const canaryHits = () =>
    withAdmin(async (c) => {
      const cols = (
        await c.query<{ s: string; t: string; c: string; type: string }>(
          `SELECT c.table_schema AS s, c.table_name AS t, c.column_name AS c, c.data_type AS type
           FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
           WHERE c.table_schema LIKE 'crove\\_%' AND c.data_type IN ('text', 'character varying', 'character', 'jsonb', 'json', 'bytea', 'ARRAY', 'USER-DEFINED')`,
        )
      ).rows;
      const hits: string[] = [];
      for (const { s, t, c: col, type } of cols) {
        const expr = type === 'bytea' ? `position(convert_to($1, 'UTF8') in "${col}") > 0` : `"${col}"::text LIKE '%' || $1 || '%'`;
        const { rowCount } = await c.query(`SELECT 1 FROM "${s}"."${t}" WHERE ${expr} LIMIT 1`, [CANARY]);
        if (rowCount) hits.push(`${s}.${t}.${col}`);
      }
      return hits;
    });

  const subjectRows = (orgId: string) => withAdmin(async (c) => (await c.query<{ ref: string }>('SELECT ref FROM crove_kernel.subject_key WHERE org_id = $1 ORDER BY ref', [orgId])).rows.map((r) => r.ref));
  const auditText = (orgId: string) =>
    withAdmin(async (c) => (await c.query<{ row: string }>("SELECT audit_event::text AS row FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 't2640.seal' ORDER BY id", [orgId])).rows.map((r) => r.row).join('\n'));

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
    const login = (user_: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user_;
      url.password = password;
      return url.toString();
    };
    appUrl = login('crove_app', 'test-app-pw');
    workerUrl = login('crove_worker', 'test-worker-pw');
    pool = createPool({ connectionString: appUrl, max: 6 });
    const register = (runtime: Runtime) => runtime.register({ commands: [...kernelCommands, SEAL, OPEN_IN_COMMAND], queries: [...kernelQueries({ inboundDomain: null }), OPEN, OPEN_PLAIN] });
    rt = register(new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, subjectVault: vaultOf(rootOld) }));
    keylessRt = register(new Runtime(createDb(pool), { manifests: TEST_MANIFESTS }));
    workerPool = createPool({ connectionString: workerUrl, max: 2 });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS, subjectVault: vaultOf(rootOld) }).register({ commands: [...kernelCommands, SEAL_AS_SYSTEM], queries: [...kernelQueries({ inboundDomain: null }), OPEN_AS_SYSTEM] });
  }, 120_000);

  afterAll(async () => {
    for (const c of clients) await c.end().catch(() => {});
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is out of reach of every login role, with row security on, and its three definers are pinned and callable by the API login alone', async () => {
    const { grants, rls, functions } = await withAdmin(async (c) => ({
      grants: (
        await c.query<{ role: string; op: string }>(
          `SELECT r AS role, p AS op FROM unnest($1::text[]) r, unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
           WHERE has_table_privilege(r, 'crove_kernel.subject_key', p) ORDER BY 1, 2`,
          [ROLES],
        )
      ).rows,
      rls: (await c.query<{ relrowsecurity: boolean }>("SELECT relrowsecurity FROM pg_class WHERE oid = 'crove_kernel.subject_key'::regclass")).rows[0]?.relrowsecurity,
      functions: (
        await c.query<{ sig: string; definer: boolean; path: string[] | null; roles: string[] }>(
          `SELECT f AS sig, p.prosecdef AS definer, p.proconfig AS path,
                  ARRAY(SELECT r FROM unnest($2::text[]) r WHERE has_function_privilege(r, p.oid, 'EXECUTE') ORDER BY 1) AS roles
           FROM unnest($1::text[]) f, pg_proc p WHERE p.oid = ('crove_kernel.' || f)::regprocedure ORDER BY 1`,
          [DEFINERS, [...ROLES, 'public']],
        )
      ).rows,
    }));
    expect(grants).toEqual([]);
    expect(rls).toBe(true);
    expect(functions.map((f) => f.sig).sort()).toEqual([...DEFINERS].sort());
    for (const f of functions) {
      expect(f.definer, f.sig).toBe(true);
      expect(f.path, f.sig).toEqual(['search_path=pg_catalog, pg_temp']);
      // The worker has no definer: it never seals or opens a subject value (ADR-0017 section 4).
      expect(f.roles, f.sig).toEqual(['crove_app']);
    }
  });

  it('seals a value in an audit fact under the person key, opens it for members and viewers, and keeps the value out of the database', async () => {
    const o = await org();
    const ref = `employee:${randomUUID()}`;
    const { sealed } = await o.seal(o.owner, ref);
    expect(sealed).toMatch(/^crove:s1:[0-9a-f-]{36}:[A-Za-z0-9_-]+$/);
    for (const who of [o.owner, o.admin, o.member, o.viewer]) expect(await o.open(who, sealed), who).toBe(CANARY);
    expect(await subjectRows(o.orgId)).toEqual([ref]);
    // The plaintext is in no text, jsonb or bytea column of any crove table.
    const found = await canaryHits();
    expect(found).toEqual([]);
    expect(await auditText(o.orgId)).toContain(sealed);
  });

  it('reuses one key for one subject, and two concurrent seals converge on a single row', async () => {
    const o = await org();
    const ref = `employee:${randomUUID()}`;
    const [a, b, c] = await Promise.all([o.seal(o.owner, ref, 'one'), o.seal(o.admin, ref, 'two'), o.seal(o.owner, ref, 'three')]);
    expect(await subjectRows(o.orgId)).toEqual([ref]);
    expect(await Promise.all([o.open(o.owner, a.sealed), o.open(o.owner, b.sealed), o.open(o.owner, c.sealed)])).toEqual(['one', 'two', 'three']);
    const subjects = new Set([a.sealed, b.sealed, c.sealed].map((s) => s.split(':')[2]));
    expect(subjects.size).toBe(1);
  });

  it('shreds: the value reads as erased, and the row that holds it is byte for byte unchanged', async () => {
    const o = await org();
    const refA = `employee:${randomUUID()}`;
    const refB = `employee:${randomUUID()}`;
    const a = await o.seal(o.owner, refA);
    const b = await o.seal(o.owner, refB, 'kept');
    const before = await auditText(o.orgId);
    expect(before).toContain(a.sealed);
    const shredded = await inUserContext(o.owner, o.orgId, async (c) => (await c.query<{ n: number }>('SELECT crove_kernel.subject_key_shred($1::text[]) AS n', [[refA]])).rows[0]?.n, true);
    expect(shredded).toBe(1);
    expect(await subjectRows(o.orgId)).toEqual([refB]);
    expect(await o.open(o.owner, a.sealed)).toEqual({ erased: true });
    expect(await o.open(o.owner, b.sealed)).toBe('kept');
    // An audit row is append-only: nothing about it changed, and the value was never in it, before or after.
    expect(await auditText(o.orgId)).toBe(before);
    expect(await auditText(o.orgId)).not.toContain(CANARY);
    expect(await canaryHits()).toEqual([]);
  });

  it('lets only an owner shred, only in a user context, and answers how many keys went', async () => {
    const o = await org();
    const ref = `employee:${randomUUID()}`;
    await o.seal(o.owner, ref);
    const shred = (who: string) => inUserContext(who, o.orgId, (c) => c.query<{ n: number }>('SELECT crove_kernel.subject_key_shred($1::text[]) AS n', [[ref]]));
    for (const who of [o.admin, o.member, o.viewer]) await expect(shred(who), who).rejects.toMatchObject({ code: '42501', message: 'SUBJECT_KEY_FORBIDDEN' });
    expect(await subjectRows(o.orgId)).toEqual([ref]);
    const done = await inUserContext(o.owner, o.orgId, (c) => c.query<{ n: number }>('SELECT crove_kernel.subject_key_shred($1::text[]) AS n', [[ref, `employee:${randomUUID()}`]]), true);
    expect(done.rows[0]?.n).toBe(1);
    expect(await subjectRows(o.orgId)).toEqual([]);
  });

  it('refuses the definers with no context, to the system, to a viewer for ensure, and for the worker login', async () => {
    const o = await org();
    const call = (c: pg.Client) => c.query("SELECT * FROM crove_kernel.subject_key_ensure($1::uuid, 'employee:x', 'k1-test', decode(repeat('00', 60), 'hex'))", [randomUUID()]);
    const app = await connect(appUrl);
    await app.query('BEGIN');
    await expect(call(app)).rejects.toMatchObject({ code: '42501', message: 'NO_CONTEXT' });
    await app.query('ROLLBACK');
    await expect(inUserContext(o.viewer, o.orgId, call)).rejects.toMatchObject({ code: '42501', message: 'SUBJECT_KEY_FORBIDDEN' });
    const worker = await connect(workerUrl);
    await worker.query('BEGIN');
    await worker.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
    await expect(call(worker)).rejects.toMatchObject({ code: '42501' });
    await worker.query('ROLLBACK');
    await worker.query('BEGIN');
    await expect(worker.query('SELECT * FROM crove_kernel.subject_key_wrapped($1::uuid[])', [[randomUUID()]])).rejects.toMatchObject({ code: '42501' });
    await worker.query('ROLLBACK');
  });

  it('answers wrapped keys for the org in context only', async () => {
    const a = await org();
    const b = await org();
    const { sealed } = await a.seal(a.owner, `employee:${randomUUID()}`);
    const subjectId = sealed.split(':')[2] as string;
    const ask = (o: Awaited<ReturnType<typeof org>>) => inUserContext(o.owner, o.orgId, async (c) => (await c.query('SELECT * FROM crove_kernel.subject_key_wrapped($1::uuid[])', [[subjectId]])).rows);
    expect(await ask(a)).toHaveLength(1);
    expect(await ask(b)).toEqual([]);
    // A sealed value moved to another org reads as erased there: that org has no key under the subject, and a plaintext is never answered.
    expect(await b.open(b.owner, sealed)).toEqual({ erased: true });
  });

  it('does not open a value read from another place, and fails loudly rather than answering', async () => {
    const o = await org();
    const { sealed } = await o.seal(o.owner, `employee:${randomUUID()}`);
    await expect(o.open(o.owner, sealed, 'crove_hr.payroll_employee.bank_account')).rejects.toBeInstanceOf(DomainError);
    await expect(o.open(o.owner, '079123456789')).rejects.toBeInstanceOf(DomainError);
  });

  it('answers 503 for a deployment with no credential key, and refuses a malformed reference', async () => {
    const o = await org();
    await expect(
      keylessRt.execute('t2640.seal', { ref: `employee:${randomUUID()}`, value: CANARY }, { actor: user(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'BROKER_NOT_CONFIGURED', status: 503 });
    await expect(o.seal(o.owner, 'not a reference')).rejects.toBeInstanceOf(DomainError);
    expect(await subjectRows(o.orgId)).toEqual([]);
  });

  it('still opens a value sealed before a rotation of the credential key while the old key is kept, and not once it is dropped', async () => {
    const o = await org();
    const { sealed } = await o.seal(o.owner, `employee:${randomUUID()}`);
    const rotated = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, subjectVault: vaultOf(rootNew, rootOld) }).register({ commands: [...kernelCommands, SEAL], queries: [...kernelQueries({ inboundDomain: null }), OPEN] });
    expect(await o.open(o.owner, sealed, undefined, rotated)).toBe(CANARY);
    const dropped = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, subjectVault: vaultOf(rootNew) }).register({ commands: [...kernelCommands, SEAL], queries: [...kernelQueries({ inboundDomain: null }), OPEN] });
    await expect(o.open(o.owner, sealed, undefined, dropped)).rejects.toBeInstanceOf(DomainError);
  });
  it('does not open a sealed value for a subject other than the one the row belongs to', async () => {
    const o = await org();
    const x = `employee:${randomUUID()}`;
    const y = `employee:${randomUUID()}`;
    const { sealed } = await o.seal(o.owner, x);
    await o.seal(o.owner, y, 'other');
    expect(await o.open(o.owner, sealed, undefined, rt, x)).toBe(CANARY);
    // The text of X's value stored in Y's record: it does not read as Y's.
    await expect(o.open(o.owner, sealed, undefined, rt, y)).rejects.toBeInstanceOf(DomainError);
  });

  it('refuses ctx.seal and ctx.open to the system, which never seals or opens a personal value', async () => {
    const o = await org();
    const ref = `employee:${randomUUID()}`;
    const { sealed } = await o.seal(o.owner, ref);
    const system = { type: 'system' as const, component: 't2640-worker' };
    await expect(workerRt.execute('t2640.seal_as_system', { ref }, { actor: system, orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'subject_user_only' } });
    await expect(workerRt.query('t2640.open_as_system', { sealed, ref }, { actor: system, orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'sensitive_user_only' } });
  });
  it('opens a value only in a sensitive query: a command and an ordinary query are refused', async () => {
    const o = await org();
    const ref = `employee:${randomUUID()}`;
    const { sealed } = await o.seal(o.owner, ref);
    await expect(rt.execute('t2640.open_in_command', { sealed, ref }, { actor: user(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'open_sensitive_only' } });
    await expect(rt.query('t2640.open_plain', { sealed, ref }, { actor: user(o.owner), orgId: o.orgId })).rejects.toMatchObject({ code: 'FORBIDDEN', details: { rule: 'open_sensitive_only' } });
    // The sensitive query opens it, and its read is audited first.
    expect(await o.open(o.owner, sealed, undefined, rt, ref)).toBe(CANARY);
    expect(await withAdmin(async (c) => Number((await c.query<{ n: string }>("SELECT count(*) AS n FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 't2640.open'", [o.orgId])).rows[0]?.n))).toBe(1);
  });

  it('refuses a contact reference that is not a keyed hash, since the reference is stored in the clear', async () => {
    const o = await org();
    await expect(o.seal(o.owner, 'contact:079123456789')).rejects.toBeInstanceOf(DomainError);
    await expect(o.seal(o.owner, `contact:${'ab'.repeat(32)}`)).resolves.toMatchObject({ sealed: expect.stringMatching(/^crove:s1:/) });
    expect(await subjectRows(o.orgId)).toEqual([`contact:${'ab'.repeat(32)}`]);
  });

  it('makes a shred wait for the seal that holds the key, and then delete the key with its value', async () => {
    const o = await org();
    const ref = `employee:${randomUUID()}`;
    await o.seal(o.owner, ref);
    const sealing = await connect(appUrl);
    const shredding = await connect(appUrl);
    const enter = (c: pg.Client, who: string) => c.query('SELECT crove_kernel.enter_user_context($1::uuid, $2::text)', [o.orgId, contextToken(who, o.orgId)]);
    await sealing.query('BEGIN');
    await enter(sealing, o.owner);
    // A seal in progress: ensure answers the stored key and holds it until this transaction ends.
    await sealing.query("SELECT * FROM crove_kernel.subject_key_ensure($1::uuid, $2, 'k1-x', decode(repeat('00', 60), 'hex'))", [randomUUID(), ref]);
    await shredding.query('BEGIN');
    await enter(shredding, o.owner);
    await shredding.query("SET LOCAL lock_timeout = '400ms'");
    await expect(shredding.query('SELECT crove_kernel.subject_key_shred($1::text[])', [[ref]])).rejects.toMatchObject({ code: '55P03' });
    await shredding.query('ROLLBACK');
    await sealing.query('COMMIT');
    await shredding.query('BEGIN');
    await enter(shredding, o.owner);
    expect((await shredding.query<{ n: number }>('SELECT crove_kernel.subject_key_shred($1::text[]) AS n', [[ref]])).rows[0]?.n).toBe(1);
    await shredding.query('COMMIT');
    expect(await subjectRows(o.orgId)).toEqual([]);
  });
});

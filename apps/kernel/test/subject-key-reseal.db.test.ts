// SPDX-License-Identifier: AGPL-3.0-only
// The reseal pass for subject keys (#2643, ADR-0017 section 7) on a real PostgreSQL 17: after a credential key rotation the worker wraps every subject key again under the current
// key, so CREDENTIAL_KEY_PREVIOUS can go and a value sealed before the rotation still opens. Only wrapped data keys move (the rows that hold sealed values are untouched); a key
// under an unknown key id is reported and left as it is; a subject shredded between the read and the write changes nothing; the definers answer the worker login alone, and the write
// only in the system context of the org; the audit row names key ids and counts, never the bytes.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; the run creates and drops its own database.
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { CredentialVault, Runtime, SUBJECT_WRAP_INFO, SubjectVault, defineCommand, defineQuery, parseVaultKey, type CommandDef, type QueryDef } from '@crove/kernel-runtime';
import { resealSubjectKeys, subjectVaultOfBroker, unopenableSubjectKeysLog } from '../src/subject-key-reseal.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const PLACE = 'crove_hr.payroll_employee.national_id_sealed';
const VALUE = '079 123 456 789';

suite('the reseal pass for subject keys on PostgreSQL (#2643)', () => {
  const dbName = `crove_test_reseal_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let appRt: Runtime;
  let workerRt: Runtime;
  const rootOld = parseVaultKey(randomBytes(32).toString('base64'));
  const rootNew = parseVaultKey(randomBytes(32).toString('base64'));
  const vaultOf = (...roots: (typeof rootOld)[]) => new SubjectVault(new CredentialVault(roots).deriveKeys(SUBJECT_WRAP_INFO));
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const system = { type: 'system' as const, component: 'kernel.subject_key.reseal' };

  const SEAL = defineCommand({
    name: 't2643.seal',
    input: z.object({ ref: z.string(), value: z.string() }),
    risk: 'R1',
    sideEffect: 'none',
    access: ['owner'],
    writes: [],
    handler: async (ctx, input) => ({ sealed: await ctx.seal(input.ref, PLACE, input.value) }),
  }) as CommandDef<unknown, unknown>;
  const OPEN = defineQuery({
    name: 't2643.open',
    input: z.object({ sealed: z.string(), ref: z.string() }),
    access: ['owner'],
    sensitive: true,
    handler: async (ctx, input) => ctx.open(input.sealed, PLACE, input.ref),
  }) as QueryDef<unknown, unknown>;

  async function withAdmin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  }

  async function org() {
    const person = await upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@reseal.test`, name: null });
    const { orgId } = await createOrg(appRt, asUser(person), `Reseal ${randomUUID().slice(0, 6)}`);
    const seal = async (ref = `employee:${randomUUID()}`) => ({ ref, ...(await appRt.execute<{ sealed: string }>('t2643.seal', { ref, value: VALUE }, { actor: asUser(person), orgId, idempotencyKey: randomUUID() })) });
    const open = (runtime: Runtime, sealed: string, ref: string) => runtime.query('t2643.open', { sealed, ref }, { actor: asUser(person), orgId });
    const rowOf = async (ref: string) =>
      withAdmin(async (c) => (await c.query<{ id: string; key_id: string; wrapped_key: Buffer }>('SELECT id, key_id, wrapped_key FROM crove_kernel.subject_key WHERE org_id = $1 AND ref = $2', [orgId, ref])).rows[0]);
    return { orgId, person, seal, open, rowOf };
  }

  const pass = (vault: SubjectVault) => resealSubjectKeys({ runtime: workerRt, vault, workerDb: createDb(workerPool) });
  const rotatedRuntime = () =>
    new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, subjectVault: vaultOf(rootNew) }).register({ commands: [...kernelCommands, SEAL], queries: [...kernelQueries({ inboundDomain: null }), OPEN] });

  beforeAll(async () => {
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`CREATE DATABASE ${dbName}`);
    await rootDb.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const login = (user: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = user;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 3 });
    appRt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, subjectVault: vaultOf(rootOld) }).register({ commands: [...kernelCommands, SEAL], queries: [...kernelQueries({ inboundDomain: null }), OPEN] });
    workerRt = new Runtime(createDb(workerPool), { manifests: TEST_MANIFESTS }).register({ commands: kernelCommands, queries: kernelQueries({ inboundDomain: null }) });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const rootDb = new pg.Client({ connectionString: ADMIN });
    await rootDb.connect();
    await rootDb.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await rootDb.end();
  });

  it('rewraps every key under the current one: a value sealed before the rotation opens after the pass with the previous key removed, and its row is untouched', async () => {
    const o = await org();
    const first = await o.seal();
    const second = await o.seal();
    const before = await o.rowOf(first.ref);
    expect(before?.key_id).toBe(vaultOf(rootOld).keyId);
    const done = await pass(vaultOf(rootNew, rootOld));
    expect(done.resealed).toBeGreaterThanOrEqual(2);
    expect(done.failed).toBe(0);
    expect(done.skipped).toBe(false);
    const after = await o.rowOf(first.ref);
    expect(after?.key_id).toBe(vaultOf(rootNew).keyId);
    expect(after?.wrapped_key.equals(before?.wrapped_key ?? Buffer.alloc(0))).toBe(false);
    expect((await o.rowOf(second.ref))?.key_id).toBe(vaultOf(rootNew).keyId);
    // The previous key is gone: the same sealed text still reads.
    const rotated = rotatedRuntime();
    expect(await o.open(rotated, first.sealed, first.ref)).toBe(VALUE);
    expect(await o.open(rotated, second.sealed, second.ref)).toBe(VALUE);
    // Nothing is left under an older key in this org, and a second pass finds nothing to do.
    const again = await pass(vaultOf(rootNew, rootOld));
    expect(again.resealed).toBe(0);
    expect(again.left).toBe(0);
  });

  it('writes one audit row per org with counts and key ids, and nothing of the wrapped bytes', async () => {
    const o = await org();
    const sealed = await o.seal();
    const row = await o.rowOf(sealed.ref);
    await pass(vaultOf(rootNew, rootOld));
    const rows = await withAdmin(async (c) => (await c.query<{ row: string; detail: Record<string, unknown> }>("SELECT audit_event::text AS row, detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'kernel.subject_key.reseal'", [o.orgId])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ resealed: 1, unchanged: 0, from_key_ids: [vaultOf(rootOld).keyId], key_ids: [vaultOf(rootNew).keyId] });
    expect(rows[0]?.row).not.toContain(Buffer.from(row?.wrapped_key ?? Buffer.alloc(0)).toString('base64'));
    expect(rows[0]?.row).not.toContain(VALUE);
    expect(rows[0]?.row).not.toContain(row?.id ?? 'x');
  });

  it('reports a key under an unknown key id and leaves it as it is, never dropping it', async () => {
    const o = await org();
    const lost = await o.seal();
    const fine = await o.seal();
    // Re-wrapped by a key the worker no longer holds: a key id of another root, as if CREDENTIAL_KEY_PREVIOUS had been removed too early.
    const unknownId = 'k1-ffffffffffffffff';
    await withAdmin((c) => c.query('UPDATE crove_kernel.subject_key SET key_id = $1 WHERE org_id = $2 AND ref = $3', [unknownId, o.orgId, lost.ref]));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const done = await pass(vaultOf(rootNew, rootOld));
      expect(done.failed).toBeGreaterThanOrEqual(1);
      expect(done.unopenable).toContainEqual({ keyId: unknownId, count: 1 });
      const text = logged.mock.calls.flat().map(String).join(' ');
      expect(text).not.toContain(VALUE);
      expect(text).toContain(unknownId);
      // Key ids and counts only: no subject id and no wrapped bytes.
      const lostRow = await o.rowOf(lost.ref);
      expect(text).not.toContain(lostRow?.id ?? 'x');
      expect(text).not.toContain(Buffer.from(lostRow?.wrapped_key ?? Buffer.alloc(1)).toString('base64'));
    } finally {
      logged.mockRestore();
    }
    expect((await o.rowOf(lost.ref))?.key_id).toBe(unknownId);
    expect((await o.rowOf(fine.ref))?.key_id).toBe(vaultOf(rootNew).keyId);
    expect(unopenableSubjectKeysLog([{ keyId: unknownId, count: 1 }])[0]).toContain(unknownId);
    expect(unopenableSubjectKeysLog([])).toEqual([]);
  });

  it('changes nothing for a subject shredded or already resealed between the read and the write, and refuses a same-key or malformed write', async () => {
    const o = await org();
    const sealed = await o.seal();
    const row = await o.rowOf(sealed.ref);
    if (!row) throw new Error('no row');
    const oldVault = vaultOf(rootOld);
    const next = vaultOf(rootNew, rootOld).rewrap(o.orgId, row.id, row.key_id, row.wrapped_key);
    const item = { id: row.id, fromKeyId: row.key_id, fromWrapped: row.wrapped_key.toString('base64'), keyId: next.keyId, wrapped: next.wrapped.toString('base64') };
    const run = (items: unknown[]) => workerRt.execute<{ resealed: number; skipped: number }>('kernel.subject_key.reseal', { items }, { actor: system, orgId: o.orgId });
    // The bytes the worker read are not the stored ones (another pass got there first): nothing changes.
    expect(await run([{ ...item, fromWrapped: oldVault.newDataKey(o.orgId, row.id).wrapped.toString('base64') }])).toEqual({ resealed: 0, skipped: 1 });
    expect((await o.rowOf(sealed.ref))?.key_id).toBe(row.key_id);
    // Shredded in between: no row, no change, no error.
    await withAdmin((c) => c.query('DELETE FROM crove_kernel.subject_key WHERE org_id = $1 AND id = $2', [o.orgId, row.id]));
    expect(await run([item])).toEqual({ resealed: 0, skipped: 1 });
    expect(await o.rowOf(sealed.ref)).toBeUndefined();
    // The definer refuses a write that names the same key id.
    const other = await o.seal();
    const otherRow = await o.rowOf(other.ref);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(run([{ id: otherRow?.id, fromKeyId: otherRow?.key_id, fromWrapped: otherRow?.wrapped_key.toString('base64'), keyId: otherRow?.key_id, wrapped: otherRow?.wrapped_key.toString('base64') }])).rejects.toThrow();
    } finally {
      logged.mockRestore();
    }
    expect((await o.rowOf(other.ref))?.key_id).toBe(vaultOf(rootOld).keyId);
  });

  it('answers the worker login alone, and writes only in the system context of an org', async () => {
    const o = await org();
    const sealed = await o.seal();
    const row = await o.rowOf(sealed.ref);
    if (!row) throw new Error('no row');
    const call = (client: pg.Pool, text: string, params: unknown[] = []) => client.query(text, params);
    // The API login has no EXECUTE on any of the three definers.
    await expect(call(pool, 'SELECT * FROM crove_kernel.subject_key_reseal_due($1, 10, NULL, NULL)', ['x'])).rejects.toMatchObject({ code: '42501' });
    await expect(call(pool, 'SELECT * FROM crove_kernel.subject_key_key_counts()')).rejects.toMatchObject({ code: '42501' });
    await expect(call(pool, 'SELECT crove_kernel.subject_key_reseal($1::uuid, $2, $3, $4, $5)', [row.id, row.key_id, row.wrapped_key, 'k-new', Buffer.alloc(60)])).rejects.toMatchObject({ code: '42501' });
    // The worker login reads, but the write needs the system context of an org: outside one it is refused.
    expect((await call(workerPool, 'SELECT * FROM crove_kernel.subject_key_key_counts()')).rowCount).toBeGreaterThan(0);
    await expect(call(workerPool, 'SELECT crove_kernel.subject_key_reseal($1::uuid, $2, $3, $4, $5)', [row.id, row.key_id, row.wrapped_key, 'k-new', Buffer.alloc(60)])).rejects.toMatchObject({ message: 'SUBJECT_KEY_SYSTEM_CONTEXT' });
    // The command itself is the system's: a user is refused, and the row stays under its key.
    await expect(appRt.execute('kernel.subject_key.reseal', { items: [{ id: row.id, fromKeyId: row.key_id, fromWrapped: row.wrapped_key.toString('base64'), keyId: 'k-new', wrapped: Buffer.alloc(60).toString('base64') }] }, { actor: asUser(o.person), orgId: o.orgId })).rejects.toBeInstanceOf(Error);
    expect((await o.rowOf(sealed.ref))?.key_id).toBe(row.key_id);
  });

  it('builds the worker vault from the broker, wiping what it derived, and none without a key', () => {
    expect(subjectVaultOfBroker(undefined)).toBeNull();
    const credentials = new CredentialVault([rootNew, rootOld]);
    const vault = subjectVaultOfBroker(credentials as never);
    expect(vault?.keyId).toBe(vaultOf(rootNew).keyId);
    expect(vault?.keyIds).toEqual([vaultOf(rootNew).keyId, vaultOf(rootOld).keyId]);
  });
});

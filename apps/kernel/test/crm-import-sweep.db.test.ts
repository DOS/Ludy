// SPDX-License-Identifier: AGPL-3.0-only
// The sweep of contact import staging past its 7 days (#2251, docs/plan/crm.md step K5b) on PostgreSQL 17: the definer that
// lists the orgs answers the worker login alone and only ids, the system command clears one org's batches without touching
// another's, a younger or decided batch keeps what it has, and a whole pass reaches an org that never imports again. Set
// CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { ImportPreview } from '@crove/kernel-contract';
import { crmCommands, crmQueries } from '@crove/mod-crm';
import { Runtime } from '@crove/kernel-runtime';
import { sweepCrmImports } from '../src/crm-worker.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SYSTEM = { type: 'system' as const, component: 'crm.import' };

suite('crm import staging sweep on PostgreSQL (#2251)', () => {
  const dbName = `crove_test_crm_import_sweep_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  const pools: pg.Pool[] = [];
  let app: Runtime;
  let worker: Runtime;
  let workerDb: Db;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const login = (username: string, password: string) => {
    const url = new URL(adminUrl);
    url.username = username;
    url.password = password;
    const pool = createPool({ connectionString: url.toString(), max: 4 });
    pools.push(pool);
    return pool;
  };

  async function org() {
    const tag = randomUUID().slice(0, 8);
    const owner = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'sweep', subject: `owner-${tag}`, email: `owner-${tag}@sweep.test`, name: null });
    const { orgId } = await createOrg(app, asUser(owner), `Nhập ${tag}`);
    // A person stages one open batch at a time (staging again cancels the earlier one), so a test that needs several open
    // batches stages each as a member of its own.
    const stage = (name: string, as = owner) =>
      app.execute<ImportPreview>('crm.import.stage', { filename: 'lien-he.csv', rows: [{ kind: null, name, taxCode: null, email: null, phone: null, address: null }] }, { actor: asUser(as), orgId });
    const member = async () => {
      const user = await upsertIdentity(createDb(pools[0] as pg.Pool), { issuer: 'sweep', subject: `member-${randomUUID()}`, email: `member-${randomUUID().slice(0, 8)}@sweep.test`, name: null });
      await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, user]));
      return user;
    };
    const rows = (batchId: string) => admin((c) => c.query('SELECT 1 FROM crove_crm.import_row WHERE org_id = $1 AND batch_id = $2', [orgId, batchId]).then((r) => r.rowCount ?? 0));
    const age = (batchId: string, days: number) => admin((c) => c.query(`UPDATE crove_crm.import_batch SET created_at = now() - make_interval(days => $3) WHERE org_id = $1 AND id = $2`, [orgId, batchId, days]));
    const status = (batchId: string) => admin((c) => c.query<{ status: string }>('SELECT status FROM crove_crm.import_batch WHERE org_id = $1 AND id = $2', [orgId, batchId]).then((r) => r.rows[0]?.status));
    return { orgId, owner, stage, member, rows, age, status };
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
    const registered = (db: Db) => new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...crmCommands], queries: [...kernelQueries({ inboundDomain: null }), ...crmQueries] });
    app = registered(createDb(login('crove_app', 'test-app-pw')));
    workerDb = createDb(login('crove_worker', 'test-worker-pw'));
    worker = registered(workerDb);
  }, 300_000);

  afterAll(async () => {
    for (const pool of pools) await pool.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists the orgs with a staged batch past the cutoff to the worker login alone, as ids only', async () => {
    const stale = await org();
    const fresh = await org();
    const old = await stale.stage('Cũ');
    await stale.age(old.batch.id, 8);
    await fresh.stage('Mới');
    // As the worker login it answers the stale org and not the fresh one.
    const asWorker = await sweepList(workerDb);
    expect(asWorker.every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(asWorker).toContain(stale.orgId);
    expect(asWorker).not.toContain(fresh.orgId);
  });

  it('refuses every other login, and the worker from inside an org', async () => {
    const o = await org();
    const asApp = login('crove_app', 'test-app-pw');
    await expect(asApp.query("SELECT * FROM crove_crm.import_expired(now() - interval '7 days', 10)")).rejects.toMatchObject({ code: '42501' });
    // No tenant or app role holds EXECUTE on it, and the worker login does.
    const grants = await admin((c) =>
      c.query<{ role: string; ok: boolean }>("SELECT r AS role, has_function_privilege(r, 'crove_crm.import_expired(timestamptz, integer)', 'EXECUTE') AS ok FROM unnest(ARRAY['crove_tenant', 'crove_app', 'crove_worker', 'crove_definer_tenant']) AS r"),
    );
    expect(new Map(grants.rows.map((g) => [g.role, g.ok]))).toEqual(new Map([['crove_tenant', false], ['crove_app', false], ['crove_worker', true], ['crove_definer_tenant', false]]));
    // Nor can the command be run by a person: refused by its access rule, not by some other failure.
    await expect(app.execute('crm.import.expire', {}, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
  });

  it('refuses the worker login from inside an org context', async () => {
    const o = await org();
    const client = await login('crove_worker', 'test-worker-pw').connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT crove_kernel.enter_system_context($1::uuid)', [o.orgId]);
      await expect(client.query("SELECT * FROM crove_crm.import_expired(now() - interval '7 days', 10)")).rejects.toMatchObject({ code: '42501', message: 'CRM_WORKER_ONLY' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('leaves a batch alone that was committed while the sweep waited on it: never a committed batch overwritten as expired', async () => {
    const o = await org();
    const old = await o.stage('Vừa nhập');
    await o.age(old.batch.id, 8);
    // A commit holds the batch row (it decides the batch before it deletes the rows); the sweep reads the batch as stale and waits.
    const blocker = new pg.Client({ connectionString: adminUrl });
    await blocker.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT 1 FROM crove_crm.import_batch WHERE org_id = $1 AND id = $2 FOR UPDATE", [o.orgId, old.batch.id]);
      const sweep = worker.execute<{ batches: number; rows: number }>('crm.import.expire', {}, { actor: SYSTEM, orgId: o.orgId });
      await new Promise((resolve) => setTimeout(resolve, 400));
      await blocker.query("UPDATE crove_crm.import_batch SET status = 'committed', created_rows = 1, decided_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, old.batch.id]);
      await blocker.query('COMMIT');
      expect(await sweep).toEqual({ batches: 0, rows: 0 });
    } finally {
      await blocker.end();
    }
    expect(await o.status(old.batch.id)).toBe('committed');
    expect(await o.rows(old.batch.id)).toBe(1);
  });

  it('clears the rows and marks the batches of one org expired, leaving a younger or a decided batch and another org alone', async () => {
    const a = await org();
    const b = await org();
    const [p1, p2, p3, p4] = [await a.member(), await a.member(), await a.member(), await a.member()];
    const old1 = await a.stage('Cũ một', p1);
    const old2 = await a.stage('Cũ hai', p2);
    const young = await a.stage('Mới', p3);
    const done = await a.stage('Đã nhập', p4);
    await app.execute('crm.import.commit', { batchId: done.batch.id, onDuplicate: 'skip' }, { actor: asUser(p4), orgId: a.orgId });
    const other = await b.stage('Của B cũ');
    for (const batch of [old1, old2, done]) await a.age(batch.batch.id, 9);
    await b.age(other.batch.id, 9);
    const result = await worker.execute<{ batches: number; rows: number }>('crm.import.expire', {}, { actor: SYSTEM, orgId: a.orgId });
    expect(result).toEqual({ batches: 2, rows: 2 });
    expect(await a.rows(old1.batch.id)).toBe(0);
    expect(await a.rows(old2.batch.id)).toBe(0);
    expect(await a.status(old1.batch.id)).toBe('expired');
    expect(await a.rows(young.batch.id)).toBe(1);
    expect(await a.status(young.batch.id)).toBe('staged');
    // A committed batch stays committed, however old.
    expect(await a.status(done.batch.id)).toBe('committed');
    // Another org's rows are untouched by this org's pass.
    expect(await b.rows(other.batch.id)).toBe(1);
    expect(await b.status(other.batch.id)).toBe('staged');
    // A second pass finds nothing.
    expect(await worker.execute('crm.import.expire', {}, { actor: SYSTEM, orgId: a.orgId })).toEqual({ batches: 0, rows: 0 });
    // The audit row holds counts only.
    const audit = await admin((c) => c.query("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'crm.import.expire' AND outcome = 'ok' ORDER BY occurred_at", [a.orgId]));
    expect(JSON.stringify(audit.rows)).not.toContain('Cũ');
  });

  it('reaches an org that never imports again, in one pass of the worker', async () => {
    const quiet = await org();
    const batch = await quiet.stage('Quên');
    await quiet.age(batch.batch.id, 10);
    const removed = await sweepCrmImports({ runtime: worker, workerDb });
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await quiet.rows(batch.batch.id)).toBe(0);
    expect(await quiet.status(batch.batch.id)).toBe('expired');
  });
});

async function sweepList(db: Db): Promise<string[]> {
  const { rows } = await sql<{ org_id: string }>`SELECT org_id FROM crove_crm.import_expired(now() - interval '7 days', 500)`.execute(db);
  return rows.map((r) => r.org_id);
}

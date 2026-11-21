// SPDX-License-Identifier: AGPL-3.0-only
// The purge of what a DISCONNECTED marketplace connection's poll brought in and no member imported (#4284, ADR-0045 point 8), on a real PostgreSQL. A week after the connection is removed the nightly job
// deletes the stored file and every extraction version of each such file (the staged lines and the decision), marks the original deleted and removes the link; a report a member imported, a file under an
// evidence hold and the files of a connection that is still there are never touched, nothing before the grace, and nothing is reachable by a login or a context that is not the worker as the system.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { MARKETPLACE_PURGE_GRACE_DAYS } from '@crove/kernel-contract';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { runMarketplacePurge } from '../src/marketplace-retention.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

class MemoryStore implements BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) {
    this.blobs.set(key, bytes);
    return `content:${sha256Hex(bytes)}`;
  }
  async get(key: string) {
    const b = this.blobs.get(key);
    if (!b) throw new Error('missing blob');
    return b;
  }
  // How many times each key was deleted: the job deletes once before the marker and once after it.
  readonly deletes = new Map<string, number>();
  async delete(key: string) {
    this.deletes.set(key, (this.deletes.get(key) ?? 0) + 1);
    this.blobs.delete(key);
  }
  has(key: string) {
    return this.blobs.has(key);
  }
}

suite('purge of the never-booked files of a disconnected marketplace connection (#4284)', () => {
  const dbName = `crove_test_mkt_purge_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let workerDb: Db;
  let rt: Runtime;
  let worker: Runtime;
  const store = new MemoryStore();
  const GRACE = MARKETPLACE_PURGE_GRACE_DAYS;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });
  const rows = async <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return (await client.query<T>(text, values)).rows;
    } finally {
      await client.end();
    }
  };
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@market.test`, name: null });
  type Org = { orgId: string; owner: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Bán sàn ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }
  // A marketplace connection of the org on a platform (one per platform in an org), with its channel connection.
  async function connection(o: Org, platform: 'shopee' | 'lazada' | 'tiktok_shop'): Promise<string> {
    const provider = `marketplace_${platform}`;
    const channelId = randomUUID();
    await rows('INSERT INTO crove_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, channelId, provider, `purge-${randomUUID()}`, 'purge test', o.owner]);
    const id = randomUUID();
    await rows('INSERT INTO crove_finance.marketplace_connection (org_id, id, channel_connection_id, provider, platform) VALUES ($1, $2, $3, $4, $5)', [o.orgId, id, channelId, provider, platform]);
    return id;
  }
  // A file the connection's poll ingested: the bytes are in the store, the row is made by the real intake, the link is the one ingest_page writes, and its extraction versions are the given states.
  async function polled(o: Org, connectionId: string, states: Array<'staged' | 'rejected' | 'imported'>): Promise<string> {
    const bytes = new TextEncoder().encode(`order report ${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: `don-hang-${randomUUID().slice(0, 8)}.csv`, contentType: 'text/csv', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    for (const state of states) {
      await rows("INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, result, checks) VALUES ($1, $2, 'unsupported', 'done', $3::jsonb, '[]')", [
        o.orgId,
        fileId,
        JSON.stringify({ kind: 'marketplace_orders', summary: { state, platform: 'shopee', orders: 3 }, ...(state === 'staged' ? { lines: [] } : {}) }),
      ]);
    }
    await rows('INSERT INTO crove_finance.marketplace_connection_file (org_id, marketplace_connection_id, file_id) VALUES ($1, $2, $3)', [o.orgId, connectionId, fileId]);
    return fileId;
  }
  const disconnect = (o: Org, connectionId: string) => rows('DELETE FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2', [o.orgId, connectionId]);
  // Moves the disconnect of a file's link back by `days` (superuser; the test stands in for the passing of time).
  const age = (o: Org, fileId: string, days: number) => rows('UPDATE crove_finance.marketplace_connection_file SET disconnected_at = now() - make_interval(days => $3) WHERE org_id = $1 AND file_id = $2', [o.orgId, fileId, days]);
  const fileRow = async (fileId: string) => (await rows<{ original_deleted_at: string | null; storage_key: string; sha256: string }>('SELECT original_deleted_at::text, storage_key, sha256 FROM crove_kernel.file WHERE id = $1', [fileId]))[0] as { original_deleted_at: string | null; storage_key: string; sha256: string };
  const versions = (fileId: string) => rows<{ version: number; state: string | null }>("SELECT version, result -> 'summary' ->> 'state' AS state FROM crove_kernel.extraction WHERE file_id = $1 ORDER BY version", [fileId]);
  const link = (fileId: string) => rows<{ marketplace_connection_id: string | null; disconnected_at: string | null }>('SELECT marketplace_connection_id, disconnected_at::text FROM crove_finance.marketplace_connection_file WHERE file_id = $1', [fileId]);
  const run = () => runMarketplacePurge({ runtime: worker, workerDb, store, log: { log: () => undefined, error: () => undefined } });

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
    pool = createPool({ connectionString: login('crove_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('crove_worker', 'test-worker-pw'), max: 2 });
    workerDb = createDb(workerPool);
    const register = (target: Db) => new Runtime(target, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    rt = register(db);
    worker = register(workerDb);
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

  it('stamps the time the connection went on its links, keeps the links, and touches the links of a connection that is still there not at all', async () => {
    const o = await org();
    const gone = await connection(o, 'shopee');
    const stays = await connection(o, 'lazada');
    const fileGone = await polled(o, gone, ['staged']);
    const fileStays = await polled(o, stays, ['staged']);
    expect(await link(fileGone)).toEqual([{ marketplace_connection_id: gone, disconnected_at: null }]);
    await disconnect(o, gone);
    const [after] = await link(fileGone);
    expect(after?.marketplace_connection_id).toBeNull();
    expect(Date.now() - Date.parse(String(after?.disconnected_at))).toBeLessThan(60_000);
    // The file and its read are still there: the link only remembers where it came from.
    expect((await versions(fileGone)).length).toBe(1);
    expect(await link(fileStays)).toEqual([{ marketplace_connection_id: stays, disconnected_at: null }]);
    // A link with no connection must say when it went.
    await expect(rows('UPDATE crove_finance.marketplace_connection_file SET disconnected_at = NULL WHERE file_id = $1', [fileGone])).rejects.toBeDefined();
  });

  it('destroys what no member imported a week after the disconnect (waiting, skipped, never read) and nothing before; the read, the object and the link go, the file row stays', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const waiting = await polled(o, id, ['staged']);
    const skipped = await polled(o, id, ['staged', 'rejected']);
    const unread = await polled(o, id, []);
    await disconnect(o, id);
    const all = [waiting, skipped, unread];
    const before = await Promise.all(all.map(fileRow));

    // Day 6: nothing is due.
    for (const f of all) await age(o, f, GRACE - 1);
    expect(await run()).toMatchObject({ failed: 0 });
    for (const [i, f] of all.entries()) {
      expect(store.has((before[i] as { storage_key: string }).storage_key)).toBe(true);
      expect((await fileRow(f)).original_deleted_at).toBeNull();
      expect((await link(f)).length).toBe(1);
    }
    expect((await versions(skipped)).length).toBe(2);

    // Day 8: all three go.
    for (const f of all) await age(o, f, GRACE + 1);
    expect(await run()).toMatchObject({ failed: 0 });
    for (const [i, f] of all.entries()) {
      const key = (before[i] as { storage_key: string }).storage_key;
      expect(store.has(key)).toBe(false);
      // Once before the marker and once after it (the window of a same-bytes upload in between).
      expect(store.deletes.get(key)).toBe(2);
      const after = await fileRow(f);
      expect(after.original_deleted_at).not.toBeNull();
      // The file row stays with its hash (a generated name, a size and a hash: no content).
      expect(after.sha256).toBe((before[i] as { sha256: string }).sha256);
      expect(await versions(f)).toEqual([]);
      expect(await link(f)).toEqual([]);
    }
    // A rerun finds nothing more.
    const again = await run();
    expect(again).toMatchObject({ failed: 0 });
    // The audit facts of the commands carry the file id, two counts and that it was the purge; nothing of the file.
    const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.marketplace_retention.apply' AND outcome = 'ok' ORDER BY occurred_at", [o.orgId]);
    expect(audit).toHaveLength(3);
    for (const a of audit) expect(Object.keys(a.detail).sort()).toEqual(['applied', 'component', 'disconnected', 'fileId', 'versions', 'workerInstance']);
    expect(JSON.stringify(audit)).not.toContain('don-hang');
  });

  it('never touches a report a member imported, a file under an evidence hold, or the files of a connection that is still there, whatever the age', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const live = await connection(o, 'tiktok_shop');
    const imported = await polled(o, id, ['staged', 'imported']);
    const held = await polled(o, id, ['staged']);
    const stillThere = await polled(o, live, ['staged']);
    await rows("UPDATE crove_kernel.file SET held_until = now() + interval '30 days' WHERE org_id = $1 AND id = $2", [o.orgId, held]);
    await disconnect(o, id);
    await age(o, imported, 400);
    await age(o, held, 400);
    // A link of a live connection has no disconnect time at all: nothing to count from.
    await rows("UPDATE crove_finance.marketplace_connection_file SET disconnected_at = NULL WHERE org_id = $1 AND file_id = $2 AND marketplace_connection_id IS NOT NULL", [o.orgId, stillThere]);
    const keys = await Promise.all([imported, held, stillThere].map(async (f) => (await fileRow(f)).storage_key));
    expect(await run()).toMatchObject({ failed: 0 });
    for (const [i, f] of [imported, held, stillThere].entries()) {
      expect(store.has(keys[i] as string)).toBe(true);
      expect((await fileRow(f)).original_deleted_at).toBeNull();
      expect((await versions(f)).length).toBeGreaterThan(0);
      expect((await link(f)).length).toBe(1);
    }
    expect(await versions(imported)).toEqual([
      { version: 1, state: 'staged' },
      { version: 2, state: 'imported' },
    ]);
    // The definer itself refuses them, by name: a bug in the job cannot reach a booked report or a held file.
    const system = { actor: { type: 'system' as const, component: 'test' }, orgId: o.orgId };
    for (const f of [imported, held]) {
      expect(await worker.execute('finance.marketplace_retention.apply', { fileId: f, disconnected: true }, system)).toMatchObject({ applied: false, versions: 0 });
      expect(await worker.query('finance.marketplace_retention.key', { fileId: f, disconnected: true }, system)).toBeNull();
    }
  });

  it('reads the key of a due file as not shared, nothing for a file that is not due, and stays inside its own org', async () => {
    const a = await org();
    const b = await org();
    const idA = await connection(a, 'shopee');
    const idB = await connection(b, 'shopee');
    const fileA = await polled(a, idA, ['staged']);
    const fileB = await polled(b, idB, ['staged']);
    await disconnect(a, idA);
    await disconnect(b, idB);
    const sysA = { actor: { type: 'system' as const, component: 'test' }, orgId: a.orgId };
    // Not due yet.
    expect(await worker.query('finance.marketplace_retention.key', { fileId: fileA, disconnected: true }, sysA)).toBeNull();
    await age(a, fileA, GRACE + 1);
    await age(b, fileB, GRACE + 1);
    expect(await worker.query('finance.marketplace_retention.key', { fileId: fileA, disconnected: true }, sysA)).toEqual({ storageKey: (await fileRow(fileA)).storage_key, shared: false });
    // Another org's file is nobody's in this context: nothing is returned and nothing applied.
    expect(await worker.query('finance.marketplace_retention.key', { fileId: fileB, disconnected: true }, sysA)).toBeNull();
    expect(await worker.execute('finance.marketplace_retention.apply', { fileId: fileB, disconnected: true }, sysA)).toMatchObject({ applied: false });
    expect((await versions(fileB)).length).toBe(1);
    expect(await run()).toMatchObject({ failed: 0 });
    expect(await versions(fileA)).toEqual([]);
    expect(await versions(fileB)).toEqual([]);
  });

  it('finishes after a crash between the object and the row: a rerun marks the row and deletes nothing twice', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const file = await polled(o, id, ['staged']);
    await disconnect(o, id);
    await age(o, file, GRACE + 1);
    // The worker died after deleting the object and before the row.
    await store.delete((await fileRow(file)).storage_key);
    expect(await run()).toMatchObject({ failed: 0 });
    expect((await fileRow(file)).original_deleted_at).not.toBeNull();
    expect(await versions(file)).toEqual([]);
  });

  it('is the worker\'s alone: no other login, and no context that is not the worker as the system in its own org, reaches the three functions; the grace is 1 to 14 days', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const file = await polled(o, id, ['staged']);
    await disconnect(o, id);
    await age(o, file, GRACE + 1);
    // The list is the worker login without a context.
    await expect(pool.query('SELECT * FROM crove_finance.marketplace_purge_due($1, 10)', [GRACE])).rejects.toBeDefined();
    expect((await workerPool.query('SELECT * FROM crove_finance.marketplace_purge_due($1, 1000)', [GRACE])).rows.some((r) => r.file_id === file)).toBe(true);
    for (const days of [0, 15, -1]) await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_purge_due($1, 10)', [days])).rejects.toMatchObject({ code: '22023' });
    // key and apply need the system context of the file's own org: a bare worker login has none, and the application login is not the worker.
    await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_purge_apply($1::uuid, $2::uuid, $3)', [o.orgId, file, GRACE])).rejects.toBeDefined();
    await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_purge_key($1::uuid, $2::uuid, $3)', [o.orgId, file, GRACE])).rejects.toBeDefined();
    await expect(pool.query('SELECT * FROM crove_finance.marketplace_purge_apply($1::uuid, $2::uuid, $3)', [o.orgId, file, GRACE])).rejects.toBeDefined();
    // The command is the system's alone: a person is refused, and nothing is deleted.
    await expect(rt.execute('finance.marketplace_retention.apply', { fileId: file, disconnected: true }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toBeDefined();
    expect((await versions(file)).length).toBe(1);
    expect(await run()).toMatchObject({ failed: 0 });
  });
});

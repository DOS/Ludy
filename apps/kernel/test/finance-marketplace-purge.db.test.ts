// SPDX-License-Identifier: AGPL-3.0-only
// The purge of what a GONE marketplace connection's poll brought in and no member imported (#4284, ADR-0045 point 8), on a real PostgreSQL. A week after the connection is disconnected or its channel
// revoked (or a month after the channel expired with no new authorization, then a week) the nightly job deletes the stored object and the file row, which takes every extraction version and the link with it;
// a report a member imported, a file under an evidence hold, a file a purchase document names, a file that is not a poll's own and the files of a live connection are never touched, nothing before the
// grace, and nothing is reachable by a login or a context that is not the worker as the system.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { MARKETPLACE_PURGE_EXPIRED_DAYS, MARKETPLACE_PURGE_GRACE_DAYS } from '@ludy/kernel-contract';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
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

suite('purge of the never-booked files of a gone marketplace connection (#4284)', () => {
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
  const EXPIRED = MARKETPLACE_PURGE_EXPIRED_DAYS;
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
  // A superuser session with the table guards switched off, for the facts the product has no path for in a test (an evidence hold, a booked invoice).
  const asReplica = async (text: string, values: unknown[]) => {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query('SET session_replication_role = replica');
      await client.query(text, values);
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
  // A marketplace connection of the org on a platform (one per platform in an org), with its channel connection (active).
  async function connection(o: Org, platform: 'shopee' | 'lazada' | 'tiktok_shop'): Promise<string> {
    const provider = `marketplace_${platform}`;
    const channelId = randomUUID();
    await rows('INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, channelId, provider, `purge-${randomUUID()}`, 'purge test', o.owner]);
    const id = randomUUID();
    await rows("INSERT INTO crove_finance.marketplace_connection (org_id, id, channel_connection_id, provider, platform, poll_cursor) VALUES ($1, $2, $3, $4, $5, 'cursor-after-page-3')", [o.orgId, id, channelId, provider, platform]);
    return id;
  }
  // A file the connection's poll ingested: the bytes are in the store, the row is made by the real intake, the link is the one ingest_page writes, and its extraction versions are the given states.
  async function polled(o: Org, connectionId: string, states: Array<'staged' | 'rejected' | 'imported'>, options: { kind?: string; contentType?: string } = {}): Promise<string> {
    const bytes = new TextEncoder().encode(`order report ${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: `don-hang-${randomUUID().slice(0, 8)}.csv`, contentType: options.contentType ?? 'text/csv', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    for (const state of states) {
      await rows("INSERT INTO ludy_kernel.extraction (org_id, file_id, method, status, result, checks) VALUES ($1, $2, 'unsupported', 'done', $3::jsonb, '[]')", [
        o.orgId,
        fileId,
        JSON.stringify({ kind: options.kind ?? 'marketplace_orders', summary: { state, platform: 'shopee', orders: 3 }, ...(state === 'staged' ? { lines: [] } : {}) }),
      ]);
    }
    await rows('INSERT INTO crove_finance.marketplace_connection_file (org_id, marketplace_connection_id, file_id) VALUES ($1, $2, $3)', [o.orgId, connectionId, fileId]);
    return fileId;
  }
  const disconnect = (o: Org, connectionId: string) => rows('DELETE FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2', [o.orgId, connectionId]);
  // Moves the disconnect of a file's link back by `days` (superuser; the test stands in for the passing of time).
  const age = (o: Org, fileId: string, days: number) => rows('UPDATE crove_finance.marketplace_connection_file SET disconnected_at = now() - make_interval(days => $3) WHERE org_id = $1 AND file_id = $2', [o.orgId, fileId, days]);
  // The channel of a connection that is still there, as `status` since `days` ago.
  const channel = (o: Org, connectionId: string, status: 'active' | 'expired' | 'revoked', days: number) =>
    rows(
      'UPDATE ludy_kernel.channel_connection SET status = $3, updated_at = now() - make_interval(days => $4) WHERE org_id = $1 AND id = (SELECT channel_connection_id FROM crove_finance.marketplace_connection WHERE org_id = $1 AND id = $2)',
      [o.orgId, connectionId, status, days],
    );
  const fileRow = async (fileId: string) => (await rows<{ original_deleted_at: string | null; storage_key: string; sha256: string }>('SELECT original_deleted_at::text, storage_key, sha256 FROM ludy_kernel.file WHERE id = $1', [fileId]))[0];
  const versions = (fileId: string) => rows<{ version: number; state: string | null }>("SELECT version, result -> 'summary' ->> 'state' AS state FROM ludy_kernel.extraction WHERE file_id = $1 ORDER BY version", [fileId]);
  const link = (fileId: string) => rows<{ marketplace_connection_id: string | null; disconnected_at: string | null }>('SELECT marketplace_connection_id, disconnected_at::text FROM crove_finance.marketplace_connection_file WHERE file_id = $1', [fileId]);
  const cursor = async (connectionId: string) => {
    const found = await rows<{ poll_cursor: string | null }>('SELECT poll_cursor FROM crove_finance.marketplace_connection WHERE id = $1', [connectionId]);
    return found.length === 0 ? 'no row' : (found[0] as { poll_cursor: string | null }).poll_cursor;
  };
  const run = (batch?: number) => runMarketplacePurge({ runtime: worker, workerDb, store, ...(batch === undefined ? {} : { batch }), log: { log: () => undefined, error: () => undefined } });
  const system = (o: Org) => ({ actor: { type: 'system' as const, component: 'test' }, orgId: o.orgId });

  beforeAll(async () => {
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`CREATE DATABASE ${dbName}`);
    await root.end();
    const base = new URL(ADMIN as string);
    base.pathname = `/${dbName}`;
    adminUrl = base.toString();
    await migrate({ adminUrl, dir: MIGRATIONS });
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const login = (username: string, password: string) => {
      const url = new URL(adminUrl);
      url.username = username;
      url.password = password;
      return url.toString();
    };
    pool = createPool({ connectionString: login('ludy_app', 'test-app-pw'), max: 4 });
    db = createDb(pool);
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 2 });
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

  it('stamps the time the connection went on its links, keeps the links, and refuses a link that has no connection and no time', async () => {
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

  it('refuses to write an orphan link: no writer, whatever its role, can make a file of its own a purge candidate', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const file = await polled(o, id, ['staged']);
    // A file that no poll brought (an upload in the Inbox).
    const bytes = new TextEncoder().encode(`own upload ${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId: own } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'tai-len.csv', contentType: 'text/csv', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    // A link with no connection, or one that carries a disconnect time, is refused (a superuser too: only the replica role skips a trigger, and a tenant cannot set it).
    await expect(rows("INSERT INTO crove_finance.marketplace_connection_file (org_id, marketplace_connection_id, file_id, disconnected_at) VALUES ($1, NULL, $2, now() - interval '30 days')", [o.orgId, own])).rejects.toThrow(/MARKETPLACE_LINK_NEEDS_CONNECTION/);
    await expect(rows("INSERT INTO crove_finance.marketplace_connection_file (org_id, marketplace_connection_id, file_id, disconnected_at) VALUES ($1, $2, $3, now() - interval '30 days')", [o.orgId, id, own])).rejects.toThrow(/MARKETPLACE_LINK_NEEDS_CONNECTION/);
    await disconnect(o, id);
    await age(o, file, GRACE + 1);
    // Only the file the removed connection brought goes; the member's own upload is nobody's candidate.
    expect(await run()).toMatchObject({ failed: 0, deleted: 1 });
    expect(await fileRow(file)).toBeUndefined();
    expect(await fileRow(own)).toBeDefined();
    expect(store.has(storageKey)).toBe(true);
  });

  it('destroys what no member imported a week after the disconnect (waiting, skipped, never read) and nothing before: the object, the file row, every read and the link all go', async () => {
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
    expect(await run()).toMatchObject({ failed: 0, deleted: 0 });
    for (const [i, f] of all.entries()) {
      expect(store.has(before[i]?.storage_key as string)).toBe(true);
      expect(await fileRow(f)).toBeDefined();
      expect((await link(f)).length).toBe(1);
    }
    expect((await versions(skipped)).length).toBe(2);

    // Day 8: all three go.
    for (const f of all) await age(o, f, GRACE + 1);
    expect(await run()).toMatchObject({ failed: 0, deleted: 3 });
    for (const [i, f] of all.entries()) {
      const key = before[i]?.storage_key as string;
      expect(store.has(key)).toBe(false);
      // Once before the row goes and once after it (the window of a same-bytes upload in between).
      expect(store.deletes.get(key)).toBe(2);
      // Nothing of the file stays, not even its hash: the row, its reads and the link are gone, so the same bytes arriving again are a new file.
      expect(await fileRow(f)).toBeUndefined();
      expect(await versions(f)).toEqual([]);
      expect(await link(f)).toEqual([]);
    }
    // A rerun finds nothing more.
    expect(await run()).toMatchObject({ failed: 0, deleted: 0 });
    // The audit facts of the commands carry the file id, two counts and that it was the purge; nothing of the file.
    const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM ludy_kernel.audit_event WHERE org_id = $1 AND command = 'finance.marketplace_retention.apply' AND outcome = 'ok' ORDER BY occurred_at", [o.orgId]);
    expect(audit).toHaveLength(3);
    for (const a of audit) expect(Object.keys(a.detail).sort()).toEqual(['applied', 'component', 'disconnected', 'fileId', 'versions', 'workerInstance']);
    expect(JSON.stringify(audit)).not.toContain('don-hang');
  });

  it('the same bytes after a purge are a new file, not a duplicate of a ghost', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const file = await polled(o, id, ['staged']);
    const { sha256, storage_key: storageKey } = (await fileRow(file)) as { sha256: string; storage_key: string };
    const bytes = await store.get(storageKey);
    await disconnect(o, id);
    await age(o, file, GRACE + 1);
    expect(await run()).toMatchObject({ failed: 0, deleted: 1 });
    expect(await fileRow(file)).toBeUndefined();
    const generation = await store.put(storageKey, bytes);
    const again = await rt.execute<{ fileId: string; duplicate: boolean }>(
      'kernel.file.ingest',
      { filename: 'lai.csv', contentType: 'text/csv', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(again.duplicate).toBe(false);
    expect(again.fileId).not.toBe(file);
  });

  it('never touches a report a member imported, a file under an evidence hold, a file a purchase document names, a file that is not a poll\'s own, or the files of a live connection, whatever the age', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const live = await connection(o, 'tiktok_shop');
    const imported = await polled(o, id, ['staged', 'imported']);
    // Imported, then a later version of the file: any imported version books it, not only the newest.
    const importedEarlier = await polled(o, id, ['imported', 'staged']);
    const held = await polled(o, id, ['staged']);
    const invoiced = await polled(o, id, ['staged']);
    const otherKind = await polled(o, id, ['staged'], { kind: 'bank_statement' });
    const notCsv = await polled(o, id, ['staged'], { contentType: 'application/pdf' });
    const stillThere = await polled(o, live, ['staged']);
    await asReplica("UPDATE ludy_kernel.file SET held_until = now() + interval '30 days' WHERE org_id = $1 AND id = $2", [o.orgId, held]);
    await asReplica(
      `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total, source_file_id) VALUES ($1, $2, 'X1', '2026-11-01', 1, 0, 1, $3)`,
      [o.orgId, randomUUID(), invoiced],
    );
    await disconnect(o, id);
    const protectedFiles = [imported, importedEarlier, held, invoiced, otherKind, notCsv];
    for (const f of protectedFiles) await age(o, f, 400);
    const keys = await Promise.all([...protectedFiles, stillThere].map(async (f) => (await fileRow(f))?.storage_key));
    expect(await run()).toMatchObject({ failed: 0, deleted: 0 });
    for (const [i, f] of [...protectedFiles, stillThere].entries()) {
      expect(store.has(keys[i] as string)).toBe(true);
      expect(await fileRow(f)).toBeDefined();
      expect((await versions(f)).length).toBeGreaterThan(0);
      expect((await link(f)).length).toBe(1);
    }
    expect(await versions(imported)).toEqual([
      { version: 1, state: 'staged' },
      { version: 2, state: 'imported' },
    ]);
    // The definer itself refuses them, by name: a bug in the job cannot reach a booked report, a held file or any file that is not a poll's own.
    for (const f of protectedFiles) {
      expect(await worker.execute('finance.marketplace_retention.apply', { fileId: f, disconnected: true }, system(o))).toMatchObject({ applied: false, versions: 0 });
      expect(await worker.query('finance.marketplace_retention.key', { fileId: f, disconnected: true }, system(o))).toBeNull();
    }
    expect(await worker.query('finance.marketplace_retention.key', { fileId: stillThere, disconnected: true }, system(o))).toBeNull();
  });

  it('counts an expired channel from 30 days without a new authorization, a revoked one from its revocation, and resets the cursor of the connection that stays', async () => {
    const o = await org();
    const expiredShort = await connection(o, 'shopee');
    const expiredLong = await connection(o, 'lazada');
    const revoked = await connection(o, 'tiktok_shop');
    const fileShort = await polled(o, expiredShort, ['staged']);
    const fileLong = await polled(o, expiredLong, ['staged']);
    const fileRevoked = await polled(o, revoked, ['staged']);

    // Expired for 10 days, and for 36 (still inside 30 + 7): untouched, whatever the grace alone would say.
    await channel(o, expiredShort, 'expired', GRACE + 3);
    await channel(o, expiredLong, 'expired', EXPIRED + GRACE - 1);
    // Revoked six days ago: inside the grace.
    await channel(o, revoked, 'revoked', GRACE - 1);
    expect(await run()).toMatchObject({ failed: 0, deleted: 0 });
    for (const f of [fileShort, fileLong, fileRevoked]) expect(await fileRow(f)).toBeDefined();

    // Expired for 38 days: purged; the connection row stays, with its cursor reset so the platform's window is read again from its start. Revoked eight days ago: purged too, no unlink needed.
    await channel(o, expiredLong, 'expired', EXPIRED + GRACE + 1);
    await channel(o, revoked, 'revoked', GRACE + 1);
    expect(await run()).toMatchObject({ failed: 0, deleted: 2 });
    expect(await fileRow(fileLong)).toBeUndefined();
    expect(await fileRow(fileRevoked)).toBeUndefined();
    expect(await fileRow(fileShort)).toBeDefined();
    expect(await cursor(expiredLong)).toBeNull();
    expect(await cursor(revoked)).toBeNull();
    expect(await cursor(expiredShort)).toBe('cursor-after-page-3');

    // A channel that was authorized again (active) is a live connection: untouched however long it was expired before.
    await channel(o, expiredShort, 'expired', 400);
    await channel(o, expiredShort, 'active', 400);
    expect(await run()).toMatchObject({ failed: 0, deleted: 0 });
    expect(await fileRow(fileShort)).toBeDefined();
  });

  it('a new connection that brings the same bytes again takes the orphan link over, and the purge leaves the file', async () => {
    const o = await org();
    const first = await connection(o, 'shopee');
    const file = await polled(o, first, ['staged']);
    await disconnect(o, first);
    await age(o, file, GRACE - 1);
    const second = await connection(o, 'shopee');
    // The poll's own command, as the system on the worker: the page's bytes are the file the removed connection brought.
    const row = (await fileRow(file)) as { sha256: string; storage_key: string };
    const bytes = await store.get(row.storage_key);
    const input = { marketplaceConnectionId: second, filename: 'lai.csv', contentType: 'text/csv', sizeBytes: bytes.byteLength, sha256: row.sha256, storageKey: row.storage_key, generation: await store.put(row.storage_key, bytes) };
    const out = await worker.execute<{ fileId: string; duplicate: boolean }>('finance.marketplace_connection.ingest_page', input, { actor: { type: 'system', component: 'marketplace-poll' }, orgId: o.orgId });
    expect(out).toMatchObject({ fileId: file, duplicate: true });
    expect(await link(file)).toEqual([{ marketplace_connection_id: second, disconnected_at: null }]);
    // Even with an old time left on it, a link of a live connection starts no clock.
    await age(o, file, 400);
    expect(await run()).toMatchObject({ failed: 0, deleted: 0 });
    expect(await fileRow(file)).toBeDefined();
    // A link that has a connection is never moved: a third connection bringing the bytes does not take it.
    const third = await connection(o, 'lazada');
    await worker.execute('finance.marketplace_connection.ingest_page', { ...input, marketplaceConnectionId: third }, { actor: { type: 'system', component: 'marketplace-poll' }, orgId: o.orgId });
    // Only the connection matters here: the old time left on the link above is still there, untouched.
    expect((await link(file)).map((l) => l.marketplace_connection_id)).toEqual([second]);
  });

  it('does not link a page whose bytes are a member\'s own upload, so the purge never reaches it', async () => {
    const o = await org();
    const bytes = new TextEncoder().encode(`own upload ${randomUUID()}`);
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId: own } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'cua-toi.csv', contentType: 'text/csv', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    const id = await connection(o, 'shopee');
    // The platform's page carries the same bytes: the intake answers the member's file as a duplicate.
    const input = { marketplaceConnectionId: id, filename: 'trang.csv', contentType: 'text/csv', sizeBytes: bytes.byteLength, sha256, storageKey, generation };
    const out = await worker.execute<{ fileId: string; duplicate: boolean }>('finance.marketplace_connection.ingest_page', input, { actor: { type: 'system', component: 'marketplace-poll' }, orgId: o.orgId });
    expect(out).toMatchObject({ fileId: own, duplicate: true });
    expect(await link(own)).toEqual([]);
    await disconnect(o, id);
    expect(await run()).toMatchObject({ failed: 0, deleted: 0 });
    expect(await fileRow(own)).toBeDefined();
    expect(store.has(storageKey)).toBe(true);
  });

  it('keeps the revocation time when a revoked channel is unlinked late: the clock is not restarted', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const file = await polled(o, id, ['staged']);
    // The disconnect stopped after revoking the channel ten days ago; the unlink comes only now.
    await channel(o, id, 'revoked', GRACE + 3);
    await disconnect(o, id);
    const [stamped] = await link(file);
    expect(stamped?.marketplace_connection_id).toBeNull();
    const days = (Date.now() - Date.parse(String(stamped?.disconnected_at))) / 86_400_000;
    expect(days).toBeGreaterThan(GRACE + 2);
    expect(await run()).toMatchObject({ failed: 0, deleted: 1 });
    expect(await fileRow(file)).toBeUndefined();
  });

  it('a finished read of no recognised kind keeps the file out of the purge', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const file = await polled(o, id, []);
    await rows("INSERT INTO ludy_kernel.extraction (org_id, file_id, method, status, result, checks) VALUES ($1, $2, 'unsupported', 'done', '{}'::jsonb, '[]')", [o.orgId, file]);
    await disconnect(o, id);
    await age(o, file, 400);
    expect(await run()).toMatchObject({ failed: 0, deleted: 0 });
    expect(await fileRow(file)).toBeDefined();
  });

  it('files another table points at do not hide the newer files behind them in a batch', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const used = await polled(o, id, ['staged']);
    const free = await polled(o, id, ['staged']);
    await rows('CREATE TABLE IF NOT EXISTS public.purge_probe (org_id uuid NOT NULL, file_id uuid NOT NULL, FOREIGN KEY (org_id, file_id) REFERENCES ludy_kernel.file (org_id, id))');
    await rows('INSERT INTO public.purge_probe (org_id, file_id) VALUES ($1, $2)', [o.orgId, used]);
    await disconnect(o, id);
    // The referenced file is the oldest, so a batch of one lists it first.
    await age(o, used, GRACE + 5);
    await age(o, free, GRACE + 1);
    expect(await run(1)).toMatchObject({ failed: 0, deleted: 1 });
    expect(await fileRow(free)).toBeUndefined();
    expect(await fileRow(used)).toBeDefined();
    await rows('DELETE FROM public.purge_probe WHERE file_id = $1', [used]);
    expect(await run()).toMatchObject({ failed: 0, deleted: 1 });
  });

  it('leaves a file another table still points at, whatever order its foreign key lists the columns in: nothing of it is deleted, and it goes once the reference is gone', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const used = await polled(o, id, ['staged']);
    const usedReversed = await polled(o, id, ['staged']);
    const free = await polled(o, id, ['staged']);
    // Tables that restrict the deletion of the file they name (a signing envelope or a post's media does the same); the second lists the key columns the other way round.
    await rows('CREATE TABLE IF NOT EXISTS public.purge_probe (org_id uuid NOT NULL, file_id uuid NOT NULL, FOREIGN KEY (org_id, file_id) REFERENCES ludy_kernel.file (org_id, id))');
    await rows('CREATE TABLE IF NOT EXISTS public.purge_probe_reversed (file_id uuid NOT NULL, org_id uuid NOT NULL, FOREIGN KEY (file_id, org_id) REFERENCES ludy_kernel.file (id, org_id))');
    await rows('INSERT INTO public.purge_probe (org_id, file_id) VALUES ($1, $2)', [o.orgId, used]);
    await rows('INSERT INTO public.purge_probe_reversed (file_id, org_id) VALUES ($1, $2)', [usedReversed, o.orgId]);
    await disconnect(o, id);
    for (const f of [used, usedReversed, free]) await age(o, f, GRACE + 1);
    const keys = await Promise.all([used, usedReversed].map(async (f) => (await fileRow(f))?.storage_key as string));
    expect(await run()).toMatchObject({ failed: 0, deleted: 1 });
    expect(await fileRow(free)).toBeUndefined();
    for (const [i, f] of [used, usedReversed].entries()) {
      expect(await fileRow(f)).toBeDefined();
      expect(store.has(keys[i] as string)).toBe(true);
      expect(await worker.query('finance.marketplace_retention.key', { fileId: f, disconnected: true }, system(o))).toBeNull();
    }
    await rows('DELETE FROM public.purge_probe WHERE file_id = $1', [used]);
    await rows('DELETE FROM public.purge_probe_reversed WHERE file_id = $1', [usedReversed]);
    expect(await run()).toMatchObject({ failed: 0, deleted: 2 });
    expect(await fileRow(used)).toBeUndefined();
    expect(await fileRow(usedReversed)).toBeUndefined();
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
    // Not due yet.
    expect(await worker.query('finance.marketplace_retention.key', { fileId: fileA, disconnected: true }, system(a))).toBeNull();
    await age(a, fileA, GRACE + 1);
    await age(b, fileB, GRACE + 1);
    expect(await worker.query('finance.marketplace_retention.key', { fileId: fileA, disconnected: true }, system(a))).toEqual({ storageKey: (await fileRow(fileA))?.storage_key, shared: false });
    // Another org's file is nobody's in this context: nothing is returned and nothing applied.
    expect(await worker.query('finance.marketplace_retention.key', { fileId: fileB, disconnected: true }, system(a))).toBeNull();
    expect(await worker.execute('finance.marketplace_retention.apply', { fileId: fileB, disconnected: true }, system(a))).toMatchObject({ applied: false });
    expect((await versions(fileB)).length).toBe(1);
    expect(await run()).toMatchObject({ failed: 0, deleted: 2 });
    expect(await versions(fileA)).toEqual([]);
    expect(await versions(fileB)).toEqual([]);
  });

  it('finishes after a crash between the object and the row: a rerun removes the row and deletes nothing twice', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const file = await polled(o, id, ['staged']);
    await disconnect(o, id);
    await age(o, file, GRACE + 1);
    // The worker died after deleting the object and before the row.
    await store.delete((await fileRow(file))?.storage_key as string);
    expect(await run()).toMatchObject({ failed: 0, deleted: 1 });
    expect(await fileRow(file)).toBeUndefined();
    expect(await versions(file)).toEqual([]);
  });

  it('is the worker\'s alone: no other login, and no context that is not the worker as the system in its own org, reaches the functions; the grace is 7 to 14 days and the expiry 30 to 90; the rule itself can be called by no role', async () => {
    const o = await org();
    const id = await connection(o, 'shopee');
    const file = await polled(o, id, ['staged']);
    await disconnect(o, id);
    await age(o, file, GRACE + 1);
    // The list is the worker login without a context.
    await expect(pool.query('SELECT * FROM crove_finance.marketplace_purge_due($1, $2, 10)', [GRACE, EXPIRED])).rejects.toBeDefined();
    expect((await workerPool.query('SELECT * FROM crove_finance.marketplace_purge_due($1, $2, 1000)', [GRACE, EXPIRED])).rows.some((r) => r.file_id === file)).toBe(true);
    for (const days of [0, 1, 6, 15, -1]) await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_purge_due($1, $2, 10)', [days, EXPIRED])).rejects.toMatchObject({ code: '22023' });
    for (const expired of [0, 1, 29, 91]) await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_purge_due($1, $2, 10)', [GRACE, expired])).rejects.toMatchObject({ code: '22023' });
    // key, apply and adopt need the system context of the file's own org: a bare worker login has none, and the application login is not the worker.
    await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_purge_apply($1::uuid, $2::uuid, $3, $4)', [o.orgId, file, GRACE, EXPIRED])).rejects.toBeDefined();
    await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_purge_key($1::uuid, $2::uuid, $3, $4)', [o.orgId, file, GRACE, EXPIRED])).rejects.toBeDefined();
    await expect(pool.query('SELECT * FROM crove_finance.marketplace_purge_apply($1::uuid, $2::uuid, $3, $4)', [o.orgId, file, GRACE, EXPIRED])).rejects.toBeDefined();
    // A real connection of the same org, so only the context guard can be what refuses. The worker login reaches the function and its guard refuses the missing context; the application login has no
    // EXECUTE on it at all, so the database refuses before the function runs.
    const target = await connection(o, 'lazada');
    await expect(workerPool.query('SELECT crove_finance.marketplace_link_adopt($1::uuid, $2::uuid, $3::uuid)', [o.orgId, target, file])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('MARKETPLACE_PURGE_WORKER_ONLY') });
    await expect(pool.query('SELECT crove_finance.marketplace_link_adopt($1::uuid, $2::uuid, $3::uuid)', [o.orgId, target, file])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    // The rule and the reference check are nobody's to call: no role executes them (the definers do, as their owner).
    for (const target of [workerPool, pool]) {
      await expect(target.query('SELECT * FROM crove_finance.marketplace_purge_candidates(NULL, NULL, $1, $2)', [GRACE, EXPIRED])).rejects.toBeDefined();
      await expect(target.query('SELECT crove_finance.marketplace_purge_referenced($1::uuid, $2::uuid)', [o.orgId, file])).rejects.toBeDefined();
    }
    // The command is the system's alone: a person is refused, and nothing is deleted.
    await expect(rt.execute('finance.marketplace_retention.apply', { fileId: file, disconnected: true }, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() })).rejects.toBeDefined();
    expect((await versions(file)).length).toBe(1);
    expect(await run()).toMatchObject({ failed: 0, deleted: 1 });
  });
});

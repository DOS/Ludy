// SPDX-License-Identifier: AGPL-3.0-only
// The delivery day of an order line (#2516, the rework to the AI consensus of 2026-11-15, slice B), on a real PostgreSQL 17 and the real parsing sandbox: the completion column of a Shopee
// report is read, stored once on a delivered line (completed, or returned after it), never on a line that has not been delivered, a later report may give it to a line that has none and
// never changes it, and the table holds the same rules (set once, only on a delivered line). The files are made in code with made-up buyers.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries, readMarketplaceFile } from '@crove/mod-finance';
import { fileURLToPath } from 'node:url';
import { buildXlsx, type XlsxCell } from '../../extract/test/xlsx-fixture.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const HEAD: XlsxCell[] = ['Mã đơn hàng', 'Ngày đặt hàng', 'Thời gian hoàn thành đơn hàng', 'Trạng Thái Đơn Hàng', 'SKU phân loại hàng', 'Tên sản phẩm', 'Giá ưu đãi', 'Số lượng', 'Tổng giá bán (sản phẩm)'];
// A line with its completion cell ('' for none).
const row = (order: string, status: string, completed: string, sku = 'QC-1'): XlsxCell[] => [order, '2026-10-30 14:05', completed, status, sku, `Sản phẩm ${sku}`, 50000, 1, 50000];
const report = (...rows: XlsxCell[][]) => buildXlsx([['Báo cáo đơn hàng'], HEAD, ...rows]);

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
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

suite('the delivery day of an order line (#2516)', () => {
  const dbName = `crove_test_delivered_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let worker: Runtime;
  let extract: ExtractClient;
  const store = new MemoryStore();
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
  type Org = { orgId: string; owner: string };
  async function org(): Promise<Org> {
    const owner = await upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@delivered.test`, name: null });
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Bán sàn ${randomUUID().slice(0, 6)}`);
    return { orgId, owner };
  }
  const execute = <T>(o: Org, name: string, input: unknown) => rt.execute<T>(name, input, { actor: asUser(o.owner), orgId: o.orgId, idempotencyKey: randomUUID() });
  async function read(o: Org, bytes: Uint8Array) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'don-hang.xlsx', contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    await readMarketplaceFile({ runtime: worker, store, extract }, o.orgId, fileId);
    return fileId;
  }
  const confirm = async (o: Org, bytes: Uint8Array) => execute<{ newLines: number; updatedLines: number; duplicateLines: number }>(o, 'finance.marketplace.confirm', { fileId: await read(o, bytes) });
  const days = (o: Org) =>
    rows<{ order_no: string; stage: string; delivered_at: string | null }>(
      `SELECT o.order_no, l.stage, l.delivered_at::text AS delivered_at FROM crove_finance.channel_order_line l
       JOIN crove_finance.channel_order o ON o.org_id = l.org_id AND o.id = l.order_id WHERE l.org_id = $1 ORDER BY o.order_no`,
      [o.orgId],
    );

  beforeAll(async () => {
    extract = inProcessExtract();
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
    const register = (target: Db) => new Runtime(target, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    rt = register(db);
    worker = register(createDb(workerPool));
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

  it('stores the completion day of a delivered line, and none for a line that has not been delivered', async () => {
    const o = await org();
    await confirm(o, report(row('D1', 'Hoàn thành', '2026-11-03 10:00'), row('D2', 'Đang giao', '2026-11-03 10:00'), row('D3', 'Hoàn thành', '')));
    expect(await days(o)).toEqual([
      { order_no: 'D1', stage: 'completed', delivered_at: '2026-11-03' },
      // A shipped line has not been delivered: a day the report gives it is not kept.
      { order_no: 'D2', stage: 'shipped', delivered_at: null },
      // A completed line whose report has no completion cell has no delivery day: nothing dates it by a guess.
      { order_no: 'D3', stage: 'completed', delivered_at: null },
    ]);
  });

  it('gives the day to a delivered line from a later report, as it advances or as it stands, and never changes it', async () => {
    const o = await org();
    await confirm(o, report(row('E1', 'Đang giao', ''), row('E2', 'Hoàn thành', '')));
    // E1 advances to completed with its day; E2 is unchanged but gets its day.
    expect(await confirm(o, report(row('E1', 'Hoàn thành', '2026-11-05'), row('E2', 'Hoàn thành', '2026-11-04')))).toMatchObject({ newLines: 0, updatedLines: 2 });
    expect(await days(o)).toEqual([
      { order_no: 'E1', stage: 'completed', delivered_at: '2026-11-05' },
      { order_no: 'E2', stage: 'completed', delivered_at: '2026-11-04' },
    ]);
    // Another report with another day changes nothing.
    expect(await confirm(o, report(row('E1', 'Hoàn thành', '2026-12-01'), row('E2', 'Hoàn thành', '2026-12-02')))).toMatchObject({ newLines: 0, updatedLines: 0, duplicateLines: 2 });
    expect((await days(o)).map((r) => r.delivered_at)).toEqual(['2026-11-05', '2026-11-04']);
  });

  it('holds the rules in the table: set once, and only on a delivered line', async () => {
    const o = await org();
    await confirm(o, report(row('F1', 'Hoàn thành', '2026-11-03'), row('F2', 'Đang giao', '')));
    // The day of a delivered line is never changed or cleared, even by the owner of the table.
    await expect(rows("UPDATE crove_finance.channel_order_line SET delivered_at = '2026-11-09' WHERE org_id = $1 AND line_key = 'QC-1' AND delivered_at IS NOT NULL", [o.orgId])).rejects.toMatchObject({ code: '23514', message: 'CHANNEL_ORDER_STAGE' });
    await expect(rows('UPDATE crove_finance.channel_order_line SET delivered_at = NULL WHERE org_id = $1 AND delivered_at IS NOT NULL', [o.orgId])).rejects.toMatchObject({ code: '23514' });
    // A line that has not been delivered cannot carry one.
    await expect(
      rows("UPDATE crove_finance.channel_order_line l SET delivered_at = '2026-11-03' FROM crove_finance.channel_order o WHERE l.org_id = $1 AND o.org_id = l.org_id AND o.id = l.order_id AND o.order_no = 'F2'", [o.orgId]),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('channel_order_line_delivered_ck') });
    // A delivered line that comes back keeps its day.
    await confirm(o, report(row('F1', 'Hoàn trả', '')));
    expect((await days(o)).find((r) => r.order_no === 'F1')).toMatchObject({ stage: 'returned', delivered_at: '2026-11-03' });
  });

  it('keeps no day for a delivery that did not happen: a shipped line that comes back and a line first seen returned, while a completed line that comes back may take its day', async () => {
    const o = await org();
    await confirm(o, report(row('G1', 'Đang giao', ''), row('G2', 'Hoàn thành', '')));
    // G1 failed delivery: the platform closes the order and fills its completion column, and the parcel came back. G3 is new and first seen returned, with a day.
    await confirm(o, report(row('G1', 'Hoàn trả', '2026-11-08'), row('G3', 'Hoàn trả', '2026-11-08')));
    // G2 is completed with no day and then comes back with one.
    await confirm(o, report(row('G2', 'Hoàn trả', '2026-11-09')));
    expect(await days(o)).toEqual([
      { order_no: 'G1', stage: 'returned', delivered_at: null },
      // G2 was completed, then came back: the day the report gives with the return is kept (it was delivered).
      { order_no: 'G2', stage: 'returned', delivered_at: '2026-11-09' },
      { order_no: 'G3', stage: 'returned', delivered_at: null },
    ]);
  });
});

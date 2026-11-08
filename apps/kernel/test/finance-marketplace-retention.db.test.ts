// SPDX-License-Identifier: AGPL-3.0-only
// Retention of the original file of a decided marketplace report (#2516 step C-2b3, ADR-0045 point 8), on a real PostgreSQL and the real parsing sandbox: 90 days after a member imports
// or skips an income report, the nightly job deletes the stored file and the staged read that holds the per-order amounts, and keeps the file row, its hash and the decision's summary. A report
// still staged, a bank statement and an invoice file are never touched whatever their age, nothing before day 90, the object only when no other file row names it, a rerun after a crash
// finishes the job, and the audit facts carry ids and counts only. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { MARKETPLACE_ORIGINAL_RETENTION_DAYS } from '@crove/kernel-contract';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries, readMarketplaceIncomeFile } from '@crove/mod-finance';
import { buildXlsx, type XlsxCell } from '../../extract/test/xlsx-fixture.ts';
import { runMarketplaceRetention } from '../src/marketplace-retention.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

// What the report carries about the buyer, which must be nowhere in what is stored.
const BUYER = { name: 'Lê Thị Mua Thử', phone: '0900000004', email: 'mua.thu4@example.com' };
const HEAD: XlsxCell[] = ['Mã đơn hàng', 'Người Mua', 'Số điện thoại', 'Email', 'Ngày hoàn tất thanh toán', 'Giá sản phẩm', 'Mã giảm giá của Shop', 'Phí cố định', 'Phí dịch vụ', 'Phí giao dịch', 'Thuế GTGT', 'Thuế TNCN', 'Tổng số tiền đã thanh toán'];
const row = (order: string, paid: string | null, sales: number, discount: number, commission: number, service: number, payment: number, vat: number, pit: number, net: number): XlsxCell[] => [
  order,
  BUYER.name,
  BUYER.phone,
  BUYER.email,
  paid,
  sales,
  -discount,
  -commission,
  -service,
  -payment,
  -vat,
  -pit,
  net,
];
// Two orders (80500 and 45250 net) and the totals row below the table; the table is on the second sheet behind a summary, as Shopee writes it.
const lines = (a: string, b: string, paid = ['2026-11-03', '2026-11-04']) => [row(a, paid[0] ?? null, 100000, 10000, 5000, 2000, 1500, 500, 500, 80500), row(b, paid[1] ?? null, 50000, 0, 2500, 1000, 750, 250, 250, 45250)];
// `note` only makes the bytes differ: two files with the same bytes are one file.
const workbook = (tableRows: XlsxCell[][], total: number | null = 125750, note = '') =>
  buildXlsx([['Tóm tắt', note], ['Tổng số tiền đã thanh toán', total ?? '']], {
    sheetName: 'Summary',
    moreSheets: [{ name: 'Income', rows: [['Báo cáo thu nhập'], HEAD, ...tableRows, ...(total === null ? [] : [['', '', '', '', '', '', '', '', '', '', '', '', total] as XlsxCell[]])] }],
  });

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
  // How many times each key was deleted: the job deletes once before the marker and once after.
  readonly deletes = new Map<string, number>();
  async delete(key: string) {
    this.deletes.set(key, (this.deletes.get(key) ?? 0) + 1);
    this.blobs.delete(key);
  }
  has(key: string) {
    return this.blobs.has(key);
  }
}

suite('retention of marketplace report originals (#2516, C-2b3)', () => {
  const dbName = `crove_test_mkt_retention_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@market.test`, name: null });
  type Org = { orgId: string; owner: string; member: string; viewer: string; a: string; b: string };
  async function org(known = true): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Bán sàn ${randomUUID().slice(0, 6)}`);
    const [member, viewer] = await Promise.all([identity('member'), identity('viewer')]);
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]);
    const o = { orgId, owner, member, viewer, a: `2611A${randomUUID().slice(0, 6).toUpperCase()}`, b: `2611B${randomUUID().slice(0, 6).toUpperCase()}` };
    if (known) await addOrders(o, o.a, o.b);
    return o;
  }
  // The orders the income report names, as an order report would have stored them.
  const addOrders = async (o: Org, ...orderNos: string[]) => {
    for (const orderNo of orderNos) await rows("INSERT INTO crove_finance.channel_order (org_id, platform, order_no) VALUES ($1, 'shopee', $2)", [o.orgId, orderNo]);
  };
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  async function ingest(o: Org, bytes: Uint8Array, filename = 'thu-nhap.xlsx') {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename, contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return fileId;
  }
  async function read(o: Org, bytes: Uint8Array) {
    const fileId = await ingest(o, bytes);
    const result = await readMarketplaceIncomeFile({ runtime: worker, store, extract }, o.orgId, fileId);
    return { fileId, ...result };
  }
  const confirm = (o: Org, fileId: string, user = o.member) => execute<{ settlementId: string; lines: number; reportNet: string; other: string }>(o, 'finance.marketplace_income.confirm', { fileId }, user);
  const settlements = (o: Org) => rows<{ id: string; platform: string; period_start: string; period_end: string; report_net: string; source_sha256: string | null }>("SELECT id::text, platform, period_start::text, period_end::text, report_net::text, source_sha256 FROM crove_finance.channel_settlement WHERE org_id = $1 ORDER BY period_start", [o.orgId]);
  const settlementLines = (o: Org) => rows<{ line_key: string; sales: string; commission: string; tax_withheld: string; other: string; net: string; source_row: number }>('SELECT line_key, sales::text, commission::text, tax_withheld::text, other::text, net::text, source_row FROM crove_finance.channel_settlement_line WHERE org_id = $1 ORDER BY line_key', [o.orgId]);

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


  let workerDb: Db;
  beforeAll(() => {
    workerDb = createDb(workerPool);
  });

  const DAY = MARKETPLACE_ORIGINAL_RETENTION_DAYS;
  const run = () => runMarketplaceRetention({ runtime: worker, workerDb, store, log: { log: () => undefined, error: () => undefined } });
  // Every test starts with nothing due: what an earlier test aged and left is cleared, so the totals a run reports are this test's own.
  afterEach(async () => {
    await run();
  });
  // Ages every extraction of a file by `days` (the guard on finished versions is switched off for this one session only: the test stands in for the passing of time).
  async function age(fileId: string, days: number) {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      await client.query('SET session_replication_role = replica');
      await client.query(`UPDATE crove_kernel.extraction SET completed_at = now() - make_interval(days => $2) WHERE file_id = $1`, [fileId, days]);
    } finally {
      await client.end();
    }
  }
  const fileRow = async (fileId: string) => {
    const [row] = await rows<{ original_deleted_at: string | null; sha256: string; storage_key: string }>('SELECT original_deleted_at::text, sha256, storage_key FROM crove_kernel.file WHERE id = $1', [fileId]);
    if (!row) throw new Error('no such file');
    return row;
  };
  const versions = (fileId: string) => rows<{ version: number; state: string | null; has_lines: boolean }>("SELECT version, result -> 'summary' ->> 'state' AS state, (result ? 'lines') AS has_lines FROM crove_kernel.extraction WHERE file_id = $1 ORDER BY version", [fileId]);
  const reject = (o: Org, fileId: string) => execute(o, 'finance.marketplace_income.reject', { fileId }, o.member);

  it('deletes the object and the staged read 90 days after a confirmation, and keeps the file row, its hash, the decision summary and the settlement', async () => {
    const o = await org();
    const { fileId } = await read(o, workbook(lines(o.a, o.b), 125750, 'confirmed'));
    await confirm(o, fileId);
    const before = await fileRow(fileId);
    expect(store.has(before.storage_key)).toBe(true);
    expect(await versions(fileId)).toEqual([
      { version: 1, state: 'staged', has_lines: true },
      { version: 2, state: 'imported', has_lines: false },
    ]);

    // Day 89: nothing is due yet.
    await age(fileId, DAY - 1);
    expect(await run()).toMatchObject({ deleted: 0, failed: 0 });
    expect(store.has(before.storage_key)).toBe(true);

    // Day 91: the original and the lines go.
    await age(fileId, DAY + 1);
    expect(await run()).toMatchObject({ deleted: 1, objects: 1, versions: 1, failed: 0 });
    expect(store.has(before.storage_key)).toBe(false);
    // Once before the marker and once after it (the window of a same-bytes upload in between).
    expect(store.deletes.get(before.storage_key)).toBe(2);
    const after = await fileRow(fileId);
    expect(after.original_deleted_at).not.toBeNull();
    expect(after.sha256).toBe(before.sha256);
    expect(await versions(fileId)).toEqual([{ version: 2, state: 'imported', has_lines: false }]);
    // What the confirmation stored is not touched: the settlement and its lines (append-only), and the decision's summary.
    expect(await settlements(o)).toHaveLength(1);
    expect(await settlementLines(o)).toHaveLength(2);
    const [kept] = await rows<{ result: { summary: { totals: { net: string }; importId: string } } }>('SELECT result FROM crove_kernel.extraction WHERE file_id = $1', [fileId]);
    expect(kept?.result.summary.totals.net).toBe('125750');

    // A rerun finds nothing more.
    expect(await run()).toMatchObject({ deleted: 0, objects: 0, versions: 0, failed: 0 });
  });

  it('covers a skipped report too, and the audit facts carry ids and counts only', async () => {
    const o = await org();
    const { fileId } = await read(o, workbook(lines(o.a, o.b), 125750, 'rejected'));
    await reject(o, fileId);
    await age(fileId, DAY + 5);
    expect(await run()).toMatchObject({ deleted: 1, failed: 0 });
    expect(await versions(fileId)).toEqual([{ version: 2, state: 'rejected', has_lines: false }]);
    const audit = await rows<{ detail: Record<string, unknown> }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.marketplace_retention.apply' AND outcome = 'ok'", [o.orgId]);
    expect(audit).toHaveLength(1);
    // The facts are the file id and two counts; the runtime adds only which worker ran it.
    expect(Object.keys(audit[0]?.detail ?? {}).sort()).toEqual(['applied', 'component', 'fileId', 'versions', 'workerInstance']);
    const text = JSON.stringify(audit) + JSON.stringify(await rows('SELECT * FROM crove_kernel.activity WHERE org_id = $1', [o.orgId]));
    for (const value of [...Object.values(BUYER), o.a, o.b, 'thu-nhap.xlsx']) expect(text).not.toContain(value);
  });

  it('never deletes a report still waiting for a member, whatever its age', async () => {
    const o = await org();
    const { fileId } = await read(o, workbook(lines(o.a, o.b), 125750, 'waiting'));
    await age(fileId, 400);
    expect(await run()).toMatchObject({ deleted: 0, failed: 0 });
    expect(store.has((await fileRow(fileId)).storage_key)).toBe(true);
    expect((await fileRow(fileId)).original_deleted_at).toBeNull();
    expect(await versions(fileId)).toEqual([{ version: 1, state: 'staged', has_lines: true }]);
  });

  it('never touches a bank statement or an invoice file, however old and however decided', async () => {
    const o = await org();
    const others: string[] = [];
    for (const [note, extraction] of [
      ['statement', { method: 'unsupported', result: { kind: 'bank_statement', summary: { state: 'imported' } } }],
      ['invoice', { method: 'einvoice_xml', result: { kind: 'invoice', summary: { state: 'imported' } } }],
      ['order-like text', { method: 'unsupported', result: { kind: 'other', summary: { state: 'rejected' } } }],
    ] as const) {
      const fileId = await ingest(o, new TextEncoder().encode(`not a marketplace report ${note} ${randomUUID()}`), `${note}.pdf`);
      await rows("INSERT INTO crove_kernel.extraction (org_id, file_id, method, status, result, checks) VALUES ($1, $2, $3, 'done', $4::jsonb, '[]')", [o.orgId, fileId, extraction.method, JSON.stringify(extraction.result)]);
      await age(fileId, 400);
      others.push(fileId);
    }
    expect(await run()).toMatchObject({ deleted: 0, objects: 0, failed: 0 });
    for (const fileId of others) {
      const row = await fileRow(fileId);
      expect(row.original_deleted_at).toBeNull();
      expect(store.has(row.storage_key)).toBe(true);
      expect((await versions(fileId)).length).toBeGreaterThan(0);
    }
    // The definer itself refuses them too, by name: a bug in the job cannot reach them.
    for (const fileId of others) {
      const applied = await worker.execute<{ applied: boolean }>('finance.marketplace_retention.apply', { fileId }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId });
      expect(applied.applied).toBe(false);
      const key = await worker.query('finance.marketplace_retention.key', { fileId }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId });
      expect(key).toBeNull();
    }
  });

  it('reads the key of a due file as not shared: the storage key is content addressed, so no other row can name it', async () => {
    const o = await org();
    const { fileId } = await read(o, workbook(lines(o.a, o.b), 125750, 'key'));
    await confirm(o, fileId);
    const system = { actor: { type: 'system' as const, component: 'test' }, orgId: o.orgId };
    // Not due yet: nothing is returned. Due: the key, not shared (file_storage_key_content_address leaves one row per key).
    expect(await worker.query('finance.marketplace_retention.key', { fileId }, system)).toBeNull();
    await age(fileId, DAY + 1);
    expect(await worker.query('finance.marketplace_retention.key', { fileId }, system)).toEqual({ storageKey: (await fileRow(fileId)).storage_key, shared: false });
  });

  it('finishes after a crash between the object and the row: a rerun deletes nothing twice and marks the row', async () => {
    const o = await org();
    const { fileId } = await read(o, workbook(lines(o.a, o.b), 125750, 'crash'));
    await confirm(o, fileId);
    await age(fileId, DAY + 1);
    // The worker died after deleting the object and before the row.
    await store.delete((await fileRow(fileId)).storage_key);
    expect(await run()).toMatchObject({ deleted: 1, failed: 0 });
    expect((await fileRow(fileId)).original_deleted_at).not.toBeNull();
    expect(await versions(fileId)).toEqual([{ version: 2, state: 'imported', has_lines: false }]);
  });

  it('refuses a download and a re-read of a deleted original in Vietnamese; the same bytes uploaded again bring it back for a night and are deleted again', async () => {
    const o = await org();
    const bytes = workbook(lines(o.a, o.b), 125750, 'gone');
    const { fileId } = await read(o, bytes);
    await reject(o, fileId);
    await age(fileId, DAY + 1);
    await run();
    await expect(query(o, 'kernel.file.get', { id: fileId })).rejects.toMatchObject({ code: 'FILE_ORIGINAL_DELETED', status: 409, message: expect.stringContaining('đã được xóa') });
    await expect(execute(o, 'kernel.file.reextract', { fileId })).rejects.toMatchObject({ code: 'FILE_ORIGINAL_DELETED', status: 409, message: expect.stringContaining('đã được xóa') });
    // The same bytes uploaded again are still one file (a duplicate): the upload stores the object under the same content-addressed key first, which brings the original back, and the
    // marker is cleared so the file reads again. The next nightly run deletes that copy again (the decision is old), so a restored original is never kept past it.
    const sha256 = sha256Hex(bytes);
    const key = fileKey(o.orgId, sha256);
    const generation = await store.put(key, bytes);
    const again = await rt.execute<{ fileId: string; duplicate: boolean }>(
      'kernel.file.ingest',
      { filename: 'thu-nhap.xlsx', contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey: key, generation, source: 'upload' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    expect(again).toMatchObject({ fileId, duplicate: true });
    expect((await fileRow(fileId)).original_deleted_at).toBeNull();
    expect(store.has(key)).toBe(true);
    await expect(query(o, 'kernel.file.get', { id: fileId })).resolves.toMatchObject({ id: fileId });
    expect(await run()).toMatchObject({ deleted: 1, objects: 1, failed: 0 });
    expect(store.has(key)).toBe(false);
    expect((await fileRow(fileId)).original_deleted_at).not.toBeNull();
    await expect(query(o, 'kernel.file.get', { id: fileId })).rejects.toMatchObject({ code: 'FILE_ORIGINAL_DELETED' });
  });

  it('lets no reader open a file whose original was deleted, even when the store still holds the recorded version (a versioned bucket keeps it)', async () => {
    const o = await org();
    const bytes = workbook(lines(o.a, o.b), 125750, 'versioned');
    const { fileId } = await read(o, bytes);
    await confirm(o, fileId);
    await age(fileId, DAY + 1);
    await run();
    const { storage_key: key } = await fileRow(fileId);
    // The store's delete left the noncurrent version readable by its recorded generation: put the bytes back to stand for it.
    await store.put(key, bytes);
    const system = { actor: { type: 'system' as const, component: 'finance.extract' }, orgId: o.orgId };
    // The one query every finance reader (extraction, order report, income report, bank statement) starts from answers as for a file that is not there.
    expect(await worker.query('finance.extraction.file', { fileId }, system)).toBeNull();
    expect(await worker.query('finance.extraction.file', { fileId, version: 1 }, system)).toBeNull();
    expect(await readMarketplaceIncomeFile({ runtime: worker, store, extract }, o.orgId, fileId)).toEqual({ handled: false });
    // An .xlsx arrives as a ZIP: the archive reader is refused too.
    expect(await worker.query('kernel.file.archive.source', { fileId }, system)).toBeNull();
    // The download and the re-read are refused.
    await expect(query(o, 'kernel.file.get', { id: fileId })).rejects.toMatchObject({ code: 'FILE_ORIGINAL_DELETED' });
    await expect(execute(o, 'kernel.file.reextract', { fileId })).rejects.toMatchObject({ code: 'FILE_ORIGINAL_DELETED' });
  });

  it('never deletes a file under an evidence hold or named by a purchase document as its source', async () => {
    const o = await org();
    const held = await read(o, workbook(lines(o.a, o.b), 125750, 'held'));
    await confirm(o, held.fileId);
    const named = await read(o, workbook(lines(o.a, o.b), 125750, 'named'));
    await reject(o, named.fileId);
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      // The guards of held_until and of the purchase document's constraints are switched off for this one session only: the test stands in for the store's hold and a booked invoice.
      await client.query('SET session_replication_role = replica');
      await client.query("UPDATE crove_kernel.file SET held_until = now() + interval '1 year' WHERE id = $1", [held.fileId]);
      await client.query(
        `INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_number, invoice_date, subtotal, vat_amount, total, source_file_id) VALUES ($1, $2, 'X1', '2026-11-01', 1, 0, 1, $3)`,
        [o.orgId, randomUUID(), named.fileId],
      );
    } finally {
      await client.end();
    }
    await age(held.fileId, DAY + 30);
    await age(named.fileId, DAY + 30);
    expect(await run()).toMatchObject({ deleted: 0, objects: 0, failed: 0 });
    for (const fileId of [held.fileId, named.fileId]) {
      const row = await fileRow(fileId);
      expect(row.original_deleted_at).toBeNull();
      expect(store.has(row.storage_key)).toBe(true);
      expect((await versions(fileId)).length).toBe(2);
    }
  });

  it('refuses a shorter period, a caller that is not the worker, and any other change of the marker', async () => {
    const o = await org();
    const { fileId } = await read(o, workbook(lines(o.a, o.b), 125750, 'guards'));
    await confirm(o, fileId);
    await age(fileId, DAY + 1);
    // 30 days, asked straight of the database as the worker: refused, so no bug in the job can delete early.
    await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_retention_due(30, 10)')).rejects.toThrow(/MARKETPLACE_RETENTION_TOO_SHORT/);
    // Asked straight of the database with no system context (the worker's login role alone), key and apply refuse: they need the system actor and the context org.
    await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_retention_apply($1::uuid, $2::uuid, $3::int)', [o.orgId, fileId, DAY])).rejects.toThrow(/MARKETPLACE_RETENTION_WORKER_ONLY/);
    await expect(workerPool.query('SELECT * FROM crove_finance.marketplace_retention_key($1::uuid, $2::uuid, $3::int)', [o.orgId, fileId, DAY])).rejects.toThrow(/MARKETPLACE_RETENTION_WORKER_ONLY/);
    // A member, even the owner, cannot run the command or the query through the runtime: both are for the system actor only.
    await expect(execute(o, 'finance.marketplace_retention.apply', { fileId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(query(o, 'finance.marketplace_retention.key', { fileId })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // The app role (the API process) cannot list, key or apply.
    await expect(pool.query('SELECT * FROM crove_finance.marketplace_retention_due($1, 10)', [DAY])).rejects.toThrow(/permission denied|MARKETPLACE_RETENTION_WORKER_ONLY/);
    // Setting the marker by hand is refused by the trigger, even for the database owner.
    await expect(rows('UPDATE crove_kernel.file SET original_deleted_at = now() WHERE id = $1', [fileId])).rejects.toThrow(/FILE_ORIGINAL_DELETED_IMMUTABLE/);
    // After a real deletion it cannot be cleared by hand either: only the restore definer (a duplicate upload) clears it, in the caller's own org.
    await run();
    await expect(rows('UPDATE crove_kernel.file SET original_deleted_at = NULL WHERE id = $1', [fileId])).rejects.toThrow(/FILE_ORIGINAL_DELETED_IMMUTABLE/);
    await expect(pool.query('SELECT crove_kernel.file_original_restore($1::uuid)', [fileId])).rejects.toThrow(/permission denied|FILE_ORIGINAL_RESTORE_NO_ORG/);
  });
});

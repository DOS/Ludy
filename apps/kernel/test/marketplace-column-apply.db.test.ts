// SPDX-License-Identifier: AGPL-3.0-only
// A saved column mapping applied on import (#4037) on a real PostgreSQL 17 and the real parsing sandbox: a spreadsheet no built-in profile fits is read through the mapping the org saved for a file with the
// same header row and STAGED like any order report (a member still confirms it, and the orders are stored then); another org's mapping, another header row and a mapping the file refuses read nothing; the
// lookup is the worker's alone and the newest confirmation wins. The files are made in code with made-up buyers.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { encodeMarketplaceColumnsInput, type ExtractClient } from '@ludy/extract-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries, readMarketplaceFile } from '@ludy/mod-finance';
import { buildXlsx, type XlsxCell } from '../../extract/test/xlsx-fixture.ts';
import { inProcessExtract } from './extract-service.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

const BUYER = { name: 'Trần Thị Mua Thử', phone: '0900000007' };
const HEAD: XlsxCell[] = ['Số hiệu đơn', 'Ngày tạo', 'Tình trạng', 'Tên người nhận', 'SĐT', 'Mô tả mặt hàng', 'Số lượng', 'Giá bán', 'Tham chiếu 1', 'Cột tự do'];
const row = (order: string, status: string, qty: number, price: number): XlsxCell[] => [order, '2026-10-30', status, BUYER.name, BUYER.phone, `Sản phẩm ${order}`, qty, price, '0900000011', `${BUYER.name} mua`];
const report = (head: XlsxCell[], ...rows: XlsxCell[][]) => buildXlsx([['Báo cáo của cửa hàng'], head, ...rows]);
// The mapping a person confirmed for this layout, as the profile table stores it (header text as the file words it).
const COLUMNS = [
  { index: 0, header: 'Số hiệu đơn', field: 'orderNo' },
  { index: 1, header: 'Ngày tạo', field: 'orderedAt' },
  { index: 2, header: 'Tình trạng', field: 'status' },
  { index: 5, header: 'Mô tả mặt hàng', field: 'itemName' },
  { index: 6, header: 'Số lượng', field: 'quantity' },
  { index: 7, header: 'Giá bán', field: 'unitPrice' },
];
const REFUSED_COLUMNS = [
  { index: 1, header: 'Ngày tạo', field: 'orderNo' },
  { index: 2, header: 'Tình trạng', field: 'quantity' },
];

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

suite('a saved column mapping applied on import (#4037)', () => {
  const dbName = `ludy_test_column_apply_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let workerPool: pg.Pool;
  let rt: Runtime;
  let worker: Runtime;
  let extract: ExtractClient;
  let digest = '';
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
  type Org = { orgId: string; owner: string; member: string };
  const person = (name: string) => upsertIdentity(createDb(pool), { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@apply.test`, name: null });
  async function org(): Promise<Org> {
    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Áp dụng ${randomUUID().slice(0, 6)}`);
    const member = await person('member');
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')", [orgId, member]);
    return { orgId, owner, member };
  }
  async function ingest(o: Org, bytes: Uint8Array) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await rt.execute<{ fileId: string }>('kernel.file.ingest', { filename: 'don-hang.xlsx', contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' }, { actor: asUser(o.owner), orgId: o.orgId });
    return fileId;
  }
  const read = async (o: Org, bytes: Uint8Array) => {
    const fileId = await ingest(o, bytes);
    return { fileId, ...(await readMarketplaceFile({ runtime: worker, store, extract }, o.orgId, fileId)) };
  };
  const saveProfile = (o: Org, columns: unknown, over: { platform?: string; digest?: string; at?: string } = {}) =>
    rows('INSERT INTO ludy_finance.marketplace_column_profile (org_id, platform, header_row, columns, header_digest, confirmed_by, confirmed_at) VALUES ($1, $2, 1, $3::jsonb, $4, $5, COALESCE($6::timestamptz, clock_timestamp()))', [
      o.orgId,
      over.platform ?? 'shopee',
      JSON.stringify(columns),
      over.digest ?? digest,
      o.owner,
      over.at ?? null,
    ]);
  const staged = (o: Org) => rt.query<Array<{ fileId: string; summary: { platform: string; lines: number; orders: number; profileVersion: string; profileConfirmed: boolean } }>>('finance.marketplace.staged', {}, { actor: asUser(o.member), orgId: o.orgId });
  const orderRows = (o: Org) => rows<{ order_no: string }>('SELECT order_no FROM ludy_finance.channel_order WHERE org_id = $1 ORDER BY order_no', [o.orgId]);

  beforeAll(async () => {
    extract = inProcessExtract();
    const sheet = await extract.extract('marketplace_columns', encodeMarketplaceColumnsInput({ fileBase64: Buffer.from(report(HEAD, row('1', 'Hoàn thành', 1, 1))).toString('base64') }));
    if (!sheet.ok || !sheet.columns.sheet?.headerDigest) throw new Error('the sandbox gave no header digest');
    digest = sheet.columns.sheet.headerDigest;
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
    workerPool = createPool({ connectionString: login('ludy_worker', 'test-worker-pw'), max: 2 });
    const register = (db: Db) => new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
    rt = register(createDb(pool));
    worker = register(createDb(workerPool));
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await workerPool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('leaves a file no profile fits alone while the org has saved no mapping for its header row', async () => {
    const o = await org();
    const result = await read(o, report(HEAD, row('9001', 'Hoàn thành', 2, 50000)));
    expect(result.handled).toBe(false);
    expect(await staged(o)).toEqual([]);
  });

  it('stages the file through the saved mapping like any report, and the orders are stored only when a member confirms', async () => {
    const o = await org();
    await saveProfile(o, COLUMNS);
    // Another file with the same header row (other rows, another title): found by the digest.
    const result = await read(o, report(HEAD, row('9001', 'Hoàn thành', 2, 50000), row('9002', 'Đã hủy', 1, 120000), row('9003', 'Hoàn thành', 3, 50000)));
    expect(result.handled).toBe(true);
    const waiting = await staged(o);
    expect(waiting.map((s) => s.fileId)).toEqual([result.fileId]);
    expect(waiting[0]?.summary).toMatchObject({ platform: 'shopee', lines: 3, orders: 3, profileConfirmed: false });
    // A mapping a person confirmed is not the profile's own words, nor a real seller's file checked: its version says so.
    expect(waiting[0]?.summary.profileVersion).toMatch(/\+columns$/);
    // Staged, nothing stored yet; a member confirms and the orders are stored once.
    expect(await orderRows(o)).toEqual([]);
    await rt.execute('finance.marketplace.confirm', { fileId: result.fileId }, { actor: asUser(o.member), orgId: o.orgId, idempotencyKey: randomUUID() });
    expect((await orderRows(o)).map((r) => r.order_no)).toEqual(['9001', '9002', '9003']);
    // Nothing of the buyer is stored anywhere in the org's rows.
    const everything = JSON.stringify(await rows('SELECT to_jsonb(l) AS l FROM ludy_finance.channel_order_line l WHERE org_id = $1', [o.orgId]));
    for (const value of Object.values(BUYER)) expect(everything).not.toContain(value);
  });

  it('does not use another org\'s mapping, nor a mapping for another header row', async () => {
    const [a, b] = [await org(), await org()];
    await saveProfile(b, COLUMNS);
    expect((await read(a, report(HEAD, row('9001', 'Hoàn thành', 2, 50000)))).handled).toBe(false);
    expect((await read(b, report(HEAD, row('9001', 'Hoàn thành', 2, 50000)))).handled).toBe(true);
    const renamed = [...HEAD];
    renamed[1] = 'Ngày đặt hàng';
    expect((await read(b, report(renamed, row('9002', 'Hoàn thành', 2, 50000)))).handled).toBe(false);
    expect(await staged(a)).toEqual([]);
  });

  it('reads nothing when the check refuses the saved mapping on this file, and stages nothing', async () => {
    const o = await org();
    await saveProfile(o, REFUSED_COLUMNS);
    expect((await read(o, report(HEAD, row('9001', 'Hoàn thành', 2, 50000)))).handled).toBe(false);
    expect(await staged(o)).toEqual([]);
  });

  it('lists the mappings for the worker alone: the latest for each header row, whichever platform, the newest first', async () => {
    const o = await org();
    await saveProfile(o, COLUMNS, { platform: 'tiktok_shop', at: '2026-11-01T00:00:00Z' });
    await saveProfile(o, COLUMNS, { platform: 'lazada', at: '2026-11-02T00:00:00Z' });
    await saveProfile(o, REFUSED_COLUMNS, { digest: 'f'.repeat(64), at: '2026-11-03T00:00:00Z' });
    await expect(rt.query('finance.marketplace.columns_saved', {}, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    const system = { type: 'system' as const, component: 'test' };
    const saved = await worker.query<Array<{ headerDigest: string; platform: string; columns: unknown }>>('finance.marketplace.columns_saved', {}, { actor: system, orgId: o.orgId });
    expect(saved.map((s) => [s.headerDigest, s.platform])).toEqual([
      ['f'.repeat(64), 'shopee'],
      [digest, 'lazada'],
    ]);
    expect(saved[1]?.columns).toEqual(COLUMNS);
    // An org with none gets an empty list, and the lookup takes no digest from a caller.
    expect(await worker.query('finance.marketplace.columns_saved', {}, { actor: system, orgId: (await org()).orgId })).toEqual([]);
    await expect(worker.query('finance.marketplace.columns_saved', { headerDigest: digest }, { actor: system, orgId: o.orgId })).rejects.toBeTruthy();
  });
});

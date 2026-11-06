// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace order reports as files (#2515, ADR-0045 points 4, 5 and 7), on a real PostgreSQL 17 and the real parsing sandbox: a Shopee report is read and STAGED with nothing stored, a
// member confirms it and the orders are stored once (a stage only moves forward, a re-upload is idempotent), the lines that name a stock item move stock at shipment and again on a return,
// a file that is no report or has rows the profile cannot read stores nothing, and no buyer data of the report appears in any stored row. The files are made in code with made-up buyers.
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

// What the report carries about the buyer, which must be nowhere in what is stored.
const BUYER = { name: 'Lê Thị Mua Thử', phone: '0900000003', email: 'mua.thu3@example.com', address: '3 Phố Thử, Quận Thử, Hà Nội' };
const HEAD: XlsxCell[] = ['Mã đơn hàng', 'Ngày đặt hàng', 'Trạng Thái Đơn Hàng', 'Người Mua', 'Số điện thoại', 'Địa chỉ nhận hàng', 'Email', 'SKU phân loại hàng', 'Tên sản phẩm', 'Giá ưu đãi', 'Số lượng', 'Tổng giá bán (sản phẩm)'];
const row = (order: string, status: string, sku: string, qty: number, price = 50000): XlsxCell[] => [order, '2026-10-30 14:05', status, BUYER.name, BUYER.phone, BUYER.address, BUYER.email, sku, `Sản phẩm ${sku}`, price, qty, price * qty];
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

suite('marketplace order reports (#2515)', () => {
  const dbName = `crove_test_marketplace_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  type Org = { orgId: string; owner: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Bán sàn ${randomUUID().slice(0, 6)}`);
    const [member, viewer] = await Promise.all([identity('member'), identity('viewer')]);
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]);
    return { orgId, owner, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const makeItem = (o: Org, code: string, extra: Record<string, unknown> = {}) =>
    execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code, name: `Hàng ${code}`, unit: 'gói', stockAccount: '156', trade: 'goods', ...extra }).then((r) => r.id);
  const onHand = async (o: Org, itemId: string) => (await query<Array<{ id: string; onHand: string }>>(o, 'finance.stock_item.list', {})).find((i) => i.id === itemId)?.onHand;
  const moves = (o: Org, itemId: string) => rows<{ order_move: string; quantity: string }>("SELECT order_move, quantity::text FROM crove_finance.stock_move WHERE org_id = $1 AND item_id = $2 AND source_type = 'order_line' ORDER BY created_at, order_move", [o.orgId, itemId]);
  const orderRows = (o: Org) => rows<{ order_no: string; stage: string; quantity: string }>('SELECT o.order_no, l.stage, l.quantity::text FROM crove_finance.channel_order_line l JOIN crove_finance.channel_order o ON o.org_id = l.org_id AND o.id = l.order_id WHERE l.org_id = $1 ORDER BY o.order_no, l.line_key', [o.orgId]);
  async function ingest(o: Org, bytes: Uint8Array) {
    const sha256 = sha256Hex(bytes);
    const storageKey = fileKey(o.orgId, sha256);
    const generation = await store.put(storageKey, bytes);
    const { fileId } = await rt.execute<{ fileId: string }>(
      'kernel.file.ingest',
      { filename: 'don-hang.xlsx', contentType: 'application/zip', sizeBytes: bytes.byteLength, sha256, storageKey, generation, source: 'upload' },
      { actor: asUser(o.owner), orgId: o.orgId },
    );
    return fileId;
  }
  // The worker's side: the file is read as an order report; handled is false for a file that is none.
  async function read(o: Org, bytes: Uint8Array) {
    const fileId = await ingest(o, bytes);
    const result = await readMarketplaceFile({ runtime: worker, store, extract }, o.orgId, fileId);
    return { fileId, ...result };
  }
  const confirm = (o: Org, fileId: string, user = o.member) => execute<{ newLines: number; updatedLines: number; duplicateLines: number; stockMoves: number }>(o, 'finance.marketplace.confirm', { fileId }, user);

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

  it('stages a report and stores nothing until a member confirms, with no buyer value in the read', async () => {
    const o = await org();
    const bytes = report(row('A1', 'Đang giao', 'QC-1', 2), row('A2', 'Đã hủy', 'QC-2', 1), row('A3', 'Hoàn thành', 'QC-1', 1));
    const { fileId, handled } = await read(o, bytes);
    expect(handled).toBe(true);
    const run = (await rows<{ result: { kind: string; summary: Record<string, unknown> } }>('SELECT result FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2 ORDER BY version DESC LIMIT 1', [o.orgId, fileId]))[0]?.result;
    expect(run).toMatchObject({ kind: 'marketplace_orders', summary: { state: 'staged', platform: 'shopee', orders: 3, lines: 3, profileConfirmed: false, stages: { shipped: 1, completed: 1, cancelled: 1, placed: 0, returned: 0, unknown: 0 } } });
    // Nothing is stored as an order or as stock, and no buyer value was kept anywhere in the read.
    expect(await orderRows(o)).toEqual([]);
    for (const value of Object.values(BUYER)) expect(JSON.stringify(run)).not.toContain(value);
    const staged = await query<Array<{ fileId: string; summary: { platform: string; lines: number } }>>(o, 'finance.marketplace.staged', {}, o.member);
    expect(staged).toEqual([expect.objectContaining({ fileId, summary: expect.objectContaining({ platform: 'shopee', lines: 3 }) })]);
    // A viewer neither lists nor confirms.
    await expect(query(o, 'finance.marketplace.staged', {}, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(confirm(o, fileId, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await orderRows(o)).toEqual([]);
  });

  it('stores the orders once on confirm, moves stock for the lines that name an item, and treats a re-upload as nothing new', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-1');
    const first = await read(o, report(row('A1', 'Đang giao', 'QC-1', 2), row('A2', 'Đã hủy', 'QC-2', 1), row('A3', 'Hoàn thành', 'QC-1', 1), row('A9', 'Đang giao', 'LẠ-1', 4)));
    // How it stands before the decision: three lines move stock, two of them name the item, one a SKU no item has yet.
    expect(await query(o, 'finance.marketplace.preview', { fileId: first.fileId }, o.member)).toEqual({ newLines: 4, knownLines: 0, advancedLines: 0, matchedLines: 2, unmatchedLines: 1 });
    expect(await confirm(o, first.fileId)).toEqual({ newLines: 4, updatedLines: 0, duplicateLines: 0, stockMoves: 2 });
    expect(await onHand(o, item)).toBe('-3');
    expect((await orderRows(o)).map((r) => [r.order_no, r.stage])).toEqual([
      ['A1', 'shipped'],
      ['A2', 'cancelled'],
      ['A3', 'completed'],
      ['A9', 'shipped'],
    ]);
    // Decided once.
    await expect(confirm(o, first.fileId)).rejects.toMatchObject({ code: 'MARKETPLACE_NOT_STAGED' });
    // An overlapping report: A1 has got to completed (a stage moves forward), A3 is as it was, A4 is new. Only the new line and the advanced one count, and the shipped stock is not moved twice.
    const second = await read(o, report(row('A1', 'Hoàn thành', 'QC-1', 2), row('A3', 'Hoàn thành', 'QC-1', 1), row('A4', 'Đang giao', 'QC-1', 5)));
    expect(await confirm(o, second.fileId)).toEqual({ newLines: 1, updatedLines: 1, duplicateLines: 1, stockMoves: 1 });
    expect(await onHand(o, item)).toBe('-8');
    expect((await moves(o, item)).map((m) => [m.order_move, m.quantity])).toEqual([
      ['ship', '-2.000000'],
      ['ship', '-1.000000'],
      ['ship', '-5.000000'],
    ]);
    // A report showing an earlier stage than the org holds changes nothing (never backwards).
    const third = await read(o, report(row('A1', 'Đang giao', 'QC-1', 2), row('A44', 'Chờ xác nhận', 'QC-1', 1)));
    expect(await confirm(o, third.fileId)).toEqual({ newLines: 1, updatedLines: 0, duplicateLines: 1, stockMoves: 0 });
    expect((await orderRows(o)).find((r) => r.order_no === 'A1')?.stage).toBe('completed');
    expect(await onHand(o, item)).toBe('-8');
  });

  it('takes a returned order line back into stock once, through the item the shipment moved', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-1');
    await confirm(o, (await read(o, report(row('R1', 'Đang giao', 'QC-1', 2)))).fileId);
    expect(await onHand(o, item)).toBe('-2');
    expect(await confirm(o, (await read(o, report(row('R1', 'Đã hoàn trả', 'QC-1', 2)))).fileId)).toEqual({ newLines: 0, updatedLines: 1, duplicateLines: 0, stockMoves: 1 });
    expect(await onHand(o, item)).toBe('0');
    expect((await moves(o, item)).map((m) => m.order_move).sort()).toEqual(['return', 'ship']);
    // A report that still says returned moves nothing more.
    expect(await confirm(o, (await read(o, report(row('R1', 'Đã hoàn trả', 'QC-1', 2), row('R2', 'Chờ xác nhận', 'QC-1', 1)))).fileId)).toEqual({ newLines: 1, updatedLines: 0, duplicateLines: 1, stockMoves: 0 });
    expect(await onHand(o, item)).toBe('0');
    // A line first seen already returned ships and returns in one go: the net is nothing, and each happens once.
    expect(await confirm(o, (await read(o, report(row('R3', 'Đã hoàn trả', 'QC-1', 3)))).fileId)).toMatchObject({ newLines: 1, stockMoves: 2 });
    expect(await onHand(o, item)).toBe('0');
  });

  it('brings the stock back when an order is cancelled after it shipped, and nothing when it was cancelled before', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-1');
    await confirm(o, (await read(o, report(row('C1', 'Đang giao', 'QC-1', 2), row('C2', 'Chờ xác nhận', 'QC-1', 1)))).fileId);
    expect(await onHand(o, item)).toBe('-2');
    // C1 failed delivery (cancelled after it shipped): the goods are back, once. C2 was cancelled before it shipped: nothing to bring back.
    expect(await confirm(o, (await read(o, report(row('C1', 'Đã hủy', 'QC-1', 2), row('C2', 'Đã hủy', 'QC-1', 1)))).fileId)).toEqual({ newLines: 0, updatedLines: 2, duplicateLines: 0, stockMoves: 1 });
    expect(await onHand(o, item)).toBe('0');
    expect((await moves(o, item)).map((m) => m.order_move).sort()).toEqual(['return', 'ship']);
    expect((await orderRows(o)).map((r) => [r.order_no, r.stage])).toEqual([
      ['C1', 'cancelled'],
      ['C2', 'cancelled'],
    ]);
    // Again: nothing more. A line first seen cancelled moved nothing.
    expect(await confirm(o, (await read(o, report(row('C1', 'Đã hủy', 'QC-1', 2), row('C3', 'Đã hủy', 'QC-1', 4)))).fileId)).toEqual({ newLines: 1, updatedLines: 0, duplicateLines: 1, stockMoves: 0 });
    expect(await onHand(o, item)).toBe('0');
  });

  it('refuses to reverse a move of an order line, in the app and in the database, and refuses one of another legal entity', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-1');
    await confirm(o, (await read(o, report(row('G1', 'Đang giao', 'QC-1', 2)))).fileId);
    const [ship] = await rows<{ id: string; order_line_id: string }>("SELECT id, order_line_id FROM crove_finance.stock_move WHERE org_id = $1 AND order_move = 'ship'", [o.orgId]);
    await expect(execute(o, 'finance.stock_move.reverse', { moveId: ship?.id })).rejects.toMatchObject({ code: 'STOCK_MOVE_ORDER_LINE' });
    // Not even a row written straight to the table gets past the guard.
    await expect(
      rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, reverses_move_id) VALUES ($1, $2, '2026-11-01', 2, 'reversal', $3)", [o.orgId, item, ship?.id]),
    ).rejects.toThrow(/STOCK_ORDER_REVERSAL/);
    expect(await onHand(o, item)).toBe('-2');
    // A move of an order line is of the line's own legal entity: an item of another entity is refused by the table.
    const other = (await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, created_by) VALUES ($1, 'Pháp nhân phụ', $2) RETURNING id", [o.orgId, o.owner]))[0]?.id;
    const foreign = await makeItem(o, 'QC-9', { legalEntityId: other });
    await expect(
      rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, order_line_id, order_move) VALUES ($1, $2, '2026-11-01', -1, 'order_line', $3, 'ship')", [o.orgId, foreign, ship?.order_line_id]),
    ).rejects.toThrow(/STOCK_ORDER_ENTITY/);
  });

  it('assigns a line without teaching its SKU unless asked, so a wrong choice is not repeated by the next report', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-1');
    await confirm(o, (await read(o, report(row('T1', 'Đang giao', 'MA-SAI', 2)))).fileId);
    const [open] = await query<Array<{ lineId: string }>>(o, 'finance.marketplace.unassigned', {}, o.member);
    expect(await execute(o, 'finance.marketplace.assign', { lineId: open?.lineId, itemId: item, factor: '3' }, o.member)).toEqual({ moves: 1 });
    expect(await onHand(o, item)).toBe('-6');
    expect(await rows("SELECT 1 FROM crove_finance.stock_alias WHERE org_id = $1 AND source = 'shopee'", [o.orgId])).toEqual([]);
    // The next report with the same SKU is not moved by itself: it waits to be assigned again.
    expect(await confirm(o, (await read(o, report(row('T2', 'Đang giao', 'MA-SAI', 1)))).fileId)).toMatchObject({ newLines: 1, stockMoves: 0 });
    expect((await query<unknown[]>(o, 'finance.marketplace.unassigned', {}, o.member)).length).toBe(1);
  });

  it('holds the stage of a line in the table: a shipment only for a line that shipped, a return only for one that came back', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-1');
    await confirm(o, (await read(o, report(row('S1', 'Chờ xác nhận', 'QC-1', 1), row('S2', 'Đang giao', 'QC-1', 2), row('S3', 'Đã hủy', 'QC-1', 1)))).fileId);
    const lineOf = async (order: string) => (await rows<{ id: string }>('SELECT l.id FROM crove_finance.channel_order_line l JOIN crove_finance.channel_order o ON o.org_id = l.org_id AND o.id = l.order_id WHERE l.org_id = $1 AND o.order_no = $2', [o.orgId, order]))[0]?.id;
    const insert = (line: string | undefined, move: 'ship' | 'return', quantity: string) =>
      rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, order_line_id, order_move) VALUES ($1, $2, '2026-11-01', $3, 'order_line', $4, $5)", [o.orgId, item, quantity, line, move]);
    // A placed line and a line cancelled before it shipped move no shipment.
    await expect(insert(await lineOf('S1'), 'ship', '-1')).rejects.toThrow(/STOCK_ORDER_STAGE/);
    await expect(insert(await lineOf('S3'), 'ship', '-1')).rejects.toThrow(/STOCK_ORDER_STAGE/);
    // A shipped line has not come back: no return, whatever its shipment (S2 moved by itself: its SKU is the item's code).
    await expect(insert(await lineOf('S2'), 'return', '2')).rejects.toThrow(/STOCK_ORDER_STAGE/);
    // A line cancelled without shipping passes the stage and is still refused a return with no shipment behind it.
    await expect(insert(await lineOf('S3'), 'return', '1')).rejects.toThrow(/STOCK_ORDER_RETURN/);
    // The ways stock really moves still work: the shipment of S2 exists, and returned and cancelled-after-shipping lines bring it back.
    expect((await moves(o, item)).map((m) => m.order_move)).toEqual(['ship']);
    expect(await confirm(o, (await read(o, report(row('S2', 'Đã hủy', 'QC-1', 2)))).fileId)).toMatchObject({ updatedLines: 1, stockMoves: 1 });
    expect(await onHand(o, item)).toBe('0');
  });

  it('takes a line back from the item it was given: the stock comes back, the line waits again, and a new assignment moves it once more', async () => {
    const o = await org();
    const wrong = await makeItem(o, 'QC-A');
    const right = await makeItem(o, 'QC-B');
    await confirm(o, (await read(o, report(row('X1', 'Đang giao', 'MA-LA', 3)))).fileId);
    const unassigned = () => query<Array<{ lineId: string }>>(o, 'finance.marketplace.unassigned', {}, o.member);
    const [open] = await unassigned();
    const line = open?.lineId as string;
    // A wrong item at a wrong factor, remembered for the platform.
    await execute(o, 'finance.marketplace.assign', { lineId: line, itemId: wrong, factor: '2', teach: true }, o.member);
    expect(await onHand(o, wrong)).toBe('-6');
    const aliases = () => rows("SELECT 1 FROM crove_finance.stock_alias WHERE org_id = $1 AND source = 'shopee'", [o.orgId]);
    expect(await aliases()).toHaveLength(1);
    const itemOf = async () => (await query<Array<{ orderNo: string; lines: Array<{ itemCode: string | null }> }>>(o, 'finance.marketplace.orders', {}, o.viewer)).find((r) => r.orderNo === 'X1')?.lines[0]?.itemCode;
    expect(await itemOf()).toBe('QC-A');
    // A viewer cannot, and a line with no item has nothing to take back.
    await expect(execute(o, 'finance.marketplace.unassign', { lineId: line }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Unassigned: the stock is what it was, the history stays (the shipment and its reversal), the line waits again and the remembered name stays unless asked to go.
    expect(await execute(o, 'finance.marketplace.unassign', { lineId: line }, o.member)).toEqual({ moves: 1, forgot: false });
    expect(await onHand(o, wrong)).toBe('0');
    expect((await rows<{ n: number }>('SELECT count(*)::int AS n FROM crove_finance.stock_move WHERE org_id = $1 AND item_id = $2', [o.orgId, wrong]))[0]?.n).toBe(2);
    expect((await unassigned()).map((l) => l.lineId)).toEqual([line]);
    expect(await itemOf()).toBeNull();
    expect(await aliases()).toHaveLength(1);
    await expect(execute(o, 'finance.marketplace.unassign', { lineId: line }, o.member)).rejects.toMatchObject({ code: 'MARKETPLACE_LINE_NOT_ASSIGNED' });
    // The right item, once: the stock moves at the new attempt and the line is assigned again.
    expect(await execute(o, 'finance.marketplace.assign', { lineId: line, itemId: right }, o.member)).toEqual({ moves: 1 });
    expect(await onHand(o, right)).toBe('-3');
    expect(await itemOf()).toBe('QC-B');
    await expect(execute(o, 'finance.marketplace.assign', { lineId: line, itemId: right }, o.member)).rejects.toMatchObject({ code: 'MARKETPLACE_LINE_ASSIGNED' });
    // Taken back again with "forget": the remembered name is A's, not the right item's, so it stays for the lines that carry it.
    expect(await execute(o, 'finance.marketplace.unassign', { lineId: line, forget: true }, o.member)).toEqual({ moves: 1, forgot: false });
    expect(await onHand(o, right)).toBe('0');
    expect(await aliases()).toHaveLength(1);
    // Given to A at the factor it was taught at and taken back with "forget": that name is the one that put the line there, so it goes.
    await execute(o, 'finance.marketplace.assign', { lineId: line, itemId: wrong, factor: '2' }, o.member);
    expect(await execute(o, 'finance.marketplace.unassign', { lineId: line, forget: true }, o.member)).toEqual({ moves: 1, forgot: true });
    expect(await aliases()).toHaveLength(0);
  });

  it('takes back a line that came back too: both of its moves are reversed and a new item takes its shipment and its return', async () => {
    const o = await org();
    const wrong = await makeItem(o, 'QC-A');
    const right = await makeItem(o, 'QC-B');
    await confirm(o, (await read(o, report(row('Y1', 'Đang giao', 'MA-LA', 2)))).fileId);
    const [open] = await query<Array<{ lineId: string }>>(o, 'finance.marketplace.unassigned', {}, o.member);
    const line = open?.lineId as string;
    await execute(o, 'finance.marketplace.assign', { lineId: line, itemId: wrong }, o.member);
    expect(await confirm(o, (await read(o, report(row('Y1', 'Đã hoàn trả', 'MA-LA', 2)))).fileId)).toMatchObject({ updatedLines: 1, stockMoves: 1 });
    expect(await onHand(o, wrong)).toBe('0');
    // The shipment, its return and their two reversals stay in the book of the wrong item, which ends where it began.
    expect(await execute(o, 'finance.marketplace.unassign', { lineId: line }, o.member)).toEqual({ moves: 2, forgot: false });
    expect(await onHand(o, wrong)).toBe('0');
    expect((await rows<{ n: number }>('SELECT count(*)::int AS n FROM crove_finance.stock_move WHERE org_id = $1 AND item_id = $2', [o.orgId, wrong]))[0]?.n).toBe(4);
    // The line is a returned one: the new item takes its shipment and its return together, and the stock is as it should be.
    expect(await execute(o, 'finance.marketplace.assign', { lineId: line, itemId: right }, o.member)).toEqual({ moves: 2 });
    expect((await moves(o, right)).map((m) => m.order_move).sort()).toEqual(['return', 'ship']);
    expect(await onHand(o, right)).toBe('0');
  });

  it('does not put a line taken back on the same item by the next report, and forgets only the name that put it there', async () => {
    const o = await org();
    const a = await makeItem(o, 'QC-A');
    const b = await makeItem(o, 'QC-B');
    await confirm(o, (await read(o, report(row('W1', 'Đang giao', 'MA-LA', 3)))).fileId);
    const [open] = await query<Array<{ lineId: string }>>(o, 'finance.marketplace.unassigned', {}, o.member);
    const line = open?.lineId as string;
    // Assigned to A and remembered; taken back without forgetting. Reports overlap: the next one names the same order, and the remembered name must not move the line again.
    await execute(o, 'finance.marketplace.assign', { lineId: line, itemId: a, factor: '2', teach: true }, o.member);
    await execute(o, 'finance.marketplace.unassign', { lineId: line }, o.member);
    expect(await confirm(o, (await read(o, report(row('W1', 'Đang giao', 'MA-LA', 3), row('W2', 'Đang giao', 'MA-LA', 1)))).fileId)).toMatchObject({ newLines: 1, duplicateLines: 1, stockMoves: 1 });
    // W2 is new and takes the remembered name (attempt 1); W1 waits for a person.
    expect(await onHand(o, a)).toBe('-2');
    expect((await query<Array<{ lineId: string }>>(o, 'finance.marketplace.unassigned', {}, o.member)).map((l) => l.lineId)).toEqual([line]);
    // Assigned to B by hand without teaching: the remembered name belongs to A, so forgetting it with this unassign is not done.
    await execute(o, 'finance.marketplace.assign', { lineId: line, itemId: b, factor: '1' }, o.member);
    expect(await execute(o, 'finance.marketplace.unassign', { lineId: line, forget: true }, o.member)).toEqual({ moves: 1, forgot: false });
    expect(await rows("SELECT 1 FROM crove_finance.stock_alias WHERE org_id = $1 AND source = 'shopee'", [o.orgId])).toHaveLength(1);
  });

  it('forgets the name that put a line on its item even when the factor does not divide back from the rounded quantity', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-A');
    await confirm(o, (await read(o, report(row('R1', 'Đang giao', 'MA-LA', 0.5)))).fileId);
    const [open] = await query<Array<{ lineId: string }>>(o, 'finance.marketplace.unassigned', {}, o.member);
    // A third of a unit per unit of the report: half a unit goes out as 0.166667 (rounded), which divided by 0.5 is not 0.333333.
    await execute(o, 'finance.marketplace.assign', { lineId: open?.lineId, itemId: item, factor: '0.333333', teach: true }, o.member);
    expect(await onHand(o, item)).toBe('-0.166667');
    expect(await execute(o, 'finance.marketplace.unassign', { lineId: open?.lineId, forget: true }, o.member)).toEqual({ moves: 1, forgot: true });
    expect(await rows("SELECT 1 FROM crove_finance.stock_alias WHERE org_id = $1 AND source = 'shopee'", [o.orgId])).toHaveLength(0);
  });

  it('has nothing to take back from a line cancelled after it shipped, whose stock came back by itself', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-A');
    await confirm(o, (await read(o, report(row('V1', 'Đang giao', 'QC-A', 2)))).fileId);
    await confirm(o, (await read(o, report(row('V1', 'Đã hủy', 'QC-A', 2)))).fileId);
    expect(await onHand(o, item)).toBe('0');
    const [v1] = await rows<{ id: string }>("SELECT l.id FROM crove_finance.channel_order_line l JOIN crove_finance.channel_order o ON o.org_id = l.org_id AND o.id = l.order_id WHERE l.org_id = $1 AND o.order_no = 'V1'", [o.orgId]);
    await expect(execute(o, 'finance.marketplace.unassign', { lineId: v1?.id }, o.member)).rejects.toMatchObject({ code: 'MARKETPLACE_LINE_CANCELLED' });
  });

  it('holds the attempt of a line in the table: no reversal of live stock by itself, no jump of the attempt, no raise without the reversals, no move at a stale attempt', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-A');
    await confirm(o, (await read(o, report(row('Z1', 'Đang giao', 'MA-LA', 3), row('Z2', 'Đang giao', 'MA-KHAC', 1)))).fileId);
    const lineOf = async (order: string) => (await rows<{ id: string }>('SELECT l.id FROM crove_finance.channel_order_line l JOIN crove_finance.channel_order o ON o.org_id = l.org_id AND o.id = l.order_id WHERE l.org_id = $1 AND o.order_no = $2', [o.orgId, order]))[0]?.id as string;
    const assigned = await lineOf('Z1');
    const waiting = await lineOf('Z2');
    await execute(o, 'finance.marketplace.assign', { lineId: assigned, itemId: item }, o.member);
    const [ship] = await rows<{ id: string }>("SELECT id FROM crove_finance.stock_move WHERE org_id = $1 AND order_line_id = $2 AND order_move = 'ship'", [o.orgId, assigned]);
    // A reversal of the live shipment, by the app and by the table.
    await expect(execute(o, 'finance.stock_move.reverse', { moveId: ship?.id }, o.member)).rejects.toMatchObject({ code: 'STOCK_MOVE_ORDER_LINE' });
    await expect(rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, reverses_move_id) VALUES ($1, $2, '2026-11-01', 3, 'reversal', $3)", [o.orgId, item, ship?.id])).rejects.toThrow(/STOCK_ORDER_REVERSAL/);
    // The attempt goes up by one, and only while the live attempt has a shipment.
    await expect(rows('UPDATE crove_finance.channel_order_line SET attempt = 2 WHERE org_id = $1 AND id = $2', [o.orgId, waiting])).rejects.toThrow(/CHANNEL_ORDER_ATTEMPT/);
    await expect(rows('UPDATE crove_finance.channel_order_line SET attempt = 3 WHERE org_id = $1 AND id = $2', [o.orgId, assigned])).rejects.toThrow(/CHANNEL_ORDER_ATTEMPT/);
    // Raised alone, without the reversals of the attempt it leaves, it does not commit.
    await expect(rows('UPDATE crove_finance.channel_order_line SET attempt = 2 WHERE org_id = $1 AND id = $2', [o.orgId, assigned])).rejects.toThrow(/CHANNEL_ORDER_ATTEMPT/);
    expect((await rows<{ attempt: number }>('SELECT attempt FROM crove_finance.channel_order_line WHERE org_id = $1 AND id = $2', [o.orgId, assigned]))[0]?.attempt).toBe(1);
    // A move at an attempt the line is not at, and a second shipment at the live one.
    await expect(rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, order_line_id, order_move, order_attempt) VALUES ($1, $2, '2026-11-01', -1, 'order_line', $3, 'ship', 2)", [o.orgId, item, waiting])).rejects.toThrow(/STOCK_ORDER_ATTEMPT/);
    await expect(rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, order_line_id, order_move, order_attempt) VALUES ($1, $2, '2026-11-01', -3, 'order_line', $3, 'ship', 1)", [o.orgId, item, assigned])).rejects.toThrow(/stock_move_order_attempt_uq/);
    // Only a move of an order line carries an attempt above 1.
    await expect(rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, order_attempt) VALUES ($1, $2, '2026-11-01', 1, 'manual', 2)", [o.orgId, item])).rejects.toThrow(/stock_move_source_ck/);
  });

  it('reads the attempt of a line with its row held: a return at the attempt an uncommitted raise is leaving waits, then fails, and no stock is left over', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-RACE');
    await confirm(o, (await read(o, report(row('R1', 'Đang giao', 'MA-RACE', 3)))).fileId);
    const [line] = await rows<{ id: string }>('SELECT id FROM crove_finance.channel_order_line WHERE org_id = $1', [o.orgId]);
    await execute(o, 'finance.marketplace.assign', { lineId: line?.id, itemId: item }, o.member);
    const [ship] = await rows<{ id: string; back: string }>("SELECT id, (-quantity)::text AS back FROM crove_finance.stock_move WHERE org_id = $1 AND order_line_id = $2 AND order_move = 'ship'", [o.orgId, line?.id]);
    // The line came back and its return is not stored yet.
    await rows("UPDATE crove_finance.channel_order_line SET stage = 'returned' WHERE org_id = $1 AND id = $2", [o.orgId, line?.id]);
    const connect = async () => {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      return c;
    };
    const t1 = await connect();
    const t2 = await connect();
    try {
      // T1 raises the attempt and reverses the shipment, and does not commit yet.
      await t1.query('BEGIN');
      await t1.query('UPDATE crove_finance.channel_order_line SET attempt = 2 WHERE org_id = $1 AND id = $2', [o.orgId, line?.id]);
      await t1.query("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, reverses_move_id) VALUES ($1, $2, '2026-11-01', $3, 'reversal', $4)", [o.orgId, item, ship?.back, ship?.id]);
      // T2 stores the return at the old attempt: it must wait for T1.
      await t2.query('BEGIN');
      const pid = (await t2.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      const late = t2
        .query("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, order_line_id, order_move, order_attempt) VALUES ($1, $2, '2026-11-02', $3, 'order_line', $4, 'return', 1)", [o.orgId, item, ship?.back, line?.id])
        .then(() => null, (e: Error) => e);
      let waiting = false;
      for (let i = 0; i < 50 && !waiting; i++) {
        waiting = (await rows<{ n: string }>("SELECT count(*)::text AS n FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'", [pid]))[0]?.n === '1';
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(waiting).toBe(true);
      await t1.query('COMMIT');
      expect((await late)?.message).toMatch(/STOCK_ORDER_ATTEMPT/);
      await t2.query('ROLLBACK');
    } finally {
      await t1.end();
      await t2.end();
    }
    // The shipment and its reversal cancel out: no return of the attempt that was left.
    expect((await rows<{ zero: boolean }>('SELECT COALESCE(sum(quantity), 0) = 0 AS zero FROM crove_finance.stock_move WHERE org_id = $1 AND item_id = $2', [o.orgId, item]))[0]?.zero).toBe(true);
    expect((await rows<{ n: string }>("SELECT count(*)::text AS n FROM crove_finance.stock_move WHERE org_id = $1 AND order_line_id = $2 AND order_move = 'return'", [o.orgId, line?.id]))[0]?.n).toBe('0');
  });

  it('lists the confirmed orders for every role, and the shipped lines that name no item, and assigns one: the shipment, the return, the SKU taught for the platform', async () => {
    const o = await org();
    const item = await makeItem(o, 'QC-1');
    const first = await read(o, report(row('U1', 'Đang giao', 'LẠ-7', 3), row('U2', 'Hoàn thành', 'QC-1', 1), row('U3', 'Chờ xác nhận', 'LẠ-8', 1)));
    await confirm(o, first.fileId);
    // The orders: every role reads them, newest first, with the item a shipped line moved and no buyer value.
    const orders = await query<Array<{ orderNo: string; platform: string; stage: string; lines: Array<{ id: string; sku: string | null; itemCode: string | null; stage: string }> }>>(o, 'finance.marketplace.orders', {}, o.viewer);
    expect(orders.map((r) => [r.orderNo, r.stage]).sort()).toEqual([
      ['U1', 'shipped'],
      ['U2', 'completed'],
      ['U3', 'placed'],
    ]);
    expect(orders.find((r) => r.orderNo === 'U2')?.lines[0]).toMatchObject({ sku: 'QC-1', itemCode: 'QC-1' });
    for (const value of Object.values(BUYER)) expect(JSON.stringify(orders)).not.toContain(value);
    expect((await query<unknown[]>(o, 'finance.marketplace.orders', { stage: 'placed' }, o.viewer)).length).toBe(1);
    expect((await query<unknown[]>(o, 'finance.marketplace.orders', { platform: 'lazada' }, o.viewer)).length).toBe(0);
    // The shipped line that names no item waits; the placed one is not listed (it moves nothing yet).
    const open = await query<Array<{ lineId: string; sku: string | null; stage: string; quantity: string }>>(o, 'finance.marketplace.unassigned', {}, o.viewer);
    expect(open.map((l) => [l.sku, l.stage, l.quantity])).toEqual([['LẠ-7', 'shipped', '3']]);
    const line = open[0]?.lineId as string;
    await expect(execute(o, 'finance.marketplace.assign', { lineId: line, itemId: item, factor: '2' }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // A line that has not shipped has nothing to move.
    const placed = orders.find((r) => r.orderNo === 'U3')?.lines[0]?.id as string;
    await expect(execute(o, 'finance.marketplace.assign', { lineId: placed, itemId: item }, o.member)).rejects.toMatchObject({ code: 'MARKETPLACE_LINE_NOT_SHIPPED' });
    // Assigned at a factor of two bottles to the unit: three units are six, taken out once, and the SKU is taught for the platform.
    // The SKU is taught only when asked (a wrong one cannot be undone yet, #2633): this one is, so the next report with it moves by itself.
    expect(await execute(o, 'finance.marketplace.assign', { lineId: line, itemId: item, factor: '2', teach: true }, o.member)).toEqual({ moves: 1 });
    expect(await onHand(o, item)).toBe('-7');
    expect(await query(o, 'finance.marketplace.unassigned', {}, o.member)).toEqual([]);
    await expect(execute(o, 'finance.marketplace.assign', { lineId: line, itemId: item }, o.member)).rejects.toMatchObject({ code: 'MARKETPLACE_LINE_ASSIGNED' });
    // Next time the same SKU moves by itself, at the same factor.
    const second = await read(o, report(row('U4', 'Đang giao', 'LẠ-7', 1)));
    expect(await confirm(o, second.fileId)).toMatchObject({ newLines: 1, stockMoves: 1 });
    expect(await onHand(o, item)).toBe('-9');
    // A return of the assigned line brings back what the shipment took, through the same item.
    expect(await confirm(o, (await read(o, report(row('U1', 'Đã hoàn trả', 'LẠ-7', 3)))).fileId)).toMatchObject({ updatedLines: 1, stockMoves: 1 });
    expect(await onHand(o, item)).toBe('-3');
  });

  it('applies the factor of a name taught for the platform, and reads a SKU as an item code without case', async () => {
    const o = await org();
    const item = await makeItem(o, 'Nuoc-Chai', { unit: 'chai' });
    await execute(o, 'finance.stock_alias.teach', { itemId: item, source: 'shopee', key: 'NUOC-THUNG', factor: '12' });
    const read1 = await read(o, report(row('F1', 'Đang giao', 'nuoc-chai', 3), row('F2', 'Đang giao', 'NUOC-THUNG', 2)));
    expect(await confirm(o, read1.fileId)).toMatchObject({ newLines: 2, stockMoves: 2 });
    // Three bottles by the code and two cartons of twelve by the taught name.
    expect(await onHand(o, item)).toBe('-27');
  });

  it('stores nothing when a member skips the report, and nothing for a file that is no report or has rows it cannot read', async () => {
    const o = await org();
    const skipped = await read(o, report(row('S1', 'Đang giao', 'QC-1', 1)));
    await execute(o, 'finance.marketplace.reject', { fileId: skipped.fileId }, o.member);
    expect(await orderRows(o)).toEqual([]);
    await expect(confirm(o, skipped.fileId)).rejects.toMatchObject({ code: 'MARKETPLACE_NOT_STAGED' });
    // A generic sheet is not handled: the worker goes on to the other readers, and no run is recorded here.
    const none = await read(o, buildXlsx([['nothing', 'here'], ['a', 'b']]));
    expect(none.handled).toBe(false);
    expect(await rows('SELECT 1 FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2', [o.orgId, none.fileId])).toEqual([]);
    // A row with a quantity that is not one stops the file: a failed read that names the row, and nothing staged.
    const bad = await read(o, report(row('B1', 'Đang giao', 'QC-1', 1), row('B2', 'Đang giao', 'QC-1', 0)));
    expect(bad.handled).toBe(true);
    const failed = (await rows<{ status: string; error: string }>('SELECT status, error FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2 ORDER BY version DESC LIMIT 1', [o.orgId, bad.fileId]))[0];
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('dòng 4') });
    expect(await orderRows(o)).toEqual([]);
  });

  it('keeps one entity\'s orders apart from another\'s and holds no buyer value in any stored row', async () => {
    const o = await org();
    const only = await read(o, report(row('E1', 'Đang giao', 'QC-1', 1)));
    expect(only.handled).toBe(true);
    await confirm(o, only.fileId);
    const stored = await rows<{ t: string }>(
      `SELECT (SELECT coalesce(jsonb_agg(to_jsonb(l)), '[]'::jsonb) FROM crove_finance.channel_order_line l WHERE l.org_id = $1)::text || (SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) FROM crove_finance.channel_order c WHERE c.org_id = $1)::text AS t`,
      [o.orgId],
    );
    for (const value of Object.values(BUYER)) expect(stored[0]?.t).not.toContain(value);
    // The audit rows and the activity of the file carry no buyer value either.
    const audit = await rows<{ detail: unknown }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.marketplace.confirm'`, [o.orgId]);
    for (const value of Object.values(BUYER)) expect(JSON.stringify(audit)).not.toContain(value);
    // Another org sees none of it.
    const other = await org();
    expect(await orderRows(other)).toEqual([]);
    expect(await query(other, 'finance.marketplace.staged', {}, other.member)).toEqual([]);
  });
});

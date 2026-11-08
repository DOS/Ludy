// SPDX-License-Identifier: AGPL-3.0-only
// Marketplace income reports as files (#2516, ADR-0045 points 5 and 7), on a real PostgreSQL 17 and the real parsing sandbox: a Shopee income workbook (the per-order table on its second sheet)
// is read and STAGED with nothing stored, a member confirms it and ONE settlement with its lines is stored (append-only, no buyer data anywhere, nothing of the file in the audit facts), and
// each check that blocks confirming it is a clear refusal that stores nothing: a line with no payment date, lines that do not add up to the net the file states, an order the org does not
// know, a period another settlement already covers, a sale line already stored. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import type { ExtractClient } from '@crove/extract-contract';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime, fileKey, sha256Hex, type BlobStore } from '@crove/kernel-runtime';
import { financeCommands, financeQueries, readMarketplaceFile, readMarketplaceIncomeFile } from '@crove/mod-finance';
import { buildXlsx, type XlsxCell } from '../../extract/test/xlsx-fixture.ts';
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
  async delete(key: string) {
    this.blobs.delete(key);
  }
}

interface Preview {
  reportNet: string;
  fileStatesNet: boolean;
  linesNet: string;
  unknownOrders: number;
  unknownOrderNos: string[];
  overlap: { periodStart: string; periodEnd: string } | null;
  repeatedLines: number;
  blockers: string[];
}

suite('marketplace income reports (#2516)', () => {
  const dbName = `crove_test_income_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const preview = (o: Org, fileId: string, user = o.member) => query<Preview>(o, 'finance.marketplace_income.preview', { fileId }, user);
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

  it('stages a workbook whose table is on the second sheet and stores nothing, with no buyer value in the read', async () => {
    const o = await org();
    const { fileId, handled } = await read(o, workbook(lines(o.a, o.b)));
    expect(handled).toBe(true);
    expect(await settlements(o)).toEqual([]);
    expect(await settlementLines(o)).toEqual([]);
    const staged = await query<Array<{ fileId: string; summary: Record<string, unknown> }>>(o, 'finance.marketplace_income.staged', {});
    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatchObject({
      fileId,
      summary: {
        state: 'staged',
        platform: 'shopee',
        profileConfirmed: false,
        sheet: 'Income',
        orders: 2,
        lines: 2,
        periodStart: '2026-11-03',
        periodEnd: '2026-11-04',
        statedNet: '125750',
        totals: { sales: '150000', net: '125750', other: '0' },
      },
    });
    expect(await preview(o, fileId)).toMatchObject({ reportNet: '125750', fileStatesNet: true, linesNet: '125750', unknownOrders: 0, overlap: null, repeatedLines: 0, blockers: [] });
    // Everything kept with the read is free of the buyer's values and of their columns' headers.
    const kept = JSON.stringify(await rows('SELECT result FROM crove_kernel.extraction WHERE org_id = $1', [o.orgId]));
    for (const value of Object.values(BUYER)) expect(kept).not.toContain(value);
    for (const header of ['Người Mua', 'Số điện thoại']) expect(kept).not.toContain(header);
  });

  it('confirms into one settlement with its lines, the file decided once, and nothing of the file in the audit facts', async () => {
    const o = await org();
    const { fileId } = await read(o, workbook(lines(o.a, o.b)));
    const result = await confirm(o, fileId);
    expect(result).toMatchObject({ lines: 2, reportNet: '125750', other: '0' });
    const stored = await settlements(o);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ platform: 'shopee', period_start: '2026-11-03', period_end: '2026-11-04', report_net: '125750.0000', source_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const keys = await settlementLines(o);
    expect(keys.map((l) => [l.line_key, l.sales, l.commission, l.tax_withheld, l.other, l.net, l.source_row])).toEqual(
      [
        [o.a, '100000.0000', '5000.0000', '1000.0000', '0.0000', '80500.0000', 3],
        [o.b, '50000.0000', '2500.0000', '500.0000', '0.0000', '45250.0000', 4],
      ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
    // The file is decided once: the card no longer lists it and a second decision is refused.
    expect(await query<unknown[]>(o, 'finance.marketplace_income.staged', {})).toEqual([]);
    await expect(confirm(o, fileId)).rejects.toMatchObject({ code: 'MARKETPLACE_INCOME_NOT_STAGED' });
    await expect(execute(o, 'finance.marketplace_income.reject', { fileId }, o.member)).rejects.toMatchObject({ code: 'MARKETPLACE_INCOME_NOT_STAGED' });
    // The audit names the platform and counts, never an order number or an amount of the file.
    const audit = JSON.stringify(await rows("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.marketplace_income.confirm' AND outcome = 'ok'", [o.orgId]));
    expect(audit).toContain('shopee');
    for (const secret of [o.a, o.b, '80500', '125750', BUYER.name]) expect(audit).not.toContain(secret);
    // No stored row of the settlement tables holds a buyer value.
    const everything = JSON.stringify(await rows('SELECT s.*, l.* FROM crove_finance.channel_settlement s JOIN crove_finance.channel_settlement_line l ON l.settlement_id = s.id WHERE s.org_id = $1', [o.orgId]));
    for (const value of Object.values(BUYER)) expect(everything).not.toContain(value);
  });

  it('refuses a report whose lines do not add up to the net the file states, and with no total confirms on the sum and says so', async () => {
    const o = await org();
    const mismatch = await read(o, workbook(lines(o.a, o.b), 125000));
    expect((await preview(o, mismatch.fileId)).blockers).toEqual(['TOTAL_MISMATCH']);
    await expect(confirm(o, mismatch.fileId)).rejects.toMatchObject({ code: 'MARKETPLACE_INCOME_TOTAL_MISMATCH', status: 422 });
    expect(await settlements(o)).toEqual([]);
    const o2 = await org();
    const none = await read(o2, workbook(lines(o2.a, o2.b), null));
    expect(await preview(o2, none.fileId)).toMatchObject({ fileStatesNet: false, reportNet: '125750', blockers: [] });
    expect((await confirm(o2, none.fileId)).reportNet).toBe('125750');
  });

  it('refuses a report that names an order the org does not know, naming it, and stores nothing', async () => {
    const o = await org(false);
    await addOrders(o, o.a);
    const { fileId } = await read(o, workbook(lines(o.a, o.b)));
    expect(await preview(o, fileId)).toMatchObject({ unknownOrders: 1, unknownOrderNos: [o.b], blockers: ['UNKNOWN_ORDERS'] });
    await expect(confirm(o, fileId)).rejects.toMatchObject({ code: 'MARKETPLACE_INCOME_UNKNOWN_ORDERS', status: 422, message: expect.stringContaining(o.b) });
    expect(await settlements(o)).toEqual([]);
    // Once the order report has stored the order, the same staged read confirms.
    await addOrders(o, o.b);
    expect((await preview(o, fileId)).blockers).toEqual([]);
    await expect(confirm(o, fileId)).resolves.toMatchObject({ lines: 2 });
  });

  it('refuses a report with a line that has no payment date: the period is unknown', async () => {
    const o = await org();
    const { fileId } = await read(o, workbook([row(o.a, '2026-11-03', 100000, 10000, 5000, 2000, 1500, 500, 500, 80500), row(o.b, null, 50000, 0, 2500, 1000, 750, 250, 250, 45250)]));
    expect((await preview(o, fileId)).blockers).toEqual(['PERIOD_UNKNOWN']);
    await expect(confirm(o, fileId)).rejects.toMatchObject({ code: 'MARKETPLACE_INCOME_PERIOD_UNKNOWN', status: 422 });
    expect(await settlements(o)).toEqual([]);
  });

  it('refuses a period another settlement covers, and a sale line already stored, with clear messages; a rejected report stores nothing', async () => {
    const o = await org();
    const first = await read(o, workbook(lines(o.a, o.b)));
    await confirm(o, first.fileId);
    // The same period again, as a second file (another name for the same order lines makes no difference to the period).
    const again = await read(o, workbook(lines(o.a, o.b), 125750, 'bản tải lần hai'));
    const overlap = await preview(o, again.fileId);
    expect(overlap.overlap).toEqual({ periodStart: '2026-11-03', periodEnd: '2026-11-04' });
    expect(overlap.blockers).toEqual(expect.arrayContaining(['OVERLAP', 'REPEATED_LINES']));
    await expect(confirm(o, again.fileId)).rejects.toMatchObject({ code: 'MARKETPLACE_INCOME_OVERLAP', status: 409, message: expect.stringContaining('03/11/2026') });
    // A later period naming the same sale lines: the sale is already stored.
    const later = await read(o, workbook(lines(o.a, o.b, ['2026-12-03', '2026-12-04'])));
    expect((await preview(o, later.fileId)).blockers).toEqual(['REPEATED_LINES']);
    await expect(confirm(o, later.fileId)).rejects.toMatchObject({ code: 'MARKETPLACE_INCOME_REPEATED_LINES', status: 409 });
    expect(await settlements(o)).toHaveLength(1);
    // Rejecting a staged report stores nothing and ends it.
    await execute(o, 'finance.marketplace_income.reject', { fileId: later.fileId }, o.member);
    expect(await query<unknown[]>(o, 'finance.marketplace_income.staged', {})).toHaveLength(1);
    expect(await settlements(o)).toHaveLength(1);
    await expect(confirm(o, later.fileId)).rejects.toMatchObject({ code: 'MARKETPLACE_INCOME_NOT_STAGED' });
  });

  it('is read and decided by owners, admins and members only; a viewer sees and decides nothing', async () => {
    const o = await org();
    const { fileId } = await read(o, workbook(lines(o.a, o.b)));
    await expect(query(o, 'finance.marketplace_income.staged', {}, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(preview(o, fileId, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(confirm(o, fileId, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(execute(o, 'finance.marketplace_income.reject', { fileId }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await settlements(o)).toEqual([]);
    // Another org never sees the report.
    const other = await org();
    expect(await query<unknown[]>(other, 'finance.marketplace_income.staged', {})).toEqual([]);
    await expect(preview(other, fileId)).rejects.toMatchObject({ code: 'MARKETPLACE_INCOME_NOT_STAGED' });
  });

  it('does not take what is no income report, and fails a report with rows it cannot read, storing nothing', async () => {
    const o = await org();
    // An order report (a quantity, no released amount) and a plain workbook are none: the file goes on to the next reader.
    const orderReport = buildXlsx([['Mã đơn hàng', 'Ngày đặt hàng', 'Trạng Thái Đơn Hàng', 'SKU phân loại hàng', 'Số lượng'], [o.a, '2026-10-30', 'Hoàn thành', 'QC-1', 2]]);
    expect((await read(o, orderReport)).handled).toBe(false);
    expect((await read(o, buildXlsx([['nothing here']]))).handled).toBe(false);
    // And the order report's own reader does not take an income report.
    const income = workbook(lines(o.a, o.b));
    const asOrders = await readMarketplaceFile({ runtime: worker, store, extract }, o.orgId, await ingest(o, income));
    expect(asOrders.handled).toBe(false);
    // A row with an amount that reads as no number stops the file, naming the row.
    const broken = await read(o, workbook([row(o.a, '2026-11-03', 100000, 10000, 5000, 2000, 1500, 500, 500, 80500), ['2611X1', '', '', '', '2026-11-04', 'không phải số', '', '', '', '', '', '', 100]]));
    expect(broken.handled).toBe(true);
    const failed = await rows<{ status: string; error: string | null }>('SELECT status, error FROM crove_kernel.extraction WHERE org_id = $1 AND file_id = $2', [o.orgId, broken.fileId]);
    expect(failed[0]?.status).toBe('failed');
    expect(failed[0]?.error).toContain('không đọc được');
    expect(await query<unknown[]>(o, 'finance.marketplace_income.staged', {})).toEqual([]);
    expect(await settlements(o)).toEqual([]);
  });
});

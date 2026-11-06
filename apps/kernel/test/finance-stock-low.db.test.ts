// SPDX-License-Identifier: AGPL-3.0-only
// The reads behind the finance coworker on stock (#2514), on a real PostgreSQL 17: which items will not last the lead days at the pace of the last eight weeks (and from whom they were last
// bought), what the model may see of the unassigned goods lines a person asks about, the facts of a reorder message, and Home's "Hàng sắp hết" item. Nothing here writes.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Low {
  itemId: string;
  code: string;
  onHand: string;
  dailyOut: string;
  coverDays: number;
  suggestedQuantity: string;
  supplier: { partyId: string; name: string; email: string | null } | null;
}
interface TodayItem {
  id: string;
  kind: string;
  count?: number;
  href: string;
  title: { key: string; params: Record<string, unknown> };
}

suite('the finance coworker on stock: low items, the lines and the reorder facts (#2514)', () => {
  const dbName = `crove_test_stocklow_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows);
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@low.test`, name: null });
  type Org = { orgId: string; owner: string; member: string; viewer: string; entity: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Kho ${randomUUID().slice(0, 6)}`);
    const [member, viewer] = await Promise.all([identity('member'), identity('viewer')]);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgId, member, viewer]));
    const [entity] = await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]);
    return { orgId, owner, member, viewer, entity: entity?.id ?? '' };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const makeItem = (o: Org, code: string, extra: Record<string, unknown> = {}) =>
    execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code, name: `Hàng ${code}`, unit: 'cái', stockAccount: '156', trade: 'goods', ...extra }).then((r) => r.id);
  const party = (o: Org, name: string, email: string | null = null) =>
    rows<{ id: string }>('INSERT INTO crove_kernel.party (org_id, name, email) VALUES ($1, $2, $3) RETURNING id', [o.orgId, name, email]).then((r) => r[0]?.id as string);
  let serial = 0;
  // A posted document with one goods line and, unless `moved` is false, its move (signed: a sale is negative), dated `daysAgo` days before today.
  async function line(o: Org, item: string | null, partyId: string, direction: 'purchase' | 'sale', daysAgo: number, quantity: string, options: { moved?: boolean; description?: string; unit?: string } = {}) {
    serial += 1;
    // The books insist that a document is posted with its entry, which these reads do not look at: the rows are written by the database owner with triggers off.
    return admin(async (c) => {
      await c.query('SET session_replication_role = replica');
      const doc = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_finance.purchase_document (org_id, legal_entity_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction)
           VALUES ($1, $2, $3, 'AA', $4, current_date - $5::int, 100, 0, 100, $6) RETURNING id`,
          [o.orgId, o.entity, partyId, String(serial).padStart(6, '0'), daysAgo, direction],
        )
      ).rows[0];
      const documentId = doc?.id as string;
      await c.query(
        `INSERT INTO crove_finance.purchase_line (org_id, document_id, line_no, description, unit, quantity, amount, ${direction === 'sale' ? 'credit_account' : 'debit_account'})
         VALUES ($1, $2, 1, $3, $4, $5, 100, $6)`,
        [o.orgId, documentId, options.description ?? 'Hàng hóa', options.unit ?? 'cái', quantity.replace('-', ''), direction === 'sale' ? '5111' : '156'],
      );
      if (options.moved === false || item === null) return { documentId, moveId: null };
      const move = (
        await c.query<{ id: string }>(
          `INSERT INTO crove_finance.stock_move (org_id, legal_entity_id, item_id, move_date, quantity, source_type, document_id, line_no, line_attempt)
           VALUES ($1, $2, $3, current_date - $4::int, $5, 'document_line', $6, 1, 1) RETURNING id`,
          [o.orgId, o.entity, item, daysAgo, quantity, documentId],
        )
      ).rows[0];
      return { documentId, moveId: move?.id as string };
    });
  }
  const low = (o: Org, input: Record<string, unknown> = {}, user = o.owner) => query<Low[]>(o, 'finance.stock.low', input, user);

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // The shared set: A1 (66 bought 60 days ago from a supplier, 56 sold in two sales: 10 left, a day's cover of ten), E1 (58 in, 56 sold: 2 left), B1 (plenty left), C1 (never sold),
  // D1 (sold, but not in use) and F1 (only sold before the last eight weeks).
  async function stocked() {
    const o = await org();
    const supplier = await party(o, 'Nhà cung cấp Phương Nam', 'ncc@phuongnam.example');
    const customer = await party(o, 'Khách lẻ');
    const [a, e, b, c, d, f] = await Promise.all(['A1', 'E1', 'B1', 'C1', 'D1', 'F1'].map((code) => makeItem(o, code)));
    const sales: Record<string, string | null> = {};
    await line(o, a as string, supplier, 'purchase', 60, '66');
    sales.first = (await line(o, a as string, customer, 'sale', 20, '-30')).moveId;
    await line(o, a as string, customer, 'sale', 10, '-26');
    await rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, current_date - 58, 58, 'manual')", [o.orgId, e]);
    await line(o, e as string, customer, 'sale', 15, '-56');
    await line(o, b as string, supplier, 'purchase', 60, '200');
    await line(o, b as string, customer, 'sale', 10, '-56');
    await rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, current_date - 5, 5, 'manual')", [o.orgId, c]);
    await rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, current_date - 30, 80, 'manual')", [o.orgId, d]);
    await line(o, d as string, customer, 'sale', 10, '-56');
    await execute(o, 'finance.stock_item.set_active', { itemId: d, active: false });
    await rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, current_date - 100, 90, 'manual')", [o.orgId, f]);
    await line(o, f as string, customer, 'sale', 80, '-60');
    return { o, supplier, customer, items: { a: a as string, e: e as string, b: b as string, c: c as string, d: d as string, f: f as string }, firstSale: sales.first as string };
  }

  it('lists the items that will not last the lead days at the pace of the last eight weeks, shortest cover first, with their supplier and a quantity for two lead times', async () => {
    const { o, supplier, items } = await stocked();
    const found = await low(o);
    // A1 sold 56 in 56 days (a day): 10 left is ten days of cover, short of the 14. Two lead times is 28 units, less the 10 on hand. E1 has two left; the rest are fine, unsold, out of use or sold only earlier.
    expect(found.map((i) => i.code)).toEqual(['E1', 'A1']);
    expect(found[1]).toMatchObject({ itemId: items.a, onHand: '10', dailyOut: '1', coverDays: 10, suggestedQuantity: '18' });
    expect(found[0]).toMatchObject({ itemId: items.e, onHand: '2', dailyOut: '1', coverDays: 2, suggestedQuantity: '26' });
    // A1 was bought through a posted purchase, from the supplier; E1 came in by a manual entry, so it has none.
    expect(found[1]?.supplier).toEqual({ partyId: supplier, name: 'Nhà cung cấp Phương Nam', email: 'ncc@phuongnam.example' });
    expect(found[0]?.supplier).toBeNull();
    // A shorter lead time drops the items whose cover is longer than it; the limit keeps the shortest covers.
    expect((await low(o, { leadDays: 5 })).map((i) => i.code)).toEqual(['E1']);
    expect((await low(o, { limit: 1 })).map((i) => i.code)).toEqual(['E1']);
  });

  it('leaves a reversed sale out of the pace, on the date of the sale it undoes', async () => {
    const { o, items, firstSale } = await stocked();
    expect((await low(o)).map((i) => i.code)).toContain('A1');
    await execute(o, 'finance.stock_move.reverse', { moveId: firstSale });
    // 30 of the 56 came back: 26 sold in the window is under half a unit a day, and 40 on hand lasts well past the 14 days.
    expect((await low(o)).map((i) => i.itemId)).not.toContain(items.a);
  });

  it('is read by every role, and by one entity only when asked', async () => {
    const { o } = await stocked();
    expect((await low(o, {}, o.viewer)).length).toBe(2);
    expect((await low(o, { legalEntityId: o.entity }, o.member)).length).toBe(2);
    expect(await low(o, { legalEntityId: randomUUID() })).toEqual([]);
  });

  it('gives Home one flag per entity with how many items are low, to the people who can act and not to a viewer', async () => {
    const { o } = await stocked();
    const flags = async (user: string) => (await query<TodayItem[]>(o, 'finance.today', {}, user)).filter((i) => i.title.key === 'financeStockLow');
    expect(await flags(o.owner)).toEqual([expect.objectContaining({ kind: 'flag', count: 2, href: '/stock', title: { key: 'financeStockLow', params: { count: 2 } } })]);
    expect(await flags(o.member)).toHaveLength(1);
    expect(await flags(o.viewer)).toEqual([]);
    const quiet = await org();
    expect(await query<TodayItem[]>(quiet, 'finance.today', {}).then((all) => all.filter((i) => i.title.key === 'financeStockLow'))).toEqual([]);
  });

  describe('finance.stock.suggest_source', () => {
    it('gives the unassigned lines that were asked about and the active items of their entity, and nothing of the books besides', async () => {
      const o = await org();
      const customer = await party(o, 'Người bán');
      const shirt = await makeItem(o, 'AO02', { name: 'Áo thun cổ tròn đen L' });
      const gone = await makeItem(o, 'CU01', { name: 'Hàng cũ' });
      await execute(o, 'finance.stock_item.set_active', { itemId: gone, active: false });
      const wanted = await line(o, null, customer, 'purchase', 3, '3', { moved: false, description: 'Ao thun co tron den L', unit: 'cai' });
      const other = await line(o, null, customer, 'purchase', 3, '2', { moved: false, description: 'Một dòng khác' });
      const blank = await line(o, null, customer, 'purchase', 3, '1', { moved: false, description: '   ' });
      const source = await query<{ lines: Array<Record<string, unknown>>; items: Array<Record<string, unknown>> }>(o, 'finance.stock.suggest_source', {
        legalEntityId: o.entity,
        lines: [{ documentId: wanted.documentId, lineNo: 1 }, { documentId: blank.documentId, lineNo: 1 }, { documentId: randomUUID(), lineNo: 1 }],
      }, o.member);
      // Only the readable line that was asked about, with its text and unit; the other line of the entity, the blank one and the one that does not exist are left out.
      expect(source.lines).toEqual([{ documentId: wanted.documentId, lineNo: 1, description: 'Ao thun co tron den L', unit: 'cai' }]);
      expect(source.items).toEqual([{ id: shirt, code: 'AO02', name: 'Áo thun cổ tròn đen L', unit: 'cái' }]);
      expect(other.documentId).not.toBe(wanted.documentId);
    });

    it('leaves a line that has an item already, offers at most 60 items with those that share words first, and is for people who can write', async () => {
      const o = await org();
      const customer = await party(o, 'Người bán');
      const item = await makeItem(o, 'ZZ99', { name: 'Áo thun cổ tròn đen L' });
      await rows(
        `INSERT INTO crove_finance.stock_item (org_id, legal_entity_id, code, name, unit, stock_account, trade)
         SELECT $1, $2, 'K' || lpad(g::text, 3, '0'), 'Mặt hàng ' || g, 'cái', '156', 'goods' FROM generate_series(1, 70) AS g`,
        [o.orgId, o.entity],
      );
      const moved = await line(o, item, customer, 'purchase', 3, '4', { description: 'Áo thun đã gán' });
      const open = await line(o, null, customer, 'purchase', 3, '2', { moved: false, description: 'Ao thun co tron den' });
      const source = await query<{ lines: unknown[]; items: Array<{ code: string }> }>(o, 'finance.stock.suggest_source', {
        legalEntityId: o.entity,
        lines: [{ documentId: moved.documentId, lineNo: 1 }, { documentId: open.documentId, lineNo: 1 }],
      });
      expect(source.lines).toHaveLength(1);
      expect(source.items).toHaveLength(60);
      // 71 items, the one whose name shares words with the line comes first although its code sorts last.
      expect(source.items[0]?.code).toBe('ZZ99');
      const asked = { legalEntityId: o.entity, lines: [{ documentId: open.documentId, lineNo: 1 }] };
      await expect(query(o, 'finance.stock.suggest_source', asked, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(query(o, 'finance.stock.suggest_source', { ...asked, legalEntityId: randomUUID() }, o.member)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    });
  });

  describe('finance.stock.reorder_source', () => {
    it('gives the names, units and quantities from the books, the supplier, the business name and the fixed template', async () => {
      const o = await org();
      const supplier = await party(o, 'Nhà cung cấp Phương Nam', 'ncc@phuongnam.example');
      const a = await makeItem(o, 'A1', { name: 'Áo thun trắng M' });
      const b = await makeItem(o, 'B1', { name: 'Nước suối 500ml', unit: 'thùng' });
      const [entityRow] = await rows<{ name: string }>('SELECT name FROM crove_kernel.legal_entity WHERE org_id = $1 AND id = $2', [o.orgId, o.entity]);
      const source = await query<{ orgName: string; supplier: unknown; items: unknown[]; template: string }>(o, 'finance.stock.reorder_source', {
        legalEntityId: o.entity,
        supplierPartyId: supplier,
        items: [{ itemId: a, quantity: '40' }, { itemId: b, quantity: '12.500000' }],
        lang: 'vi',
      }, o.member);
      expect(source.orgName).toBe(entityRow?.name);
      expect(source.supplier).toEqual({ partyId: supplier, name: 'Nhà cung cấp Phương Nam', email: 'ncc@phuongnam.example' });
      expect(source.items).toEqual([
        { itemId: a, name: 'Áo thun trắng M', unit: 'cái', quantity: '40' },
        { itemId: b, name: 'Nước suối 500ml', unit: 'thùng', quantity: '12.5' },
      ]);
      expect(source.template).toBe(`Chào Nhà cung cấp Phương Nam,\n\n${entityRow?.name} muốn đặt thêm các mặt hàng dưới đây. Xin anh chị xác nhận số lượng có thể giao:\n- Áo thun trắng M: 40 cái\n- Nước suối 500ml: 12.5 thùng\n\nXin cảm ơn.\n${entityRow?.name}`);
      // With no supplier named and in English the template greets "Supplier".
      const plain = await query<{ supplier: unknown; template: string }>(o, 'finance.stock.reorder_source', { legalEntityId: o.entity, items: [{ itemId: a, quantity: '1' }], lang: 'en' });
      expect(plain.supplier).toBeNull();
      expect(plain.template).toMatch(/^Hello Supplier,/);
    });

    it('refuses a duplicate item, a quantity that is not above zero, an item of another org, a supplier that is not there, and a viewer', async () => {
      const o = await org();
      const a = await makeItem(o, 'A1');
      const stranger = await org();
      const foreign = await makeItem(stranger, 'A1');
      const ask = (items: unknown, extra: Record<string, unknown> = {}, user = o.owner) => query(o, 'finance.stock.reorder_source', { legalEntityId: o.entity, items, ...extra }, user);
      await expect(ask([{ itemId: a, quantity: '1' }, { itemId: a, quantity: '2' }])).rejects.toMatchObject({ code: 'STOCK_REORDER_DUPLICATE' });
      await expect(ask([{ itemId: a, quantity: '0' }])).rejects.toMatchObject({ code: 'STOCK_REORDER_QUANTITY' });
      await expect(ask([{ itemId: foreign, quantity: '1' }])).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
      await expect(ask([{ itemId: a, quantity: '1' }], { supplierPartyId: randomUUID() })).rejects.toMatchObject({ code: 'PARTY_NOT_FOUND' });
      await expect(ask([{ itemId: a, quantity: '1' }], {}, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });
});

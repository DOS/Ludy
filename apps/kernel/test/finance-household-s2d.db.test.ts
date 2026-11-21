// SPDX-License-Identifier: AGPL-3.0-only
// The S2d-HKD goods book of a household business on the income method (#2517 slice 2d, plan stock-and-marketplaces.md sections 8.3, 8.5 and 12 row 5), on PostgreSQL 17: per item of the household's entity the
// opening, one row per stock move, the totals and the closing, equal to finance.stock.report (an open month) or to what the close stored (a closed month); another entity's items stay out; the label while the
// layout row is `commentary`; and the cases the book refuses. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { HouseholdProfileView, HouseholdS2d } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the S2d-HKD goods book of a household business (#2517 slice 2d)', () => {
  const dbName = `crove_test_household_s2d_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@household.test`, name: null });
  type Org = { orgId: string; owner: string; viewer: string; company: string; household: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Hộ Kinh Doanh ${randomUUID().slice(0, 6)}`);
    const viewer = await identity('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer]));
    const company = (await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))).rows[0]?.id as string;
    const household = randomUUID();
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Hộ kinh doanh Nguyễn Văn A', 'household', $3)", [orgId, household, owner]),
    );
    return { orgId, owner, viewer, company, household };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const setProfile = (o: Org, over: Record<string, unknown> = {}) =>
    execute<HouseholdProfileView>(o, 'finance.household.profile_set', {
      legalEntityId: o.household,
      effectiveFrom: '2026-01-01',
      taxGroup: 3,
      pitMethod: 'income',
      trades: ['goods'],
      einvoiceRegistered: false,
      representativeName: 'Nguyễn Văn A',
      ...over,
    });
  const s2d = (o: Org, month: string, entity = o.household, user = o.owner) => query<HouseholdS2d>(o, 'finance.household.s2d', { legalEntityId: entity, month }, user);
  const report = (o: Org, month: string, entity = o.household) => query<Array<Record<string, string | boolean | null>>>(o, 'finance.stock.report', { month, legalEntityId: entity });

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
    // The seeded law rows are `confirmed` from #3710 (finance-household.db.test.ts checks that). This file exercises the provisional label, so it starts from the rows as they were before:
    // `commentary`, restored here as the database owner (the law tables are read-only to every tenant login).
    // The yearly revenue threshold and the PIT cut are set to 0 here: these files test the books' rows, splits, labels and Excel with small revenues, so every revenue is above the threshold and the tax is the plain
    // percentage of it, as before the yearly rule (#3710 slice 3). That rule has its own file, finance-household-annual.db.test.ts, on the real rows (1 billion VND, PIT cut 30%).
    const restore = new pg.Client({ connectionString: adminUrl });
    await restore.connect();
    await restore.query(
      "UPDATE crove_finance.household_threshold SET amount = 0 WHERE code = 'no_tax_revenue'; UPDATE crove_finance.household_tax_reduction SET cut_percent = 0 WHERE kind = 'pit'; UPDATE crove_finance.household_trade_rate SET status = 'commentary'; UPDATE crove_finance.household_form_version SET status = 'commentary'; UPDATE crove_finance.household_return_form_version SET status = 'commentary'",
    );
    await restore.end();
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  const item = (o: Org, code: string, entity = o.household) =>
    admin(async (a) => (await a.query<{ id: string }>("INSERT INTO crove_finance.stock_item (org_id, legal_entity_id, code, name, unit, stock_account, trade) VALUES ($1, $2, $3, $3, 'kg', '156', 'goods') RETURNING id", [o.orgId, entity, code])).rows[0]?.id as string);
  // A purchase document of the entity with one line, the stock move it makes (quantity in, valued at the line's amount) and its journal entry, all in one transaction: a purchase document commits only together
  // with its own entry (check_purchase_document_entry).
  const purchase = (o: Org, itemId: string, date: string, quantity: number, amount: number, number: string, entity = o.household) =>
    admin(async (a) => {
      await a.query('BEGIN');
      try {
        const party = (await a.query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'Nhà cung cấp') RETURNING id", [o.orgId])).rows[0]?.id;
        const document = (
          await a.query<{ id: string }>(
            "INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id) VALUES ($1, $2, 'AA', $3, $4, $5, 0, $5, 'purchase', $6) RETURNING id",
            [o.orgId, party, number, date, amount, entity],
          )
        ).rows[0]?.id as string;
        await a.query("INSERT INTO crove_finance.purchase_line (org_id, document_id, line_no, description, amount, debit_account) VALUES ($1, $2, 1, 'Hàng', $3, '156')", [o.orgId, document, amount]);
        await a.query("INSERT INTO crove_finance.stock_move (org_id, legal_entity_id, item_id, move_date, quantity, source_type, document_id, line_no, line_attempt) VALUES ($1, $2, $3, $4, $5, 'document_line', $6, 1, 1)", [o.orgId, entity, itemId, date, quantity, document]);
        const entry = (
          await a.query<{ id: string }>(
            "INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, 'Mua hàng', 'finance.purchase_document', $3, $4) RETURNING id",
            [o.orgId, date, document, entity],
          )
        ).rows[0]?.id;
        await a.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '156', $3, 0), ($1, $2, 2, '331', 0, $3)", [o.orgId, entry, amount]);
        await a.query('COMMIT');
      } catch (error) {
        await a.query('ROLLBACK');
        throw error;
      }
    });
  const manual = (o: Org, itemId: string, date: string, quantity: number, entity = o.household) =>
    admin((a) => a.query("INSERT INTO crove_finance.stock_move (org_id, legal_entity_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, $4, $5, 'manual')", [o.orgId, entity, itemId, date, quantity]));


  it('gives each item its opening, moves, totals and closing, equal to the stock report, and leaves another entity out', async () => {
    const o = await org();
    await setProfile(o);
    const rice = await item(o, 'GAO');
    const other = await item(o, 'CTY', o.company);
    await purchase(o, rice, '2026-09-05', 10, 1000000, '0001');
    await manual(o, rice, '2026-09-10', -4);
    await purchase(o, other, '2026-09-06', 5, 500000, '0002', o.company);
    const book = await s2d(o, '2026-09');
    expect(book.period).toEqual({ month: '2026-09', from: '2026-09-01', to: '2026-09-30' });
    expect(book.form).toMatchObject({ book: 'S2d', status: 'commentary' });
    expect(book.items.map((i) => i.code)).toEqual(['GAO']);
    const gao = book.items[0]!;
    expect(gao.rows.map((r) => [r.date, r.reference, r.quantityIn, r.quantityOut, r.valueIn, r.balanceQuantity])).toEqual([
      ['2026-09-05', 'AA-0001', '10', '0', '1000000', '10'],
      ['2026-09-10', null, '0', '4', null, '6'],
    ]);
    expect(gao).toMatchObject({ openingQuantity: '0', inQuantity: '10', inValue: '1000000', outQuantity: '4', outValue: '400000', closingQuantity: '6', closingValue: '600000', unitCost: '100000' });
    expect(book.totals).toEqual({ openingValue: '0', inValue: '1000000', outValue: '400000', closingValue: '600000' });
    expect(book.monthClosed).toBe(false);
    // The book is the report's own figures: nothing is recomputed.
    const row = (await report(o, '2026-09')).find((r) => r.itemId === rice)!;
    for (const key of ['openingQuantity', 'openingValue', 'inQuantity', 'inValue', 'outQuantity', 'outValue', 'closingQuantity', 'closingValue', 'unitCost'] as const) expect(gao[key], key).toBe(row[key]);
    expect(book.commentary).toBe(true);
    expect(book.unconfirmed.map((u) => [u.kind, u.key])).toEqual([['form', expect.stringContaining('S2d')]]);
  });

  it('opens the next month with the balance of the month before, and leaves out an item with nothing in the month and nothing on hand', async () => {
    const o = await org();
    await setProfile(o);
    const rice = await item(o, 'GAO');
    const gone = await item(o, 'HET');
    await purchase(o, rice, '2026-09-05', 10, 1000000, '0001');
    await purchase(o, gone, '2026-08-05', 2, 200000, '0002');
    await manual(o, gone, '2026-08-20', -2);
    await manual(o, rice, '2026-10-03', -5);
    const book = await s2d(o, '2026-10');
    expect(book.items.map((i) => i.code)).toEqual(['GAO']);
    expect(book.items[0]).toMatchObject({ openingQuantity: '10', openingValue: '1000000', outQuantity: '5', closingQuantity: '5', closingValue: '500000' });
    expect(book.items[0]!.rows).toHaveLength(1);
  });

  it('reads a closed month from what the close stored, and says the month is closed', async () => {
    const o = await org();
    await setProfile(o);
    const rice = await item(o, 'GAO');
    await purchase(o, rice, '2026-09-05', 10, 1000000, '0001');
    await manual(o, rice, '2026-09-10', -4);
    const entity = o.household;
    await admin(async (a) => {
      const period = (await a.query<{ id: string }>('INSERT INTO crove_finance.stock_period (org_id, legal_entity_id, period_month, total_cost) VALUES ($1, $2, DATE \'2026-09-01\', 0) RETURNING id', [o.orgId, entity])).rows[0]?.id;
      await a.query(
        `INSERT INTO crove_finance.stock_period_item (org_id, period_id, item_id, opening_quantity, opening_value, in_quantity, in_value, out_quantity, out_value, closing_quantity, closing_value, unit_cost)
         VALUES ($1, $2, $3, 0, 0, 10, 1000000, 4, 400000, 6, 600000, 100000)`,
        [o.orgId, period, rice],
      );
    });
    const book = await s2d(o, '2026-09');
    expect(book.monthClosed).toBe(true);
    expect(book.items[0]).toMatchObject({ outValue: '400000', closingValue: '600000', unitCost: '100000' });
    const row = (await report(o, '2026-09')).find((r) => r.itemId === rice)!;
    expect(row.closed).toBe(true);
    expect(book.items[0]!.closingValue).toBe(row.closingValue);
  });

  it('gives an empty book when nothing moved, and labels the book only while the layout row is commentary', async () => {
    const o = await org();
    await setProfile(o);
    const empty = await s2d(o, '2026-09');
    expect(empty.items).toEqual([]);
    expect(empty.totals).toEqual({ openingValue: '0', inValue: '0', outValue: '0', closingValue: '0' });
    await admin((a) => a.query("INSERT INTO crove_finance.household_form_version (book, version, effective_from, name, pit_methods, source, status) VALUES ('S2d', '2026.2', DATE '2026-12-01', 'Sổ chi tiết hàng hóa (S2d-HKD)', ARRAY['income']::text[], 'test', 'confirmed')"));
    expect((await s2d(o, '2026-11')).commentary).toBe(true);
    const december = await s2d(o, '2026-12');
    expect(december.commentary).toBe(false);
    expect(december.form).toMatchObject({ version: '2026.2', status: 'confirmed' });
  });

  it('refuses a quarter or a year with a named error that says why', async () => {
    const o = await org();
    await setProfile(o);
    for (const period of ['2026-Q3', '2026']) await expect(s2d(o, period)).rejects.toMatchObject({ code: 'HOUSEHOLD_S2D_MONTH_ONLY' });
  });

  it('refuses an entity that is not a household, has no profile, is on group 1 or on the percentage method, and lets a viewer read the book', async () => {
    const o = await org();
    await expect(s2d(o, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    await expect(s2d(o, '2026-09', o.company)).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    await setProfile(o, { taxGroup: 1, pitMethod: null });
    await expect(s2d(o, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    const percentage = await org();
    await setProfile(percentage, { taxGroup: 2, pitMethod: 'percentage' });
    await expect(s2d(percentage, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    const reader = await org();
    await setProfile(reader);
    const rice = await item(reader, 'GAO');
    await purchase(reader, rice, '2026-09-05', 1, 100000, '0001');
    await expect(s2d(reader, '2026-09', reader.household, reader.viewer)).resolves.toMatchObject({ totals: { closingValue: '100000' } });
  });
});

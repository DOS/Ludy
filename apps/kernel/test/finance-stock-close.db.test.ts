// SPDX-License-Identifier: AGPL-3.0-only
// The tables and guards of the stock month close (#2513, ADR-0045 point 2), on a real PostgreSQL 17: a closed month is append-only, is closed in order and only once it is over, keeps
// every move out of it, and is the authority of the reports: its own report reads what the close stored and the month after it opens with its closing balance.
// The command that closes a month (and posts its cost) is tested in finance-stock-close-command.db.test.ts; here the rows a close leaves are written by the database owner.
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

interface Row {
  itemId: string;
  closed: boolean;
  openingQuantity: string;
  openingValue: string;
  inQuantity: string;
  inValue: string;
  outQuantity: string;
  outValue: string;
  closingQuantity: string;
  closingValue: string;
  unitCost: string | null;
}

suite('the stock month close: tables, guards and reports (#2513)', () => {
  const dbName = `crove_test_stockclose_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@close.test`, name: null });
  type Org = { orgId: string; owner: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Kho ${randomUUID().slice(0, 6)}`);
    const viewer = await identity('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer]));
    return { orgId, owner, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const makeItem = (o: Org, code: string) =>
    execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code, name: `Hàng ${code}`, unit: 'cái', stockAccount: '156', trade: 'goods' }).then((r) => r.id);
  const move = (o: Org, item: string, date: string, quantity: string) =>
    rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, $4, 'manual')", [o.orgId, item, date, quantity]);
  const entityOf = async (o: Org) => (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [o.orgId]))[0]?.id ?? '';
  // What a close leaves: the period, and a row per item with the figures the cost was posted from.
  async function closePeriod(o: Org, month: string, items: Array<{ item: string; opening: [string, string]; inn: [string, string]; out: [string, string]; closing: [string, string]; cost: string | null }>) {
    const [period] = await rows<{ id: string }>('INSERT INTO crove_finance.stock_period (org_id, legal_entity_id, period_month, total_cost) VALUES ($1, $2, $3, 0) RETURNING id', [o.orgId, await entityOf(o), `${month}-01`]);
    for (const i of items) {
      await rows(
        `INSERT INTO crove_finance.stock_period_item (org_id, period_id, item_id, opening_quantity, opening_value, in_quantity, in_value, out_quantity, out_value, closing_quantity, closing_value, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [o.orgId, period?.id, i.item, ...i.opening, ...i.inn, ...i.out, ...i.closing, i.cost],
      );
    }
    return period?.id as string;
  }
  const report = (o: Org, month: string, user = o.owner) => query<Row[]>(o, 'finance.stock.report', { month }, user);

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

  it('closes months in order and only once they are over, once each, and never changes or removes one', async () => {
    const o = await org();
    const item = await makeItem(o, 'A');
    await move(o, item, '2026-07-10', '10');
    const entity = await entityOf(o);
    const insert = (month: string) => rows('INSERT INTO crove_finance.stock_period (org_id, legal_entity_id, period_month) VALUES ($1, $2, $3)', [o.orgId, entity, `${month}-01`]);
    // The month has to be the first day, and over.
    await expect(rows('INSERT INTO crove_finance.stock_period (org_id, legal_entity_id, period_month) VALUES ($1, $2, $3)', [o.orgId, entity, '2026-07-15'])).rejects.toThrow();
    const now = new Date();
    const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    await expect(insert(thisMonth)).rejects.toThrow(/STOCK_PERIOD_NOT_ENDED/);
    // August is not closed while the July move has no closed month before it.
    await expect(insert('2026-08')).rejects.toThrow(/STOCK_PERIOD_ORDER/);
    await insert('2026-07');
    await insert('2026-08');
    await expect(insert('2026-08')).rejects.toThrow(/stock_period_month_uq/);
    // Append-only for the database owner too.
    await expect(rows('UPDATE crove_finance.stock_period SET total_cost = 1 WHERE org_id = $1', [o.orgId])).rejects.toThrow();
    await expect(rows('DELETE FROM crove_finance.stock_period WHERE org_id = $1', [o.orgId])).rejects.toThrow();
    // The periods query: newest first, every role reads it.
    const listed = await query<Array<{ month: string; totalCost: string; voucherId: string | null }>>(o, 'finance.stock.periods', {}, o.viewer);
    expect(listed.map((p) => [p.month, p.totalCost, p.voucherId])).toEqual([
      ['2026-08', '0', null],
      ['2026-07', '0', null],
    ]);
    // A cost that was posted names its voucher.
    await expect(rows('INSERT INTO crove_finance.stock_period (org_id, legal_entity_id, period_month, total_cost) VALUES ($1, $2, $3, 500)', [o.orgId, entity, '2026-09-01'])).rejects.toThrow(/stock_period_voucher_ck/);
  });

  it('refuses a move dated in a closed month or before one, and takes one of the open month', async () => {
    const o = await org();
    const item = await makeItem(o, 'B');
    await move(o, item, '2026-08-05', '5');
    await closePeriod(o, '2026-08', [{ item, opening: ['0', '0'], inn: ['5', '500'], out: ['0', '0'], closing: ['5', '500'], cost: '100' }]);
    await expect(move(o, item, '2026-08-20', '1')).rejects.toThrow(/STOCK_PERIOD_CLOSED/);
    await expect(move(o, item, '2026-07-31', '1')).rejects.toThrow(/STOCK_PERIOD_CLOSED/);
    await move(o, item, '2026-09-01', '1');
    // Another entity's moves are not held by this entity's close.
    const other = (await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, created_by) VALUES ($1, 'Pháp nhân phụ', $2) RETURNING id", [o.orgId, o.owner]))[0]?.id;
    const foreign = await execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: other, code: 'C', name: 'Hàng C', unit: 'cái', stockAccount: '156', trade: 'goods' });
    await move(o, foreign.id, '2026-08-10', '2');
  });

  it('reads a closed month from what the close stored, and opens the month after it with its closing balance', async () => {
    const o = await org();
    const item = await makeItem(o, 'D');
    await move(o, item, '2026-08-05', '5');
    // The close of August stored a figure the moves could not give again (a cost rounded at the close): the report returns it as stored.
    await closePeriod(o, '2026-08', [{ item, opening: ['0', '0'], inn: ['10', '1000'], out: ['5', '500'], closing: ['5', '500'], cost: '100' }]);
    const august = (await report(o, '2026-08')).find((r) => r.itemId === item);
    expect(august).toMatchObject({ closed: true, openingQuantity: '0', inQuantity: '10', inValue: '1000', outQuantity: '5', outValue: '500', closingQuantity: '5', closingValue: '500', unitCost: '100' });
    // September has one move out of the open month and opens with August's closing: five on hand at 100 each, two leave at that average.
    await move(o, item, '2026-09-10', '-2');
    const september = (await report(o, '2026-09')).find((r) => r.itemId === item);
    expect(september).toMatchObject({ closed: false, openingQuantity: '5', openingValue: '500', outQuantity: '2', outValue: '200', closingQuantity: '3', closingValue: '300', unitCost: '100' });
    // The card of the closed month is not provisional, the one of September is, and it starts from the opening of the month.
    expect(await query<{ provisional: boolean }>(o, 'finance.stock.card', { itemId: item, month: '2026-08' })).toMatchObject({ provisional: false, closingQuantity: '5', unitCost: '100' });
    expect(await query<{ provisional: boolean; openingQuantity: string; moves: unknown[] }>(o, 'finance.stock.card', { itemId: item, month: '2026-09' })).toMatchObject({ provisional: true, openingQuantity: '5', moves: [expect.objectContaining({ quantity: '-2', balance: '3' })] });
    // An entity that closed nothing keeps the provisional figures, and a viewer reads the same report.
    expect((await report(o, '2026-09', o.viewer)).find((r) => r.itemId === item)).toMatchObject({ closed: false, closingQuantity: '3' });
  });
});

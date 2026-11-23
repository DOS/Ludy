// SPDX-License-Identifier: AGPL-3.0-only
// A partial return of the goods of a sale (#3712 slice 1), on a real PostgreSQL 17: finance.stock_move.return writes a stock-in that names the sale's stock-out, never more than was sold, under a
// lock on the sale move; an undo is the reversal of the return; a sale move with a live return is not reversed on its own; the database holds the same rules for any writer.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('a partial return of the goods of a sale (#3712)', () => {
  const dbName = `crove_test_stock_return_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@stock.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Kho ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) => c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]));
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  // A move straight into the table as the database owner: the triggers fire, RLS does not (the commands that write moves come with the posting of document lines).
  const addMove = async (o: Org, itemId: string, quantity: string, date = '2026-11-03') =>
    String((await rows<{ id: string }>("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [o.orgId, itemId, date, quantity]))[0]?.id);

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
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // A sale's stock-out as the database owner: a delivered CRM order line is a stock-out with no document behind it (the guards fire, RLS does not).
  const addSale = async (o: Org, itemId: string, quantity: string) =>
    String((await rows<{ id: string }>("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type, crm_order_id, crm_order_line_no) VALUES ($1, $2, '2026-11-03', $3, 'crm_order_line', $4, 1) RETURNING id", [o.orgId, itemId, quantity, randomUUID()]))[0]?.id);
  interface Move {
    id: string;
    quantity: string;
    source: string;
    reversed: boolean;
    returnOfMoveId: string | null;
    returnable: string;
  }
  const moves = (o: Org, itemId: string, user = o.owner) => query<Move[]>(o, 'finance.stock_move.list', { itemId }, user);
  const onHand = async (o: Org, itemId: string) => (await query<Array<{ id: string; onHand: string }>>(o, 'finance.stock_item.list', {})).find((i) => i.id === itemId)?.onHand;
  const giveBack = (o: Org, moveId: string, quantity: string, user = o.owner) => execute<{ id: string }>(o, 'finance.stock_move.return', { moveId, quantity }, user);
  async function sold(quantity = '10') {
    const o = await org();
    const { id: item } = await execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code: 'SP001', name: 'Gạo thơm', unit: 'kg', stockAccount: '156', trade: 'goods' });
    await addMove(o, item, '20');
    const sale = await addSale(o, item, `-${quantity}`);
    return { o, item, sale };
  }

  it('takes back part of a sale: a stock-in that names the sale, dated today, and tells how much is still returnable', async () => {
    const { o, item, sale } = await sold();
    expect(await onHand(o, item)).toBe('10');
    const { id } = await giveBack(o, sale, '3');
    expect(await onHand(o, item)).toBe('13');
    const list = await moves(o, item);
    expect(list.find((m) => m.id === id)).toMatchObject({ quantity: '3', source: 'sale_return', returnOfMoveId: sale, reversed: false, returnable: '0' });
    expect(list.find((m) => m.id === sale)).toMatchObject({ quantity: '-10', returnable: '7' });
    // Decimals within the six the table holds.
    await giveBack(o, sale, '0.5');
    expect((await moves(o, item)).find((m) => m.id === sale)?.returnable).toBe('6.5');
  });

  it('never takes back more than was sold, the live returns together included, and a return is refused when nothing is left', async () => {
    const { o, item, sale } = await sold();
    await giveBack(o, sale, '3');
    await expect(giveBack(o, sale, '7.000001')).rejects.toMatchObject({ code: 'STOCK_RETURN_EXCEEDS' });
    await giveBack(o, sale, '7');
    expect((await moves(o, item)).find((m) => m.id === sale)?.returnable).toBe('0');
    await expect(giveBack(o, sale, '0.000001')).rejects.toMatchObject({ code: 'STOCK_RETURN_EXCEEDS' });
    expect(await onHand(o, item)).toBe('20');
  });

  it('lets two returns at once take no more than was sold: the second meets the lock on the sale move and is refused', async () => {
    const { o, item, sale } = await sold();
    const results = await Promise.allSettled([giveBack(o, sale, '6'), giveBack(o, sale, '6')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'STOCK_RETURN_EXCEEDS' });
    expect(await onHand(o, item)).toBe('16');
  });

  it('refuses a return of anything that is not a sale: a manual stock-in, a reversal, a return, a count; and of an unknown move', async () => {
    const { o, item, sale } = await sold();
    const manual = await addMove(o, item, '5');
    await expect(giveBack(o, manual, '1')).rejects.toMatchObject({ code: 'STOCK_RETURN_NOT_SALE' });
    const back = await giveBack(o, sale, '2');
    await expect(giveBack(o, back.id, '1')).rejects.toMatchObject({ code: 'STOCK_RETURN_NOT_SALE' });
    const undo = await execute<{ id: string }>(o, 'finance.stock_move.reverse', { moveId: back.id });
    await expect(giveBack(o, undo.id, '1')).rejects.toMatchObject({ code: 'STOCK_RETURN_NOT_SALE' });
    await expect(giveBack(o, randomUUID(), '1')).rejects.toMatchObject({ code: 'STOCK_MOVE_NOT_FOUND' });
  });

  it('does not take a zero, a negative or a malformed quantity, and only owners, admins and members may return', async () => {
    const { o, sale } = await sold();
    for (const quantity of ['0', '-1', '1.0000001', 'abc', '']) await expect(giveBack(o, sale, quantity)).rejects.toBeTruthy();
    await expect(giveBack(o, sale, '1', o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(giveBack(o, sale, '1', o.member)).resolves.toMatchObject({ id: expect.any(String) });
    await expect(giveBack(o, sale, '1', o.admin)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('undoes a return with the existing reversal, after which the pieces can be returned again; a sale with a live return is not reversed on its own', async () => {
    const { o, item, sale } = await sold();
    const back = await giveBack(o, sale, '4');
    // The sale move cannot be reversed under its return, by the command or by the database.
    await expect(execute(o, 'finance.stock_move.reverse', { moveId: sale })).rejects.toMatchObject({ code: 'STOCK_MOVE_HAS_RETURN' });
    await expect(rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type, reverses_move_id) VALUES ($1, $2, current_date, 10, 'reversal', $3)", [o.orgId, item, sale])).rejects.toMatchObject({
      code: '23514',
      message: expect.stringContaining('STOCK_MOVE_HAS_RETURN'),
    });
    await execute(o, 'finance.stock_move.reverse', { moveId: back.id });
    expect(await onHand(o, item)).toBe('10');
    const list = await moves(o, item);
    expect(list.find((m) => m.id === back.id)?.reversed).toBe(true);
    expect(list.find((m) => m.id === sale)?.returnable).toBe('10');
    await giveBack(o, sale, '10');
    expect(await onHand(o, item)).toBe('20');
    // With the returns undone the sale can be reversed whole, and then no return is taken against it.
    const second = (await moves(o, item)).find((m) => m.returnOfMoveId === sale && !m.reversed) as Move;
    await execute(o, 'finance.stock_move.reverse', { moveId: second.id });
    await execute(o, 'finance.stock_move.reverse', { moveId: sale });
    await expect(giveBack(o, sale, '1')).rejects.toMatchObject({ code: 'STOCK_RETURN_REVERSED' });
  });

  it('holds the same rules for any writer in SQL: a return of another item, a negative one, one with no sale, and one above what was sold', async () => {
    const { o, item, sale } = await sold();
    const other = (await execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code: 'SP002', name: 'Đường', unit: 'kg', stockAccount: '156', trade: 'goods' })).id;
    const insert = (itemId: string, quantity: string, of: string | null) =>
      rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type, return_of_move_id) VALUES ($1, $2, current_date, $3, 'sale_return', $4)", [o.orgId, itemId, quantity, of]);
    await expect(insert(other, '1', sale)).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('STOCK_RETURN_NOT_SALE') });
    await expect(insert(item, '-1', sale)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(item, '1', null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(item, '11', sale)).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('STOCK_RETURN_EXCEEDS') });
    await expect(insert(item, '10', sale)).resolves.toBeDefined();
    // Another source cannot carry the link.
    await expect(rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type, return_of_move_id) VALUES ($1, $2, current_date, 1, 'manual', $3)", [o.orgId, item, sale])).rejects.toMatchObject({ code: '23514' });
  });
});

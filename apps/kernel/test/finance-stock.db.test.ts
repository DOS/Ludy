// SPDX-License-Identifier: AGPL-3.0-only
// Items of stock, their aliases and the append-only ledger of stock moves (#2512, ADR-0045 point 1), on a real PostgreSQL 17: an item per legal entity with a unique code,
// its unit and account fixed once a move names it, aliases normalized and never changed, moves that no role updates or deletes (a correction is a reversing move, once),
// on hand as the sum of the moves, and who may do what in the commands and in SQL as the runtime's own login.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Item {
  id: string;
  legalEntityId: string;
  code: string;
  name: string;
  unit: string;
  stockAccount: string;
  trade: string;
  active: boolean;
  onHand: string;
  moves: number;
}

suite('stock items, aliases and moves (#2512)', () => {
  const dbName = `crove_test_stock_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]));
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const itemInput = (extra: Record<string, unknown> = {}) => ({ itemId: null, legalEntityId: null, code: 'SP001', name: 'Gạo thơm', unit: 'kg', stockAccount: '156', trade: 'goods', ...extra });
  const save = (o: Org, extra: Record<string, unknown> = {}, user = o.owner) => execute<{ id: string }>(o, 'finance.stock_item.save', itemInput(extra), user);
  const list = (o: Org, input: Record<string, unknown> = {}, user = o.owner) => query<Item[]>(o, 'finance.stock_item.list', input, user);
  // A move straight into the table as the database owner: the triggers fire, RLS does not (the commands that write moves come with the posting of document lines).
  const addMove = async (o: Org, itemId: string, quantity: string, date = '2026-11-03') =>
    String((await rows<{ id: string }>("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [o.orgId, itemId, date, quantity]))[0]?.id);

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
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

  it('makes an item, edits it, keeps its code and entity, deactivates it, and lists it with what is on hand', async () => {
    const o = await org();
    const { id } = await save(o);
    expect(await list(o)).toEqual([expect.objectContaining({ id, code: 'SP001', name: 'Gạo thơm', unit: 'kg', stockAccount: '156', trade: 'goods', active: true, onHand: '0', moves: 0 })]);
    // The same code in the entity is refused; the same code in another org is not.
    await expect(save(o, { name: 'Khác' })).rejects.toMatchObject({ code: 'STOCK_ITEM_CODE_EXISTS' });
    await expect(save(await org())).resolves.toMatchObject({ id: expect.any(String) });
    // An edit changes the name, unit, account and trade; the code and the entity stay.
    await save(o, { itemId: id, name: 'Gạo thơm ST25', unit: 'bao', trade: 'other' });
    expect((await list(o))[0]).toMatchObject({ name: 'Gạo thơm ST25', unit: 'bao', trade: 'other' });
    await expect(save(o, { itemId: id, code: 'SP002' })).rejects.toMatchObject({ code: 'STOCK_ITEM_CODE_FIXED' });
    await expect(save(o, { itemId: id, legalEntityId: randomUUID() })).rejects.toMatchObject({ code: 'STOCK_ITEM_ENTITY_FIXED' });
    // An item is deactivated, never deleted: the list leaves it out unless asked.
    expect(await execute(o, 'finance.stock_item.set_active', { itemId: id, active: false })).toEqual({ active: false });
    expect(await list(o)).toEqual([]);
    expect(await list(o, { includeInactive: true })).toHaveLength(1);
    expect((await rows('SELECT 1 FROM crove_finance.stock_item WHERE org_id = $1 AND id = $2', [o.orgId, id])).length).toBe(1);
    // Audit facts name ids, never the item's name.
    const audits = await rows<{ detail: unknown }>("SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command LIKE 'finance.stock_item.%' AND outcome = 'ok'", [o.orgId]);
    expect(JSON.stringify(audits)).not.toContain('Gạo');
  });

  it('books an item only to a goods account of the chart, and fixes its unit and account once a move names it', async () => {
    const o = await org();
    await expect(save(o, { stockAccount: '111' })).rejects.toMatchObject({ code: 'STOCK_ACCOUNT_KIND' });
    await expect(save(o, { stockAccount: '999' })).rejects.toMatchObject({ code: 'STOCK_ACCOUNT_UNKNOWN' });
    const { id } = await save(o);
    await addMove(o, id, '5');
    await expect(save(o, { itemId: id, unit: 'tấn' })).rejects.toMatchObject({ code: 'STOCK_ITEM_IN_USE' });
    // The name and the trade still change; the database says the same to a direct update of the unit.
    await save(o, { itemId: id, name: 'Gạo mới', trade: 'goods' });
    await expect(rows("UPDATE crove_finance.stock_item SET unit = 'tấn' WHERE org_id = $1 AND id = $2", [o.orgId, id])).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('STOCK_ITEM_IN_USE') });
  });

  it('teaches a name once, normalizes it, keeps a name to one item and forgets it', async () => {
    const o = await org();
    const a = await save(o);
    const b = await save(o, { code: 'SP002', name: 'Đường' });
    const teach = (itemId: string, key: string, factor = '1') => execute<{ id: string; existing: boolean }>(o, 'finance.stock_alias.teach', { itemId, source: 'text', key, factor });
    const first = await teach(a.id, '  GẠO  Thơm   5kg ');
    expect(first.existing).toBe(false);
    expect((await rows<{ alias_key: string }>('SELECT alias_key FROM crove_finance.stock_alias WHERE org_id = $1 AND id = $2', [o.orgId, first.id]))[0]?.alias_key).toBe('gạo thơm 5kg');
    // The same name written another way is the same alias for the same item, refused for another item or another factor.
    expect(await teach(a.id, 'gạo thơm 5KG')).toEqual({ id: first.id, existing: true });
    await expect(teach(b.id, 'gạo thơm 5kg')).rejects.toMatchObject({ code: 'STOCK_ALIAS_TAKEN' });
    await expect(teach(a.id, 'gạo thơm 5kg', '12')).rejects.toMatchObject({ code: 'STOCK_ALIAS_FACTOR' });
    await expect(teach(a.id, '   ')).rejects.toMatchObject({ code: 'VALIDATION' });
    // A carton of 12 is taught with its factor; an inactive item takes no name.
    await expect(teach(a.id, 'thùng gạo', '12')).resolves.toMatchObject({ existing: false });
    await execute(o, 'finance.stock_item.set_active', { itemId: b.id, active: false });
    await expect(teach(b.id, 'đường cát')).rejects.toMatchObject({ code: 'STOCK_ITEM_INACTIVE' });
    // Forgetting removes it, and the name is free for the other item.
    expect(await execute(o, 'finance.stock_alias.forget', { aliasId: first.id })).toEqual({ removed: true });
    expect(await execute(o, 'finance.stock_alias.forget', { aliasId: first.id })).toEqual({ removed: false });
    await execute(o, 'finance.stock_item.set_active', { itemId: b.id, active: true });
    await expect(teach(b.id, 'gạo thơm 5kg')).resolves.toMatchObject({ existing: false });
    // An alias takes its item's entity (that no tenant role updates one is tested in SQL below).
    const entity = (await rows<{ legal_entity_id: string }>('SELECT legal_entity_id FROM crove_finance.stock_item WHERE org_id = $1 AND id = $2', [o.orgId, a.id]))[0]?.legal_entity_id;
    expect((await rows<{ legal_entity_id: string }>('SELECT DISTINCT legal_entity_id FROM crove_finance.stock_alias WHERE org_id = $1 AND item_id = $2', [o.orgId, a.id])).map((r) => r.legal_entity_id)).toEqual([entity]);
  });

  it('keeps the moves append-only for every role, reverses a move once by the opposite quantity, and sums on hand from the moves', async () => {
    const o = await org();
    const { id } = await save(o);
    const inMove = await addMove(o, id, '5.5');
    const outMove = await addMove(o, id, '-3');
    expect((await list(o))[0]).toMatchObject({ onHand: '2.5', moves: 2 });
    // Nobody updates or deletes a move: not a tenant role (no grant), not the database owner (the append-only trigger), not a truncate.
    const refuseAll = async (sqlText: string) => {
      await expect(rows(sqlText, [o.orgId])).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('append-only') });
    };
    await refuseAll("UPDATE crove_finance.stock_move SET quantity = 99 WHERE org_id = $1");
    await refuseAll('DELETE FROM crove_finance.stock_move WHERE org_id = $1');
    await expect(rows('TRUNCATE crove_finance.stock_move')).rejects.toMatchObject({ code: '42501' });
    const asRuntime = async (sqlText: string, who = o.member) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, who, o.orgId);
        return await c.query(sqlText, [o.orgId]);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    };
    await expect(asRuntime('UPDATE crove_finance.stock_move SET quantity = 99 WHERE org_id = $1', o.owner)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    await expect(asRuntime('DELETE FROM crove_finance.stock_move WHERE org_id = $1', o.owner)).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    // A correction is a reversing move of the opposite quantity, written by the command, once.
    const reversal = await execute<{ id: string }>(o, 'finance.stock_move.reverse', { moveId: outMove });
    expect((await list(o))[0]).toMatchObject({ onHand: '5.5', moves: 3 });
    expect(await rows<{ quantity: string; source_type: string; reverses_move_id: string }>('SELECT quantity::text, source_type, reverses_move_id FROM crove_finance.stock_move WHERE org_id = $1 AND id = $2', [o.orgId, reversal.id])).toEqual([
      { quantity: '3.000000', source_type: 'reversal', reverses_move_id: outMove },
    ]);
    await expect(execute(o, 'finance.stock_move.reverse', { moveId: outMove })).rejects.toMatchObject({ code: 'STOCK_MOVE_REVERSED' });
    await expect(execute(o, 'finance.stock_move.reverse', { moveId: reversal.id })).rejects.toMatchObject({ code: 'STOCK_MOVE_IS_REVERSAL' });
    await expect(execute(o, 'finance.stock_move.reverse', { moveId: randomUUID() })).rejects.toMatchObject({ code: 'STOCK_MOVE_NOT_FOUND' });
    // The list says which move was reversed; and the database refuses a reversal that is not the exact opposite of one move, or a second one.
    const moves = await query<Array<{ id: string; reversed: boolean; source: string }>>(o, 'finance.stock_move.list', { itemId: id });
    expect(moves.find((m) => m.id === outMove)?.reversed).toBe(true);
    expect(moves.find((m) => m.id === inMove)?.reversed).toBe(false);
    const rawReversal = (moveId: string, quantity: string) =>
      rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, reverses_move_id) VALUES ($1, $2, '2026-11-04', $3, 'reversal', $4)", [o.orgId, id, quantity, moveId]);
    await expect(rawReversal(inMove, '-5')).rejects.toMatchObject({ code: '23514', message: expect.stringContaining('STOCK_REVERSAL') });
    await expect(rawReversal(reversal.id, '-3')).rejects.toMatchObject({ code: '23514' });
    await expect(rawReversal(outMove, '3')).rejects.toMatchObject({ code: '23505' });
    // A move is never zero, and a manual move names no document line.
    await expect(addMove(o, id, '0')).rejects.toMatchObject({ code: '23514' });
    await expect(rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, document_id, line_no) VALUES ($1, $2, '2026-11-03', 1, 'manual', $3, 1)", [o.orgId, id, randomUUID()])).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps the unit of an item that has taught names, whose factors are against that unit, until they are forgotten', async () => {
    const o = await org();
    const { id } = await save(o, { unit: 'chai' });
    await execute(o, 'finance.stock_alias.teach', { itemId: id, source: 'text', key: 'thùng nước', factor: '12', unit: 'thùng' });
    await expect(save(o, { itemId: id, unit: 'thùng' })).rejects.toMatchObject({ code: 'STOCK_ITEM_IN_USE' });
    const alias = (await rows<{ id: string }>('SELECT id FROM crove_finance.stock_alias WHERE org_id = $1 AND item_id = $2', [o.orgId, id]))[0]?.id;
    await execute(o, 'finance.stock_alias.forget', { aliasId: alias });
    await expect(save(o, { itemId: id, unit: 'thùng' })).resolves.toEqual({ id });
  });

  it('shows negative stock as it is, and lets members read and write while a viewer only reads', async () => {
    const o = await org();
    const { id } = await save(o, {}, o.member);
    await addMove(o, id, '-4');
    expect((await list(o, {}, o.viewer))[0]).toMatchObject({ onHand: '-4' });
    await expect(save(o, { code: 'SP9' }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(execute(o, 'finance.stock_item.set_active', { itemId: id, active: false }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(execute(o, 'finance.stock_alias.teach', { itemId: id, source: 'text', key: 'x', factor: '1' }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // Another org sees none of it.
    const other = await org();
    expect(await list(other)).toEqual([]);
    await expect(execute(other, 'finance.stock_item.set_active', { itemId: id, active: false })).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
    await expect(query(other, 'finance.stock_move.list', { itemId: id })).rejects.toMatchObject({ code: 'STOCK_ITEM_NOT_FOUND' });
  });

  it('holds the roles in SQL as the runtime\'s own login: a viewer writes nothing, a tenant role changes only an item\'s name, unit, account, trade and flag', async () => {
    const o = await org();
    const { id } = await save(o);
    async function asRole<T>(who: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await enterUser(c, who, o.orgId);
        return await fn(c);
      } finally {
        await c.query('ROLLBACK').catch(() => undefined);
        c.release();
      }
    }
    const insertItem = "INSERT INTO crove_finance.stock_item (org_id, code, name, unit, stock_account) VALUES ($1, 'SQL1', 'x', 'cái', '156')";
    await expect(asRole(o.viewer, (c) => c.query(insertItem, [o.orgId]))).rejects.toMatchObject({ code: '42501' });
    expect(await asRole(o.member, async (c) => (await c.query(insertItem, [o.orgId])).rowCount)).toBe(1);
    const insertMove = "INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, '2026-11-03', 1, 'manual')";
    await expect(asRole(o.viewer, (c) => c.query(insertMove, [o.orgId, id]))).rejects.toMatchObject({ code: '42501' });
    expect(await asRole(o.member, async (c) => (await c.query(insertMove, [o.orgId, id])).rowCount)).toBe(1);
    // The update grant is the five columns; the code, the entity, the kind and who made it are fixed for every tenant role, and an item is never deleted.
    expect(await asRole(o.member, async (c) => (await c.query("UPDATE crove_finance.stock_item SET name = 'y', trade = 'other', active = false WHERE org_id = $1 AND id = $2", [o.orgId, id])).rowCount)).toBe(1);
    expect(await asRole(o.viewer, async (c) => (await c.query("UPDATE crove_finance.stock_item SET name = 'y' WHERE org_id = $1 AND id = $2", [o.orgId, id])).rowCount)).toBe(0);
    for (const column of ["code = 'ZZ'", "kind = 'goods'", `legal_entity_id = '${randomUUID()}'`, "created_at = now()"]) {
      await expect(asRole(o.owner, (c) => c.query(`UPDATE crove_finance.stock_item SET ${column} WHERE org_id = $1 AND id = $2`, [o.orgId, id]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    }
    await expect(asRole(o.owner, (c) => c.query('DELETE FROM crove_finance.stock_item WHERE org_id = $1 AND id = $2', [o.orgId, id]))).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    // An alias is inserted and deleted, never updated.
    const aliasInsert = "INSERT INTO crove_finance.stock_alias (org_id, item_id, alias_key) VALUES ($1, $2, 'sql alias')";
    await expect(asRole(o.viewer, (c) => c.query(aliasInsert, [o.orgId, id]))).rejects.toMatchObject({ code: '42501' });
    expect(await asRole(o.member, async (c) => (await c.query(aliasInsert, [o.orgId, id])).rowCount)).toBe(1);
    await expect(asRole(o.member, async (c) => { await c.query(aliasInsert, [o.orgId, id]); return c.query("UPDATE crove_finance.stock_alias SET alias_key = 'z' WHERE org_id = $1", [o.orgId]); })).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
  });
});

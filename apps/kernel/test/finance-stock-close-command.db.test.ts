// SPDX-License-Identifier: AGPL-3.0-only
// The close of a month of stock (#2513, ADR-0045 point 2) on a real PostgreSQL 17: a member asks for it through kernel.proposal.request, the kernel builds the cost of goods sold of the month
// from the stock moves (Dr 632 / Cr the stock account), an owner or an admin approves it, and approving posts the voucher and stores the month and its items in one transaction. A month with
// no cost closes at once with no entry. Refused: a month not over, one closed already, one after a month that still holds moves, an item below zero, a proposal the moves changed since.
// The database keeps a month from existing without its voucher and from taking a move dated in it, whatever the source of the move.
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
  outQuantity: string;
  outValue: string;
  closingQuantity: string;
  closingValue: string;
}

suite('the stock month close command (#2513)', () => {
  const dbName = `crove_test_stockclosecmd_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const asMfa = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, sessionId: randomUUID(), mfaAt: Math.floor(Date.now() / 1000) });

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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@closecmd.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Kho ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]));
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asMfa(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const makeItem = (o: Org, code: string) =>
    execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code, name: `Hàng ${code}`, unit: 'cái', stockAccount: '156', trade: 'goods' }).then((r) => r.id);
  const move = (o: Org, item: string, date: string, quantity: string) =>
    rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [o.orgId, item, date, quantity]).then((r) => r[0]?.id as string);
  const entityOf = async (o: Org) => (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [o.orgId]))[0]?.id ?? '';
  // What an earlier close left: a closed month holding `item` with five on hand worth 500, nothing out (the rows are written by the database owner).
  async function seedClosed(o: Org, month: string, item: string, closing: [string, string] = ['5', '500']) {
    const [period] = await rows<{ id: string }>('INSERT INTO crove_finance.stock_period (org_id, legal_entity_id, period_month, total_cost) VALUES ($1, $2, $3, 0) RETURNING id', [o.orgId, await entityOf(o), `${month}-01`]);
    await rows(
      `INSERT INTO crove_finance.stock_period_item (org_id, period_id, item_id, opening_quantity, opening_value, in_quantity, in_value, out_quantity, out_value, closing_quantity, closing_value, unit_cost)
       VALUES ($1, $2, $3, 0, 0, $4, $5, 0, 0, $4, $5, 100)`,
      [o.orgId, period?.id, item, ...closing],
    );
  }
  const ask = (o: Org, month: string, user = o.member) =>
    rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.stock.close_period', input: { month } }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  async function approve(o: Org, proposalId: string, user = o.owner) {
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
    return rt.execute<{ journalEntryId: string; voucherId: string; code: string; periodId: string }>('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(user), orgId: o.orgId });
  }
  const report = (o: Org, month: string) => query<Row[]>(o, 'finance.stock.report', { month });
  const currentMonth = () => {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  };

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

  it('closes a month through its proposal: Dr 632 / Cr 156 for what left at the average, the month stored, the moves of the month locked, the reversal dated today', async () => {
    const o = await org();
    const item = await makeItem(o, 'A');
    // August was closed with five on hand worth 500; in September two leave, at the average of 100 each.
    await move(o, item, '2026-08-05', '5');
    await seedClosed(o, '2026-08', item);
    const outMove = await move(o, item, '2026-09-10', '-2');
    const { proposalId } = await ask(o, '2026-09');
    // Every ledger proposal needs a person other than the author to approve it: a viewer cannot, the owner can.
    await expect(approve(o, proposalId, o.viewer)).rejects.toMatchObject({ status: 403 });
    const posted = await approve(o, proposalId);
    expect(posted).toMatchObject({ voucherId: expect.any(String), journalEntryId: expect.any(String), periodId: expect.any(String) });
    const lines = await rows<{ account_code: string; debit: string; credit: string }>(
      'SELECT account_code, debit::bigint::text AS debit, credit::bigint::text AS credit FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY account_code',
      [o.orgId, posted.journalEntryId],
    );
    expect(lines).toEqual([
      { account_code: '156', debit: '0', credit: '200' },
      { account_code: '632', debit: '200', credit: '0' },
    ]);
    const [entry] = await rows<{ entry_date: string }>('SELECT entry_date::text AS entry_date FROM crove_finance.journal_entry WHERE org_id = $1 AND id = $2', [o.orgId, posted.journalEntryId]);
    expect(entry?.entry_date).toBe('2026-09-30');
    const [voucher] = await rows<{ stock_closing_month: string; proposal_id: string }>('SELECT stock_closing_month::text AS stock_closing_month, proposal_id FROM crove_finance.journal_voucher WHERE org_id = $1 AND id = $2', [o.orgId, posted.voucherId]);
    expect(voucher).toEqual({ stock_closing_month: '2026-09-01', proposal_id: proposalId });
    // The month is stored with its voucher and its cost; every role reads it.
    expect(await query<Array<{ month: string; totalCost: string; voucherId: string | null }>>(o, 'finance.stock.periods', {}, o.viewer)).toEqual([
      expect.objectContaining({ month: '2026-09', totalCost: '200', voucherId: posted.voucherId }),
      expect.objectContaining({ month: '2026-08', totalCost: '0', voucherId: null }),
    ]);
    expect((await report(o, '2026-09')).find((r) => r.itemId === item)).toMatchObject({ closed: true, outQuantity: '2', outValue: '200', closingQuantity: '3', closingValue: '300' });
    // The month is closed once.
    await expect(ask(o, '2026-09')).rejects.toMatchObject({ code: 'STOCK_CLOSE_DONE' });
    await expect(execute(o, 'finance.stock.close_empty', { month: '2026-09' })).rejects.toMatchObject({ code: 'STOCK_CLOSE_DONE' });
    // The entry that posted the cost is not reversed: the month stays closed with its cost.
    await expect(
      rt.execute('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: posted.journalEntryId, entryDate: '2026-10-15', reason: 'Ghi nhầm' } }, { actor: asUser(o.member), orgId: o.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'STOCK_CLOSE_ENTRY' });

    // The database keeps a move of any source out of a closed month, and before one.
    const entity = await entityOf(o);
    const insert = (columns: string, values: string) => rows(`INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, ${columns}) VALUES ($1, $2, '2026-09-20', ${values})`, [o.orgId, item]);
    await expect(insert('quantity, source_type', "1, 'manual'")).rejects.toThrow(/STOCK_PERIOD_CLOSED/);
    await expect(insert('quantity, source_type, reverses_move_id', `2, 'reversal', '${outMove}'`)).rejects.toThrow(/STOCK_PERIOD_CLOSED/);
    await expect(insert('quantity, source_type, document_id, line_no, line_attempt', `-1, 'document_line', '${randomUUID()}', 1, 1`)).rejects.toThrow(/STOCK_PERIOD_CLOSED/);
    await expect(insert('quantity, source_type, order_line_id, order_move', `-1, 'order_line', '${randomUUID()}', 'ship'`)).rejects.toThrow(/STOCK_PERIOD_CLOSED/);
    await expect(rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, '2026-07-01', 1, 'manual')", [o.orgId, item])).rejects.toThrow(/STOCK_PERIOD_CLOSED/);
    // The command that corrects a move writes the reversal today, in the open month, never back in the closed one.
    const reversed = await execute<{ id: string }>(o, 'finance.stock_move.reverse', { moveId: outMove }, o.member);
    const [reversal] = await rows<{ move_date: string; today: string }>('SELECT move_date::text AS move_date, current_date::text AS today FROM crove_finance.stock_move WHERE org_id = $1 AND id = $2', [o.orgId, reversed.id]);
    expect(reversal?.move_date).toBe(reversal?.today);

    // A month never exists without the voucher that posted its cost (checked at commit): the month of another voucher, a cost with none, and what went out with none.
    const closeMonthOf = async (script: (c: pg.Client, periodId: string) => Promise<void>, voucherId: string | null, cost: string) => {
      const c = new pg.Client({ connectionString: adminUrl });
      await c.connect();
      try {
        await c.query('BEGIN');
        const period = await c.query<{ id: string }>('INSERT INTO crove_finance.stock_period (org_id, legal_entity_id, period_month, voucher_id, total_cost) VALUES ($1, $2, $3, $4, $5) RETURNING id', [
          o.orgId,
          entity,
          '2026-10-01',
          voucherId,
          cost,
        ]);
        await script(c, period.rows[0]?.id as string);
        await c.query('COMMIT');
      } finally {
        await c.end();
      }
    };
    const nothing = async () => {};
    await expect(closeMonthOf(nothing, posted.voucherId, '200')).rejects.toThrow(/STOCK_PERIOD_VOUCHER/);
    await expect(
      closeMonthOf(
        async (c, periodId) => {
          await c.query('INSERT INTO crove_finance.stock_period_item (org_id, period_id, item_id, out_quantity, out_value) VALUES ($1, $2, $3, 1, 10)', [o.orgId, periodId, item]);
        },
        null,
        '0.0000',
      ),
    ).rejects.toThrow(/STOCK_PERIOD_VOUCHER/);
    // Both refused ones rolled back; a month with no cost and no voucher is stored.
    await expect(closeMonthOf(nothing, null, '0.0000')).resolves.toBeUndefined();
  });

  it('refuses a close that cannot be made: a month not over, a month after one that still holds moves, an item below zero, a month with nothing to post', async () => {
    const o = await org();
    const item = await makeItem(o, 'B');
    await expect(ask(o, currentMonth())).rejects.toMatchObject({ code: 'STOCK_CLOSE_NOT_ENDED' });
    // June holds a move and is not closed: August cannot close before it.
    await move(o, item, '2026-06-10', '3');
    await expect(ask(o, '2026-08')).rejects.toMatchObject({ code: 'STOCK_CLOSE_ORDER' });
    // A sale entered before its purchase leaves an item below zero at the end of the month.
    const negative = await makeItem(o, 'NEG');
    await move(o, negative, '2026-06-15', '-4');
    await expect(ask(o, '2026-06')).rejects.toMatchObject({ code: 'STOCK_CLOSE_NEGATIVE' });
    await expect(execute(o, 'finance.stock.close_empty', { month: '2026-06' })).rejects.toMatchObject({ code: 'STOCK_CLOSE_NEGATIVE' });
    // Without a cost there is no entry to approve: asking is refused and the owner closes the month at once; a member may not, and a viewer neither.
    const quiet = await org();
    const goods = await makeItem(quiet, 'Q');
    await move(quiet, goods, '2026-06-10', '5');
    await expect(ask(quiet, '2026-06')).rejects.toMatchObject({ code: 'STOCK_CLOSE_NO_COST' });
    await expect(execute(quiet, 'finance.stock.close_empty', { month: '2026-06' }, quiet.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(execute(quiet, 'finance.stock.close_empty', { month: '2026-06' }, quiet.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await execute(quiet, 'finance.stock.close_empty', { month: '2026-06' })).toMatchObject({ periodId: expect.any(String), items: 1 });
    expect(await query<Array<{ month: string; totalCost: string; voucherId: string | null }>>(quiet, 'finance.stock.periods', {})).toEqual([expect.objectContaining({ month: '2026-06', totalCost: '0', voucherId: null })]);
    await expect(move(quiet, goods, '2026-06-20', '1')).rejects.toThrow(/STOCK_PERIOD_CLOSED/);
    // A month with a cost does not close without its approval.
    const costly = await org();
    const widget = await makeItem(costly, 'C');
    await move(costly, widget, '2026-08-05', '5');
    await seedClosed(costly, '2026-08', widget);
    await move(costly, widget, '2026-09-10', '-2');
    await expect(execute(costly, 'finance.stock.close_empty', { month: '2026-09' })).rejects.toMatchObject({ code: 'STOCK_CLOSE_HAS_COST' });
  });

  it('refuses a proposal the moves changed since it was asked for, and a month closed in between', async () => {
    const o = await org();
    const item = await makeItem(o, 'D');
    await move(o, item, '2026-08-05', '5');
    await seedClosed(o, '2026-08', item);
    await move(o, item, '2026-09-10', '-2');
    const stale = await ask(o, '2026-09');
    // One more unit leaves in September after the proposal: its figures no longer match.
    await move(o, item, '2026-09-12', '-1');
    await expect(approve(o, stale.proposalId)).rejects.toMatchObject({ code: 'STOCK_CLOSE_STALE', status: 409 });
    // A fresh proposal for the same month is made from the moves as they read now and goes through; the cost is three at the average.
    const fresh = await ask(o, '2026-09');
    const posted = await approve(o, fresh.proposalId);
    const [total] = await rows<{ cost: string }>('SELECT total_cost::bigint::text AS cost FROM crove_finance.stock_period WHERE org_id = $1 AND voucher_id = $2', [o.orgId, posted.voucherId]);
    expect(total?.cost).toBe('300');
  });
});

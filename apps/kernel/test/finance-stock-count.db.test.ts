// SPDX-License-Identifier: AGPL-3.0-only
// The count of stock (kiểm kê, #2513 part b) on a real PostgreSQL 17: a member counts the goods on a day, the server works out the difference from the books and prices it, a member asks to
// confirm it through kernel.proposal.request, an owner or an admin approves, and approving posts one voucher (a shortage within the norm to 632, beyond it to 1381, a surplus to 3381) and writes
// one adjustment move per item that differs, with its value, in one transaction. Refused: a day not come or in a closed month, an item with no cost, a proposal the books changed since, a
// second confirmation. The database keeps a count from being confirmed without its voucher, an adjustment from a count that is not confirmed, and a move out of a closed month.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { StockCount } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Row {
  itemId: string;
  closingQuantity: string;
  closingValue: string;
}

suite('the count of stock (#2513, part b)', () => {
  const dbName = `crove_test_stockcount_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@count.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Kiểm kê ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]));
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.member) => rt.execute<T>(name, input, { actor: asMfa(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.member) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const makeItem = (o: Org, code: string) =>
    execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code, name: `Hàng ${code}`, unit: 'cái', stockAccount: '156', trade: 'goods' }).then((r) => r.id);
  const move = (o: Org, item: string, date: string, quantity: string) =>
    rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [o.orgId, item, date, quantity]).then((r) => r[0]?.id as string);
  const entityOf = async (o: Org) => (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [o.orgId]))[0]?.id ?? '';
  // What an earlier close left: a closed month holding `item` with five on hand worth 500 (the rows are written by the database owner).
  async function seedClosed(o: Org, month: string, item: string) {
    const [period] = await rows<{ id: string }>('INSERT INTO crove_finance.stock_period (org_id, legal_entity_id, period_month, total_cost) VALUES ($1, $2, $3, 0) RETURNING id', [o.orgId, await entityOf(o), `${month}-01`]);
    await rows(
      `INSERT INTO crove_finance.stock_period_item (org_id, period_id, item_id, opening_quantity, opening_value, in_quantity, in_value, out_quantity, out_value, closing_quantity, closing_value, unit_cost)
       VALUES ($1, $2, $3, 0, 0, 5, 500, 0, 0, 5, 500, 100)`,
      [o.orgId, period?.id, item],
    );
  }
  type Line = { itemId: string; countedQuantity: string; unitCost?: string };
  const count = (o: Org, countDate: string, lines: Line[], extra: Record<string, unknown> = {}, user = o.member) =>
    execute<{ id: string }>(o, 'finance.stock_count.create', { countDate, lossNormPercent: '10', lines, ...extra }, user).then((r) => r.id);
  const ask = (o: Org, countId: string, user = o.member) =>
    rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.stock.count_confirm', input: { countId } }, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  async function approve(o: Org, proposalId: string, user = o.owner) {
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
    return rt.execute<{ journalEntryId: string; voucherId: string; code: string; countId: string }>('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(user), orgId: o.orgId });
  }
  const counts = (o: Org, user = o.member) => query<StockCount[]>(o, 'finance.stock_count.list', {}, user);
  const onHand = async (o: Org, itemId: string) => (await query<Array<{ id: string; onHand: string }>>(o, 'finance.stock_item.list', {})).find((i) => i.id === itemId)?.onHand;

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

  it('confirms a count through its proposal: the voucher splits the shortage at the norm and books the surplus, the adjustments carry their value, the stock follows', async () => {
    const o = await org();
    const a = await makeItem(o, 'A');
    const b = await makeItem(o, 'B');
    // August was closed with five of A on hand worth 500; in September one of A is sold, so the books hold four of A on the 30th, at an average of 100.
    await move(o, a, '2026-08-05', '5');
    await seedClosed(o, '2026-08', a);
    await move(o, a, '2026-09-10', '-1');
    // Two of A are counted (two missing, worth 200; a norm of 10 percent allows 0.4 of four, worth 40) and three of B, which the books never held, at a cost typed for it (a surplus of 150).
    const countId = await count(o, '2026-09-30', [
      { itemId: a, countedQuantity: '2' },
      { itemId: b, countedQuantity: '3', unitCost: '50' },
    ]);
    const [draft] = await counts(o);
    expect(draft).toMatchObject({ id: countId, status: 'draft', countDate: '2026-09-30', lossNormPercent: '10', voucherId: null });
    expect(draft?.lines).toEqual([
      expect.objectContaining({ itemId: a, bookQuantity: '4', countedQuantity: '2', difference: '-2', unitCost: '100', value: '-200', withinNorm: '40' }),
      expect.objectContaining({ itemId: b, bookQuantity: '0', countedQuantity: '3', difference: '3', unitCost: '50', value: '150' }),
    ]);
    // Nothing moved yet.
    expect(await onHand(o, a)).toBe('4');
    const { proposalId } = await ask(o, countId);
    // A viewer cannot approve; the owner can.
    await expect(approve(o, proposalId, o.viewer)).rejects.toMatchObject({ status: 403 });
    const posted = await approve(o, proposalId);
    expect(posted).toMatchObject({ voucherId: expect.any(String), journalEntryId: expect.any(String), countId });
    const lines = await rows<{ account_code: string; debit: string; credit: string }>(
      'SELECT account_code, debit::bigint::text AS debit, credit::bigint::text AS credit FROM crove_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY account_code, credit',
      [o.orgId, posted.journalEntryId],
    );
    expect(lines).toEqual([
      { account_code: '1381', debit: '160', credit: '0' },
      { account_code: '156', debit: '150', credit: '0' },
      { account_code: '156', debit: '0', credit: '200' },
      { account_code: '3381', debit: '0', credit: '150' },
      { account_code: '632', debit: '40', credit: '0' },
    ]);
    const [entry] = await rows<{ entry_date: string }>('SELECT entry_date::text AS entry_date FROM crove_finance.journal_entry WHERE org_id = $1 AND id = $2', [o.orgId, posted.journalEntryId]);
    expect(entry?.entry_date).toBe('2026-09-30');
    const [voucher] = await rows<{ stock_count_id: string; proposal_id: string }>('SELECT stock_count_id, proposal_id FROM crove_finance.journal_voucher WHERE org_id = $1 AND id = $2', [o.orgId, posted.voucherId]);
    expect(voucher).toEqual({ stock_count_id: countId, proposal_id: proposalId });
    // The adjustments: one per item that differs, dated the day of the count, with their value signed like their quantity.
    const adjustments = await rows<{ item_id: string; move_date: string; quantity: string; amount: string }>(
      "SELECT item_id, move_date::text AS move_date, quantity::bigint::text AS quantity, amount::bigint::text AS amount FROM crove_finance.stock_move WHERE org_id = $1 AND source_type = 'count' ORDER BY quantity",
      [o.orgId],
    );
    expect(adjustments).toEqual([
      { item_id: a, move_date: '2026-09-30', quantity: '-2', amount: '-200' },
      { item_id: b, move_date: '2026-09-30', quantity: '3', amount: '150' },
    ]);
    expect(await onHand(o, a)).toBe('2');
    expect(await onHand(o, b)).toBe('3');
    // The count is final and shows what its adjustments made; the month's figures count them as value out and in, not as a stock-out priced at the average.
    const [confirmed] = await counts(o, o.viewer);
    expect(confirmed).toMatchObject({ status: 'confirmed', voucherId: posted.voucherId, confirmedAt: expect.any(String) });
    expect(confirmed?.lines.map((l) => [l.code, l.bookQuantity, l.countedQuantity, l.difference, l.value])).toEqual([
      ['A', '4', '2', '-2', '-200'],
      ['B', '0', '3', '3', '150'],
    ]);
    const september = await query<Row[]>(o, 'finance.stock.report', { month: '2026-09' });
    expect(september.find((r) => r.itemId === a)).toMatchObject({ closingQuantity: '2', closingValue: '200' });
    expect(september.find((r) => r.itemId === b)).toMatchObject({ closingQuantity: '3', closingValue: '150' });
    // Confirmed once, and an adjustment is not reversed: the count that was wrong is put right by a new one.
    await expect(ask(o, countId)).rejects.toMatchObject({ code: 'STOCK_COUNT_NOT_DRAFT' });
    const [adjustment] = await rows<{ id: string }>("SELECT id FROM crove_finance.stock_move WHERE org_id = $1 AND source_type = 'count' AND item_id = $2", [o.orgId, a]);
    await expect(execute(o, 'finance.stock_move.reverse', { moveId: adjustment?.id })).rejects.toMatchObject({ code: 'STOCK_MOVE_COUNT' });
    await expect(
      rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, reverses_move_id) VALUES ($1, $2, '2026-10-02', 2, 'reversal', $3)", [o.orgId, a, adjustment?.id]),
    ).rejects.toThrow(/STOCK_MOVE_COUNT/);
  });

  it('refuses a count that cannot be made or confirmed: a day not come, a closed month, a duplicate item, no cost, no difference, a proposal the books changed', async () => {
    const o = await org();
    const item = await makeItem(o, 'C');
    await move(o, item, '2026-08-05', '5');
    await seedClosed(o, '2026-08', item);
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await expect(count(o, future, [{ itemId: item, countedQuantity: '1' }])).rejects.toMatchObject({ code: 'STOCK_COUNT_FUTURE' });
    await expect(count(o, '2026-08-20', [{ itemId: item, countedQuantity: '1' }])).rejects.toMatchObject({ code: 'STOCK_COUNT_CLOSED' });
    await expect(count(o, '2026-09-10', [{ itemId: item, countedQuantity: '1' }, { itemId: item, countedQuantity: '2' }])).rejects.toMatchObject({ code: 'STOCK_COUNT_DUPLICATE_ITEM' });
    await expect(count(o, '2026-09-10', [{ itemId: item, countedQuantity: '1' }], {}, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // An item the books hold nothing of and have no cost for needs a cost typed: the proposal is refused and the confirmation without one too.
    const found = await makeItem(o, 'FOUND');
    const unpriced = await count(o, '2026-09-10', [{ itemId: found, countedQuantity: '3' }]);
    await expect(ask(o, unpriced)).rejects.toMatchObject({ code: 'STOCK_COUNT_UNPRICED' });
    await expect(execute(o, 'finance.stock_count.confirm_empty', { countId: unpriced })).rejects.toMatchObject({ code: 'STOCK_COUNT_HAS_DIFFERENCE' });
    await execute(o, 'finance.stock_count.cancel', { countId: unpriced });
    await expect(execute(o, 'finance.stock_count.cancel', { countId: unpriced })).rejects.toMatchObject({ code: 'STOCK_COUNT_NOT_DRAFT' });
    await expect(ask(o, unpriced)).rejects.toMatchObject({ code: 'STOCK_COUNT_NOT_DRAFT' });
    // A count that matches the books has no entry to approve and is confirmed at once, with no voucher and no move.
    const same = await count(o, '2026-09-10', [{ itemId: item, countedQuantity: '5' }]);
    await expect(ask(o, same)).rejects.toMatchObject({ code: 'STOCK_COUNT_NO_DIFFERENCE' });
    expect(await execute(o, 'finance.stock_count.confirm_empty', { countId: same })).toEqual({ id: same });
    const [done] = await counts(o);
    expect(done).toMatchObject({ id: same, status: 'confirmed', voucherId: null });
    expect(await rows("SELECT 1 FROM crove_finance.stock_move WHERE org_id = $1 AND source_type = 'count'", [o.orgId])).toEqual([]);
    // A proposal is refused when a move dated before the day of the count was written after it was asked for: the book quantity it was built on is gone.
    const stale = await count(o, '2026-09-20', [{ itemId: item, countedQuantity: '4' }]);
    const request = await ask(o, stale);
    await move(o, item, '2026-09-15', '-1');
    await expect(approve(o, request.proposalId)).rejects.toMatchObject({ code: 'STOCK_COUNT_STALE', status: 409 });
    // The count is still a draft: asked for again, the difference is nil now (four counted, four on the books) and it is confirmed at once.
    await expect(ask(o, stale)).rejects.toMatchObject({ code: 'STOCK_COUNT_NO_DIFFERENCE' });
  });

  it('keeps the table to its rules: a count is final once confirmed, an adjustment belongs to a confirmed count, a confirmed count has its voucher, a closed month takes no adjustment', async () => {
    const o = await org();
    const item = await makeItem(o, 'D');
    await move(o, item, '2026-08-05', '5');
    await seedClosed(o, '2026-08', item);
    const countId = await count(o, '2026-09-10', [{ itemId: item, countedQuantity: '3' }]);
    const [line] = await rows<{ id: string }>('SELECT id FROM crove_finance.stock_count_line WHERE org_id = $1 AND count_id = $2', [o.orgId, countId]);
    // An adjustment of a count that is a draft is refused.
    await expect(
      rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, count_line_id, amount) VALUES ($1, $2, '2026-09-10', -2, 'count', $3, -200)", [o.orgId, item, line?.id]),
    ).rejects.toThrow(/STOCK_COUNT_MOVE/);
    // A count is confirmed with its voucher or not at all: a confirmation that leaves an adjustment with no voucher fails at commit.
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("UPDATE crove_finance.stock_count SET status = 'confirmed', confirmed_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, countId]);
      await c.query("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, count_line_id, amount) VALUES ($1, $2, '2026-09-10', -2, 'count', $3, -200)", [o.orgId, item, line?.id]);
      await expect(c.query('COMMIT')).rejects.toThrow(/STOCK_COUNT_VOUCHER/);
    } finally {
      await c.end();
    }
    // The failed confirmation left nothing: the count is still a draft, and its line is still the person's to change while it is.
    expect((await rows<{ status: string }>('SELECT status FROM crove_finance.stock_count WHERE org_id = $1 AND id = $2', [o.orgId, countId]))[0]?.status).toBe('draft');
    await rows('UPDATE crove_finance.stock_count_line SET counted_quantity = 4 WHERE org_id = $1 AND id = $2', [o.orgId, line?.id]);
    // A cancelled or confirmed count and its lines are frozen.
    await execute(o, 'finance.stock_count.cancel', { countId });
    await expect(rows("UPDATE crove_finance.stock_count SET note = 'x' WHERE org_id = $1 AND id = $2", [o.orgId, countId])).rejects.toThrow(/STOCK_COUNT_FROZEN/);
    await expect(rows('UPDATE crove_finance.stock_count_line SET counted_quantity = 1 WHERE org_id = $1 AND id = $2', [o.orgId, line?.id])).rejects.toThrow(/STOCK_COUNT_FROZEN/);
    // A closed month takes no adjustment either: the stock guard is the same for every source.
    const entity = await entityOf(o);
    await rows('INSERT INTO crove_finance.stock_period (org_id, legal_entity_id, period_month, total_cost) VALUES ($1, $2, $3, 0)', [o.orgId, entity, '2026-09-01']);
    await expect(
      rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type, count_line_id, amount) VALUES ($1, $2, '2026-09-20', 1, 'count', $3, 100)", [o.orgId, item, randomUUID()]),
    ).rejects.toThrow(/STOCK_PERIOD_CLOSED/);
  });
});

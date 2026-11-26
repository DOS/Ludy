// SPDX-License-Identifier: AGPL-3.0-only
// The count of stock (kiểm kê, #2513 part b) on a real PostgreSQL 17: a member counts the goods on a day, the server works out the difference from the books and prices it, a member asks to
// confirm it through kernel.proposal.request, an owner or an admin approves, and approving posts one voucher (a shortage within the norm to 632, beyond it to 1381, a surplus to 3381) and writes
// one adjustment move per item that differs, with its value, in one transaction. Refused: a day not come or in a closed month, an item with no cost, a proposal the books changed since, a
// second confirmation. The database keeps a count from being confirmed without its voucher, an adjustment from a count that is not confirmed, and a move out of a closed month.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { StockCount } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { enterUser } from './context-token.ts';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

interface Row {
  itemId: string;
  closingQuantity: string;
  closingValue: string;
}

suite('the count of stock (#2513, part b)', () => {
  const dbName = `ludy_test_stockcount_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    await admin((c) => c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]));
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.member) => rt.execute<T>(name, input, { actor: asMfa(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.member) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const makeItem = (o: Org, code: string) =>
    execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code, name: `Hàng ${code}`, unit: 'cái', stockAccount: '156', trade: 'goods' }).then((r) => r.id);
  const move = (o: Org, item: string, date: string, quantity: string) =>
    rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [o.orgId, item, date, quantity]).then((r) => r[0]?.id as string);
  const entityOf = async (o: Org) => (await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [o.orgId]))[0]?.id ?? '';
  // What an earlier close left: a closed month holding `item` with five on hand worth 500 (the rows are written by the database owner).
  async function seedClosed(o: Org, month: string, item: string) {
    const [period] = await rows<{ id: string }>('INSERT INTO ludy_finance.stock_period (org_id, legal_entity_id, period_month, total_cost) VALUES ($1, $2, $3, 0) RETURNING id', [o.orgId, await entityOf(o), `${month}-01`]);
    await rows(
      `INSERT INTO ludy_finance.stock_period_item (org_id, period_id, item_id, opening_quantity, opening_value, in_quantity, in_value, out_quantity, out_value, closing_quantity, closing_value, unit_cost)
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
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
    // A cost typed for A, which the books have a cost for, is ignored: the average prices the difference.
    const countId = await count(o, '2026-09-30', [
      { itemId: a, countedQuantity: '2', unitCost: '1' },
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
      'SELECT account_code, debit::bigint::text AS debit, credit::bigint::text AS credit FROM ludy_finance.journal_line WHERE org_id = $1 AND entry_id = $2 ORDER BY account_code, credit',
      [o.orgId, posted.journalEntryId],
    );
    expect(lines).toEqual([
      { account_code: '1381', debit: '160', credit: '0' },
      { account_code: '156', debit: '150', credit: '0' },
      { account_code: '156', debit: '0', credit: '200' },
      { account_code: '3381', debit: '0', credit: '150' },
      { account_code: '632', debit: '40', credit: '0' },
    ]);
    const [entry] = await rows<{ entry_date: string }>('SELECT entry_date::text AS entry_date FROM ludy_finance.journal_entry WHERE org_id = $1 AND id = $2', [o.orgId, posted.journalEntryId]);
    expect(entry?.entry_date).toBe('2026-09-30');
    const [voucher] = await rows<{ stock_count_id: string; proposal_id: string }>('SELECT stock_count_id, proposal_id FROM ludy_finance.journal_voucher WHERE org_id = $1 AND id = $2', [o.orgId, posted.voucherId]);
    expect(voucher).toEqual({ stock_count_id: countId, proposal_id: proposalId });
    // The adjustments: one per item that differs, dated the day of the count, with their value signed like their quantity.
    const adjustments = await rows<{ item_id: string; move_date: string; quantity: string; amount: string }>(
      "SELECT item_id, move_date::text AS move_date, quantity::bigint::text AS quantity, amount::bigint::text AS amount FROM ludy_finance.stock_move WHERE org_id = $1 AND source_type = 'count' ORDER BY quantity",
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
    const [adjustment] = await rows<{ id: string }>("SELECT id FROM ludy_finance.stock_move WHERE org_id = $1 AND source_type = 'count' AND item_id = $2", [o.orgId, a]);
    await expect(execute(o, 'finance.stock_move.reverse', { moveId: adjustment?.id })).rejects.toMatchObject({ code: 'STOCK_MOVE_COUNT' });
    await expect(
      rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type, reverses_move_id) VALUES ($1, $2, '2026-10-02', 2, 'reversal', $3)", [o.orgId, a, adjustment?.id]),
    ).rejects.toThrow(/STOCK_MOVE_COUNT/);
  });

  it('keeps a confirmed count tied to its entry: its entry is not reversed, and an adjustment written later without the voucher behind it fails at commit', async () => {
    const o = await org();
    const a = await makeItem(o, 'E');
    const c = await makeItem(o, 'F');
    await move(o, a, '2026-08-05', '5');
    await seedClosed(o, '2026-08', a);
    await move(o, a, '2026-09-10', '-1');
    await move(o, c, '2026-09-05', '2');
    // A is one short of the books (four on them, three counted); F matches them, so its line makes no adjustment.
    const countId = await count(o, '2026-09-30', [
      { itemId: a, countedQuantity: '3' },
      { itemId: c, countedQuantity: '2' },
    ]);
    const posted = await approve(o, (await ask(o, countId)).proposalId);
    // The entry that posted the difference is not reversed, since the adjustments never are.
    await expect(
      rt.execute('kernel.proposal.request', { command: 'finance.journal.reverse', input: { entryId: posted.journalEntryId, entryDate: '2026-10-15', reason: 'Ghi nhầm' } }, { actor: asUser(o.member), orgId: o.orgId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ code: 'STOCK_COUNT_ENTRY' });
    // An adjustment of the line that made none, written afterwards by a raw session, is not covered by the voucher: it fails at its own commit.
    const [line] = await rows<{ id: string }>('SELECT id FROM ludy_finance.stock_count_line WHERE org_id = $1 AND count_id = $2 AND item_id = $3', [o.orgId, countId, c]);
    await expect(
      rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type, count_line_id, amount) VALUES ($1, $2, '2026-09-30', 1000, 'count', $3, 1000000)", [o.orgId, c, line?.id]),
    ).rejects.toThrow(/STOCK_COUNT_VOUCHER/);
    expect(await onHand(o, c)).toBe('2');
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
    expect(await rows("SELECT 1 FROM ludy_finance.stock_move WHERE org_id = $1 AND source_type = 'count'", [o.orgId])).toEqual([]);
    // A proposal is refused when a move dated before the day of the count was written after it was asked for: the book quantity it was built on is gone.
    const stale = await count(o, '2026-09-20', [{ itemId: item, countedQuantity: '4' }]);
    const request = await ask(o, stale);
    await move(o, item, '2026-09-15', '-1');
    await expect(approve(o, request.proposalId)).rejects.toMatchObject({ code: 'STOCK_COUNT_STALE', status: 409 });
    // The count is still a draft: asked for again, the difference is nil now (four counted, four on the books) and it is confirmed at once.
    await expect(ask(o, stale)).rejects.toMatchObject({ code: 'STOCK_COUNT_NO_DIFFERENCE' });
  });

  it('keeps the table to its rules: a count is final once confirmed, an adjustment belongs to a confirmed count, an adjustment has its voucher behind it, a closed month takes no adjustment', async () => {
    const o = await org();
    const item = await makeItem(o, 'D');
    await move(o, item, '2026-08-05', '5');
    await seedClosed(o, '2026-08', item);
    const countId = await count(o, '2026-09-10', [{ itemId: item, countedQuantity: '3' }]);
    const [line] = await rows<{ id: string }>('SELECT id FROM ludy_finance.stock_count_line WHERE org_id = $1 AND count_id = $2', [o.orgId, countId]);
    // An adjustment of a count that is a draft is refused.
    await expect(
      rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type, count_line_id, amount) VALUES ($1, $2, '2026-09-10', -2, 'count', $3, -200)", [o.orgId, item, line?.id]),
    ).rejects.toThrow(/STOCK_COUNT_MOVE/);
    // A count confirmed with no voucher takes no adjustment: the guard wants the voucher that posted the difference behind every one.
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
      await c.query('BEGIN');
      await c.query("UPDATE ludy_finance.stock_count SET status = 'confirmed', confirmed_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, countId]);
      await expect(
        c.query("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type, count_line_id, amount) VALUES ($1, $2, '2026-09-10', -2, 'count', $3, -200)", [o.orgId, item, line?.id]),
      ).rejects.toThrow(/STOCK_COUNT_MOVE/);
      await c.query('ROLLBACK');
    } finally {
      await c.end();
    }
    // The failed confirmation left nothing: the count is still a draft, and a raw tenant role has no UPDATE privilege on its line or header note (#2682 N3).
    expect((await rows<{ status: string }>('SELECT status FROM ludy_finance.stock_count WHERE org_id = $1 AND id = $2', [o.orgId, countId]))[0]?.status).toBe('draft');
    const asMember = async (fn: (c: pg.PoolClient) => Promise<unknown>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await enterUser(client, o.member, o.orgId);
        return await fn(client);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    await expect(
      asMember((client) => client.query('UPDATE ludy_finance.stock_count_line SET counted_quantity = 4 WHERE org_id = $1 AND id = $2', [o.orgId, line?.id])),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    await expect(
      asMember((client) => client.query("UPDATE ludy_finance.stock_count SET note = 'x' WHERE org_id = $1 AND id = $2", [o.orgId, countId])),
    ).rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied') });
    // A cancelled or confirmed count and its lines are frozen.
    const otherItem = await makeItem(o, 'D2');
    await execute(o, 'finance.stock_count.cancel', { countId });
    await expect(rows("UPDATE ludy_finance.stock_count SET status = 'draft' WHERE org_id = $1 AND id = $2", [o.orgId, countId])).rejects.toThrow(/STOCK_COUNT_FROZEN/);
    await expect(
      rows('INSERT INTO ludy_finance.stock_count_line (org_id, count_id, item_id, counted_quantity) VALUES ($1, $2, $3, 1)', [o.orgId, countId, otherItem]),
    ).rejects.toThrow(/STOCK_COUNT_FROZEN/);
    // A closed month takes no adjustment either: the stock guard is the same for every source.
    const entity = await entityOf(o);
    await rows('INSERT INTO ludy_finance.stock_period (org_id, legal_entity_id, period_month, total_cost) VALUES ($1, $2, $3, 0)', [o.orgId, entity, '2026-09-01']);
    await expect(
      rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type, count_line_id, amount) VALUES ($1, $2, '2026-09-20', 1, 'count', $3, 100)", [o.orgId, item, randomUUID()]),
    ).rejects.toThrow(/STOCK_PERIOD_CLOSED/);
  });

  it('enforces the confirmed count date floor on late non-count moves (#2682 N1)', async () => {
    const o = await org();
    const item = await makeItem(o, 'N1A');
    const unrelated = await makeItem(o, 'N1B');
    // Confirmed count on 2026-09-10 finds +10 units that had no receipt yet.
    const countId = await count(o, '2026-09-10', [{ itemId: item, countedQuantity: '10', unitCost: '100' }]);
    await approve(o, (await ask(o, countId)).proposalId);
    // Raw SQL inserts for this item on or before the confirmed count date are refused by the database guard; unrelated items still take moves then.
    await expect(
      rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, '2026-09-05', 10, 'manual')", [o.orgId, item]),
    ).rejects.toThrow(/STOCK_COUNT_MOVE_DATE/);
    await expect(
      rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, '2026-09-10', 10, 'manual')", [o.orgId, item]),
    ).rejects.toThrow(/STOCK_COUNT_MOVE_DATE/);
    await expect(
      rows("INSERT INTO ludy_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, '2026-09-05', 2, 'manual')", [o.orgId, unrelated]),
    ).resolves.toBeDefined();
    // Late purchase invoice dated 2026-09-05 assigned after the count is re-dated above the confirmed count floor onto today so September is not double-counted.
    const [party] = await rows<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name, email) VALUES ($1, 'NCC', 'ncc@n1.test') RETURNING id", [o.orgId]);
    const entity = await entityOf(o);
    const documentId = await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      const [doc] = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_finance.purchase_document (org_id, legal_entity_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction)
           VALUES ($1, $2, $3, 'AA', '000001', '2026-09-05', 1000, 0, 1000, 'purchase') RETURNING id`,
          [o.orgId, entity, party?.id],
        )
      ).rows;
      await c.query(
        "INSERT INTO ludy_finance.purchase_line (org_id, document_id, line_no, description, unit, quantity, amount, debit_account) VALUES ($1, $2, 1, 'Hàng N1', 'cái', 10, 1000, '156')",
        [o.orgId, doc?.id],
      );
      await c.query('COMMIT');
      return doc?.id as string;
    });
    const { moveId } = await execute<{ moveId: string }>(o, 'finance.stock.assign', { documentId, lineNo: 1, itemId: item, teach: false });
    const [assigned] = await rows<{ move_date: string; today: string }>(
      "SELECT move_date::text AS move_date, (pg_catalog.now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date::text AS today FROM ludy_finance.stock_move WHERE org_id = $1 AND id = $2",
      [o.orgId, moveId],
    );
    expect((assigned?.move_date ?? '') > '2026-09-10').toBe(true);
    expect(assigned?.move_date).toBe(assigned?.today);
    const september = await query<Row[]>(o, 'finance.stock.report', { month: '2026-09' });
    expect(september.find((r) => r.itemId === item)).toMatchObject({ closingQuantity: '10', closingValue: '1000' });
    expect(await onHand(o, item)).toBe('20');
    // When a count is confirmed on today itself, a subsequent backdated assignment is refused rather than pushed into tomorrow.
    const todayItem = await makeItem(o, 'N1T');
    const today = assigned?.today ?? '';
    const todayCount = await count(o, today, [{ itemId: todayItem, countedQuantity: '1', unitCost: '100' }]);
    await approve(o, (await ask(o, todayCount)).proposalId);
    const todayDocId = await admin(async (c) => {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      const [doc] = (
        await c.query<{ id: string }>(
          `INSERT INTO ludy_finance.purchase_document (org_id, legal_entity_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction)
           VALUES ($1, $2, $3, 'AA', '000002', $4, 100, 0, 100, 'purchase') RETURNING id`,
          [o.orgId, entity, party?.id, today],
        )
      ).rows;
      await c.query(
        "INSERT INTO ludy_finance.purchase_line (org_id, document_id, line_no, description, unit, quantity, amount, debit_account) VALUES ($1, $2, 1, 'Hàng hôm nay', 'cái', 1, 100, '156')",
        [o.orgId, doc?.id],
      );
      await c.query('COMMIT');
      return doc?.id as string;
    });
    await expect(execute(o, 'finance.stock.assign', { documentId: todayDocId, lineNo: 1, itemId: todayItem, teach: false })).rejects.toMatchObject({
      code: 'STOCK_COUNT_MOVE_DATE',
      status: 409,
    });
  });

  it('refuses confirming an earlier-dated count after a later confirmed count for an overlapping item (#2682 N1)', async () => {
    const o = await org();
    const item = await makeItem(o, 'N1O');
    const unrelated = await makeItem(o, 'N1U');
    await move(o, item, '2026-08-05', '5');
    await seedClosed(o, '2026-08', item);
    // Earlier drafts created before the later confirmation: one with a difference (plus an already-prepared proposal) and one with zero difference.
    const earlyDiff = await count(o, '2026-09-05', [{ itemId: item, countedQuantity: '3' }]);
    const earlyEmpty = await count(o, '2026-09-05', [{ itemId: item, countedQuantity: '5' }]);
    const earlyUnrelated = await count(o, '2026-09-05', [{ itemId: unrelated, countedQuantity: '0' }]);
    const earlyProposal = await ask(o, earlyDiff);
    // Later count covering `item` is confirmed on 2026-09-20.
    const later = await count(o, '2026-09-20', [{ itemId: item, countedQuantity: '4' }]);
    await approve(o, (await ask(o, later)).proposalId);
    // Preparing, approving an existing proposal, confirming empty, or updating directly in SQL for the earlier date all fail closed on STOCK_COUNT_ORDER.
    await expect(ask(o, earlyDiff)).rejects.toMatchObject({ code: 'STOCK_COUNT_ORDER', status: 409 });
    await expect(approve(o, earlyProposal.proposalId)).rejects.toMatchObject({ code: 'STOCK_COUNT_ORDER', status: 409 });
    await expect(execute(o, 'finance.stock_count.confirm_empty', { countId: earlyEmpty })).rejects.toMatchObject({ code: 'STOCK_COUNT_ORDER', status: 409 });
    await expect(
      rows("UPDATE ludy_finance.stock_count SET status = 'confirmed', confirmed_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, earlyEmpty]),
    ).rejects.toThrow(/STOCK_COUNT_ORDER/);
    // An earlier count whose items did not overlap the later count still confirms cleanly.
    await expect(execute(o, 'finance.stock_count.confirm_empty', { countId: earlyUnrelated })).resolves.toEqual({ id: earlyUnrelated });
  });

  it('guards raw ludy_tenant confirmations: refuses forged confirmed_by, nonzero differences without a voucher, and 0-line counts (#2682 N2)', async () => {
    const o = await org();
    const item = await makeItem(o, 'N2');
    await move(o, item, '2026-09-01', '5');
    const diffCount = await count(o, '2026-09-10', [{ itemId: item, countedQuantity: '3' }]);
    const zeroCount = await count(o, '2026-09-10', [{ itemId: item, countedQuantity: '5' }]);
    const entity = await entityOf(o);
    const asMemberCommit = async (fn: (c: pg.PoolClient) => Promise<void>) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await enterUser(client, o.member, o.orgId);
        await fn(client);
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    // Forging confirmed_by as another member or leaving it null fails immediately.
    await expect(
      asMemberCommit(async (client) => {
        await client.query("UPDATE ludy_finance.stock_count SET status = 'confirmed', confirmed_by = $3, confirmed_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, zeroCount, o.owner]);
      }),
    ).rejects.toThrow(/STOCK_COUNT_STATE/);
    await expect(
      asMemberCommit(async (client) => {
        await client.query("UPDATE ludy_finance.stock_count SET status = 'confirmed', confirmed_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, zeroCount]);
      }),
    ).rejects.toThrow(/STOCK_COUNT_STATE/);
    // Even with matching confirmed_by, confirming a count with a nonzero difference and no voucher fails on commit.
    await expect(
      asMemberCommit(async (client) => {
        await client.query("UPDATE ludy_finance.stock_count SET status = 'confirmed', confirmed_by = $3, confirmed_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, diffCount, o.member]);
      }),
    ).rejects.toThrow(/STOCK_COUNT_VOUCHER/);
    expect((await rows<{ status: string }>('SELECT status FROM ludy_finance.stock_count WHERE org_id = $1 AND id = $2', [o.orgId, diffCount]))[0]?.status).toBe('draft');
    // Confirming a 0-line draft header without a voucher also fails closed.
    await expect(
      asMemberCommit(async (client) => {
        const [empty] = (
          await client.query<{ id: string }>(
            "INSERT INTO ludy_finance.stock_count (org_id, legal_entity_id, count_date, created_by) VALUES ($1, $2, '2026-09-10', $3) RETURNING id",
            [o.orgId, entity, o.member],
          )
        ).rows;
        await client.query("UPDATE ludy_finance.stock_count SET status = 'confirmed', confirmed_by = $3, confirmed_at = now() WHERE org_id = $1 AND id = $2", [o.orgId, empty?.id, o.member]);
      }),
    ).rejects.toThrow(/STOCK_COUNT_VOUCHER/);
    // Confirming a zero-difference count with valid caller identity overwrites client-supplied confirmed_at using pg_catalog.now().
    await asMemberCommit(async (client) => {
      await client.query("UPDATE ludy_finance.stock_count SET status = 'confirmed', confirmed_by = $3, confirmed_at = '2020-01-01T00:00:00Z' WHERE org_id = $1 AND id = $2", [o.orgId, zeroCount, o.member]);
    });
    const [confirmedZero] = await rows<{ status: string; confirmed_by: string | null; year: number }>(
      'SELECT status, confirmed_by::text AS confirmed_by, EXTRACT(YEAR FROM confirmed_at)::int AS year FROM ludy_finance.stock_count WHERE org_id = $1 AND id = $2',
      [o.orgId, zeroCount],
    );
    expect(confirmedZero?.status).toBe('confirmed');
    expect(confirmedZero?.confirmed_by).toBe(o.member);
    expect(confirmedZero?.year).toBeGreaterThanOrEqual(2026);
  });
});

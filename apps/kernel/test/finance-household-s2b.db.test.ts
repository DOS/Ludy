// SPDX-License-Identifier: AGPL-3.0-only
// The S2b-HKD revenue book of a household business on the income method (#2517 slice 2c, plan stock-and-marketplaces.md sections 8.5 and 12 row 6), on PostgreSQL 17: a view of the ledger's account 511
// whose total ties to the ledger, each entry shared between the household's business lines by what it is built from (a sale document's lines by their stock item's trade; anything else is unassigned; a
// reversal follows the entry it undoes; one trade takes everything), VAT per line (no PIT: on the income method it comes from income) by the percentages in force on the period's last day, the label while a row behind the figures is `commentary`,
// and the cases the book refuses. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { HouseholdProfileView, HouseholdS2b } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the S2b-HKD revenue book of a household business (#2517 slice 2c)', () => {
  const dbName = `crove_test_household_s2b_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
      trades: ['goods', 'services'],
      einvoiceRegistered: false,
      representativeName: 'Nguyễn Văn A',
      ...over,
    });
  const s2b = (o: Org, period: string, entity = o.household, user = o.owner) => query<HouseholdS2b>(o, 'finance.household.s2b', { legalEntityId: entity, period }, user);

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
    const restore = new pg.Client({ connectionString: adminUrl });
    await restore.connect();
    await restore.query(
      "UPDATE crove_finance.household_threshold SET status = 'commentary'; UPDATE crove_finance.household_trade_rate SET status = 'commentary'; UPDATE crove_finance.household_form_version SET status = 'commentary'; UPDATE crove_finance.household_return_form_version SET status = 'commentary'",
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

  // A stock item of the household with a trade, written by the database owner.
  async function item(o: Org, code: string, trade: string): Promise<string> {
    return admin(async (a) => (await a.query<{ id: string }>("INSERT INTO crove_finance.stock_item (org_id, legal_entity_id, code, name, unit, stock_account, trade) VALUES ($1, $2, $3, $3, 'cái', '156', $4) RETURNING id", [o.orgId, o.household, code, trade])).rows[0]?.id as string);
  }
  // An entry of the household's ledger written by the database owner (the triggers fire as for any writer). A reversal mirrors its original line by line (same line number and account, debit and credit swapped). With `sale`, the entry is the posting of a sale document of the entity whose lines (net amount, stock item
  // or none) each make a live stock move; `reverses` makes it the reversal of another entry.
  async function entry(
    o: Org,
    date: string,
    description: string,
    lines: Array<[string, number, number]>,
    over: { sale?: Array<{ amount: number; item: string | null }>; reverses?: string; entity?: string } = {},
  ): Promise<string> {
    const entity = over.entity ?? o.household;
    return admin(async (a) => {
      await a.query('BEGIN');
      try {
        let document: string | null = null;
        if (over.sale) {
          const party = (await a.query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'Khách lẻ') RETURNING id", [o.orgId])).rows[0]?.id;
          const total = over.sale.reduce((acc, l) => acc + l.amount, 0);
          document = (
            await a.query<{ id: string }>(
              "INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id) VALUES ($1, $2, '1C26TAA', $3, $4, $5, 0, $5, 'sale', $6) RETURNING id",
              [o.orgId, party, `S${randomUUID().slice(0, 8)}`, date, total, entity],
            )
          ).rows[0]?.id as string;
          // A sale line names its credit account alone (purchase_line_one_account).
          let no = 1;
          for (const l of over.sale) {
            await a.query("INSERT INTO crove_finance.purchase_line (org_id, document_id, line_no, description, amount, credit_account) VALUES ($1, $2, $3, $4, $5, '511')", [o.orgId, document, no, `Dòng ${no}`, l.amount]);
            if (l.item) {
              await a.query(
                "INSERT INTO crove_finance.stock_move (org_id, legal_entity_id, item_id, move_date, quantity, source_type, document_id, line_no, line_attempt) VALUES ($1, $2, $3, $4, -1, 'document_line', $5, $6, 1)",
                [o.orgId, entity, l.item, date, document, no],
              );
            }
            no += 1;
          }
        }
        const id = (
          await a.query<{ id: string }>(
            'INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id, reverses_entry_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
            [o.orgId, date, description, document ? 'finance.purchase_document' : 'finance.journal_voucher', document ?? randomUUID(), entity, over.reverses ?? null],
          )
        ).rows[0]?.id as string;
        let no = 1;
        for (const [account, debit, credit] of lines) await a.query('INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, id, no++, account, debit, credit]);
        // The only way to reverse the entry of a sale document is a void, written in the same transaction (a deferred trigger demands it), and a void takes the stock of every line back: the
        // document's stock moves are reversed, as finance.journal.reverse does. The reversed moves stay, so the book still sees which item each line was sold as.
        if (over.reverses) {
          const original = (await a.query<{ source_type: string; source_id: string }>('SELECT source_type, source_id FROM crove_finance.journal_entry WHERE org_id = $1 AND id = $2', [o.orgId, over.reverses])).rows[0];
          if (original?.source_type === 'finance.purchase_document') {
            const moves = await a.query<{ id: string; item_id: string; quantity: string }>("SELECT id, item_id, quantity FROM crove_finance.stock_move WHERE org_id = $1 AND document_id = $2 AND source_type = 'document_line'", [o.orgId, original.source_id]);
            for (const m of moves.rows) {
              await a.query("INSERT INTO crove_finance.stock_move (org_id, legal_entity_id, item_id, move_date, quantity, source_type, reverses_move_id) VALUES ($1, $2, $3, $4, $5, 'reversal', $6)", [o.orgId, entity, m.item_id, date, -Number(m.quantity), m.id]);
            }
            await a.query("INSERT INTO crove_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'Hủy hóa đơn')", [o.orgId, original.source_id, id]);
          }
        }
        await a.query('COMMIT');
        return id;
      } catch (error) {
        await a.query('ROLLBACK');
        throw error;
      }
    });
  }
  const sum = (list: string[]) => list.reduce((acc, v) => acc + Number(v), 0);

  it('shares the entries between the business lines by what they are built from, ties to the ledger, and holds the tax total back while something is unassigned', async () => {
    const o = await org();
    await setProfile(o);
    const shirt = await item(o, 'AO', 'goods');
    const repair = await item(o, 'SUA', 'services');
    await entry(o, '2026-09-05', 'Bán hàng và sửa chữa', [['111', 1000000, 0], ['511', 0, 1000000]], { sale: [{ amount: 600000, item: shirt }, { amount: 400000, item: repair }] });
    // A voucher and a settlement have no item: unassigned, never guessed.
    await entry(o, '2026-09-12', 'Đối soát sàn', [['111', 300000, 0], ['511', 0, 300000]]);
    await entry(o, '2026-08-31', 'Bán tháng trước', [['111', 777000, 0], ['511', 0, 777000]]);
    await entry(o, '2026-10-01', 'Bán tháng sau', [['111', 555000, 0], ['511', 0, 555000]]);
    await entry(o, '2026-09-14', 'Bán của công ty', [['111', 999000, 0], ['511', 0, 999000]], { entity: o.company });
    const book = await s2b(o, '2026-09');
    expect(book.period).toEqual({ period: '2026-09', from: '2026-09-01', to: '2026-09-30' });
    expect(book.form).toMatchObject({ book: 'S2b', status: 'commentary' });
    expect(book.rows.map((r) => [r.date, r.amount])).toEqual([['2026-09-05', '1000000'], ['2026-09-12', '300000']]);
    expect(book.rows[0]?.parts).toEqual([{ trade: 'goods', amount: '600000' }, { trade: 'services', amount: '400000' }]);
    expect(book.rows[1]?.parts).toEqual([{ trade: 'unassigned', amount: '300000' }]);
    // The total is the ledger's own movement of 511, and every row's parts add up to the row.
    const ledger = await query<{ debit: string; credit: string }>(o, 'finance.ledger.account', { period: '2026-09', legalEntityId: o.household, accountCode: '511' });
    expect(book.total).toBe(String(Number(ledger.credit) - Number(ledger.debit)));
    expect(book.total).toBe('1300000');
    for (const r of book.rows) expect(sum(r.parts.map((p) => p.amount))).toBe(Number(r.amount));
    expect(book.lines).toEqual([
      { trade: 'goods', revenue: '600000', vatPercent: '1', vat: '6000' },
      { trade: 'services', revenue: '400000', vatPercent: '5', vat: '20000' },
    ]);
    expect(book.unassigned).toBe('300000');
    expect(book.unassignedGross).toBe('300000');
    expect(sum([...book.lines.map((l) => l.revenue), book.unassigned])).toBe(Number(book.total));
    expect(book.totals).toBeNull();
    // The rows behind the figures are still `commentary`: the book is given and says so.
    expect(book.commentary).toBe(true);
    expect(book.unconfirmed.map((u) => u.kind)).toEqual(['form', 'rate', 'rate']);
  });

  it('totals the tax once every entry has a line, rounded to a whole dong per line', async () => {
    const o = await org();
    await setProfile(o);
    const shirt = await item(o, 'AO', 'goods');
    const repair = await item(o, 'SUA', 'services');
    await entry(o, '2026-09-05', 'Bán hàng và sửa chữa', [['111', 1000333, 0], ['511', 0, 1000333]], { sale: [{ amount: 600200, item: shirt }, { amount: 400133, item: repair }] });
    const book = await s2b(o, '2026-09');
    expect(book.unassigned).toBe('0');
    expect(sum(book.lines.map((l) => l.revenue))).toBe(1000333);
    expect(book.totals).not.toBeNull();
    expect(book.totals?.revenue).toBe('1000333');
    // Each line: revenue times the percentage, rounded to a whole dong.
    for (const l of book.lines) {
      expect(l.vat).toBe(String(Math.round((Number(l.revenue) * Number(l.vatPercent)) / 100)));
    }
    expect(book.totals?.vat).toBe(String(sum(book.lines.map((l) => l.vat))));
  });

  it('puts a voided sale on the lines it was made under, in the month of the sale and in the month of the void', async () => {
    const o = await org();
    await setProfile(o);
    const shirt = await item(o, 'AO', 'goods');
    const repair = await item(o, 'SUA', 'services');
    const sale = await entry(o, '2026-08-30', 'Bán hàng và sửa chữa', [['111', 1000000, 0], ['511', 0, 1000000]], { sale: [{ amount: 600000, item: shirt }, { amount: 400000, item: repair }] });
    await entry(o, '2026-09-02', 'Hủy hóa đơn', [['111', 0, 1000000], ['511', 1000000, 0]], { reverses: sale });
    // The void took the stock back, so no line has a move left that nothing reverses; the sale is still attributed to the trades it had, not to unassigned.
    const august = await s2b(o, '2026-08');
    expect(august.rows[0]?.parts).toEqual([{ trade: 'goods', amount: '600000' }, { trade: 'services', amount: '400000' }]);
    expect(august.unassigned).toBe('0');
    expect(august.totals).not.toBeNull();
    const september = await s2b(o, '2026-09');
    expect(september.rows[0]?.parts).toEqual([{ trade: 'goods', amount: '-600000' }, { trade: 'services', amount: '-400000' }]);
    expect(september.unassigned).toBe('0');
    expect(september.totals).toEqual({ revenue: '-1000000', vat: '0' });
  });

  it('puts a reversal on the lines of the entry it undoes, so the period nets to the ledger', async () => {
    const o = await org();
    await setProfile(o);
    const shirt = await item(o, 'AO', 'goods');
    const repair = await item(o, 'SUA', 'services');
    const sale = await entry(o, '2026-09-05', 'Bán hàng và sửa chữa', [['111', 1000000, 0], ['511', 0, 1000000]], { sale: [{ amount: 600000, item: shirt }, { amount: 400000, item: repair }] });
    await entry(o, '2026-09-20', 'Đảo bán hàng', [['111', 0, 1000000], ['511', 1000000, 0]], { reverses: sale });
    const book = await s2b(o, '2026-09');
    expect(book.rows.map((r) => [r.amount, r.reversal])).toEqual([['1000000', false], ['-1000000', true]]);
    expect(book.rows[1]?.parts).toEqual([{ trade: 'goods', amount: '-600000' }, { trade: 'services', amount: '-400000' }]);
    expect(book.total).toBe('0');
    expect(book.lines.map((l) => l.revenue)).toEqual(['0', '0']);
    expect(book.unassigned).toBe('0');
    // A period with net returns owes nothing: the tax never goes negative.
    expect(book.totals).toEqual({ revenue: '0', vat: '0' });
  });

  it('puts a line whose item has a trade the profile does not list on unassigned, and holds the tax total back', async () => {
    const o = await org();
    await setProfile(o, { trades: ['goods', 'services'] });
    const catered = await item(o, 'AN', 'catering');
    const shirt = await item(o, 'AO', 'goods');
    await entry(o, '2026-09-05', 'Bán lẻ', [['111', 1000000, 0], ['511', 0, 1000000]], { sale: [{ amount: 500000, item: catered }, { amount: 500000, item: shirt }] });
    const book = await s2b(o, '2026-09');
    expect(book.rows[0]?.parts).toEqual([{ trade: 'goods', amount: '500000' }, { trade: 'unassigned', amount: '500000' }]);
    expect(book.totals).toBeNull();
  });

  it('keeps each trade its signed contribution from a sale document with an adjustment line', async () => {
    const o = await org();
    await setProfile(o);
    const shirt = await item(o, 'AO', 'goods');
    const repair = await item(o, 'SUA', 'services');
    // Goods 200000 and services -100000 (a price adjustment) make a net of 100000 on 511.
    await entry(o, '2026-09-05', 'Bán hàng có điều chỉnh', [['111', 100000, 0], ['511', 0, 100000]], { sale: [{ amount: 200000, item: shirt }, { amount: -100000, item: repair }] });
    const book = await s2b(o, '2026-09');
    expect(book.rows[0]?.parts).toEqual([{ trade: 'goods', amount: '200000' }, { trade: 'services', amount: '-100000' }]);
    expect(book.lines.map((l) => [l.trade, l.revenue])).toEqual([['goods', '200000'], ['services', '-100000']]);
    expect(book.total).toBe('100000');
  });

  it('holds the totals back for every unassigned part, even when two unrelated unassigned entries cancel each other', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o, '2026-09-05', 'Phiếu nhập tay', [['111', 1000000, 0], ['511', 0, 1000000]]);
    await entry(o, '2026-09-20', 'Điều chỉnh khác', [['511', 1000000, 0], ['111', 0, 1000000]]);
    const book = await s2b(o, '2026-09');
    expect(book.unassigned).toBe('0');
    expect(book.unassignedGross).toBe('2000000');
    expect(book.totals).toBeNull();
  });

  it('shows the layout row in force on the last day and its label, even when it changes inside the period with no profile change', async () => {
    const o = await org();
    await setProfile(o, { trades: ['goods'] });
    await entry(o, '2026-12-05', 'Bán tháng 12', [['111', 1000000, 0], ['511', 0, 1000000]]);
    // December, so the global layout row this adds leaves the other tests' months (August to October) as they were.
    await admin((a) => a.query("INSERT INTO crove_finance.household_form_version (book, version, effective_from, name, pit_methods, source, status) VALUES ('S2b', '2026.9', DATE '2026-12-15', 'Sổ S2b mới', ARRAY['income'], 'test', 'confirmed') ON CONFLICT DO NOTHING"));
    const december = await s2b(o, '2026-12');
    expect(december.form).toMatchObject({ book: 'S2b', version: '2026.9', name: 'Sổ S2b mới', status: 'confirmed' });
    expect(december.unconfirmed.map((u) => u.kind)).toEqual(['rate']);
  });

  it('gives every row to the only trade of a household with one trade, whatever the entry is built from', async () => {
    const o = await org();
    await setProfile(o, { trades: ['goods'] });
    await entry(o, '2026-09-12', 'Đối soát sàn', [['111', 300000, 0], ['511', 0, 300000]]);
    await entry(o, '2026-09-13', 'Bán lẻ', [['111', 200000, 0], ['511', 0, 200000]]);
    const book = await s2b(o, '2026-09');
    expect(book.rows.map((r) => r.parts)).toEqual([[{ trade: 'goods', amount: '300000' }], [{ trade: 'goods', amount: '200000' }]]);
    expect(book.lines).toEqual([{ trade: 'goods', revenue: '500000', vatPercent: '1', vat: '5000' }]);
    expect(book.totals).toEqual({ revenue: '500000', vat: '5000' });
  });

  it('changes the figures of the next period by a new dated row and leaves a period made earlier as it was; the label stays while the form is unconfirmed', async () => {
    const o = await org();
    await setProfile(o, { trades: ['goods'] });
    await entry(o, '2026-09-12', 'Bán tháng 9', [['111', 1000000, 0], ['511', 0, 1000000]]);
    await entry(o, '2026-10-12', 'Bán tháng 10', [['111', 1000000, 0], ['511', 0, 1000000]]);
    await admin((a) => a.query("INSERT INTO crove_finance.household_trade_rate (trade, effective_from, vat_percent, pit_percent, source, status) VALUES ('goods', DATE '2026-10-01', 2, 1, 'test', 'confirmed')"));
    const september = await s2b(o, '2026-09');
    const october = await s2b(o, '2026-10');
    expect(september.lines[0]).toMatchObject({ vatPercent: '1', vat: '10000' });
    expect(october.lines[0]).toMatchObject({ vatPercent: '2', vat: '20000' });
    // The rate is confirmed from October, so it is no longer on the list; the S2b layout row is still `commentary`, so the book still says so.
    expect(september.unconfirmed.map((u) => u.kind)).toEqual(['form', 'rate']);
    expect(october.unconfirmed.map((u) => u.kind)).toEqual(['form']);
    expect(october.commentary).toBe(true);
  });

  it('refuses a period whose profiles name different trades, and gives the parts on either side of the change (#3714)', async () => {
    const o = await org();
    await setProfile(o);
    const shirt = await item(o, 'AO', 'goods');
    const repair = await item(o, 'SUA', 'services');
    await entry(o, '2026-09-05', 'Bán hàng và sửa chữa', [['111', 1000000, 0], ['511', 0, 1000000]], { sale: [{ amount: 600000, item: shirt }, { amount: 400000, item: repair }] });
    await entry(o, '2026-09-20', 'Bán lẻ', [['111', 200000, 0], ['511', 0, 200000]], { sale: [{ amount: 200000, item: shirt }] });
    // From 16 September the household drops its service line: one month then has two trade lists, and the book never applies the later one to the earlier sales.
    await setProfile(o, { effectiveFrom: '2026-09-16', trades: ['goods'] });
    await expect(s2b(o, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_TRADES_CHANGED' });
    await expect(s2b(o, '2026-Q3')).rejects.toMatchObject({ code: 'HOUSEHOLD_TRADES_CHANGED' });
    // The parts on either side of the change are not refused: August is under the first profile, October under the second.
    const august = await s2b(o, '2026-08');
    expect(august.lines.map((l) => l.trade)).toEqual(['goods', 'services']);
    const october = await s2b(o, '2026-10');
    expect(october.lines.map((l) => l.trade)).toEqual(['goods']);
  });

  it('does not refuse a period whose profiles change but keep the same trades', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o, '2026-09-05', 'Bán', [['111', 100000, 0], ['511', 0, 100000]]);
    await setProfile(o, { effectiveFrom: '2026-09-16', einvoiceRegistered: true });
    await expect(s2b(o, '2026-09')).resolves.toMatchObject({ total: '100000' });
  });

  it('refuses an entity that is not a household, has no profile, is on group 1 or on the percentage method, and lets a viewer read the book', async () => {
    const o = await org();
    await expect(s2b(o, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    await expect(s2b(o, '2026-09', o.company)).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    await setProfile(o, { taxGroup: 1, pitMethod: null, trades: ['goods'] });
    await expect(s2b(o, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    const percentage = await org();
    await setProfile(percentage, { taxGroup: 2, pitMethod: 'percentage', trades: ['goods'] });
    await expect(s2b(percentage, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    const reader = await org();
    await setProfile(reader, { trades: ['goods'] });
    await entry(reader, '2026-09-12', 'Bán', [['111', 100000, 0], ['511', 0, 100000]]);
    await expect(s2b(reader, '2026-09', reader.household, reader.viewer)).resolves.toMatchObject({ total: '100000' });
  });
});

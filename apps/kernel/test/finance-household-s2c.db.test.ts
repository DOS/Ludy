// SPDX-License-Identifier: AGPL-3.0-only
// The S2c-HKD revenue and expense detail of a household business on the income method (#2517 slice 2b, plan stock-and-marketplaces.md sections 8.5 and 12 row 6), on PostgreSQL 17: revenue from the ledger's
// account 511, one row per journal line on an expense account (classes 6 and 8) with its document, grouped by the dated rows of household_expense_group_map (the longest prefix decides, never a guess), the totals
// tying to the ledger, the income held back while an expense account has no group, the label while a row behind the figures is `commentary`, and the cases the book refuses. Set CROVE_TEST_ADMIN_URL to a
// superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { HouseholdProfileView, HouseholdS2c } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the S2c-HKD revenue and expense detail of a household business (#2517 slice 2b)', () => {
  const dbName = `crove_test_household_s2c_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const s2c = (o: Org, period: string, entity = o.household, user = o.owner) => query<HouseholdS2c>(o, 'finance.household.s2c', { legalEntityId: entity, period }, user);

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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // An entry of the household's ledger written by the database owner (the triggers fire as for any writer). With `invoice`, the entry is posted from a purchase document of the entity carrying that invoice
  // number, so the ledger gives the entry a document reference.
  async function entry(o: Org, date: string, description: string, lines: Array<[string, number, number]>, over: { invoice?: { series: string; number: string; total: number }; entity?: string } = {}): Promise<string> {
    const entity = over.entity ?? o.household;
    return admin(async (a) => {
      await a.query('BEGIN');
      try {
        let document: string | null = null;
        if (over.invoice) {
          const party = (await a.query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'Nhà cung cấp') RETURNING id", [o.orgId])).rows[0]?.id;
          document = (
            await a.query<{ id: string }>(
              "INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6, 0, $6, 'purchase', $7) RETURNING id",
              [o.orgId, party, over.invoice.series, over.invoice.number, date, over.invoice.total, entity],
            )
          ).rows[0]?.id as string;
        }
        const id = (
          await a.query<{ id: string }>(
            'INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [o.orgId, date, description, document ? 'finance.purchase_document' : 'finance.journal_voucher', document ?? randomUUID(), entity],
          )
        ).rows[0]?.id as string;
        let no = 1;
        for (const [account, debit, credit] of lines) await a.query('INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)', [o.orgId, id, no++, account, debit, credit]);
        await a.query('COMMIT');
        return id;
      } catch (error) {
        await a.query('ROLLBACK');
        throw error;
      }
    });
  }
  const sum = (list: string[]) => list.reduce((acc, v) => acc + Number(v), 0);
  const ledgerNet = async (o: Org, period: string, account: string) => {
    const l = await query<{ debit: string; credit: string }>(o, 'finance.ledger.account', { period, legalEntityId: o.household, accountCode: account });
    return Number(l.debit) - Number(l.credit);
  };

  it('lists the revenue and every expense line with its document and group, ties to the ledger, and holds the income back while an account has no group', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o, '2026-09-05', 'Bán hàng', [['111', 5000000, 0], ['511', 0, 5000000]]);
    await entry(o, '2026-09-06', 'Mua hàng về bán', [['632', 3000000, 0], ['111', 0, 3000000]], { invoice: { series: 'AA', number: '0001', total: 3000000 } });
    await entry(o, '2026-09-20', 'Chi phí quản lý', [['642', 400000, 0], ['111', 0, 400000]]);
    // No row of the map covers 641: it shows apart, never in a guessed group.
    await entry(o, '2026-09-22', 'Thuê mặt bằng', [['641', 700000, 0], ['111', 0, 700000]]);
    await entry(o, '2026-08-31', 'Chi tháng trước', [['632', 111000, 0], ['111', 0, 111000]]);
    await entry(o, '2026-10-01', 'Chi tháng sau', [['632', 222000, 0], ['111', 0, 222000]]);
    await entry(o, '2026-09-14', 'Chi của công ty', [['632', 999000, 0], ['111', 0, 999000]], { entity: o.company });
    const book = await s2c(o, '2026-09');
    expect(book.period).toEqual({ period: '2026-09', from: '2026-09-01', to: '2026-09-30' });
    expect(book.form).toMatchObject({ book: 'S2c', status: 'commentary' });
    expect(book.revenueRows.map((r) => [r.date, r.amount])).toEqual([['2026-09-05', '5000000']]);
    expect(book.revenue).toBe('5000000');
    expect(book.expenseRows.map((r) => [r.date, r.reference, r.accountCode, r.group, r.amount])).toEqual([
      ['2026-09-06', 'AA-0001', '632', 'materials_goods', '3000000'],
      ['2026-09-20', null, '642', 'other', '400000'],
      ['2026-09-22', null, '641', null, '700000'],
    ]);
    expect(book.groups.map((g) => [g.group, g.amount])).toEqual([
      ['materials_goods', '3000000'],
      ['wages_insurance', '0'],
      ['depreciation', '0'],
      ['outside_services', '0'],
      ['interest', '0'],
      ['other', '400000'],
    ]);
    expect(book.unmapped).toBe('700000');
    expect(book.unmappedGross).toBe('700000');
    expect(book.expenseTotal).toBe('4100000');
    expect(book.income).toBeNull();
    // The totals are the ledger's own: revenue is 511's movement, and the expense is the net of the accounts' lines.
    expect(book.revenue).toBe(String(-(await ledgerNet(o, '2026-09', '511'))));
    expect(book.expenseTotal).toBe(String((await ledgerNet(o, '2026-09', '632')) + (await ledgerNet(o, '2026-09', '642')) + (await ledgerNet(o, '2026-09', '641'))));
    expect(sum([...book.groups.map((g) => g.amount), book.unmapped])).toBe(Number(book.expenseTotal));
    // The map rows in use are still `commentary`, and so is the layout: the book is given and says so (641 rests on no row).
    expect(book.commentary).toBe(true);
    expect(book.unconfirmed.map((u) => [u.kind, u.key])).toEqual([['form', expect.stringContaining('S2c')], ['group', '632'], ['group', '642']]);
  });

  it('gives the income, revenue less expenses, once every expense line has a group; a return lowers the expense', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o, '2026-09-05', 'Bán hàng', [['111', 5000000, 0], ['511', 0, 5000000]]);
    await entry(o, '2026-09-06', 'Mua hàng', [['632', 3000000, 0], ['111', 0, 3000000]]);
    await entry(o, '2026-09-08', 'Trả lại hàng đã mua', [['111', 500000, 0], ['632', 0, 500000]]);
    await entry(o, '2026-09-20', 'Lãi vay', [['635', 200000, 0], ['111', 0, 200000]]);
    const book = await s2c(o, '2026-09');
    expect(book.expenseRows.map((r) => [r.accountCode, r.group, r.amount])).toEqual([['632', 'materials_goods', '3000000'], ['632', 'materials_goods', '-500000'], ['635', 'interest', '200000']]);
    expect(book.groups.find((g) => g.group === 'materials_goods')?.amount).toBe('2500000');
    expect(book.groups.find((g) => g.group === 'interest')?.amount).toBe('200000');
    expect(book.unmapped).toBe('0');
    expect(book.unmappedGross).toBe('0');
    expect(book.expenseTotal).toBe('2700000');
    expect(book.income).toBe('2300000');
  });

  it('holds the income back for any unmapped line, even when two unrelated unmapped lines cancel each other', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o, '2026-09-05', 'Chi 641', [['641', 100000, 0], ['111', 0, 100000]]);
    await entry(o, '2026-09-06', 'Hoàn chi 641', [['111', 100000, 0], ['641', 0, 100000]]);
    const book = await s2c(o, '2026-09');
    expect(book.unmapped).toBe('0');
    expect(book.unmappedGross).toBe('200000');
    expect(book.income).toBeNull();
  });

  it('reads the group from the row in force on the last day: a new dated row changes the next period and no earlier one, and a confirmed row ends the label', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o, '2026-11-10', 'Chi 642 tháng 11', [['642', 100000, 0], ['111', 0, 100000]]);
    await entry(o, '2026-12-10', 'Chi 642 tháng 12', [['642', 100000, 0], ['111', 0, 100000]]);
    // The accountant's later dated row, in December so the months of the other tests keep the seeds: 642 is wages and insurance from 1 December, confirmed.
    await admin((a) => a.query("INSERT INTO crove_finance.household_expense_group_map (expense_group, account_prefix, effective_from, source, status) VALUES ('wages_insurance', '642', DATE '2026-12-01', 'test', 'confirmed')"));
    const november = await s2c(o, '2026-11');
    const december = await s2c(o, '2026-12');
    expect(november.expenseRows[0]?.group).toBe('other');
    expect(december.expenseRows[0]?.group).toBe('wages_insurance');
    expect(november.unconfirmed.map((u) => [u.kind, u.key])).toContainEqual(['group', '642']);
    expect(december.unconfirmed.map((u) => [u.kind, u.key])).not.toContainEqual(['group', '642']);
  });

  it('refuses an entity that is not a household, has no profile, is on group 1 or on the percentage method, and lets a viewer read the book', async () => {
    const o = await org();
    await expect(s2c(o, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    await expect(s2c(o, '2026-09', o.company)).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    await setProfile(o, { taxGroup: 1, pitMethod: null });
    await expect(s2c(o, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    const percentage = await org();
    await setProfile(percentage, { taxGroup: 2, pitMethod: 'percentage' });
    await expect(s2c(percentage, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    const reader = await org();
    await setProfile(reader);
    await entry(reader, '2026-09-12', 'Bán', [['111', 100000, 0], ['511', 0, 100000]]);
    await expect(s2c(reader, '2026-09', reader.household, reader.viewer)).resolves.toMatchObject({ revenue: '100000' });
  });
});

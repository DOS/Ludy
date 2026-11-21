// SPDX-License-Identifier: AGPL-3.0-only
// The S2e-HKD cash and bank book of a household business on the income method (#2517 slice 2e, plan stock-and-marketplaces.md sections 8.5 and 12 row 6), on PostgreSQL 17: one section per account of 111 and 112
// (sub-accounts too) with its opening balance, one row per line, the running balance and the closing balance; the closings add up to the ledger's balance of 111 and 112; the days before the household's books
// opened go into the opening balance; another entity's lines stay out; the label while the layout row is `commentary`; and the cases the book refuses. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { HouseholdProfileView, HouseholdS2e } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the S2e-HKD cash and bank book of a household business (#2517 slice 2e)', () => {
  const dbName = `crove_test_household_s2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const s2e = (o: Org, period: string, entity = o.household, user = o.owner) => query<HouseholdS2e>(o, 'finance.household.s2e', { legalEntityId: entity, period }, user);

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
  const ledgerClosing = async (o: Org, period: string, account: string) => {
    const l = await query<{ closing: string }>(o, 'finance.ledger.account', { period, legalEntityId: o.household, accountCode: account });
    return Number(l.closing);
  };

  it('gives each cash and bank account its opening, lines and closing, and the closings add up to the ledger of 111 and 112', async () => {
    const o = await org();
    await setProfile(o);
    // 1121 is a TT133 sub-account of 112 (a bank account), so a line on it must stay out of 112's own section.
    await entry(o, '2026-08-20', 'Vốn đầu kỳ', [['111', 500000, 0], ['112', 2000000, 0], ['411', 0, 2500000]]);
    await entry(o, '2026-09-05', 'Bán hàng thu tiền mặt', [['111', 1000000, 0], ['511', 0, 1000000]]);
    await entry(o, '2026-09-06', 'Mua hàng', [['632', 300000, 0], ['111', 0, 300000]], { invoice: { series: 'AA', number: '0001', total: 300000 } });
    await entry(o, '2026-09-10', 'Khách chuyển khoản', [['1121', 700000, 0], ['511', 0, 700000]]);
    await entry(o, '2026-09-12', 'Rút tiền gửi', [['111', 200000, 0], ['112', 0, 200000]]);
    // Not cash and not this household: left out.
    await entry(o, '2026-09-14', 'Của công ty', [['111', 999000, 0], ['511', 0, 999000]], { entity: o.company });
    await entry(o, '2026-10-01', 'Tháng sau', [['111', 123000, 0], ['511', 0, 123000]]);
    const book = await s2e(o, '2026-09');
    expect(book.form).toMatchObject({ book: 'S2e', status: 'commentary' });
    expect(book.accounts.map((a) => a.accountCode)).toEqual(['111', '112', '1121']);
    const [cash, bank, sub] = book.accounts;
    expect(cash).toMatchObject({ opening: '500000', totalIn: '1200000', totalOut: '300000', closing: '1400000', negative: false });
    expect(cash!.rows.map((r) => [r.date, r.reference, r.counterAccounts, r.cashIn, r.cashOut, r.balance])).toEqual([
      ['2026-09-05', null, ['511'], '1000000', '0', '1500000'],
      ['2026-09-06', 'AA-0001', ['632'], '0', '300000', '1200000'],
      ['2026-09-12', null, ['112'], '200000', '0', '1400000'],
    ]);
    // 112 holds only its own lines: the sub-account's are in its own section.
    expect(bank).toMatchObject({ opening: '2000000', totalIn: '0', totalOut: '200000', closing: '1800000' });
    expect(sub).toMatchObject({ opening: '0', totalIn: '700000', totalOut: '0', closing: '700000' });
    expect(book.totals).toEqual({ opening: '2500000', in: '1900000', out: '500000', closing: '3900000' });
    // Ties to the ledger: the closing of 111 and the closing of 112 (with its sub-account) are the ledger's own.
    expect(Number(book.totals.closing)).toBe((await ledgerClosing(o, '2026-09', '111')) + (await ledgerClosing(o, '2026-09', '112')));
    expect(Number(cash!.closing)).toBe(await ledgerClosing(o, '2026-09', '111'));
    expect(Number(bank!.closing) + Number(sub!.closing)).toBe(await ledgerClosing(o, '2026-09', '112'));
    expect(book.commentary).toBe(true);
    expect(book.unconfirmed.map((u) => [u.kind, u.key])).toEqual([['form', expect.stringContaining('S2e')]]);
  });

  it('starts the book on the day the first profile took effect, the days before it going into the opening balance, and flags a negative balance', async () => {
    const o = await org();
    await setProfile(o, { effectiveFrom: '2026-09-10' });
    await entry(o, '2026-09-02', 'Trước ngày mở sổ', [['111', 700000, 0], ['411', 0, 700000]]);
    await entry(o, '2026-09-20', 'Chi quá số dư', [['642', 900000, 0], ['111', 0, 900000]]);
    const book = await s2e(o, '2026-09');
    expect(book.period.from).toBe('2026-09-10');
    const cash = book.accounts[0]!;
    expect(cash.opening).toBe('700000');
    expect(cash.rows.map((r) => r.date)).toEqual(['2026-09-20']);
    expect(cash).toMatchObject({ closing: '-200000', negative: true });
    expect(Number(cash.closing)).toBe(await ledgerClosing(o, '2026-09', '111'));
  });

  it('shows a reversal as its own row, and gives an empty book when nothing moved', async () => {
    const o = await org();
    await setProfile(o);
    const empty = await s2e(o, '2026-09');
    expect(empty.accounts).toEqual([]);
    expect(empty.totals).toEqual({ opening: '0', in: '0', out: '0', closing: '0' });
    const id = await entry(o, '2026-09-05', 'Thu nhầm', [['111', 400000, 0], ['511', 0, 400000]]);
    await admin(async (a) => {
      await a.query('BEGIN');
      const reversal = (await a.query<{ id: string }>("INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id, reverses_entry_id) VALUES ($1, DATE '2026-09-06', 'Đảo bút toán', 'finance.journal_voucher', $2, $3, $4) RETURNING id", [o.orgId, randomUUID(), o.household, id])).rows[0]?.id;
      await a.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '111', 0, 400000), ($1, $2, 2, '511', 400000, 0)", [o.orgId, reversal]);
      await a.query('COMMIT');
    });
    const book = await s2e(o, '2026-09');
    expect(book.accounts[0]!.rows.map((r) => [r.reversal, r.balance])).toEqual([[false, '400000'], [true, '0']]);
    expect(book.accounts[0]).toMatchObject({ totalIn: '400000', totalOut: '400000', closing: '0' });
  });

  it('labels the book while the layout row is commentary and not once a later dated confirmed row exists', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o, '2026-11-10', 'Thu tháng 11', [['111', 100000, 0], ['511', 0, 100000]]);
    await entry(o, '2026-12-10', 'Thu tháng 12', [['111', 100000, 0], ['511', 0, 100000]]);
    await admin((a) => a.query("INSERT INTO crove_finance.household_form_version (book, version, effective_from, name, pit_methods, source, status) VALUES ('S2e', '2026.2', DATE '2026-12-01', 'Sổ chi tiết tiền (S2e-HKD)', ARRAY['income']::text[], 'test', 'confirmed')"));
    const november = await s2e(o, '2026-11');
    const december = await s2e(o, '2026-12');
    expect(november.commentary).toBe(true);
    expect(december.commentary).toBe(false);
    expect(december.unconfirmed).toEqual([]);
    expect(december.form).toMatchObject({ version: '2026.2', status: 'confirmed' });
  });

  it('refuses an entity that is not a household, has no profile, is on group 1 or on the percentage method, and lets a viewer read the book', async () => {
    const o = await org();
    await expect(s2e(o, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    await expect(s2e(o, '2026-09', o.company)).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    await setProfile(o, { taxGroup: 1, pitMethod: null });
    await expect(s2e(o, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    const percentage = await org();
    await setProfile(percentage, { taxGroup: 2, pitMethod: 'percentage' });
    await expect(s2e(percentage, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    const reader = await org();
    await setProfile(reader);
    await entry(reader, '2026-09-12', 'Thu', [['111', 100000, 0], ['511', 0, 100000]]);
    await expect(s2e(reader, '2026-09', reader.household, reader.viewer)).resolves.toMatchObject({ totals: { closing: '100000' } });
  });
});

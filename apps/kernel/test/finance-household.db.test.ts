// SPDX-License-Identifier: AGPL-3.0-only
// The household business kind (#2517, plan stock-and-marketplaces.md section 8.5), on PostgreSQL 17: the profile of an entity of kind household (a new dated row, never an edit; refused inside a
// locked period, for another kind of entity and for a group and method that do not fit), the books each method requires, and the law as dated data (a new row changes the periods from its
// date and none before; every seed row is still `commentary` until the accountant confirms it, #2520). Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { HouseholdProfileView, HouseholdRules, HouseholdS1a } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('household business profile and rules (#2517)', () => {
  const dbName = `crove_test_household_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string; company: string; household: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Hộ Kinh Doanh ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]),
    );
    const company = (await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))).rows[0]?.id as string;
    const household = randomUUID();
    await admin((c) =>
      c.query("INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Hộ kinh doanh Nguyễn Văn A', 'household', $3)", [orgId, household, owner]),
    );
    return { orgId, owner, admin: adminUser, member, viewer, company, household };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.execute<T>(name, input, { actor: asUser(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.owner) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const setProfile = (o: Org, over: Record<string, unknown> = {}, user = o.owner) =>
    execute<HouseholdProfileView>(
      o,
      'finance.household.profile_set',
      { legalEntityId: o.household, effectiveFrom: '2026-01-01', taxGroup: 1, pitMethod: null, trades: ['goods'], einvoiceRegistered: false, representativeName: 'Nguyễn Văn A', ...over },
      user,
    );
  const profileAt = (o: Org, date: string, user = o.owner) => query<HouseholdProfileView>(o, 'finance.household.profile_get', { legalEntityId: o.household, date }, user);

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

  it('has no profile and no book until one is set, and then lists the books of its method', async () => {
    const o = await org();
    expect(await profileAt(o, '2026-06-30')).toEqual({ date: '2026-06-30', profile: null, books: [], commentary: false });
    // Group 1 keeps S1a alone.
    const one = await setProfile(o);
    expect(one.profile).toMatchObject({ effectiveFrom: '2026-01-01', taxGroup: 1, pitMethod: null, trades: ['goods'], einvoiceRegistered: false, representativeName: null });
    expect((await profileAt(o, '2026-06-30')).profile?.representativeName).toBe('Nguyễn Văn A');
    expect(one.books.map((b) => b.book)).toEqual(['S1a']);
    // Group 2 on a percentage of revenue keeps S2a; group 3 on income keeps S2b to S2e.
    await setProfile(o, { effectiveFrom: '2026-07-01', taxGroup: 2, pitMethod: 'percentage', trades: ['goods', 'services'], einvoiceRegistered: true });
    await setProfile(o, { effectiveFrom: '2027-01-01', taxGroup: 3, pitMethod: 'income' });
    expect((await profileAt(o, '2026-12-31')).books.map((b) => b.book)).toEqual(['S2a']);
    expect((await profileAt(o, '2027-01-01')).books.map((b) => b.book)).toEqual(['S2b', 'S2c', 'S2d', 'S2e']);
    // A change is a new row: the earlier period keeps the profile it was made under.
    expect((await profileAt(o, '2026-06-30')).profile).toMatchObject({ taxGroup: 1, trades: ['goods'] });
    expect((await profileAt(o, '2026-07-01')).profile).toMatchObject({ taxGroup: 2, pitMethod: 'percentage', trades: ['goods', 'services'], einvoiceRegistered: true });
    // Group 2 may choose the income method.
    await setProfile(o, { effectiveFrom: '2027-07-01', taxGroup: 2, pitMethod: 'income' });
    expect((await profileAt(o, '2027-07-01')).books.map((b) => b.book)).toEqual(['S2b', 'S2c', 'S2d', 'S2e']);
  });

  it('says every book is commentary until the accountant confirms the row', async () => {
    const o = await org();
    const view = await setProfile(o);
    expect(view.commentary).toBe(true);
    expect(view.books).toEqual([expect.objectContaining({ book: 'S1a', version: '2026.1', status: 'commentary' })]);
  });

  it('refuses a group and method that do not fit, and an entity that is not a household', async () => {
    const o = await org();
    for (const bad of [
      { taxGroup: 1, pitMethod: 'income' },
      { taxGroup: 2, pitMethod: null },
      { taxGroup: 3, pitMethod: 'percentage' },
      { taxGroup: 3, pitMethod: null },
    ]) {
      await expect(setProfile(o, bad)).rejects.toMatchObject({ code: 'HOUSEHOLD_PROFILE_METHOD' });
    }
    await expect(setProfile(o, { legalEntityId: o.company })).rejects.toMatchObject({ code: 'HOUSEHOLD_NOT_HOUSEHOLD' });
    for (const bad of [{ taxGroup: 4 }, { taxGroup: 0 }, { trades: [] }, { trades: ['cars'] }, { trades: ['goods', 'goods'] }, { effectiveFrom: '2026-13-01' }, { representativeName: '' }]) {
      await expect(setProfile(o, bad)).rejects.toMatchObject({ code: 'VALIDATION' });
    }
    // The database holds the kind rule too, for a writer that skips the command.
    await expect(admin((c) => c.query("INSERT INTO crove_finance.household_profile (org_id, legal_entity_id, effective_from, tax_group) VALUES ($1, $2, '2026-01-01', 1)", [o.orgId, o.company]))).rejects.toMatchObject({
      message: expect.stringContaining('HOUSEHOLD_PROFILE_KIND'),
    });
  });

  it('refuses a date more than a year ahead, which could never be corrected', async () => {
    const o = await org();
    await expect(setProfile(o, { effectiveFrom: '2206-01-01' })).rejects.toMatchObject({ code: 'HOUSEHOLD_PROFILE_DATE' });
    await expect(setProfile(o, { effectiveFrom: '1999-12-31' })).rejects.toMatchObject({ code: 'HOUSEHOLD_PROFILE_DATE' });
    await setProfile(o, { effectiveFrom: `${new Date().getFullYear() + 1}-12-31` });
  });

  it('shows no profile and no book for an entity whose kind was changed away from household', async () => {
    const o = await org();
    await setProfile(o);
    expect((await profileAt(o, '2026-06-30')).books).toHaveLength(1);
    await admin((c) => c.query("UPDATE crove_kernel.legal_entity SET kind = 'company' WHERE org_id = $1 AND id = $2", [o.orgId, o.household]));
    expect(await profileAt(o, '2026-06-30')).toEqual({ date: '2026-06-30', profile: null, books: [], commentary: false });
  });

  it('lets a later version retire a book from a method', async () => {
    const o = await org();
    await setProfile(o, { taxGroup: 3, pitMethod: 'income' });
    expect((await profileAt(o, '2026-12-31')).books.map((b) => b.book)).toEqual(['S2b', 'S2c', 'S2d', 'S2e']);
    await admin((c) =>
      c.query("INSERT INTO crove_finance.household_form_version (book, version, effective_from, name, pit_methods, source, status) VALUES ('S2e', '2027.1', '2027-01-01', 'Sổ chi tiết tiền', '{}', 'a retiring version (test)', 'confirmed')"),
    );
    expect((await profileAt(o, '2026-12-31')).books.map((b) => b.book)).toEqual(['S2b', 'S2c', 'S2d', 'S2e']);
    expect((await profileAt(o, '2027-06-01')).books.map((b) => b.book)).toEqual(['S2b', 'S2c', 'S2d']);
  });

  it('takes a new profile only after the latest one and after a locked period', async () => {
    const o = await org();
    await setProfile(o, { effectiveFrom: '2026-03-01' });
    for (const date of ['2026-03-01', '2026-02-01']) await expect(setProfile(o, { effectiveFrom: date, taxGroup: 2, pitMethod: 'percentage' })).rejects.toMatchObject({ code: 'HOUSEHOLD_PROFILE_ORDER' });
    await admin((c) =>
      c.query("INSERT INTO crove_finance.period_lock (org_id, legal_entity_id, locked_from, locked_through) VALUES ($1, $2, '2026-01-01', '2026-06-30')", [o.orgId, o.household]),
    );
    await expect(setProfile(o, { effectiveFrom: '2026-06-30', taxGroup: 2, pitMethod: 'percentage' })).rejects.toMatchObject({ code: 'HOUSEHOLD_PROFILE_LOCKED' });
    await setProfile(o, { effectiveFrom: '2026-07-01', taxGroup: 2, pitMethod: 'percentage' });
    expect((await profileAt(o, '2026-06-30')).profile?.taxGroup).toBe(1);
  });

  it('lets owners and admins set a profile, every role read it, and keeps the name out of the audit row', async () => {
    const o = await org();
    await setProfile(o, {}, o.admin);
    await expect(setProfile(o, { effectiveFrom: '2026-09-01', taxGroup: 2, pitMethod: 'percentage' }, o.member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(setProfile(o, { effectiveFrom: '2026-09-01', taxGroup: 2, pitMethod: 'percentage' }, o.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const who of [o.owner, o.admin, o.member, o.viewer]) expect((await profileAt(o, '2026-06-30', who)).profile?.taxGroup).toBe(1);
    const rows = await admin(async (c) => (await c.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM crove_kernel.audit_event WHERE org_id = $1 AND command = 'finance.household.profile_set' AND outcome = 'ok'`, [o.orgId])).rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ legalEntityId: o.household, effectiveFrom: '2026-01-01', taxGroup: 1, pitMethod: null, trades: ['goods'], einvoiceRegistered: false });
    expect(JSON.stringify(rows[0]?.detail)).not.toContain('Nguyễn');
  });

  it("shows another org's household nothing", async () => {
    const a = await org();
    const b = await org();
    await setProfile(a);
    await expect(query(b, 'finance.household.profile_get', { legalEntityId: a.household })).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    const seen = await admin(async (c) => (await c.query('SELECT 1 FROM crove_finance.household_profile WHERE org_id = $1', [b.orgId])).rowCount);
    expect(seen).toBe(0);
  });

  it('never lets a tenant role change a profile or the law, and a profile row never changes in place', async () => {
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    const client = new pg.Client({ connectionString: app.toString() });
    await client.connect();
    try {
      for (const table of ['household_threshold', 'household_trade_rate', 'household_expense_group_map', 'household_form_version', 'household_profile']) {
        await expect(client.query(`DELETE FROM crove_finance.${table}`)).rejects.toMatchObject({ code: '42501' });
        await expect(client.query(`UPDATE crove_finance.${table} SET source = source`)).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|42703)$/) });
      }
    } finally {
      await client.end();
    }
  });

  it('seeds the law as dated rows, all still commentary, and reads the row in force on a date', async () => {
    const o = await org();
    const rules = await query<HouseholdRules>(o, 'finance.household.rules', { date: '2026-06-30' }, o.viewer);
    expect(rules.commentary).toBe(true);
    expect(rules.thresholds.map((t) => t.code).sort()).toEqual(['income_method_revenue', 'no_tax_revenue']);
    expect(rules.thresholds.find((t) => t.code === 'no_tax_revenue')).toMatchObject({ amount: '1000000000.0000', status: 'commentary', effectiveFrom: '2026-01-01' });
    // The e-invoice threshold starts on 2026-07-01.
    expect((await query<HouseholdRules>(o, 'finance.household.rules', { date: '2026-07-01' })).thresholds.map((t) => t.code)).toContain('einvoice_mandatory_revenue');
    expect(rules.tradeRates.map((r) => [r.trade, r.vatPercent, r.pitPercent])).toEqual(
      expect.arrayContaining([
        ['goods', '1.0000', '0.5000'],
        ['services', '5.0000', '2.0000'],
      ]),
    );
    expect(rules.forms.map((f) => f.book).sort()).toEqual(['S1a', 'S2a', 'S2b', 'S2c', 'S2d', 'S2e']);
    expect([...rules.thresholds, ...rules.tradeRates, ...rules.expenseGroups, ...rules.forms].every((r) => r.status === 'commentary' && r.source.length > 0)).toBe(true);
    // Before the first row there is nothing in force.
    const early = await query<HouseholdRules>(o, 'finance.household.rules', { date: '2025-12-31' });
    expect([early.thresholds, early.tradeRates, early.expenseGroups, early.forms].every((l) => l.length === 0)).toBe(true);
  });

  it('changes a rate for the periods from a new dated row and for none before it', async () => {
    const o = await org();
    await admin((c) =>
      c.query(
        "INSERT INTO crove_finance.household_trade_rate (trade, effective_from, vat_percent, pit_percent, source, status) VALUES ('goods', '2027-01-01', 2, 1, 'a later dated row (test)', 'confirmed')",
      ),
    );
    const goods = async (date: string) => (await query<HouseholdRules>(o, 'finance.household.rules', { date })).tradeRates.find((r) => r.trade === 'goods');
    expect(await goods('2026-12-31')).toMatchObject({ vatPercent: '1.0000', pitPercent: '0.5000', status: 'commentary' });
    expect(await goods('2027-01-01')).toMatchObject({ vatPercent: '2.0000', pitPercent: '1.0000', status: 'confirmed', effectiveFrom: '2027-01-01' });
    expect(await goods('2030-05-05')).toMatchObject({ vatPercent: '2.0000' });
  });

  // An entry of the household's ledger written by the database owner (the triggers fire as for any writer), with its lines; `reverses` makes it the reversal of another entry.
  async function entry(entity: string, orgId: string, date: string, description: string, lines: Array<[string, number, number]>, over: { invoice?: { series: string; number: string; total: number }; reverses?: string } = {}): Promise<string> {
    return admin(async (a) => {
      await a.query('BEGIN');
      try {
        // A sales document is posted in the same transaction as its entry.
        let document: string | null = null;
        if (over.invoice) {
          const party = (await a.query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name) VALUES ($1, 'Khách lẻ') RETURNING id", [orgId])).rows[0]?.id;
          document = (
            await a.query<{ id: string }>(
              "INSERT INTO crove_finance.purchase_document (org_id, party_id, invoice_series, invoice_number, invoice_date, subtotal, vat_amount, total, direction, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6, 0, $6, 'sale', $7) RETURNING id",
              [orgId, party, over.invoice.series, over.invoice.number, date, over.invoice.total, entity],
            )
          ).rows[0]?.id as string;
        }
        const id = (
          await a.query<{ id: string }>(
            `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id, reverses_entry_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
            [orgId, date, description, document ? 'finance.purchase_document' : 'finance.journal_voucher', document ?? randomUUID(), entity, over.reverses ?? null],
          )
        ).rows[0]?.id as string;
        let no = 1;
        for (const [account, debit, credit] of lines) await a.query('INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, no++, account, debit, credit]);
        await a.query('COMMIT');
        return id;
      } catch (error) {
        await a.query('ROLLBACK');
        throw error;
      }
    });
  }
  const s1a = (o: Org, period: string, entity = o.household, user = o.owner) => query<HouseholdS1a>(o, 'finance.household.s1a', { legalEntityId: entity, period }, user);

  it('lists the sales of the household from account 511 and its total ties to the ledger', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o.household, o.orgId, '2026-09-05', 'Bán có hóa đơn', [['131', 100000, 0], ['511', 0, 100000]], { invoice: { series: '1C26TAA', number: '00000042', total: 100000 } });
    const retail = await entry(o.household, o.orgId, '2026-09-12', 'Bán hàng lẻ', [['111', 60000, 0], ['511', 0, 60000]]);
    await entry(o.household, o.orgId, '2026-09-20', 'Bán dịch vụ', [['111', 250000, 0], ['5111', 0, 250000]]);
    await entry(o.household, o.orgId, '2026-09-25', 'Đảo bán hàng lẻ', [['111', 0, 60000], ['511', 60000, 0]], { reverses: retail });
    // Not sales: other income, a purchase, an entry of the org's company entity, and a sale outside the period.
    await entry(o.household, o.orgId, '2026-09-10', 'Lãi tiền gửi', [['112', 5000, 0], ['515', 0, 5000]]);
    await entry(o.household, o.orgId, '2026-09-13', 'Mua hàng', [['156', 70000, 0], ['111', 0, 70000]]);
    await entry(o.company, o.orgId, '2026-09-14', 'Bán của công ty', [['111', 999000, 0], ['511', 0, 999000]]);
    await entry(o.household, o.orgId, '2026-10-02', 'Bán tháng sau', [['111', 40000, 0], ['511', 0, 40000]]);
    const book = await s1a(o, '2026-09');
    expect(book.period).toEqual({ period: '2026-09', from: '2026-09-01', to: '2026-09-30' });
    expect(book.household).toEqual({ name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A', openedOn: '2026-01-01' });
    expect(book.form).toMatchObject({ book: 'S1a', status: 'commentary' });
    expect(book.rows.map((r) => [r.date, r.description, r.amount, r.reversal, r.reference])).toEqual([
      ['2026-09-05', 'Bán có hóa đơn', '100000', false, '1C26TAA-00000042'],
      ['2026-09-12', 'Bán hàng lẻ', '60000', false, null],
      ['2026-09-20', 'Bán dịch vụ', '250000', false, null],
      ['2026-09-25', 'Đảo bán hàng lẻ', '-60000', true, null],
    ]);
    expect(book.total).toBe('350000');
    // The total is the ledger's own movement of account 511 for the period: credit less debit.
    const ledger = await query<{ debit: string; credit: string }>(o, 'finance.ledger.account', { period: '2026-09', legalEntityId: o.household, accountCode: '511' });
    expect(Number(ledger.credit) - Number(ledger.debit)).toBe(Number(book.total));
    // A quarter and a year hold the months.
    expect((await s1a(o, '2026-Q3')).total).toBe('350000');
    expect((await s1a(o, '2026')).total).toBe('390000');
    // The company's own sale is in the company's ledger, not the household's book.
    expect(book.rows.some((r) => r.description === 'Bán của công ty')).toBe(false);
  });

  it('refuses the book to a household whose method does not need it, an entity that is not a household, and a period over a change', async () => {
    const o = await org();
    await expect(s1a(o, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    await setProfile(o, { effectiveFrom: '2026-01-01' });
    await setProfile(o, { effectiveFrom: '2026-10-01', taxGroup: 2, pitMethod: 'percentage' });
    expect((await s1a(o, '2026-Q3')).rows).toEqual([]);
    for (const period of ['2026-Q4', '2026-10', '2026']) await expect(s1a(o, period)).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    await expect(s1a(o, '2026-09', o.company)).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
    const g3 = await org();
    await setProfile(g3, { taxGroup: 3, pitMethod: 'income' });
    await expect(s1a(g3, '2026-09')).rejects.toMatchObject({ code: 'HOUSEHOLD_BOOK_NOT_REQUIRED' });
  });

  it('lets every role read the book', async () => {
    const o = await org();
    await setProfile(o);
    for (const who of [o.owner, o.admin, o.member, o.viewer]) expect((await s1a(o, '2026-09', o.household, who)).total).toBe('0');
  });
});

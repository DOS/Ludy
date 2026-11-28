// SPDX-License-Identifier: AGPL-3.0-only
// The year-end checklist of the Kế toán app, on PostgreSQL 17 (finance.year_end): every item is a state or a count read from the books for one org, one legal entity and one year, and each is
// checked here against rows the test made: the 131, 331, 3387 and 141 balances at the year's last day, the asset months not depreciated, the stock count in December, the period lock, the company
// returns marked done on the tax calendar with their due dates, a household's fourth-quarter return (an export of it was recorded), the e-invoice series of the new year, and the items that do not
// apply. The years are fixed (2024 is over, 2099 is not) so the result does not depend on the day the suite runs. Another org and another entity see nothing of it, and a viewer reads it too. The
// rules are unit-tested in modules/finance/test/year-end.test.ts.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { YearEnd, YearEndKey } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the year-end checklist', () => {
  const dbName = `ludy_test_year_end_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let o: { orgId: string; owner: string; viewer: string };
  let other: { orgId: string; owner: string };
  let defaultEntity = '';
  let branch = '';
  let household = '';
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
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@yearend.test`, name: null });

  const yearEnd = (year: number, user = o.owner, orgId = o.orgId, legalEntityId?: string) =>
    rt.query<YearEnd>('finance.year_end', { year, ...(legalEntityId ? { legalEntityId } : {}) }, { actor: asUser(user), orgId });
  const item = (view: YearEnd, key: YearEndKey) => view.items.find((i) => i.key === key);

  const party = (name: string) => {
    const id = randomUUID();
    return admin((c) => c.query("INSERT INTO ludy_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', $3)", [o.orgId, id, name])).then(() => id);
  };
  // One balanced journal entry, as the commands write one.
  async function entry(date: string, lines: Array<{ account: string; debit?: string; credit?: string; party?: string | null }>, entity = defaultEntity): Promise<string> {
    return admin(async (c) => {
      await c.query('BEGIN');
      const id = randomUUID();
      await c.query(`INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'year-end test', 'finance.journal_voucher', $4, $5)`, [o.orgId, id, date, randomUUID(), entity]);
      let n = 1;
      for (const l of lines) {
        await c.query(`INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [o.orgId, id, n++, l.account, l.debit ?? '0', l.credit ?? '0', l.party ?? null, entity]);
      }
      await c.query('COMMIT');
      return id;
    });
  }

  // A confirmed count as it stands once the command has confirmed it. The command needs counted lines and a voucher or a match with the books, which is not what this suite is about, so the
  // row is written with the triggers off (the guard that makes a count start as a draft, and the deferred one that ties a confirmed count to its voucher), as other suites write such rows.
  const confirmedCount = (date: string) =>
    admin(async (c) => {
      await c.query('BEGIN');
      await c.query("SET LOCAL session_replication_role = 'replica'");
      await c.query("INSERT INTO ludy_finance.stock_count (org_id, legal_entity_id, count_date, status, confirmed_at, confirmed_by, created_by) VALUES ($1, $2, $3, 'confirmed', now(), $4, $4)", [o.orgId, defaultEntity, date, o.owner]);
      await c.query('COMMIT');
    });

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });

    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    o = { orgId, owner, viewer: await person('viewer') };
    await admin((c) => c.query('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, o.viewer, 'viewer']));
    defaultEntity = String((await admin((c) => c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))).rows[0]?.id);
    branch = String((await admin((c) => c.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner]))).rows[0]?.id);
    household = String((await admin((c) => c.query<{ id: string }>(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Hộ kinh doanh A', 'household', $2) RETURNING id`, [orgId, owner]))).rows[0]?.id);
    const lone = await person('lone');
    other = { orgId: (await createOrg(rt, asUser(lone), `Org ${randomUUID().slice(0, 6)}`)).orgId, owner: lone };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('reads an org with nothing in it: done on the balances, not applicable where nothing is kept, and open on the closing entry and the lock', async () => {
    const view = await yearEnd(2024);
    expect(view).toMatchObject({ year: 2024, legalEntityId: defaultEntity, over: true });
    expect(view.items.map((i) => i.key)).toEqual(['balances', 'depreciation', 'stock_count', 'closing_entry', 'months_locked', 'statements', 'cit', 'pit', 'household_return', 'einvoice_series']);
    expect(item(view, 'balances')).toEqual({ key: 'balances', state: 'done', waiting: false, count: 0, due: null });
    for (const key of ['depreciation', 'stock_count', 'statements', 'cit', 'pit', 'household_return', 'einvoice_series'] as const) expect(item(view, key)?.state, key).toBe('na');
    expect(item(view, 'closing_entry')).toEqual({ key: 'closing_entry', state: 'open', waiting: false, count: 1, due: null });
    expect(item(view, 'months_locked')).toMatchObject({ state: 'open', waiting: false });
    // A year that has not ended yet: what needs the year to end waits.
    const future = await yearEnd(2099);
    expect(future.over).toBe(false);
    expect(item(future, 'closing_entry')).toMatchObject({ state: 'open', waiting: true });
    expect(item(future, 'months_locked')).toMatchObject({ state: 'open', waiting: true });
  });

  it('counts the balances to look at at the year end: a customer credit, a supplier advance, 3387 and 141, and no other', async () => {
    const credit = await party('Khách trả thừa');
    const advance = await party('Nhà cung cấp tạm ứng');
    const normal = await party('Khách còn nợ');
    const later = await party('Nhà cung cấp năm sau');
    // 131 with a credit balance, 331 with a debit balance, 3387 and 141 with any balance: four. A 131 with a debit balance is normal.
    await entry('2024-11-10', [{ account: '112', debit: '700000' }, { account: '131', credit: '700000', party: credit }]);
    await entry('2024-11-11', [{ account: '331', debit: '300000', party: advance }, { account: '112', credit: '300000' }]);
    await entry('2024-11-12', [{ account: '131', debit: '900000', party: normal }, { account: '511', credit: '900000' }]);
    await entry('2024-11-13', [{ account: '112', debit: '50000' }, { account: '3387', credit: '50000' }]);
    await entry('2024-11-14', [{ account: '141', debit: '40000' }, { account: '112', credit: '40000' }]);
    // After the year's last day: not counted for 2024.
    await entry('2025-01-05', [{ account: '331', debit: '10000', party: later }, { account: '112', credit: '10000' }]);
    expect(item(await yearEnd(2024), 'balances')).toEqual({ key: 'balances', state: 'open', waiting: false, count: 4, due: null });
    // A balance that is settled in the same year is not left: the customer's credit is paid back on 20 December.
    await entry('2024-12-20', [{ account: '131', debit: '700000', party: credit }, { account: '112', credit: '700000' }]);
    expect(item(await yearEnd(2024), 'balances')?.count).toBe(3);
    // The year before has none of it, the branch has none, another org sees none, and a viewer reads the same as the owner.
    expect(item(await yearEnd(2023), 'balances')?.state).toBe('done');
    expect(item(await yearEnd(2024, o.owner, o.orgId, branch), 'balances')?.state).toBe('done');
    expect(item(await yearEnd(2024, other.owner, other.orgId), 'balances')?.state).toBe('done');
    expect(item(await yearEnd(2024, o.viewer), 'balances')?.count).toBe(3);
  });

  it('counts the asset months of the year with no depreciation line, and is done once December is posted', async () => {
    const asset = randomUUID();
    await admin((c) =>
      c.query(
        `INSERT INTO ludy_finance.fixed_asset (org_id, id, kind, name, cost, asset_account, accumulated_account, expense_account, start_month, months, legal_entity_id)
         VALUES ($1, $2, 'fixed_asset', 'Máy in', 1200000, '211', '214', '6422', '2024-01-01', 12, $3)`,
        [o.orgId, asset, defaultEntity],
      ),
    );
    const post = async (month: string) => {
      const id = await entry(`${month.slice(0, 8)}28`, [{ account: '6422', debit: '100000' }, { account: '214', credit: '100000' }]);
      await admin((c) => c.query('INSERT INTO ludy_finance.depreciation_line (org_id, asset_id, month, amount, entry_id, legal_entity_id) VALUES ($1, $2, $3, 100000, $4, $5)', [o.orgId, asset, month, id, defaultEntity]));
    };
    // Twelve months, none posted: all of them have ended in 2024.
    expect(item(await yearEnd(2024), 'depreciation')).toEqual({ key: 'depreciation', state: 'open', waiting: false, count: 12, due: null });
    for (const m of ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11']) await post(`2024-${m}-01`);
    expect(item(await yearEnd(2024), 'depreciation')?.count).toBe(1);
    await post('2024-12-01');
    expect(item(await yearEnd(2024), 'depreciation')).toEqual({ key: 'depreciation', state: 'done', waiting: false, count: 0, due: null });
    // The branch has no asset, and a year the asset has not started in (nothing to post) that has not ended waits.
    expect(item(await yearEnd(2024, o.owner, o.orgId, branch), 'depreciation')?.state).toBe('na');
    expect(item(await yearEnd(2099), 'depreciation')).toEqual({ key: 'depreciation', state: 'open', waiting: true, count: 0, due: null });
  });

  it('asks for a confirmed stock count dated in December, only where stock is kept', async () => {
    expect(item(await yearEnd(2024), 'stock_count')?.state).toBe('na');
    await admin((c) => c.query("INSERT INTO ludy_finance.stock_item (org_id, legal_entity_id, code, name, unit, stock_account) VALUES ($1, $2, 'HH1', 'Hàng 1', 'cái', '156')", [o.orgId, defaultEntity]));
    expect(item(await yearEnd(2024), 'stock_count')).toEqual({ key: 'stock_count', state: 'open', waiting: false, count: 1, due: null });
    // A draft, a count dated in November and a cancelled one are not it.
    await admin((c) => c.query("INSERT INTO ludy_finance.stock_count (org_id, legal_entity_id, count_date, created_by) VALUES ($1, $2, '2024-12-20', $3)", [o.orgId, defaultEntity, o.owner]));
    await confirmedCount('2024-11-30');
    expect(item(await yearEnd(2024), 'stock_count')?.state).toBe('open');
    await confirmedCount('2024-12-30');
    expect(item(await yearEnd(2024), 'stock_count')).toEqual({ key: 'stock_count', state: 'done', waiting: false, count: 0, due: null });
    // The branch keeps no stock.
    expect(item(await yearEnd(2024, o.owner, o.orgId, branch), 'stock_count')?.state).toBe('na');
  });

  it('is done on the lock once it runs through the last day of the year', async () => {
    await rt.execute('finance.period.lock', { month: '2024-11' }, { actor: asMfa(o.owner), orgId: o.orgId });
    expect(item(await yearEnd(2024), 'months_locked')?.state).toBe('open');
    await rt.execute('finance.period.lock', { month: '2024-12' }, { actor: asMfa(o.owner), orgId: o.orgId });
    expect(item(await yearEnd(2024), 'months_locked')).toEqual({ key: 'months_locked', state: 'done', waiting: false, count: 0, due: null });
    // The branch locked nothing.
    expect(item(await yearEnd(2024, o.owner, o.orgId, branch), 'months_locked')?.state).toBe('open');
  });

  it('lists the company returns the tax calendar turned on, with the due date from its rules, and done once marked', async () => {
    await admin((c) =>
      c.query("INSERT INTO ludy_kernel.tax_profile (org_id, obligations, fiscal_year_end_month, updated_by) VALUES ($1, ARRAY['financial_statements', 'cit_finalization'], 12, $2)", [o.orgId, o.owner]),
    );
    const view = await yearEnd(2024);
    // 31 March 2025 is a Monday: 90 days after 31 December 2024, and the last day of the third month.
    expect(item(view, 'statements')).toEqual({ key: 'statements', state: 'open', waiting: false, count: 1, due: '2025-03-31' });
    expect(item(view, 'cit')).toEqual({ key: 'cit', state: 'open', waiting: false, count: 1, due: '2025-03-31' });
    // PIT finalization is not on this org's calendar.
    expect(item(view, 'pit')?.state).toBe('na');
    await admin((c) => c.query("INSERT INTO ludy_kernel.tax_obligation_done (org_id, obligation, period, done_by, legal_entity_id) VALUES ($1, 'cit_finalization', '2024', $2, $3)", [o.orgId, o.owner, defaultEntity]));
    expect(item(await yearEnd(2024), 'cit')?.state).toBe('done');
    expect(item(await yearEnd(2024), 'statements')?.state).toBe('open');
    // A mark of another entity or another year is not this one's.
    await admin((c) => c.query("INSERT INTO ludy_kernel.tax_obligation_done (org_id, obligation, period, done_by, legal_entity_id) VALUES ($1, 'financial_statements', '2024', $2, $3)", [o.orgId, o.owner, branch]));
    await admin((c) => c.query("INSERT INTO ludy_kernel.tax_obligation_done (org_id, obligation, period, done_by, legal_entity_id) VALUES ($1, 'financial_statements', '2023', $2, $3)", [o.orgId, o.owner, defaultEntity]));
    expect(item(await yearEnd(2024), 'statements')?.state).toBe('open');
    expect(item(await yearEnd(2024, o.owner, o.orgId, branch), 'statements')?.state).toBe('done');
  });

  it('asks a household that files by percentage for the fourth quarter worksheet, done once an export of it was recorded', async () => {
    await admin((c) => c.query("INSERT INTO ludy_finance.household_profile (org_id, legal_entity_id, effective_from, tax_group, pit_method) VALUES ($1, $2, '2024-01-01', 2, 'percentage')", [o.orgId, household]));
    const open = await yearEnd(2024, o.owner, o.orgId, household);
    // 31 January 2025 is a Friday.
    expect(item(open, 'household_return')).toEqual({ key: 'household_return', state: 'open', waiting: false, count: 1, due: '2025-01-31' });
    for (const key of ['closing_entry', 'statements', 'cit', 'pit'] as const) expect(item(open, key)?.state, key).toBe('na');
    // An export of another quarter or another book is not it.
    await rt.execute('finance.household.export', { legalEntityId: household, book: '01/CNKD', period: '2024-Q3', rows: 3 }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(item(await yearEnd(2024, o.owner, o.orgId, household), 'household_return')?.state).toBe('open');
    await rt.execute('finance.household.export', { legalEntityId: household, book: '01/CNKD', period: '2024-Q4', rows: 3 }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(item(await yearEnd(2024, o.owner, o.orgId, household), 'household_return')).toEqual({ key: 'household_return', state: 'done', waiting: false, count: 0, due: '2025-01-31' });
    // A company has no such item.
    expect(item(await yearEnd(2024), 'household_return')?.state).toBe('na');
  });

  it('asks an entity with an e-invoice connection for a series of the new year', async () => {
    const channel = randomUUID();
    await admin((c) => c.query(`INSERT INTO ludy_kernel.channel_connection (org_id, id, provider, external_account_id, display_name, connected_by) VALUES ($1, $2, 'einvoice_sandbox', $3, 'Hóa đơn', $4)`, [o.orgId, channel, `ext-${randomUUID()}`, o.owner]));
    await admin((c) => c.query(`INSERT INTO ludy_finance.einvoice_connection (org_id, legal_entity_id, channel_connection_id, provider, seller_tax_code) VALUES ($1, $2, $3, 'einvoice_sandbox', '0123456799')`, [o.orgId, branch, channel]));
    expect(item(await yearEnd(2024, o.owner, o.orgId, branch), 'einvoice_series')).toEqual({ key: 'einvoice_series', state: 'open', waiting: false, count: 1, due: null });
    // A series of the year itself is not one of the new year; one whose symbol carries the next year is.
    await admin((c) => c.query("INSERT INTO ludy_finance.einvoice_series (org_id, legal_entity_id, provider, template_no, symbol) VALUES ($1, $2, 'einvoice_sandbox', '1', 'C24TAA')", [o.orgId, branch]));
    expect(item(await yearEnd(2024, o.owner, o.orgId, branch), 'einvoice_series')?.state).toBe('open');
    await admin((c) => c.query("INSERT INTO ludy_finance.einvoice_series (org_id, legal_entity_id, provider, template_no, symbol) VALUES ($1, $2, 'einvoice_sandbox', '1', 'C25TAA')", [o.orgId, branch]));
    expect(item(await yearEnd(2024, o.owner, o.orgId, branch), 'einvoice_series')?.state).toBe('done');
    // The default entity has no connection.
    expect(item(await yearEnd(2024), 'einvoice_series')?.state).toBe('na');
  });

  it('refuses a year outside the contract and an entity of another org', async () => {
    await expect(rt.query('finance.year_end', { year: 1999 }, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toBeDefined();
    await expect(rt.query('finance.year_end', { year: 2024, legalEntityId: defaultEntity }, { actor: asUser(other.owner), orgId: other.orgId })).rejects.toBeDefined();
  });
});

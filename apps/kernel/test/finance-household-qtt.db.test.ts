// SPDX-License-Identifier: AGPL-3.0-only
// The annual PIT finalization worksheet 02/CNKD-TNCN-QTT of a household on the income method (#5285), on PostgreSQL 17: the year of the ledger's account 511 (an entry outside the year or of another entity
// left out), the platform revenue of the stored settlements (a reversed one left out), the deductible costs of S2c by group, the band of the income-method rate, the tax withheld and prepaid the household
// enters, the 30% cut of Decree 398 on both sides, what is held (revenue at or under the threshold, a cost no group covers, a year closed to 911), the cases it refuses (no profile, group 1, the
// revenue-percentage method, a profile that changes inside the year) and the law rows the migration seeds. The seeded law rows are `confirmed` and the threshold, the rates and the cut are the real ones
// (1 billion VND, 15/17/20%, 30% up to 10 billion). Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { HouseholdProfileView, HouseholdQtt } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the 02/CNKD-TNCN-QTT annual worksheet of a household business (#5285)', () => {
  const dbName = `ludy_test_household_qtt_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    await admin((c) => c.query("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer]));
    const company = (await admin((c) => c.query<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))).rows[0]?.id as string;
    const household = randomUUID();
    await admin((c) => c.query("INSERT INTO ludy_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Hộ kinh doanh Nguyễn Văn A', 'household', $3)", [orgId, household, owner]));
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
  const qtt = (o: Org, over: Record<string, unknown> = {}, entity = o.household, user = o.owner) => query<HouseholdQtt>(o, 'finance.household.qtt', { legalEntityId: entity, year: 2026, ...over }, user);
  const line = (w: HouseholdQtt, code: string) => w.lines.find((l) => l.code === code)?.amount;

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
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  // An entry of the ledger written by the database owner (the triggers fire as for any writer), with its lines.
  async function entry(entity: string, orgId: string, date: string, description: string, lines: Array<[string, number, number]>): Promise<string> {
    return admin(async (a) => {
      await a.query('BEGIN');
      try {
        const id = (
          await a.query<{ id: string }>(
            'INSERT INTO ludy_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
            [orgId, date, description, 'finance.journal_voucher', randomUUID(), entity],
          )
        ).rows[0]?.id as string;
        let no = 1;
        for (const [account, debit, credit] of lines) await a.query('INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, $3, $4, $5, $6)', [orgId, id, no++, account, debit, credit]);
        await a.query('COMMIT');
        return id;
      } catch (error) {
        await a.query('ROLLBACK');
        throw error;
      }
    });
  }
  // A settlement of the household with one line of `sales` and no withheld tax; `reversalOf` makes it the reversal of another one (it states the negative net and its line repeats the original's, marked as
  // an adjustment, as the guard demands).
  async function settlement(o: Org, start: string, end: string, sales: number, reversalOf: string | null = null): Promise<string> {
    return admin(async (a) => {
      await a.query('BEGIN');
      const id = randomUUID();
      let order: string = randomUUID();
      if (reversalOf) order = (await a.query<{ order_id: string }>('SELECT order_id FROM ludy_finance.channel_settlement_line WHERE org_id = $1 AND settlement_id = $2', [o.orgId, reversalOf])).rows[0]?.order_id as string;
      else await a.query('INSERT INTO ludy_finance.channel_order (org_id, id, legal_entity_id, platform, order_no) VALUES ($1, $2, $3, $4, $5)', [o.orgId, order, o.household, 'shopee', `ST${randomUUID().slice(0, 12)}`]);
      await a.query('INSERT INTO ludy_finance.channel_settlement (org_id, id, legal_entity_id, platform, period_start, period_end, report_net, reversal_of) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [o.orgId, id, o.household, 'shopee', start, end, reversalOf ? -sales : sales, reversalOf]);
      await a.query('INSERT INTO ludy_finance.channel_settlement_line (org_id, id, legal_entity_id, settlement_id, order_id, line_key, sales, tax_withheld, net, adjustment) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $7, $8)', [o.orgId, randomUUID(), o.household, id, order, 'L1', sales, reversalOf !== null]);
      await a.query('COMMIT');
      return id;
    });
  }

  // The year of a household on the income method: sales of 1.2 billion and 600 million, costs of goods 700 million, administration 150 million and loan interest 20 million; entries outside the year and
  // of the company are in the ledger too and must not count.
  async function year(o: Org) {
    await setProfile(o);
    await entry(o.household, o.orgId, '2026-03-10', 'Bán hàng', [['111', 1_200_000_000, 0], ['511', 0, 1_200_000_000]]);
    await entry(o.household, o.orgId, '2026-09-20', 'Bán hàng', [['111', 600_000_000, 0], ['511', 0, 600_000_000]]);
    await entry(o.household, o.orgId, '2025-12-31', 'Bán năm trước', [['111', 777_000, 0], ['511', 0, 777_000]]);
    await entry(o.household, o.orgId, '2027-01-02', 'Bán năm sau', [['111', 555_000, 0], ['511', 0, 555_000]]);
    await entry(o.company, o.orgId, '2026-05-05', 'Bán của công ty', [['111', 999_000_000, 0], ['511', 0, 999_000_000]]);
    await entry(o.household, o.orgId, '2026-04-01', 'Giá vốn', [['632', 700_000_000, 0], ['111', 0, 700_000_000]]);
    await entry(o.household, o.orgId, '2026-06-01', 'Chi phí quản lý', [['642', 150_000_000, 0], ['111', 0, 150_000_000]]);
    await entry(o.household, o.orgId, '2026-07-01', 'Lãi vay', [['635', 20_000_000, 0], ['111', 0, 20_000_000]]);
    await entry(o.household, o.orgId, '2027-02-01', 'Chi năm sau', [['632', 1_000, 0], ['111', 0, 1_000]]);
    await entry(o.company, o.orgId, '2026-05-06', 'Chi của công ty', [['632', 5_000_000, 0], ['111', 0, 5_000_000]]);
  }

  it('works out the year from the ledger: revenue, costs by group, the 15% band, the tax and the balance', async () => {
    const o = await org();
    await year(o);
    // 300 million on a platform that pays over, and a settlement of 50 million that was reversed (it and its reversal are left out).
    await settlement(o, '2026-06-01', '2026-06-30', 300_000_000);
    const reversed = await settlement(o, '2026-08-01', '2026-08-31', 50_000_000);
    await settlement(o, '2026-08-01', '2026-08-31', 50_000_000, reversed);
    const w = await qtt(o, { withheld: '10000000', prepaid: '50000000' });
    expect(w.period).toMatchObject({ year: 2026, from: '2026-01-01', to: '2026-12-31' });
    expect(w.household).toEqual({ name: 'Hộ kinh doanh Nguyễn Văn A', taxCode: null, representativeName: 'Nguyễn Văn A' });
    expect(w.form).toMatchObject({ form: '02/CNKD-TNCN-QTT', version: '2026.1', status: 'confirmed' });
    // Revenue is the ledger's movement of 511: 1.2 billion + 600 million, with the platform part taken out of [09a].
    expect(line(w, '09')).toBe('1800000000');
    expect(line(w, '09a')).toBe('1500000000');
    expect(line(w, '09b')).toBe('300000000');
    expect(line(w, '09c')).toBe('0');
    expect(line(w, '10a')).toBe('700000000');
    expect(line(w, '10b')).toBe('0');
    expect(line(w, '10đ')).toBe('20000000');
    expect(line(w, '10e')).toBe('150000000');
    expect(line(w, '10')).toBe('870000000');
    expect(line(w, '11')).toBe('930000000');
    // 1.8 billion is in the 15% band: 15% of 930 million = 139.5 million; less 10 million withheld and 50 million prepaid.
    expect(line(w, '12')).toBe('15');
    expect(line(w, '13')).toBe('139500000');
    expect(line(w, '14')).toBe('10000000');
    expect(line(w, '15')).toBe('50000000');
    expect(line(w, '16')).toBe('0');
    expect(line(w, '17')).toBe('79500000');
    expect(line(w, '18')).toBe('0');
    expect(line(w, '19')).toBe('79500000');
    expect(line(w, '20')).toBe('0');
    expect(w.rate).toMatchObject({ revenueOver: '0', percent: '15', status: 'confirmed' });
    expect(w.threshold).toBe('1000000000');
    expect(w.holds).toEqual([]);
    expect(w.unmappedCosts).toBe('0');
    expect(w.entered).toEqual({ withheld: '10000000', prepaid: '50000000', noPaymentRevenue: '0' });
    // The 30% cut has no line on the form: [13] to [20] are before it, and the memo gives both sides (30% of 139.5 million = 41.85 million).
    expect(w.reduction).toMatchObject({ percent: '30', ceiling: '10000000000', applies: true, cut: '41850000' });
    expect(w.reduction?.before).toEqual({ tax: '139500000', payable: '79500000', exempt: '0', due: '79500000', overpaid: '0' });
    expect(w.reduction?.after).toEqual({ tax: '97650000', payable: '37650000', exempt: '0', due: '37650000', overpaid: '0' });
    expect(w.notes).toEqual(expect.arrayContaining(['costs_not_checked', 'reduction_not_in_form']));
    expect(w.notes).not.toContain('withheld_not_entered');
    expect(w.notes).not.toContain('prepaid_not_entered');
    // Everyone who reads the ledger reads it.
    const asViewer = await qtt(o, {}, o.household, o.viewer);
    expect(line(asViewer, '13')).toBe('139500000');
    expect(asViewer.notes).toEqual(expect.arrayContaining(['withheld_not_entered', 'prepaid_not_entered']));
  });

  it('takes the 17% band above 3 billion VND and the tax from the whole income', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o.household, o.orgId, '2026-05-05', 'Bán hàng', [['111', 3_500_000_000, 0], ['511', 0, 3_500_000_000]]);
    await entry(o.household, o.orgId, '2026-06-05', 'Giá vốn', [['632', 1_000_000_000, 0], ['111', 0, 1_000_000_000]]);
    const w = await qtt(o);
    expect(line(w, '11')).toBe('2500000000');
    expect(line(w, '12')).toBe('17');
    expect(line(w, '13')).toBe('425000000');
    expect(w.rate).toMatchObject({ revenueOver: '3000000000', percent: '17' });
  });

  it('holds a revenue at or under the tax-free threshold: no PIT, and the file is refused', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o.household, o.orgId, '2026-05-05', 'Bán hàng', [['111', 900_000_000, 0], ['511', 0, 900_000_000]]);
    const w = await qtt(o);
    expect(w.holds).toEqual(['below_threshold']);
    expect(line(w, '09')).toBe('900000000');
    expect(line(w, '13')).toBeNull();
    await expect(qtt(o, { forExport: true })).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_HELD' });
  });

  it('holds the income while a cost account has no group, and holds a year closed to account 911', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o.household, o.orgId, '2026-05-05', 'Bán hàng', [['111', 1_500_000_000, 0], ['511', 0, 1_500_000_000]]);
    await entry(o.household, o.orgId, '2026-06-05', 'Chi phí bán hàng', [['641', 5_000_000, 0], ['111', 0, 5_000_000]]);
    const unmapped = await qtt(o);
    expect(unmapped.holds).toEqual(['unmapped_costs']);
    expect(unmapped.unmappedCosts).toBe('5000000');
    expect(line(unmapped, '11')).toBeNull();
    await expect(qtt(o, { forExport: true })).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_HELD' });
    await entry(o.household, o.orgId, '2026-12-31', 'Kết chuyển', [['511', 1_500_000_000, 0], ['911', 0, 1_500_000_000]]);
    const closed = await qtt(o);
    expect(closed.holds).toEqual(expect.arrayContaining(['closing_entries']));
    expect(line(closed, '11')).toBeNull();
  });

  it('holds a loss, which no clause treats, and shows the income below zero', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o.household, o.orgId, '2026-05-05', 'Bán hàng', [['111', 1_200_000_000, 0], ['511', 0, 1_200_000_000]]);
    await entry(o.household, o.orgId, '2026-06-05', 'Giá vốn', [['632', 1_500_000_000, 0], ['111', 0, 1_500_000_000]]);
    const w = await qtt(o);
    expect(w.holds).toEqual(['loss']);
    expect(line(w, '11')).toBe('-300000000');
    expect(line(w, '13')).toBeNull();
  });

  it('holds [09a] when the settlements of the year are more than the revenue on the ledger', async () => {
    const o = await org();
    await setProfile(o);
    await entry(o.household, o.orgId, '2026-05-05', 'Bán hàng', [['111', 1_200_000_000, 0], ['511', 0, 1_200_000_000]]);
    await settlement(o, '2026-06-01', '2026-06-30', 1_300_000_000);
    const w = await qtt(o);
    expect(w.holds).toEqual(['platform_split']);
    expect(line(w, '09a')).toBeNull();
    expect(line(w, '09b')).toBe('1300000000');
    // A platform with no payment function entered by the household is part of the split too.
    const entered = await qtt(o, { noPaymentRevenue: '10000000' });
    expect(line(entered, '09c')).toBe('10000000');
  });

  it('refuses the entities and the methods that file no annual finalization, and an input below zero', async () => {
    const none = await org();
    await expect(qtt(none)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_NOT_REQUIRED' });
    await setProfile(none, { taxGroup: 1, pitMethod: null });
    await expect(qtt(none)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_NOT_REQUIRED' });
    // A company has no profile at all.
    await expect(qtt(none, {}, none.company)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_NOT_REQUIRED' });

    const percentage = await org();
    await setProfile(percentage, { taxGroup: 2, pitMethod: 'percentage' });
    await expect(qtt(percentage)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_METHOD' });

    const changed = await org();
    await setProfile(changed);
    await setProfile(changed, { effectiveFrom: '2026-07-01', taxGroup: 2, pitMethod: 'percentage' });
    await expect(qtt(changed)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_PROFILE_CHANGED' });

    const o = await org();
    await setProfile(o);
    await expect(qtt(o, { withheld: '-1' })).rejects.toMatchObject({ code: 'HOUSEHOLD_QTT_INPUT' });
    // A fraction of a dong is refused for each of the three entered amounts (the contract rejects it before the query runs).
    for (const field of ['withheld', 'prepaid', 'noPaymentRevenue']) await expect(qtt(o, { [field]: '0.5' }), field).rejects.toMatchObject({ code: 'VALIDATION' });
    // A year before the first profile is outside the return.
    await expect(qtt(o, { year: 2026 })).resolves.toBeDefined();
    const late = await org();
    await setProfile(late, { effectiveFrom: '2027-03-01' });
    await expect(qtt(late)).rejects.toMatchObject({ code: 'HOUSEHOLD_RETURN_NOT_REQUIRED' });
  });

  it('starts the year on the day the first profile took effect', async () => {
    const o = await org();
    await setProfile(o, { effectiveFrom: '2026-04-01' });
    await entry(o.household, o.orgId, '2026-03-20', 'Bán trước khi mở sổ', [['111', 500_000_000, 0], ['511', 0, 500_000_000]]);
    await entry(o.household, o.orgId, '2026-04-02', 'Bán hàng', [['111', 1_500_000_000, 0], ['511', 0, 1_500_000_000]]);
    const w = await qtt(o);
    expect(w.period.from).toBe('2026-04-01');
    expect(line(w, '09')).toBe('1500000000');
  });

  it('keeps the law rows the migration seeds: the three bands, the form version, and the corrected 01/CNKD source', async () => {
    const rates = await admin((c) => c.query<{ revenue_over: string; percent: string; status: string }>('SELECT revenue_over::text, percent::text, status FROM ludy_finance.household_income_rate ORDER BY revenue_over'));
    expect(rates.rows.map((r) => [Number(r.revenue_over), Number(r.percent), r.status])).toEqual([
      [0, 15, 'confirmed'],
      [3_000_000_000, 17, 'confirmed'],
      [50_000_000_000, 20, 'confirmed'],
    ]);
    const forms = await admin((c) => c.query<{ form: string; version: string; pit_methods: string[]; status: string; source: string }>('SELECT form, version, pit_methods, status, source FROM ludy_finance.household_return_form_version ORDER BY form'));
    expect(forms.rows.map((r) => [r.form, r.version, r.pit_methods, r.status])).toEqual([
      ['01/CNKD', '2026.1', ['percentage'], 'confirmed'],
      ['02/CNKD-TNCN-QTT', '2026.1', ['income'], 'confirmed'],
    ]);
    // 01/TKN-CNKD is the revenue notice of a household at or under the threshold, not the yearly settlement.
    expect(forms.rows[0]?.source).not.toContain('is the yearly settlement');
    expect(forms.rows[0]?.source).toContain('02/CNKD-TNCN-QTT');
    // The form list accepts no other form, and no tenant login changes a rate.
    await expect(admin((c) => c.query("INSERT INTO ludy_finance.household_return_form_version (form, version, effective_from, name, pit_methods, source, status) VALUES ('03/XXX', '2026.1', DATE '2026-01-01', 'x', ARRAY['income'], 'x', 'confirmed')"))).rejects.toThrow(/household_return_form_version_form_check/);
    await expect(pool.query('UPDATE ludy_finance.household_income_rate SET percent = 0')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('DELETE FROM ludy_finance.household_income_rate')).rejects.toMatchObject({ code: '42501' });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The Tổng quan of the Kế toán app (#2631), on PostgreSQL 17: known entries are posted through journal vouchers and each card must equal the statement line it
// reads (B01-DNN's 110, 131 and 311 at the period's last day, B02-DNN's 50 for the period) for the same entity and dates, the comparison must read the period of
// the same length right before, the six months and the expense mix must match the books, a new org reads as empty, and a viewer reads it too while another org
// sees nothing of it. The rules themselves are unit-tested in modules/finance/test/overview.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { z } from 'zod';
import { zFinancialStatements, type FinanceOverview, type JournalVoucherRequest } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = '2026-11-04';
type FinancialStatements = z.infer<typeof zFinancialStatements>;

suite('the Kế toán Tổng quan (#2631)', () => {
  const dbName = `crove_test_overview_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let o: { orgId: string; owner: string; member: string; viewer: string };
  let fresh: { orgId: string; owner: string };
  let second = '';
  let customer = '';
  let vendor = '';
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
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@overview.test`, name: null });

  // One balanced voucher of two lines, requested by the member and approved by the owner (four-eyes).
  async function post(date: string, debit: { account: string; partyId?: string }, credit: { account: string; partyId?: string }, amount: string, orgId = o.orgId) {
    const input: JournalVoucherRequest = {
      date,
      description: `Bút toán thử ${date}`,
      lines: [
        { account: debit.account, ...(debit.partyId ? { partyId: debit.partyId } : {}), debit: amount, credit: '0' },
        { account: credit.account, ...(credit.partyId ? { partyId: credit.partyId } : {}), debit: '0', credit: amount },
      ],
    };
    const { proposalId } = await rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal_voucher.record', input }, { actor: asUser(o.member), orgId, idempotencyKey: randomUUID() });
    return approve(proposalId, orgId);
  }

  async function approve(proposalId: string, orgId: string) {
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(o.owner), orgId });
    return rt.execute<{ journalEntryId: string }>('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(o.owner), orgId });
  }

  const overview = (range: FinanceOverview['range'], user = o.owner, orgId = o.orgId, asOf = TODAY) =>
    rt.query<FinanceOverview>('finance.overview', { range, asOf }, { actor: asUser(user), orgId });
  const statements = (period: string) => rt.query<FinancialStatements>('finance.statements.period', { period }, { actor: asUser(o.owner), orgId: o.orgId });
  const lineOf = (lines: Array<{ code: string; amount: string }>, code: string) => lines.find((l) => l.code === code)?.amount;

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });

    const owner = await person('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    o = { orgId, owner, member: await person('member'), viewer: await person('viewer') };
    second = await person('admin');
    for (const [user, role] of [
      [o.member, 'member'],
      [o.viewer, 'viewer'],
      [second, 'admin'],
    ] as const) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]));
    }
    const party = async (name: string, taxCode: string) =>
      String((await admin((c) => c.query<{ id: string }>(`INSERT INTO crove_kernel.party (org_id, name, tax_code) VALUES ($1, $2, $3) RETURNING id`, [orgId, name, taxCode]))).rows[0]?.id);
    customer = await party('Khách hàng Mẫu', '0101234564');
    vendor = await party('Nhà cung cấp Mẫu', '0301234567');

    // The books: capital in August; in the period before (2026-09-06 to 2026-10-05) a sale of 5,000,000 and a cost of goods of 2,000,000; in the
    // last 30 days (2026-10-06 to 2026-11-04) a sale of 8,000,000, an administrative cost of 1,500,000 owed, 3,000,000 collected, a financial cost of
    // 200,000 and 1,000,000 paid to the vendor.
    await post('2026-08-10', { account: '112' }, { account: '4111' }, '10000000');
    await post('2026-09-10', { account: '131', partyId: customer }, { account: '511' }, '5000000');
    await post('2026-09-12', { account: '632' }, { account: '331', partyId: vendor }, '2000000');
    await post('2026-10-10', { account: '131', partyId: customer }, { account: '511' }, '8000000');
    await post('2026-10-12', { account: '642' }, { account: '331', partyId: vendor }, '1500000');
    await post('2026-10-15', { account: '112' }, { account: '131', partyId: customer }, '3000000');
    await post('2026-10-20', { account: '635' }, { account: '112' }, '200000');
    await post('2026-11-02', { account: '331', partyId: vendor }, { account: '112' }, '1000000');

    const lone = await person('lone');
    fresh = { orgId: (await createOrg(rt, asUser(lone), `Org ${randomUUID().slice(0, 6)}`)).orgId, owner: lone };
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('answers the last 30 days against the 30 days before: each card and its change', async () => {
    const view = await overview('last_30_days');
    expect(view).toMatchObject({ range: 'last_30_days', from: '2026-10-06', to: TODAY, previousFrom: '2026-09-06', previousTo: '2026-10-05', empty: false, unmapped: 0 });
    // 112: 10,000,000 + 3,000,000 - 200,000 - 1,000,000 now, 10,000,000 on 2026-10-05.
    expect(view.cash).toEqual({ amount: '11800000', previous: '10000000', change: '1800000', changePercent: '18.0' });
    expect(view.profit).toEqual({ amount: '6300000', previous: '3000000', change: '3300000', changePercent: '110.0' });
    expect(view.receivables).toEqual({ amount: '10000000', previous: '5000000', change: '5000000', changePercent: '100.0' });
    expect(view.payables).toEqual({ amount: '2500000', previous: '2000000', change: '500000', changePercent: '25.0' });
  });

  it('shows the costs of the period by account group, largest first, with the groups that only the period before had', async () => {
    const view = await overview('last_30_days');
    expect(view.expenses).toEqual([
      { group: '642', amount: '1500000', previous: '0', percent: '88.2' },
      { group: '635', amount: '200000', previous: '0', percent: '11.8' },
      { group: '632', amount: '0', previous: '2000000', percent: '0.0' },
    ]);
  });

  it('shows revenue, costs and profit for the six months ending with the period\'s month', async () => {
    const view = await overview('last_30_days');
    expect(view.months).toEqual([
      { month: '2026-06', revenue: '0', costs: '0', profit: '0' },
      { month: '2026-07', revenue: '0', costs: '0', profit: '0' },
      { month: '2026-08', revenue: '0', costs: '0', profit: '0' },
      { month: '2026-09', revenue: '5000000', costs: '2000000', profit: '3000000' },
      { month: '2026-10', revenue: '8000000', costs: '1700000', profit: '6300000' },
      { month: '2026-11', revenue: '0', costs: '0', profit: '0' },
    ]);
  });

  it('equals the statements for the same entity and dates: last month is October, read as B01 at its last day and B02 for it', async () => {
    const view = await overview('last_month');
    expect(view).toMatchObject({ from: '2026-10-01', to: '2026-10-31', previousFrom: '2026-08-31', previousTo: '2026-09-30' });
    const october = await statements('2026-10');
    expect(view.cash.amount).toBe(lineOf(october.b01.lines, '110'));
    expect(view.receivables.amount).toBe(lineOf(october.b01.lines, '131'));
    expect(view.payables.amount).toBe(lineOf(october.b01.lines, '311'));
    expect(view.profit.amount).toBe(lineOf(october.b02.lines, '50'));
    // The period before holds nothing on 31 August, so it is September's own statements.
    const september = await statements('2026-09');
    expect(view.cash.previous).toBe(lineOf(september.b01.lines, '110'));
    expect(view.receivables.previous).toBe(lineOf(september.b01.lines, '131'));
    expect(view.payables.previous).toBe(lineOf(september.b01.lines, '311'));
    expect(view.profit.previous).toBe(lineOf(september.b02.lines, '50'));
  });

  it('knows the period picker: this month, this quarter and this year run to today', async () => {
    expect(await overview('this_month')).toMatchObject({ from: '2026-11-01', to: TODAY, previousFrom: '2026-10-28', previousTo: '2026-10-31' });
    expect(await overview('this_quarter')).toMatchObject({ from: '2026-10-01', to: TODAY, previousFrom: '2026-08-27', previousTo: '2026-09-30' });
    const year = await overview('this_year');
    expect(year).toMatchObject({ from: '2026-01-01', to: TODAY });
    expect(year.profit.amount).toBe('9300000');
  });

  it('is open to every role of the org and reads nothing across orgs', async () => {
    const viewer = await overview('last_30_days', o.viewer);
    expect(viewer.cash.amount).toBe('11800000');
    await expect(overview('last_30_days', fresh.owner, o.orgId)).rejects.toThrow();
  });

  it('counts a posted reversal as lowering what it undoes, in the cards, the months and the mix', async () => {
    const { orgId } = await createOrg(rt, asUser(o.owner), `Org ${randomUUID().slice(0, 6)}`);
    for (const [user, role] of [
      [o.member, 'member'],
      [second, 'admin'],
    ] as const) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]));
    }
    await post('2026-10-20', { account: '112' }, { account: '511' }, '5000000', orgId);
    const cost = await post('2026-10-21', { account: '642' }, { account: '112' }, '400000', orgId);
    const before = await overview('last_30_days', o.owner, orgId);
    expect(before.cash.amount).toBe('4600000');
    expect(before.profit.amount).toBe('4600000');
    const { proposalId } = await rt.execute<{ proposalId: string }>(
      'kernel.proposal.request',
      { command: 'finance.journal.reverse', input: { entryId: cost.journalEntryId, entryDate: '2026-10-25', reason: 'Ghi nhầm' } },
      { actor: asUser(o.member), orgId, idempotencyKey: randomUUID() },
    );
    await approve(proposalId, orgId);
    const after = await overview('last_30_days', o.owner, orgId);
    expect(after.cash.amount).toBe('5000000');
    expect(after.profit.amount).toBe('5000000');
    expect(after.months.at(-2)).toEqual({ month: '2026-10', revenue: '5000000', costs: '0', profit: '5000000' });
    expect(after.expenses).toEqual([]);
  });

  it('answers a member for the entities they see only: another entity is refused as if it did not exist', async () => {
    const branch = String((await admin((c) => c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [o.orgId, o.owner]))).rows[0]?.id);
    const defaultEntity = String((await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [o.orgId]))).rows[0]?.id);
    const scoped = await person('scoped');
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, scoped]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [o.orgId, scoped, defaultEntity, o.owner]);
    });
    const asScoped = (legalEntityId?: string) =>
      rt.query<FinanceOverview>('finance.overview', { range: 'last_30_days', asOf: TODAY, ...(legalEntityId ? { legalEntityId } : {}) }, { actor: asUser(scoped), orgId: o.orgId });
    expect((await asScoped()).cash.amount).toBe('11800000');
    expect((await asScoped(defaultEntity)).cash.amount).toBe('11800000');
    await expect(asScoped(branch)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    // The branch's own books are empty: the owner sees them as such, and nothing of the default entity's.
    const own = await rt.query<FinanceOverview>('finance.overview', { range: 'last_30_days', asOf: TODAY, legalEntityId: branch }, { actor: asUser(o.owner), orgId: o.orgId });
    expect(own.empty).toBe(true);
    expect(own.cash.amount).toBe('0');
  });

  it('reads a new org as empty, with every card at 0', async () => {
    const view = await overview('last_30_days', fresh.owner, fresh.orgId);
    expect(view.empty).toBe(true);
    for (const card of [view.cash, view.profit, view.receivables, view.payables]) expect(card).toEqual({ amount: '0', previous: '0', change: '0', changePercent: null });
    expect(view.expenses).toEqual([]);
    expect(view.months).toHaveLength(6);
  });
});

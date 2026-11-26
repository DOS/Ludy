// SPDX-License-Identifier: AGPL-3.0-only
// The three money tiles on Home (#4785), on PostgreSQL 17: known entries are posted through journal vouchers and Chưa thu and Chưa trả must equal B01-DNN's lines 131 and
// 311 for the same entity and day, Tiền ngân hàng the net of the 112 accounts listed by account; owners and admins, and members with a finance role, see the figures, a
// plain member or viewer and another org's owner see `available: false` with no figure. The rules are unit-tested in modules/finance/test/home-money.test.ts.
// Set LUDY_TEST_ADMIN_URL (or CROVE_TEST_ADMIN_URL) to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { z } from 'zod';
import { zFinancialStatements, type FinanceHomeMoney, type JournalVoucherRequest } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = '2026-11-04';
type FinancialStatements = z.infer<typeof zFinancialStatements>;

suite('the Home money tiles (#4785)', () => {
  const dbName = `ludy_test_home_money_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@home-money.test`, name: null });

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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const app = new URL(adminUrl);
    app.username = 'ludy_app';
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
      await admin((c) => c.query('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]));
    }
    const party = async (name: string, taxCode: string) =>
      String((await admin((c) => c.query<{ id: string }>(`INSERT INTO ludy_kernel.party (org_id, name, tax_code) VALUES ($1, $2, $3) RETURNING id`, [orgId, name, taxCode]))).rows[0]?.id);
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

  const tiles = (user: string, orgId = o.orgId, asOf = TODAY) => rt.query<FinanceHomeMoney>('finance.home_money', { asOf }, { actor: asUser(user), orgId });
  const available = (view: FinanceHomeMoney) => {
    if (!view.available) throw new Error('the tiles are not available');
    return view;
  };

  it('reads what customers owe, what the org owes and the bank as the statements do for the same day', async () => {
    const view = available(await tiles(o.owner));
    const statement = await statements('2026-11');
    expect(view.asOf).toBe(TODAY);
    expect(view.receivables).toBe(lineOf(statement.b01.lines, '131'));
    expect(view.payables).toBe(lineOf(statement.b01.lines, '311'));
    // 112: 10,000,000 + 3,000,000 - 200,000 - 1,000,000.
    expect(view).toMatchObject({ receivables: '10000000', payables: '2500000', bank: '11800000', bankAccountCount: 1 });
    expect(view.bankAccounts).toEqual([{ code: '112', name: expect.any(String), balance: '11800000' }]);
  });

  it('reads the books as of the day asked: before the cash was collected the bank held the capital alone', async () => {
    const view = available(await tiles(o.owner, o.orgId, '2026-10-05'));
    expect(view).toMatchObject({ receivables: '5000000', payables: '2000000', bank: '10000000' });
  });

  it('lists every bank account of the 112 group by size, and the figure counts them all', async () => {
    const { orgId } = await createOrg(rt, asUser(o.owner), `Org ${randomUUID().slice(0, 6)}`);
    for (const [user, role] of [
      [o.member, 'member'],
      [second, 'admin'],
    ] as const) {
      await admin((c) => c.query('INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]));
    }
    await post('2026-10-01', { account: '1121' }, { account: '4111' }, '4000000', orgId);
    await post('2026-10-02', { account: '1122' }, { account: '4111' }, '9000000', orgId);
    await post('2026-10-03', { account: '642' }, { account: '1121' }, '5000000', orgId);
    const view = available(await tiles(o.owner, orgId));
    // 1121 is overdrawn by 1,000,000: the figure is the net of both accounts and says so by its sign.
    expect(view.bank).toBe('8000000');
    expect(view.bankAccountCount).toBe(2);
    expect(view.bankAccounts.map((a) => [a.code, a.balance])).toEqual([
      ['1122', '9000000'],
      ['1121', '-1000000'],
    ]);
  });

  it('shows owners and admins the figures, and a plain member or viewer nothing at all', async () => {
    expect(available(await tiles(second)).bank).toBe('11800000');
    expect(await tiles(o.member)).toEqual({ available: false });
    expect(await tiles(o.viewer)).toEqual({ available: false });
  });

  it('shows a member who holds a finance role or permission the figures, and a role of another app nothing', async () => {
    const keyed = await person('keyed');
    const other = await person('other');
    await admin(async (c) => {
      for (const user of [keyed, other]) await c.query(`INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, user]);
      await c.query(`INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, granted_by) VALUES ($1, $2, 'finance.viewer', $3)`, [o.orgId, keyed, o.owner]);
    });
    expect(available(await tiles(keyed)).receivables).toBe('10000000');
    expect(await tiles(other)).toEqual({ available: false });
  });

  it('answers a new org with every figure at 0, and an outsider with a refusal rather than another org\'s books', async () => {
    expect(await tiles(fresh.owner, fresh.orgId)).toMatchObject({ available: true, receivables: '0', payables: '0', bank: '0', bankAccounts: [], bankAccountCount: 0 });
    await expect(tiles(fresh.owner, o.orgId)).rejects.toThrow();
  });

  it('keeps reading the default entity books when the org also has a branch', async () => {
    const { orgId } = await createOrg(rt, asUser(o.owner), `Org ${randomUUID().slice(0, 6)}`);
    await admin((c) => c.query(`INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2)`, [orgId, o.owner]));
    // The default entity is the one Home reads; a caller whose scope leaves it out would get available false (unit-tested through the entity rule).
    expect((await tiles(o.owner, orgId)).available).toBe(true);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The month-close checklist of the Kế toán app, on PostgreSQL 17 (finance.month_close): every item is a count read from the books for one org, one legal entity and one month,
// and each is checked here against rows the test made: pending proposals by their own date, bank lines of the month that nothing settles, the period lock, the VAT return mark
// for a monthly and for a quarterly filer, and the items that do not apply (no tax-portal list, no stock move) being left out. A member limited to one entity cannot read another,
// another org sees nothing of it, and a viewer reads it too. The rules are unit-tested in modules/finance/test/month-close.test.ts.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import type { JournalVoucherRequest, MonthClose, MonthCloseKey } from '@ludy/kernel-contract';
import { Runtime } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the month-close checklist', () => {
  const dbName = `crove_test_month_close_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  let o: { orgId: string; owner: string; member: string; viewer: string };
  let other: { orgId: string; owner: string };
  let defaultEntity = '';
  let branch = '';
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
  const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@close.test`, name: null });

  const close = (month: string, user = o.owner, orgId = o.orgId, legalEntityId?: string) =>
    rt.query<MonthClose>('finance.month_close', { month, ...(legalEntityId ? { legalEntityId } : {}) }, { actor: asUser(user), orgId });
  const item = (view: MonthClose, key: MonthCloseKey) => view.items.find((i) => i.key === key);
  const count = (view: MonthClose, key: MonthCloseKey) => item(view, key)?.count;

  // A voucher proposal waits for approval: its date is the voucher's, so it belongs to that month.
  async function propose(date: string, orgId = o.orgId) {
    const input: JournalVoucherRequest = {
      date,
      description: `Đề xuất ${date}`,
      lines: [
        { account: '112', debit: '1000000', credit: '0' },
        { account: '511', debit: '0', credit: '1000000' },
      ],
    };
    return rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.journal_voucher.record', input }, { actor: asUser(o.member), orgId, idempotencyKey: randomUUID() });
  }
  const bankLine = (value: string, entity: string | null = null) =>
    admin((c) =>
      c.query(
        `INSERT INTO crove_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount${entity ? ', legal_entity_id' : ''})
         VALUES ($1, '1121', $2, 1, $3, 'chuyển khoản', 500000${entity ? ', $4' : ''})`,
        entity ? [o.orgId, randomUUID(), value, entity] : [o.orgId, randomUUID(), value],
      ),
    );

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
    for (const [user, role] of [
      [o.member, 'member'],
      [o.viewer, 'viewer'],
    ] as const) {
      await admin((c) => c.query('INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, $3)', [orgId, user, role]));
    }
    defaultEntity = String((await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))).rows[0]?.id);
    branch = String((await admin((c) => c.query<{ id: string }>(`INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id`, [orgId, owner]))).rows[0]?.id);
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

  it('reads an org with nothing in it as open on the three yes or no items, zero on the counts, and leaves out what does not apply', async () => {
    const view = await close('2026-10');
    expect(view).toMatchObject({ month: '2026-10', legalEntityId: defaultEntity });
    expect(view.items.map((i) => i.key)).toEqual(['proposals', 'bank', 'marketplace', 'vat', 'lock']);
    expect(count(view, 'proposals')).toBe(0);
    expect(count(view, 'bank')).toBe(0);
    expect(count(view, 'marketplace')).toBe(0);
    // No tax-portal list and no stock move: those two items do not apply, so they are not there.
    expect(item(view, 'invoices')).toBeUndefined();
    expect(item(view, 'stock')).toBeUndefined();
    expect(item(view, 'vat')).toEqual({ key: 'vat', count: 1, period: '2026-10' });
    expect(count(view, 'lock')).toBe(1);
  });

  it('counts the pending proposals by their own date, in the month they are dated and no other', async () => {
    await propose('2026-10-10');
    await propose('2026-10-28');
    await propose('2026-09-20');
    expect(count(await close('2026-10'), 'proposals')).toBe(2);
    expect(count(await close('2026-09'), 'proposals')).toBe(1);
    expect(count(await close('2026-08'), 'proposals')).toBe(0);
    // The branch has none of them.
    expect(count(await close('2026-10', o.owner, o.orgId, branch), 'proposals')).toBe(0);
  });

  it('counts the bank lines of the month that nothing settles, for the entity they belong to', async () => {
    await bankLine('2026-10-05');
    await bankLine('2026-10-20');
    await bankLine('2026-09-30');
    await bankLine('2026-11-01');
    await bankLine('2026-10-15', branch);
    expect(count(await close('2026-10'), 'bank')).toBe(2);
    expect(count(await close('2026-09'), 'bank')).toBe(1);
    expect(count(await close('2026-10', o.owner, o.orgId, branch), 'bank')).toBe(1);
    expect(count(await close('2026-10', o.owner, o.orgId, defaultEntity), 'bank')).toBe(2);
  });

  it('marks the VAT return of a monthly filer for every month, and the period lock once it runs through the month', async () => {
    expect(count(await close('2026-10'), 'vat')).toBe(1);
    await rt.execute('finance.vat.return_mark', { period: '2026-10', done: true }, { actor: asMfa(o.owner), orgId: o.orgId });
    expect(item(await close('2026-10'), 'vat')).toEqual({ key: 'vat', count: 0, period: '2026-10' });
    // Withdrawing the mark reopens it.
    await rt.execute('finance.vat.return_mark', { period: '2026-10', done: false }, { actor: asMfa(o.owner), orgId: o.orgId });
    expect(count(await close('2026-10'), 'vat')).toBe(1);

    expect(count(await close('2026-10'), 'lock')).toBe(1);
    await rt.execute('finance.period.lock', { month: '2026-10' }, { actor: asMfa(o.owner), orgId: o.orgId });
    expect(count(await close('2026-10'), 'lock')).toBe(0);
    expect(count(await close('2026-09'), 'lock')).toBe(0);
    // The month after is not covered by it, and the branch has locked nothing.
    expect(count(await close('2026-11'), 'lock')).toBe(1);
    expect(count(await close('2026-10', o.owner, o.orgId, branch), 'lock')).toBe(1);
  });

  it('asks a quarterly filer about the return of the quarter, in the last month of it only', async () => {
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET vat_filing_period = 'quarter' WHERE org_id = $1`, [o.orgId]));
    expect(item(await close('2026-10'), 'vat')).toBeUndefined();
    expect(item(await close('2026-11'), 'vat')).toBeUndefined();
    expect(item(await close('2026-12'), 'vat')).toEqual({ key: 'vat', count: 1, period: '2026-Q4' });
    await rt.execute('finance.vat.return_mark', { period: '2026-Q3', done: true }, { actor: asMfa(o.owner), orgId: o.orgId });
    expect(item(await close('2026-09'), 'vat')).toEqual({ key: 'vat', count: 0, period: '2026-Q3' });
    await admin((c) => c.query(`UPDATE crove_kernel.tenant SET vat_filing_period = NULL WHERE org_id = $1`, [o.orgId]));
  });

  it('reads a viewer the same checklist, refuses an entity of another org and a member limited to another entity, and shows another org nothing of this one', async () => {
    expect(count(await close('2026-10', o.viewer), 'proposals')).toBe(2);
    await expect(close('2026-10', other.owner, other.orgId, defaultEntity)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    const scoped = await person('scoped');
    await admin(async (c) => {
      await c.query(`INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member')`, [o.orgId, scoped]);
      await c.query(`INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)`, [o.orgId, scoped, defaultEntity, o.owner]);
    });
    expect(count(await close('2026-10', scoped), 'bank')).toBe(2);
    await expect(close('2026-10', scoped, o.orgId, branch)).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    const mine = await close('2026-10', other.owner, other.orgId);
    expect(mine.legalEntityId).not.toBe(defaultEntity);
    expect(count(mine, 'proposals')).toBe(0);
    expect(count(mine, 'bank')).toBe(0);
  });

  it('leaves out the stock close until the entity has a stock move, and asks for it once the month is over', async () => {
    await admin(async (c) => {
      const item = String(
        (await c.query<{ id: string }>(`INSERT INTO crove_finance.stock_item (org_id, legal_entity_id, code, name, unit, stock_account) VALUES ($1, $2, 'SKU1', 'Hàng thử', 'cái', '156') RETURNING id`, [o.orgId, defaultEntity])).rows[0]?.id,
      );
      await c.query(
        `INSERT INTO crove_finance.stock_move (org_id, legal_entity_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, '2026-10-03', 5, 'manual')`,
        [o.orgId, defaultEntity, item],
      );
    });
    expect(item(await close('2026-10'), 'stock')).toEqual({ key: 'stock', count: 1, period: null });
    // A month before the first move has nothing to close; a month that is not over is not asked about.
    expect(item(await close('2026-09'), 'stock')).toBeUndefined();
    expect(item(await close('2099-01'), 'stock')).toBeUndefined();
    // Once a close covers the month it is done (count 0), whether it is the close of that month or of a later one; the branch has no stock and is not asked.
    await admin((c) => c.query(`INSERT INTO crove_finance.stock_period (org_id, legal_entity_id, period_month, total_cost) VALUES ($1, $2, DATE '2026-10-01', 0)`, [o.orgId, defaultEntity]));
    expect(item(await close('2026-10'), 'stock')).toEqual({ key: 'stock', count: 0, period: null });
    expect(item(await close('2026-10', o.owner, o.orgId, branch), 'stock')).toBeUndefined();
  });

  // A proposal as the extraction or a request leaves it, with a creation time of its own where the test needs one.
  const proposal = (command: string, kind: string, payload: unknown, createdAt: string | null = null) =>
    admin((c) =>
      c.query(
        `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors${createdAt ? ', created_at' : ''})
         VALUES ($1, $2, $3, 'Đề xuất thử', $4, ARRAY[$5::uuid], '[]'${createdAt ? ', $6' : ''})`,
        createdAt ? [o.orgId, kind, command, JSON.stringify(payload), o.owner, createdAt] : [o.orgId, kind, command, JSON.stringify(payload), o.owner],
      ),
    );

  it('dates a pending proposal by the voucher date, else the invoice issue date, else the day it was made in Vietnam, and never breaks on an impossible date', async () => {
    await proposal('finance.purchase.record', 'finance.purchase', { invoice: { issueDate: '2026-03-12' } });
    // Made at 00:30 on 1 March in Vietnam (17:30 UTC the day before), and at 00:30 on 1 April: the day in Vietnam decides, not the UTC day.
    await proposal('finance.marketplace_settlement.record', 'finance.journal_voucher', { settlementId: randomUUID() }, '2026-02-28T17:30:00Z');
    await proposal('finance.marketplace_settlement.record', 'finance.journal_voucher', { settlementId: randomUUID() }, '2026-03-31T17:30:00Z');
    // One impossible date in a payload breaks nothing (it is read as text and sorts into the month it names); another command's proposal is not counted.
    await proposal('finance.journal_voucher.record', 'finance.journal_voucher', { date: '2026-02-31', lines: [] });
    await proposal('social.post.publish', 'social.post', { date: '2026-03-15' });
    expect(count(await close('2026-03'), 'proposals')).toBe(2);
    expect(count(await close('2026-04'), 'proposals')).toBe(1);
    expect(count(await close('2026-02'), 'proposals')).toBe(1);
    expect(count(await close('2026-01'), 'proposals')).toBe(0);
  });

  // A settlement of one line that stands, as the Sàn screen keeps them, and the vouchers that post it and its payout, as the record commands leave them.
  async function settlement(platform: string, start: string, end: string): Promise<string> {
    return admin(async (a) => {
      await a.query('BEGIN');
      const id = randomUUID();
      const order = randomUUID();
      await a.query('INSERT INTO crove_finance.channel_order (org_id, id, legal_entity_id, platform, order_no) VALUES ($1, $2, $3, $4, $5)', [o.orgId, order, defaultEntity, platform, `ST${randomUUID().slice(0, 12)}`]);
      await a.query('INSERT INTO crove_finance.channel_settlement (org_id, id, legal_entity_id, platform, period_start, period_end, report_net) VALUES ($1, $2, $3, $4, $5, $6, 9000)', [o.orgId, id, defaultEntity, platform, start, end]);
      await a.query('INSERT INTO crove_finance.channel_settlement_line (org_id, id, legal_entity_id, settlement_id, order_id, line_key, sales, tax_withheld, net, adjustment) VALUES ($1, $2, $3, $4, $5, $6, 10000, 1000, 9000, false)', [o.orgId, randomUUID(), defaultEntity, id, order, 'L1']);
      await a.query('COMMIT');
      return id;
    });
  }
  const voucherOf = (settlementId: string, payout: { bankLineId: string } | null = null) =>
    admin(async (a) => {
      await a.query('BEGIN');
      const v = (
        await a.query<{ id: string }>(
          payout
            ? `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, payout_settlement_id, payout_bank_line_id, legal_entity_id) VALUES ($1, '2026-11-10', 'Sàn trả tiền', $2, $3, $4, $5) RETURNING id`
            : `INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, settlement_id, legal_entity_id) VALUES ($1, '2026-11-10', 'Ghi sổ kỳ đối soát', $2, $3, $4) RETURNING id`,
          payout ? [o.orgId, randomUUID(), settlementId, payout.bankLineId, defaultEntity] : [o.orgId, randomUUID(), settlementId, defaultEntity],
        )
      ).rows[0]?.id;
      const e = (
        await a.query<{ id: string }>(
          "INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, '2026-11-10', 'Sàn', 'finance.journal_voucher', $2, $3) RETURNING id",
          [o.orgId, v, defaultEntity],
        )
      ).rows[0]?.id;
      await a.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '131', 10000, 0), ($1, $2, 2, '511', 0, 10000)", [o.orgId, e]);
      await a.query('COMMIT');
    });
  const bankLineId = async (value: string) =>
    String(
      (
        await admin((c) =>
          c.query<{ id: string }>(`INSERT INTO crove_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount) VALUES ($1, '1121', $2, 1, $3, 'Sàn trả tiền', 9000) RETURNING id`, [o.orgId, randomUUID(), value]),
        )
      ).rows[0]?.id,
    );

  it('counts the marketplace settlements still to post and the payouts still to record by their period, and leaves out the ones that wait on a pending proposal or have their payout', async () => {
    const toPost = await settlement('shopee', '2026-06-01', '2026-06-15');
    const posted = await settlement('shopee', '2026-06-16', '2026-06-30');
    await voucherOf(posted);
    // Ends in May: not in June.
    await settlement('shopee', '2026-05-01', '2026-05-20');
    expect(count(await close('2026-06'), 'marketplace')).toBe(2);
    expect(count(await close('2026-05'), 'marketplace')).toBe(1);
    expect(toPost).not.toBe(posted);

    // A pending proposal to post one, and one to record a payout, hold them: those proposals are counted in the first item, not here.
    const proposedPost = await settlement('lazada', '2026-06-02', '2026-06-10');
    await proposal('finance.marketplace_settlement.record', 'finance.journal_voucher', { settlementId: proposedPost }, '2026-06-20T03:00:00Z');
    const proposedPayout = await settlement('lazada', '2026-06-11', '2026-06-12');
    await voucherOf(proposedPayout);
    await proposal('finance.marketplace_payout.record', 'finance.journal_voucher', { settlementId: proposedPayout }, '2026-06-20T03:00:00Z');
    expect(count(await close('2026-06'), 'marketplace')).toBe(2);
    expect(count(await close('2026-06'), 'proposals')).toBe(2);

    // A payout voucher settles its settlement and its bank line: neither is counted any more, in the marketplace item or the bank item.
    const paid = await settlement('tiktok', '2026-06-13', '2026-06-14');
    await voucherOf(paid);
    expect(count(await close('2026-06'), 'marketplace')).toBe(3);
    const payoutLine = await bankLineId('2026-06-18');
    expect(count(await close('2026-06'), 'bank')).toBe(1);
    await voucherOf(paid, { bankLineId: payoutLine });
    expect(count(await close('2026-06'), 'marketplace')).toBe(2);
    expect(count(await close('2026-06'), 'bank')).toBe(0);
    // The branch has none of it.
    expect(count(await close('2026-06', o.owner, o.orgId, branch), 'marketplace')).toBe(0);
  });

  it('leaves out of the bank item a line that a pending voucher proposal names', async () => {
    const line = await bankLineId('2026-08-05');
    await bankLine('2026-08-20');
    expect(count(await close('2026-08'), 'bank')).toBe(2);
    await proposal('finance.voucher.record', 'finance.cash_voucher', { bankLineId: line, date: '2026-08-05' });
    expect(count(await close('2026-08'), 'bank')).toBe(1);
    // A decided proposal holds nothing.
    await admin((c) => c.query(`UPDATE crove_kernel.proposal SET status = 'rejected' WHERE org_id = $1 AND payload->>'bankLineId' = $2`, [o.orgId, line]));
    expect(count(await close('2026-08'), 'bank')).toBe(2);
  });

  it('counts the tax-portal invoices that match no voucher once a list was read for the month, and not before', async () => {
    const fileId = randomUUID();
    const sha = 'b'.repeat(64);
    const list = (period: string, state: 'done' | 'pending') =>
      admin(async (a) => {
        await a.query(`INSERT INTO crove_kernel.file (org_id, id, sha256, storage_key, filename, content_type, size_bytes, source) VALUES ($1, $2, $3, $4, 'ds.xlsx', 'application/octet-stream', 10, 'upload') ON CONFLICT DO NOTHING`, [o.orgId, fileId, sha, `org/${o.orgId}/${sha}`]);
        const id = String((await a.query<{ id: string }>(`INSERT INTO crove_finance.portal_invoice_list (org_id, period, file_id, filename, direction, legal_entity_id) VALUES ($1, $2, $3, 'ds.xlsx', 'purchase', $4) RETURNING id`, [o.orgId, period, fileId, defaultEntity])).rows[0]?.id);
        if (state === 'done') {
          for (const [no, number] of [[1, '101'], [2, '102']] as const) {
            await a.query(
              `INSERT INTO crove_finance.portal_invoice_row (org_id, list_id, row_no, seller_tax_code, seller_name, template, series, number, issue_date, subtotal, vat_amount, total, status)
               VALUES ($1, $2, $3, '0101234564', 'Bên bán', '1', 'C26TAA', $4, '2026-05-10', 1000000, 100000, 1100000, 'original')`,
              [o.orgId, id, no, number],
            );
          }
          await a.query(`UPDATE crove_finance.portal_invoice_list SET status = 'done', row_count = 2 WHERE id = $1`, [id]);
        }
      });
    // A list that is still being read says nothing yet: the item does not apply.
    await list('2026-04', 'pending');
    expect(item(await close('2026-04'), 'invoices')).toBeUndefined();
    expect(item(await close('2026-05'), 'invoices')).toBeUndefined();
    await list('2026-05', 'done');
    // Two invoices of the portal's list that no voucher of the books matches.
    expect(item(await close('2026-05'), 'invoices')).toEqual({ key: 'invoices', count: 2, period: '2026-05' });
    expect(item(await close('2026-05', o.owner, o.orgId, branch), 'invoices')).toBeUndefined();
  });
});

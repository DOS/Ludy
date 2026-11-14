// SPDX-License-Identifier: AGPL-3.0-only
// `finance.signals.overdue_receivables`, Accounting's side of rule 2 (Vy V5, #2969), on PostgreSQL 17: for the parties it is asked about, the oldest due date among their overdue sales
// invoices, the overdue total and the count, by the numbers of the payment reminders screen (the 131 balance laid over the invoices newest first, 30 day terms unless the customer has its
// own); due today is not overdue; a paid customer is not listed; a customer who owes in several entities is summed; a party and its duplicates are one customer; the read REFUSES a caller whose
// books are only in part in view, so a party that is not listed owes nothing late. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { SIGNAL_PARTIAL_VIEW_CODE, vietnamToday, zFinanceOverdueReceivableSignals, type FinanceOverdueReceivableSignal } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { addDays, financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TODAY = vietnamToday();
// The invoice date that makes an invoice `late` days past its due date under the 30 day terms (late 0 is due today).
const dated = (late: number) => addDays(TODAY, -(30 + late));
const SECRET_NAME = 'Công ty bí mật của chị Lan';

suite('finance.signals.overdue_receivables on PostgreSQL (#2969)', () => {
  const dbName = `crove_test_finance_overdue_signals_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const rows = <T extends pg.QueryResultRow>(text: string, params: unknown[] = []) => admin(async (c) => (await c.query<T>(text, params)).rows);
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@overdue.test`, name: null }) as Promise<string>;

  async function org() {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [member, viewer, branchMember] = [await identity('member'), await identity('viewer'), await identity('branch')];
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    const branch = (await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]?.id as string;
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer'), ($1, $4, 'member')", [orgId, member, viewer, branchMember]);
    await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, branchMember, branch, owner]);
    const signals = (user: string, partyIds: string[]) => rt.query<FinanceOverdueReceivableSignal[]>('finance.signals.overdue_receivables', { partyIds }, { actor: asUser(user), orgId });
    const party = (name: string) => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    // A sales invoice with its entry (Dr 131, Cr 511), written the way finance.purchase.record writes one, in one transaction.
    async function sale(partyId: string, number: string, date: string, total: string, legalEntity: string = entity): Promise<string> {
      return admin(async (c) => {
        const doc = randomUUID();
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
           VALUES ($1, $2, $3, 'C26TAA', $4, $5, 'VND', $6, 0, $6, 'sale', $7)`,
          [orgId, doc, partyId, number, date, total, legalEntity],
        );
        const entry = randomUUID();
        await c.query(
          `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, $4, 'finance.purchase_document', $5, $6)`,
          [orgId, entry, date, `HĐ bán ${number}`, doc, legalEntity],
        );
        await c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, '131', $3, 0, $4, $5), ($1, $2, 2, '511', 0, $3, NULL, $5)`,
          [orgId, entry, total, partyId, legalEntity],
        );
        await c.query('COMMIT');
        return doc;
      });
    }
    // A receipt from the customer: Dr 112, Cr 131 naming it.
    async function receipt(partyId: string, date: string, amount: string, legalEntity: string = entity): Promise<void> {
      await admin(async (c) => {
        const entry = randomUUID();
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'Thu tiền khách hàng', 'finance.journal_voucher', $4, $5)`,
          [orgId, entry, date, randomUUID(), legalEntity],
        );
        await c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, '112', $3, 0, NULL, $5), ($1, $2, 2, '131', 0, $3, $4, $5)`,
          [orgId, entry, amount, partyId, legalEntity],
        );
        await c.query('COMMIT');
      });
    }
    return { orgId, owner, member, viewer, branchMember, entity, branch, signals, party, sale, receipt };
  }

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
    const url = new URL(adminUrl);
    url.username = 'crove_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
  });

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('lists a customer one day past its due date and not near misses: due today, not yet due, paid, or never invoiced', async () => {
    const o = await org();
    const [late, today, early, paid, none] = [await o.party(SECRET_NAME), await o.party('B'), await o.party('C'), await o.party('D'), await o.party('E')];
    await o.sale(late, '1', dated(1), '1500000.5');
    await o.sale(today, '2', dated(0), '700000');
    await o.sale(early, '3', addDays(TODAY, -10), '900000');
    await o.sale(paid, '4', dated(40), '2000000');
    await o.receipt(paid, addDays(TODAY, -5), '2000000');
    const list = await o.signals(o.owner, [late, today, early, paid, none]);
    expect(list).toEqual([{ partyId: late, oldestDueOn: addDays(dated(1), 30), amount: '1500000.5', count: 1 }]);
    expect(zFinanceOverdueReceivableSignals.safeParse(list).success).toBe(true);
  });

  it('lays a partial payment over the newest invoice first, as the reminders screen does', async () => {
    const o = await org();
    const p = await o.party('A');
    await o.sale(p, '1', dated(30), '1000000');
    await o.sale(p, '2', dated(10), '2000000');
    await o.receipt(p, addDays(TODAY, -2), '500000');
    // Owed 2 500 000: the newer invoice in full, then 500 000 of the older one; both are overdue, the oldest due date is the older invoice's.
    expect(await o.signals(o.owner, [p])).toEqual([{ partyId: p, oldestDueOn: addDays(dated(30), 30), amount: '2500000', count: 2 }]);
    // After 2 500 000 paid in all, 500 000 is left: the oldest invoices are taken as paid first, so what is left sits on the newest invoice (still overdue).
    await o.receipt(p, addDays(TODAY, -1), '2000000');
    expect(await o.signals(o.owner, [p])).toEqual([{ partyId: p, oldestDueOn: addDays(dated(10), 30), amount: '500000', count: 1 }]);
  });

  it('takes the customer\'s own payment terms and still lists a customer whose reminders are paused', async () => {
    const o = await org();
    const [terms, paused] = [await o.party('A'), await o.party('B')];
    await o.sale(terms, '1', dated(5), '1000000');
    await o.sale(paused, '2', dated(5), '1000000');
    await rows('INSERT INTO crove_finance.customer_collection (org_id, party_id, terms_days) VALUES ($1, $2, 90)', [o.orgId, terms]);
    await rows('INSERT INTO crove_finance.customer_collection (org_id, party_id, paused_until) VALUES ($1, $2, $3)', [o.orgId, paused, addDays(TODAY, 30)]);
    // Ninety day terms: the 35 day old invoice is not due yet. The pause stops the mail, not the debt.
    expect((await o.signals(o.owner, [terms, paused])).map((r) => r.partyId)).toEqual([paused]);
  });

  it('sums a customer who owes late in two entities, and answers a row for each asked id of a customer and its duplicate', async () => {
    const o = await org();
    const kept = await o.party('A');
    const dup = await o.party('A (trùng)');
    await rows('UPDATE crove_kernel.party SET duplicate_of = $3 WHERE org_id = $1 AND id = $2', [o.orgId, dup, kept]);
    await o.sale(kept, '1', dated(3), '1000000', o.entity);
    await o.sale(dup, '2', dated(9), '500000', o.branch);
    const both = await o.signals(o.owner, [kept, dup]);
    expect(both.map((r) => r.partyId).sort()).toEqual([kept, dup].sort());
    for (const row of both) expect(row).toMatchObject({ oldestDueOn: addDays(dated(9), 30), amount: '1500000', count: 2 });
  });

  it('refuses, and never answers the part it can see, when the caller\'s entity scope is narrower than the org', async () => {
    const o = await org();
    const p = await o.party('A');
    await o.sale(p, '1', dated(3), '1000000', o.entity);
    await expect(o.signals(o.branchMember, [p])).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    for (const user of [o.owner, o.member, o.viewer]) expect((await o.signals(user, [p])).map((r) => r.partyId), user).toEqual([p]);
    // A caller who sees every book and has no overdue customer gets an empty list: none is late.
    expect(await o.signals(o.owner, [await o.party('F')])).toEqual([]);
  });

  it('refuses a caller that is not a user, and an input outside its shape', async () => {
    const o = await org();
    const p = await o.party('A');
    await expect(rt.query('finance.signals.overdue_receivables', { partyIds: [p] }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    for (const bad of [{}, { partyIds: [] }, { partyIds: ['x'] }, { partyIds: [p], extra: 1 }, { partyIds: Array.from({ length: 501 }, () => randomUUID()) }]) {
      await expect(rt.query('finance.signals.overdue_receivables', bad, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toThrow();
    }
  });

  it('carries no text and no key outside the contract, and shows one org only its own debts', async () => {
    const a = await org();
    const b = await org();
    const pa = await a.party(SECRET_NAME);
    const pb = await b.party('B');
    await a.sale(pa, '1', dated(3), '123456789');
    await b.sale(pb, '1', dated(3), '1000000');
    const list = await a.signals(a.owner, [pa, pb]);
    expect(list.map((r) => r.partyId)).toEqual([pa]);
    const text = JSON.stringify(list);
    expect(text).not.toContain('bí mật');
    for (const row of list) expect(Object.keys(row).sort()).toEqual(['amount', 'count', 'oldestDueOn', 'partyId']);
  });
});

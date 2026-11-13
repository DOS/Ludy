// SPDX-License-Identifier: AGPL-3.0-only
// `finance.signals.sales`, Accounting's side of the first cross-app rule (Vy V4, #2967), on PostgreSQL 17: for the parties it is asked about, the day of the latest sales invoice and how many
// there are; a voided invoice and a purchase do not count; a party and its duplicates are one customer; an empty answer means "none exists" because
// the read REFUSES a caller whose books are only in part in view; the answer is the contract's and nothing else. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { SIGNAL_PARTIAL_VIEW_CODE, zFinanceSalesSignals, type FinanceSalesSignal } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const SECRET_NAME = 'Công ty bí mật của chị Lan';

suite('finance.signals.sales on PostgreSQL (#2967)', () => {
  const dbName = `crove_test_finance_sales_signals_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@sales.test`, name: null }) as Promise<string>;

  async function org() {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [member, viewer, branchMember] = [await identity('member'), await identity('viewer'), await identity('branch')];
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    const branch = (await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]?.id as string;
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer'), ($1, $4, 'member')", [orgId, member, viewer, branchMember]);
    // The branch member keeps the branch's books only (an entity-scoped assignment narrows the context's entity scope).
    await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, branchMember, branch, owner]);
    const signals = (user: string, partyIds: string[]) => rt.query<FinanceSalesSignal[]>('finance.signals.sales', { partyIds }, { actor: asUser(user), orgId });
    const party = (name: string) => rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind) VALUES ($1, $2, 'organization') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    // A recorded invoice with its entry (Dr 131, Cr 511 for a sale; the entry is what the books hold, the read looks at the document).
    async function invoice(partyId: string, number: string, date: string, total: string, direction: 'sale' | 'purchase' = 'sale', legalEntity: string = entity): Promise<string> {
      const doc = randomUUID();
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
           VALUES ($1, $2, $3, 'C26TAA', $4, $5, 'VND', $6, 0, $6, $7, $8)`,
          [orgId, doc, partyId, number, date, total, direction, legalEntity],
        );
        const entry = randomUUID();
        await c.query(
          `INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, $4, 'finance.purchase_document', $5, $6)`,
          [orgId, entry, date, `HĐ ${number}`, doc, legalEntity],
        );
        const [debit, credit] = direction === 'sale' ? ['131', '511'] : ['156', '331'];
        await c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id)
           VALUES ($1, $2, 1, $5, $3, 0, $4, $6), ($1, $2, 2, $7, 0, $3, $4, $6)`,
          [orgId, entry, total, partyId, debit, legalEntity, credit],
        );
        await c.query('COMMIT');
      });
      return doc;
    }
    // Voids an invoice the way a restore would write it: a superuser's statement that skips the triggers.
    const voidIt = (docId: string) =>
      admin(async (c) => {
        await c.query("SET session_replication_role = 'replica'");
        await c.query("INSERT INTO crove_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'sai')", [orgId, docId, randomUUID()]);
      });
    return { orgId, owner, member, viewer, branchMember, entity, branch, signals, party, invoice, voidIt };
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

  it('answers the latest sales invoice day and the count per asked party, and nothing for a party not asked or never invoiced', async () => {
    const o = await org();
    const [a, b, c, d] = [await o.party(SECRET_NAME), await o.party('B'), await o.party('C'), await o.party('D')];
    await o.invoice(a, '1', '2026-10-01', '1000000');
    await o.invoice(a, '2', '2026-11-05', '2000000');
    await o.invoice(b, '3', '2026-09-30', '500000');
    await o.invoice(c, '4', '2026-11-01', '700000');
    const list = await o.signals(o.owner, [a, b, d]);
    expect(list).toEqual([
      { partyId: a, lastSaleOn: '2026-11-05', count: 2 },
      { partyId: b, lastSaleOn: '2026-09-30', count: 1 },
    ].sort((x, y) => (x.partyId < y.partyId ? -1 : 1)));
    expect(zFinanceSalesSignals.safeParse(list).success).toBe(true);
    // A caller who sees every book and has no invoice for the asked party gets an empty list: none exists.
    expect(await o.signals(o.owner, [d])).toEqual([]);
  });

  it('does not count a voided invoice or a purchase', async () => {
    const o = await org();
    const p = await o.party('A');
    const voided = await o.invoice(p, '1', '2026-11-08', '1000000');
    await o.voidIt(voided);
    await o.invoice(p, '2', '2026-11-09', '1000000', 'purchase');
    expect(await o.signals(o.owner, [p])).toEqual([]);
    await o.invoice(p, '4', '2026-11-02', '300000');
    expect(await o.signals(o.owner, [p])).toEqual([{ partyId: p, lastSaleOn: '2026-11-02', count: 1 }]);
  });

  it('treats a party and the parties marked as its duplicates as one customer, and answers a row for each asked id', async () => {
    const o = await org();
    const kept = await o.party('A');
    const dup = await o.party('A (trùng)');
    await rows('UPDATE crove_kernel.party SET duplicate_of = $3 WHERE org_id = $1 AND id = $2', [o.orgId, dup, kept]);
    await o.invoice(dup, '1', '2026-11-03', '1000000');
    await o.invoice(kept, '2', '2026-11-04', '1000000');
    const both = await o.signals(o.owner, [kept, dup]);
    expect(both.map((r) => r.partyId).sort()).toEqual([kept, dup].sort());
    for (const row of both) expect(row).toMatchObject({ lastSaleOn: '2026-11-04', count: 2 });
    // The deal sits on the duplicate and the invoice on the kept party: still invoiced.
    expect(await o.signals(o.owner, [dup])).toEqual([{ partyId: dup, lastSaleOn: '2026-11-04', count: 2 }]);
  });

  it('refuses, and never answers the part it can see, when the caller\'s entity scope is narrower than the org', async () => {
    const o = await org();
    const p = await o.party('A');
    await o.invoice(p, '1', '2026-11-03', '1000000', 'sale', o.entity);
    // The branch member cannot open the default entity's invoice: an empty list would read as "never invoiced".
    await expect(o.signals(o.branchMember, [p])).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    // Even when their own entity holds an invoice of the party, the answer is a refusal, not one row.
    await o.invoice(p, '2', '2026-11-06', '1000000', 'sale', o.branch);
    await expect(o.signals(o.branchMember, [p])).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE });
    // A member and a viewer with the whole org in view get the full answer.
    for (const user of [o.owner, o.member, o.viewer]) expect(await o.signals(user, [p]), user).toEqual([{ partyId: p, lastSaleOn: '2026-11-06', count: 2 }]);
  });

  it('refuses a caller that is not a user, and an input outside its shape', async () => {
    const o = await org();
    const p = await o.party('A');
    await expect(rt.query('finance.signals.sales', { partyIds: [p] }, { actor: { type: 'system', component: 'test' }, orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    for (const bad of [{}, { partyIds: [] }, { partyIds: ['not-an-id'] }, { partyIds: [p], extra: 1 }, { partyIds: Array.from({ length: 501 }, () => randomUUID()) }]) {
      await expect(rt.query('finance.signals.sales', bad, { actor: asUser(o.owner), orgId: o.orgId })).rejects.toThrow();
    }
  });

  it('carries no text and no key outside the contract, and shows one org only its own invoices', async () => {
    const a = await org();
    const b = await org();
    const pa = await a.party(SECRET_NAME);
    const pb = await b.party('B');
    await a.invoice(pa, '1', '2026-11-03', '123456789');
    await b.invoice(pb, '1', '2026-11-04', '1000000');
    const list = await a.signals(a.owner, [pa, pb]);
    expect(list).toEqual([{ partyId: pa, lastSaleOn: '2026-11-03', count: 1 }]);
    const text = JSON.stringify(list);
    expect(text).not.toContain('bí mật');
    expect(text).not.toContain('123456789');
    for (const row of list) expect(Object.keys(row).sort()).toEqual(['count', 'lastSaleOn', 'partyId']);
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// `finance.mcp.payment_reminder` (#3849, tool 3) as the runtime runs it for a grant: the draft of one overdue customer's reminder with the fixed template words, the oldest invoices first, nothing
// sent or stored, and the refusals (nothing overdue, partial view, several legal entities, bad arguments, a browser session, no scope, a member). The privacy pin is
// apps/kernel/test/invariant/mcp-payment-reminder-projection.db.test.ts.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@ludy/db';
import { migrate, setRolePasswords } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { SIGNAL_PARTIAL_VIEW_CODE } from '@ludy/kernel-contract';
import { Runtime, type UserActor } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TOP_KEYS = ['currency', 'invoiceCount', 'invoices', 'lang', 'level', 'name', 'partyId', 'total', 'words'];
const INVOICE_KEYS = ['amountDue', 'date', 'daysOverdue', 'dueDate', 'number', 'series'];
const WORD_KEYS = ['closing', 'greeting', 'lead', 'subject'];
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

suite('finance.mcp.payment_reminder on PostgreSQL (#3849)', () => {
  const dbName = `crove_test_mcp_reminder_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const user = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const mcp = (userId: string, grantId: string, scopes: readonly string[] = ['ludy.read']): UserActor => ({ ...user(userId), mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes } });

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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@balances.test`, name: null }) as Promise<string>;

  async function org(withBranch = false) {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, user(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [member, branchAdmin] = [await identity('member'), await identity('branch')];
    const entity = (await rows<{ id: string }>('SELECT id FROM ludy_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    await rows("INSERT INTO ludy_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'admin')", [orgId, member, branchAdmin]);
    if (withBranch) {
      const branch = (await rows<{ id: string }>("INSERT INTO ludy_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]?.id as string;
      await rows("INSERT INTO ludy_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, branchAdmin, branch, owner]);
    }
    // Planted on purpose: the org's bank account number a reminder mail names (payTo), which a grant must never read.
    await rows("INSERT INTO ludy_finance.bank_account_number (org_id, legal_entity_id, bank_account, account_number) VALUES ($1, $2, '1121', '4455667788')", [orgId, entity]);
    const grant = async (userId: string) => {
      const id = randomUUID();
      await rows(
        `INSERT INTO ludy_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3)`,
        [orgId, id, userId, `oauth-${id}`, `client-${id}`],
      );
      return id;
    };
    // Planted on purpose: what a grant must never read.
    const party = (name: string) =>
      rows<{ id: string }>("INSERT INTO ludy_kernel.party (org_id, name, kind, email, phone, address) VALUES ($1, $2, 'organization', 'secret-contact@example.test', '0900000000', 'Số 9 Đường Bí Mật') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    // A sale (Dr 131 / Cr 511) or a purchase (Dr 156 / Cr 331) with its balanced entry, in one transaction.
    async function invoice(partyId: string, number: string, date: string, total: string, direction: 'sale' | 'purchase' = 'sale'): Promise<string> {
      const doc = randomUUID();
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO ludy_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
           VALUES ($1, $2, $3, 'SECRETSERIES', $4, $5, 'VND', $6, 0, $6, $7, $8)`,
          [orgId, doc, partyId, number, date, total, direction, entity],
        );
        const entry = randomUUID();
        await c.query(`INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'secret text', 'finance.purchase_document', $4, $5)`, [orgId, entry, date, doc, entity]);
        const [debit, credit] = direction === 'sale' ? ['131', '511'] : ['156', '331'];
        await c.query(
          `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, $5, $3, 0, $4, $6), ($1, $2, 2, $7, 0, $3, $4, $6)`,
          [orgId, entry, total, partyId, debit, entity, credit],
        );
        await c.query('COMMIT');
      });
      return doc;
    }
    // A balance on 131 that no sale invoice covers (a manual entry), for the part allocateReceivable cannot lay under an invoice.
    async function manualReceivable(partyId: string, date: string, total: string): Promise<void> {
      await admin(async (c) => {
        await c.query('BEGIN');
        const entry = randomUUID();
        await c.query(`INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'manual', 'finance.test', $4, $5)`, [orgId, entry, date, randomUUID(), entity]);
        await c.query(
          `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, '131', $3, 0, $4, $5), ($1, $2, 2, '511', 0, $3, $4, $5)`,
          [orgId, entry, total, partyId, entity],
        );
        await c.query('COMMIT');
      });
    }
    const read = async (userId: string, input: unknown) => rt.query<Record<string, unknown>>('finance.mcp.payment_reminder', input, { actor: mcp(userId, await grant(userId)), orgId });
    return { orgId, owner, member, branchAdmin, grant, party, invoice, manualReceivable, read };
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
    await setRolePasswords(adminUrl, { ludy_app: 'test-app-pw', ludy_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'ludy_app';
    url.password = 'test-app-pw';
    pool = createPool({ connectionString: url.toString(), max: 4 });
    db = createDb(pool);
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({ commands: [...kernelCommands, ...financeCommands], queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries] });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('drafts the reminder of an overdue customer: the oldest invoice first, the total of all, the fixed words', async () => {
    const o = await org();
    const p = await o.party('Khách trễ hạn');
    await o.invoice(p, 'A1', daysAgo(120), '1000000');
    await o.invoice(p, 'A2', daysAgo(50), '500000');
    const out = await o.read(o.owner, { partyId: p });
    expect(Object.keys(out).sort()).toEqual(TOP_KEYS);
    expect(out).toMatchObject({ partyId: p, name: 'Khách trễ hạn', lang: 'vi', invoiceCount: 2, total: '1500000' });
    expect([1, 2, 3]).toContain(out.level);
    const invoices = out.invoices as Array<Record<string, unknown>>;
    expect(invoices.map((i) => i.number)).toEqual(['A1', 'A2']);
    for (const i of invoices) expect(Object.keys(i).sort()).toEqual(INVOICE_KEYS);
    expect(Object.keys(out.words as object).sort()).toEqual(WORD_KEYS);
    for (const w of Object.values(out.words as Record<string, string>)) expect(w.length).toBeGreaterThan(0);
  });

  it('keeps the oldest 50 invoices, and counts and totals all of them', async () => {
    const o = await org();
    const p = await o.party('Khách nhiều hóa đơn');
    // 51 overdue invoices of 1000 each, the oldest dated 200 days ago.
    for (let i = 0; i < 51; i += 1) await o.invoice(p, `C${String(i).padStart(2, '0')}`, daysAgo(200 - i), '1000');
    const out = await o.read(o.owner, { partyId: p });
    const invoices = out.invoices as Array<{ number: string }>;
    expect(invoices).toHaveLength(50);
    expect(invoices[0]?.number).toBe('C00');
    expect(out).toMatchObject({ invoiceCount: 51, total: '51000' });
  }, 60_000);

  it('refuses a customer whose reminders are paused, as the screen does', async () => {
    const o = await org();
    const p = await o.party('Khách tạm dừng');
    await o.invoice(p, 'T1', daysAgo(90), '1000000');
    await rows("INSERT INTO ludy_finance.customer_collection (org_id, party_id, paused_until) VALUES ($1, $2, (now() + interval '10 days')::date)", [o.orgId, p]);
    await expect(o.read(o.owner, { partyId: p })).rejects.toMatchObject({ code: 'CUSTOMER_PAUSED', status: 409 });
  });

  it('refuses a customer with nothing overdue, as the screen does', async () => {
    const o = await org();
    const p = await o.party('Khách mới');
    await o.invoice(p, 'N1', daysAgo(3), '100000');
    await expect(o.read(o.owner, { partyId: p })).rejects.toMatchObject({ code: 'NOTHING_OVERDUE', status: 409 });
  });

  it('refuses a grant that sees only part of the books and an org with more than one legal entity', async () => {
    const o = await org(true);
    const p = await o.party('A');
    await o.invoice(p, '1', daysAgo(90), '1000000');
    await expect(o.read(o.branchAdmin, { partyId: p })).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    await expect(o.read(o.owner, { partyId: p })).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
  });

  it('refuses arguments outside the schema, a browser session, a grant without the scope and a member', async () => {
    const o = await org();
    const p = await o.party('B');
    await o.invoice(p, '1', daysAgo(90), '1000000');
    await expect(o.read(o.owner, {})).rejects.toBeTruthy();
    await expect(o.read(o.owner, { partyId: 'not-an-id' })).rejects.toBeTruthy();
    await expect(o.read(o.owner, { partyId: p, extra: 1 })).rejects.toBeTruthy();
    await expect(rt.query('finance.mcp.payment_reminder', { partyId: p }, { actor: user(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(rt.query('finance.mcp.payment_reminder', { partyId: p }, { actor: mcp(o.owner, await o.grant(o.owner), ['ludy.other']), orgId: o.orgId })).rejects.toBeTruthy();
    // The grant of a member (only an owner or an admin may consent) is not in standing: the same 401 as for a grant that never existed.
    await expect(o.read(o.member, { partyId: p })).rejects.toMatchObject({ status: 401, code: 'MCP_GRANT_INVALID' });
  });
});

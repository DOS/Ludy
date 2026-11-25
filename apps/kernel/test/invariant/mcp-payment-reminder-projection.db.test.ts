// SPDX-License-Identifier: AGPL-3.0-only
// The privacy pin of `finance.mcp.payment_reminder` (#3849, tool 3; Accounting PO's binding condition on #3907): the answer is exactly the keys below (the customer's name, the notice level and language,
// the currency, the overdue invoices with their series, number, dates and amount due, the total and the fixed words) and nothing else: no customer email, phone or address, no `payTo` bank account
// number or holder, no journal text. A partial view of the books and an org with more than one legal entity are refused; a browser session, a grant without the scope and a member are refused. Part of the
// invariant suite: its fixtures are its own. The product flow stays in apps/kernel/test/mcp-payment-reminder.db.test.ts.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { SIGNAL_PARTIAL_VIEW_CODE } from '@ludy/kernel-contract';
import { Runtime, type UserActor } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const TOP_KEYS = ['currency', 'invoiceCount', 'invoices', 'lang', 'level', 'name', 'partyId', 'total', 'words'];
const INVOICE_KEYS = ['amountDue', 'date', 'daysOverdue', 'dueDate', 'number', 'series'];
const WORD_KEYS = ['closing', 'greeting', 'lead', 'subject'];
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

suite('the privacy pin of finance.mcp.payment_reminder (#3849)', () => {
  const dbName = `crove_test_mcp_reminder_pin_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const user = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const mcp = (userId: string, grantId: string, scopes: readonly string[] = ['ludy.read']): UserActor => ({ ...user(userId), mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes } });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = createDbClient({ connectionString: adminUrl }, dbIds);
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
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'admin')", [orgId, member, branchAdmin]);
    if (withBranch) {
      const branch = (await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]?.id as string;
      await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, branchAdmin, branch, owner]);
    }
    // Planted on purpose: the org's bank account number a reminder mail names (payTo), which a grant must never read.
    await rows("INSERT INTO crove_finance.bank_account_number (org_id, legal_entity_id, bank_account, account_number) VALUES ($1, $2, '1121', '4455667788')", [orgId, entity]);
    const grant = async (userId: string) => {
      const id = randomUUID();
      await rows(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3)`,
        [orgId, id, userId, `oauth-${id}`, `client-${id}`],
      );
      return id;
    };
    // Planted on purpose: what a grant must never read.
    const party = (name: string) =>
      rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, email, phone, address) VALUES ($1, $2, 'organization', 'secret-contact@example.test', '0900000000', 'Số 9 Đường Bí Mật') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
    // A sale (Dr 131 / Cr 511) or a purchase (Dr 156 / Cr 331) with its balanced entry, in one transaction.
    async function invoice(partyId: string, number: string, date: string, total: string, direction: 'sale' | 'purchase' = 'sale'): Promise<string> {
      const doc = randomUUID();
      await admin(async (c) => {
        await c.query('BEGIN');
        await c.query(
          `INSERT INTO crove_finance.purchase_document (org_id, id, party_id, invoice_series, invoice_number, invoice_date, currency, subtotal, vat_amount, total, direction, legal_entity_id)
           VALUES ($1, $2, $3, 'SECRETSERIES', $4, $5, 'VND', $6, 0, $6, $7, $8)`,
          [orgId, doc, partyId, number, date, total, direction, entity],
        );
        const entry = randomUUID();
        await c.query(`INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'secret text', 'finance.purchase_document', $4, $5)`, [orgId, entry, date, doc, entity]);
        const [debit, credit] = direction === 'sale' ? ['131', '511'] : ['156', '331'];
        await c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id, legal_entity_id) VALUES ($1, $2, 1, $5, $3, 0, $4, $6), ($1, $2, 2, $7, 0, $3, $4, $6)`,
          [orgId, entry, total, partyId, debit, entity, credit],
        );
        await c.query('COMMIT');
      });
      return doc;
    }
    const read = async (userId: string, input: unknown) => rt.query<Record<string, unknown>>('finance.mcp.payment_reminder', input, { actor: mcp(userId, await grant(userId)), orgId });
    return { orgId, owner, member, branchAdmin, grant, party, invoice, read };
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
    dbIds = await resolveDbIdentifiers(adminUrl);
    await setActiveRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' }, dbIds);
    const url = new URL(adminUrl);
    url.username = dbIds ? dbIds.roleName('crove_app') : 'crove_app';
    url.password = 'test-app-pw';
    pool = createDbPool({ connectionString: url.toString(), max: 4 }, dbIds);
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


  const SECRETS = ['secret-contact@example.test', '0900000000', 'Số 9 Đường Bí Mật', '4455667788', 'secret text'];

  it('returns exactly the projected keys, with no contact, bank or journal detail', async () => {
    const o = await org();
    const p = await o.party('Khách hàng');
    await o.invoice(p, 'S1', daysAgo(90), '1000000');
    const out = await o.read(o.owner, { partyId: p });
    expect(Object.keys(out).sort()).toEqual(TOP_KEYS);
    expect(Object.keys((out.invoices as object[])[0] as object).sort()).toEqual(INVOICE_KEYS);
    expect(Object.keys(out.words as object).sort()).toEqual(WORD_KEYS);
    const wire = JSON.stringify(out);
    for (const secret of SECRETS) expect(wire, secret).not.toContain(secret);
  });

  it('refuses a partial view, an org with several legal entities, a browser session, a grant without the scope and a member', async () => {
    const o = await org(true);
    const p = await o.party('A');
    await o.invoice(p, '1', daysAgo(90), '1000000');
    await expect(o.read(o.branchAdmin, { partyId: p })).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    await expect(o.read(o.owner, { partyId: p })).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    const plain = await org();
    const q = await plain.party('C');
    await plain.invoice(q, '1', daysAgo(90), '1000000');
    await expect(rt.query('finance.mcp.payment_reminder', { partyId: q }, { actor: user(plain.owner), orgId: plain.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(rt.query('finance.mcp.payment_reminder', { partyId: q }, { actor: mcp(plain.owner, await plain.grant(plain.owner), ['ludy.other']), orgId: plain.orgId })).rejects.toBeTruthy();
    await expect(plain.read(plain.member, { partyId: q })).rejects.toMatchObject({ status: 401, code: 'MCP_GRANT_INVALID' });
  });
});

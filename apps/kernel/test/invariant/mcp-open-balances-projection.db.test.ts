// SPDX-License-Identifier: AGPL-3.0-only
// The privacy pin of `finance.mcp.open_balances` (#3849, tool 2; Accounting PO's binding condition on #3907): per party exactly its id, its name, the open amount, the five age buckets and the count of
// open invoices, for receivables and for payables, and nothing else: no email, phone, address, bank detail, invoice series or number, no journal text. A partial view of the books and an org with
// more than one legal entity are refused; a browser session, a grant without the scope and a member are refused. Part of the invariant suite: its fixtures are its own. The product flow stays in
// apps/kernel/test/mcp-open-balances.db.test.ts.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { SIGNAL_PARTIAL_VIEW_CODE } from '@crove/kernel-contract';
import { Runtime, type UserActor } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ROW_KEYS = ['buckets', 'invoiceCount', 'name', 'open', 'partyId'];
const BUCKET_KEYS = ['d1to30', 'd31to60', 'd61to90', 'notYet', 'over90'];
const TOP_KEYS = ['asOf', 'basis', 'parties', 'side', 'total', 'truncated'];
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

suite('the privacy pin of finance.mcp.open_balances (#3849)', () => {
  const dbName = `crove_test_mcp_balances_pin_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'admin')", [orgId, member, branchAdmin]);
    if (withBranch) {
      const branch = (await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]?.id as string;
      await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4)", [orgId, branchAdmin, branch, owner]);
    }
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
      rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, email, phone, address) VALUES ($1, $2, 'organization', 'secret-contact@example.test', '0909000111', 'Số 9 Đường Bí Mật') RETURNING id", [orgId, name]).then((r) => (r[0] as { id: string }).id);
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
    const read = async (userId: string, input: unknown) => rt.query<Record<string, unknown>>('finance.mcp.open_balances', input, { actor: mcp(userId, await grant(userId)), orgId });
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
    await setRolePasswords(adminUrl, { crove_app: 'test-app-pw', crove_worker: 'test-worker-pw' });
    const url = new URL(adminUrl);
    url.username = 'crove_app';
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

  const SECRETS = ['secret-contact@example.test', '0909000111', 'Số 9 Đường Bí Mật', 'SECRETSERIES', 'secret text'];

  it('returns exactly the projected keys for receivables and payables, with no contact, bank or invoice detail', async () => {
    const o = await org();
    const [customer, supplier] = [await o.party('Khách hàng'), await o.party('Nhà cung cấp')];
    await o.invoice(customer, 'S1', daysAgo(45), '1000000');
    await o.invoice(supplier, 'B1', daysAgo(45), '800000', 'purchase');
    for (const side of ['receivable', 'payable'] as const) {
      const out = await o.read(o.owner, { side });
      expect(Object.keys(out).sort(), side).toEqual(TOP_KEYS);
      const parties = out.parties as Array<{ buckets: object }>;
      expect(parties.length, side).toBe(1);
      for (const row of parties) {
        expect(Object.keys(row).sort(), side).toEqual(ROW_KEYS);
        expect(Object.keys(row.buckets).sort(), side).toEqual(BUCKET_KEYS);
      }
      const wire = JSON.stringify(out);
      for (const secret of SECRETS) expect(wire, `${side} ${secret}`).not.toContain(secret);
    }
  });

  it('refuses a partial view, an org with several legal entities, a browser session, a grant without the scope and a member', async () => {
    const o = await org(true);
    await expect(o.read(o.branchAdmin, { side: 'payable' })).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    await expect(o.read(o.owner, { side: 'payable' })).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    const plain = await org();
    await expect(rt.query('finance.mcp.open_balances', { side: 'payable' }, { actor: user(plain.owner), orgId: plain.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(rt.query('finance.mcp.open_balances', { side: 'payable' }, { actor: mcp(plain.owner, await plain.grant(plain.owner), ['ludy.other']), orgId: plain.orgId })).rejects.toBeTruthy();
    await expect(plain.read(plain.member, { side: 'payable' })).rejects.toMatchObject({ status: 401, code: 'MCP_GRANT_INVALID' });
  });
});

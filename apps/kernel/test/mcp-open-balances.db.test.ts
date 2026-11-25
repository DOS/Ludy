// SPDX-License-Identifier: AGPL-3.0-only
// `finance.mcp.open_balances` (#3849, tool 2) as the runtime runs it for a grant: receivables per customer aged by days past due, payables per supplier aged by invoice date, oldest first,
// capped, the figures of the books and no more, and the refusals (partial view, several legal entities, bad arguments, a browser session, no scope, a member). The privacy pin is
// apps/kernel/test/invariant/mcp-open-balances-projection.db.test.ts.
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

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const ROW_KEYS = ['buckets', 'invoiceCount', 'name', 'open', 'partyId'];
const BUCKET_KEYS = ['d1to30', 'd31to60', 'd61to90', 'notYet', 'over90'];
const TOP_KEYS = ['asOf', 'basis', 'parties', 'side', 'total', 'truncated'];
const DAY_MS = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);

suite('finance.mcp.open_balances on PostgreSQL (#3849)', () => {
  const dbName = `ludy_test_mcp_balances_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
    // A voided invoice, as a restore would write it (a superuser's statement that skips the triggers), and a request to pay one that waits for approval.
    const voidIt = (docId: string) =>
      admin(async (c) => {
        await c.query("SET session_replication_role = 'replica'");
        await c.query("INSERT INTO ludy_finance.purchase_document_void (org_id, document_id, reversal_entry_id, reason) VALUES ($1, $2, $3, 'sai')", [orgId, docId, randomUUID()]);
      });
    const pendingRequest = (docId: string) =>
      rows(
        `INSERT INTO ludy_kernel.proposal (org_id, id, kind, command, status, title, payload, authors, eligible_approvers)
         VALUES ($1, $2, 'finance.supplier_payment', 'finance.supplier_payment.record', 'pending', 'Chi nhà cung cấp', $3::jsonb, $4::jsonb, $5::uuid[])`,
        [orgId, randomUUID(), JSON.stringify({ purchaseDocumentId: docId }), JSON.stringify([{ type: 'user', id: owner }]), [owner]],
      );
    const read = async (userId: string, input: unknown) => rt.query<Record<string, unknown>>('finance.mcp.open_balances', input, { actor: mcp(userId, await grant(userId)), orgId });
    return { orgId, owner, member, branchAdmin, grant, party, invoice, manualReceivable, voidIt, pendingRequest, read };
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

  it('lists receivables per customer, oldest first, aged by days past due with the default 30-day terms', async () => {
    const o = await org();
    const [late, fresh] = [await o.party('Khách trễ'), await o.party('Khách mới')];
    await o.invoice(late, '1', daysAgo(100), '1000000');
    await o.invoice(late, '2', daysAgo(10), '500000');
    await o.invoice(fresh, '3', daysAgo(5), '300000');
    const out = await o.read(o.owner, { side: 'receivable' });
    expect(Object.keys(out).sort()).toEqual(TOP_KEYS);
    expect(out).toMatchObject({ side: 'receivable', basis: 'due_date', total: 2, truncated: false });
    const parties = out.parties as Array<{ partyId: string; name: string; open: string; buckets: Record<string, string>; invoiceCount: number }>;
    expect(parties.map((p) => p.partyId)).toEqual([late, fresh]);
    expect(parties[0]).toMatchObject({ name: 'Khách trễ', open: '1500000', invoiceCount: 2 });
    expect(Object.keys(parties[0] ?? {}).sort()).toEqual(ROW_KEYS);
    expect(Object.keys(parties[0]?.buckets ?? {}).sort()).toEqual(BUCKET_KEYS);
    expect(parties[0]?.buckets).toMatchObject({ d61to90: '1000000', notYet: '500000', over90: '0' });
    expect(parties[1]).toMatchObject({ open: '300000', invoiceCount: 1 });
  });

  it('counts a 131 balance no invoice covers as open and not yet due', async () => {
    const o = await org();
    const p = await o.party('Khách số dư đầu kỳ');
    await o.manualReceivable(p, daysAgo(200), '400000');
    const out = await o.read(o.owner, { side: 'receivable' });
    const parties = out.parties as Array<{ partyId: string; open: string; buckets: Record<string, string>; invoiceCount: number }>;
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({ partyId: p, open: '400000', invoiceCount: 0 });
    expect(parties[0]?.buckets).toMatchObject({ notYet: '400000', over90: '0' });
  });

  it('lists payables per supplier aged by invoice date, capped and flagged as truncated', async () => {
    const o = await org();
    const [a, b] = [await o.party('NCC cũ'), await o.party('NCC mới')];
    await o.invoice(a, 'P1', daysAgo(95), '2000000', 'purchase');
    await o.invoice(b, 'P2', daysAgo(3), '700000', 'purchase');
    const out = await o.read(o.owner, { side: 'payable', limit: 1 });
    expect(out).toMatchObject({ side: 'payable', basis: 'invoice_date', total: 2, truncated: true });
    const parties = out.parties as Array<{ partyId: string; open: string; buckets: Record<string, string> }>;
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({ partyId: a, open: '2000000' });
    expect(parties[0]?.buckets).toMatchObject({ over90: '2000000', d1to30: '0' });
  });

  it('leaves out of the payables a voided invoice and one with a request waiting for approval, as the Ask-to-pay list does', async () => {
    const o = await org();
    const supplier = await o.party('NCC');
    const open = await o.invoice(supplier, 'P1', daysAgo(40), '1000000', 'purchase');
    const voided = await o.invoice(supplier, 'P2', daysAgo(40), '2000000', 'purchase');
    const asked = await o.invoice(supplier, 'P3', daysAgo(40), '4000000', 'purchase');
    expect(open).toBeTruthy();
    await o.voidIt(voided);
    await o.pendingRequest(asked);
    const out = await o.read(o.owner, { side: 'payable' });
    const parties = out.parties as Array<{ open: string; invoiceCount: number }>;
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({ open: '1000000', invoiceCount: 1 });
  });

  it('refuses a grant that sees only part of the books and an org with more than one legal entity', async () => {
    const o = await org(true);
    const p = await o.party('A');
    await o.invoice(p, '1', daysAgo(40), '1000000');
    await expect(o.read(o.branchAdmin, { side: 'receivable' })).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    await expect(o.read(o.owner, { side: 'receivable' })).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
  });

  it('refuses arguments outside the schema, a browser session, a grant without the scope and a member', async () => {
    const o = await org();
    await expect(o.read(o.owner, {})).rejects.toBeTruthy();
    await expect(o.read(o.owner, { side: 'both' })).rejects.toBeTruthy();
    await expect(o.read(o.owner, { side: 'payable', limit: 51 })).rejects.toBeTruthy();
    // The entity is not the caller's to choose: an extra key is refused before any query runs.
    await expect(o.read(o.owner, { side: 'payable', legalEntityId: randomUUID() })).rejects.toMatchObject({ status: 422 });
    await expect(rt.query('finance.mcp.open_balances', { side: 'payable' }, { actor: user(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    const noScope = await rt.query('finance.mcp.open_balances', { side: 'payable' }, { actor: mcp(o.owner, await o.grant(o.owner), ['ludy.other']), orgId: o.orgId }).then(() => null, (e: { status?: number; details?: unknown }) => e);
    expect([noScope?.status, noScope?.details]).toEqual([403, expect.objectContaining({ rule: 'mcp_scope' })]);
    await expect(o.read(o.member, { side: 'payable' })).rejects.toMatchObject({ status: 401, code: 'MCP_GRANT_INVALID' });
  });
});

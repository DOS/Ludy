// SPDX-License-Identifier: AGPL-3.0-only
// The privacy pin of `finance.mcp.overview` (#3849, tool 1; Accounting PO's binding condition on #3907): what a grant reads is the exact set of keys below, four money
// figures of the period and their dates, and nothing else: no customer email or phone, no bank account number or holder, no invoice line, no free text of the books, no
// monthly series or expense mix. A partial view of the books is refused, and a browser session, a grant without the scope and a member are refused. Part of the invariant
// suite: its fixtures are its own. The product flow of the same tool stays in apps/kernel/test/mcp-overview.db.test.ts.
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
const FIGURE_KEYS = ['amount', 'change', 'changePercent', 'previous'];
const KEYS = ['cash', 'empty', 'from', 'payables', 'previousFrom', 'previousTo', 'profit', 'range', 'receivables', 'to', 'unmapped'];

suite('finance.mcp.overview on PostgreSQL (#3849)', () => {
  const dbName = `crove_test_mcp_overview_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@overview.test`, name: null }) as Promise<string>;

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
    // Planted on purpose: what a grant must never read.
    const planted = (await rows<{ id: string }>("INSERT INTO crove_kernel.party (org_id, name, kind, email, phone) VALUES ($1, 'Khách bí mật', 'organization', 'secret-customer@example.test', '0900000000') RETURNING id", [orgId]))[0]?.id as string;
    expect(planted).toBeTruthy();
    const grant = async (userId: string) => {
      const id = randomUUID();
      await rows(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3)`,
        [orgId, id, userId, `oauth-${id}`, `client-${id}`],
      );
      return id;
    };
    // One balanced entry on the default entity: Dr cash 111 / Cr revenue 511 (a receipt), Dr 131 / Cr 511 (a sale on credit), Dr 642 / Cr 331 (a bill not yet paid).
    const post = async (date: string, debit: string, credit: string, amount: string) =>
      admin(async (c) => {
        await c.query('BEGIN');
        const entry = randomUUID();
        await c.query(`INSERT INTO crove_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'secret text', 'finance.test', $4, $5)`, [orgId, entry, date, randomUUID(), entity]);
        await c.query(
          `INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, legal_entity_id) VALUES ($1, $2, 1, $3, $5, 0, $6), ($1, $2, 2, $4, 0, $5, $6)`,
          [orgId, entry, debit, credit, amount, entity],
        );
        await c.query('COMMIT');
      });
    const read = async (userId: string, input: unknown = {}) => rt.query<Record<string, unknown>>('finance.mcp.overview', input, { actor: mcp(userId, await grant(userId)), orgId });
    return { orgId, owner, member, branchAdmin, grant, post, read };
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

  it('returns the screen\'s own figures for the period and nothing else', async () => {
    const o = await org();
    await o.post('2026-11-10', '111', '511', '5000000');
    await o.post('2026-11-11', '131', '511', '2000000');
    await o.post('2026-11-12', '642', '331', '800000');
    const asOf = '2026-11-15';
    const screen = await rt.query<Record<string, unknown>>('finance.overview', { range: 'this_month', asOf }, { actor: user(o.owner), orgId: o.orgId });
    const seen = await o.read(o.owner, { range: 'this_month' });
    expect(Object.keys(seen).sort()).toEqual(KEYS);
    // The same range on the same books reads the same figures (the screen is asked with an explicit day, the tool with the database's today: compare what does not move with it).
    expect(seen.range).toBe('this_month');
    for (const key of ['cash', 'receivables', 'payables'] as const) expect((seen[key] as { amount: string }).amount, key).toBe((screen[key] as { amount: string }).amount);
    expect(typeof (seen.profit as { amount: unknown }).amount).toBe('string');
    expect(screen.receivables).toMatchObject({ amount: '2000000' });
    expect(seen.receivables).toMatchObject({ amount: '2000000' });
    expect(seen.payables).toMatchObject({ amount: '800000' });
    expect(seen.cash).toMatchObject({ amount: '5000000' });
    const wire = JSON.stringify(seen);
    for (const secret of ['secret text', 'secret-customer@example.test', '0900000000', 'Khách bí mật']) expect(wire, secret).not.toContain(secret);
    for (const key of ['cash', 'profit', 'receivables', 'payables']) expect(Object.keys(seen[key] as object).sort(), key).toEqual(FIGURE_KEYS);
    expect(seen).not.toHaveProperty('months');
    expect(seen).not.toHaveProperty('expenses');
  });

  it('refuses an org with more than one legal entity, for the branch-scoped admin and for the owner alike, and never answers the part it sees', async () => {
    const o = await org(true);
    await o.post('2026-11-10', '111', '511', '5000000');
    // Both are refused by the entity count (the figures are one entity's, so with a second entity they are a part of the books); the scope check of wholeOrg is the guard for a grant that cannot see every entity.
    await expect(o.read(o.branchAdmin)).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    await expect(o.read(o.owner)).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
  });

  it('refuses arguments outside the schema, a browser session, a grant without the scope and a member', async () => {
    const o = await org();
    await expect(o.read(o.owner, { range: 'forever' })).rejects.toBeTruthy();
    await expect(o.read(o.owner, { range: 'this_month', legalEntityId: randomUUID() })).rejects.toBeTruthy();
    await expect(rt.query('finance.mcp.overview', {}, { actor: user(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(rt.query('finance.mcp.overview', {}, { actor: mcp(o.owner, await o.grant(o.owner), ['ludy.other']), orgId: o.orgId })).rejects.toBeTruthy();
    await expect(o.read(o.member)).rejects.toMatchObject({ status: 403 });
  });
});

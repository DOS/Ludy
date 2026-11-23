// SPDX-License-Identifier: AGPL-3.0-only
// `finance.mcp.overview` (#3849, tool 1) as the runtime runs it for a grant: the same figures the overview screen reads, a projection with nothing more, a refusal for a
// partial view of the books, and a closed door for a browser session, a grant without the scope and a member.
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
const KEYS = ['cash', 'empty', 'from', 'outputVatUnsettled', 'payables', 'previousFrom', 'previousTo', 'profit', 'range', 'receivables', 'to', 'unmapped'];

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
    // One balanced entry on the default entity: Dr cash 111 / Cr revenue 511 (a receipt), Dr 131 / Cr 511 (a sale on credit), Dr 642 / Cr 331 (a bill not yet paid).
    const post = async (date: string, debit: string, credit: string, amount: string) =>
      admin(async (c) => {
        await c.query('BEGIN');
        const entry = randomUUID();
        await c.query(`INSERT INTO ludy_finance.journal_entry (org_id, id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, $3, 'secret text', 'finance.test', $4, $5)`, [orgId, entry, date, randomUUID(), entity]);
        await c.query(
          `INSERT INTO ludy_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, legal_entity_id) VALUES ($1, $2, 1, $3, $5, 0, $6), ($1, $2, 2, $4, 0, $5, $6)`,
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
    expect(JSON.stringify(seen)).not.toContain('secret text');
    expect(seen).not.toHaveProperty('months');
    expect(seen).not.toHaveProperty('expenses');
  });

  it('reads the output VAT not yet settled as the credit balance of account 3331 at the period\'s end, against the earlier period\'s (not the VAT return\'s net tax)', async () => {
    const o = await org();
    // 3331 credited by two sales' VAT this month and one last month; a settlement (Dr 3331 / Cr 1331) of 100000 this month lowers it.
    await o.post('2026-10-20', '131', '3331', '300000');
    await o.post('2026-11-05', '131', '3331', '500000');
    await o.post('2026-11-06', '131', '3331', '200000');
    await o.post('2026-11-07', '3331', '1331', '100000');
    const today = (await rows<{ d: string }>("SELECT to_char((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, 'YYYY-MM-DD') AS d"))[0]?.d as string;
    // The same period as the answer's, so the expected figure is read from the books themselves (trial of account 3331 by SQL), not from the code under test.
    const seen = await o.read(o.owner, { range: 'this_year' });
    const sums = async (to: string) => (await rows<{ n: string | null }>("SELECT sum(l.credit - l.debit)::text AS n FROM ludy_finance.journal_line l JOIN ludy_finance.journal_entry j ON j.org_id = l.org_id AND j.id = l.entry_id WHERE l.org_id = $1 AND l.account_code LIKE '3331%' AND j.entry_date <= $2", [o.orgId, to]))[0]?.n ?? '0';
    const vat = seen.outputVatUnsettled as { amount: string; previous: string; change: string };
    expect(Number(vat.amount)).toBe(Number(await sums(seen.to as string)));
    expect(Number(vat.previous)).toBe(Number(await sums(seen.previousTo as string)));
    // The dates of the seed are in 2026: when the run's own year is another one the totals above still tie to the books, and the fixed amounts only apply in 2026.
    if (today.startsWith('2026-')) expect(Number(vat.amount)).toBe(900000);
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
    // The grant of a member (only an owner or an admin may consent) is not in standing: the same 401 as for a grant that never existed.
    await expect(o.read(o.member)).rejects.toMatchObject({ status: 401, code: 'MCP_GRANT_INVALID' });
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// The privacy pin of `finance.mcp.month_close` (#5346; design approved on the issue): what a grant reads is the month it asked for and, per checklist item, exactly its key, how many things are open and
// the VAT period it refers to, and nothing else: no amount, no name, no title or text of a proposal, no bank line text, no id, not the legal entity id and not the screen's link hint. The month is required
// and strict (no entity, no other key). An org with more than one legal entity is refused, a member-bound grant (even of a branch-limited member) is refused, and so are a browser session, a grant without
// the scope and a member. Part of the invariant suite: its fixtures are its own. The product flow stays in apps/kernel/test/mcp-month-close.db.test.ts.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ludy/db';
import { migrate } from '@ludy/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@ludy/kernel';
import { SIGNAL_PARTIAL_VIEW_CODE } from '@ludy/kernel-contract';
import { DomainError, Runtime, type UserActor } from '@ludy/kernel-runtime';
import { financeCommands, financeQueries } from '@ludy/mod-finance';
import { TEST_MANIFESTS } from './fixtures/manifests.ts';
import { createDbClient, createDbPool, resolveDbIdentifiers, setActiveRolePasswords, type DbIdentifiers } from './fixtures/db-identifiers.ts';

const ADMIN = process.env.LUDY_TEST_ADMIN_URL ?? process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;
const KEYS = ['items', 'month'];
const ITEM_KEYS = ['count', 'key', 'period'];
const ITEM_NAMES = ['proposals', 'invoices', 'bank', 'marketplace', 'stock', 'vat', 'lock'];
// Words and figures planted in the books that must never leave.
const SECRETS = ['Đề xuất bí mật', 'Ông Nam', 'chuyển khoản bí mật', '500000', 'secret supplier'];
const DROPPED = ['legalEntityId', 'note', 'text', 'direction'];

suite('the privacy pin of finance.mcp.month_close (#5346)', () => {
  const dbName = `crove_test_mcp_close_pin_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let dbIds: DbIdentifiers | undefined;
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const user = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const mcp = (userId: string, grantId: string, scopes: readonly string[] = ['ludy.read'], kind: 'company' | 'member' = 'company'): UserActor => ({ ...user(userId), mcp: { grantId, clientId: 'client-1', clientName: 'Test client', scopes, kind } });

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
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@close-pin.test`, name: null }) as Promise<string>;

  async function org(withBranch = false) {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, user(owner), `Org ${randomUUID().slice(0, 6)}`);
    const [member, branchAdmin, branchMember] = [await identity('member'), await identity('branch'), await identity('branchmember')];
    const entity = (await rows<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))[0]?.id as string;
    await rows("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'admin'), ($1, $4, 'member')", [orgId, member, branchAdmin, branchMember]);
    if (withBranch) {
      const branch = (await rows<{ id: string }>("INSERT INTO crove_kernel.legal_entity (org_id, name, kind, created_by) VALUES ($1, 'Chi nhánh', 'branch', $2) RETURNING id", [orgId, owner]))[0]?.id as string;
      await rows("INSERT INTO crove_kernel.role_assignment (org_id, user_id, role_key, legal_entity_id, granted_by) VALUES ($1, $2, 'external_accountant', $3, $4), ($1, $5, 'external_accountant', $3, $4)", [orgId, branchAdmin, branch, owner, branchMember]);
    }
    const grant = async (userId: string, kind: 'company' | 'member' = 'company') => {
      const id = randomUUID();
      await rows(
        `INSERT INTO crove_kernel.agent_grant (org_id, id, user_id, client_id, client_name, client_host, scopes, oauth_grant_id, created_at, expires_at, created_by, kind, member_id)
         VALUES ($1, $2, $3, $5, 'Test client', 'client.example.com', ARRAY['ludy.read'], $4, now(), now() + interval '30 days', $3, $6, ${kind === 'member' ? '$3' : 'NULL'})`,
        [orgId, id, userId, `oauth-${id}`, `client-${id}`, kind],
      );
      return id;
    };
    // Planted on purpose: a pending proposal dated in March 2026 with words in its title and payload, and a bank line of March that no entry books, with text and an amount.
    await rows(
      `INSERT INTO crove_kernel.proposal (org_id, kind, command, title, payload, eligible_approvers, authors)
       VALUES ($1, 'finance.journal_voucher', 'finance.journal_voucher.record', 'Đề xuất bí mật Ông Nam', $2, ARRAY[$3::uuid], '[]')`,
      [orgId, JSON.stringify({ date: '2026-03-10', memo: 'secret supplier', lines: [] }), owner],
    );
    await rows(`INSERT INTO crove_finance.bank_line (org_id, bank_account, import_id, position, value_date, description, amount) VALUES ($1, '1121', $2, 1, DATE '2026-03-12', 'chuyển khoản bí mật Ông Nam', 500000)`, [orgId, randomUUID()]);
    const read = async (userId: string, input: unknown = { month: '2026-03' }) => rt.query<Record<string, unknown>>('finance.mcp.month_close', input, { actor: mcp(userId, await grant(userId)), orgId });
    return { orgId, owner, member, branchAdmin, branchMember, entity, grant, read };
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

  it('returns the month and, per item, exactly its key, its count and its period, and nothing of the planted words', async () => {
    const o = await org();
    const seen = await o.read(o.owner);
    expect(Object.keys(seen).sort()).toEqual(KEYS);
    for (const key of DROPPED) expect(seen, key).not.toHaveProperty(key);
    expect(seen.month).toBe('2026-03');
    const items = seen.items as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
      expect(ITEM_NAMES).toContain(item.key);
      expect(Number.isInteger(item.count)).toBe(true);
      expect(item.period === null || typeof item.period === 'string').toBe(true);
    }
    // The planted proposal, the planted bank line and the period that is not locked: one each, as counts.
    const count = (key: string) => items.find((i) => i.key === key)?.count;
    expect(count('proposals')).toBe(1);
    expect(count('bank')).toBe(1);
    expect(count('lock')).toBe(1);
    const wire = JSON.stringify(seen);
    for (const secret of [...SECRETS, o.entity, o.orgId]) expect(wire, secret).not.toContain(secret);
    for (const word of ['"title"', '"payload"', '"description"', '"amount"', '"legalEntityId"', '"id"']) expect(wire, word).not.toContain(word);
  });

  it('refuses an org with more than one legal entity, for the branch-scoped admin and for the owner alike', async () => {
    const o = await org(true);
    await expect(o.read(o.branchAdmin)).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
    await expect(o.read(o.owner)).rejects.toMatchObject({ code: SIGNAL_PARTIAL_VIEW_CODE, status: 403 });
  });

  it('refuses a member-bound grant, of a member who sees the whole org and of a branch-limited one: the finance reads are for a company grant only', async () => {
    const o = await org(true);
    await rows('UPDATE crove_kernel.tenant SET mcp_member_grants = true WHERE org_id = $1', [o.orgId]);
    for (const member of [o.member, o.branchMember]) {
      const g = await o.grant(member, 'member');
      const error = await rt.query('finance.mcp.month_close', { month: '2026-03' }, { actor: mcp(member, g, ['ludy.read'], 'member'), orgId: o.orgId }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, 'a member-bound grant must be refused').toBeInstanceOf(DomainError);
      expect([401, 403]).toContain((error as DomainError).status);
    }
  });

  it('refuses a missing or malformed month and any other argument, a browser session, a grant without the scope and a member', async () => {
    const o = await org();
    for (const bad of [{}, { month: '2026-13' }, { month: '2101-01' }, { month: '1999-12' }, { month: 'march' }, { month: 202603 }, { month: '2026-03', legalEntityId: randomUUID() }, { month: '2026-03', note: 'x' }]) {
      await expect(o.read(o.owner, bad), JSON.stringify(bad)).rejects.toBeTruthy();
    }
    await expect(rt.query('finance.mcp.month_close', { month: '2026-03' }, { actor: user(o.owner), orgId: o.orgId })).rejects.toMatchObject({ status: 403 });
    await expect(rt.query('finance.mcp.month_close', { month: '2026-03' }, { actor: mcp(o.owner, await o.grant(o.owner), ['ludy.other']), orgId: o.orgId })).rejects.toBeTruthy();
    // The grant of a member (only an owner or an admin may consent) is not in standing: the same 401 as for a grant that never existed.
    await expect(o.read(o.member)).rejects.toMatchObject({ status: 401, code: 'MCP_GRANT_INVALID' });
  });
});

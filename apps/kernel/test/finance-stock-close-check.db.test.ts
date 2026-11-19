// SPDX-License-Identifier: AGPL-3.0-only
// The warning before closing a month of stock (#3712 slice 3) on a real PostgreSQL 17: finance.stock.close_check reads the entity's books regime on the month's last day and its 1381 balance
// (a count's shortage beyond the norm) at that day. It applies under Circular 99 for a debit balance, never under Circular 133, not before the balance exists, and it only warns: it writes nothing.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run creates and drops its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { StockCloseCheck } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the 1381 warning before closing a month of stock (#3712 slice 3)', () => {
  const dbName = `crove_test_stockclosecheck_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
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
  const rows = <T extends pg.QueryResultRow = Record<string, unknown>>(text: string, values: unknown[] = []) => admin(async (c) => (await c.query<T>(text, values)).rows);
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@surplus.test`, name: null });
  type Org = { orgId: string; owner: string; admin: string; member: string; viewer: string };
  async function org(regime: 'tt133' | 'tt99' = 'tt133'): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Công ty Kho ${randomUUID().slice(0, 6)}`);
    const [adminUser, member, viewer] = await Promise.all([identity('admin'), identity('member'), identity('viewer')]);
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member'), ($1, $4, 'viewer')", [orgId, adminUser, member, viewer]));
    if (regime === 'tt99') {
      await admin((c) =>
        c.query("INSERT INTO crove_finance.legal_entity_books (org_id, legal_entity_id, regime, chart_version, effective_from) SELECT $1, id, 'tt99', '2026.1', '2026-01-01' FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default", [orgId]),
      );
    }
    return { orgId, owner, admin: adminUser, member, viewer };
  }
  const execute = <T>(o: Org, name: string, input: unknown, user = o.member) => rt.execute<T>(name, input, { actor: asMfa(user), orgId: o.orgId, idempotencyKey: randomUUID() });
  const query = <T>(o: Org, name: string, input: unknown, user = o.member) => rt.query<T>(name, input, { actor: asUser(user), orgId: o.orgId });
  const makeItem = (o: Org, code: string) =>
    execute<{ id: string }>(o, 'finance.stock_item.save', { itemId: null, legalEntityId: null, code, name: `Hàng ${code}`, unit: 'cái', stockAccount: '156', trade: 'goods' }).then((r) => r.id);
  const move = (o: Org, item: string, date: string, quantity: string) =>
    rows("INSERT INTO crove_finance.stock_move (org_id, item_id, move_date, quantity, source_type) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [o.orgId, item, date, quantity]).then((r) => r[0]?.id as string);
  type Line = { itemId: string; countedQuantity: string; unitCost?: string };
  const count = (o: Org, countDate: string, lines: Line[], user = o.member) =>
    execute<{ id: string }>(o, 'finance.stock_count.create', { countDate, lossNormPercent: '10', lines }, user).then((r) => r.id);
  const approve = async (o: Org, proposalId: string, user = o.owner) => {
    const detail = await rt.query<{ revision: number }>('kernel.inbox.get', { id: proposalId }, { actor: asUser(user), orgId: o.orgId });
    return rt.execute<{ journalEntryId: string; voucherId: string; code: string }>('kernel.proposal.approve', { id: proposalId, revision: detail.revision }, { actor: asMfa(user), orgId: o.orgId });
  };
  const askCount = (o: Org, countId: string) =>
    rt.execute<{ proposalId: string }>('kernel.proposal.request', { command: 'finance.stock.count_confirm', input: { countId } }, { actor: asUser(o.member), orgId: o.orgId, idempotencyKey: randomUUID() });
  // A confirmed count whose shortage goes beyond the norm: four of an item on the books, three counted at a cost typed for it, a norm of 10 percent, so part of the one missing goes to 1381.
  async function shortageCount(o: Org): Promise<void> {
    const a = await makeItem(o, `A${randomUUID().slice(0, 4)}`);
    await move(o, a, '2026-09-05', '4');
    const countId = await count(o, '2026-09-30', [{ itemId: a, countedQuantity: '3', unitCost: '10' }]);
    await approve(o, (await askCount(o, countId)).proposalId);
  }
  const balance1381 = async (o: Org) =>
    (await rows<{ balance: string }>("SELECT COALESCE(SUM(debit - credit), 0)::bigint::text AS balance FROM crove_finance.journal_line WHERE org_id = $1 AND account_code = '1381'", [o.orgId]))[0]?.balance;
  const check = (o: Org, month: string, input: Record<string, unknown> = {}, user = o.member) => query<StockCloseCheck>(o, 'finance.stock.close_check', { month, ...input }, user);

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
    rt = new Runtime(db, { manifests: TEST_MANIFESTS }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('warns under Circular 99 when a 1381 balance stands at the end of the month, with the balance the ledger holds', async () => {
    const o = await org('tt99');
    await shortageCount(o);
    const held = await balance1381(o);
    expect(Number(held)).toBeGreaterThan(0);
    const result = await check(o, '2026-10');
    expect(result).toMatchObject({ month: '2026-10', regime: 'tt99', balance1381: held, applies: true });
  });

  it('does not warn under Circular 133 for the same balance, nor for a month before the balance exists', async () => {
    const o = await org('tt133');
    await shortageCount(o);
    const held = await balance1381(o);
    expect(await check(o, '2026-10')).toMatchObject({ regime: 'tt133', balance1381: held, applies: false });
    const early = await org('tt99');
    await shortageCount(early);
    // The count is of 2026-09-30 and its entry is dated that day or later: August holds nothing.
    expect(await check(early, '2026-08')).toMatchObject({ regime: 'tt99', balance1381: '0', applies: false });
  });

  it('does not warn without a 1381 balance, is read only, and names an entity of the org only', async () => {
    const o = await org('tt99');
    expect(await check(o, '2026-10')).toMatchObject({ balance1381: '0', applies: false });
    const before = await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_finance.journal_entry WHERE org_id = $1', [o.orgId]);
    await check(o, '2026-10');
    expect(await rows<{ n: string }>('SELECT count(*)::text AS n FROM crove_finance.journal_entry WHERE org_id = $1', [o.orgId])).toEqual(before);
    await expect(check(o, '2026-10', { legalEntityId: randomUUID() })).rejects.toBeDefined();
  });

  it('is for owners, admins and members: a viewer is refused', async () => {
    const o = await org('tt99');
    await expect(check(o, '2026-10', {}, o.viewer)).rejects.toMatchObject({ status: 403 });
  });
});

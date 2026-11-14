// SPDX-License-Identifier: AGPL-3.0-only
// The facts behind the coworker's line on the Sàn screen (#2516 slice E), on PostgreSQL 17: finance.marketplace.facts counts the stored settlements that stand and have no posting voucher (a reversed
// one and its reversal do not count, a posted one does not), and sums the balance rows (slice D). Every role reads it, another org sees nothing, an entity filter narrows it, and it writes nothing.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { MarketplaceFacts } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the Sàn line facts on PostgreSQL (#2516 slice E)', () => {
  const dbName = `crove_test_mkt_facts_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let owner = '';
  let member = '';
  let viewer = '';
  let stranger = '';
  let orgA = '';
  let orgB = '';
  let entity = '';
  let branch = '';
  let shopee = '';

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const actor = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal1' as const });
  const facts = (userId = owner, orgId = orgA, input: { legalEntityId?: string } = {}) => rt.query<MarketplaceFacts>('finance.marketplace.facts', input, { actor: actor(userId), orgId });
  // A settlement of an entity with one line; `reversalOf` makes it the reversal of another (one transaction: the guard checks at commit that it mirrors its original).
  async function settlement(org: string, forEntity: string, platform: string, start: string, end: string, reversalOf: string | null = null): Promise<string> {
    return admin(async (a) => {
      await a.query('BEGIN');
      const id = randomUUID();
      let order: string = randomUUID();
      if (reversalOf) order = (await a.query<{ order_id: string }>('SELECT order_id FROM crove_finance.channel_settlement_line WHERE org_id = $1 AND settlement_id = $2', [org, reversalOf])).rows[0]?.order_id as string;
      else await a.query('INSERT INTO crove_finance.channel_order (org_id, id, legal_entity_id, platform, order_no) VALUES ($1, $2, $3, $4, $5)', [org, order, forEntity, platform, `ST${randomUUID().slice(0, 12)}`]);
      await a.query('INSERT INTO crove_finance.channel_settlement (org_id, id, legal_entity_id, platform, period_start, period_end, report_net, reversal_of) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [org, id, forEntity, platform, start, end, reversalOf ? -9000 : 9000, reversalOf]);
      await a.query('INSERT INTO crove_finance.channel_settlement_line (org_id, id, legal_entity_id, settlement_id, order_id, line_key, sales, tax_withheld, net, adjustment) VALUES ($1, $2, $3, $4, $5, $6, 10000, 1000, 9000, $7)', [org, randomUUID(), forEntity, id, order, 'L1', reversalOf !== null]);
      await a.query('COMMIT');
      return id;
    });
  }
  // The posting voucher of a settlement as the record command leaves it (the unique link `settlement_id`), with its entry on the same date in the same transaction.
  const posted = (settlementId: string, org = orgA) =>
    admin(async (a) => {
      await a.query('BEGIN');
      const v = (
        await a.query<{ id: string }>(
          "INSERT INTO crove_finance.journal_voucher (org_id, voucher_date, description, proposal_id, settlement_id, legal_entity_id) VALUES ($1, '2026-11-10', 'Ghi sổ kỳ đối soát', $2, $3, $4) RETURNING id",
          [org, randomUUID(), settlementId, entity],
        )
      ).rows[0]?.id;
      const e = (
        await a.query<{ id: string }>(
          "INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, '2026-11-10', 'Ghi sổ kỳ đối soát', 'finance.journal_voucher', $2, $3) RETURNING id",
          [org, v, entity],
        )
      ).rows[0]?.id;
      await a.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit) VALUES ($1, $2, 1, '131', 10000, 0), ($1, $2, 2, '511', 0, 10000)", [org, e]);
      await a.query('COMMIT');
    });
  const post = (lines: Array<[string, number, number, string | null]>) =>
    admin(async (c) => {
      await c.query('BEGIN');
      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id) VALUES ($1, '2026-11-05', 'Sàn', 'test', $2) RETURNING id",
        [orgA, randomUUID()],
      );
      let lineNo = 1;
      for (const [account, debit, credit, partyId] of lines) await c.query('INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [orgA, rows[0]?.id, lineNo++, account, debit, credit, partyId]);
      await c.query('COMMIT');
    });

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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, contextTokenKey: process.env.CROVE_CONTEXT_TOKEN_KEY ?? null }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const db = createDb(pool);
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}@mkt-facts.test`, name: null });
    owner = await person('owner');
    member = await person('member');
    viewer = await person('viewer');
    stranger = await person('stranger');
    ({ orgId: orgA } = await createOrg(rt, actor(owner), 'Công ty A'));
    ({ orgId: orgB } = await createOrg(rt, actor(stranger), 'Công ty B'));
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'viewer')", [orgA, member, viewer]));
    entity = (await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgA]))).rows[0]?.id as string;
    branch = randomUUID();
    await admin((c) => c.query("INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh', 'branch', $3)", [orgA, branch, owner]));
    shopee = randomUUID();
    await admin((c) => c.query("INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', 'Shopee')", [orgA, shopee]));
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('is all zeros while nothing is stored, posted or linked', async () => {
    expect(await facts()).toEqual({ settlementsToPost: 0, platforms: 0, awaitingPayout: '0', feesAwaitingInvoice: '0' });
  });

  it('counts the stored settlements that stand and are not posted, leaving out a posted one, a reversed one and its reversal', async () => {
    const open = await settlement(orgA, entity, 'shopee', '2026-11-01', '2026-11-07');
    const done = await settlement(orgA, entity, 'shopee', '2026-11-08', '2026-11-14');
    const wrong = await settlement(orgA, entity, 'lazada', '2026-11-01', '2026-11-07');
    await settlement(orgA, entity, 'lazada', '2026-11-01', '2026-11-07', wrong);
    await settlement(orgA, branch, 'tiktok_shop', '2026-11-01', '2026-11-07');
    expect(open).not.toBe(done);
    expect((await facts()).settlementsToPost).toBe(3);
    // Posting one takes it off the list; the unique link is the posting's own record.
    await posted(done);
    expect((await facts()).settlementsToPost).toBe(2);
    // A filter by entity narrows the count to that entity's settlements.
    expect((await facts(owner, orgA, { legalEntityId: entity })).settlementsToPost).toBe(1);
    expect((await facts(owner, orgA, { legalEntityId: branch })).settlementsToPost).toBe(1);
    expect((await facts(owner, orgA, { legalEntityId: randomUUID() })).settlementsToPost).toBe(0);
  });

  it('sums what the platforms still owe and the fees awaiting an invoice from the balance rows, and counts the platforms', async () => {
    await admin((c) => c.query("INSERT INTO crove_finance.marketplace_party (org_id, platform, party_id) VALUES ($1, 'shopee', $2)", [orgA, shopee]));
    await post([['131', 1_000_000, 0, shopee], ['511', 0, 1_000_000, null]]);
    await post([['112', 880_000, 0, null], ['1388', 120_000, 0, shopee], ['131', 0, 1_000_000, shopee]]);
    await post([['131', 500_000, 0, shopee], ['511', 0, 500_000, null]]);
    const f = await facts();
    expect(f.platforms).toBe(1);
    expect(f.awaitingPayout).toBe('500000');
    expect(f.feesAwaitingInvoice).toBe('120000');
  });

  it('is read by every role, never shows another org anything, and writes nothing', async () => {
    for (const who of [owner, member, viewer]) expect((await facts(who)).settlementsToPost).toBe(2);
    expect(await facts(stranger, orgB)).toEqual({ settlementsToPost: 0, platforms: 0, awaitingPayout: '0', feesAwaitingInvoice: '0' });
    const before = await admin(async (c) => (await c.query<{ n: string }>('SELECT (SELECT count(*) FROM crove_finance.journal_voucher) + (SELECT count(*) FROM crove_finance.journal_entry) AS n')).rows[0]?.n);
    await facts();
    expect(await admin(async (c) => (await c.query<{ n: string }>('SELECT (SELECT count(*) FROM crove_finance.journal_voucher) + (SELECT count(*) FROM crove_finance.journal_entry) AS n')).rows[0]?.n)).toBe(before);
  });
});

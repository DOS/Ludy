// SPDX-License-Identifier: AGPL-3.0-only
// The Sàn screen's read (#2516 slice D), on PostgreSQL 17: finance.marketplace.balance reads the ledger by account (131, 1388) and by the platform's party of crove_finance.marketplace_party.
// A platform with no entries shows zeros; sales, payouts and fees come from the lines that name the platform's party and nobody else's; a reversal entry takes back what it reverses and is
// never counted as a payout; another org sees nothing and an unknown entity filter gives no rows.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import type { MarketplaceBalance } from '@crove/kernel-contract';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('the platform balance read on PostgreSQL (#2516)', () => {
  const dbName = `crove_test_mkt_balance_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let owner = '';
  let stranger = '';
  let orgA = '';
  let orgB = '';
  let entity = '';
  let shopee = '';
  let tiktok = '';
  let customer = '';

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
  const balance = (userId = owner, orgId = orgA, input: { legalEntityId?: string } = {}) => rt.query<MarketplaceBalance>('finance.marketplace.balance', input, { actor: actor(userId), orgId });
  const party = (name: string) =>
    admin(async (c) => {
      const id = randomUUID();
      await c.query("INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, 'organization', $3)", [orgA, id, name]);
      return id;
    });
  // One entry by the superuser: lines are [account, debit, credit, party]; a reversal names the entry it reverses.
  const post = (lines: Array<[string, number, number, string | null]>, reverses: string | null = null) =>
    admin(async (c) => {
      await c.query('BEGIN');
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, reverses_entry_id) VALUES ($1, '2026-11-05', 'Sàn', 'test', $2, $3) RETURNING id`,
        [orgA, randomUUID(), reverses],
      );
      const entry = rows[0]?.id as string;
      let lineNo = 1;
      for (const [account, debit, credit, partyId] of lines) {
        await c.query('INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [orgA, entry, lineNo++, account, debit, credit, partyId]);
      }
      await c.query('COMMIT');
      return entry;
    });
  const rowOf = (result: MarketplaceBalance, platform: string) => result.rows.find((r) => r.platform === platform);

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
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}@mkt-balance.test`, name: null });
    owner = await person('owner');
    stranger = await person('stranger');
    ({ orgId: orgA } = await createOrg(rt, actor(owner), 'Công ty A'));
    ({ orgId: orgB } = await createOrg(rt, actor(stranger), 'Công ty B'));
    entity = (await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgA]))).rows[0]?.id as string;
    shopee = await party('Shopee');
    tiktok = await party('TikTok Shop');
    customer = await party('Khách lẻ');
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('gives no rows while no platform is linked', async () => {
    expect(await balance()).toEqual({ rows: [] });
  });

  it('shows a linked platform with zeros when nothing was posted for it, in the order of the platform key', async () => {
    await admin(async (c) => {
      await c.query("INSERT INTO crove_finance.marketplace_party (org_id, platform, party_id) VALUES ($1, 'tiktok_shop', $2), ($1, 'shopee', $3)", [orgA, tiktok, shopee]);
    });
    const zero = { salesPosted: '0', paidOut: '0', awaitingPayout: '0', feesAwaitingInvoice: '0', legalEntityId: entity };
    expect(await balance()).toEqual({
      rows: [
        { ...zero, platform: 'shopee', platformName: 'Shopee' },
        { ...zero, platform: 'tiktok_shop', platformName: 'TikTok Shop' },
      ],
    });
  });

  it('adds the sales posted to 131, the payouts that cleared it and the fees kept on 1388, for the platform\'s party only', async () => {
    // Two settlements of Shopee: Dr 131 / Cr 511.
    await post([['131', 1_000_000, 0, shopee], ['511', 0, 1_000_000, null]]);
    await post([['131', 500_000, 0, shopee], ['511', 0, 500_000, null]]);
    // A payout of the first settlement: 900,000 received, 100,000 of fees kept (invoice not come), Cr 131 for the whole.
    await post([['112', 900_000, 0, null], ['1388', 100_000, 0, shopee], ['131', 0, 1_000_000, shopee]]);
    // A customer's 131 line and a TikTok settlement are other people's figures.
    await post([['131', 777_000, 0, customer], ['511', 0, 777_000, null]]);
    await post([['131', 250_000, 0, tiktok], ['511', 0, 250_000, null]]);
    const result = await balance();
    expect(rowOf(result, 'shopee')).toMatchObject({ salesPosted: '1500000', paidOut: '1000000', awaitingPayout: '500000', feesAwaitingInvoice: '100000' });
    expect(rowOf(result, 'tiktok_shop')).toMatchObject({ salesPosted: '250000', paidOut: '0', awaitingPayout: '250000', feesAwaitingInvoice: '0' });
  });

  it('takes a reversed settlement back from the sales, and a reversed payout back from what was paid, never counting a reversal as a payout', async () => {
    const settlement = await post([['131', 300_000, 0, shopee], ['511', 0, 300_000, null]]);
    const before = rowOf(await balance(), 'shopee');
    expect(before).toMatchObject({ salesPosted: '1800000', paidOut: '1000000', awaitingPayout: '800000' });
    // The reversal mirrors the entry: Cr 131 for the platform. It lowers the sales, not the money still owed in a way a payout would.
    await post([['131', 0, 300_000, shopee], ['511', 300_000, 0, null]], settlement);
    expect(rowOf(await balance(), 'shopee')).toMatchObject({ salesPosted: '1500000', paidOut: '1000000', awaitingPayout: '500000', feesAwaitingInvoice: '100000' });
    // A payout reversed: the Cr 131 of that entry is taken back, so it was never paid out and the fee line goes with it.
    const payout = await post([['112', 200_000, 0, null], ['1388', 50_000, 0, shopee], ['131', 0, 250_000, shopee]]);
    expect(rowOf(await balance(), 'shopee')).toMatchObject({ salesPosted: '1500000', paidOut: '1250000', awaitingPayout: '250000', feesAwaitingInvoice: '150000' });
    await post([['112', 0, 200_000, null], ['1388', 0, 50_000, shopee], ['131', 250_000, 0, shopee]], payout);
    expect(rowOf(await balance(), 'shopee')).toMatchObject({ salesPosted: '1500000', paidOut: '1000000', awaitingPayout: '500000', feesAwaitingInvoice: '100000' });
  });

  it('shows a negative balance as it stands (a platform that was paid more than it was posted)', async () => {
    await post([['131', 0, 600_000, tiktok], ['112', 600_000, 0, null]]);
    expect(rowOf(await balance(), 'tiktok_shop')).toMatchObject({ salesPosted: '250000', paidOut: '600000', awaitingPayout: '-350000' });
  });

  it('filters by legal entity, gives nothing for an unknown entity, and shows another org nothing of this one', async () => {
    expect((await balance(owner, orgA, { legalEntityId: entity })).rows).toHaveLength(2);
    expect(await balance(owner, orgA, { legalEntityId: randomUUID() })).toEqual({ rows: [] });
    expect(await balance(stranger, orgB)).toEqual({ rows: [] });
  });
});

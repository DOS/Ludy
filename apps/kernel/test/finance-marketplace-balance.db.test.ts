// SPDX-License-Identifier: AGPL-3.0-only
// What each marketplace owes the business (#2516 slice D), read from the ledger on PostgreSQL 17: a settlement entry debits 131 under the platform's party, a payout credits it and puts the fees that
// have no invoice yet in 1388; the query sums journal lines by account and party as of a day, shows zeros for a platform with orders but no posted settlement, counts a sub-account (131.SHP) under its parent,
// leaves another entity's and another org's lines out, and every role that reads the ledger may read it. Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool, type Db } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import type { MarketplaceBalance } from '@crove/kernel-contract';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('marketplace balance on PostgreSQL (#2516 slice D)', () => {
  const dbName = `crove_test_mkt_balance_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let pool: pg.Pool;
  let db: Db;
  let rt: Runtime;
  const asUser = (userId: string) => ({ type: 'user' as const, userId, aal: 'aal2' as const, mfaAt: Math.floor(Date.now() / 1000) });

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  const identity = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}-${randomUUID().slice(0, 8)}@mkt-balance.test`, name: null });
  type Org = { orgId: string; owner: string; viewer: string; entity: string };
  async function org(): Promise<Org> {
    const owner = await identity('owner');
    const { orgId } = await createOrg(rt, asUser(owner), `Cửa hàng ${randomUUID().slice(0, 6)}`);
    const viewer = await identity('viewer');
    await admin((c) => c.query("INSERT INTO crove_kernel.tenant_member (org_id, user_id, role) VALUES ($1, $2, 'viewer')", [orgId, viewer]));
    const entity = (await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgId]))).rows[0]?.id as string;
    return { orgId, owner, viewer, entity };
  }
  const balance = (o: Org, input: Record<string, unknown> = {}, user = o.owner) => rt.query<MarketplaceBalance>('finance.marketplace.balance', input, { actor: asUser(user), orgId: o.orgId });
  // The organization party that stands for a platform, linked as marketplace_party does.
  async function platformParty(o: Org, platform: string): Promise<string> {
    return admin(async (c) => {
      const party = (await c.query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, kind, name) VALUES ($1, 'organization', $2) RETURNING id", [o.orgId, `Sàn ${platform}`])).rows[0]?.id as string;
      await c.query('INSERT INTO crove_finance.marketplace_party (org_id, legal_entity_id, platform, party_id) VALUES ($1, $2, $3, $4)', [o.orgId, o.entity, platform, party]);
      return party;
    });
  }
  // A manual entry written by the database owner, each line [account, debit, credit, party].
  async function entry(o: Org, date: string, lines: Array<[string, string, string, string | null]>, entity = o.entity): Promise<void> {
    await admin(async (c) => {
      await c.query('BEGIN');
      try {
        const id = (
          await c.query<{ id: string }>(
            "INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, $2, 'sàn', 'finance.journal_voucher', $3, $4) RETURNING id",
            [o.orgId, date, randomUUID(), entity],
          )
        ).rows[0]?.id as string;
        let no = 1;
        for (const [account, debit, credit, party] of lines) {
          await c.query('INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [o.orgId, id, no++, account, debit, credit, party]);
        }
        await c.query('COMMIT');
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      }
    });
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
    const app = new URL(adminUrl);
    app.username = 'crove_app';
    app.password = 'test-app-pw';
    pool = createPool({ connectionString: app.toString(), max: 4 });
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

  it('is empty for an entity with no platform, and says so with zero totals', async () => {
    const o = await org();
    const view = await balance(o, { asOf: '2026-11-09' });
    expect(view).toEqual({ legalEntityId: o.entity, asOf: '2026-11-09', platforms: [], totals: { sales: '0', payouts: '0', owed: '0', feesAwaitingInvoice: '0' } });
  });

  it('shows zeros for a platform that has orders but no posted settlement', async () => {
    const o = await org();
    await admin((c) => c.query("INSERT INTO crove_finance.channel_order (org_id, legal_entity_id, platform, order_no) VALUES ($1, $2, 'shopee', 'A1')", [o.orgId, o.entity]));
    const view = await balance(o);
    expect(view.platforms).toEqual([{ platform: 'shopee', partyId: null, partyName: null, sales: '0', payouts: '0', owed: '0', feesAwaitingInvoice: '0' }]);
  });

  it('sums the settlement and the payout under the platform party, as of a day', async () => {
    const o = await org();
    const shopee = await platformParty(o, 'shopee');
    const tiktok = await platformParty(o, 'tiktok_shop');
    // A settlement: Dr 131 (the platform) / Cr 511; a part payout: Dr 112 for the money, Dr 1388 for fees with no invoice yet, Dr 333 for the tax withheld, Cr 131 for the whole.
    await entry(o, '2026-10-31', [['131', '1000000', '0', shopee], ['511', '0', '1000000', null]]);
    await entry(o, '2026-11-05', [['112', '700000.5', '0', null], ['1388', '40000', '0', shopee], ['333', '9999.5', '0', null], ['131', '0', '750000', shopee]]);
    await entry(o, '2026-11-08', [['131', '200000', '0', tiktok], ['511', '0', '200000', null]]);
    const view = await balance(o, { asOf: '2026-11-09' });
    expect(view.platforms).toEqual([
      { platform: 'shopee', partyId: shopee, partyName: 'Sàn shopee', sales: '1000000', payouts: '750000', owed: '250000', feesAwaitingInvoice: '40000' },
      { platform: 'tiktok_shop', partyId: tiktok, partyName: 'Sàn tiktok_shop', sales: '200000', payouts: '0', owed: '200000', feesAwaitingInvoice: '0' },
    ]);
    expect(view.totals).toEqual({ sales: '1200000', payouts: '750000', owed: '450000', feesAwaitingInvoice: '40000' });
    // As of an earlier day the later entries are not counted.
    const earlier = await balance(o, { asOf: '2026-11-01' });
    expect(earlier.platforms.find((p) => p.platform === 'shopee')).toMatchObject({ sales: '1000000', payouts: '0', owed: '1000000', feesAwaitingInvoice: '0' });
    expect(earlier.platforms.find((p) => p.platform === 'tiktok_shop')).toMatchObject({ sales: '0', owed: '0' });
  });

  it('counts a sub-account (131.SHP) under its parent and leaves out other accounts, other parties and other entities', async () => {
    const o = await org();
    const shopee = await platformParty(o, 'shopee');
    const customer = await admin(async (c) => (await c.query<{ id: string }>("INSERT INTO crove_kernel.party (org_id, kind, name) VALUES ($1, 'organization', 'Khách hàng') RETURNING id", [o.orgId])).rows[0]?.id as string);
    const branch = randomUUID();
    await admin((c) => c.query("INSERT INTO crove_kernel.legal_entity (org_id, id, name, kind, created_by) VALUES ($1, $2, 'Chi nhánh', 'branch', $3)", [o.orgId, branch, o.owner]));
    // The org's own sub-account of 131 (the chart gives sub-accounts as 131.XXX).
    await admin((c) => c.query("INSERT INTO crove_finance.org_account (org_id, code, name, parent_code, root_code, created_by) VALUES ($1, '131.SHP', 'Phải thu Shopee', '131', '131', $2)", [o.orgId, o.owner]));
    await entry(o, '2026-11-02', [['131.SHP', '300000', '0', shopee], ['511', '0', '300000', null]]);
    // A customer's receivable and a platform line on another account are not the platform's.
    await entry(o, '2026-11-02', [['131', '111111', '0', customer], ['511', '0', '111111', null]]);
    await entry(o, '2026-11-02', [['156', '5000', '0', shopee], ['111', '0', '5000', null]]);
    // The same party in another entity's books is not this entity's.
    await entry(o, '2026-11-03', [['131', '777000', '0', shopee], ['511', '0', '777000', null]], branch);
    const view = await balance(o);
    expect(view.platforms).toEqual([{ platform: 'shopee', partyId: shopee, partyName: 'Sàn shopee', sales: '300000', payouts: '0', owed: '300000', feesAwaitingInvoice: '0' }]);
    const other = await balance(o, { legalEntityId: branch });
    expect(other.platforms).toEqual([]);
  });

  it('leaves out a settlement that was reversed, and its reversal', async () => {
    const o = await org();
    const shopee = await platformParty(o, 'shopee');
    await entry(o, '2026-11-02', [['131', '500000', '0', shopee], ['511', '0', '500000', null]]);
    const wrong = await admin(async (c) => {
      await c.query('BEGIN');
      const id = (
        await c.query<{ id: string }>(
          "INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id) VALUES ($1, '2026-11-03', 'sàn nhầm', 'finance.journal_voucher', $2, $3) RETURNING id",
          [o.orgId, randomUUID(), o.entity],
        )
      ).rows[0]?.id as string;
      await c.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, 1, '131', 70000, 0, $3), ($1, $2, 2, '511', 0, 70000, NULL)", [o.orgId, id, shopee]);
      await c.query('COMMIT');
      return id;
    });
    await admin(async (c) => {
      await c.query('BEGIN');
      const id = (
        await c.query<{ id: string }>(
          "INSERT INTO crove_finance.journal_entry (org_id, entry_date, description, source_type, source_id, legal_entity_id, reverses_entry_id) VALUES ($1, '2026-11-04', 'đảo', 'finance.journal_voucher', $2, $3, $4) RETURNING id",
          [o.orgId, randomUUID(), o.entity, wrong],
        )
      ).rows[0]?.id as string;
      await c.query("INSERT INTO crove_finance.journal_line (org_id, entry_id, line_no, account_code, debit, credit, party_id) VALUES ($1, $2, 1, '131', 0, 70000, $3), ($1, $2, 2, '511', 70000, 0, NULL)", [o.orgId, id, shopee]);
      await c.query('COMMIT');
    });
    expect((await balance(o)).platforms).toEqual([{ platform: 'shopee', partyId: shopee, partyName: 'Sàn shopee', sales: '500000', payouts: '0', owed: '500000', feesAwaitingInvoice: '0' }]);
  });

  it('lets every role that reads the ledger read it, and shows another org nothing', async () => {
    const a = await org();
    const b = await org();
    await platformParty(a, 'shopee');
    expect((await balance(a, {}, a.viewer)).platforms.map((p) => p.platform)).toEqual(['shopee']);
    expect((await balance(b)).platforms).toEqual([]);
    await expect(rt.query('finance.marketplace.balance', { legalEntityId: a.entity }, { actor: asUser(b.owner), orgId: b.orgId })).rejects.toMatchObject({ code: 'LEGAL_ENTITY_NOT_ALLOWED' });
    await expect(balance(a, { asOf: '2026-13-01' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

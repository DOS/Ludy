// SPDX-License-Identifier: AGPL-3.0-only
// The platform as the counterparty of account 131 (#2516, ADR-0045 point 6, plan stock-and-marketplaces.md section 8.4), on PostgreSQL 17: crove_finance.marketplace_party links one
// legal entity's platform to an ordinary organization party. One link per entity and platform, a party linked once, only an organization party, a member of another org sees
// nothing, a tenant role reads and inserts but never updates or deletes, and the org purge removes the links before the parties they name.
// Set CROVE_TEST_ADMIN_URL to a superuser URL; each run makes its own database.
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from '@crove/db';
import { migrate, setRolePasswords } from '@crove/db/migrate';
import { createOrg, kernelCommands, kernelQueries, upsertIdentity } from '@crove/kernel';
import { Runtime } from '@crove/kernel-runtime';
import { financeCommands, financeQueries } from '@crove/mod-finance';
import { TEST_MANIFESTS } from './manifests.ts';
import { enterUser } from './context-token.ts';

const ADMIN = process.env.CROVE_TEST_ADMIN_URL;
const MIGRATIONS = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const suite = ADMIN ? describe : describe.skip;

suite('marketplace party links on PostgreSQL (#2516)', () => {
  const dbName = `crove_test_mkt_party_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let adminUrl = '';
  let appUrl = '';
  let pool: pg.Pool;
  let rt: Runtime;
  let owner = '';
  let stranger = '';
  let orgA = '';
  let orgB = '';
  const org = { id: '', entity: '' };

  async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
  async function asMember<T>(userId: string, orgId: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: appUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      await enterUser(client, userId, orgId);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      await client.end();
    }
  }
  const party = (kind: string, orgId: string = orgA) =>
    admin(async (c) => {
      const id = randomUUID();
      await c.query('INSERT INTO crove_kernel.party (org_id, id, kind, name) VALUES ($1, $2, $3, $4)', [orgId, id, kind, `Platform ${id.slice(0, 6)}`]);
      return id;
    });
  const link = (platform: string, partyId: string) =>
    asMember(owner, orgA, (c) => c.query('INSERT INTO crove_finance.marketplace_party (org_id, platform, party_id) VALUES ($1, $2, $3)', [orgA, platform, partyId]));

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
    appUrl = app.toString();
    pool = createPool({ connectionString: appUrl, max: 4 });
    rt = new Runtime(createDb(pool), { manifests: TEST_MANIFESTS, contextTokenKey: process.env.CROVE_CONTEXT_TOKEN_KEY ?? null }).register({
      commands: [...kernelCommands, ...financeCommands],
      queries: [...kernelQueries({ inboundDomain: null }), ...financeQueries],
    });
    const db = createDb(pool);
    const person = (name: string) => upsertIdentity(db, { issuer: 'test', subject: randomUUID(), email: `${name}@mkt-party.test`, name: null });
    owner = await person('owner');
    stranger = await person('stranger');
    ({ orgId: orgA } = await createOrg(rt, { type: 'user', userId: owner, aal: 'aal1' }, 'Công ty A'));
    ({ orgId: orgB } = await createOrg(rt, { type: 'user', userId: stranger, aal: 'aal1' }, 'Công ty B'));
    org.id = orgA;
    org.entity = (await admin((c) => c.query<{ id: string }>('SELECT id FROM crove_kernel.legal_entity WHERE org_id = $1 AND is_default', [orgA]))).rows[0]?.id as string;
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    if (!ADMIN) return;
    const root = new pg.Client({ connectionString: ADMIN });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await root.end();
  });

  it('links an organization party to the default entity and platform, and a member reads it', async () => {
    const p = await party('organization');
    await link('shopee', p);
    const rows = await asMember(owner, orgA, (c) => c.query<{ legal_entity_id: string; platform: string; party_id: string }>('SELECT legal_entity_id, platform, party_id FROM crove_finance.marketplace_party'));
    expect(rows.rows).toEqual([{ legal_entity_id: org.entity, platform: 'shopee', party_id: p }]);
  });

  it('allows one link per entity and platform, and a party linked once', async () => {
    const other = await party('organization');
    await expect(link('shopee', other)).rejects.toMatchObject({ constraint: 'marketplace_party_platform_uq' });
    const taken = (await admin((c) => c.query<{ party_id: string }>('SELECT party_id FROM crove_finance.marketplace_party LIMIT 1'))).rows[0]?.party_id as string;
    await expect(link('tiktok_shop', taken)).rejects.toMatchObject({ constraint: 'marketplace_party_party_uq' });
    await link('tiktok_shop', other);
  });

  it('refuses a person or a merged party as a platform, and a platform id of the wrong shape', async () => {
    const person = await party('person');
    await expect(link('lazada', person)).rejects.toMatchObject({ message: expect.stringContaining('MARKETPLACE_PARTY_KIND') });
    const target = await party('organization');
    const merged = await party('organization');
    await admin((c) => c.query('UPDATE crove_kernel.party SET duplicate_of = $3 WHERE org_id = $1 AND id = $2', [orgA, merged, target]));
    await expect(link('lazada', merged)).rejects.toMatchObject({ message: expect.stringContaining('MARKETPLACE_PARTY_KIND') });
    const p = await party('organization');
    for (const bad of ['', 'S', 'Shopee', '1shopee', 'shop-ee', 'x'.repeat(32)]) {
      await expect(link(bad, p)).rejects.toMatchObject({ constraint: 'marketplace_party_platform_check' });
    }
  });

  it('shows another org nothing and refuses its own write for the first org', async () => {
    const seen = await asMember(stranger, orgB, (c) => c.query('SELECT 1 FROM crove_finance.marketplace_party'));
    expect(seen.rowCount).toBe(0);
    const p = await party('organization');
    await expect(
      asMember(stranger, orgB, (c) => c.query('INSERT INTO crove_finance.marketplace_party (org_id, platform, party_id) VALUES ($1, $2, $3)', [orgA, 'lazada', p])),
    ).rejects.toMatchObject({ code: '42501' });
    expect((await admin((c) => c.query('SELECT 1 FROM crove_finance.marketplace_party WHERE party_id = $1', [p]))).rowCount).toBe(0);
  });

  it('lets a tenant role read and insert but never update or delete', async () => {
    await expect(asMember(owner, orgA, (c) => c.query("UPDATE crove_finance.marketplace_party SET platform = 'zzz'"))).rejects.toMatchObject({ code: '42501' });
    await expect(asMember(owner, orgA, (c) => c.query('DELETE FROM crove_finance.marketplace_party'))).rejects.toMatchObject({ code: '42501' });
  });

  it('is removed by the org purge before the parties it names', async () => {
    const before = (await admin((c) => c.query('SELECT 1 FROM crove_finance.marketplace_party WHERE org_id = $1', [orgA]))).rowCount;
    expect(before).toBeGreaterThan(0);
    const purge = (await admin((c) => c.query('SELECT 1 FROM pg_catalog.pg_proc WHERE proname = $1 AND pg_catalog.pg_get_functiondef(oid) LIKE $2', ['org_purge', '%crove_finance.marketplace_party%']))).rowCount;
    expect(purge).toBe(1);
  });
});
